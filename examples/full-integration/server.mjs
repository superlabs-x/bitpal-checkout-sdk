/**
 * server.mjs — 머천트 백엔드 통합 reference (Express).
 *
 * BitPal SDK + webhook receiver + idempotent dedup 을 한 백엔드에서 묶어 쓰는 최소
 * 실행 가능 예제. production-grade가 아닌 reference. (환불은 비수탁 자동 경로라 머천트
 * 트리거 endpoint 없음 — checkout.refund.recorded webhook 으로 통지만 받는다.)
 *
 * 실행:
 *   1. cp .env.example .env  (그리고 BITPAL_API_KEY / BITPAL_WEBHOOK_SECRET 채움)
 *   2. pnpm --filter @bitpal/checkout build
 *   3. cd packages/checkout-sdk/examples/full-integration
 *   4. node --env-file=.env server.mjs
 *
 * Endpoints:
 *   POST /api/checkout              — 머천트 frontend가 호출. checkout session 생성 → URL 반환
 *   POST /webhook                   — BitPal이 호출. signature 검증 + dedup + 비즈니스 로직
 *   GET  /api/order/:sessionId      — 디버깅용. 머천트 store 상태 조회
 */
import express from 'express';
import {
  BitPal,
  toAtomicUSDC,
  verifyWebhookSignature,
  parseWebhookEvent,
  WEBHOOK_HEADERS,
  BitPalError,
} from '@bitpal/checkout';
import {
  withIdempotency,
  upsertOrder,
  getOrder,
  appendRefund,
} from './store.mjs';

const PORT = Number(process.env.PORT ?? 4000);
const API_KEY = process.env.BITPAL_API_KEY;
const WEBHOOK_SECRET = process.env.BITPAL_WEBHOOK_SECRET;
const API_BASE = process.env.BITPAL_API_BASE ?? 'http://localhost:3100';
const SUCCESS_URL = process.env.MERCHANT_SUCCESS_URL ?? `http://localhost:${PORT}/order-complete`;
const CANCEL_URL = process.env.MERCHANT_CANCEL_URL ?? `http://localhost:${PORT}/cart`;

if (!API_KEY) {
  console.error('환경변수 BITPAL_API_KEY 필요. (콘솔 → Developers → API Keys 발급)');
  process.exit(1);
}
if (!WEBHOOK_SECRET) {
  console.error('환경변수 BITPAL_WEBHOOK_SECRET 필요. (콘솔 → Developers → Webhooks endpoint 등록 시 1회 노출)');
  process.exit(1);
}

const bitpal = new BitPal({ apiKey: API_KEY, baseUrl: API_BASE });
const app = express();

// ── 1) Checkout 세션 생성 ────────────────────────────────────────────────
//
// 머천트 frontend가 호출. body: { item_name, amount_usd }
// 응답: { checkout_url, session_id }
app.post('/api/checkout', express.json(), async (req, res) => {
  try {
    const { item_name = 'Pro Plan', amount_usd = '29.00' } = req.body ?? {};
    const amountAtomic = toAtomicUSDC(amount_usd);

    const { data: session } = await bitpal.checkout.createSession({
      line_items: [
        { name: item_name, amount: amountAtomic, currency: 'USDC' },
      ],
      pay_chain: 'eip155:84532', // Base Sepolia (test 키). live: 'eip155:8453'(Base mainnet).
      expires_in_seconds: 1800,
      success_url: SUCCESS_URL,
      cancel_url: CANCEL_URL,
    });

    // 머천트 store에 'pending' 주문 INSERT (webhook 도착 전 상태)
    upsertOrder(session.id, {
      status: 'pending',
      amount: amountAtomic,
      item_name,
      created_at: new Date().toISOString(),
    });

    res.json({ checkout_url: session.url, session_id: session.id });
  } catch (err) {
    if (err instanceof BitPalError) {
      return res.status(err.statusCode).json({ error: err.message });
    }
    res.status(500).json({ error: err.message ?? 'unknown' });
  }
});

// ── 2) Webhook receiver — signature 검증 + idempotency + 비즈니스 로직 ────
//
// raw body 필수 — express.json() 쓰지 말 것 (signature 대상은 byte-identical body).
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  // 2.1 signature 검증 (replay 방어: X-Webhook-Timestamp 필수)
  const sig = req.header(WEBHOOK_HEADERS.signature) ?? '';
  const timestamp = req.header(WEBHOOK_HEADERS.timestamp) ?? '';
  const ok = await verifyWebhookSignature(req.body.toString(), sig, WEBHOOK_SECRET, { timestamp });
  if (!ok) {
    console.warn('[webhook] invalid signature — replay/tamper or wrong secret');
    return res.status(400).send('invalid signature');
  }

  // 2.2 envelope parse
  let event;
  try {
    event = parseWebhookEvent(req.body.toString());
  } catch (err) {
    return res.status(400).send(`invalid envelope: ${err.message}`);
  }

  // 2.3 idempotency dedup — at-least-once delivery라 같은 event가 두 번 올 수 있음.
  //     반드시 서명된 body 의 event.id 로 dedup 한다. 헤더 X-Webhook-Id 는 미서명 → 위조 가능.
  const eventId = event.id;
  const deliveryId = req.header(WEBHOOK_HEADERS.deliveryId) ?? '<no-delivery-id>';

  const result = await withIdempotency(eventId, async () => {
    // 2.4 event-specific 비즈니스 로직 (실제 store 트랜잭션 안에서 처리해야 함)
    const sessionId = event.data?.session_id ?? event.data?.id;
    switch (event.event) {
      case 'checkout.session.created':
        upsertOrder(sessionId, { status: 'created' });
        break;
      case 'checkout.session.deposit_detected':
        upsertOrder(sessionId, { status: 'deposit_detected' });
        break;
      case 'checkout.session.paid':
        upsertOrder(sessionId, {
          status: 'paid',
          paid_at: event.created_at,
          tx_hash: event.data?.tx_hash ?? null,
        });
        break;
      case 'checkout.session.settled':
        upsertOrder(sessionId, { status: 'settled', settled_at: event.created_at });
        break;
      case 'checkout.session.expired':
        upsertOrder(sessionId, { status: 'expired' });
        break;
      case 'checkout.session.unresolved':
        // 금액부족/잘못된토큰 등 — 머천트 검토 필요(자동 환불은 아래 recorded 로 통지).
        upsertOrder(sessionId, { status: 'unresolved' });
        break;
      case 'checkout.refund.recorded':
        // 온체인 자동 환불(초과/미달/만료)이 기록됨 — SDK 수동 환불 API 는 없다.
        appendRefund(sessionId, {
          amount: event.data?.amount ?? null,
          tx_hash: event.data?.tx_hash ?? null,
          recorded_at: event.created_at,
        });
        break;
      default:
        // 알려지지 않은 이벤트는 받기만 하고 200 반환
        break;
    }
  });

  if (result.processed) {
    console.log(`[webhook] ✓ ${event.event} processed  evt=${eventId}  dlv=${deliveryId}`);
  } else {
    console.log(`[webhook] ⤴ ${event.event} duplicate (already processed)  evt=${eventId}`);
  }

  res.status(200).send('ok');
});

// 환불은 비수탁 자동 경로다 — 머천트가 트리거하는 SDK 환불 API 는 없다. 초과/미달/만료
// 입금은 issueDepositAddress 에 지정한 refundAddress 로 온체인 자동 환불되고,
// `checkout.refund.recorded` webhook 으로 위 /webhook 핸들러에 통지된다.

// ── 3) 머천트 store 디버깅 ────────────────────────────────────────────────
app.get('/api/order/:sessionId', (req, res) => {
  const order = getOrder(req.params.sessionId);
  if (!order) return res.status(404).json({ error: 'not found' });
  res.json({ data: order });
});

// success/cancel landing pages (buyer redirect 목적지)
app.get('/order-complete', (_req, res) => res.send('Order complete (예제 페이지). 실제 머천트는 주문 status 조회 후 표시.'));
app.get('/cart', (_req, res) => res.send('Cart (예제 페이지).'));

app.listen(PORT, () => {
  console.log(`[merchant-backend] listening on http://localhost:${PORT}`);
  console.log(`[merchant-backend] BitPal API: ${API_BASE}`);
  console.log(`[merchant-backend] webhook secret: ${WEBHOOK_SECRET.slice(0, 8)}…`);
  console.log('');
  console.log('  POST /api/checkout   — checkout session 생성');
  console.log('  POST /webhook        — BitPal이 호출 (signature+timestamp 검증 + dedup)');
  console.log('  GET  /api/order/:id  — 머천트 store 상태 조회 (디버깅)');
});

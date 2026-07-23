/**
 * webhook-receiver.mjs — webhook 수신 + 서명 검증 시뮬
 *
 * 동작:
 *   1. http://localhost:4000/webhook 에서 POST 수신
 *   2. X-Webhook-Signature-256 검증 (HMAC-SHA256, sha256=<hex> 형식)
 *   3. canonical envelope 파싱 후 event 종류별 분기
 *
 * 실행:
 *   BITPAL_WEBHOOK_SECRET=whsec_xxx node webhook-receiver.mjs
 *
 * 사전 작업:
 *   콘솔 → Developers → Webhooks에서 endpoint 등록 (예: http://localhost:4000/webhook)
 *   외부 노출이 필요하면 ngrok 사용:
 *     ngrok http 4000   →   https://xxx.ngrok.io 받아서 콘솔에 등록
 *
 * 통합 검증 흐름:
 *   1. 이 스크립트 실행
 *   2. create-session.mjs 실행 → 결제 URL 받기
 *   3. 브라우저로 결제 페이지 열고 "즉시 성공" 클릭
 *   4. 이 터미널에 'checkout.session.paid' 이벤트 도착 확인
 */
import { createServer } from 'http';
import { verifyWebhookSignature, parseWebhookEvent, WEBHOOK_HEADERS } from '../dist/index.js';

const PORT = Number(process.env.PORT ?? 4000);
const SECRET = process.env.BITPAL_WEBHOOK_SECRET;

if (!SECRET) {
  console.error('환경변수 BITPAL_WEBHOOK_SECRET 필요. (콘솔 → Webhooks → endpoint 생성 시 표시)');
  process.exit(1);
}

const server = createServer((req, res) => {
  if (req.method !== 'POST' || req.url !== '/webhook') {
    res.statusCode = 404;
    return res.end('not found');
  }

  let raw = '';
  req.setEncoding('utf8');
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', async () => {
    const sig = req.headers[WEBHOOK_HEADERS.signature.toLowerCase()];
    const ts = req.headers[WEBHOOK_HEADERS.timestamp.toLowerCase()];
    const evtType = req.headers[WEBHOOK_HEADERS.event.toLowerCase()];

    if (typeof sig !== 'string') {
      console.warn(`[webhook] missing ${WEBHOOK_HEADERS.signature}`);
      res.statusCode = 400;
      return res.end('missing signature');
    }

    const isValid = await verifyWebhookSignature(raw, sig, SECRET, { timestamp: ts ?? '' });
    if (!isValid) {
      console.warn('[webhook] signature mismatch — replay/tamper or wrong secret');
      res.statusCode = 400;
      return res.end('invalid signature');
    }

    let event;
    try {
      event = parseWebhookEvent(raw);
    } catch (err) {
      console.warn('[webhook] parse failed:', err.message);
      res.statusCode = 400;
      return res.end('invalid payload');
    }

    console.log(`\n[webhook] ✓ ${evtType ?? event.event}  ts=${ts}  id=${event.id}`);

    // 이벤트별 처리 (idempotent — at-least-once 전달이라 같은 이벤트가 두 번 올 수 있음)
    switch (event.event) {
      case 'checkout.session.paid':
        console.log(`           → 주문 ${event.data?.session_id ?? event.id} 결제 완료. 머천트 DB에 status='paid' UPSERT.`);
        break;
      case 'checkout.session.settled':
        console.log(`           → 머천트 지갑으로 스윕 완료. 머천트 잔액에 반영.`);
        break;
      case 'checkout.session.unresolved':
        console.log(`           → 금액부족/잘못된토큰 등 미해결. 머천트 검토 필요.`);
        break;
      case 'checkout.refund.recorded':
        console.log(`           → 온체인 자동 환불(초과/미달/만료) 기록. 주문 환불 반영.`);
        break;
      default:
        console.log(`           → (handler 미구현: ${event.event})`);
    }

    res.statusCode = 200;
    res.end('ok');
  });
});

server.listen(PORT, () => {
  console.log(`[webhook] listening on http://localhost:${PORT}/webhook`);
  console.log(`[webhook] secret: ${SECRET.slice(0, 8)}…`);
  console.log(`[webhook] 결제 완료 이벤트 대기 중…\n`);
});

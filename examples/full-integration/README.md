# BitPal SDK — Full Merchant Integration Example

머천트가 BitPal을 자기 백엔드에 통합할 때 알아야 할 흐름을 한 Express 앱에서 묶어 보여주는 reference.

> ⚠️ **production-grade 아님** — 통합 패턴 보여주는 reference. 실제 운영 시:
> - in-memory store 대신 Postgres/Redis 등 영구 저장소
> - dedup + 비즈니스 로직을 단일 트랜잭션 안에서 처리
> - 머천트 백오피스 인증 미들웨어 추가
> - secret을 환경변수가 아닌 secret manager에서 주입
> - 에러 처리/로깅/observability 보강

## 포함된 흐름

```
머천트 frontend          머천트 backend (이 예제)        BitPal API + Webhook
       │                          │                              │
       │ 1. POST /api/checkout    │                              │
       ├─────────────────────────►│ createSession()              │
       │                          ├─────────────────────────────►│
       │                          │ ◄────── { url, id } ─────────│
       │ ◄── { checkout_url } ────┤                              │
       │                          │                              │
       │ 2. buyer를 url로 redirect ─────────────────────────────► │
       │                          │                              │ buyer가 입금주소로
       │                          │                              │ 직접 송금(자기 가스)
       │                          │ 3. POST /webhook             │
       │                          │ ◄── checkout.session.paid ───│
       │                          │   ├ signature+timestamp 검증 │
       │                          │   ├ event.id 기반 dedup      │
       │                          │   └ orders 테이블 update    │
       │                          │ ◄── checkout.session.settled │ (스윕 완료)
       │                          │ ◄── checkout.refund.recorded │ (초과/미달/만료 자동환불)
```

비수탁 모델이라 머천트가 트리거하는 환불 API 는 없다. 초과/미달/만료 입금은 buyer 가
issueDepositAddress 에 지정한 refundAddress 로 **온체인 자동 환불**되고, `checkout.refund.recorded`
webhook 으로 통지된다.

## 사전 준비

1. **BitPal API 키 발급**
   - 콘솔: Developers → API Keys → "Create API Key" → `bp_test_...` 복사

2. **Webhook endpoint 등록**
   - 콘솔: Developers → Webhooks → "Create Webhook"
   - Endpoint URL: 머천트 backend URL + `/webhook` (외부 노출 필요)
     - 로컬 개발: `ngrok http 4000` → `https://xxx.ngrok.io/webhook` 등록
   - Subscribed events: 최소 `checkout.session.paid` + `checkout.session.settled`
     (+ `checkout.refund.recorded` 로 자동 환불 통지 수신)
   - 등록 직후 **secret(`whsec_...`)이 1회만 노출** — 즉시 복사

3. **SDK 빌드**
   ```bash
   pnpm --filter @bitpal/checkout build
   ```

4. **환경변수 채우기**
   ```bash
   cp .env.example .env
   # 에디터로 .env 열어 BITPAL_API_KEY + BITPAL_WEBHOOK_SECRET 채움
   ```

## 실행

```bash
cd packages/checkout-sdk/examples/full-integration
node --env-file=.env server.mjs
```

기대 출력:
```
[merchant-backend] listening on http://localhost:4000

  POST /api/checkout   — checkout session 생성
  POST /webhook        — BitPal이 호출 (signature+timestamp 검증 + dedup)
  GET  /api/order/:id  — 머천트 store 상태 조회 (디버깅)
```

## End-to-end 통합 검증

### 1. 결제 흐름

```bash
curl -X POST http://localhost:4000/api/checkout \
  -H 'Content-Type: application/json' \
  -d '{"item_name": "Pro Plan", "amount_usd": "29.00"}'
# → { "checkout_url": "http://localhost:3200/pay/cs_...", "session_id": "cs_..." }
```

브라우저에서 `checkout_url` 열고 결제 (TEST 모드면 시나리오 버튼 클릭).

### 2. Webhook 도착 확인

```
[webhook] ✓ checkout.session.created processed  evt=evt_...  dlv=...
[webhook] ✓ checkout.session.paid processed     evt=evt_...
[webhook] ✓ checkout.session.settled processed  evt=evt_...
```

머천트 store 조회:
```bash
curl http://localhost:4000/api/order/cs_...
# → { "data": { "status": "settled", "paid_at": "...", "tx_hash": "..." } }
```

### 3. Idempotency 검증 (재전송 시뮬)

콘솔 → Developers → Webhooks → 해당 endpoint → DLQ replay 로 같은 event 재발송:
```
[webhook] ⤴ checkout.session.paid duplicate (already processed)  evt=evt_...
```
머천트 store는 변경되지 않음 (dedup 정상).

### 4. 자동 환불 통지

초과/미달/만료 입금이 있으면 BitPal 이 refundAddress 로 온체인 환불하고 통지한다:
```
[webhook] ✓ checkout.refund.recorded processed  evt=evt_...
```
머천트 store 의 `refunds[]` 에 append 된다. 머천트가 별도로 트리거할 것은 없다.

## 핵심 패턴 (꼭 기억)

### 1. Webhook signature 검증 — timestamp 필수 (replay 방어)

```ts
import { verifyWebhookSignature, WEBHOOK_HEADERS } from '@bitpal/checkout';

const sig = req.header(WEBHOOK_HEADERS.signature);   // 'X-Webhook-Signature-256'
const timestamp = req.header(WEBHOOK_HEADERS.timestamp); // 'X-Webhook-Timestamp' — 필수
const ok = await verifyWebhookSignature(req.body.toString(), sig, SECRET, { timestamp });
```

raw HTTP body가 signature 대상 — `express.raw({ type: 'application/json' })` 미들웨어 사용.
`express.json()`은 body를 parse해서 byte가 달라지므로 검증 실패. timestamp 없이 호출하면
검증은 항상 false(replay 방어).

### 2. Idempotency — 서명된 `event.id` 기준 dedup

```ts
const event = parseWebhookEvent(req.body.toString());
await withIdempotency(event.id, async () => {
  // 비즈니스 로직 + dedup 키 기록을 같은 트랜잭션에서
});
```

at-least-once delivery라 같은 event가 여러 번 도착할 수 있음. **반드시 서명된 body의
`event.id`로 dedup** — 헤더 `X-Webhook-Id`는 미서명이라 위조 가능. dedup 키 기록과 비즈니스
처리를 묶지 않으면 race로 중복 적용 발생.

### 3. Atomic μUSDC

모든 amount는 atomic μUSDC 정수 문자열. `toAtomicUSDC('29.00')` → `"29000000"`.
decimal 문자열은 backend에서 400 거부.

## 환경변수 정리

| 변수 | 필수 | 기본값 | 설명 |
|------|:---:|--------|------|
| `BITPAL_API_KEY` | ✅ | — | `bp_test_*` 또는 `bp_live_*` |
| `BITPAL_WEBHOOK_SECRET` | ✅ | — | webhook endpoint secret (1회 노출) |
| `BITPAL_API_BASE` | — | `http://localhost:3100` | API 서버 URL |
| `PORT` | — | `4000` | 머천트 backend listen 포트 |
| `MERCHANT_SUCCESS_URL` | — | `http://localhost:4000/order-complete` | buyer 결제 완료 후 redirect |
| `MERCHANT_CANCEL_URL` | — | `http://localhost:4000/cart` | buyer 결제 취소 시 redirect |

## TEST vs LIVE 모드

- **TEST** (`bp_test_...` 키): testnet(Base Sepolia 등). on-chain tx 없이 `sim_xxx` hash로 webhook delivery 시뮬.
- **LIVE** (`bp_live_...` 키): 실 USDC 결제. mainnet 컨트랙트 호출, 실 on-chain tx hash.

같은 머천트 계정에서 TEST/LIVE 분리 운영 — API 키 + webhook endpoint 모두 환경별 별도.

## 참조

- SDK README: `packages/checkout-sdk/README.md`

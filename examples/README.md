# BitPal SDK — 통합 예제

외부 머천트가 BitPal SDK를 자기 백엔드에 통합하는 시뮬레이션.

| 예제 | 범위 |
|------|------|
| [`create-session.mjs`](./create-session.mjs) | SDK로 세션 생성 → URL 출력 (1분 통합 검증) |
| [`webhook-receiver.mjs`](./webhook-receiver.mjs) | webhook 단일 endpoint + signature 검증 (1분 통합 검증) |
| [`full-integration/`](./full-integration/) | **머천트 backend full reference** — checkout 생성 + webhook receiver + idempotency dedup + refund 전 흐름 (Express) |

## 사전 준비

1. **API 키 발급** — BitPal 콘솔(`http://localhost:3000/producer/console/developers/api-keys`) → "Create new key" → `bp_test_...` 복사
2. **(선택) Webhook 시크릿 발급** — 콘솔 → Developers → Webhooks → endpoint 등록 → secret 복사
3. **SDK 빌드**
   ```bash
   pnpm --filter @bitpal/checkout build
   ```

## 1. 세션 생성 (create-session.mjs)

가장 빠른 통합 검증. SDK로 세션 만들고 결제 URL 받기.

```bash
# Linux/macOS
BITPAL_API_KEY=bp_test_xxx node examples/create-session.mjs

# Windows PowerShell
$env:BITPAL_API_KEY="bp_test_xxx"; node examples/create-session.mjs
```

기대 출력:
```
[demo] API: http://localhost:3100
[demo] Key: bp_test_xxx…

[1] 수수료 미리보기 ($29.00 = 29000000 μUSDC)
    fee_rate:   0.015
    fee_amount: $0.43 (435000 μUSDC)
    net_amount: $28.56

[2] 체크아웃 세션 생성
    session.id:           cs_xxx
    session.status:       created
    ...

[3] 결제 URL — 브라우저에서 열기:
    http://localhost:3200/pay/cs_xxx
```

## 2. Webhook 수신 (webhook-receiver.mjs)

결제 완료 이벤트를 머천트 백엔드가 받는 흐름 시뮬.

```bash
# 별도 터미널에서 실행 (4000 포트)
BITPAL_WEBHOOK_SECRET=whsec_xxx node examples/webhook-receiver.mjs
```

위 receiver를 띄운 상태에서:
1. `create-session.mjs`로 세션 생성
2. 출력된 결제 URL 브라우저로 열기
3. "즉시 성공" 시나리오 클릭
4. webhook-receiver 터미널에 `checkout.session.paid` 이벤트 도착 확인

### 외부 노출이 필요하면

콘솔에 등록하는 webhook URL은 BitPal API 서버에서 도달 가능해야 합니다. 로컬 개발 시:

```bash
# ngrok 설치 후
ngrok http 4000
# → https://xxx.ngrok.io 받음 → 콘솔에서 https://xxx.ngrok.io/webhook 등록
```

## 환경변수

| 변수 | 기본값 | 설명 |
|------|--------|------|
| `BITPAL_API_KEY` | (필수) | `bp_test_*` 또는 `bp_live_*` |
| `BITPAL_API_BASE` | `http://localhost:3100` | API 서버 URL |
| `BITPAL_WEBHOOK_SECRET` | (필수, receiver) | webhook endpoint 시크릿 |
| `PORT` | `4000` | webhook receiver 포트 |

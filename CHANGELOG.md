# Changelog

All notable changes to `@bitpal/checkout`. Versions follow [semver](https://semver.org/) (pre-1.0: a minor bump may contain breaking changes, called out below).

Source of truth: the BitPal monorepo (`packages/checkout-sdk`). The public repo `superlabs-x/bitpal-checkout-sdk` mirrors it.

## Unreleased

_Nothing yet._

## 0.14.0 — 2026-11-12

No breaking change in the SDK itself. Two API value changes to check if you store them: Tron `payer_wallet` / `received_token` now come back as base58 `T…` (were `0x` hex), and `tx_hash` is no longer always `null` (it mirrors `deposit_tx_hash`).

### Added
- `CreateSessionParams.late_payments` (`'accept'` default | `'refund'`) and `CheckoutSession.late_payments`. With `'refund'`, a full payment that arrives after the payment deadline is never accepted; it is refunded automatically to the buyer about 7 days after the deadline (refund kind `late_deposit`) — the non-custodial deposit contract does not allow an earlier refund.
- Types `CheckoutRefundKind` (now including `merchant`) and `CheckoutRefundRecord` (the `checkout.refund.recorded` data, with optional `from_address` and `reason_code` for `merchant` refunds).
- No refund method, by design: BitPal is non-custodial. Refund a completed payment in the console (Sessions → session → Refund — send from your own wallet and record the transaction); BitPal verifies it on-chain and sends `checkout.refund.recorded` with `kind: "merchant"`.
- `WebhookEvent` — the webhook envelope as a discriminated union on `event`, with typed `data` per event (`CheckoutSessionPaidData`, `CheckoutSessionUnresolvedData`, `CheckoutRefundRecordedData`, … and `WebhookEventDataMap`). `parseWebhookEvent()` now returns it; the result is still assignable to `WebhookPayload`, and every `data` type keeps an index signature, so existing `event.data.foo` code compiles unchanged. `WebhookPayload` takes an optional event-name type parameter.
- `CheckoutSession.received_token_symbol` (symbol of `received_token`, which is an address).

### Changed
- Published type docs (`.d.ts`) are now English-only, and internal local-development notes were removed. The `verifyWebhookSignature` docs now state the real signed string: `HMAC-SHA256(secret, "<X-Webhook-Timestamp>.<raw body>")` (the implementation was already correct).
- `CheckoutSession.tx_hash` is marked `@deprecated` — use `deposit_tx_hash` / `sweep_tx_hash`.
- `x402()` JSDoc example: `amount` is human-readable, so the "$1 per call" example now uses `amount: '1'` (it showed `'1000000'`).

### API (applies to every SDK version once the API is deployed)
- Every webhook's `data` now includes `metadata` — the metadata you set when creating the session (`{}` if none). BitPal's reserved keys (`_bitpal`, `payer_email`, `allowed_pay_chains`, `allowed_assets`) are not included.
- Session responses add `received_token_symbol`. `tx_hash` (a legacy field that was always `null`) now returns the same value as `deposit_tx_hash` and is deprecated. Tron `payer_wallet` / `received_token` are returned as base58 `T…` addresses (they used to come back as `0x` hex).
- The `CHECKOUT_AMOUNT_TOO_LOW` message now names the session currency ("Minimum checkout total is 1.00 USDC …"); the minimum itself (1.00 in the session currency) is unchanged and now documented.
- `checkout.refund.recorded` can carry `kind: "merchant"` (plus `from_address`, `reason_code`) for refunds you record in the console. Treat unknown `kind` values as a generic refund. `GET /v1/checkout/sessions/{id}/refunds` lists them too, with `from_address`, `reason_code`, `note` and `explorer_url`.
- Every error body now has the standard shape `{ error, code, retryable, trace_id }`, including errors some endpoints used to build by hand. Where `error` used to hold a code (`{ error: 'NOT_FOUND', message }`), `code` now holds it and `error` holds the message (`message` is kept too). Branch on `BitPalError.code`, not on `error.message`.
- `POST /v1/checkout/sessions/:id/resolve` is removed (`404`). Underpaid and overpaid sessions are handled automatically — an underpayment completes if the buyer sends the rest before the payment deadline and is otherwise refunded to the buyer, an overpayment settles and the excess is refunded — and the session's `unresolved` state only reports what happened. The SDK never exposed this endpoint.
- Webhook endpoints: `subscribed_events` only accepts published event names (`checkout.session.*`, `checkout.refund.recorded`, `x402.payment.resolved`) or `*`; anything else is a `400`. Duplicates are dropped.
- `GET /health` now returns only `status`, `db` and `uptime_seconds`.

## 0.13.0 — 2026-11-11

### Breaking (API — applies to every SDK version once the API is deployed)
- `getStatus()` (`GET /v1/checkout/sessions/:id/status`) now requires your API key and only returns your own sessions. 0.12 documented it as unauthenticated — call it from your backend.
- Error bodies from auth / permission / idempotency checks changed from `{ error: 'CODE', message }` to the standard `{ error: <message>, code, retryable, trace_id }`. `BitPalError.message` is the body's `error`, so code that compared `err.message === 'FORBIDDEN'` must compare `err.code` instead.
- `tolerance_percent` only accepts `"0"` (underpayments are never accepted); any other value is a `400`.
- `listSessions({ limit })` above 100 is a `400` (it used to be capped silently).
- `Idempotency-Key` is honoured on every merchant `POST` (sessions, products, prices, payment links, webhook endpoints). Reusing a key with a different method, path or body is a `422`.
- Session reads return a public resource: internal columns (`tenant_id`, `snapshot_*`, `fee_claim_*`) are gone and `snapshot_token_decimals` is now `token_decimals`. List responses carry `meta: { total, limit, offset }`.
- Webhooks: deliveries no longer follow 3xx redirects (a redirect counts as a failed attempt), and the event `data` no longer includes internal keys (`webhook_event`, `delivery_status`, `max_retries`).
- `success_url` / `cancel_url` must be `http(s)` URLs.

### Added
- `idempotencyKey` option on `createSession(params, { idempotencyKey })` and on `products.create`, `prices.create`, `paymentLinks.create` — sent as the `Idempotency-Key` header so a retried request returns the first result instead of creating a duplicate.
- `CheckoutSession`: `mode`, `amount_received`, `token_decimals`, `fee_amount_token`, `net_amount_token` (fee and net in the pay token's own decimals — matches on-chain amounts for 18-decimal tokens), plus the other public fields the API returns. `ListResponse.meta`.
- `PublicSession.payment_deadline_at` — after `expires_at` the buyer's transfer is still accepted until this time (confirmation grace).
- `PaymentOption.available` / `unavailable_reason` — an option can be listed but not selectable yet (`'coming_soon'`). Show it disabled; `issueDepositAddress` for it returns `409 CHECKOUT_CHAIN_COMING_SOON`. Also `PaymentOption.amount_atomic` (exact amount in that token's decimals).
- Solana: `PublicSession.deposit_owner` and `DepositAddress.depositOwner` — the wallet (owner) address buyers should send to. Wallets derive the token account (`deposit_address`) from it; showing only the token account can make a wallet send to the wrong account.

### Fixed
- **x402 replay store (security):** the replay key now normalises `network` the same way the API does, so the same EIP-3009 authorization can't be claimed twice as `'Base'` and `'base'`. Upgrade if you run `x402()` middleware.
- `expires_in_seconds` is range-checked before rounding up, so `1` second no longer passes as 1 minute.

### Deprecated
- `tolerance_percent` (see above).

## 0.12.0 — 2026-11-06

Merges the x402 line (0.8.0–0.11.0, previously released from the standalone repo) with the checkout API alignment fixes made in the monorepo.

### Breaking (types)
- `CreatePriceParams.currency` removed. The API always rejected it — a Price's currency is derived from `token_symbol` (`'USDC' | 'USDT' | 'JPYC'`, default `'USDC'`). Code that passed `currency` got a `400`; pass `token_symbol` instead.

### Added
- `PublicSession.pay_amount` — the exact amount the buyer must send, in the pay token's atomic units (`token_decimals`).
- `BitPalError` now carries structured fields parsed from the API error body: `code`, `apiMessage`, `retryable`, `traceId`. `error.message` is unchanged from 0.11 (it is still the body's `error` value), so existing `catch` code keeps working. Also exported: `parseApiErrorBody`, `BitPalErrorDetails`.
- `CreateSessionParams.expires_in_minutes` (1–60, default 15) — the session payment window.
- Non-JSON error responses (e.g. an HTML `502` from a gateway) now throw `BitPalError` with `HTTP <status>` instead of a `SyntaxError`.

### Fixed
- **Session expiry was silently ignored.** `expires_in_seconds` was never an API field, so every session used the 15-minute default. The SDK now sends `expires_in_minutes`; `expires_in_seconds` is deprecated and converted (rounded up to whole minutes, 60–3600 s). Out-of-range values throw before the request.
- `payer_wallet` and `pay_asset` on `createSession` are deprecated and no longer sent — the API never accepted them (it dropped them silently).
- A contract test checks every SDK request (method, path, query and body keys) against the API's generated OpenAPI spec, so SDK ↔ API drift like the two above fails CI.

### Fixed (docs / type comments)
- `amount_total` is **always canonical 6-decimal**, regardless of the pay token. Only `amount_received`, `pay_amount` and the issued `expectedAmount` use `token_decimals`. (0.11 said `amount_total` used token decimals — wrong for 18-decimal tokens.)
- Line item / Price `amount` is quoted in the line item's `currency` (`USDC`/`USDT` = USD, `JPYC` = JPY, no FX), not always USD.
- Browser use: only `getPublicSession` may be called from a merchant's browser (CORS). Call `issueDepositAddress` / `getStatus` through your backend.
- README: `previewFee` example now passes a human amount (`'29.00'`) — 0.11's README passed an atomic value, which the API reads as a human amount (1,000,000× too large).
- README: full payments after the deadline (up to 7 days) are accepted as late payments (`late: true` on `checkout.session.paid`), not refunded.

## 0.11.0 — 2026-09-17
- **Breaking (x402 payer):** standard x402 payload — one EIP-3009 authorization and one signature (`{ signature, authorization }`). Fee split is committed by the `payTo` forwarder address. Old two-signature headers get a fresh `402`.
- `paymentRequirements` carries the merchant wallet.

## 0.10.0 — 2026-09-17
- Webhook event `x402.payment.resolved` (an x402 payment left unresolved by `/settle` was later settled on-chain).

## 0.9.0 — 2026-09-17
- **Breaking:** `x402({ amount })` and `previewFee(amount)` take a human amount (`'1.00'`); use `amountAtomic` / `{ amountAtomic }` for raw values.

## 0.8.0 — 2026-09-16
- `x402()` per-call payment middleware, `createX402Payment()` payer helper, `X402ReplayStore` (memory default; pass a shared store when running several instances).

## 0.7.0 — 2026-07-30
- `allowed_assets: { chain, token }[]` as the standard way to set payment options.

## 0.6.0 — 2026-07-30
- Human `amount` input for line items and Prices; `paymentLinks` resource.

## 0.5.0 — 2026-07-23
- Initial public release: sessions, per-order deposit addresses, status polling, timestamped webhook signatures.

# Changelog

All notable changes to `@bitpal/checkout`. Versions follow [semver](https://semver.org/) (pre-1.0: a minor bump may contain breaking changes, called out below).

Source of truth: the BitPal monorepo (`packages/checkout-sdk`). The public repo `superlabs-x/bitpal-checkout-sdk` mirrors it.

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

# @bitpal/checkout

BitPal Checkout SDK — **non-custodial** crypto checkout. Create sessions, issue per-order deposit
addresses, poll status, and verify signed webhooks. BitPal never custodies funds: each order gets a
deposit address cryptographically committed to your wallet, and payments are swept directly to you.

## Install

```bash
pnpm add @bitpal/checkout
# npm i @bitpal/checkout / yarn add @bitpal/checkout
```

## Amounts — just pass a human number

Use **`amount`** in line items — a plain USD string like `"20"`, `"0.5"`, `"29.00"`. No decimals to compute.

```ts
line_items: [{ name: 'Pro', amount: '29', currency: 'USDC' }]
```

**The amount is a USD price — it does NOT depend on the chain or token decimals.** Whether the buyer pays with USDC (6dp) on Base or USDT (18dp) on BNB, you pass the same `amount`. BitPal rescales to the buyer's chosen token at deposit time. So you never compute per-token decimals. (Prices via `prices.create` take the same `amount`.)

<details><summary>Advanced: raw atomic amounts</summary>

If you already hold **atomic μUSD integer strings** ($1 = `"1000000"`), pass `amount_atomic` instead (mutually exclusive with `amount`):

```
$1.00 → "1000000"   $29.00 → "29000000"   $0.50 → "500000"
```

Helpers for atomic conversion (e.g. reading `amount_total` back): `toAtomic(v, decimals)` / `fromAtomic(v, decimals)` — read `decimals` from `payment_options[]`/`token_decimals` (6 for USDC/USDT, 18 for BNB USDT). `toAtomicUSDC`/`fromAtomicUSDC` are 6dp shortcuts.
</details>

## Environments

API keys are environment-scoped:

- `bp_test_...` — Test mode (testnets). No real funds.
- `bp_live_...` — Live mode (mainnets).

Get keys in the console under **Developers → API Keys**. The key you use decides the environment —
there is no separate flag.

## Usage

### Setup

```ts
import { BitPal } from '@bitpal/checkout';
// (optional atomic helpers if you need them: import { toAtomic, fromAtomic } from '@bitpal/checkout')

const bitpal = new BitPal(process.env.BITPAL_API_KEY!); // bp_test_... / bp_live_...
```

> Works with both ESM (`import`) and CommonJS (`const { BitPal } = require('@bitpal/checkout')`).

### Create a session → redirect to the hosted checkout (simplest)

`createSession` returns a `checkout_url`. Redirect the buyer there — BitPal hosts the payment page,
shows the per-order deposit address + QR, and confirms the payment on-chain.

```ts
const { data: session } = await bitpal.checkout.createSession({
  line_items: [
    { name: 'Pro Plan', amount: '29', currency: 'USDC' },  // `currency` = price denomination (USD via USDC)
  ],
  // Payment options the buyer may choose — (chain, token) pairs. Mix tokens freely.
  //   `chain` accepts a short-name ('base' | 'arbitrum' | 'bnb' | 'tron' | 'solana') or a CAIP-2 id;
  //   it resolves to the right testnet/mainnet chain for your mode (test vs live key) automatically.
  allowed_assets: [
    { chain: 'base',   token: 'USDC' },
    { chain: 'tron',   token: 'USDT' },
    { chain: 'solana', token: 'USDC' },
  ],
  expires_in_seconds: 1800,
  success_url: 'https://yourstore.com/thanks',
});

// Redirect the buyer here — the hosted page handles the deposit address.
redirect(session.checkout_url!);
```

**Setting the payment options** (precedence, highest first):

- **`allowed_assets`** — `(chain, token)` cells. The standard, most explicit way; the buyer picks any listed pair (lets you mix tokens, e.g. USDC on Base + USDT on Tron).
- `allowed_pay_chains: string[]` — shorthand for "the line-item `currency` across these chains" (one token, many chains).
- `pay_chain: string` — a single fixed chain, no buyer choice.

`pay_chain` and `allowed_pay_chains` are mutually exclusive; `allowed_assets` takes precedence over both. Omit all three and it defaults to **one chain × the line-item currency**. `currency` on the line item is always the **price denomination** (what the amount is quoted in) — independent of which token the buyer pays with.

### Self-hosted flow: issue a deposit address yourself

If you render your own payment UI, issue the per-order deposit address and show it to the buyer.
The buyer then sends the exact amount from **any wallet or exchange** — no wallet connection, no
signature; they pay their own network gas. A watcher detects the deposit and a keeper sweeps it to
you.

```ts
const { data } = await bitpal.checkout.issueDepositAddress(session.id, {
  session_token: session.session_token!, // from createSession
  refundAddress: '0xBuyerWallet...',      // VM-matched (EVM 0x… / Tron T… / Solana base58); committed, immutable after issuance
  chain: 'eip155:84532',                  // match the session's chain (test: Base Sepolia / live: eip155:8453).
                                          // only needed for multi-option (allowed_assets / allowed_pay_chains) sessions
  token: 'USDC',
});

console.log(data.depositAddress);  // buyer sends the exact amount here
console.log(data.expectedAmount);  // atomic μUSDC — display this exact amount
```

> `refundAddress` is committed into the deposit address and **cannot change** after issuance
> (over / under / late payments auto-refund there on-chain).

### Poll status (buyer UX)

```ts
const { data } = await bitpal.checkout.getStatus(session.id); // no auth needed
// status: awaiting_deposit → deposit_detected → paid_confirmed → swept
```

Polling is for buyer-facing UX. For **server-side** confirmation, trust the webhook (below).

### Preview the fee

```ts
const { data: fee } = await bitpal.checkout.previewFee(toAtomicUSDC('29.00'));
console.log(fromAtomicUSDC(fee.fee_amount)); // e.g. "0.43"
```

## Webhooks

Register an endpoint in **Developers → Webhooks**. Verify every delivery with the shared secret
(`whsec_...`) before trusting it.

```ts
import express from 'express';
import { verifyWebhookSignature, parseWebhookEvent, WEBHOOK_HEADERS } from '@bitpal/checkout';

const app = express();

app.post(
  '/webhook',
  express.raw({ type: 'application/json' }), // raw body — do NOT use express.json() (the raw body is signed)
  async (req, res) => {
    const raw = req.body.toString('utf8'); // raw body — parsing/re-serializing breaks the signature
    const ok = await verifyWebhookSignature(
      raw,
      req.header(WEBHOOK_HEADERS.signature) ?? '', // 'sha256=<hex>'
      process.env.BITPAL_WEBHOOK_SECRET!,          // whsec_...
      { timestamp: req.header(WEBHOOK_HEADERS.timestamp) ?? '' }, // replay defense — REQUIRED
    );
    if (!ok) return res.status(400).send('invalid signature');

    const event = parseWebhookEvent(raw);

    // ⚠️ At-least-once delivery — dedup on the SIGNED body id (event.id), not the
    //    X-Webhook-Id header (unsigned → forgeable). Persist the key in the same txn.
    if (await alreadyProcessed(event.id)) return res.status(200).send('already processed');

    switch (event.event) {
      case 'checkout.session.paid':    // on-chain confirmed
      case 'checkout.session.settled': // swept to your wallet
        await fulfill(event.data.session_id);
        break;
    }
    res.status(200).send('ok');
  },
);
```

### Events

| Event | Meaning |
|-------|---------|
| `checkout.session.created` | Session created |
| `checkout.session.deposit_detected` | Deposit seen on-chain (awaiting confirmations) |
| `checkout.session.paid` | Payment confirmed on-chain |
| `checkout.session.settled` | Funds swept to your wallet |
| `checkout.session.expired` | Session expired unpaid |
| `checkout.session.unresolved` | Underpaid / overpaid / wrong token — needs review |
| `checkout.refund.recorded` | An on-chain auto-refund (over / under / late payment) was recorded |
| `x402.payment.resolved` | An x402 payment that `/settle` left unresolved was later settled on-chain (see below) |

### ⚠️ Replay defense + at-least-once delivery

The signature covers `` `${X-Webhook-Timestamp}.${rawBody}` `` (HMAC-SHA256), and `verifyWebhookSignature`
**requires** the `X-Webhook-Timestamp` header and rejects deliveries outside a ±5 min freshness window
(override with `toleranceSec`). This blocks replay of a captured request.

BitPal may still deliver the **same event more than once** within the window. Deduplicate on the
**signed body id** (`event.id` from `parseWebhookEvent`), **not** the `X-Webhook-Id` header (the header
is not signed, so it is forgeable). Persist the dedup key in the **same transaction** as your side
effect; handlers must be safe to run twice (UPSERT, not INSERT).

## x402 — charge per API call

A different lane from checkout: no page, no redirect, no deposit address. The caller pays with a
signed authorization and retries the request. Settles to the **same payout wallet as checkout**
(register one in the console first).

### Merchant side

```ts
import { x402 } from '@bitpal/checkout';

// $1.00 USDC per call
app.get('/report', x402({
  apiKey: process.env.BITPAL_API_KEY,   // bp_test_… or bp_live_…
  payTo: '0xYourPayoutWallet',
  network: 'base',                      // test key → 'base-sepolia'
  amount: '1.00',                       // human-readable — no decimals math
}), (req, res) => {
  res.json({ report: '…' });            // req.x402Payment has the txHash
});
```

Unpaid requests get a `402` with the payment terms. Paid ones run `verify` → `settle` and reach your
handler with `X-PAYMENT-RESPONSE` set. The middleware also does what the API cannot do for you:

- **One payment unlocks one response.** `/settle` is idempotent, so replaying the same `X-PAYMENT`
  keeps returning success — which would let one payment buy unlimited calls. The middleware records
  redeemed authorizations and rejects reuse with `409`. Redemption is recorded only once your
  response actually ships: if the handler throws, the caller can retry with the same header instead
  of paying for nothing.
- **Only re-prompts for payment when the money definitely did not move.** `reverted`, `expired` and
  `failed` get a fresh `402`. Everything else — settlement still in flight, an uncertain broadcast, a
  timeout — answers `503` and asks for a retry with the *same* header. Handing back a `402` there
  would make the caller re-sign and pay twice.

When `/settle` answers `503`, nobody knows yet whether the money moved — so BitPal watches the chain
and tells you how it ended with a **`x402.payment.resolved`** webhook (`status`: `confirmed` |
`reverted` | `expired`, plus `payment_id` and `tx_hash`). It fires only on that path: the normal case
already returned the result to you, and you should not have to handle the same outcome twice. Verify
it exactly like a checkout webhook.

Not on Express? `X402Gate` is the framework-neutral core — give it the header and the resource URL,
it tells you whether to bill or serve. On a `settled` result, call `commit()` once you have delivered
the response, or `release()` if you could not.

**Two things to set for production:**

- `replayStore` — the default keeps redeemed payments in process memory, so a second instance does
  not know what the first one served. Pass a shared store (Redis/DB) whose `claim` is an atomic
  compare-and-set. The memory store also refuses new payments rather than evicting live entries once
  it fills, so a busy single instance needs a real store too.
- `resource` — by default it is derived from the request's `Host` header, which the caller controls.
  The payment binds to that string, so pass an explicit `resource` (or a function) to pin it.

### Payer side

The payer signs **one** standard EIP-3009 authorization, so the `X-PAYMENT` payload is plain x402:
`{ signature, authorization }`. The fee split happens on-chain — `payTo` in the `402` is not the
merchant's wallet but a CREATE2 address that commits to the whole split, so nothing extra has to be
signed for it.

`createX402Payment` reads the `402` and builds the header. You supply the signer; the SDK has no
crypto dependency.

```ts
import { createX402Payment } from '@bitpal/checkout';

const res = await fetch(url);
if (res.status === 402) {
  const { header } = await createX402Payment({
    requirements: await res.json(),
    from: account.address,
    signTypedData: (req) => walletClient.signTypedData({ account, ...req }), // viem
  });
  const paid = await fetch(url, { headers: { 'X-PAYMENT': header } });
}
```

### Supported

| Network | Token | `network` |
|---|---|---|
| Base | USDC | `base` |
| Base Sepolia | USDC | `base-sepolia` |

Amounts are human-readable (`'1.00'`), the same model as `line_items[].amount` — the server converts.
Pass `amountAtomic` instead if you already have raw units.

The `402` also carries a `feeBreakdown` (net / fee / bps / recipient). It is informational — a payer
can ignore it entirely and still pay correctly, because the split is already committed by the `payTo`
address. It is there so you can see where the money goes without reading the chain.

EOA signers only — smart-contract wallets cannot sign EIP-3009 authorizations. Amounts are exact:
over- and underpayment are both rejected, and this lane has no refund path. Authorizations are valid
for 90–3600 seconds (the server's floor is 60s; the extra 30s absorbs clock skew and round trips).

## Config options

```ts
new BitPal(apiKey);                          // string shorthand — defaults to https://api.bitpal.io
new BitPal({ apiKey, baseUrl: 'https://…' }); // config object — override baseUrl (self-hosted / staging)
```

## Integration flow

1. Backend → `bitpal.checkout.createSession(...)` → get `checkout_url` (+ `session_token`).
2. Redirect the buyer to `checkout_url` (or render your own UI + `issueDepositAddress`).
3. Buyer sends the exact amount to the deposit address from any wallet / exchange.
4. BitPal detects + confirms on-chain, then sweeps directly to your wallet (non-custodial).
5. Your webhook receives `checkout.session.paid` / `settled` → fulfill the order.

## Runnable examples

The source repo's `examples/` directory has runnable references (not shipped in the npm
package): `create-session.mjs`, `webhook-receiver.mjs`, and a `full-integration/` Express
store wiring session creation + webhook verification + idempotency.

## Build

```bash
pnpm build   # tsup → dist/ (ESM + .d.ts)
```

## Migrating to 0.11.0 (breaking — x402 payer only)

The `X-PAYMENT` payload changed from BitPal's two-authorization shape to the **x402 standard**:

```
0.10.0   payload: { merchant: {...}, fee: {...} }     two signatures
0.11.0   payload: { signature, authorization }        one signature — plain x402
```

- If you call `createX402Payment`, nothing changes in your code. It signs once now instead of twice,
  and the wallet prompts once.
- If you built the payload by hand, rebuild it in the standard shape.
- `splitSignature` is gone. `normalizeSignature` replaces it — same input handling (65-byte or
  EIP-2098 compact, `v` of 0/1/27/28) but it returns a 65-byte packed hex string, which is what the
  payload carries.
- The `402` is unchanged apart from `payTo`, which now points at the settlement address rather than
  the merchant wallet. Both `X402Gate` and `x402()` handle this for you.

Old headers are rejected — a payer on 0.10.0 gets a fresh `402` and re-signs, so no payment is lost.

## Migrating from 0.3.x → 0.5.0 (breaking)

- **Webhook verification now requires the timestamp** and enforces replay defense. Pass the
  `X-Webhook-Timestamp` header as the 4th argument:
  `verifyWebhookSignature(rawBody, sigHeader, secret, { timestamp: tsHeader })`. A 3-argument call now
  returns `false`. The signed content changed from `body` to `` `${timestamp}.${body}` ``.
- Deduplicate on the signed `event.id`, not the `X-Webhook-Id` header.
- Removed 안1 methods (`payWithAuthorization`, `submitExternalPayment`) and escrow refund helpers —
  checkout is non-custodial deposit-address (see Usage above).

## License

MIT © BitPal. See [LICENSE](./LICENSE).

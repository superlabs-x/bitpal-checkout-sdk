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
    { name: 'Pro Plan', amount: '29', currency: 'USDC' },  // just the USD number
  ],
  pay_chain: 'eip155:84532',     // Base Sepolia (test mode). Live mode: 'eip155:8453' (Base mainnet).
                                 // Or use allowed_pay_chains for a buyer-picked chain.
  expires_in_seconds: 1800,
  success_url: 'https://yourstore.com/thanks',
});

// Redirect the buyer here — the hosted page handles the deposit address.
redirect(session.checkout_url!);
```

`pay_chain` (single fixed chain) and `allowed_pay_chains` (buyer picks) are mutually exclusive.

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
                                          // only needed for multi-option (allowed_pay_chains) sessions
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

### ⚠️ Replay defense + at-least-once delivery

The signature covers `` `${X-Webhook-Timestamp}.${rawBody}` `` (HMAC-SHA256), and `verifyWebhookSignature`
**requires** the `X-Webhook-Timestamp` header and rejects deliveries outside a ±5 min freshness window
(override with `toleranceSec`). This blocks replay of a captured request.

BitPal may still deliver the **same event more than once** within the window. Deduplicate on the
**signed body id** (`event.id` from `parseWebhookEvent`), **not** the `X-Webhook-Id` header (the header
is not signed, so it is forgeable). Persist the dedup key in the **same transaction** as your side
effect; handlers must be safe to run twice (UPSERT, not INSERT).

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

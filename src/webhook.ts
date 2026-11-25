/**
 * @bitpal/checkout — webhook signature verification and event types.
 *
 * Matches the envelope, signature and headers BitPal sends.
 */
import type { CheckoutRefundRecord } from './types.js';

/**
 * Every webhook event name BitPal sends.
 */
export const CHECKOUT_WEBHOOK_EVENTS = [
  'checkout.session.created',
  'checkout.session.deposit_detected',
  'checkout.session.paid',
  'checkout.session.settled',
  'checkout.session.expired',
  'checkout.session.unresolved',
  'checkout.refund.recorded',
  // An x402 payment reached a final outcome. Sent whichever path got there — your `settle` call or the
  // reconciler afterwards — so make the handler idempotent; `settle` also answers inline.
  'x402.payment.resolved',
  // We could not determine an x402 payment's outcome automatically. Not final, and `resolved` is not
  // guaranteed to follow. Nothing for you to do; mark the call outstanding.
  'x402.payment.needs_review',
] as const;

export type CheckoutWebhookEvent = (typeof CHECKOUT_WEBHOOK_EVENTS)[number];

/**
 * Webhook envelope (HTTP body), with `data` loosely typed.
 * For per-event `data` types use {@link WebhookEvent} (what {@link parseWebhookEvent} returns) and narrow on `event`.
 */
export interface WebhookPayload<E extends CheckoutWebhookEvent = CheckoutWebhookEvent> {
  /** Event id. Deduplicate on it — unchanged on retries and replays. Test events start with `test_`. */
  id: string;
  /** Event name. */
  event: E;
  /** When the event happened (ISO 8601, unchanged on retries). */
  created_at: string;
  /** Event data. */
  data: Record<string, unknown>;
}

/**
 * The `metadata` you set when creating the session (`{}` if none). BitPal's reserved keys (`_bitpal`, `payer_email`,
 * `allowed_pay_chains`, `allowed_assets`) are not included.
 */
export type WebhookSessionMetadata = Record<string, unknown>;

/** Fields every `checkout.session.*` event carries. More fields may be added. */
export interface CheckoutSessionEventBase {
  session_id: string;
  /** Your session metadata. */
  metadata: WebhookSessionMetadata;
  /** Session total, 6-decimal integer string ("1000000" = 1). */
  amount_total: string;
  currency: string;
  /** `true` when the full amount arrived after the payment window. */
  late?: boolean;
  [key: string]: unknown;
}

/**
 * Deposit fields on `deposit_detected`, `paid`, `unresolved`, `settled` and `expired` — same names as on the session.
 * `tx_hash` is still sent with the same value as `deposit_tx_hash` for compatibility.
 */
export interface CheckoutSessionDepositFields {
  /** The buyer's payment into the deposit address. null when nothing was received. */
  deposit_tx_hash?: string | null;
  /** Symbol of the token received (e.g. `USDC`). */
  received_token_symbol?: string | null;
  /** Decimals of `amount_received` / `amount_expected` (USDC/USDT = 6; BNB Chain USDC/USDT and JPYC = 18). `amount_total` is always 6-decimal. */
  token_decimals?: number | null;
}

/** `checkout.session.created` */
export type CheckoutSessionCreatedData = CheckoutSessionEventBase;

/**
 * `checkout.session.deposit_detected` — funds seen, waiting for confirmations. Optional: skipped when the deposit is
 * already confirmed the first time BitPal sees it, so never wait for it.
 */
export interface CheckoutSessionDepositDetectedData extends CheckoutSessionEventBase, CheckoutSessionDepositFields {
  /** Same as `deposit_tx_hash`. */
  tx_hash: string;
  /** Atomic amount in the pay token's own decimals. */
  amount_received: string;
  /** Token contract / mint address actually received (not the symbol). */
  received_token: string;
}

/** `checkout.session.paid` — confirmed, safe to fulfil. */
export interface CheckoutSessionPaidData extends CheckoutSessionEventBase, CheckoutSessionDepositFields {
  /** Same as `deposit_tx_hash`. */
  tx_hash?: string;
}

/** `checkout.session.settled` — swept to your payout wallet. */
export interface CheckoutSessionSettledData extends CheckoutSessionEventBase, CheckoutSessionDepositFields {
  sweep_tx_hash?: string;
}

/**
 * `checkout.session.unresolved` — see `reason`:
 * - `underpaid`: less than the amount arrived; the buyer can top up until the deadline.
 * - `late`: a full payment arrived after the deadline on a session created with `late_payments: 'refund'`. It is not
 *   accepted and is refunded to the buyer automatically at `refund_available_at` (`checkout.refund.recorded`,
 *   kind `late_deposit`). Sent once.
 * - `reorg`: a confirmed deposit was reverted.
 * - `wrong_token`: sessions created before 2026-11-12 only.
 */
export interface CheckoutSessionUnresolvedData extends CheckoutSessionEventBase, CheckoutSessionDepositFields {
  reason: 'underpaid' | 'late' | 'reorg' | 'wrong_token' | (string & {});
  /** `underpaid`: the expected amount in the pay token's decimals. */
  amount_expected?: string;
  amount_received?: string;
  received_token?: string;
  /** Same as `deposit_tx_hash`. */
  tx_hash?: string;
  /** `late`: when the automatic refund becomes possible (about 7 days after the deadline). */
  refund_available_at?: string;
}

/** `checkout.session.expired` — the deadline passed without a full payment. */
export interface CheckoutSessionExpiredData extends CheckoutSessionEventBase, CheckoutSessionDepositFields {
  /**
   * `no_deposit` = nothing was paid. `underpaid` = still short at the deadline; what was received is refunded.
   * `late_payment_refunded` = a full payment arrived after the late-acceptance cutoff and was refunded.
   */
  reason?: 'no_deposit' | 'underpaid' | 'late_payment_refunded' | (string & {});
  expired_at?: string;
  /** What noticed the expiry. Informational. */
  source?: 'lazy' | 'cron' | 'deposit_scan' | (string & {});
  /** Set when what was received was refunded. */
  refund_tx_hash?: string;
}

/** `checkout.refund.recorded` */
export interface CheckoutRefundRecordedData extends CheckoutRefundRecord {
  session_id: string;
  /** Your session metadata. */
  metadata: WebhookSessionMetadata;
  [key: string]: unknown;
}

/**
 * `x402.payment.resolved` — an x402 payment reached a final outcome.
 *
 * Fired whichever path got there: your own `settle` call, or the reconciler afterwards. Which process
 * wrote the row first is timing you do not control, so the event does not depend on it. Settle also
 * answers inline, so **make this handler idempotent** — treat the event as the durable record of a
 * fact you may already have acted on.
 */
export interface X402PaymentResolvedData {
  payment_id: string;
  /**
   * Final outcomes only.
   *
   * `uncharged_expired` is upto-only: you verified an authorization, never called `charge()`, and it
   * expired — revenue you served but did not bill. `voided` is upto charging zero on purpose, which is
   * a different event: one is your choice, the other is money you lost.
   *
   * States still in flight and states awaiting a human never appear here, nor does an upto settlement
   * that reverted while the authorization is still usable.
   */
  status: 'confirmed' | 'reverted' | 'expired' | 'uncharged_expired' | 'voided';
  resource: string;
  scheme: 'exact' | 'upto';
  /** Atomic amount in the token's decimals. **null** when nothing was ever charged. */
  amount: string | null;
  /** Ceiling the payer approved (`upto` only). On `uncharged_expired`, what you could have billed. */
  max_gross_amount: string | null;
  asset: string;
  chain: string;
  tx_hash: string | null;
  payer: string;
  /**
   * Diagnostic only. Which process recorded the outcome depends on timing you do not control, so do
   * not branch your accounting or fulfilment on it.
   */
  resolved_by: 'settle' | 'reconciler';
  [key: string]: unknown;
}

/**
 * `x402.payment.needs_review` — we could not determine the payment's outcome automatically.
 *
 * You already served the resource, but whether you were paid is unknown. Mark the call as outstanding
 * and do not count it as paid or as failed.
 *
 * There is nothing for you to do here — recovery runs on our relayer, not yours.
 *
 * **This is not a final state, and a `resolved` event is not guaranteed to follow.** If the outcome
 * stays undeterminable, it stays here. When it does resolve, `x402.payment.resolved` arrives with the
 * same `payment_id`, and **that terminal event wins over this one** regardless of the order they reach
 * you — so never let a late `needs_review` move a payment back out of a settled ledger.
 */
export interface X402PaymentNeedsReviewData {
  payment_id: string;
  /**
   * Always `needs_review`. Deliberately a single value: our internal reason codes describe what
   * evidence we have, not where the money is, and exposing them would imply a certainty we lack.
   */
  status: 'needs_review';
  resource: string;
  scheme: 'exact' | 'upto';
  /** What the payer would have been charged, if a charge was recorded. **Not** proof it moved. */
  amount: string | null;
  /** Ceiling the payer approved (`upto` only; null for `exact`). */
  max_gross_amount: string | null;
  asset: string;
  chain: string;
  /** The transaction we were looking at, when there is one. It may have succeeded, failed, or be unreadable. */
  tx_hash: string | null;
  payer: string;
  [key: string]: unknown;
}

/** `data` type for each event name. */
export interface WebhookEventDataMap {
  'checkout.session.created': CheckoutSessionCreatedData;
  'checkout.session.deposit_detected': CheckoutSessionDepositDetectedData;
  'checkout.session.paid': CheckoutSessionPaidData;
  'checkout.session.settled': CheckoutSessionSettledData;
  'checkout.session.expired': CheckoutSessionExpiredData;
  'checkout.session.unresolved': CheckoutSessionUnresolvedData;
  'checkout.refund.recorded': CheckoutRefundRecordedData;
  'x402.payment.resolved': X402PaymentResolvedData;
  'x402.payment.needs_review': X402PaymentNeedsReviewData;
}

/**
 * A webhook envelope typed per event — a discriminated union on `event`.
 *
 * @example
 * ```ts
 * const event = parseWebhookEvent(raw);
 * if (event.event === 'checkout.session.paid') {
 *   event.data.metadata.order_id; // your session metadata
 *   event.data.late;              // boolean | undefined
 * }
 * ```
 */
export type WebhookEvent = {
  [E in CheckoutWebhookEvent]: {
    id: string;
    event: E;
    created_at: string;
    data: WebhookEventDataMap[E];
  };
}[CheckoutWebhookEvent];

/** Header names BitPal sends. */
export const WEBHOOK_HEADERS = {
  signature: 'X-Webhook-Signature-256',
  timestamp: 'X-Webhook-Timestamp',
  event: 'X-Webhook-Event',
  eventId: 'X-Webhook-Id',
  deliveryId: 'X-Webhook-Delivery-Id',
} as const;

const SIGNATURE_PREFIX = 'sha256=';

/**
 * Verify a webhook signature.
 *
 * BitPal sends `X-Webhook-Signature-256: sha256=<hex>`, where `<hex>` is
 * `HMAC-SHA256(secret, "<X-Webhook-Timestamp>.<raw body>")`. Pass the raw request body exactly as received
 * (parsing and re-serialising it breaks the signature) and the `X-Webhook-Timestamp` header. The timestamp must be
 * within `toleranceSec` (default 300 s) of now, which blocks replays. The comparison is timing-safe.
 *
 * @param payload - Raw HTTP request body (string).
 * @param signature - `X-Webhook-Signature-256` header value (`sha256=<hex>`).
 * @param secret - The endpoint's signing secret (`whsec_…`), shown once when the endpoint was created.
 * @param opts - `timestamp` (required): the `X-Webhook-Timestamp` header value.
 * @returns `true` if the signature matches and the timestamp is fresh. Async — always `await` it.
 *
 * @example
 * ```ts
 * import express from 'express';
 * import { verifyWebhookSignature, parseWebhookEvent, WEBHOOK_HEADERS } from '@bitpal/checkout';
 *
 * app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
 *   const raw = req.body.toString('utf8'); // raw body — do not parse and re-serialise
 *   const ok = await verifyWebhookSignature(
 *     raw,
 *     req.header(WEBHOOK_HEADERS.signature) ?? '',
 *     process.env.BITPAL_WEBHOOK_SECRET!,
 *     { timestamp: req.header(WEBHOOK_HEADERS.timestamp) ?? '' },
 *   );
 *   if (!ok) return res.status(400).send('invalid signature');
 *   const event = parseWebhookEvent(raw);
 *   // deduplicate on the signed body id (the X-Webhook-Id header is not signed)
 *   if (await alreadyProcessed(event.id)) return res.status(200).send('dup');
 *   if (event.event === 'checkout.session.paid') { ... }
 *   res.status(200).send('ok');
 * });
 * ```
 */
export interface VerifyWebhookOptions {
  /** `X-Webhook-Timestamp` header value (ISO 8601 UTC). Part of the signed string and checked for freshness. Required. */
  timestamp: string;
  /** Allowed clock difference in seconds (default 300). Timestamps further away are rejected as replays. */
  toleranceSec?: number;
}

export async function verifyWebhookSignature(
  payload: string,
  signature: string,
  secret: string,
  opts?: VerifyWebhookOptions,
): Promise<boolean> {
  if (!payload || !signature || !secret) return false;
  if (!signature.startsWith(SIGNATURE_PREFIX)) return false;

  // Replay protection: the timestamp is required.
  const timestamp = opts?.timestamp;
  if (!timestamp) return false;

  // Only a valid, canonical ISO UTC timestamp.
  const parsedMs = Date.parse(timestamp);
  if (!Number.isFinite(parsedMs)) return false;
  if (new Date(parsedMs).toISOString() !== timestamp) return false;
  const toleranceMs = (opts?.toleranceSec ?? 300) * 1000;
  if (Math.abs(Date.now() - parsedMs) > toleranceMs) return false;

  const sigHex = signature.slice(SIGNATURE_PREFIX.length);
  if (!/^[0-9a-f]{64}$/.test(sigHex)) return false;

  try {
    const crypto = await import('node:crypto');
    const expectedHex = crypto
      .createHmac('sha256', secret)
      .update(`${timestamp}.${payload}`, 'utf8') // same as the server: HMAC(secret, `${timestamp}.${body}`)
      .digest('hex');

    if (sigHex.length !== expectedHex.length) return false;

    return crypto.timingSafeEqual(
      Buffer.from(sigHex, 'hex'),
      Buffer.from(expectedHex, 'hex'),
    );
  } catch {
    return false;
  }
}

/**
 * Parse a webhook body into a {@link WebhookEvent} (narrow on `event` to get typed `data`).
 * Verify the signature first. The result is also assignable to {@link WebhookPayload}.
 *
 * @throws Error when the body is not a webhook envelope.
 */
export function parseWebhookEvent(body: string): WebhookEvent {
  const parsed = JSON.parse(body) as Record<string, unknown>;
  if (
    typeof parsed.id !== 'string' ||
    typeof parsed.event !== 'string' ||
    typeof parsed.created_at !== 'string' ||
    typeof parsed.data !== 'object' ||
    parsed.data === null
  ) {
    throw new Error('Invalid webhook envelope — expected {id, event, created_at, data}');
  }
  return parsed as unknown as WebhookEvent;
}

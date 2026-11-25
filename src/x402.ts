/**
 * x402 — merchant middleware that charges per route call.
 *
 * Merchant code only declares "this route costs $1". Building the 402, parsing `PAYMENT-SIGNATURE`, the
 * verify → settle sequence, error mapping and replay protection all live here. BitPal computes the
 * fee and includes it in the 402, so the merchant passes **only the gross amount it wants to receive**
 * (same UX as checkout `line_items[].amount`).
 *
 * Two things are handled with particular care:
 *
 *  1. **"One payment = one response" is the middleware's job.** BitPal `/settle` idempotency only
 *     guarantees that funds move once for a given nonce. Sending the same `PAYMENT-SIGNATURE` 100 times yields
 *     100 success responses, so relying on that alone would let one payment unlock unlimited calls.
 *     Authorizations that have already been served are recorded locally to block reuse (`X402ReplayStore`).
 *
 *  2. **HTTP 200 does not mean settlement succeeded.** Settling an already-finalized payment returns
 *     its existing result — even `reverted` comes back as 200. The resource is served only when
 *     `status === 'confirmed'`.
 */

import { BitPalError, parseApiErrorBody } from './client.js';
import type { ApiResponse } from './types.js';
import {
  decodePaymentSignatureHeader,
  encodePaymentRequiredHeader,
  encodePaymentResponseHeaderV2,
  X402_PAYMENT_REQUIRED_CACHE_CONTROL,
  X402_PAYMENT_REQUIRED_HEADER,
  X402_PAYMENT_RESPONSE_HEADER_V2,
  X402_PAYMENT_SIGNATURE_HEADER,
  isExactPayload,
  type Eip3009Authorization,
  type Permit2Authorization,
  type X402ResourceInfo,
  type X402UptoAccept,
  type X402V2PaymentPayload,
  type X402V2Requirements,
} from './x402-v2.js';

export type { Eip3009Authorization } from './x402-v2.js';

/* ─── Constants ─── */

// v1 의 `X-PAYMENT` / `X-PAYMENT-RESPONSE` 는 없앴다. 봉투가 v2 하나이므로 헤더도 하나다
//   (`PAYMENT-SIGNATURE` / `PAYMENT-RESPONSE`, x402-v2.ts). 두 벌을 남겨 두면 어느 쪽을 읽어야
//   하는지가 영구적인 질문으로 남는다.

/**
 * Statuses returned by settle (with HTTP 200) where it is **certain that no funds moved**.
 * Only these produce a 402 (re-sign required). The others (created/submitted/unknown/reconciliation_needed)
 * are not final yet, so asking the payer to re-sign could cause a double payment.
 */
const RESIGN_REQUIRED_STATUSES = new Set(['reverted', 'expired', 'failed']);

const DEFAULT_BASE_URL = 'https://api.bitpal.io';
const DEFAULT_TIMEOUT = 60_000;
/** Default 402 validity (seconds) — matches the server default. Also used as the in-flight claim TTL. */
const DEFAULT_MAX_TIMEOUT_SECONDS = 300;
/** Validity window range the server requires for authorizations. Outside it, verify rejects. */
const MIN_VALIDITY_SECONDS = 60;
const MAX_VALIDITY_SECONDS = 3600;
/** How long consumed nonces are remembered (seconds). Well beyond the EIP-3009 validity window, so no reuse risk. */
const CONSUMED_TTL_SECONDS = 24 * 60 * 60;
/** Cap for the default in-memory store. When full, new payments are rejected (replay protection is never dropped). */
const MEMORY_STORE_MAX_ENTRIES = 50_000;
/** Max PAYMENT-SIGNATURE header size. A normal payload is well under 1KB. */
const MAX_PAYMENT_HEADER_BYTES = 8192;

/* ─── 402 body types (values produced by the server) ─── */

export interface X402FeeBreakdown {
  netAmount: string;
  feeAmount: string;
  feeBps: number;
  feeRecipient: string | null;
}

export interface X402Accept {
  scheme: 'exact';
  /** CAIP-2 (`eip155:8453`). v1 used hyphenated short names from a hardcoded table. */
  network: string;
  asset: string;
  payTo: string;
  /** Charge amount, atomic units. v1 called this `maxAmountRequired`. */
  amount: string;
  maxTimeoutSeconds: number;
  /** Values the payer can use to build the EIP-712 domain as-is. */
  extra: { name: string; version: string; chainId: number };
  /** BitPal extension — the fee split fixed by the server. */
  feeBreakdown: X402FeeBreakdown;
}

export interface X402Requirements {
  x402Version: 2;
  /** v2 moved resource/description/mimeType out of `accepts[]` into this object. */
  resource: X402ResourceInfo;
  accepts: X402Accept[];
  error?: string;
}

/* ─── PAYMENT-SIGNATURE payload ─── */

/**
 * The standard x402 payload — a single authorization plus a 65-byte packed signature.
 *
 * Up to 0.10.0 this was a `{ merchant, fee }` pair, which required the payer to sign twice and
 * prevented stock x402 clients from paying BitPal merchants. The split is now committed by the
 * `payTo` (forwarder) address, so a single signature is enough.
 */

/**
 * Normalizes an x402 network name (trim, lowercase, '-' → '_'), matching the BitPal API. Used in the replay key.
 * 'Base', ' base ' and 'base' are the same chain and the signature does not cover the network string, so they must map to the same key.
 */
export function normalizeX402Network(network: string): string {
  return network.trim().toLowerCase().replace(/-/g, '_');
}

/* ─── Replay protection store ─── */

/** `ok` = this call claimed it first / `inflight` = another request is processing it / `used` = resource already served. */
export type X402ClaimState = 'ok' | 'inflight' | 'used';

/**
 * Store that blocks authorization reuse.
 *
 * The default implementation is in process memory — fine for a single instance, but when scaled out
 * each instance remembers separately, so one payment could unlock one call per instance. For
 * multi-instance deployments, pass a Redis/DB-backed implementation (the key is a single `network:from:nonce` string).
 */
export interface X402ReplayStore {
  claim(key: string, inflightTtlSeconds: number): X402ClaimState | Promise<X402ClaimState>;
  /** The resource was served — this key is permanently consumed. */
  commit(key: string): void | Promise<void>;
  /** Settlement did not complete — release the claim and allow retries (not consumed). */
  release(key: string): void | Promise<void>;
}

/** Default store backed by process memory. */
export function createMemoryReplayStore(): X402ReplayStore {
  const entries = new Map<string, { state: 'inflight' | 'used'; expiresAt: number }>();

  const prune = (now: number): void => {
    for (const [k, v] of entries) {
      if (v.expiresAt <= now) entries.delete(k);
    }
    if (entries.size <= MEMORY_STORE_MAX_ENTRIES) return;

    // If expiry did not shrink it enough, drop only in-flight entries (short-lived; a retry recovers them).
    //   **Never drop an unexpired 'used' entry** — that authorization would become 'ok' again, and since
    //   /settle is idempotent and returns confirmed 200, one payment would unlock the resource twice.
    for (const [k, v] of entries) {
      if (entries.size <= MEMORY_STORE_MAX_ENTRIES) break;
      if (v.state === 'inflight') entries.delete(k);
    }
  };

  return {
    claim(key, inflightTtlSeconds) {
      const now = Date.now();
      prune(now);
      const found = entries.get(key);
      if (found) return found.state;
      if (entries.size >= MEMORY_STORE_MAX_ENTRIES) {
        // Accepting here would force prune to drop unexpired 'used' entries, breaking replay protection.
        //   Reject the new payment instead (fail-closed). Traffic that hits this limit needs a
        //   shared store — see the README.
        throw new BitPalError(
          '[BitPal] x402: replay store is full. Pass a shared replayStore (Redis/DB) for this traffic level.',
          503,
        );
      }
      entries.set(key, { state: 'inflight', expiresAt: now + inflightTtlSeconds * 1000 });
      return 'ok';
    },
    commit(key) {
      entries.set(key, { state: 'used', expiresAt: Date.now() + CONSUMED_TTL_SECONDS * 1000 });
    },
    release(key) {
      entries.delete(key);
    },
  };
}

/* ─── Gate (framework-agnostic core) ─── */

export interface X402GateOptions {
  /** Your `bp_test_…` / `bp_live_…` API key. The prefix selects the network (test/live). */
  apiKey: string;
  /**
   * Pricing model for this route. Defaults to `'exact'`.
   *
   * - `'exact'` — fixed price, settled before the handler runs. x402 v1 / EIP-3009.
   * - `'upto'`  — the payer approves a **ceiling**; you charge the real amount after doing the work.
   *   x402 v2 / Permit2, and a different wire format (see `x402-v2.ts`). `collect()` returns
   *   `authorized` with a `charge()` to call once you know the usage.
   *
   * It is per route, not per merchant: `/download` is naturally `exact`, `/summarize` is `upto`.
   */
  scheme?: 'exact' | 'upto';
  /** Payout wallet. Must match the payout address registered in the console. */
  payTo: string;
  /**
   * Gross amount charged per call, as a **human-readable string** — `'0.1'`, `'1'`, `'29.00'`.
   * No need to handle chain or token decimals (same model as checkout `line_items[].amount`).
   * The fee is deducted from this amount. To pass a raw atomic value, use `amountAtomic` (mutually exclusive).
   */
  amount?: string;
  /** Raw atomic integer string (advanced). For USDC (6dp), $1 = `'1000000'`. Mutually exclusive with `amount`. */
  amountAtomic?: string;
  /** Defaults to the API key mode's default network (currently Base / Base Sepolia). */
  network?: string;
  /** Defaults to `'USDC'`. */
  asset?: string;
  description?: string;
  mimeType?: string;
  /** Time (seconds) given to the payer to sign and retry. Default 300. */
  maxTimeoutSeconds?: number;
  baseUrl?: string;
  /** BitPal API request timeout (ms). Defaults to 60s because settle waits for the receipt. */
  timeout?: number;
  /** Pass a shared store for multi-instance deployments. Defaults to process memory. */
  replayStore?: X402ReplayStore;
}

export interface X402SettledPayment {
  paymentId: string;
  txHash: string | null;
  /** Tx of the platform fee leg. Best-effort, so it may be null even when the merchant leg is confirmed. */
  feeTxHash: string | null;
  network: string;
  /** Payer address (`from` of the authorization). */
  payer: string;
  amount: string;
  /** Whether an already-settled payment was returned as-is (for auditing/debugging). */
  idempotent: boolean;
}

/** What an `upto` route gets back once the ceiling is verified but nothing has been charged yet. */
export interface X402Authorized {
  kind: 'authorized';
  /** Serve the resource. Same meaning as `settled`'s 200 — the difference is that nothing is charged yet. */
  status: 200;
  paymentId: string;
  /** Payer address (`permit2Authorization.from`). */
  payer: string;
  /** Approval ceiling, atomic units. You cannot charge more than this. */
  maxAmount: string;
  network: string;
  /**
   * Charges the actual amount and settles on-chain. Call it once you know what the work cost.
   *
   * `amount` is human-readable (`'0.42'`) unless `atomic` is set. Charging `'0'` closes the payment
   * without an on-chain transaction (`voided`) — correct when the work produced nothing billable.
   *
   * Set the returned `paymentResponseHeader` on the response under `PAYMENT-RESPONSE`.
   */
  charge: (amount: string, opts?: { atomic?: boolean }) => Promise<X402ChargeResult>;
  /** Abandon without charging. Frees the claim so the payer can retry with the same header. */
  release: () => Promise<void>;
}

export type X402ChargeResult =
  | { kind: 'charged'; payment: X402SettledPayment; paymentResponseHeader: string }
  /** Charged 0 — closed with no on-chain transaction. */
  | { kind: 'voided'; paymentId: string }
  /** Not certain whether funds moved. Do not ask the payer to re-sign; retry the same charge. */
  | { kind: 'unconfirmed'; paymentId: string; message: string };

export type X402GateResult =
  /**
   * No payment or an invalid one — respond with 402.
   *
   * The requirements go in `headers` (`PAYMENT-REQUIRED`), not `body` — clients never read the
   * body. Set every entry of `headers` on the response or agents will not see that payment is
   * possible. `body` carries a human-readable error for your logs.
   */
  | {
      kind: 'payment_required';
      status: 402;
      body: (X402Requirements & { error?: string }) | { error?: string };
      headers?: Record<string, string>;
    }
  /** This authorization has already been used to serve the resource — reuse rejected. */
  | { kind: 'already_used'; status: 409; body: { error: string; message: string } }
  /**
   * Not yet certain whether funds moved — retry with the **same** `PAYMENT-SIGNATURE` (do not re-sign).
   *
   * The body is narrowed on `error`, because whether an id exists is not incidental:
   *   - `SETTLEMENT_UNCONFIRMED` — we asked the facilitator to settle and got no answer. Funds may
   *     have moved. `paymentId` is **always** here: it is the merchant's only handle for
   *     `GET /v1/x402/payments/:id` and for matching the later webhook. Record it.
   *   - `PAYMENT_IN_PROGRESS` — another request holds the claim for this same payment and is the one
   *     talking to the facilitator. **This** request never learned an id, and it should not record
   *     anything: the sibling request will.
   */
  | {
      kind: 'unconfirmed';
      status: 503;
      body:
        | { error: 'SETTLEMENT_UNCONFIRMED'; message: string; paymentId: string }
        | { error: 'PAYMENT_IN_PROGRESS'; message: string };
    }
  /**
   * Settlement confirmed — serve the resource.
   *
   * At this point the payment is still **claimed (in flight)**. Call `commit()` after the response is
   * actually sent, or `release()` if the handler failed to serve the resource. If neither is called, the
   * claim holds until its TTL and retries get 503 in the meantime (safer than double delivery).
   */
  | {
      kind: 'settled';
      status: 200;
      payment: X402SettledPayment;
      paymentResponseHeader: string;
      commit: () => Promise<void>;
      release: () => Promise<void>;
    }
  /** `upto` only — ceiling verified, nothing charged yet. Do the work, then call `charge()`. */
  | X402Authorized;

/**
 * Framework-agnostic x402 gate.
 *
 * For Express use the `x402()` adapter below; for Hono/Fastify/Next and other runtimes, wrap this class
 * directly — pass the header and resource URL and it tells you whether to return a 402 or serve the resource.
 */
export class X402Gate {
  private readonly opts: X402GateOptions;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly store: X402ReplayStore;
  private readonly maxTimeoutSeconds: number;
  private readonly scheme: 'exact' | 'upto';

  constructor(opts: X402GateOptions) {
    if (!opts.apiKey) throw new Error('[BitPal] x402: apiKey is required.');
    if (!/^0x[a-fA-F0-9]{40}$/.test(opts.payTo)) {
      throw new Error('[BitPal] x402: payTo must be a 0x EVM address (your registered payout wallet).');
    }
    const hasHuman = opts.amount != null;
    const hasAtomic = opts.amountAtomic != null;
    if (hasHuman === hasAtomic) {
      throw new Error('[BitPal] x402: provide exactly one of `amount` ("0.1") or `amountAtomic` ("100000").');
    }
    if (hasHuman && !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(opts.amount as string)) {
      throw new Error('[BitPal] x402: amount must be a decimal string like "0.1" or "29" (max 6 decimals).');
    }
    if (hasAtomic && !/^\d+$/.test(opts.amountAtomic as string)) {
      throw new Error('[BitPal] x402: amountAtomic must be an integer string (USDC 6dp, $1 = "1000000").');
    }
    const timeoutSeconds = opts.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
    if (timeoutSeconds < MIN_VALIDITY_SECONDS || timeoutSeconds > MAX_VALIDITY_SECONDS) {
      // The server rejects authorizations outside this range; without this check the payer would sign
      //   against the 402 and every verify would fail.
      throw new Error(
        `[BitPal] x402: maxTimeoutSeconds must be between ${MIN_VALIDITY_SECONDS} and ${MAX_VALIDITY_SECONDS} (got ${timeoutSeconds}).`,
      );
    }
    this.opts = opts;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeout = opts.timeout ?? DEFAULT_TIMEOUT;
    this.store = opts.replayStore ?? createMemoryReplayStore();
    this.maxTimeoutSeconds = opts.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
    this.scheme = opts.scheme ?? 'exact';
  }

  /**
   * Fetches this resource's 402 body from the server (including the fee split).
   *
   * The shape follows the scheme: `exact` returns the v1 body, `upto` the v2 one (top-level
   * `resource` object, `accepts[]` without per-entry resource strings).
   */
  async requirements(resource: string): Promise<X402Requirements | X402V2Requirements> {
    return this.request<X402Requirements | X402V2Requirements>('POST', '/v1/x402/requirements', {
      payTo: this.opts.payTo,
      ...(this.scheme === 'upto' ? { scheme: 'upto' as const } : {}),
      // The server converts human-readable amounts to atomic units; the SDK does not need to know decimals.
      ...(this.opts.amount != null ? { amount: this.opts.amount } : { amountAtomic: this.opts.amountAtomic }),
      resource,
      ...(this.opts.network ? { network: this.opts.network } : {}),
      ...(this.opts.asset ? { asset: this.opts.asset } : {}),
      ...(this.opts.description ? { description: this.opts.description } : {}),
      ...(this.opts.mimeType ? { mimeType: this.opts.mimeType } : {}),
      maxTimeoutSeconds: this.maxTimeoutSeconds,
    });
  }

  /**
   * Processes one `PAYMENT-SIGNATURE` header. Returns 402 if missing or malformed, `settled` once settlement completes.
   *
   * Order matters: **claim → verify → settle → record consumption**. Claiming before verify ensures that
   * concurrent submissions of the same authorization result in only one request being served.
   */
  async collect(input: {
    /**
     * `PAYMENT-SIGNATURE`. **Both schemes use this header** — the v1 `X-PAYMENT` envelope is gone.
     *
     * `header` is still accepted as an alias so callers that funnel one argument keep working;
     * it is read as a `PAYMENT-SIGNATURE` value, not as a v1 payload.
     */
    paymentSignature?: string | null;
    header?: string | null;
    resource: string;
  }): Promise<X402GateResult> {
    if (this.scheme === 'upto') return this.collectUpto(input);
    const { resource } = input;
    const raw = input.paymentSignature ?? input.header;
    if (!raw) return this.paymentRequired(resource);

    let payload: X402V2PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(raw);
    } catch {
      return this.paymentRequired(resource, 'MALFORMED_PAYMENT_SIGNATURE');
    }
    // The payer picked the scheme in `accepted`. A gate configured for `exact` must not settle an
    //   `upto` authorization — the bodies are different and the amount semantics differ (ceiling vs charge).
    if (!isExactPayload(payload)) {
      return this.paymentRequired(resource, 'SCHEME_MISMATCH');
    }

    const auth = payload.payload.authorization;
    if (!auth?.from || !auth?.nonce) {
      return this.paymentRequired(resource, 'MALFORMED_PAYMENT_SIGNATURE');
    }

    // The key scope matches EIP-3009's on-chain uniqueness scope (network + from + nonce). The network is
    //   normalized like the API does, since the signature does not cover it ('Base' and 'base' must collide).
    const key = `${normalizeX402Network(payload.accepted.network)}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
    const claim = await this.store.claim(key, this.maxTimeoutSeconds);
    if (claim === 'used') {
      return {
        kind: 'already_used',
        status: 409,
        body: {
          error: 'PAYMENT_ALREADY_USED',
          message: 'This payment has already been redeemed. One payment unlocks one response.',
        },
      };
    }
    if (claim === 'inflight') {
      return {
        kind: 'unconfirmed',
        status: 503,
        body: {
          error: 'PAYMENT_IN_PROGRESS',
          message: 'This payment is still being settled. Retry with the same PAYMENT-SIGNATURE header.',
        },
      };
    }

    // Rebuild the payment requirements ourselves — trusting payer-supplied values would allow swapping amount/recipient.
    // 402 를 다시 내줄 때 **통째로** 필요하다(헤더 인코딩이 requirements 전체를 받는다).
    //   accept 하나만 들고 있으면 resource/extensions 가 빠진 402 가 나간다.
    let reqs: X402Requirements;
    let accept: X402Accept;
    try {
      reqs = await this.exactRequirements(resource);
      accept = reqs.accepts[0]!;
    } catch (err) {
      await this.store.release(key);
      throw err;
    }

    const body = {
      x402Version: 2 as const,
      // The payer's envelope, forwarded as-is. Rebuilding it here would drop fields the facilitator
      //   may need (`extensions`, `resource`) and would make this a different payment than they signed.
      paymentPayload: payload,
      paymentRequirements: {
        scheme: 'exact' as const,
        asset: accept.asset,
        // Destination signed by the payer = settlement address committing to the split.
        payTo: accept.payTo,
        // Merchant payout wallet. The facilitator recomputes the settlement address from it and compares with payTo —
        //   CREATE2 is one-way, so it cannot be derived from payTo and must be sent separately.
        //   Uses our configured value (not read from the 402 response, which would defeat the check).
        merchant: this.opts.payTo,
        amount: accept.amount,
        resource,
      },
    };

    // ★ Keep the id. If /settle then fails to answer, this is the ONLY handle on the payment —
    //   without it the merchant cannot poll `GET /v1/x402/payments/:id` and the payment is simply
    //   lost to them even though funds may have moved.
    let paymentId: string;
    try {
      const verified = await this.request<{ valid: boolean; payment_id: string; status: string }>(
        'POST',
        '/v1/x402/verify',
        body,
      );
      paymentId = verified.payment_id;
    } catch (err) {
      await this.store.release(key);
      // 4xx = signature/amount/asset does not match. The payer must re-sign, so return 402.
      if (err instanceof BitPalError && err.statusCode < 500) {
        return this.paymentRequired(resource, err.message, reqs);
      }
      throw err;
    }

    let settled: {
      success: boolean;
      payment_id: string;
      status: string;
      tx_hash: string | null;
      fee_tx_hash?: string | null;
      network: string;
      idempotent?: boolean;
    };
    try {
      settled = await this.request('POST', '/v1/x402/settle', body);
    } catch (err) {
      if (err instanceof BitPalError && err.statusCode < 500) {
        // Rejected on-chain (e.g. reverted) — no funds moved, so a new payment is needed.
        await this.store.release(key);
        return this.paymentRequired(resource, err.message, reqs);
      }
      // Unconfirmed. Returning a new 402 here could make the payer **re-sign and pay twice**.
      //   Release the claim and have them retry with the same header — /settle is idempotent, so that is safe.
      await this.store.release(key);
      return {
        kind: 'unconfirmed',
        status: 503,
        body: {
          error: 'SETTLEMENT_UNCONFIRMED',
          message:
            'Payment settlement is not confirmed yet. Retry this request with the same PAYMENT-SIGNATURE header — settlement is idempotent.',
          // From /verify. /settle never answered, so this is the only id we have — and the only way
          //   the merchant can find out how this payment ended.
          paymentId,
        },
      };
    }

    // HTTP 200 may still be non-confirmed. Returning 402 for every such case would make the payer re-sign
    //   (**double payment**) even when funds may already have moved (submitted/unknown/...). So only statuses
    //   where no funds moved for certain get 402; the rest retry with the same header.
    if (settled.status !== 'confirmed') {
      await this.store.release(key);
      if (RESIGN_REQUIRED_STATUSES.has(settled.status)) {
        return this.paymentRequired(resource, `PAYMENT_${settled.status.toUpperCase()}`, reqs);
      }
      return {
        kind: 'unconfirmed',
        status: 503,
        body: {
          error: 'SETTLEMENT_UNCONFIRMED',
          message: `Payment is still settling (${settled.status}). Retry with the same PAYMENT-SIGNATURE header — do not create a new payment.`,
          paymentId: settled.payment_id,
        },
      };
    }

    const payment: X402SettledPayment = {
      paymentId: settled.payment_id,
      txHash: settled.tx_hash,
      feeTxHash: settled.fee_tx_hash ?? null,
      network: settled.network,
      payer: auth.from,
      amount: accept.amount,
      idempotent: settled.idempotent ?? false,
    };

    return {
      kind: 'settled',
      status: 200,
      payment,
      paymentResponseHeader: encodeBase64Json({
        success: true,
        transaction: settled.tx_hash,
        network: settled.network,
        payer: auth.from,
        paymentId: settled.payment_id,
      }),
      // Consumption is committed **after the response is actually sent**. If the handler throws or the process
      //   dies, the payer paid without receiving the resource; committing early would block the retry with 409.
      commit: () => Promise.resolve(this.store.commit(key)),
      release: () => Promise.resolve(this.store.release(key)),
    };
  }

  /**
   * `upto` variant of `collect()`. The order is inverted on purpose.
   *
   * `exact` settles before the handler runs, because the price is already known. With `upto` the
   * price *is* the thing the handler produces, so the gate can only verify the ceiling here and
   * hand back a `charge()` to call afterwards. Everything else — claim-before-verify, releasing on
   * failure, committing only after delivery — is kept identical, because those rules exist to stop
   * one payment unlocking two responses and that risk does not depend on the scheme.
   */
  private async collectUpto(input: {
    header?: string | null;
    paymentSignature?: string | null;
    resource: string;
  }): Promise<X402GateResult> {
    const { resource } = input;
    // A stock v2 client sends PAYMENT-SIGNATURE. `header` is accepted as a courtesy for callers that
    //   funnel both through one argument; X-PAYMENT is not part of v2.
    const raw = input.paymentSignature ?? input.header;
    if (!raw) return this.paymentRequiredUpto(resource);

    let payload: X402V2PaymentPayload;
    try {
      payload = decodePaymentSignatureHeader(raw);
    } catch {
      return this.paymentRequiredUpto(resource, 'MALFORMED_PAYMENT_SIGNATURE');
    }
    // A gate configured for `upto` must not settle an `exact` authorization, and vice versa.
    if (isExactPayload(payload)) {
      return this.paymentRequiredUpto(resource, 'SCHEME_MISMATCH');
    }
    const auth = (payload.payload as { permit2Authorization: Permit2Authorization }).permit2Authorization;

    // Scoped like Permit2's own uniqueness scope (chain + owner + nonce). The nonce is a 256-bit
    //   value chosen by the signer, so it is compared as the decimal string the wire carries.
    const key = `${normalizeX402Network(payload.accepted.network)}:${auth.from.toLowerCase()}:${auth.nonce}`;
    const claim = await this.store.claim(key, this.maxTimeoutSeconds);
    if (claim === 'used') {
      return {
        kind: 'already_used',
        status: 409,
        body: {
          error: 'PAYMENT_ALREADY_USED',
          message: 'This authorization has already been charged. One authorization unlocks one response.',
        },
      };
    }
    if (claim === 'inflight') {
      return {
        kind: 'unconfirmed',
        status: 503,
        body: {
          error: 'PAYMENT_IN_PROGRESS',
          message: 'This payment is still being processed. Retry with the same PAYMENT-SIGNATURE header.',
        },
      };
    }

    // Rebuilt server-side, never read from the payer's `accepted` — trusting it would let the payer
    //   swap the ceiling or the destination.
    let accept: X402UptoAccept;
    let reqs: X402V2Requirements;
    try {
      reqs = await this.uptoRequirements(resource);
      const first = reqs.accepts[0];
      if (!first || first.scheme !== 'upto') {
        throw new BitPalError('[BitPal] x402: no upto payment option available for this API key mode.', 500);
      }
      accept = first;
    } catch (err) {
      await this.store.release(key);
      throw err;
    }

    const envelope = (amount: string) => ({
      x402Version: 2 as const,
      paymentPayload: payload,
      paymentRequirements: {
        scheme: 'upto' as const,
        asset: accept.asset,
        payTo: accept.payTo,
        // Merchant payout wallet, from our own config — the facilitator recomputes the forwarder
        //   address from it and compares with the signed `witness.to`. Reading it from the 402 we
        //   just fetched would make the check circular.
        merchant: this.opts.payTo,
        amount,
        resource: reqs.resource.url,
      },
    });

    let verified: { valid: boolean; payment_id: string; status: string };
    try {
      // Verified against the **ceiling** — "can this payer cover what they approved?".
      verified = await this.request('POST', '/v1/x402/verify', envelope(accept.amount));
    } catch (err) {
      await this.store.release(key);
      if (err instanceof BitPalError && err.statusCode < 500) {
        return this.paymentRequiredUpto(resource, err.message, reqs);
      }
      throw err;
    }

    return {
      kind: 'authorized',
      status: 200,
      paymentId: verified.payment_id,
      payer: auth.from,
      maxAmount: accept.amount,
      network: accept.network,
      release: () => Promise.resolve(this.store.release(key)),
      charge: async (amount: string, opts?: { atomic?: boolean }): Promise<X402ChargeResult> => {
        const atomic = opts?.atomic === true;
        if (atomic ? !/^\d+$/.test(amount) : !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount)) {
          throw new Error(
            atomic
              ? '[BitPal] x402: charge amountAtomic must be an integer string (USDC 6dp, $1 = "1000000").'
              : '[BitPal] x402: charge amount must be a decimal string like "0.42" (max 6 decimals).',
          );
        }
        // The wire carries atomic units, so a human amount is converted here against the ceiling's
        //   own precision rather than a hardcoded 6 — the ceiling came from the server in atomic form.
        const atomicAmount = atomic ? amount : humanToAtomic(amount);
        if (BigInt(atomicAmount) > BigInt(accept.amount)) {
          throw new Error(
            `[BitPal] x402: charge ${atomicAmount} exceeds the approved ceiling ${accept.amount}.`,
          );
        }

        let settled: {
          payment_id: string;
          status: string;
          tx_hash: string | null;
          fee_tx_hash?: string | null;
          network: string;
          idempotent?: boolean;
        };
        try {
          settled = await this.request('POST', '/v1/x402/settle', envelope(atomicAmount));
        } catch (err) {
          if (err instanceof BitPalError && err.statusCode < 500) {
            // Rejected outright — no funds moved, so this authorization is spent as far as we are
            //   concerned. Release so the payer can sign a new one.
            await this.store.release(key);
            throw err;
          }
          // Unknown outcome. Keep the claim: asking for a new authorization here could double-charge.
          return {
            kind: 'unconfirmed',
            // Same reason as the exact lane: without the id the merchant cannot find out how this ended.
            paymentId: verified.payment_id,
            message:
              'Settlement is not confirmed yet. Retry the same charge — settlement is idempotent.',
          };
        }

        // Charging 0 closes the payment with no on-chain transaction. The payer owes nothing and the
        //   authorization is spent, so the claim is committed just like a confirmed charge.
        if (settled.status === 'voided') {
          await this.store.commit(key);
          return { kind: 'voided', paymentId: settled.payment_id };
        }

        if (settled.status !== 'confirmed') {
          if (RESIGN_REQUIRED_STATUSES.has(settled.status)) {
            await this.store.release(key);
            throw new BitPalError(`[BitPal] x402: settlement ${settled.status}.`, 402);
          }
          return {
            kind: 'unconfirmed',
            paymentId: settled.payment_id,
            message: `Payment is still settling (${settled.status}). Retry the same charge.`,
          };
        }

        await this.store.commit(key);
        return {
          kind: 'charged',
          payment: {
            paymentId: settled.payment_id,
            txHash: settled.tx_hash,
            feeTxHash: settled.fee_tx_hash ?? null,
            network: settled.network,
            payer: auth.from,
            amount: atomicAmount,
            idempotent: settled.idempotent ?? false,
          },
          paymentResponseHeader: encodePaymentResponseHeaderV2({
            success: true,
            transaction: settled.tx_hash,
            network: settled.network,
            payer: auth.from,
            paymentId: settled.payment_id,
          }),
        };
      },
    };
  }

  /**
   * v2 402. The requirements go in the `PAYMENT-REQUIRED` header, not the body — a stock v2 client
   * reads the body only when `x402Version === 1`, so a body-only 402 is invisible to it.
   */
  private async paymentRequiredUpto(
    resource: string,
    error?: string,
    known?: X402V2Requirements,
  ): Promise<X402GateResult> {
    const reqs = known ?? (await this.uptoRequirements(resource));
    const withError = error ? { ...reqs, error } : reqs;
    return {
      kind: 'payment_required',
      status: 402,
      // Kept for humans and for logs; machines read the header.
      body: { error: error ?? 'PAYMENT_REQUIRED' },
      headers: {
        [X402_PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(withError),
        'Cache-Control': X402_PAYMENT_REQUIRED_CACHE_CONTROL,
      },
    };
  }

  private async uptoRequirements(resource: string): Promise<X402V2Requirements> {
    const reqs = (await this.requirements(resource)) as X402V2Requirements;
    if (reqs.x402Version !== 2 || !reqs.resource?.url) {
      throw new BitPalError('[BitPal] x402: server did not return a v2 (upto) 402 body.', 500);
    }
    return reqs;
  }

  /* ─── Internal ─── */

  /** `exact` requirements. `upto` goes through `uptoRequirements()` — the accept shape differs. */
  private async exactRequirements(resource: string): Promise<X402Requirements> {
    const reqs = (await this.requirements(resource)) as X402Requirements;
    if (reqs.x402Version !== 2 || !reqs.resource?.url) {
      throw new BitPalError('[BitPal] x402: server did not return a v2 402 body.', 500);
    }
    const accept = reqs.accepts[0];
    if (!accept || accept.scheme !== 'exact') {
      throw new BitPalError('[BitPal] x402: no exact payment option available for this API key mode.', 500);
    }
    return reqs;
  }

  /**
   * The 402. **The requirements go in the `PAYMENT-REQUIRED` header, not the body** — a stock v2
   * client reads the body only for `x402Version === 1`, which we no longer serve. Putting them in
   * the body means a stock agent sees a 402 it cannot act on.
   */
  private async paymentRequired(
    resource: string,
    error?: string,
    known?: X402Requirements,
  ): Promise<X402GateResult> {
    const reqs = known ?? (await this.exactRequirements(resource));
    const withError = error ? { ...reqs, error } : reqs;
    return {
      kind: 'payment_required',
      status: 402,
      // Kept for humans and for logs; machines read the header.
      body: { error: error ?? 'PAYMENT_REQUIRED' },
      headers: {
        [X402_PAYMENT_REQUIRED_HEADER]: encodePaymentRequiredHeader(withError),
        'Cache-Control': X402_PAYMENT_REQUIRED_CACHE_CONTROL,
      },
    };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      const res = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.opts.apiKey}`,
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      // A proxy/gateway error (an HTML 502) is not JSON. `res.json()` would throw a SyntaxError that the
      //   catch below flattens to 599, losing the real status — read the text and parse defensively.
      const text = await res.text();
      let json: (ApiResponse<T> & { error?: unknown }) | null = null;
      try {
        json = text ? (JSON.parse(text) as ApiResponse<T> & { error?: unknown }) : null;
      } catch {
        // A success status with an unreadable body means the outcome is **unknown**. Reporting it as <500
        //   would tell settle "this definitely did not happen" while the money may already have moved.
        throw new BitPalError(`Invalid JSON response (HTTP ${res.status})`, res.ok ? 599 : res.status);
      }
      if (!res.ok) {
        // Carry the API's `code` / `trace_id` / `retryable` through. `BitPalCheckoutClient` already does
        //   this (client.ts); without it the caller gets a bare string and cannot tell *why* it was
        //   rejected — an expired key and a disabled chain both arrive as an opaque failure.
        throw new BitPalError(String(json?.error ?? `HTTP ${res.status}`), res.status, parseApiErrorBody(json));
      }
      return json?.data as T;
    } catch (err) {
      // Timeouts/network errors are treated as 5xx — for settle this routes to the "unconfirmed" path.
      if (err instanceof BitPalError) throw err;
      throw new BitPalError(err instanceof Error ? err.message : String(err), 599);
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Human decimal → atomic units.
 *
 * x402 assets are 6-decimal stablecoins today (USDC/USDT). This stays in the SDK rather than asking
 * the server because `charge()` has to compare against the ceiling before spending a round trip, and
 * the comparison must be exact — string math only, never floating point.
 */
function humanToAtomic(amount: string, decimals = 6): string {
  const [whole, frac = ''] = amount.split('.');
  return `${BigInt(whole || '0') * 10n ** BigInt(decimals) + BigInt((frac + '0'.repeat(decimals)).slice(0, decimals) || '0')}`;
}

/* ─── Express adapter ─── */

/** Structural type with only the Express request fields this middleware reads. */
export interface X402Request {
  headers: Record<string, string | string[] | undefined>;
  protocol?: string;
  baseUrl?: string;
  path?: string;
  url?: string;
  originalUrl?: string;
  get?(name: string): string | undefined;
  /** Settlement details are attached here for use in the handler. */
  x402Payment?: X402SettledPayment;
}

/** Structural type with only the Express response methods this middleware uses. */
export interface X402Response {
  status(code: number): X402Response;
  json(body: unknown): unknown;
  setHeader(name: string, value: string): unknown;
  /** Used to detect that the response was actually sent before consuming the payment. If absent, the payment is consumed immediately. */
  once?(event: string, listener: () => void): unknown;
  statusCode?: number;
  writableEnded?: boolean;
}

export interface X402MiddlewareOptions extends X402GateOptions {
  /**
   * Resource URL this payment is bound to. Defaults to the request's absolute URL (without query).
   * Payments are bound to this value, so the 402 and the retry must produce the same value.
   */
  resource?: string | ((req: X402Request) => string);
  /** Called right after settlement is confirmed (before the handler runs) — for logging/usage metering. */
  onSettled?: (payment: X402SettledPayment, req: X402Request) => void | Promise<void>;
}

/**
 * Wraps an Express route with per-call billing.
 *
 * @example
 * ```ts
 * import { x402 } from '@bitpal/checkout';
 *
 * // $1.00 USDC per call
 * app.get('/report', x402({
 *   apiKey: process.env.BITPAL_API_KEY!,
 *   payTo: '0xYourPayoutWallet',
 *   network: 'base',
 *   amount: '1', // human-readable; or amountAtomic: '1000000'
 * }), (req, res) => {
 *   res.json({ report: '…' });
 * });
 * ```
 */
export function x402(options: X402MiddlewareOptions) {
  if (options.scheme === 'upto') {
    // A transparent middleware cannot know what to charge — that is the handler's output. Use
    //   `new X402Gate({ scheme: 'upto' })` directly and call `charge()` once the work is done.
    throw new Error(
      "[BitPal] x402: the Express middleware supports scheme 'exact' only. " +
        "For 'upto', use X402Gate directly: verify with collect(), then call charge(amount) after the handler runs.",
    );
  }
  const gate = new X402Gate(options);

  return async function x402Middleware(
    req: X402Request,
    res: X402Response,
    next: (err?: unknown) => void,
  ): Promise<void> {
    try {
      const result = await gate.collect({
        paymentSignature: readHeader(req, X402_PAYMENT_SIGNATURE_HEADER),
        resource: resolveResource(req, options.resource),
      });

      // Unreachable: the constructor rejects scheme 'upto', and only 'upto' produces 'authorized'.
      //   Asserted rather than assumed, so a future scheme cannot silently fall through to `body`.
      if (result.kind === 'authorized') {
        await result.release();
        throw new Error("[BitPal] x402: 'authorized' is not reachable from the Express middleware.");
      }

      if (result.kind !== 'settled') {
        // 402 for a v2 scheme carries its requirements in headers; dropping them makes the 402
        //   invisible to stock clients. Harmless for v1, which sets none.
        if (result.kind === 'payment_required' && result.headers) {
          for (const [name, value] of Object.entries(result.headers)) res.setHeader(name, value);
        }
        res.status(result.status).json(result.body);
        return;
      }

      res.setHeader(X402_PAYMENT_RESPONSE_HEADER_V2, result.paymentResponseHeader);
      req.x402Payment = result.payment;

      // Payment consumption is committed **after the response is actually sent**. If the handler throws or ends
      //   with 5xx, the payer did not receive the resource, so the claim is released for a retry with the same header
      //   (/settle is idempotent, so funds still move only once).
      if (typeof res.once === 'function') {
        let finalized = false;
        const finalize = (delivered: boolean): void => {
          if (finalized) return;
          finalized = true;
          const done = delivered ? result.commit() : result.release();
          void done.catch(() => undefined);
        };
        res.once('finish', () => finalize((res.statusCode ?? 200) < 500));
        res.once('close', () => finalize(res.writableEnded === true && (res.statusCode ?? 200) < 500));
      } else {
        // Runtime without `once` — delivery cannot be detected, so consume the payment (safer than double delivery).
        await result.commit();
      }

      if (options.onSettled) await options.onSettled(result.payment, req);
      next();
    } catch (err) {
      next(err);
    }
  };
}

/* ─── Helpers ─── */

function readHeader(req: X402Request, name: string): string | undefined {
  const direct = req.headers?.[name] ?? req.headers?.[name.toUpperCase()];
  const value = Array.isArray(direct) ? direct[0] : direct;
  if (value) return value;
  return req.get?.(name);
}

function resolveResource(req: X402Request, override: X402MiddlewareOptions['resource']): string {
  if (typeof override === 'function') return override(req);
  if (override) return override;

  const host = req.get?.('host') ?? readHeader(req, 'host') ?? 'localhost';
  const protocol = req.protocol ?? 'https';
  // Express splits the mount path (baseUrl) and route path (path). Fall back to the raw URL if neither is present.
  const raw = req.path != null ? `${req.baseUrl ?? ''}${req.path}` : (req.originalUrl ?? req.url ?? '/');
  // Strip the query — if the same endpoint split into different resources per query, the 402 and retry would mismatch.
  const path = raw.split('?')[0] || '/';
  return `${protocol}://${host}${path}`;
}


const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX32_RE = /^0x[a-fA-F0-9]{64}$/;
const DECIMAL_RE = /^\d{1,78}$/;


/** 65-byte packed signature — the standard x402 form. */
const PACKED_SIG_RE = /^0x[0-9a-fA-F]{130}$/;

function assertAuthorization(value: unknown, label: string): Eip3009Authorization {
  const a = asObject(value, label);
  const check = (ok: boolean, field: string): void => {
    if (!ok) throw new Error(`[BitPal] x402: invalid ${label}.${field}.`);
  };
  check(typeof a.from === 'string' && ADDRESS_RE.test(a.from), 'from');
  check(typeof a.to === 'string' && ADDRESS_RE.test(a.to), 'to');
  check(typeof a.value === 'string' && DECIMAL_RE.test(a.value), 'value');
  check(typeof a.validAfter === 'string' && DECIMAL_RE.test(a.validAfter), 'validAfter');
  check(typeof a.validBefore === 'string' && DECIMAL_RE.test(a.validBefore), 'validBefore');
  check(typeof a.nonce === 'string' && HEX32_RE.test(a.nonce), 'nonce');
  // Copy only validated fields — passing the original object would forward arbitrary keys to the API body.
  return {
    from: a.from as string,
    to: a.to as string,
    value: a.value as string,
    validAfter: a.validAfter as string,
    validBefore: a.validBefore as string,
    nonce: a.nonce as string,
  };
}

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`[BitPal] x402: ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}


function encodeBase64Json(value: unknown): string {
  const json = JSON.stringify(value);
  const g = globalThis as { btoa?: (s: string) => string };
  if (typeof g.btoa === 'function') {
    // btoa only accepts latin1 — expand UTF-8 into bytes first.
    const bytes = new TextEncoder().encode(json);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return g.btoa(binary);
  }
  return bufferFrom(json, 'utf8').toString('base64');
}

function decodeBase64(value: string): string {
  const g = globalThis as { atob?: (s: string) => string };
  if (typeof g.atob === 'function') {
    const binary = g.atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return new TextDecoder().decode(bytes);
  }
  return bufferFrom(value, 'base64').toString('utf8');
}

/** Node-only fallback — narrowly typed to avoid pulling the Buffer type into browser bundles. */
function bufferFrom(value: string, encoding: string): { toString(enc: string): string } {
  const g = globalThis as { Buffer?: { from(v: string, e: string): { toString(enc: string): string } } };
  if (!g.Buffer) throw new Error('[BitPal] x402: no base64 implementation available in this runtime.');
  return g.Buffer.from(value, encoding);
}

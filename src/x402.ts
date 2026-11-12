/**
 * x402 — merchant middleware that charges per route call.
 *
 * Merchant code only declares "this route costs $1". Building the 402, parsing `X-PAYMENT`, the
 * verify → settle sequence, error mapping and replay protection all live here. BitPal computes the
 * fee and includes it in the 402, so the merchant passes **only the gross amount it wants to receive**
 * (same UX as checkout `line_items[].amount`).
 *
 * Two things are handled with particular care:
 *
 *  1. **"One payment = one response" is the middleware's job.** BitPal `/settle` idempotency only
 *     guarantees that funds move once for a given nonce. Sending the same `X-PAYMENT` 100 times yields
 *     100 success responses, so relying on that alone would let one payment unlock unlimited calls.
 *     Authorizations that have already been served are recorded locally to block reuse (`X402ReplayStore`).
 *
 *  2. **HTTP 200 does not mean settlement succeeded.** Settling an already-finalized payment returns
 *     its existing result — even `reverted` comes back as 200. The resource is served only when
 *     `status === 'confirmed'`.
 */

import { BitPalError } from './client.js';
import type { ApiResponse } from './types.js';

/* ─── Constants ─── */

/** payer → resource server. base64(JSON) payment payload. */
export const X402_PAYMENT_HEADER = 'x-payment';
/** resource server → payer. base64(JSON) settlement result (includes txHash). */
export const X402_PAYMENT_RESPONSE_HEADER = 'X-PAYMENT-RESPONSE';

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
/** Max X-PAYMENT header size. A normal payload is well under 1KB. */
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
  network: string;
  asset: string;
  payTo: string;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  maxTimeoutSeconds: number;
  /** Values the payer can use to build the EIP-712 domain as-is. */
  extra: { name: string; version: string; chainId: number };
  /** BitPal extension — the fee split fixed by the server. */
  feeBreakdown: X402FeeBreakdown;
}

export interface X402Requirements {
  x402Version: 1;
  accepts: X402Accept[];
}

/* ─── X-PAYMENT payload ─── */

/** Signed fields of EIP-3009 `TransferWithAuthorization`. Standard x402 `payload.authorization`. */
export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

/**
 * The standard x402 payload — a single authorization plus a 65-byte packed signature.
 *
 * Up to 0.10.0 this was a `{ merchant, fee }` pair, which required the payer to sign twice and
 * prevented stock x402 clients from paying BitPal merchants. The split is now committed by the
 * `payTo` (forwarder) address, so a single signature is enough.
 */
export interface X402PaymentPayload {
  x402Version: 1;
  scheme: 'exact';
  /** x402 wire name — 'base' / 'base-sepolia'. */
  network: string;
  payload: {
    /** 65-byte packed hex (`0x` + r + s + v). */
    signature: string;
    authorization: Eip3009Authorization;
  };
}

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

export type X402GateResult =
  /** No payment or an invalid one — respond with 402 and the payment requirements. */
  | { kind: 'payment_required'; status: 402; body: X402Requirements & { error?: string } }
  /** This authorization has already been used to serve the resource — reuse rejected. */
  | { kind: 'already_used'; status: 409; body: { error: string; message: string } }
  /** Not yet certain whether funds moved — retry with the **same** `X-PAYMENT` (do not re-sign). */
  | { kind: 'unconfirmed'; status: 503; body: { error: string; message: string; paymentId?: string } }
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
    };

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
  }

  /** Fetches this resource's 402 body from the server (including the fee split). */
  async requirements(resource: string): Promise<X402Requirements> {
    return this.request<X402Requirements>('POST', '/v1/x402/requirements', {
      payTo: this.opts.payTo,
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
   * Processes one `X-PAYMENT` header. Returns 402 if missing or malformed, `settled` once settlement completes.
   *
   * Order matters: **claim → verify → settle → record consumption**. Claiming before verify ensures that
   * concurrent submissions of the same authorization result in only one request being served.
   */
  async collect(input: { header?: string | null; resource: string }): Promise<X402GateResult> {
    const { header, resource } = input;
    if (!header) return this.paymentRequired(resource);

    let payload: X402PaymentPayload;
    try {
      payload = decodePaymentHeader(header);
    } catch {
      return this.paymentRequired(resource, 'MALFORMED_PAYMENT_HEADER');
    }

    const auth = payload?.payload?.authorization;
    if (!auth?.from || !auth?.nonce) {
      return this.paymentRequired(resource, 'MALFORMED_PAYMENT_HEADER');
    }

    // The key scope matches EIP-3009's on-chain uniqueness scope (network + from + nonce). The network is
    //   normalized like the API does, since the signature does not cover it ('Base' and 'base' must collide).
    const key = `${normalizeX402Network(payload.network)}:${auth.from.toLowerCase()}:${auth.nonce.toLowerCase()}`;
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
          message: 'This payment is still being settled. Retry with the same X-PAYMENT header.',
        },
      };
    }

    // Rebuild the payment requirements ourselves — trusting payer-supplied values would allow swapping amount/recipient.
    let accept: X402Accept;
    try {
      accept = await this.firstAccept(resource);
    } catch (err) {
      await this.store.release(key);
      throw err;
    }

    const body = {
      x402Version: 1 as const,
      paymentPayload: {
        scheme: 'exact' as const,
        network: payload.network,
        payload: payload.payload,
      },
      paymentRequirements: {
        asset: accept.asset,
        // Destination signed by the payer = settlement address committing to the split.
        payTo: accept.payTo,
        // Merchant payout wallet. The facilitator recomputes the settlement address from it and compares with payTo —
        //   CREATE2 is one-way, so it cannot be derived from payTo and must be sent separately.
        //   Uses our configured value (not read from the 402 response, which would defeat the check).
        merchant: this.opts.payTo,
        maxAmountRequired: accept.maxAmountRequired,
        resource: accept.resource,
      },
    };

    try {
      await this.request<{ valid: boolean; payment_id: string; status: string }>('POST', '/v1/x402/verify', body);
    } catch (err) {
      await this.store.release(key);
      // 4xx = signature/amount/asset does not match. The payer must re-sign, so return 402.
      if (err instanceof BitPalError && err.statusCode < 500) {
        return this.paymentRequired(resource, err.message, accept);
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
        return this.paymentRequired(resource, err.message, accept);
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
            'Payment settlement is not confirmed yet. Retry this request with the same X-PAYMENT header — settlement is idempotent.',
        },
      };
    }

    // HTTP 200 may still be non-confirmed. Returning 402 for every such case would make the payer re-sign
    //   (**double payment**) even when funds may already have moved (submitted/unknown/...). So only statuses
    //   where no funds moved for certain get 402; the rest retry with the same header.
    if (settled.status !== 'confirmed') {
      await this.store.release(key);
      if (RESIGN_REQUIRED_STATUSES.has(settled.status)) {
        return this.paymentRequired(resource, `PAYMENT_${settled.status.toUpperCase()}`, accept);
      }
      return {
        kind: 'unconfirmed',
        status: 503,
        body: {
          error: 'SETTLEMENT_UNCONFIRMED',
          message: `Payment is still settling (${settled.status}). Retry with the same X-PAYMENT header — do not create a new payment.`,
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
      amount: accept.maxAmountRequired,
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

  /* ─── Internal ─── */

  private async firstAccept(resource: string): Promise<X402Accept> {
    const requirements = await this.requirements(resource);
    const accept = requirements.accepts[0];
    if (!accept) {
      throw new BitPalError('[BitPal] x402: no payment option available for this API key mode.', 500);
    }
    return accept;
  }

  private async paymentRequired(
    resource: string,
    error?: string,
    known?: X402Accept,
  ): Promise<X402GateResult> {
    const requirements = known
      ? { x402Version: 1 as const, accepts: [known] }
      : await this.requirements(resource);
    return {
      kind: 'payment_required',
      status: 402,
      body: error ? { ...requirements, error } : requirements,
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
      const json = (await res.json()) as ApiResponse<T> & { error?: unknown };
      if (!res.ok) {
        throw new BitPalError(String(json.error ?? `HTTP ${res.status}`), res.status);
      }
      return json.data as T;
    } catch (err) {
      // Timeouts/network errors are treated as 5xx — for settle this routes to the "unconfirmed" path.
      if (err instanceof BitPalError) throw err;
      throw new BitPalError(err instanceof Error ? err.message : String(err), 599);
    } finally {
      clearTimeout(timer);
    }
  }
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
  const gate = new X402Gate(options);

  return async function x402Middleware(
    req: X402Request,
    res: X402Response,
    next: (err?: unknown) => void,
  ): Promise<void> {
    try {
      const result = await gate.collect({
        header: readHeader(req, X402_PAYMENT_HEADER),
        resource: resolveResource(req, options.resource),
      });

      if (result.kind !== 'settled') {
        res.status(result.status).json(result.body);
        return;
      }

      res.setHeader(X402_PAYMENT_RESPONSE_HEADER, result.paymentResponseHeader);
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

/**
 * base64(JSON) is the standard, but plain JSON is also accepted.
 *
 * This parses untrusted input before authentication, so size limits and shape validation are enforced here —
 * only values that pass go into the replay key and BitPal API body. (The payload is never merged anywhere, so
 * there is no direct prototype-pollution path, but keys like `__proto__` are not passed through either.)
 */
export function decodePaymentHeader(header: string): X402PaymentPayload {
  if (header.length > MAX_PAYMENT_HEADER_BYTES) {
    throw new Error('[BitPal] x402: X-PAYMENT header too large.');
  }
  const trimmed = header.trim();
  const json = trimmed.startsWith('{') ? trimmed : decodeBase64(trimmed);
  const parsed: unknown = JSON.parse(json);
  return assertPaymentPayload(parsed);
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const HEX32_RE = /^0x[a-fA-F0-9]{64}$/;
const DECIMAL_RE = /^\d{1,78}$/;

function assertPaymentPayload(value: unknown): X402PaymentPayload {
  const root = asObject(value, 'payment payload');
  if (root.x402Version !== 1) throw new Error('[BitPal] x402: unsupported x402Version.');
  if (root.scheme !== 'exact') throw new Error('[BitPal] x402: unsupported scheme.');
  if (typeof root.network !== 'string' || root.network.length === 0 || root.network.length > 64) {
    throw new Error('[BitPal] x402: invalid network.');
  }
  const inner = asObject(root.payload, 'payload');
  if (typeof inner.signature !== 'string' || !PACKED_SIG_RE.test(inner.signature)) {
    throw new Error('[BitPal] x402: invalid payload.signature (expected 65-byte packed hex).');
  }
  return {
    x402Version: 1,
    scheme: 'exact',
    network: root.network,
    payload: {
      signature: inner.signature,
      authorization: assertAuthorization(inner.authorization, 'authorization'),
    },
  };
}

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

/** Encodes a payload built by the payer helper as the `X-PAYMENT` header value. */
export function encodePaymentHeader(payload: X402PaymentPayload): string {
  return encodeBase64Json(payload);
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

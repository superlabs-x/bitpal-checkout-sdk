/**
 * @bitpal/checkout SDK — client
 *
 * Covers: session create/retrieve, payment link create/retrieve, fee preview.
 * Credit balance/top-up is not part of BitPal's non-custodial model.
 */

import type {
  BitPalConfig,
  CreateSessionParams,
  CheckoutLineItemInput,
  CheckoutSession,
  PublicSession,
  SessionStatus,
  IssueDepositAddressParams,
  DepositAddress,
  FeePreview,
  ApiResponse,
  ListResponse,
  IdempotencyOptions,
} from './types.js';
import { ProductsResource, PricesResource, PaymentLinksResource } from './catalog.js';

/**
 * Idempotency key -> `Idempotency-Key` header. For every merchant POST the API returns the first response to retries
 * with the same key, and returns 422 if the same key is reused with a different method/path/body. No key, no header.
 */
function idempotencyHeaders(options?: IdempotencyOptions): Record<string, string> | undefined {
  const key = options?.idempotencyKey;
  if (key === undefined) return undefined;
  if (key.trim().length === 0) throw new Error('[BitPal] idempotencyKey must be a non-empty string.');
  return { 'Idempotency-Key': key };
}

/**
 * Line item one-of validation — the amount is either `amount` (human-readable canonical 6dp) or `amount_atomic`
 * (raw canonical 6dp), not both. `currency` ('USDC'/'USDT'/'JPYC') determines the actual payment currency and the
 * amount is denominated in it (not fixed to USD). The server does the conversion, so the SDK passes values through
 * unchanged (rescaling to the actual token decimals happens at issuance). price_id items are resolved by the server.
 * Specifying both or neither throws immediately.
 */
/** Allowed payment window (minutes) — same range as the API's expires_in_minutes. */
const EXPIRY_MIN_MINUTES = 1;
const EXPIRY_MAX_MINUTES = 60;

/**
 * expires_in_minutes / (deprecated) expires_in_seconds -> the API's expires_in_minutes.
 * The server does not accept expires_in_seconds (it was silently ignored), so the SDK converts it to minutes.
 */
function resolveExpiryMinutes(minutes: number | undefined, seconds: number | undefined): number | undefined {
  if (minutes !== undefined && seconds !== undefined) {
    throw new Error("[BitPal] pass only one of `expires_in_minutes` or `expires_in_seconds`.");
  }
  // Range-check seconds before rounding up, so 1 second is not rounded up to 1 minute and accepted (documented: 60–3600 s).
  if (seconds !== undefined && (!Number.isFinite(seconds) || seconds < EXPIRY_MIN_MINUTES * 60 || seconds > EXPIRY_MAX_MINUTES * 60)) {
    throw new Error(`[BitPal] session expiry must be ${EXPIRY_MIN_MINUTES}–${EXPIRY_MAX_MINUTES} minutes (expires_in_minutes) — got ${seconds}s.`);
  }
  const resolved = seconds !== undefined ? Math.ceil(seconds / 60) : minutes;
  if (resolved === undefined) return undefined;
  if (!Number.isInteger(resolved) || resolved < EXPIRY_MIN_MINUTES || resolved > EXPIRY_MAX_MINUTES) {
    throw new Error(`[BitPal] session expiry must be ${EXPIRY_MIN_MINUTES}–${EXPIRY_MAX_MINUTES} minutes (expires_in_minutes) — got ${seconds !== undefined ? seconds + "s" : minutes}.`);
  }
  return resolved;
}

function validateLineItem(li: CheckoutLineItemInput): CheckoutLineItemInput {
  if ('price_id' in li) return li;
  const hasHuman = li.amount != null;
  const hasAtomic = li.amount_atomic != null;
  if (hasHuman === hasAtomic) {
    throw new Error('[BitPal] line item requires exactly one of `amount` (canonical decimal number, e.g. "29") or `amount_atomic` (raw canonical 6dp integer, e.g. "29000000").');
  }
  return li;
}

const DEFAULT_BASE_URL = 'https://api.bitpal.io';
const DEFAULT_TIMEOUT = 30_000;

export class BitPalCheckoutClient {
  /** Secret key for server methods. Public (buyer-facing) methods work without it. */
  private readonly apiKey: string | undefined;
  private readonly baseUrl: string;
  private readonly timeout: number;

  /** Product catalog management (server-side only) */
  readonly products: ProductsResource;
  /** Immutable Price management — to change a price, create a new one */
  readonly prices: PricesResource;
  /** Payment Link management — create payment links in code without the dashboard (server-side only) */
  readonly paymentLinks: PaymentLinksResource;

  constructor(config: BitPalConfig) {
    // apiKey is optional — server methods need it (the server returns 401 otherwise); public methods work without it.
    this.apiKey = config.apiKey;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, '');
    this.timeout = config.timeout ?? DEFAULT_TIMEOUT;

    const requester = <T>(method: string, path: string, body?: unknown, options?: IdempotencyOptions): Promise<T> =>
      this.request<T>(method, path, body, idempotencyHeaders(options));
    this.products = new ProductsResource(requester);
    this.prices = new PricesResource(requester);
    this.paymentLinks = new PaymentLinksResource(requester);
  }

  /* ─── Internal HTTP ─── */


  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);

    try {
      const res = await fetch(url, {
        method,
        headers: {
          'Content-Type': 'application/json',
          // Public methods (session_token based) work without an apiKey — attach Authorization only when present.
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
          ...(extraHeaders ?? {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      // Proxy/gateway errors (e.g. HTML 502) are not JSON — don't let the parse failure surface as a SyntaxError.
      const text = await res.text();
      let json: unknown = null;
      try {
        json = text ? JSON.parse(text) : null;
      } catch {
        if (!res.ok) throw new BitPalError(`HTTP ${res.status}`, res.status);
        throw new BitPalError(`Invalid JSON response (HTTP ${res.status})`, res.status);
      }

      if (!res.ok) {
        const err = json && typeof json === 'object' ? (json as Record<string, unknown>).error : undefined;
        const msg = typeof err === 'string' && err.length > 0 ? err : `HTTP ${res.status}`;
        throw new BitPalError(msg, res.status, parseApiErrorBody(json));
      }

      return json as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /* ─── Sessions ─── */

  /**
   * Create a checkout session.
   *
   * `line_items[].amount` is a human-readable canonical 6dp string ("29", "0.5") — no decimals math needed.
   * `currency` ('USDC'/'USDT'/'JPYC') determines the actual payment currency, and amount is always denominated in it
   * (not fixed to USD — currency='JPYC' + amount='1500' -> 1500 JPYC, no FX conversion).
   * If you already have a raw canonical 6dp integer, use `amount_atomic` ("29000000"). The two are mutually exclusive.
   *
   * @example
   * import { BitPal } from '@bitpal/checkout';
   * const bp = new BitPal('bp_test_...');
   * const { data } = await bp.checkout.createSession({
   *   // amount: human-readable canonical 6dp ("29", "0.5"). The server rescales to the chain/token decimals.
   *   line_items: [{ name: 'Pro', amount: '29', currency: 'USDC' }],
   * });
   * console.log(data.url); // -> payment page to redirect the buyer to
   *
   * // Allow multiple chains — the buyer picks Base or Optimism (auto-selected if only one):
   * //   the amount is the same for any chain/token; the server rescales to token decimals.
   * await bp.checkout.createSession({
   *   line_items: [{ name: 'Pro', amount: '29', currency: 'USDC' }],
   *   allowed_pay_chains: ['eip155:84532', 'eip155:11155420'],
   * });
   * // To pin a single chain, use pay_chain (mutually exclusive with allowed_pay_chains).
   */
  async createSession(params: CreateSessionParams, options?: IdempotencyOptions): Promise<ApiResponse<CheckoutSession>> {
    // pay_chain (single, pinned) and allowed_pay_chains (multiple allowed) are mutually exclusive. The server
    // rejects this too, but the SDK checks up front for immediate feedback.
    if (params.pay_chain && params.allowed_pay_chains && params.allowed_pay_chains.length > 0) {
      throw new Error('[BitPal] pay_chain and allowed_pay_chains are mutually exclusive — use only one.');
    }
    // One-of validation only — the server converts amount / amount_atomic.
    //   allowed_assets maps the SDK's {chain, token} to the createSession API field name (caip2).
    //   chain values (short name or CAIP-2) are normalized by the server relative to the mode.
    // payer_wallet / pay_asset are deprecated — they are not in the API schema and were silently dropped,
    //   so they are not sent.
    const { expires_in_seconds, payer_wallet: _payerWallet, pay_asset: _payAsset, ...rest } = params;
    const expiresInMinutes = resolveExpiryMinutes(params.expires_in_minutes, expires_in_seconds);
    const body = {
      ...rest,
      ...(expiresInMinutes !== undefined ? { expires_in_minutes: expiresInMinutes } : {}),
      line_items: params.line_items.map(validateLineItem),
      ...(params.allowed_assets
        ? { allowed_assets: params.allowed_assets.map((a) => ({ caip2: a.chain, token: a.token })) }
        : {}),
    };
    const res = await this.request<ApiResponse<CheckoutSession>>(
      'POST',
      '/v1/checkout/sessions',
      body,
      idempotencyHeaders(options),
    );
    // The backend returns the exact URL, including the token query, as `checkout_url`.
    // The SDK mirrors it as `url` too (backwards compat). It does not build the URL itself because:
    //   - without the token query the payment page fails closed
    //   - when the API and web hosts differ, deriving the host may be wrong
    if (res.data) {
      if (res.data.checkout_url) {
        res.data.url = res.data.checkout_url;
      } else if (!res.data.url) {
        // Last-resort fallback — only when the backend returns neither.
        res.data.url = `${this.baseUrl.replace('api.', '')}/pay/${res.data.id}`;
      }
    }
    return res;
  }

  /** Retrieve a session */
  async getSession(sessionId: string): Promise<ApiResponse<CheckoutSession>> {
    return this.request<ApiResponse<CheckoutSession>>(
      'GET',
      `/v1/checkout/sessions/${sessionId}`,
    );
  }

  /** List sessions */
  async listSessions(params?: { status?: string; limit?: number; offset?: number }): Promise<ListResponse<CheckoutSession>> {
    const qs = new URLSearchParams();
    if (params?.status) qs.set('status', params.status);
    if (params?.limit) qs.set('limit', String(params.limit));
    if (params?.offset) qs.set('offset', String(params.offset));
    const query = qs.toString();
    return this.request<ListResponse<CheckoutSession>>(
      'GET',
      `/v1/checkout/sessions${query ? `?${query}` : ''}`,
    );
  }

  /* ─── Non-custodial payments (deposit address) ─── */

  /**
   * Retrieve a public session (`GET /v1/checkout/sessions/:id/public`) — no auth required.
   *
   * Server-authoritative view used by buyer-facing payment pages for display and asset selection. `payment_options`
   * lists the chain×token pairs the buyer can choose; `deposit_address` is filled in once issued.
   */
  async getPublicSession(sessionId: string): Promise<ApiResponse<PublicSession>> {
    return this.request<ApiResponse<PublicSession>>(
      'GET',
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/public`,
    );
  }

  /**
   * Issue a per-order non-custodial deposit address (`POST /v1/checkout/sessions/:id/deposit-address`).
   *
   * Payment entry point. Once the buyer confirms the asset (chain/token, for multi-option sessions) and a refund
   * address, the server returns a CREATE2 forwarder address dedicated to that order. The buyer sends the **exact amount**
   * to it from any wallet or exchange (no signing or wallet connection needed). The deposit is then detected and settled.
   *
   * refundAddress is committed into the deposit address and cannot be changed after issuance. session_token comes from the createSession response.
   *
   * @example
   * ```ts
   * const { data } = await bitpal.checkout.issueDepositAddress(sessionId, {
   *   session_token: session.session_token!,
   *   refundAddress: '0xBuyerWallet...',
   *   chain: 'eip155:8453', // only needed for multi-option sessions
   *   token: 'USDC',
   * });
   * console.log(data.depositAddress, data.expectedAmount); // send exactly this amount to this address
   * ```
   */
  async issueDepositAddress(
    sessionId: string,
    params: IssueDepositAddressParams,
  ): Promise<ApiResponse<DepositAddress>> {
    return this.request<ApiResponse<DepositAddress>>(
      'POST',
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/deposit-address`,
      params,
    );
  }

  /**
   * Lightweight status check (`GET /v1/checkout/sessions/:id/status`) — requires an API key; own sessions only.
   *
   * status: awaiting_deposit -> deposit_detected -> paid_confirmed/swept. Confirmation and settlement are also sent
   * via webhook, so rely on the webhook for server-side confirmation (polling is for buyer UX).
   */
  async getStatus(sessionId: string): Promise<ApiResponse<SessionStatus>> {
    return this.request<ApiResponse<SessionStatus>>(
      'GET',
      `/v1/checkout/sessions/${encodeURIComponent(sessionId)}/status`,
    );
  }

  /* ─── Fees ─── */

  /**
   * Fee preview — `/v1/checkout/fee-preview`.
   *
   * `amount` is **human-readable** ("100", "0.5") — the same model as line items / Prices / x402, so
   * no decimals math is needed. To pass raw μUSD, use `amountAtomic` (mutually exclusive).
   * The response stays atomic (it is a computed result, so precision is part of the contract).
   *
   * @example
   * const { data } = await bp.checkout.previewFee('100');       // $100
   * const { data } = await bp.checkout.previewFee({ amountAtomic: '100000000' });
   */
  async previewFee(amount: string | { amountAtomic: string }): Promise<ApiResponse<FeePreview>> {
    const qs =
      typeof amount === 'string'
        ? `amount=${encodeURIComponent(amount)}`
        : `amount_atomic=${encodeURIComponent(amount.amountAtomic)}`;
    if (typeof amount === 'string' && !/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(amount)) {
      throw new Error('[BitPal] previewFee: amount must be a decimal string like "100" or "0.5" (max 6 decimals). For raw μUSD use { amountAtomic }.');
    }
    return this.request<ApiResponse<FeePreview>>('GET', `/v1/checkout/fee-preview?${qs}`);
  }
}

/* ─── Error ─── */

/** Structured fields parsed from an API error body. All optional — older endpoints omit some. */
export interface BitPalErrorDetails {
  /** Machine-readable error code, e.g. `"FEATURE_NOT_ENABLED"`. */
  code?: string;
  /** Human-readable message from the API, when it sent one separately from the code. */
  apiMessage?: string;
  /** Whether retrying the same request may succeed. */
  retryable?: boolean;
  /** Server trace id — include it when contacting support. */
  traceId?: string;
}

export class BitPalError extends Error {
  readonly statusCode: number;
  readonly code?: string;
  readonly apiMessage?: string;
  readonly retryable?: boolean;
  readonly traceId?: string;
  constructor(message: string, statusCode: number, details: BitPalErrorDetails = {}) {
    super(message);
    this.name = 'BitPalError';
    this.statusCode = statusCode;
    this.code = details.code;
    this.apiMessage = details.apiMessage;
    this.retryable = details.retryable;
    this.traceId = details.traceId;
  }
}

const ERROR_CODE_RE = /^[A-Z][A-Z0-9_]*$/;

/**
 * API error body -> BitPalError details. Reads both shapes:
 *   - standard: `{ error: <message>, code, retryable, trace_id }`
 *   - some routes: `{ error: <CODE>, message }`
 * `message` (Error.message) stays `body.error` for backward compatibility — extra info is exposed only as fields.
 */
export function parseApiErrorBody(body: unknown): BitPalErrorDetails {
  if (!body || typeof body !== 'object') return {};
  const b = body as Record<string, unknown>;
  const str = (v: unknown): string | undefined => (typeof v === 'string' && v.length > 0 ? v : undefined);
  const error = str(b.error);
  const explicitCode = str(b.code);
  const message = str(b.message);
  const code = explicitCode ?? (error && ERROR_CODE_RE.test(error) ? error : undefined);
  const apiMessage = message ?? (explicitCode && error && error !== explicitCode ? error : undefined);
  return {
    code,
    apiMessage,
    retryable: typeof b.retryable === 'boolean' ? b.retryable : undefined,
    traceId: str(b.trace_id),
  };
}

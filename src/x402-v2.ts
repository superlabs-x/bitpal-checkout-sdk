/**
 * x402 v2 wire format — headers and envelopes for the `upto` scheme.
 *
 * v2 did not just add a scheme. **It moved the transport off the body.** A stock v2 client never
 * reads the response body; it looks for a `PAYMENT-REQUIRED` header, and only falls back to the
 * body when `x402Version === 1`. Serving a v2 402 in the body means a stock agent cannot even
 * discover that payment is possible.
 *
 * |                   | v1 (`exact`)          | v2 (`upto`)          |
 * | ----------------- | --------------------- | -------------------- |
 * | 402 requirements  | response body         | `PAYMENT-REQUIRED`   |
 * | payment payload   | `X-PAYMENT`           | `PAYMENT-SIGNATURE`  |
 * | settlement receipt| `X-PAYMENT-RESPONSE`  | `PAYMENT-RESPONSE`   |
 *
 * The envelope differs too: v1 is flat (`{ scheme, network, payload }`), v2 nests the selected
 * requirements under `accepted` and lifts `resource` to a top-level object. These shapes were
 * captured from `@x402/*` 2.31.0 rather than inferred from the spec text, which omits both.
 *
 * Keeping this module separate from `x402.ts` is deliberate: it is the part most tightly coupled to
 * an external spec, so when that spec moves there is exactly one file to re-check.
 */

/** resource server → payer. base64(JSON) payment requirements. v2 only. */
export const X402_PAYMENT_REQUIRED_HEADER = 'PAYMENT-REQUIRED';
/** payer → resource server. base64(JSON) payment payload. v2 only. */
export const X402_PAYMENT_SIGNATURE_HEADER = 'payment-signature';
/** resource server → payer. base64(JSON) settlement result. v2 only (v1 uses `X-PAYMENT-RESPONSE`). */
export const X402_PAYMENT_RESPONSE_HEADER_V2 = 'PAYMENT-RESPONSE';

/**
 * Requirements must not be cached — they carry a deadline and a one-shot settlement address.
 * The stock resource server sets this, so a proxy in between behaves the same for both.
 */
export const X402_PAYMENT_REQUIRED_CACHE_CONTROL = 'no-store';

/** Max accepted size for an inbound `PAYMENT-SIGNATURE` header. A normal payload is well under 1KB. */
const MAX_PAYMENT_SIGNATURE_BYTES = 8192;

/* ─── 402 body (v2) ─── */

/**
 * In v1 each `accepts[]` entry carried `resource` / `description` / `mimeType` as strings. v2 lifts
 * them into one object at the top level, since they are properties of the resource, not of a payment
 * option — the same resource may be payable several ways.
 */
export interface X402ResourceInfo {
  url: string;
  description?: string;
  mimeType?: string;
  serviceName?: string;
  tags?: string[];
  iconUrl?: string;
}

/** One `accepts[]` entry for `upto`. `amount` is the **approval ceiling**, not the charge. */
export interface X402UptoAccept {
  scheme: 'upto';
  /** CAIP-2 (`eip155:8453`). v1 used hyphenated short names; mixing the two picks the wrong chain. */
  network: string;
  asset: string;
  /** The forwarder clone the payer signs as `witness.to`. Not the merchant wallet. */
  payTo: string;
  /** Approval ceiling, atomic units. */
  amount: string;
  maxTimeoutSeconds: number;
  extra: {
    name: string;
    version: string;
    chainId: number;
    /** Settler contract address. Goes into `witness.facilitator`; the proxy checks it against `msg.sender`. */
    facilitatorAddress: string;
  };
  /**
   * BitPal extension — not part of `PaymentRequirements`. Stock clients ignore unknown keys (verified
   * against 2.31.0), and merchants need to see how a charge will be split.
   */
  feeBreakdown?: { feeBps: number; feeRecipient: string | null };
}

/**
 * A v2 `exact` accept. Nearly identical to `upto`; the differences are `scheme` and the absence of
 * `extra.facilitatorAddress`.
 *
 * It is absent because an EIP-3009 signature names the **token itself** as `verifyingContract`, so
 * the payer never needs one of our contract addresses. `upto` needs it because the settler address
 * is part of the Permit2 witness.
 */
export interface X402ExactAccept {
  scheme: 'exact';
  /** CAIP-2 (`eip155:8453`). */
  network: string;
  asset: string;
  /** The forwarder clone the payer signs as `authorization.to`. Not the merchant wallet. */
  payTo: string;
  /** Charge amount, atomic units. (v1 called this `maxAmountRequired`.) */
  amount: string;
  maxTimeoutSeconds: number;
  extra: { name: string; version: string; chainId: number };
  /** BitPal extension — stock clients ignore unknown keys. */
  feeBreakdown?: { netAmount: string; feeAmount: string; feeBps: number; feeRecipient: string | null };
}

export type X402V2Accept = X402ExactAccept | X402UptoAccept;

export interface X402V2Requirements {
  x402Version: 2;
  resource: X402ResourceInfo;
  accepts: X402V2Accept[];
  error?: string;
  /**
   * Protocol extensions the facilitator supports, **top-level and not inside `accepts`** — that is
   * where a stock v2 client reads them from.
   *
   * The key that matters today is `eip2612GasSponsoring`: it tells the payer they can skip the
   * one-time on-chain `approve(Permit2)` and sign an EIP-2612 permit instead, which the facilitator
   * submits and pays gas for. A stock client handles this on its own — it only looks at whether the
   * key is present, never at the value.
   *
   * Declared here so this passes through the gate by contract rather than by accident: the object is
   * spread into the `PAYMENT-REQUIRED` header, so dropping the field would silently restore the
   * approve wall with no error anywhere.
   */
  extensions?: Record<string, unknown>;
}

/* ─── Payment payload (v2) ─── */

export interface Permit2Authorization {
  permitted: { token: string; amount: string };
  from: string;
  /** The official upto proxy. The payer signs it as the Permit2 spender. */
  spender: string;
  /** 256-bit, decimal string — chosen by the signer, not a counter. */
  nonce: string;
  deadline: string;
  witness: { to: string; facilitator: string; validAfter: string };
}

/**
 * The v2 envelope. **`scheme` and `network` live inside `accepted`,** not at the top level.
 *
 * `accepted` is what the payer selected, so it is not trusted: the resource server rebuilds the
 * requirements itself and the facilitator re-derives the forwarder address from them. It is read
 * here only to route and to scope the replay key.
 */
/** Signed fields of EIP-3009 `TransferWithAuthorization` — the `exact` body. */
export interface Eip3009Authorization {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
}

export interface X402V2PaymentPayload {
  x402Version: 2;
  resource?: X402ResourceInfo;
  /** `scheme` routes; the rest is payer-chosen and therefore untrusted. */
  accepted: { scheme: 'exact' | 'upto'; network: string; [k: string]: unknown };
  payload:
    | { signature: string; authorization: Eip3009Authorization }
    | { signature: string; permit2Authorization: Permit2Authorization };
  extensions?: Record<string, unknown>;
}

/** Narrowing helpers — the body shape follows `accepted.scheme`. */
export function isExactPayload(
  p: X402V2PaymentPayload,
): p is X402V2PaymentPayload & { payload: { signature: string; authorization: Eip3009Authorization } } {
  return p.accepted.scheme === 'exact';
}

/* ─── Codec ─── */

function encodeBase64Json(value: unknown): string {
  const json = JSON.stringify(value);
  return typeof Buffer !== 'undefined'
    ? Buffer.from(json, 'utf8').toString('base64')
    : btoa(unescape(encodeURIComponent(json)));
}

function decodeBase64Json(encoded: string): unknown {
  const json =
    typeof Buffer !== 'undefined'
      ? Buffer.from(encoded, 'base64').toString('utf8')
      : decodeURIComponent(escape(atob(encoded)));
  return JSON.parse(json);
}

/** Builds the `PAYMENT-REQUIRED` header value from a v2 402 body. */
export function encodePaymentRequiredHeader(requirements: X402V2Requirements): string {
  return encodeBase64Json(requirements);
}

/** Builds the `PAYMENT-RESPONSE` header value from a settlement result. */
export function encodePaymentResponseHeaderV2(result: unknown): string {
  return encodeBase64Json(result);
}

const ADDRESS_RE = /^0x[a-fA-F0-9]{40}$/;
const DECIMAL_RE = /^\d+$/;
const HEX_RE = /^0x[0-9a-fA-F]+$/;

/**
 * Builds a `PAYMENT-SIGNATURE` header value.
 *
 * The payer side of {@link decodePaymentSignatureHeader}. Stock clients do this themselves; this
 * exists for `preparePayment()` and for tests, so the two directions cannot drift apart.
 */
export function encodePaymentSignatureHeader(payload: X402V2PaymentPayload): string {
  return encodeBase64Json(payload);
}

/**
 * Parses a `PAYMENT-SIGNATURE` header.
 *
 * Validation here is shape-only — it exists so a malformed header produces a clean 402 instead of a
 * crash or a pointless API round trip. Authenticity is the facilitator's job: it re-derives the
 * forwarder address from the requirements and checks the signature against it, so nothing in this
 * payload can be believed on its own.
 *
 * @throws Error when the header is not a well-formed v2 upto payload.
 */
export function decodePaymentSignatureHeader(header: string): X402V2PaymentPayload {
  if (header.length > MAX_PAYMENT_SIGNATURE_BYTES) {
    throw new Error('[BitPal] x402: PAYMENT-SIGNATURE header is too large.');
  }
  let decoded: unknown;
  try {
    decoded = decodeBase64Json(header);
  } catch {
    throw new Error('[BitPal] x402: PAYMENT-SIGNATURE is not base64-encoded JSON.');
  }
  if (typeof decoded !== 'object' || decoded === null || Array.isArray(decoded)) {
    throw new Error('[BitPal] x402: PAYMENT-SIGNATURE must decode to a JSON object.');
  }
  const p = decoded as Record<string, unknown>;

  const check = (ok: boolean, what: string): void => {
    if (!ok) throw new Error(`[BitPal] x402: PAYMENT-SIGNATURE has an invalid '${what}'.`);
  };

  // ── Envelope. Same for every scheme. ──
  check(p.x402Version === 2, 'x402Version');

  const accepted = p.accepted as Record<string, unknown> | undefined;
  check(typeof accepted === 'object' && accepted !== null, 'accepted');
  const scheme = (accepted as Record<string, unknown>).scheme;
  check(scheme === 'exact' || scheme === 'upto', 'accepted.scheme');
  const network = (accepted as Record<string, unknown>).network;
  check(typeof network === 'string' && network.length > 0, 'accepted.network');

  const payload = p.payload as Record<string, unknown> | undefined;
  check(typeof payload === 'object' && payload !== null, 'payload');
  const sig = (payload as Record<string, unknown>).signature;
  // Length is not fixed for `upto`: an ERC-6492 wrapper (smart-account payers) is longer than 65 bytes.
  //   `exact` is 65 bytes because the token contract itself runs ecrecover, but the body check below
  //   is what enforces that — the envelope stays scheme-agnostic.
  check(typeof sig === 'string' && HEX_RE.test(sig), 'payload.signature');

  // ── Body. Follows `accepted.scheme`. ──
  if (scheme === 'exact') {
    // **65바이트 고정이다.** `upto` 와 달리 ERC-6492 래핑을 받을 수 없다 — EIP-3009 는 토큰
    //   컨트랙트가 직접 ecrecover 하므로 래핑 서명은 온체인에서 복구되지 않는다. 여기서 막지
    //   않으면 그 실패가 한참 뒤 브로드캐스트 시점에 드러난다.
    check(/^0x[0-9a-fA-F]{130}$/.test(sig as string), 'payload.signature (exact must be 65 bytes)');

    const auth = (payload as Record<string, unknown>).authorization as Record<string, unknown> | undefined;
    check(typeof auth === 'object' && auth !== null, 'payload.authorization');
    const a = auth as Record<string, unknown>;
    check(typeof a.from === 'string' && ADDRESS_RE.test(a.from), 'authorization.from');
    check(typeof a.to === 'string' && ADDRESS_RE.test(a.to), 'authorization.to');
    check(typeof a.value === 'string' && DECIMAL_RE.test(a.value), 'authorization.value');
    check(typeof a.validAfter === 'string' && DECIMAL_RE.test(a.validAfter), 'authorization.validAfter');
    check(typeof a.validBefore === 'string' && DECIMAL_RE.test(a.validBefore), 'authorization.validBefore');
    check(typeof a.nonce === 'string' && /^0x[0-9a-fA-F]{64}$/.test(a.nonce), 'authorization.nonce');

    // **서명된 필드만 통과시킨다.** 봉투(`accepted`)는 순정이 임의 키를 싣기 때문에
    //   passthrough 지만, `authorization` 은 EIP-3009 가 서명하는 6개가 전부다 — 그 밖의 키는
    //   서명 대상이 아니므로 들고 갈 이유가 없고, 그대로 전달하면 API 바디로 샌다.
    const clean = decoded as X402V2PaymentPayload;
    (clean.payload as { authorization: Eip3009Authorization }).authorization = {
      from: a.from as string,
      to: a.to as string,
      value: a.value as string,
      validAfter: a.validAfter as string,
      validBefore: a.validBefore as string,
      nonce: a.nonce as string,
    };
    return clean;
  }

  const auth = (payload as Record<string, unknown>).permit2Authorization as
    | Record<string, unknown>
    | undefined;
  check(typeof auth === 'object' && auth !== null, 'payload.permit2Authorization');
  const a = auth as Record<string, unknown>;
  const permitted = a.permitted as Record<string, unknown> | undefined;
  check(typeof permitted === 'object' && permitted !== null, 'permitted');
  check(typeof permitted?.token === 'string' && ADDRESS_RE.test(permitted.token as string), 'permitted.token');
  check(typeof permitted?.amount === 'string' && DECIMAL_RE.test(permitted.amount as string), 'permitted.amount');
  check(typeof a.from === 'string' && ADDRESS_RE.test(a.from), 'from');
  check(typeof a.spender === 'string' && ADDRESS_RE.test(a.spender), 'spender');
  check(typeof a.nonce === 'string' && DECIMAL_RE.test(a.nonce), 'nonce');
  check(typeof a.deadline === 'string' && DECIMAL_RE.test(a.deadline), 'deadline');
  const w = a.witness as Record<string, unknown> | undefined;
  check(typeof w === 'object' && w !== null, 'witness');
  check(typeof w?.to === 'string' && ADDRESS_RE.test(w.to as string), 'witness.to');
  check(typeof w?.facilitator === 'string' && ADDRESS_RE.test(w.facilitator as string), 'witness.facilitator');
  check(typeof w?.validAfter === 'string' && DECIMAL_RE.test(w.validAfter as string), 'witness.validAfter');

  return decoded as X402V2PaymentPayload;
}

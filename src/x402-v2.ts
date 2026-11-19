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

export interface X402UptoRequirements {
  x402Version: 2;
  resource: X402ResourceInfo;
  accepts: X402UptoAccept[];
  error?: string;
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
export interface X402UptoPaymentPayload {
  x402Version: 2;
  resource?: X402ResourceInfo;
  accepted: { scheme: 'upto'; network: string; [k: string]: unknown };
  payload: { signature: string; permit2Authorization: Permit2Authorization };
  extensions?: Record<string, unknown>;
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
export function encodePaymentRequiredHeader(requirements: X402UptoRequirements): string {
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
 * Parses a `PAYMENT-SIGNATURE` header.
 *
 * Validation here is shape-only — it exists so a malformed header produces a clean 402 instead of a
 * crash or a pointless API round trip. Authenticity is the facilitator's job: it re-derives the
 * forwarder address from the requirements and checks the signature against it, so nothing in this
 * payload can be believed on its own.
 *
 * @throws Error when the header is not a well-formed v2 upto payload.
 */
export function decodePaymentSignatureHeader(header: string): X402UptoPaymentPayload {
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

  check(p.x402Version === 2, 'x402Version');

  const accepted = p.accepted as Record<string, unknown> | undefined;
  check(typeof accepted === 'object' && accepted !== null, 'accepted');
  check((accepted as Record<string, unknown>).scheme === 'upto', 'accepted.scheme');
  const network = (accepted as Record<string, unknown>).network;
  check(typeof network === 'string' && network.length > 0, 'accepted.network');

  const payload = p.payload as Record<string, unknown> | undefined;
  check(typeof payload === 'object' && payload !== null, 'payload');
  const sig = (payload as Record<string, unknown>).signature;
  // Length is not fixed: an ERC-6492 wrapper (smart-account payers) is longer than 65 bytes.
  check(typeof sig === 'string' && HEX_RE.test(sig), 'payload.signature');

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

  return decoded as X402UptoPaymentPayload;
}

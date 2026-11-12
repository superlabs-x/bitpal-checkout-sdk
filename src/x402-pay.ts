/**
 * x402-pay — payer-side helper. Takes a 402 response and builds the `X-PAYMENT` header.
 *
 * BitPal's 402 can carry a fee extension (`feeBreakdown`: merchant share + platform fee share)
 * that stock x402 clients don't know about; this helper absorbs that difference on the payer side.
 * A plain 402 without `feeBreakdown` works as well. Either way, a single authorization is produced
 * (see `createX402Payment`).
 *
 * It does not sign by itself. Pass a `signTypedData` from whatever holds the wallet/key, so this
 * SDK has no crypto library dependency (viem / ethers / browser wallets connect in a few lines).
 */

import type { Eip3009Authorization, X402Accept, X402PaymentPayload, X402Requirements } from './x402.js';
import { encodePaymentHeader } from './x402.js';

/** EIP-712 type definition for EIP-3009 `TransferWithAuthorization`. */
export const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: 'from', type: 'address' },
    { name: 'to', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'validAfter', type: 'uint256' },
    { name: 'validBefore', type: 'uint256' },
    { name: 'nonce', type: 'bytes32' },
  ],
} as const;

export interface Eip712Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}

export interface X402TypedDataRequest {
  domain: Eip712Domain;
  types: typeof TRANSFER_WITH_AUTHORIZATION_TYPES;
  primaryType: 'TransferWithAuthorization';
  message: {
    from: string;
    to: string;
    value: string;
    validAfter: string;
    validBefore: string;
    nonce: string;
  };
}

/**
 * EIP-712 signer. Must return a 65-byte `0x…` signature string.
 *
 * @example viem
 * ```ts
 * const sign: X402Signer = (req) => walletClient.signTypedData({ account, ...req });
 * ```
 * @example ethers v6
 * ```ts
 * const sign: X402Signer = (req) => wallet.signTypedData(req.domain, req.types, req.message);
 * ```
 */
export type X402Signer = (request: X402TypedDataRequest) => Promise<string> | string;

export interface CreateX402PaymentOptions {
  /** The full 402 response body, or a single `accepts[]` entry. */
  requirements: X402Requirements | X402Accept;
  /** Payer address. Must match the signer (the server verifies it by signature recovery). */
  from: string;
  signTypedData: X402Signer;
  /**
   * Signature validity in seconds. Defaults to the 402's `maxTimeoutSeconds`.
   * BitPal rejects values below 60 or above 3600 seconds.
   */
  validForSeconds?: number;
  /** Test hook for a fixed clock. Defaults to `Date.now()`. */
  now?: () => number;
  /** Test hook for a fixed nonce. Defaults to 32 CSPRNG bytes. */
  randomNonce?: () => string;
}

export interface X402PaymentResult {
  /** Base64 string to put directly in the `X-PAYMENT` header. */
  header: string;
  payload: X402PaymentPayload;
  /** Total amount leaving the wallet (merchant share + fee share). */
  totalAmount: string;
}

/**
 * The server accepts 60–3600 seconds, but the payer computes validBefore from its **local clock**.
 * Using exactly 60 would be rejected at `validBefore >= now+60` if the round trip or server clock is even 1 s ahead,
 * so a lower bound with a safety margin is used to avoid wasted signatures.
 */
const CLOCK_SKEW_MARGIN_SECONDS = 30;
const SERVER_MIN_VALIDITY_SECONDS = 60;
const MIN_VALIDITY_SECONDS = SERVER_MIN_VALIDITY_SECONDS + CLOCK_SKEW_MARGIN_SECONDS;
const MAX_VALIDITY_SECONDS = 3600;

/**
 * 402 response -> signed `X-PAYMENT` header.
 *
 * Requires one signature: the full gross amount goes to the `payTo` forwarder address, which splits
 * any platform fee on-chain. The validity window is taken from the 402 (or `validForSeconds`)
 * and kept within the server's 60–3600 s range.
 *
 * @example
 * ```ts
 * const res = await fetch(url);
 * if (res.status === 402) {
 *   const { header } = await createX402Payment({
 *     requirements: await res.json(),
 *     from: account.address,
 *     signTypedData: (req) => walletClient.signTypedData({ account, ...req }),
 *   });
 *   const paid = await fetch(url, { headers: { 'X-PAYMENT': header } });
 * }
 * ```
 */
export async function createX402Payment(options: CreateX402PaymentOptions): Promise<X402PaymentResult> {
  const accept = resolveAccept(options.requirements);
  const now = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const validFor = options.validForSeconds ?? accept.maxTimeoutSeconds;

  if (validFor < MIN_VALIDITY_SECONDS || validFor > MAX_VALIDITY_SECONDS) {
    throw new Error(
      `[BitPal] x402: validForSeconds must be between ${MIN_VALIDITY_SECONDS} and ${MAX_VALIDITY_SECONDS} (got ${validFor}). ` +
        `The server requires ${SERVER_MIN_VALIDITY_SECONDS}s minimum; the extra ${CLOCK_SKEW_MARGIN_SECONDS}s absorbs clock skew and round-trip latency.`,
    );
  }

  const domain: Eip712Domain = {
    name: accept.extra.name,
    version: accept.extra.version,
    chainId: accept.extra.chainId,
    verifyingContract: accept.asset,
  };
  if (!domain.chainId) {
    throw new Error('[BitPal] x402: the 402 response is missing extra.chainId — cannot build the EIP-712 domain.');
  }

  // validAfter=0 means "valid from any time", so payer/server clock skew does not matter.
  const validAfter = '0';
  const validBefore = String(now + validFor);
  const nonce = (options.randomNonce ?? randomNonce)();

  // **One signature.** `payTo` is not the merchant wallet but a forwarder address that commits the split
  //   terms via CREATE2; the full gross amount goes there and that address splits the fee on-chain.
  //   So the payer never needs to read `feeBreakdown` — a stock x402 client can pay this 402
  //   the same way.
  const authorization: Eip3009Authorization = {
    from: options.from,
    to: accept.payTo,
    value: accept.maxAmountRequired,
    validAfter,
    validBefore,
    nonce,
  };

  const signature = normalizeSignature(
    await options.signTypedData({
      domain,
      types: TRANSFER_WITH_AUTHORIZATION_TYPES,
      primaryType: 'TransferWithAuthorization',
      message: authorization,
    }),
  );

  const payload: X402PaymentPayload = {
    x402Version: 1,
    scheme: 'exact',
    network: accept.network,
    payload: { signature, authorization },
  };

  return {
    header: encodePaymentHeader(payload),
    payload,
    totalAmount: accept.maxAmountRequired,
  };
}

/* ─── Internal ─── */

function resolveAccept(input: X402Requirements | X402Accept): X402Accept {
  if ('accepts' in input) {
    const first = input.accepts?.[0];
    if (!first) throw new Error('[BitPal] x402: the 402 response has no accepts[] entry.');
    return first;
  }
  return input;
}

/**
 * Signature -> `{v, r, s}`, the split form the BitPal API expects.
 *
 * Accepts both 65-byte (r‖s‖v) and 64-byte EIP-2098 compact (r‖yParityAndS) signatures — viem's
 * `signTypedData` returns 65 bytes, but some wallets/libraries return the compact form.
 */
/**
 * Normalizes a wallet signature to **65-byte packed hex**, the x402 standard form.
 *
 * Handles two cases:
 *   - EIP-2098 compact (64 bytes), emitted by some wallets. The top bit of s is yParity; it is stripped and
 *     v is restored to expand to 65 bytes.
 *   - v of 0/1 — mapped to 27/28, the on-chain ecrecover convention.
 *
 * The server only accepts 130 hex chars, so anything not normalized here would be rejected there. Other values
 * would fail recovery anyway, so they are rejected here.
 */
export function normalizeSignature(signature: string): string {
  const hex = signature.startsWith('0x') ? signature.slice(2) : signature;
  if (!/^[0-9a-fA-F]+$/.test(hex) || (hex.length !== 130 && hex.length !== 128)) {
    throw new Error(
      `[BitPal] x402: expected a 65-byte or 64-byte (EIP-2098) hex signature, got ${signature.length} chars.`,
    );
  }
  const r = hex.slice(0, 64);

  if (hex.length === 128) {
    const yParityAndS = BigInt(`0x${hex.slice(64, 128)}`);
    const yParity = Number((yParityAndS >> 255n) & 1n);
    const s = (yParityAndS & ((1n << 255n) - 1n)).toString(16).padStart(64, '0');
    return `0x${r}${s}${(27 + yParity).toString(16).padStart(2, '0')}`;
  }

  const s = hex.slice(64, 128);
  const raw = parseInt(hex.slice(128, 130), 16);
  if (raw === 27 || raw === 28) return `0x${r}${s}${raw.toString(16)}`;
  if (raw === 0 || raw === 1) return `0x${r}${s}${(raw + 27).toString(16)}`;
  throw new Error(`[BitPal] x402: unexpected signature v=${raw} (expected 0, 1, 27 or 28).`);
}

/** 32-byte CSPRNG nonce. EIP-3009 only requires the nonce to be unique per signer. */
function randomNonce(): string {
  const g = globalThis as { crypto?: { getRandomValues?<T extends ArrayBufferView>(a: T): T } };
  if (!g.crypto?.getRandomValues) {
    throw new Error('[BitPal] x402: crypto.getRandomValues is unavailable — pass randomNonce explicitly.');
  }
  const bytes = g.crypto.getRandomValues(new Uint8Array(32));
  let hex = '';
  for (const b of bytes) hex += b.toString(16).padStart(2, '0');
  return `0x${hex}`;
}

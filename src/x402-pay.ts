/**
 * x402-pay — payer 측 헬퍼. 402 응답을 받아 `X-PAYMENT` 헤더를 만들어 준다.
 *
 * BitPal 의 402 는 수수료를 forwarder 컨트랙트 없이 나누기 위해 authorization 을 두 개 요구한다
 * (머천트 몫 + 플랫폼 수수료 몫). 순정 x402 클라이언트는 그 확장(`feeBreakdown`)을 모르므로,
 * payer 쪽에서 그 차이를 흡수하는 게 이 파일의 존재 이유다. `feeBreakdown` 이 없는 평범한 402 도
 * 그대로 처리한다 — 그 경우 authorization 하나만 만든다.
 *
 * 서명은 직접 하지 않는다. 지갑/키가 있는 쪽에서 `signTypedData` 하나만 넘기면 되고, 그래서 이
 * SDK 는 암호 라이브러리 의존이 없다(viem / ethers / 브라우저 지갑 전부 몇 줄로 연결된다).
 */

import type { Eip3009Authorization, X402Accept, X402PaymentPayload, X402Requirements } from './x402.js';
import { encodePaymentHeader } from './x402.js';

/** EIP-3009 `TransferWithAuthorization` 의 EIP-712 타입 정의. */
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
 * EIP-712 서명자. 65바이트 `0x…` 서명 문자열을 돌려주면 된다.
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
  /** 402 응답 바디 전체, 또는 그 안의 `accepts[]` 한 칸. */
  requirements: X402Requirements | X402Accept;
  /** 지불자 주소. 서명자와 같은 주소여야 한다(서버가 recover 로 대조). */
  from: string;
  signTypedData: X402Signer;
  /**
   * 서명 유효시간(초). 기본은 402 의 `maxTimeoutSeconds`.
   * BitPal 은 60초 미만·3600초 초과를 거부한다.
   */
  validForSeconds?: number;
  /** 테스트에서 고정하기 위한 훅. 기본은 `Date.now()`. */
  now?: () => number;
  /** 테스트에서 고정하기 위한 훅. 기본은 CSPRNG 32바이트. */
  randomNonce?: () => string;
}

export interface X402PaymentResult {
  /** 그대로 `X-PAYMENT` 헤더에 넣으면 되는 base64 문자열. */
  header: string;
  payload: X402PaymentPayload;
  /** 지갑에서 실제로 빠져나가는 총액(머천트 몫 + 수수료 몫). */
  totalAmount: string;
}

/**
 * 서버가 요구하는 범위는 60~3600초지만, payer 는 **로컬 시계**로 validBefore 를 만든다.
 * 60 에 딱 맞추면 네트워크 왕복 + 서버 시계가 1초만 앞서도 `validBefore >= now+60` 에서 거부되므로
 * 서명 낭비를 막기 위해 마진을 둔 하한을 쓴다.
 */
const CLOCK_SKEW_MARGIN_SECONDS = 30;
const SERVER_MIN_VALIDITY_SECONDS = 60;
const MIN_VALIDITY_SECONDS = SERVER_MIN_VALIDITY_SECONDS + CLOCK_SKEW_MARGIN_SECONDS;
const MAX_VALIDITY_SECONDS = 3600;

/**
 * 402 응답 → 서명된 `X-PAYMENT` 헤더.
 *
 * 수수료가 있으면 서명 프롬프트가 두 번 뜬다(머천트 몫 1건, 수수료 몫 1건). 두 authorization 은
 * 같은 유효창을 쓴다 — 수수료 쪽이 먼저 만료되면 머천트 정산 뒤 수수료만 못 걷히기 때문에
 * 서버가 "수수료 창이 결제 창을 덮을 것"을 요구한다.
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

  // validAfter=0 이면 "언제부터든 유효" 라 payer/서버 시계 오차에 걸리지 않는다.
  const validAfter = '0';
  const validBefore = String(now + validFor);
  const nonce = (options.randomNonce ?? randomNonce)();

  // **서명은 1건이다.** `payTo` 는 머천트 지갑이 아니라 분배 조건을 CREATE2 로 커밋한 포워더
  //   주소이고, 거기로 gross 전액을 보낸다. 수수료를 쪼개는 건 그 주소가 온체인에서 한다.
  //   그래서 payer 는 `feeBreakdown` 을 읽을 필요가 없다 — 순정 x402 클라이언트도 이 402 로
  //   똑같이 결제할 수 있다는 뜻이다.
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

/* ─── 내부 ─── */

function resolveAccept(input: X402Requirements | X402Accept): X402Accept {
  if ('accepts' in input) {
    const first = input.accepts?.[0];
    if (!first) throw new Error('[BitPal] x402: the 402 response has no accepts[] entry.');
    return first;
  }
  return input;
}

/**
 * 서명 → `{v, r, s}`. BitPal API 가 요구하는 분해 형태.
 *
 * 65바이트(r‖s‖v)와 64바이트 EIP-2098 compact(r‖yParityAndS) 둘 다 받는다 — viem 의
 * `signTypedData` 는 65바이트를 주지만 일부 지갑·라이브러리는 compact 를 돌려준다.
 */
/**
 * 지갑이 돌려준 서명을 **65바이트 packed hex** 로 수렴시킨다. x402 표준이 그 형태다.
 *
 * 두 가지를 정규화한다:
 *   - EIP-2098 compact(64바이트) — 일부 지갑이 이걸 낸다. s 의 최상위 비트가 yParity 라 떼어내고
 *     v 를 복원해 65바이트로 편다.
 *   - v 가 0/1 인 경우 — 온체인 ecrecover 규약인 27/28 로 맞춘다.
 *
 * 서버가 130 hex 만 받으므로 여기서 안 맞추면 그쪽에서 거부된다. 그 외 값은 recover 가 어긋나
 * 어차피 실패하므로 여기서 끊는다.
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

/** CSPRNG 32바이트 nonce. EIP-3009 는 nonce 가 서명자별로 유일하기만 하면 된다. */
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

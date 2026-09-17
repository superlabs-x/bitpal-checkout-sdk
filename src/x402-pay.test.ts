/**
 * payer 헬퍼 — 서버가 요구하는 제약을 그대로 만족하는 payload 를 만드는지 본다.
 *
 * 0.11.0 에서 계약이 바뀌었다. 예전에는 머천트 몫/수수료 몫 **2건**에 서명했고, 이 파일 절반이
 * "두 leg 의 금액·nonce·유효창이 서버 제약을 만족하는가" 였다. 이제 분배는 `payTo`(포워더)
 * 주소가 커밋하므로 **서명은 1건**이고, payload 는 x402 표준 `{ signature, authorization }` 이다.
 *
 * 그래서 여기서 잠그는 것도 바뀌었다 — 서명이 정확히 1건인가, `to` 가 402 의 payTo 인가,
 * `value` 가 gross 인가(수수료 차감 전 총액), 그리고 payload 모양이 표준인가.
 */
import { describe, expect, it } from 'vitest';
import { createX402Payment, normalizeSignature } from './x402-pay.js';
import { decodePaymentHeader } from './x402.js';
import type { X402Accept } from './x402.js';
import type { X402TypedDataRequest } from './x402-pay.js';

const FROM = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
/** 402 의 payTo — 머천트 지갑이 아니라 분배 조건을 커밋한 포워더 주소다. */
const PAY_TO = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const FEE_TO = '0xcccccccccccccccccccccccccccccccccccccccc';

const ACCEPT: X402Accept = {
  scheme: 'exact',
  network: 'base',
  asset: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
  payTo: PAY_TO,
  maxAmountRequired: '1000000',
  resource: 'https://api.test/report',
  description: '',
  mimeType: 'application/json',
  maxTimeoutSeconds: 300,
  extra: { name: 'USD Coin', version: '2', chainId: 8453 },
  feeBreakdown: { netAmount: '985000', feeAmount: '15000', feeBps: 150, feeRecipient: FEE_TO },
};

const SIG = `0x${'1'.repeat(64)}${'2'.repeat(64)}1b`;

function recorder() {
  const seen: X402TypedDataRequest[] = [];
  return {
    seen,
    sign: (req: X402TypedDataRequest) => {
      seen.push(req);
      return SIG;
    },
  };
}

let counter = 0;
const nonce = () => `0x${String(++counter).padStart(64, '0')}`;

describe('createX402Payment', () => {
  it('서명은 1건 — gross 전액을 402 의 payTo 로 보낸다', async () => {
    counter = 0;
    const r = recorder();
    const result = await createX402Payment({
      requirements: { x402Version: 1, accepts: [ACCEPT] },
      from: FROM,
      signTypedData: r.sign,
      randomNonce: nonce,
    });

    // 수수료가 있어도 서명은 하나다 — 분배는 payTo 주소가 온체인에서 한다.
    expect(r.seen).toHaveLength(1);
    const p = decodePaymentHeader(result.header);
    expect(p.payload.authorization.to).toBe(PAY_TO);
    // net(985000)이 아니라 gross 다. net 만 보내면 서버가 AMOUNT_MISMATCH 로 거부한다.
    expect(p.payload.authorization.value).toBe('1000000');
    expect(p.payload.authorization.from).toBe(FROM);
    expect(result.totalAmount).toBe('1000000');
  });

  it('payload 모양이 x402 표준이다 — { signature, authorization }', async () => {
    counter = 0;
    const result = await createX402Payment({
      requirements: ACCEPT,
      from: FROM,
      signTypedData: recorder().sign,
      randomNonce: nonce,
    });
    const p = decodePaymentHeader(result.header);
    // 이 모양이라야 순정 x402 클라이언트/서버와 상호운용된다.
    expect(Object.keys(p.payload).sort()).toEqual(['authorization', 'signature']);
    expect(p.payload.signature).toMatch(/^0x[0-9a-f]{130}$/i);
    expect(p.scheme).toBe('exact');
    expect(p.network).toBe('base');
  });

  it('feeBreakdown 을 아예 안 봐도 된다 — 순정 402 도 동일하게 처리한다', async () => {
    counter = 0;
    const { feeBreakdown: _drop, ...plain } = ACCEPT;
    const withFee = await createX402Payment({ requirements: ACCEPT, from: FROM, signTypedData: recorder().sign, randomNonce: nonce });
    counter = 0;
    const withoutFee = await createX402Payment({ requirements: plain as X402Accept, from: FROM, signTypedData: recorder().sign, randomNonce: nonce });

    // 서명 대상이 같다 — payer 입장에서 feeBreakdown 은 정보일 뿐 계약이 아니다.
    const a = decodePaymentHeader(withFee.header).payload.authorization;
    const b = decodePaymentHeader(withoutFee.header).payload.authorization;
    expect(b.to).toBe(a.to);
    expect(b.value).toBe(a.value);
  });

  it('EIP-712 domain 은 402 의 extra + asset 으로 구성한다', async () => {
    counter = 0;
    const r = recorder();
    await createX402Payment({ requirements: ACCEPT, from: FROM, signTypedData: r.sign, randomNonce: nonce });
    expect(r.seen[0]!.domain).toEqual({
      name: 'USD Coin',
      version: '2',
      chainId: 8453,
      verifyingContract: ACCEPT.asset,
    });
    expect(r.seen[0]!.primaryType).toBe('TransferWithAuthorization');
    // 서명 대상 메시지가 authorization 그대로여야 서버 recover 가 맞는다.
    expect(r.seen[0]!.message).toMatchObject({ from: FROM, to: PAY_TO, value: '1000000' });
  });

  it('유효시간이 허용 범위 밖이면 서명 전에 막는다 (서버 60초 + 시계오차 마진 30초)', async () => {
    // 서버 하한 60 에 딱 붙이면 왕복 지연·시계 오차로 verify 에서 튕긴다 — 서명을 낭비시키지 않는다.
    for (const bad of [10, 60, 89, 7200]) {
      await expect(
        createX402Payment({ requirements: ACCEPT, from: FROM, signTypedData: recorder().sign, validForSeconds: bad }),
      ).rejects.toThrow(/between 90 and 3600/);
    }
    await expect(
      createX402Payment({ requirements: ACCEPT, from: FROM, signTypedData: recorder().sign, validForSeconds: 90, randomNonce: nonce }),
    ).resolves.toBeDefined();
  });

  it('chainId 가 없는 402 는 domain 을 만들 수 없으므로 거부한다', async () => {
    await expect(
      createX402Payment({
        requirements: { ...ACCEPT, extra: { name: 'USD Coin', version: '2' } as never },
        from: FROM,
        signTypedData: recorder().sign,
      }),
    ).rejects.toThrow(/extra.chainId/);
  });
});

describe('normalizeSignature', () => {
  it('65바이트 서명은 그대로 통과시킨다', () => {
    expect(normalizeSignature(SIG)).toBe(SIG);
  });

  it('v 를 0/1 로 주는 지갑은 27/28 로 정규화한다', () => {
    const base = `${'1'.repeat(64)}${'2'.repeat(64)}`;
    expect(normalizeSignature(`0x${base}00`)).toBe(`0x${base}1b`);
    expect(normalizeSignature(`0x${base}01`)).toBe(`0x${base}1c`);
  });

  it('EIP-2098 compact(64바이트)를 65바이트로 편다', () => {
    // 서버는 130 hex 만 받는다 — 여기서 안 펴면 그쪽에서 거부된다.
    const s = '2'.repeat(64);
    expect(normalizeSignature(`0x${'1'.repeat(64)}${s}`)).toBe(`0x${'1'.repeat(64)}${s}1b`);

    // 최상위 비트를 세운 경우 → v=28, s 는 그 비트를 뗀 값
    const high = (BigInt(`0x${s}`) | (1n << 255n)).toString(16).padStart(64, '0');
    expect(normalizeSignature(`0x${'1'.repeat(64)}${high}`)).toBe(`0x${'1'.repeat(64)}${s}1c`);
  });

  it('길이가 안 맞거나 v 가 규약 밖이면 throw', () => {
    expect(() => normalizeSignature('0xdeadbeef')).toThrow(/65-byte or 64-byte/);
    // v=2 같은 값을 27+2=29 로 만들어 서버로 보내면 recover 가 어긋난다 — 여기서 끊는다.
    expect(() => normalizeSignature(`0x${'1'.repeat(64)}${'2'.repeat(64)}02`)).toThrow(/unexpected signature v=2/);
  });
});

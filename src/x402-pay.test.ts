/**
 * payer 헬퍼 — 서버가 요구하는 제약을 그대로 만족하는 payload 를 만드는지 본다.
 *
 * 서버 검증(x402-facilitator)이 요구하는 것: merchant.value === netAmount, fee.value === feeAmount,
 * 두 leg 의 서명자 동일, nonce 상이, fee 유효창이 merchant 유효창을 덮을 것.
 */
import { describe, expect, it } from 'vitest';
import { createX402Payment, splitSignature } from './x402-pay.js';
import { decodePaymentHeader } from './x402.js';
import type { X402Accept } from './x402.js';
import type { X402TypedDataRequest } from './x402-pay.js';

const FROM = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
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
  it('수수료가 있으면 두 authorization 에 서명한다 — 금액·수신처가 서버 분해와 정확히 일치', async () => {
    counter = 0;
    const r = recorder();
    const result = await createX402Payment({
      requirements: { x402Version: 1, accepts: [ACCEPT] },
      from: FROM,
      signTypedData: r.sign,
      randomNonce: nonce,
    });

    expect(r.seen).toHaveLength(2);
    const p = decodePaymentHeader(result.header);
    expect(p.payload.merchant.to).toBe(PAY_TO);
    expect(p.payload.merchant.value).toBe('985000');
    expect(p.payload.fee!.to).toBe(FEE_TO);
    expect(p.payload.fee!.value).toBe('15000');
    // 지갑에서 실제로 빠지는 총액 = 402 가 표시한 금액.
    expect(result.totalAmount).toBe('1000000');
  });

  it('두 leg 의 서명자는 같고 nonce 는 다르며 유효창은 동일하다 (서버 제약)', async () => {
    counter = 0;
    const result = await createX402Payment({
      requirements: ACCEPT,
      from: FROM,
      signTypedData: recorder().sign,
      randomNonce: nonce,
    });
    const { merchant, fee } = decodePaymentHeader(result.header).payload;
    expect(fee!.from).toBe(merchant.from);
    expect(fee!.nonce).not.toBe(merchant.nonce);
    // fee 창이 merchant 창보다 짧으면 서버가 FEE_AUTHORIZATION_MISMATCH 로 거부한다.
    expect(BigInt(fee!.validBefore) >= BigInt(merchant.validBefore)).toBe(true);
    expect(BigInt(fee!.validAfter) <= BigInt(merchant.validAfter)).toBe(true);
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
  });

  it('수수료가 0이면 authorization 은 하나뿐이고 전액이 머천트 몫이다', async () => {
    counter = 0;
    const r = recorder();
    const result = await createX402Payment({
      requirements: { ...ACCEPT, feeBreakdown: { netAmount: '1000000', feeAmount: '0', feeBps: 0, feeRecipient: null } },
      from: FROM,
      signTypedData: r.sign,
      randomNonce: nonce,
    });
    expect(r.seen).toHaveLength(1);
    const p = decodePaymentHeader(result.header);
    expect(p.payload.fee).toBeUndefined();
    expect(p.payload.merchant.value).toBe('1000000');
  });

  it('feeBreakdown 없는 순정 x402 402 도 처리한다', async () => {
    counter = 0;
    const { feeBreakdown: _drop, ...plain } = ACCEPT;
    const result = await createX402Payment({
      requirements: plain as X402Accept,
      from: FROM,
      signTypedData: recorder().sign,
      randomNonce: nonce,
    });
    const p = decodePaymentHeader(result.header);
    expect(p.payload.fee).toBeUndefined();
    expect(p.payload.merchant.value).toBe('1000000');
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

describe('splitSignature', () => {
  it('65바이트 서명을 v/r/s 로 쪼갠다', () => {
    expect(splitSignature(SIG)).toEqual({
      v: 27,
      r: `0x${'1'.repeat(64)}`,
      s: `0x${'2'.repeat(64)}`,
    });
  });

  it('v 를 0/1 로 주는 지갑은 27/28 로 정규화한다', () => {
    expect(splitSignature(`0x${'1'.repeat(64)}${'2'.repeat(64)}00`).v).toBe(27);
    expect(splitSignature(`0x${'1'.repeat(64)}${'2'.repeat(64)}01`).v).toBe(28);
  });

  it('EIP-2098 compact(64바이트) 서명도 받는다', () => {
    // yParityAndS 의 최상위 비트가 yParity. 그 비트를 떼어야 정상 s 가 된다.
    const s = '2'.repeat(64);
    const compactEven = `0x${'1'.repeat(64)}${s}`;
    expect(splitSignature(compactEven)).toEqual({ v: 27, r: `0x${'1'.repeat(64)}`, s: `0x${s}` });

    // 최상위 비트를 세운 경우 → v=28, s 는 비트를 뗀 값
    const high = (BigInt(`0x${s}`) | (1n << 255n)).toString(16).padStart(64, '0');
    expect(splitSignature(`0x${'1'.repeat(64)}${high}`)).toEqual({ v: 28, r: `0x${'1'.repeat(64)}`, s: `0x${s}` });
  });

  it('길이가 안 맞거나 v 가 규약 밖이면 throw', () => {
    expect(() => splitSignature('0xdeadbeef')).toThrow(/65-byte or 64-byte/);
    // v=2 같은 값을 27+2=29 로 만들어 서버로 보내면 recover 가 어긋난다 — 여기서 끊는다.
    expect(() => splitSignature(`0x${'1'.repeat(64)}${'2'.repeat(64)}02`)).toThrow(/unexpected signature v=2/);
  });
});

import { describe, it, expect } from 'vitest';
import { toAtomic, fromAtomic, toAtomicUSDC, fromAtomicUSDC } from './amount.js';

describe('amount — 임의 decimals', () => {
  it('toAtomic 6dp (USDC/USDT/Tron/Solana)', () => {
    expect(toAtomic('29.00', 6)).toBe('29000000');
    expect(toAtomic('0.5', 6)).toBe('500000');
    expect(toAtomic('1000', 6)).toBe('1000000000');
  });

  it('toAtomic 18dp (BSC-USD / BNB USDT) — 6dp 하드코딩이면 틀리는 케이스', () => {
    expect(toAtomic('1', 18)).toBe('1000000000000000000');
    expect(toAtomic('1.5', 18)).toBe('1500000000000000000');
    expect(toAtomic('0.000000000000000001', 18)).toBe('1');
  });

  it('fromAtomic 6dp / 18dp', () => {
    expect(fromAtomic('29000000', 6)).toBe('29.00');
    expect(fromAtomic('500000', 6)).toBe('0.50');
    expect(fromAtomic('1500000000000000000', 18)).toBe('1.50');
    expect(fromAtomic('1000000000000000000', 18)).toBe('1.00');
  });

  it('round-trip 임의 decimals', () => {
    for (const [v, d] of [['29.00', 6], ['1.50', 18], ['0.01', 6]] as const) {
      expect(fromAtomic(toAtomic(v, d), d)).toBe(Number(v).toFixed(2));
    }
  });

  it('decimals 초과 소수 자리 → throw', () => {
    expect(() => toAtomic('1.1234567', 6)).toThrow(); // 7 frac > 6
    expect(() => toAtomic('-1.0', 6)).toThrow();
    expect(() => toAtomic('abc', 6)).toThrow();
    expect(() => fromAtomic('1.5', 6)).toThrow(); // atomic 은 정수만
  });

  it('USDC 별칭 = toAtomic(·,6) 하위호환', () => {
    expect(toAtomicUSDC('29.00')).toBe(toAtomic('29.00', 6));
    expect(fromAtomicUSDC('29000000')).toBe(fromAtomic('29000000', 6));
  });
});

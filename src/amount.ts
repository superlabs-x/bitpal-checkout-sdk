/**
 * amount.ts — atomic μUSDC 변환 헬퍼
 *
 * BitPal API는 모든 amount를 atomic 정수 문자열로 받는다 (USDC/USDT 6 decimals).
 *   $1   → "1000000"
 *   $10  → "10000000"
 *   $0.5 → "500000"
 *
 * 정밀도 손실 방지를 위해 BigInt 연산만 사용한다 (Number 변환 금지 — CLAUDE.md 정책).
 */

const USDC_DECIMALS = 6n;
const USDC_SCALE = 10n ** USDC_DECIMALS;

/**
 * decimal 문자열 → atomic μUSDC 문자열
 *
 * @example
 * toAtomicUSDC('29.00')   // → '29000000'
 * toAtomicUSDC('0.5')     // → '500000'
 * toAtomicUSDC('1000')    // → '1000000000'
 *
 * @throws {Error} 음수, 6자리 초과 소수, 형식 오류
 */
export function toAtomicUSDC(decimal: string): string {
  if (typeof decimal !== 'string' || !/^\d+(\.\d{1,6})?$/.test(decimal)) {
    throw new Error(`toAtomicUSDC: invalid decimal '${decimal}' (max 6 fractional digits, no negatives)`);
  }
  const [whole = '0', frac = ''] = decimal.split('.');
  const fracPadded = frac.padEnd(Number(USDC_DECIMALS), '0');
  return (BigInt(whole) * USDC_SCALE + BigInt(fracPadded || '0')).toString();
}

/**
 * atomic μUSDC 문자열 → 사람이 읽기 좋은 decimal 문자열
 *
 * @example
 * fromAtomicUSDC('29000000')   // → '29.00'
 * fromAtomicUSDC('500000')     // → '0.50'
 * fromAtomicUSDC('1500000')    // → '1.50'
 *
 * @throws {Error} 정수 문자열이 아니면
 */
export function fromAtomicUSDC(atomic: string): string {
  if (typeof atomic !== 'string' || !/^\d+$/.test(atomic)) {
    throw new Error(`fromAtomicUSDC: invalid atomic '${atomic}' (must be non-negative integer string)`);
  }
  const big = BigInt(atomic);
  const whole = big / USDC_SCALE;
  const frac = big % USDC_SCALE;
  const fracStr = frac.toString().padStart(Number(USDC_DECIMALS), '0').replace(/0+$/, '');
  return fracStr.length > 0
    ? `${whole}.${fracStr.padEnd(2, '0')}`
    : `${whole}.00`;
}

/**
 * amount.ts — atomic ↔ decimal 변환 헬퍼 (임의 decimals + USDC 하위호환)
 *
 * BitPal API는 모든 amount를 atomic 정수 문자열로 받는다. decimals 는 토큰마다 다르다:
 *   USDC/USDT(Base/Arb/Tron/Solana) = 6, BSC-USD(BNB USDT) = 18. → payment_options[].decimals /
 *   PublicSession.token_decimals 로 서버가 내려준다. 6dp 를 하드코딩하면 non-6dp 토큰에서 금액이 틀린다.
 *
 * 정밀도 손실 방지를 위해 BigInt 연산만 사용한다 (Number 변환 금지 — CLAUDE.md 정책).
 *   $1(6dp)   → "1000000"     $1(18dp) → "1000000000000000000"
 */

/**
 * decimal 문자열 → atomic 문자열 (임의 decimals).
 *
 * @param decimal 소수 문자열(음수 불가, 소수 자리 ≤ decimals)
 * @param decimals 토큰 decimals (예: 6, 18). payment_options[].decimals 사용.
 * @throws {Error} 음수, decimals 초과 소수 자리, 형식 오류
 * @example toAtomic('29.00', 6) // '29000000'   toAtomic('1.5', 18) // '1500000000000000000'
 */
export function toAtomic(decimal: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`toAtomic: invalid decimals '${decimals}'`);
  }
  const fracPattern = decimals > 0 ? `(\\.\\d{1,${decimals}})?` : '';
  if (typeof decimal !== 'string' || !new RegExp(`^\\d+${fracPattern}$`).test(decimal)) {
    throw new Error(`toAtomic: invalid decimal '${decimal}' (max ${decimals} fractional digits, no negatives)`);
  }
  const scale = 10n ** BigInt(decimals);
  const [whole = '0', frac = ''] = decimal.split('.');
  const fracPadded = frac.padEnd(decimals, '0');
  return (BigInt(whole) * scale + BigInt(fracPadded || '0')).toString();
}

/**
 * atomic 문자열 → 사람이 읽기 좋은 decimal 문자열 (임의 decimals).
 * 최소 2자리 소수를 유지하되(예: '29.00'), decimals 만큼만 노출.
 *
 * @throws {Error} 정수 문자열이 아니면
 * @example fromAtomic('29000000', 6) // '29.00'   fromAtomic('1500000000000000000', 18) // '1.50'
 */
export function fromAtomic(atomic: string, decimals: number): string {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 36) {
    throw new Error(`fromAtomic: invalid decimals '${decimals}'`);
  }
  if (typeof atomic !== 'string' || !/^\d+$/.test(atomic)) {
    throw new Error(`fromAtomic: invalid atomic '${atomic}' (must be non-negative integer string)`);
  }
  const scale = 10n ** BigInt(decimals);
  const big = BigInt(atomic);
  const whole = big / scale;
  const frac = big % scale;
  if (decimals === 0) return `${whole}`;
  const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
  return fracStr.length > 0 ? `${whole}.${fracStr.padEnd(2, '0')}` : `${whole}.00`;
}

/**
 * decimal → atomic μUSDC (6dp). 하위호환 별칭 — 새 코드는 `toAtomic(decimal, decimals)` 권장
 *   (BNB USDT=18dp 등 non-6dp 토큰은 이 헬퍼로 처리 불가).
 * @example toAtomicUSDC('29.00') // '29000000'
 */
export function toAtomicUSDC(decimal: string): string {
  return toAtomic(decimal, 6);
}

/**
 * atomic μUSDC(6dp) → decimal. 하위호환 별칭 — 새 코드는 `fromAtomic(atomic, decimals)` 권장.
 * @example fromAtomicUSDC('29000000') // '29.00'
 */
export function fromAtomicUSDC(atomic: string): string {
  return fromAtomic(atomic, 6);
}

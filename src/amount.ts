/**
 * amount.ts — atomic <-> decimal conversion helpers (any decimals, plus USDC aliases)
 *
 * The BitPal API takes every amount as an atomic integer string. Decimals differ per token:
 *   USDC/USDT (Base/Arbitrum/Tron/Solana) = 6, BSC-USD (BNB USDT) = 18. The server returns them in
 *   payment_options[].decimals / PublicSession.token_decimals. Hardcoding 6dp gives wrong amounts for non-6dp tokens.
 *
 * Only BigInt arithmetic is used, to avoid precision loss (never converted to Number).
 *   $1(6dp)   → "1000000"     $1(18dp) → "1000000000000000000"
 */

/**
 * Decimal string -> atomic string (any decimals).
 *
 * @param decimal Decimal string (non-negative, at most `decimals` fractional digits)
 * @param decimals Token decimals (e.g. 6, 18). Use payment_options[].decimals.
 * @throws {Error} On negatives, too many fractional digits, or malformed input
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
 * Atomic string -> human-readable decimal string (any decimals).
 * Keeps at least 2 fractional digits (e.g. '29.00') and at most `decimals`.
 *
 * @throws {Error} If the input is not an integer string
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
 * decimal -> atomic μUSDC (6dp). Backward-compatible alias — prefer `toAtomic(decimal, decimals)` in new code
 *   (it cannot handle non-6dp tokens such as BNB USDT = 18dp).
 * @example toAtomicUSDC('29.00') // '29000000'
 */
export function toAtomicUSDC(decimal: string): string {
  return toAtomic(decimal, 6);
}

/**
 * atomic μUSDC (6dp) -> decimal. Backward-compatible alias — prefer `fromAtomic(atomic, decimals)` in new code.
 * @example fromAtomicUSDC('29000000') // '29.00'
 */
export function fromAtomicUSDC(atomic: string): string {
  return fromAtomic(atomic, 6);
}

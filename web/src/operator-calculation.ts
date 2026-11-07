import Decimal from 'decimal.js';

// Independent precision: other accounting modules may configure their own Decimal.
const OperatorDecimal = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });

function input(value: string, scale: number, zero: boolean, max: string) {
  const normalized = value.trim().replace(',', '.');
  if (normalized.length > 40 || !new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`).test(normalized)) return null;
  const parsed = new OperatorDecimal(normalized);
  if (parsed.gt(max) || parsed.lt(0) || !zero && parsed.eq(0)) return null;
  return parsed;
}

/** Null means an incomplete/invalid form; only the final total is rounded. */
export function calculateOperatorAmount(litres: string, price: string, discount: string, allowHistoricalPrecision = false): string | null {
  const quantity = input(litres, allowHistoricalPrecision ? 6 : 2, false, '1000000000000');
  const basePrice = input(price, allowHistoricalPrecision ? 6 : 2, false, '1000000000000');
  const discountPercent = input(discount, 6, true, '100');
  if (!quantity || !basePrice || !discountPercent) return null;
  return quantity.times(basePrice).times(new OperatorDecimal(1).minus(discountPercent.div(100))).toFixed(2, OperatorDecimal.ROUND_HALF_UP);
}

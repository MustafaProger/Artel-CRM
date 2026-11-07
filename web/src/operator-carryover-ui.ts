import Decimal from 'decimal.js'
const D = Decimal.clone({ precision: 60 })

/** Form projection only; the server rechecks quantity, version and available balance. */
export function operatorPayableLitres(total: string, carried = '0'): string | null {
  const normalize = (value: string) => value.trim().replace(',', '.')
  const a = normalize(total), b = normalize(carried)
  if (![a, b].every(value => value.length <= 40 && /^\d+(?:\.\d{1,6})?$/.test(value))) return null
  const result = new D(a).minus(b)
  return result.isNegative() || new D(a).gt('1000000000000') ? null : result.toFixed()
}

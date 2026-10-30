import Decimal from 'decimal.js';

/** New snapshots opt in explicitly; frozen pre-existing XML keeps its exact conversion. */
export const SABY_VOLUME_ROUNDING_VERSION = 'fns-5.01-v1' as const;
export type SabyVolumeRoundingVersion = typeof SABY_VOLUME_ROUNDING_VERSION;
export const SABY_VOLUME_ROUNDING_INFO = 'Точность объёмов CRM';
const VolumeDecimal = Decimal.clone({ precision: 80, rounding: Decimal.ROUND_HALF_UP });

/** Input units remain explicit. A comma is a decimal separator, never a thousands separator. */
export function exactSabyVolume(value: unknown, unit: 'litres' | 'cubic-metres'): string | null {
  if (typeof value !== 'string' || value.length > 40 || !/^\d+(?:[.,]\d+)?$/.test(value)) return null;
  return new VolumeDecimal(value.replace(',', '.')).div(unit === 'litres' ? 1000 : 1).toFixed();
}

/** FNS 5.01: order volume/capacity 2 dp; consignment cargo volume 3 dp.
 * The original quantities are never modified. Zero after rounding must be blocked by the caller.
 * Absence of the version preserves the previous exact-only behavior of historical snapshots.
 */
export function formatSabyVolume(value: unknown, unit: 'litres' | 'cubic-metres', fractionDigits: 2 | 3, version?: SabyVolumeRoundingVersion): string | null {
  const exact = exactSabyVolume(value, unit);
  if (exact === null) return null;
  return version === SABY_VOLUME_ROUNDING_VERSION
    ? new VolumeDecimal(exact).toDecimalPlaces(fractionDigits, Decimal.ROUND_HALF_UP).toFixed()
    : exact;
}

export function sabyVolumeRoundedToZero(value: unknown, unit: 'litres' | 'cubic-metres', fractionDigits: 2 | 3, version?: SabyVolumeRoundingVersion): boolean {
  const exact = exactSabyVolume(value, unit);
  return exact !== null && new VolumeDecimal(exact).gt(0) && formatSabyVolume(value, unit, fractionDigits, version) === '0';
}

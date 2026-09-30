import type { Product } from './model';

/** This rule is opt-in for bulk diesel; neither a short name nor ADR packing group is evidence of packaging. */
export function isUnpackagedDiesel(product: Product | undefined): boolean {
  return product?.transportProductKind === 'diesel' && product.cargoPackaging === 'bulk';
}

/** Date-only is retained as date-only: missing time must never become an invented loading event. */
export function validLoadingDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?)?$/.test(value)) return false;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
}

import type { ShipmentAddress, Snapshot } from '../web/src/model';
import { ApiError } from './api-error';

export function validateStoredDeliveryDistances(value: unknown) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > 5000 || Object.entries(value).some(([id, distance]) => !id || id.length > 500 || typeof distance !== 'string' || distance.length > 32 || !/^\d+(?:\.\d+)?$/.test(distance) || !Number.isFinite(Number(distance)) || Number(distance) > 100000)) throw new Error('Invalid stored oil depot distances');
}

// Manual reference values only; these distances do not participate in pricing.
export function deliveryDistances(input: Record<string, unknown>, snapshot: Snapshot, previous?: ShipmentAddress): ShipmentAddress['oilDepotDistancesKm'] {
  if (!Object.hasOwn(input, 'oilDepotDistancesKm')) return previous?.oilDepotDistancesKm ? { ...previous.oilDepotDistancesKm } : undefined;
  const raw = input.oilDepotDistancesKm;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).length > 5000) throw new ApiError(400, 'Укажите расстояния до нефтебаз списком значений в километрах.');
  const depotIds = new Set((snapshot.directories?.oilDepots ?? []).map(depot => depot.id));
  // Removing a depot from the active directory must not erase its saved history.
  const values = new Map(Object.entries(previous?.oilDepotDistancesKm ?? {}).filter(([id]) => !depotIds.has(id)));
  for (const [id, value] of Object.entries(raw)) {
    if (!depotIds.has(id)) {
      if (previous?.oilDepotDistancesKm && Object.hasOwn(previous.oilDepotDistancesKm, id) && previous.oilDepotDistancesKm[id] === value) continue;
      throw new ApiError(400, 'Выберите нефтебазу из справочника для расстояния.');
    }
    if (typeof value === 'string' && !value.trim()) continue;
    if (typeof value !== 'string' && typeof value !== 'number') throw new ApiError(400, 'Расстояние должно быть числом от 0 до 100 000 км или пустым полем.');
    const text = String(value).trim().replace(',', '.');
    if (text.length > 32 || !/^\d+(?:\.\d+)?$/.test(text) || !Number.isFinite(Number(text)) || Number(text) > 100000) throw new ApiError(400, 'Расстояние должно быть числом от 0 до 100 000 км или пустым полем.');
    // Keep decimal notation stable without rounding user-entered fractions.
    const normalized = text.replace(/^0+(?=\d)/, '').replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
    values.set(id, normalized);
  }
  return values.size ? Object.fromEntries([...values].sort(([left], [right]) => left.localeCompare(right))) : undefined;
}

export function sameDeliveryDistances(left: ShipmentAddress['oilDepotDistancesKm'], right: ShipmentAddress['oilDepotDistancesKm']) {
  const keys = Object.keys(left ?? {});
  return keys.length === Object.keys(right ?? {}).length && keys.every(key => left![key] === right?.[key]);
}

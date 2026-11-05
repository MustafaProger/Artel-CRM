import Decimal from 'decimal.js';
import type { TripRequest } from '../web/src/trip-request-model';
import type { Shipment, Snapshot } from '../web/src/model';
import { calculateTransportPrice, transportAddressMatches, readTransportPriceSnapshot, readTransportPricing, readTransportSectionIndexes } from '../web/src/transport-pricing';
import { ApiError } from './api-error';

export const transportPricingFields = ['transport_pricing_mode', 'transport_section_indexes', 'transport_price_snapshot'] as const;
type Fields = Record<string, string | null>;
type Customer = { fields: Fields; previous?: Shipment; pricingRequest?: TripRequest };
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)])) : value;
const identical = (a: unknown, b: unknown) => JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
const numericSame = (a: string | null | undefined, b: string | null | undefined) => {
  try { return !!a && !!b && new Decimal(a.replace(/\s/g, '').replace(',', '.')).eq(b); } catch { return a === b; }
};
const indexes = (value: string | null | undefined) => {
  try { return readTransportSectionIndexes(value); } catch { throw new ApiError(400, 'Проверьте назначение секций автомобиля.'); }
};

/** Validate the whole allocation before storing anything. Historical quotes use
 * their saved prices; only an explicitly supplied new quote reads current rates. */
export function prepareTripTransportPricing(snapshot: Snapshot, shared: Fields, customers: Customer[]) {
  const selected = customers.map(({ fields, previous }) => indexes(Object.hasOwn(fields, 'transport_section_indexes') ? fields.transport_section_indexes : previous?.fields.transport_section_indexes));
  const modes = customers.map(({ fields, previous }) => fields.transport_pricing_mode ?? previous?.fields.transport_pricing_mode);
  for (const [position, customer] of customers.entries()) {
    const input = customer.fields, previous = customer.previous?.fields;
    const effective = { ...previous, ...shared, ...input };
    const explicitMode = input.transport_pricing_mode;
    if (explicitMode != null && !['auto', 'manual'].includes(explicitMode)) throw new ApiError(400, 'Выберите автоматическую или ручную сумму перевозки.');
    const oldQuote = readTransportPriceSnapshot(previous?.transport_price_snapshot);
    const contextSame = !!previous && ['vehicle_id', 'oil_depot_id', 'customer_id', 'unloading_address_id'].every(key => effective[key] === previous[key]) && numericSame(effective.quantity_litres, previous.quantity_litres) && identical(selected[position], indexes(previous.transport_section_indexes));
    const amountSame = !!previous && numericSame(effective.transport_amount, previous.transport_amount);
    // Older clients do not know these optional fields. Preserve historical
    // metadata only while the actual price inputs and amount are untouched.
    if (explicitMode == null) {
      if (previous?.transport_pricing_mode && contextSame && amountSame) {
        for (const key of transportPricingFields) input[key] = previous[key] ?? null;
      } else if (previous?.transport_pricing_mode) {
        input.transport_pricing_mode = 'manual'; input.transport_price_snapshot = null;
        input.transport_section_indexes = shared.vehicle_id !== previous.vehicle_id ? null : previous.transport_section_indexes ?? null;
      } else if (input.transport_price_snapshot || input.transport_section_indexes) throw new ApiError(400, 'Для назначения секций укажите способ расчёта перевозки.');
      continue;
    }
    if (explicitMode === 'manual') {
      if (!input.transport_amount?.trim()) throw new ApiError(400, 'Укажите сумму перевозки вручную. Пустая сумма не заменяется нулём.');
      if (input.transport_price_snapshot) throw new ApiError(400, 'Ручная сумма не может содержать автоматический расчёт.');
      const vehicle = snapshot.directories!.vehicles.find(row => row.id === effective.vehicle_id);
      // Optional assignments describe the saved truck configuration. Changing a
      // catalog must not block an unchanged manual row or an explicit override
      // of its old automatic amount; new assignments still use today's vehicle.
      const sameAssignment = !!previous && effective.vehicle_id === previous.vehicle_id && identical(selected[position], indexes(previous.transport_section_indexes));
      if (!sameAssignment && selected[position].some(index => index >= (vehicle?.compartmentsLitres?.length ?? 0))) throw new ApiError(400, 'Проверьте назначение секций выбранного автомобиля.');
      input.transport_price_snapshot = null;
      input.transport_section_indexes = selected[position].length ? JSON.stringify(selected[position]) : null;
      continue;
    }
    if (customers.some((other, otherPosition) => otherPosition !== position && (other.fields.customer_id ?? other.previous?.fields.customer_id) === effective.customer_id)) throw new ApiError(400, 'Один клиент указан в нескольких доставках. Доплата и расстояние для такого случая не согласованы: введите суммы вручную.');
    const overlaps = selected[position].filter(index => selected.some((other, otherPosition) => otherPosition !== position && other.includes(index)));
    if (overlaps.length) throw new ApiError(400, 'Секция назначена нескольким доставкам. Распределение стоимости не задано: укажите отдельные секции или ручные суммы.');
    const supplied = readTransportPriceSnapshot(input.transport_price_snapshot);
    if (input.transport_price_snapshot && !supplied) throw new ApiError(400, 'Некорректный сохранённый расчёт перевозки.');
    if (previous?.transport_pricing_mode === 'auto' && oldQuote && contextSame && amountSame && (!input.transport_price_snapshot || identical(supplied, oldQuote))) {
      input.transport_price_snapshot = previous.transport_price_snapshot;
      input.transport_section_indexes = previous.transport_section_indexes;
      continue;
    }
    if (oldQuote && previous?.transport_pricing_mode === 'auto' && !supplied) throw new ApiError(409, 'Для изменения сохранённой суммы явно обновите расчёт или выберите ручной ввод.');
    const address = snapshot.directories!.addresses.find(row => row.id === effective.unloading_address_id);
    // Existing trip locations are frozen by prepareShipmentFields. Repricing
    // the same directory ID must use that actual route, even for non-request
    // trips, instead of charging for a subsequently edited catalog location.
    const sameAddress = !!previous && effective.unloading_address_id === previous.unloading_address_id;
    const actual = sameAddress ? { address: previous.unloading_address, latitude: previous.unloading_latitude, longitude: previous.unloading_longitude, locationSnapshot: customer.pricingRequest?.locationSnapshot } : customer.pricingRequest;
    if (!transportAddressMatches(address, actual)) throw new ApiError(400, 'Адрес или точка доставки в заявке отличаются от справочника. Подтверждённого расстояния для этой доставки нет: введите сумму перевозки вручную.');
    const oilDepot = snapshot.directories!.oilDepots?.find(row => row.id === effective.oil_depot_id);
    if (previous && effective.oil_depot_id === previous.oil_depot_id && !transportAddressMatches(oilDepot, { address: previous.loading_address, latitude: previous.loading_latitude, longitude: previous.loading_longitude })) throw new ApiError(400, 'Сохранённое место погрузки отличается от текущей нефтебазы в справочнике. Подтверждённого расстояния для этого маршрута нет: введите сумму перевозки вручную.');
    const calculated = calculateTransportPrice({
      vehicle: snapshot.directories!.vehicles.find(row => row.id === effective.vehicle_id),
      oilDepot,
      address,
      customerId: effective.customer_id, quantityLitres: effective.quantity_litres ?? undefined,
      compartmentIndexes: selected[position], settings: readTransportPricing(snapshot.directories!.transportPricing),
    });
    if (!calculated.ok) throw new ApiError(400, `Клиент ${position + 1}: ${calculated.errors.join(' ')}`);
    if (supplied && !identical(supplied, calculated.snapshot) || !numericSame(effective.transport_amount, calculated.snapshot.totalRub)) throw new ApiError(409, 'Исходные данные или тарифы перевозки изменились. Обновите расчёт и проверьте сумму перед сохранением.');
    input.transport_amount = calculated.snapshot.totalRub;
    input.transport_section_indexes = JSON.stringify(selected[position]);
    input.transport_price_snapshot = JSON.stringify(calculated.snapshot);
  }
  // An omitted mode can preserve an old auto quote; conflicts still must not be
  // introduced by another row switching its manual section allocation. Inspect
  // the resolved values: legacy normalization may restore prior assignments.
  const resolvedSections = customers.map(({ fields, previous }) => indexes(Object.hasOwn(fields, 'transport_section_indexes') ? fields.transport_section_indexes : previous?.fields.transport_section_indexes));
  for (const [position, customer] of customers.entries()) if ((customer.fields.transport_pricing_mode ?? modes[position]) === 'auto') {
    if (resolvedSections[position].some(index => resolvedSections.some((other, otherPosition) => otherPosition !== position && other.includes(index)))) throw new ApiError(400, 'Секция назначена нескольким доставкам. Автоматический расчёт неполон.');
    const customerId = customer.fields.customer_id ?? customer.previous?.fields.customer_id;
    if (customers.some((other, otherPosition) => otherPosition !== position && (other.fields.customer_id ?? other.previous?.fields.customer_id) === customerId)) throw new ApiError(400, 'Один клиент указан в нескольких доставках. Введите суммы перевозки вручную.');
  }
}

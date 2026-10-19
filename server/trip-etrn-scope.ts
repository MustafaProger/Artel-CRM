import Decimal from 'decimal.js';
import type { ShipmentTrip, Snapshot } from '../web/src/model';
import { requiresEtrn } from '../web/src/trip-etrn-scope';
import { ApiError } from './api-error';
export { requiresEtrn } from '../web/src/trip-etrn-scope';
export const ETRN_NOT_REQUIRED = 'Для всех клиентов рейса выбрано «ЭТрН не нужна». Задание водителя выполняется в CRM.';
export function requireEtrnDelivery(trip: ShipmentTrip, shipmentId: string): void {
  const delivery = trip.customers.find(row => row.id === shipmentId);
  if (!delivery) throw new ApiError(404, 'Доставка не найдена в этом рейсе.');
  if (!requiresEtrn(delivery)) throw new ApiError(409, 'Для этой доставки выбрано «ЭТрН не нужна». Передача в Saby отключена.');
}
/** Restrict external document data only. Never repartition a truck's mass across fewer recipients. */
export function etrnTrip(source: Snapshot, trip: ShipmentTrip): ShipmentTrip {
  const customers = trip.customers.filter(requiresEtrn);
  if (customers.length === trip.customers.length) return trip;
  const persisted = trip.fields.trip_flow_version === 'driver-v1' ? customers : customers.map(customer => source.shipments.find(row => row.id === customer.id));
  const total = (key: string): string | null => persisted.length && persisted.every(row => /^\d+(?:\.\d+)?$/.test(row?.fields[key] || '') && new Decimal(row!.fields[key]!).gt(0))
    ? persisted.reduce((sum, row) => sum.plus(row!.fields[key]!), new Decimal(0)).toFixed() : null;
  return { ...trip, fields: { ...trip.fields, quantity_tonnes: total('quantity_tonnes'), quantity_gross_tonnes: trip.fields.trip_flow_version === 'driver-v1' ? total('quantity_gross_tonnes') : null }, customers };
}

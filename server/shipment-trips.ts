import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Shipment, ShipmentTrip, ShipmentTripResponse, Snapshot } from '../web/src/model';
import { allocateTrip } from '../web/src/trip-calculations';
import { ApiError } from './api-error';
import type { OperationsData } from './operations-store';
import { allocateShipmentNumber } from './shipment-numbering';
import { currentSnapshot, prepareShipmentFields } from './shipment-operations';

const sharedFields = ['date', 'supplier_id', 'purchase_price_unspecified_unit', 'quantity_tonnes', 'product_id', 'driver_id', 'vehicle_id', 'loading_address_id', 'additional_costs'] as const;
const customerFields = ['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const pick = (fields: Record<string, string | null>, keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, fields[key] ?? null]));

function checkTripVersions(versions: unknown, rows: Shipment[]) {
  if (!object(versions) || Object.values(versions).some(version => !Number.isSafeInteger(version) || Number(version) < 0)) throw new ApiError(400, 'Передайте версии всех клиентов отгрузки.');
  if (Object.keys(versions).length !== rows.length || rows.some(row => versions[row.id] !== (row.version ?? 0))) throw new ApiError(409, 'Состав или данные отгрузки уже изменены в другом окне. Обновите отгрузку и повторите изменение.');
}

function tombstone(data: OperationsData, row: Shipment, now: string) {
  const fields = { ...row.fields };
  delete fields.driver_name; delete fields.vehicle_plate;
  data.shipments[row.id] = { fields, version: (row.version ?? 0) + 1, createdAt: row.createdAt ?? now, updatedAt: now, deleted: true };
}

function inputFields(value: unknown, keys: readonly string[]): Record<string, string | null> {
  if (!object(value)) throw new ApiError(400, 'Укажите поля машины и каждого клиента.');
  const fields: Record<string, string | null> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (!keys.includes(key)) throw new ApiError(400, `Неизвестное поле отгрузки: ${key}.`);
    if (raw !== null && typeof raw !== 'string') throw new ApiError(400, `Поле ${key} должно быть строкой или null.`);
    if (typeof raw === 'string' && raw.length > 4000) throw new ApiError(400, `Поле ${key} слишком длинное.`);
    fields[key] = typeof raw === 'string' ? raw.trim() || null : null;
  }
  return fields;
}

export function getShipmentTrip(snapshot: Snapshot, id: string): ShipmentTrip {
  const rows = snapshot.shipments.filter(row => row.fields.trip_id === id);
  if (!rows.length) throw new ApiError(404, 'Отгрузка машины не найдена.');
  const fields = pick(rows[0].fields, sharedFields);
  fields.quantity_tonnes = rows[0].fields.trip_total_tonnes;
  fields.additional_costs = rows[0].fields.trip_additional_costs;
  return {
    id, fields,
    customers: rows.map(row => ({ id: row.id, version: row.version ?? 0, paidAmount: row.fields.paid_amount_source, fields: pick(row.fields, customerFields) })),
  };
}

/** Called inside OperationsStore.mutate; no row is persisted until the complete truck validates. */
export function saveShipmentTrip(base: Snapshot, data: OperationsData, body: Record<string, unknown>, existingId?: string): ShipmentTripResponse {
  if (Object.keys(body).some(key => !['fields', 'customers', ...(existingId ? ['versions'] : [])].includes(key))) throw new ApiError(400, 'В запросе отгрузки есть неизвестные параметры.');
  const snapshot = currentSnapshot(base, data);
  const id = existingId ?? `shipment-trip-${randomUUID()}`;
  const previousRows = existingId ? snapshot.shipments.filter(row => row.fields.trip_id === id) : [];
  if (existingId && !previousRows.length) throw new ApiError(404, 'Отгрузка машины не найдена.');
  if (existingId) checkTripVersions(body.versions, previousRows);
  const fields = inputFields(body.fields, sharedFields);
  if (!fields.driver_id) throw new ApiError(400, 'Выберите водителя.');
  if (!Array.isArray(body.customers) || !body.customers.length || body.customers.length > 100) throw new ApiError(400, 'Добавьте от 1 до 100 клиентов.');
  const customers = body.customers.map(value => {
    if (!object(value) || Object.keys(value).some(key => !['id', 'fields'].includes(key))) throw new ApiError(400, 'Некорректные данные клиента отгрузки.');
    if (value.id !== undefined && (typeof value.id !== 'string' || !value.id)) throw new ApiError(400, 'Некорректный идентификатор клиента отгрузки.');
    const previous = value.id ? previousRows.find(row => row.id === value.id) : undefined;
    if (value.id && !previous) throw new ApiError(400, 'Клиент не принадлежит этой отгрузке.');
    return { previous, fields: inputFields(value.fields, customerFields) };
  });
  const retainedIds = customers.flatMap(customer => customer.previous ? [customer.previous.id] : []);
  if (new Set(retainedIds).size !== retainedIds.length) throw new ApiError(400, 'Одна строка клиента указана несколько раз.');
  const removed = previousRows.filter(row => !retainedIds.includes(row.id));
  if (removed.some(row => data.paymentAllocations?.some(allocation => allocation.shipmentId === row.id))) throw new ApiError(409, 'Нельзя удалить клиента с привязанными банковскими платежами. Сначала отмените привязку платежей.');
  for (const customer of customers) {
    if (customer.previous && Object.hasOwn(customer.fields, 'customer_id') && customer.fields.customer_id !== customer.previous.customerId && data.paymentAllocations?.some(allocation => allocation.shipmentId === customer.previous!.id)) throw new ApiError(409, 'Нельзя заменить клиента с привязанными банковскими платежами. Сначала отмените привязку платежей.');
  }
  let allocation: ReturnType<typeof allocateTrip>;
  try { allocation = allocateTrip(fields.quantity_tonnes ?? '', customers.map(customer => customer.fields.quantity_litres ?? ''), fields.additional_costs ?? '0'); }
  catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'Некорректная разбивка отгрузки.'); }
  const exact = Decimal.clone({ precision: 100 });
  const totalTonnes = allocation.tonnes.reduce((sum, value) => sum.plus(value), new exact(0)).toFixed();
  const totalCosts = allocation.additionalCosts.reduce((sum, value) => sum.plus(value), new exact(0)).toFixed();
  const prepared = customers.map((customer, index) => {
    const input = { ...fields, ...customer.fields, purchase_unit: 'tonnes', quantity_tonnes: allocation.tonnes[index], additional_costs: allocation.additionalCosts[index] };
    const result = prepareShipmentFields(input, customer.previous, snapshot);
    result.trip_id = id;
    result.trip_total_tonnes = totalTonnes;
    result.trip_additional_costs = totalCosts;
    return { previous: customer.previous, fields: result };
  });
  const now = new Date().toISOString();
  const shipmentIds: string[] = [];
  for (const row of prepared) {
    const shipmentId = row.previous?.id ?? `shipment-local-${randomUUID()}`;
    if (!row.previous) row.fields.document_number = allocateShipmentNumber(data, row.fields.date!);
    data.shipments[shipmentId] = { fields: row.fields, version: (row.previous?.version ?? 0) + 1, createdAt: row.previous?.createdAt ?? now, updatedAt: now };
    shipmentIds.push(shipmentId);
  }
  for (const row of removed) tombstone(data, row, now);
  const updated = currentSnapshot(base, data);
  const rowsById = new Map(updated.shipments.map(row => [row.id, row]));
  const shipments = shipmentIds.map(id => rowsById.get(id) as Shipment);
  return { trip: getShipmentTrip(updated, id), shipments, shipment: shipments[0] };
}

/** Remove the whole truck under the same lock and full customer-version guard as editing. */
export function deleteShipmentTrip(base: Snapshot, data: OperationsData, body: Record<string, unknown>, id: string): { deleted: true; id: string; deletedCount: number } {
  if (Object.keys(body).some(key => key !== 'versions')) throw new ApiError(400, 'В запросе удаления есть неизвестные параметры.');
  const rows = currentSnapshot(base, data).shipments.filter(row => row.fields.trip_id === id);
  if (!rows.length) throw new ApiError(404, 'Отгрузка машины не найдена.');
  checkTripVersions(body.versions, rows);
  if (rows.some(row => data.paymentAllocations?.some(allocation => allocation.shipmentId === row.id))) throw new ApiError(409, 'Нельзя удалить отгрузку с привязанными банковскими платежами. Сначала отмените привязку платежей у всех клиентов.');
  const now = new Date().toISOString();
  for (const row of rows) tombstone(data, row, now);
  return { deleted: true, id, deletedCount: rows.length };
}

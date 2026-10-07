import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Shipment, ShipmentTrip, ShipmentTripResponse, Snapshot } from '../web/src/model';
import { allocateTrip, allocateMeasuredTrip } from '../web/src/trip-calculations';
import { ApiError } from './api-error';
import type { OperationsData } from './operations-store';
import { allocateShipmentNumber } from './shipment-numbering';
import { queueTripAssignment } from './push';
import { currentSnapshot, prepareShipmentFields } from './shipment-operations';
import { hasSabyDocuments } from './saby-service';
import { isUnpackagedDiesel, validLoadingDate } from '../web/src/trip-input-rules';
import { readIntermediateStops } from '../web/src/trip-route';

const sharedFields = ['trip_flow_version', 'organization_id', 'date', 'supplier_id', 'oil_depot_id', 'carrier_id', 'purchase_price_unspecified_unit', 'quantity_tonnes', 'quantity_gross_tonnes', 'product_id', 'driver_id', 'vehicle_id', 'loading_address_id', 'additional_costs', 'trip_notes', 'loading_planned_at', 'loading_actual_at', 'intermediate_stops_in_order'] as const;
const customerFields = ['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id', 'delivery_notes', 'invoice_not_required', 'unloading_planned_at', 'unloading_actual_at', 'intermediate_stops_after'] as const;
const sharedSnapshots = ['loading_address', 'loading_map_url', 'loading_latitude', 'loading_longitude'] as const;
const customerSnapshots = ['unloading_address', 'unloading_map_url', 'unloading_latitude', 'unloading_longitude'] as const;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const pick = (fields: Record<string, string | null>, keys: readonly string[]) => Object.fromEntries(keys.map(key => [key, fields[key] ?? null]));

export function checkTripVersions(versions: unknown, rows: Shipment[]) {
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
  const rows = snapshot.shipments.filter(row => row.fields.trip_id === id).sort((a, b) => Number(a.fields.trip_delivery_order ?? 0) - Number(b.fields.trip_delivery_order ?? 0));
  if (!rows.length) throw new ApiError(404, 'Отгрузка машины не найдена.');
  const fields = pick(rows[0].fields, [...sharedFields, ...sharedSnapshots]);
  fields.quantity_tonnes = rows[0].fields.trip_total_tonnes;
  fields.additional_costs = rows[0].fields.trip_additional_costs;
  return {
    id, fields,
    customers: rows.map(row => ({ id: row.id, version: row.version ?? 0, paidAmount: row.fields.paid_amount_source, fields: pick(row.fields, [...customerFields, ...customerSnapshots, ...(fields.trip_flow_version === 'driver-v1' ? ['quantity_tonnes', 'quantity_gross_tonnes'] : [])]) })),
  };
}

/** Called inside OperationsStore.mutate; no row is persisted until the complete truck validates. */
export function saveShipmentTrip(base: Snapshot, data: OperationsData, body: Record<string, unknown>, existingId?: string, actorId: string | null = null): ShipmentTripResponse {
  if (Object.keys(body).some(key => !['fields', 'customers', ...(existingId ? ['versions'] : ['idempotencyKey'])].includes(key))) throw new ApiError(400, 'В запросе отгрузки есть неизвестные параметры.');
  // Save only baseline inputs; the response below adds the current bank projection.
  const snapshot = currentSnapshot(base, data, false);
  const key = body.idempotencyKey;
  if (key !== undefined && (typeof key !== 'string' || !/^[a-f0-9-]{36}$/.test(key))) throw new ApiError(400, 'Некорректный ключ сохранения рейса.');
  const fingerprint = createHash('sha256').update(JSON.stringify(canonical({ fields: body.fields, customers: body.customers }))).digest('hex');
  const replay = typeof key === 'string' ? data.tripCreateRequests?.[key] : undefined;
  if (replay) {
    if (replay.fingerprint !== fingerprint || replay.actorId !== actorId) throw new ApiError(409, 'Этот ключ уже использован для другого сохранения. Откройте список рейсов.');
    const current = currentSnapshot(base, data);
    const shipments = current.shipments.filter(row => row.fields.trip_id === replay.tripId);
    if (!shipments.length) throw new ApiError(409, 'Созданный рейс уже удалён. Повторное создание по прежнему запросу запрещено.');
    return { trip: getShipmentTrip(current, replay.tripId), shipments, shipment: shipments[0] };
  }
  const id = existingId ?? `shipment-trip-${randomUUID()}`;
  const previousRows = existingId ? snapshot.shipments.filter(row => row.fields.trip_id === id) : [];
  if (existingId && !previousRows.length) throw new ApiError(404, 'Отгрузка машины не найдена.');
  if (existingId && hasSabyDocuments(data, existingId)) throw new ApiError(409, 'Рейс уже передаётся или сохранён в Saby. Изменение отправленных данных требует отдельной сверки документа.');
  if (existingId) checkTripVersions(body.versions, previousRows);
  if (existingId && data.driverTripProgress?.[existingId]?.arrivedAt) throw new ApiError(409, 'Водитель уже зафиксировал прибытие. Состав рейса и факты защищены от изменения.');
  const cleanSnapshots = (raw: unknown, keys: readonly string[], previous?: Shipment) => {
    if (!object(raw)) return raw;
    const copy = { ...raw };
    for (const key of keys) {
      if (Object.hasOwn(copy, key) && copy[key] !== null && copy[key] !== (previous?.fields[key] ?? null)) throw new ApiError(400, 'Адрес и карта сохраняются из выбранного места справочника.');
      delete copy[key];
    }
    return copy;
  };
  const fields = inputFields(cleanSnapshots(body.fields, sharedSnapshots, previousRows[0]), [...sharedFields, 'loading_at']);
  const flowVersion = fields.trip_flow_version ?? previousRows[0]?.fields.trip_flow_version ?? null;
  if (flowVersion !== null && flowVersion !== 'driver-v1' || previousRows.length && flowVersion !== (previousRows[0].fields.trip_flow_version ?? null)) throw new ApiError(400, 'Сценарий существующего рейса изменять нельзя.');
  const driverFlow = flowVersion === 'driver-v1';
  if (driverFlow) {
    for (const key of ['quantity_tonnes', 'quantity_gross_tonnes', 'loading_actual_at']) if (fields[key] != null) throw new ApiError(400, 'Массу и фактические события сохраняет назначенный водитель.');
    fields.trip_flow_version = flowVersion;
    fields.quantity_tonnes = previousRows[0]?.fields.trip_total_tonnes ?? null;
    fields.quantity_gross_tonnes = null;
  }
  for (const key of ['trip_notes', 'loading_planned_at', 'loading_actual_at', 'intermediate_stops_in_order', 'quantity_gross_tonnes', 'oil_depot_id', 'carrier_id']) {
    if (!Object.hasOwn(fields, key) && previousRows.length) fields[key] = previousRows[0].fields[key] ?? null;
  }
  // An older client may omit this new shared input while adding a customer.
  // Preserve the explicit trip identity for every row rather than creating a mixed trip.
  if (!Object.hasOwn(fields, 'organization_id') && previousRows.length) fields.organization_id = previousRows[0].fields.organization_id ?? null;
  if (fields.loading_address_id && !fields.oil_depot_id && (!previousRows.length || fields.loading_address_id !== previousRows[0].fields.loading_address_id)) throw new ApiError(400, 'Для места погрузки выберите нефтебазу. Адрес поставщика сохраняется только в историческом рейсе.');
  if (fields.intermediate_stops_in_order && !['true', 'false'].includes(fields.intermediate_stops_in_order)) throw new ApiError(400, 'Укажите, включать ли промежуточные остановки в заявку.');
  // The unified input is an explicit edit. Old clients and untouched historical
  // plan/fact values retain their original distinct values.
  const loadingAt = fields.loading_at;
  if (Object.hasOwn(fields, 'loading_at')) {
    if (!loadingAt || !validLoadingDate(loadingAt) || driverFlow && !loadingAt.includes('T')) throw new ApiError(400, 'Укажите корректную дату отгрузки / погрузки.');
    fields.date = loadingAt.slice(0, 10);
    fields.loading_planned_at = loadingAt;
    if (!driverFlow && !previousRows.length) fields.loading_actual_at = loadingAt;
    delete fields.loading_at;
  } else if (!previousRows.length && fields.date && !driverFlow) {
    fields.loading_planned_at ||= fields.date;
    fields.loading_actual_at ||= fields.loading_planned_at;
  }
  if (driverFlow && (!fields.loading_planned_at?.includes('T') || !validLoadingDate(fields.loading_planned_at))) throw new ApiError(400, 'Укажите плановую дату и время рейса.');
  // Retain historical legal company links without treating them as fleet filters
  // when the ordinary workflow changes only the actual driver or vehicle.
  const carrierSelectionChanged = (fields.carrier_id ?? null) !== (previousRows[0]?.fields.carrier_id ?? null);
  const carrier = fields.carrier_id ? snapshot.companies.find(row => row.id === fields.carrier_id && row.roles.includes('carrier') && !row.directoryArchived) : undefined;
  if (carrierSelectionChanged && fields.carrier_id && !carrier) throw new ApiError(400, 'Выберите действующего перевозчика из справочника.');
  if (carrierSelectionChanged && carrier) {
    const candidates = snapshot.directories!;
    for (const [key, rows, defaultId, label] of [
      ['driver_id', candidates.drivers, carrier.defaultDriverId, 'водителя'],
      ['vehicle_id', candidates.vehicles, carrier.defaultVehicleId, 'автомобиль'],
    ] as const) {
      const allowed = rows.filter(row => row.carrierId === carrier.id);
      if (fields[key] && !allowed.some(row => row.id === fields[key])) throw new ApiError(400, `Выбранный ${label} не связан с перевозчиком. Выберите допустимую запись.`);
      if (!fields[key]) fields[key] = allowed.find(row => row.id === defaultId)?.id ?? (allowed.length === 1 ? allowed[0].id : null);
      if (!fields[key]) throw new ApiError(400, `Выберите ${label} из связанных с перевозчиком записей.`);
    }
  }
  if (!fields.driver_id) throw new ApiError(400, 'Выберите водителя.');
  const product = snapshot.directories!.products.find(row => row.id === fields.product_id);
  const massChanged = !previousRows.length || fields.quantity_tonnes !== previousRows[0].fields.trip_total_tonnes || fields.product_id !== previousRows[0].fields.product_id || fields.quantity_gross_tonnes !== previousRows[0].fields.quantity_gross_tonnes;
  if (!driverFlow && isUnpackagedDiesel(product) && (massChanged || !fields.quantity_gross_tonnes)) fields.quantity_gross_tonnes = fields.quantity_tonnes;

  if (fields.quantity_gross_tonnes) {
    const gross = fields.quantity_gross_tonnes.replace(',', '.');
    if (!/^\d+(?:\.\d{1,6})?$/.test(gross) || !new Decimal(gross).gt(0)) throw new ApiError(400, 'Укажите положительную плановую массу груза в тоннах, до 6 знаков после запятой.');
    fields.quantity_gross_tonnes = new Decimal(gross).toFixed();
  }
  if (!Array.isArray(body.customers) || !body.customers.length || body.customers.length > 100) throw new ApiError(400, 'Добавьте от 1 до 100 клиентов.');
  const customers = body.customers.map(value => {
    if (!object(value) || Object.keys(value).some(key => !['id', 'fields'].includes(key))) throw new ApiError(400, 'Некорректные данные клиента отгрузки.');
    if (value.id !== undefined && (typeof value.id !== 'string' || !value.id)) throw new ApiError(400, 'Некорректный идентификатор клиента отгрузки.');
    const previous = value.id ? previousRows.find(row => row.id === value.id) : undefined;
    if (value.id && !previous) throw new ApiError(400, 'Клиент не принадлежит этой отгрузке.');
    const customer = inputFields(cleanSnapshots(value.fields, customerSnapshots, previous), customerFields);
    if (driverFlow && (customer.unloading_planned_at != null || customer.unloading_actual_at != null)) throw new ApiError(400, 'Плановое время выгрузки не задано; фактические события сохраняет водитель.');
    if (!Object.hasOwn(customer, 'intermediate_stops_after') && previous) customer.intermediate_stops_after = previous.fields.intermediate_stops_after ?? null;
    try { if (customer.intermediate_stops_after) customer.intermediate_stops_after = JSON.stringify(readIntermediateStops(customer.intermediate_stops_after)); }
    catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'Проверьте промежуточные остановки.'); }
    for (const key of ['unloading_planned_at', 'unloading_actual_at']) {
      if (!Object.hasOwn(customer, key) && previous) customer[key] = previous.fields[key] ?? null;
      // Default only a new delivery. Null in an existing record may be an intentional manual clearing.
      if (!driverFlow && !previous && !Object.hasOwn(customer, key)) customer[key] = loadingAt ?? fields.loading_planned_at ?? fields.date ?? null;
    }
    return { previous, fields: customer };
  });
  const retainedIds = customers.flatMap(customer => customer.previous ? [customer.previous.id] : []);
  if (new Set(retainedIds).size !== retainedIds.length) throw new ApiError(400, 'Одна строка клиента указана несколько раз.');
  const removed = previousRows.filter(row => !retainedIds.includes(row.id));
  if (removed.some(row => data.paymentAllocations?.some(allocation => allocation.shipmentId === row.id))) throw new ApiError(409, 'Нельзя удалить клиента с привязанными банковскими платежами. Сначала отмените привязку платежей.');
  for (const customer of customers) {
    if (customer.previous && Object.hasOwn(customer.fields, 'customer_id') && customer.fields.customer_id !== customer.previous.customerId && data.paymentAllocations?.some(allocation => allocation.shipmentId === customer.previous!.id)) throw new ApiError(409, 'Нельзя заменить клиента с привязанными банковскими платежами. Сначала отмените привязку платежей.');
  }
  let allocation: { tonnes: (string | null)[]; additionalCosts: string[] };
  try { allocation = driverFlow
    ? allocateMeasuredTrip(customers.map(customer => customer.previous?.fields.quantity_tonnes ?? null), customers.map(customer => customer.fields.quantity_litres ?? ''), fields.additional_costs ?? '0')
    : allocateTrip(fields.quantity_tonnes ?? '', customers.map(customer => customer.fields.quantity_litres ?? ''), fields.additional_costs ?? '0'); }
  catch (error) { throw new ApiError(400, error instanceof Error ? error.message : 'Некорректная разбивка отгрузки.'); }
  const exact = Decimal.clone({ precision: 100 });
  const totalTonnes = allocation.tonnes[0] === null ? null : allocation.tonnes.reduce((sum, value) => sum.plus(value!), new exact(0)).toFixed();
  const totalCosts = allocation.additionalCosts.reduce((sum, value) => sum.plus(value), new exact(0)).toFixed();
  const prepared = customers.map((customer, index) => {
    const input: Record<string, string | null> = { ...fields, ...customer.fields, purchase_unit: 'tonnes', quantity_tonnes: allocation.tonnes[index], ...(driverFlow ? { quantity_gross_tonnes: allocation.tonnes[index] } : {}), additional_costs: allocation.additionalCosts[index] };
    delete input.trip_flow_version;
    const result = prepareShipmentFields(input, customer.previous, snapshot, { historicalCarrierId: previousRows[0]?.fields.carrier_id, allowMissingMass: driverFlow });
    if (driverFlow) result.trip_flow_version = 'driver-v1';
    if (previousRows.length && previousRows[0].fields.loading_address_id === result.loading_address_id && previousRows[0].fields.oil_depot_id === result.oil_depot_id) {
      for (const key of sharedSnapshots) if (!result.oil_depot_id || previousRows[0].fields[key]) result[key] = previousRows[0].fields[key] ?? null;
    }
    result.trip_id = id;
    result.trip_delivery_order = String(index + 1);
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
  if (typeof key === 'string') (data.tripCreateRequests ??= {})[key] = { tripId: id, fingerprint, actorId };
  const updated = currentSnapshot(base, data);
  const rowsById = new Map(updated.shipments.map(row => [row.id, row]));
  const shipments = shipmentIds.map(id => rowsById.get(id) as Shipment);
  queueTripAssignment(data, id, shipments, previousRows);
  return { trip: getShipmentTrip(updated, id), shipments, shipment: shipments[0] };
}

/** Remove the whole truck under the same lock and full customer-version guard as editing. */
export function deleteShipmentTrip(base: Snapshot, data: OperationsData, body: Record<string, unknown>, id: string): { deleted: true; id: string; deletedCount: number } {
  if (hasSabyDocuments(data, id)) throw new ApiError(409, 'Рейс связан с документами Saby. Удаление запрещено до сверки документов.');
  if (Object.keys(body).some(key => key !== 'versions')) throw new ApiError(400, 'В запросе удаления есть неизвестные параметры.');
  const rows = currentSnapshot(base, data, false).shipments.filter(row => row.fields.trip_id === id);
  if (!rows.length) throw new ApiError(404, 'Отгрузка машины не найдена.');
  checkTripVersions(body.versions, rows);
  if (rows.some(row => data.paymentAllocations?.some(allocation => allocation.shipmentId === row.id))) throw new ApiError(409, 'Нельзя удалить отгрузку с привязанными банковскими платежами. Сначала отмените привязку платежей у всех клиентов.');
  const now = new Date().toISOString();
  for (const row of rows) tombstone(data, row, now);
  if (data.push?.tripAssignments) delete data.push.tripAssignments[id];
  return { deleted: true, id, deletedCount: rows.length };
}

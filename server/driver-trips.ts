import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import type { AccountUser } from '../web/src/auth-model';
import type { Shipment, Snapshot } from '../web/src/model';
import { ApiError } from './api-error';
import type { OperationsData } from './operations-store';
import { currentSnapshot } from './shipment-operations';
import { checkTripVersions } from './shipment-trips';

const Exact = Decimal.clone({ precision: 100 });
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const rowVersions = (rows: Shipment[]) => Object.fromEntries(rows.map(row => [row.id, row.version ?? 0]));
const sameVersions = (value: unknown, expected: Record<string, number>) => object(value) && Object.keys(value).length === Object.keys(expected).length && Object.entries(expected).every(([id, version]) => value[id] === version);
const compositionHash = (rows: Shipment[]) => createHash('sha256').update(JSON.stringify([...rows].sort((a, b) => a.id.localeCompare(b.id)).map(row => [row.id, ...['trip_flow_version', 'driver_id', 'vehicle_id', 'customer_id', 'unloading_address_id', 'unloading_address', 'product_id', 'quantity_litres', 'oil_depot_id', 'loading_address', 'loading_planned_at'].map(key => row.fields[key] ?? null)]))).digest('hex');
const moscowLocal = (value: string) => new Date(Date.parse(value) + 3 * 3600_000).toISOString().slice(0, 19);

function ownedTrips(snapshot: Snapshot, actor: AccountUser) {
  if (actor.role !== 'driver' || !actor.driverId || !snapshot.directories?.drivers.some(row => row.id === actor.driverId)) throw new ApiError(403, 'Доступен только кабинет назначенного водителя.');
  const grouped = new Map<string, Shipment[]>();
  for (const row of snapshot.shipments) if (row.fields.trip_id) {
    const rows = grouped.get(row.fields.trip_id) ?? []; rows.push(row); grouped.set(row.fields.trip_id, rows);
  }
  return [...grouped].filter(([, rows]) => rows.every(row => row.fields.driver_id === actor.driverId));
}

/** Keep this projection explicit. Shipment.fields contains financial and legal metadata. */
function projectTrip(snapshot: Snapshot, id: string, rows: Shipment[], actor: AccountUser, data?: OperationsData) {
  const first = rows[0], fields = first.fields;
  const driver = snapshot.directories?.drivers.find(row => row.id === actor.driverId);
  const progress = data?.driverTripProgress?.[id];
  // Only the workflow's terminal evidence can archive. Its legacy `completed` phase means drafts exist.
  const workflow = data?.tripSaby?.trips[id];
  const completed = !!workflow?.stage6CompletedAt && workflow.phase === 'completed' && workflow.driverFlow?.state === 'ready'
    && !!progress?.departedAt && !!workflow.carrierEvidence && workflow.signing?.sender.state === 'confirmed' && workflow.signing.carrier.state === 'confirmed'
    && workflow.deliveries.length === rows.length && rows.every(row => {
      const delivery = workflow.deliveries.find(item => item.shipmentId === row.id);
      const doc = data?.etrn?.trips[id]?.deliveries[row.id]?.document;
      return !!delivery?.id && delivery.status === 'draft' && doc?.id === delivery.id && !!doc.dispatch?.completedAt
        && doc.dispatch.sender.state === 'confirmed' && doc.dispatch.carrier.state === 'confirmed';
    });
  return {
    id, date: first.date, driverName: driver?.fullName || driver?.name || actor.name,
    flowVersion: fields.trip_flow_version ?? null, versions: rowVersions(rows), archived: !!completed,
    arrivedAt: progress?.arrivedAt ?? null, departedAt: progress?.departedAt ?? null,
    vehiclePlate: fields.vehicle_plate ?? null, supplier: first.supplier,
    loadingAddress: fields.loading_address ?? null, loadingMapUrl: fields.loading_map_url ?? null,
    loadingPlannedAt: fields.trip_flow_version === 'driver-v1' ? null : fields.loading_planned_at ?? null,
    loadingActualAt: progress?.arrivedAt ?? fields.loading_actual_at ?? null, notes: fields.trip_notes ?? null,
    deliveries: [...rows].sort((a, b) => Number(a.fields.trip_delivery_order ?? 0) - Number(b.fields.trip_delivery_order ?? 0)).map(row => ({
      id: row.id, number: row.fields.document_number ?? null, customer: row.customer, product: row.product, liters: row.liters,
      netTonnes: row.fields.quantity_tonnes ?? null,
      address: row.fields.unloading_address ?? null, mapUrl: row.fields.unloading_map_url ?? null,
      plannedAt: fields.trip_flow_version === 'driver-v1' ? null : row.fields.unloading_planned_at ?? null,
      actualAt: row.fields.unloading_actual_at ?? null, notes: row.fields.delivery_notes ?? null,
    })),
  };
}
export function readDriverTrips(snapshot: Snapshot, actor: AccountUser, id?: string, query = '', data?: OperationsData) {
  const owned = ownedTrips(snapshot, actor);
  if (id) {
    const rows = owned.find(([tripId]) => tripId === id)?.[1];
    if (!rows) throw new ApiError(404, 'Рейс не найден.');
    return { trip: projectTrip(snapshot, id, rows, actor, data) };
  }
  const needle = query.trim().toLocaleLowerCase('ru-RU').slice(0, 200);
  const trips = owned.map(([tripId, rows]) => projectTrip(snapshot, tripId, rows, actor, data))
    .filter(trip => !needle || JSON.stringify(trip).toLocaleLowerCase('ru-RU').includes(needle))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id));
  return { trips, total: trips.length };
}

/** Must run within OperationsStore.mutate after fresh requireUser authentication. No external calls. */
export function recordDriverTripAction(base: Snapshot, data: OperationsData, actor: AccountUser, tripId: string, action: 'arrive' | 'depart', body: Record<string, unknown>) {
  if (Object.keys(body).some(key => !['versions', ...(action === 'depart' ? ['masses'] : [])].includes(key))) throw new ApiError(400, 'В запросе есть недоступные водителю поля.');
  const snapshot = currentSnapshot(base, data, false);
  const rows = ownedTrips(snapshot, actor).find(([id]) => id === tripId)?.[1];
  if (!rows) throw new ApiError(404, 'Рейс не найден.');
  if (rows.some(row => row.fields.trip_flow_version !== 'driver-v1')) throw new ApiError(409, 'Действия водителя доступны только новым рейсам.');
  const progress = data.driverTripProgress?.[tripId];
  const composition = compositionHash(rows);
  if (progress && (progress.driverId !== actor.driverId || progress.compositionHash !== composition)) throw new ApiError(409, 'Назначение или состав рейса изменился после прибытия. Обратитесь к логисту.');
  const response = (changed: boolean) => ({ result: readDriverTrips(currentSnapshot(base, data, false), actor, tripId, '', data), changed });
  if (action === 'arrive' && progress) {
    if (!sameVersions(body.versions, progress.arrivalVersions) && !sameVersions(body.versions, rowVersions(rows))) throw new ApiError(409, 'Рейс изменился. Обновите задание.');
    return response(false);
  }
  const masses: Record<string, string> = {};
  if (action === 'depart') {
    if (!progress) throw new ApiError(409, 'Сначала отметьте прибытие на погрузку.');
    if (!Array.isArray(body.masses) || body.masses.length !== rows.length) throw new ApiError(400, 'Укажите массу каждой доставки.');
    for (const value of body.masses) {
      if (!object(value) || Object.keys(value).some(key => !['deliveryId', 'netTonnes'].includes(key)) || typeof value.deliveryId !== 'string' || !rows.some(row => row.id === value.deliveryId) || Object.hasOwn(masses, value.deliveryId) || typeof value.netTonnes !== 'string') throw new ApiError(400, 'Передайте полный набор доставок текущего рейса.');
      const raw = value.netTonnes.trim().replace(',', '.');
      if (!/^\d{1,11}(?:\.\d{1,6})?$/.test(raw) || !new Exact(raw).gt(0)) throw new ApiError(400, 'Масса каждой доставки должна быть положительным числом в тоннах, до 6 знаков после запятой.');
      masses[value.deliveryId] = new Exact(raw).toFixed();
    }
    if (progress.departedAt) {
      if (!sameVersions(body.versions, progress.departureVersions!) && !sameVersions(body.versions, rowVersions(rows)) || rows.some(row => progress.masses?.[row.id] !== masses[row.id])) throw new ApiError(409, 'Убытие уже сохранено. Массы и события изменять нельзя.');
      return response(false);
    }
  }
  checkTripVersions(body.versions, rows);
  const now = new Date().toISOString();
  if (action === 'arrive') {
    (data.driverTripProgress ??= {})[tripId] = { driverId: actor.driverId!, compositionHash: composition, arrivedAt: now, arrivedBy: actor.id, arrivalVersions: rowVersions(rows) };
    return response(true);
  }
  if (data.etrn?.trips[tripId]?.loadingFacts || Object.values(data.etrn?.trips[tripId]?.deliveries ?? {}).some(row => row.document)) throw new ApiError(409, 'Факты или документы уже существуют. Нужна сверка логистом.');
  if (now < progress!.arrivedAt) throw new ApiError(409, 'Серверное время раньше прибытия. Повторите действие после восстановления времени.');
  const total = Object.values(masses).reduce((sum, value) => sum.plus(value), new Exact(0)).toFixed();
  for (const row of rows) {
    const previous = data.shipments[row.id];
    data.shipments[row.id] = { fields: { ...previous.fields, quantity_tonnes: masses[row.id], quantity_gross_tonnes: masses[row.id], trip_total_tonnes: total, loading_actual_at: moscowLocal(progress!.arrivedAt) }, version: previous.version + 1, createdAt: previous.createdAt, updatedAt: now };
  }
  Object.assign(progress!, { departedAt: now, departedBy: actor.id, departureVersions: rowVersions(rows), masses, continuationRequestedAt: now });
  data.etrn ??= { trips: {} };
  const etrn = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: now };
  etrn.loadingFacts = { arrivedAt: moscowLocal(progress!.arrivedAt), departedAt: moscowLocal(now), deliveries: Object.fromEntries(rows.map(row => [row.id, { grossMassTonnes: masses[row.id], massMethod: '03' }])), recordedAt: now, actorId: actor.id };
  etrn.updatedAt = now;
  return response(true);
}

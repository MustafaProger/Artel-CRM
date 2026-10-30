import { createHash } from 'node:crypto';
import type { Snapshot, Shipment } from '../web/src/model';
import { hasSection, type AccountUser } from '../web/src/auth-model';
import type { TripExecution, TripExecutionEvent } from '../web/src/trip-execution-model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { checkTripVersions } from './shipment-trips';
import { driverTripConfirmation } from './driver-trips';

export type StoredTripExecution = { composition: string; version: number; deliveries: Record<string, TripExecutionEvent>; completed: TripExecutionEvent | null };
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const fingerprint = (rows: Shipment[]) => createHash('sha256').update(JSON.stringify([...rows].sort((a,b) => a.id.localeCompare(b.id)).map(row => [row.id, ...['driver_id','vehicle_id','customer_id','unloading_address_id','unloading_address','product_id','quantity_litres'].map(key => row.fields[key] ?? null)]))).digest('hex');
export function validateTripExecutions(value: unknown): asserts value is Record<string, StoredTripExecution> | undefined {
  if (value === undefined) return;
  if (!object(value)) throw new Error('Invalid trip executions');
  const event = (v: unknown) => object(v) && typeof v.at === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v.at) && Number.isFinite(Date.parse(v.at)) && typeof v.by === 'string' && !!v.by && typeof v.name === 'string' && !!v.name && ['driver','logistics'].includes(String(v.role));
  for (const [id,row] of Object.entries(value)) {
    if (!/^shipment-trip-[a-f0-9-]+$/.test(id) || !object(row) || typeof row.composition !== 'string' || !/^[a-f0-9]{64}$/.test(row.composition) || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || !object(row.deliveries) || !Object.keys(row.deliveries).length || Object.values(row.deliveries).some(v => !event(v)) || row.completed !== null && !event(row.completed)) throw new Error('Invalid trip execution');
    if (row.completed && Object.values(row.deliveries).some(v => (v as TripExecutionEvent).at > (row.completed as TripExecutionEvent).at)) throw new Error('Invalid completion time');
  }
}
export function readTripExecution(snapshot: Snapshot, data: OperationsData, tripId: string): TripExecution {
  const rows = snapshot.shipments.filter(row => row.fields.trip_id === tripId);
  const saved = data.tripExecutions?.[tripId];
  const facts = driverTripConfirmation(snapshot, data, tripId);
  const conflict = !!saved && saved.composition !== fingerprint(rows);
  const deliveries = conflict ? {} : saved?.deliveries ?? {};
  const count = rows.filter(row => deliveries[row.id]).length;
  // Legacy fully delivered records derive completion from their last real delivery, without rewriting history.
  const lastDelivery = rows.length > 0 && count === rows.length && facts?.confirmedAt
    ? rows.map(row => deliveries[row.id]).sort((a, b) => a.at.localeCompare(b.at)).at(-1) ?? null : null;
  const completed = conflict ? null : saved?.completed ?? lastDelivery;
  return { version: saved?.version ?? 0, arrivedAt: facts?.arrivedAt ?? null, departedAt: facts?.confirmedAt ?? null, deliveries, completed,
    stage: conflict ? 'conflict' : completed ? 'completed' : rows.length && count === rows.length ? 'delivered' : count ? 'delivering' : facts?.confirmedAt ? 'enroute' : facts?.arrivedAt ? 'loading' : 'planned' };
}
/** Caller authenticates and checks the entire trip inside the same store transaction. No provider calls. */
export function recordTripExecution(snapshot: Snapshot, data: OperationsData, actor: AccountUser, tripId: string, action: 'deliver' | 'complete', body: Record<string, unknown>) {
  if (actor.role !== 'driver' && !hasSection(actor, 'trips')) throw new ApiError(403, 'Раздел рейсов недоступен.');
  if (Object.keys(body).some(key => !['versions','executionVersion', ...(action === 'deliver' ? ['deliveryId'] : [])].includes(key))) throw new ApiError(400, 'В запросе есть неизвестные поля.');
  const rows = snapshot.shipments.filter(row => row.fields.trip_id === tripId);
  if (!rows.length || actor.role === 'driver' && (!actor.driverId || rows.some(row => row.fields.driver_id !== actor.driverId))) throw new ApiError(404, 'Рейс не найден.');
  checkTripVersions(body.versions, rows);
  const current = readTripExecution(snapshot, data, tripId);
  if (current.stage === 'conflict') throw new ApiError(409, 'Состав рейса изменился. Требуется сверка с логистом.');
  if (action === 'complete') throw new ApiError(410, 'Рейс завершается автоматически после последней доставки. Обновите страницу.');
  if (!current.departedAt) throw new ApiError(409, 'Сначала водитель должен отметить погрузку и убытие.');
  const deliveryId = body.deliveryId;
  if (action === 'deliver' && (typeof deliveryId !== 'string' || !rows.some(row => row.id === deliveryId))) throw new ApiError(400, 'Доставка не принадлежит этому рейсу.');
  if (current.deliveries[deliveryId as string]) return { changed: false, result: current };
  if (!Number.isSafeInteger(body.executionVersion) || body.executionVersion !== current.version) throw new ApiError(409, 'Статус уже изменён. Обновите рейс перед подтверждением.');
  if (current.completed) throw new ApiError(409, 'Рейс уже закрыт.');
  const event: TripExecutionEvent = { at: new Date().toISOString(), by: actor.id, name: actor.name, role: actor.role === 'driver' ? 'driver' : 'logistics', ...(actor.role === 'driver' ? { kind: 'arrival' as const } : {}) };
  const record = (data.tripExecutions ??= {})[tripId] ?? { composition: fingerprint(rows), version: 0, deliveries: {}, completed: null };
  if (Object.values(record.deliveries).some(previous => previous.at > event.at)) throw new ApiError(409, 'Серверное время раньше предыдущей доставки. Повторите позже.');
  record.deliveries[deliveryId as string] = event;
  if (rows.every(row => record.deliveries[row.id])) record.completed = event;
  record.version++;
  data.tripExecutions[tripId] = record;
  return { changed: true, result: readTripExecution(snapshot, data, tripId) };
}

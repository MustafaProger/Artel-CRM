import { ApiError } from './api-error';
import type { OperationsData, OperationsStorage } from './operations-store';
import type { SabyClient } from './saby-client';

export interface TripExchangeControl { paused: boolean; version: number; updatedAt: string; updatedBy: string }
export class TripExchangePausedError extends ApiError {
  constructor() { super(409, 'Обмен рейса остановлен. Для продолжения нажмите «Возобновить обмен».'); }
}
export function exchangeControl(data: OperationsData, tripId: string) {
  const row = data.tripExchangeControls?.[tripId];
  return { paused: row?.paused ?? false, version: row?.version ?? 0, updatedAt: row?.updatedAt ?? null };
}
export function assertTripExchangeRunning(data: OperationsData, tripId: string) {
  if (data.tripExchangeControls?.[tripId]?.paused) throw new TripExchangePausedError();
}
/** Runs again after acquiring provider network capacity, including queued requests.
 * Receiving an already sent response and releasing leases remain allowed. */
export function controlledTripClient(client: SabyClient, store: OperationsStorage, source: string, tripId: string) {
  return client.withRequestGuard(async () => assertTripExchangeRunning(await store.read(source), tripId));
}
export function setTripExchangeControl(data: OperationsData, tripId: string, actorId: string, body: Record<string, unknown>) {
  if (Object.keys(body).length !== 2 || typeof body.paused !== 'boolean' || !Number.isSafeInteger(body.version) || Number(body.version) < 0) throw new ApiError(400, 'Укажите действие и версию состояния обмена.');
  const previous = exchangeControl(data, tripId);
  if (previous.version !== body.version) throw new ApiError(409, 'Состояние обмена изменилось в другом окне. Обновите состояние.');
  if (previous.paused === body.paused) return false;
  (data.tripExchangeControls ??= {})[tripId] = { paused: body.paused, version: previous.version + 1, updatedAt: new Date().toISOString(), updatedBy: actorId };
  return true;
}
export function validateTripExchangeControls(value: unknown) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid trip exchange controls');
  for (const [id, row] of Object.entries(value)) {
    if (!id || !row || typeof row !== 'object' || typeof row.paused !== 'boolean' || !Number.isSafeInteger(row.version) || row.version < 1 || typeof row.updatedBy !== 'string' || !row.updatedBy || typeof row.updatedAt !== 'string' || !Number.isFinite(Date.parse(row.updatedAt))) throw new Error('Invalid trip exchange control');
  }
}

import type { Snapshot } from '../web/src/model';
import type { AccountUser } from '../web/src/auth-model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { currentSnapshot } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import { hasTripTransportHistory, isNkDirectEtrn } from './trip-document-mode';
import { requiresEtrn } from './trip-etrn-scope';
import { nkDirectAutostartSourceHash } from './nk-direct-autostart';
import { enqueueAutomaticTripSaby, policyHash, verifiedDriverDeparture, type PrepareTripSaby } from './trip-saby-workflow';
import { sabyObject, type SabyConfig } from './saby-client';

export interface TripSabyAutostart {
  version: 'after-driver-v1'; actorId: string; updatedAt: string;
  sourceHash: string; policyHash: string | null;
  state: 'waiting_departure' | 'queued' | 'blocked'; lastError: string | null;
}
export function validateTripSabyAutostart(value: unknown): asserts value is TripSabyAutostart | undefined {
  if (value === undefined) return;
  const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  if (!sabyObject(value) || value.version !== 'after-driver-v1' || typeof value.actorId !== 'string' || !value.actorId || typeof value.updatedAt !== 'string' || !Number.isFinite(Date.parse(value.updatedAt)) || !digest(value.sourceHash) || !(value.policyHash === null || digest(value.policyHash)) || !['waiting_departure', 'queued', 'blocked'].includes(String(value.state)) || !(value.lastError === null || typeof value.lastError === 'string') || value.state === 'blocked' && !value.lastError) throw new Error('Invalid Saby departure enrollment');
}
interface Context { base: Snapshot; data: OperationsData; tripId: string; config: SabyConfig }
/** Employee save only. Reads and background scans must never enroll old trips. */
export function enrollTripSabyAfterDriver({ base, data, tripId, config, actorId }: Context & { actorId: string }): void {
  const trip = getShipmentTrip(currentSnapshot(base, data), tripId);
  if (hasTripTransportHistory(data, tripId) || data.driverTripProgress?.[tripId]?.departedAt) return;
  if (trip.fields.trip_flow_version !== 'driver-v1' || isNkDirectEtrn(trip, data) || !trip.customers.some(requiresEtrn)) {
    if (data.etrn?.trips[tripId]) delete data.etrn.trips[tripId].sabyAutostart;
    return;
  }
  const now = new Date().toISOString();
  data.etrn ??= { trips: {} };
  const saved = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: now };
  saved.sabyAutostart = { version: 'after-driver-v1', actorId, updatedAt: now, sourceHash: nkDirectAutostartSourceHash(base, data, tripId), policyHash: config.automaticSigning ? policyHash(config.automaticSigning) : null, state: 'waiting_departure', lastError: null };
}
/** Runs atomically with the first authenticated departure; never impersonates the driver as signer. */
export function enqueueTripSabyDeparture(options: Context & { actor: AccountUser; previousSourceHash: string; prepare?: PrepareTripSaby }): boolean {
  const { base, data, tripId, config, actor } = options;
  const enrollment = data.etrn?.trips[tripId]?.sabyAutostart;
  if (!enrollment || enrollment.state !== 'waiting_departure') return false;
  try {
    const progress = data.driverTripProgress?.[tripId], snapshot = currentSnapshot(base, data);
    if (actor.role !== 'driver' || progress?.departedBy !== actor.id || progress.driverId !== actor.driverId || !verifiedDriverDeparture(snapshot, data, tripId) || enrollment.sourceHash !== options.previousSourceHash || hasTripTransportHistory(data, tripId)) throw new ApiError(409, 'Данные рейса или подтверждение водителя изменились. Требуется сверка перед отправкой.');
    if (!config.automaticSigning || enrollment.policyHash !== policyHash(config.automaticSigning)) throw new ApiError(409, 'Настройка автоподписи изменилась. Убытие сохранено; проверьте обмен.');
    const queued = enqueueAutomaticTripSaby({ ...options, actorId: enrollment.actorId });
    if (!queued.enqueued) throw new ApiError(422, queued.blockers.join(' ') || 'Обмен не поставлен в очередь. Проверьте сведения рейса.');
    enrollment.state = 'queued'; enrollment.lastError = null; enrollment.updatedAt = new Date().toISOString();
    return true;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    enrollment.state = 'blocked'; enrollment.lastError = error.message; enrollment.updatedAt = new Date().toISOString();
    return false;
  }
}

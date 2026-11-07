import { createHash, randomUUID } from 'node:crypto';
import type { Snapshot } from '../web/src/model';
import type { AccountUser } from '../web/src/auth-model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { currentSnapshot } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import { hasTripTransportHistory, isNkDirectEtrn, TRIP_DOCUMENT_POLICY_VERSION } from './trip-document-mode';
import { requiresEtrn } from './trip-etrn-scope';
import { departureHash, verifiedDriverDeparture } from './trip-saby-workflow';
import { directActorAccess, directCandidateBlockers, directPolicyHash, directSourceHash, preparedNkDirectEtrn, type NkDirectEtrnRecord } from './nk-direct-etrn';
import { sabyObject, type SabyConfig } from './saby-client';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dated = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export interface NkDirectAutostart {
  version: 'nk-direct-autostart-v1'; actorId: string; createdAt: string; updatedAt: string;
  source: 'trip_save' | 'approved_existing_departure'; sourceHash: string; policyHash: string; certificate: string | null;
  state: 'waiting_departure' | 'queued' | 'blocked' | 'not_required'; lastError: string | null;
  event?: { driverId: string; actorId: string; departedAt: string; factsHash: string; sourceHash?: string };
}
export function validateNkDirectAutostart(value: unknown): asserts value is NkDirectAutostart | undefined {
  if (value === undefined) return;
  if (!sabyObject(value) || value.version !== 'nk-direct-autostart-v1' || typeof value.actorId !== 'string' || !value.actorId || !dated(value.createdAt) || !dated(value.updatedAt) || !['trip_save', 'approved_existing_departure'].includes(String(value.source)) || !digest(value.sourceHash) || !digest(value.policyHash) || !(value.certificate === null || typeof value.certificate === 'string' && /^[a-f0-9]{40,128}$/.test(value.certificate)) || !['waiting_departure', 'queued', 'blocked', 'not_required'].includes(String(value.state)) || !(value.lastError === null || typeof value.lastError === 'string')) throw new Error('Invalid direct ETRN automatic enrollment');
  if (value.event !== undefined && (!sabyObject(value.event) || typeof value.event.driverId !== 'string' || !value.event.driverId || typeof value.event.actorId !== 'string' || !value.event.actorId || !dated(value.event.departedAt) || !digest(value.event.factsHash) || value.event.sourceHash !== undefined && !digest(value.event.sourceHash))) throw new Error('Invalid direct ETRN departure event');
  if (value.state === 'queued' && (!value.event || !value.certificate) || value.state === 'blocked' && !value.lastError) throw new Error('Inconsistent direct ETRN automatic enrollment');
}
/** Only persisted inputs are relevant; bank projections and transient workflow status are excluded. */
export function nkDirectAutostartSourceHash(base: Snapshot, data: OperationsData, tripId: string): string {
  const trip = getShipmentTrip(currentSnapshot(base, data, false), tripId);
  const loadingActorMode = data.etrn?.trips[tripId]?.loadingActorMode;
  // Preserve historical hashes when absent; an explicit role change invalidates old departure authority.
  return hash([base.provenance.sourceSha256, tripId, trip.customers.map(row => [row.id, row.version, row.fields]), ...(loadingActorMode ? [{ loadingActorMode }] : [])]);
}
const enrollmentHash = (saved: NkDirectAutostart) => hash([saved.version, saved.actorId, saved.createdAt, saved.source, saved.sourceHash, saved.policyHash, saved.certificate, saved.event]);
interface Context { base: Snapshot; data: OperationsData; tripId: string; config: SabyConfig }
/** Called only by authenticated employee save, before any driver arrival; never by reads or scans. */
export function enrollNkDirectAutostart({ base, data, tripId, config, actorId }: Context & { actorId: string }): boolean {
  const snapshot = currentSnapshot(base, data), trip = getShipmentTrip(snapshot, tripId);
  if (data.etrn?.trips[tripId]?.rebuild?.externalRestartBlocked) return false;
  if (trip.fields.trip_document_policy !== TRIP_DOCUMENT_POLICY_VERSION || data.driverTripProgress?.[tripId] || hasTripTransportHistory(data, tripId)) return false;
  if (!isNkDirectEtrn(trip, data)) {
    if (data.etrn?.trips[tripId]?.directAutostart) delete data.etrn.trips[tripId].directAutostart;
    return false;
  }
  let authorityError: string | null = null;
  try { directActorAccess(snapshot, data, tripId, actorId); } catch (error) { if (!(error instanceof ApiError)) throw error; authorityError = error.message; }
  const now = new Date().toISOString();
  data.etrn ??= { trips: {} };
  const saved = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: now };
  saved.directAutostart = { version: 'nk-direct-autostart-v1', actorId, createdAt: now, updatedAt: now, source: 'trip_save', sourceHash: nkDirectAutostartSourceHash(base, data, tripId), policyHash: directPolicyHash(config), certificate: authorityError ? null : config.automaticSigning?.carrier.thumbprint ?? null, state: authorityError ? 'blocked' : 'waiting_departure', lastError: authorityError };
  saved.updatedAt = now;
  return true;
}
function persistIntent({ base, data, tripId, config }: Context, enrollment: NkDirectAutostart): void {
  if (data.etrn?.trips[tripId]?.rebuild?.externalRestartBlocked) throw new ApiError(409, 'Прежний обмен сохранён в истории; повторная отправка требует сверки.');
  directActorAccess(currentSnapshot(base, data), data, tripId, enrollment.actorId);
  if (directCandidateBlockers(config).length || enrollment.policyHash !== directPolicyHash(config) || !enrollment.certificate || enrollment.certificate !== config.automaticSigning?.carrier.thumbprint) throw new ApiError(403, 'Настройка подписи НК изменилась или недоступна. Убытие сохранено; автоматический обмен остановлен для сверки.');
  const prepared = preparedNkDirectEtrn(base, data, tripId, config);
  if (prepared.blockers.length) throw new ApiError(422, prepared.blockers.join(' '));
  const now = new Date().toISOString(), saved = data.etrn!.trips[tripId];
  enrollment.state = 'queued'; enrollment.lastError = null; enrollment.updatedAt = now;
  saved.direct = { version: 'nk-direct-v1', attemptId: randomUUID(), createdAt: now, updatedAt: now, phase: 'creating_etrn', lastError: null, leaseId: null, leaseUntil: null,
    authorization: { actorId: enrollment.actorId, requestedAt: now, mode: 'sign_and_send', grantedRoles: ['sender', 'carrier'], selection: { sender: enrollment.certificate, carrier: enrollment.certificate }, policyHash: enrollment.policyHash, factsHash: departureHash(data, tripId), sourceHash: directSourceHash(base, data, tripId, prepared), automatic: { version: 'nk-direct-autostart-v1', enrollmentHash: enrollmentHash(enrollment), eventHash: enrollment.event!.factsHash, source: enrollment.source === 'trip_save' ? 'driver_departure' : 'approved_existing_departure' } }, deliveries: prepared.deliveries };
  saved.updatedAt = now;
}
/** The caller invokes this once, in the same transaction that first saves the authenticated departure. */
export function enqueueNkDirectDeparture(options: Context & { actor: AccountUser; previousSourceHash: string }): boolean {
  const { base, data, tripId, actor } = options, enrollment = data.etrn?.trips[tripId]?.directAutostart;
  if (!enrollment || enrollment.event || enrollment.source !== 'trip_save') return false;
  const progress = data.driverTripProgress?.[tripId];
  if (actor.role !== 'driver' || progress?.departedBy !== actor.id || progress.driverId !== actor.driverId || !progress.departedAt) throw new ApiError(403, 'Не подтверждён источник события водителя.');
  enrollment.event = { actorId: actor.id, driverId: progress.driverId, departedAt: progress.departedAt, factsHash: departureHash(data, tripId) };
  enrollment.updatedAt = progress.departedAt;
  try {
    const snapshot = currentSnapshot(base, data), trip = getShipmentTrip(snapshot, tripId);
    if (!isNkDirectEtrn(trip, data) || trip.fields.trip_document_policy !== TRIP_DOCUMENT_POLICY_VERSION || hasTripTransportHistory(data, tripId) || enrollment.sourceHash !== options.previousSourceHash || !verifiedDriverDeparture(snapshot, data, tripId)) throw new ApiError(409, 'Состав, данные или основание автоматической ЭТрН изменились. Убытие сохранено; необходима сверка.');
    if (!trip.customers.some(requiresEtrn)) { enrollment.state = 'not_required'; enrollment.lastError = null; return false; }
    enrollment.event.sourceHash = nkDirectAutostartSourceHash(base, data, tripId);
    persistIntent(options, enrollment);
    return true;
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    enrollment.state = 'blocked'; enrollment.lastError = error.message;
    return false;
  }
}
/** Filling missing loading details can finish a new, unchanged departure enrollment.
 * Historical enrollments without a frozen post-departure source cannot be revived here. */
export function retryNkDirectAfterLoadingDetails(options: Context): boolean {
  const { base, data, tripId } = options, saved = data.etrn?.trips[tripId], enrollment = saved?.directAutostart;
  if (!enrollment || enrollment.state !== 'blocked' || enrollment.source !== 'trip_save' || !enrollment.event?.sourceHash || saved?.rebuild || hasTripTransportHistory(data, tripId)) return false;
  const snapshot = currentSnapshot(base, data), trip = getShipmentTrip(snapshot, tripId);
  if (!isNkDirectEtrn(trip, data) || enrollment.event.sourceHash !== nkDirectAutostartSourceHash(base, data, tripId) || enrollment.event.factsHash !== departureHash(data, tripId) || !verifiedDriverDeparture(snapshot, data, tripId)) return false;
  try { persistIntent(options, enrollment); return true; }
  catch (error) {
    if (!(error instanceof ApiError)) throw error;
    enrollment.lastError = error.message; enrollment.updatedAt = new Date().toISOString(); return false;
  }
}
/** A saved grant can never outlive or switch its employee policy or confirmed driver event. */
export function authorizeNkDirectAutostart(data: OperationsData, tripId: string, record: NkDirectEtrnRecord): void {
  const automatic = record.authorization.automatic, saved = data.etrn?.trips[tripId]?.directAutostart;
  if (!automatic && !saved) return;
  if (!automatic || !saved || saved.state !== 'queued' || !saved.event || saved.actorId !== record.authorization.actorId || saved.policyHash !== record.authorization.policyHash || saved.certificate !== record.authorization.selection.sender || automatic.enrollmentHash !== enrollmentHash(saved) || automatic.eventHash !== departureHash(data, tripId) || automatic.eventHash !== saved.event.factsHash || automatic.source !== (saved.source === 'trip_save' ? 'driver_departure' : 'approved_existing_departure')) throw new ApiError(403, 'Основание автоматической прямой ЭТрН изменилось. Обмен остановлен.');
}

export const NK_DIRECT_EXISTING_TRIP = 'shipment-trip-20d93bd0-7538-4160-a468-e3393f31b9f0';
export interface NkDirectExistingExpectation { sourceHash: string; factsHash: string; policyHash: string }
/** Read-only compare-and-swap evidence for the single existing trip explicitly requested by the user. */
export function nkDirectExistingExpectation(options: Context): NkDirectExistingExpectation {
  const { base, data, tripId, config } = options;
  if (tripId !== NK_DIRECT_EXISTING_TRIP) throw new ApiError(403, 'Продолжение разрешено только для согласованного рейса №27.');
  return { sourceHash: directSourceHash(base, data, tripId, preparedNkDirectEtrn(base, data, tripId, config)), factsHash: departureHash(data, tripId), policyHash: directPolicyHash(config) };
}
/** Maintenance-only scoped adoption, no HTTP route or history scan. Caller must hold the storage transaction. */
export function continueApprovedNkDirect27(options: Context & { actorId: string; expected: NkDirectExistingExpectation }): { enqueued: boolean } {
  const { base, data, tripId, config, actorId, expected } = options;
  if (tripId !== NK_DIRECT_EXISTING_TRIP) throw new ApiError(403, 'Продолжение разрешено только для согласованного рейса №27.');
  const snapshot = currentSnapshot(base, data), trip = getShipmentTrip(snapshot, tripId);
  directActorAccess(snapshot, data, tripId, actorId);
  const current = nkDirectExistingExpectation(options);
  if (!digest(expected.sourceHash) || !digest(expected.factsHash) || !digest(expected.policyHash) || expected.sourceHash !== current.sourceHash || expected.factsHash !== current.factsHash || expected.policyHash !== current.policyHash) throw new ApiError(409, 'Согласованные данные рейса №27 изменились. Требуется повторная сверка.');
  const direct = data.etrn?.trips[tripId]?.direct;
  if (direct) {
    authorizeNkDirectAutostart(data, tripId, direct);
    if (direct.authorization.actorId !== actorId || direct.authorization.automatic?.source !== 'approved_existing_departure' || direct.authorization.sourceHash !== expected.sourceHash || direct.authorization.factsHash !== expected.factsHash) throw new ApiError(409, 'По рейсу уже есть другая попытка обмена.');
    return { enqueued: false };
  }
  const deliveries = new Map([['shipment-local-d4593cc1-1c92-406d-8229-e8c085ae3dfd', ['8000', '6.745']], ['shipment-local-d0d5959a-ef66-4e54-bf67-a6e896194b94', ['9500', '7.985']]]);
  if (!isNkDirectEtrn(trip, data) || hasTripTransportHistory(data, tripId) || data.etrn?.trips[tripId]?.directAutostart || !verifiedDriverDeparture(snapshot, data, tripId) || trip.customers.length !== 2 || trip.customers.some(row => { const expectedRow = deliveries.get(row.id); return !expectedRow || row.version !== 2 || !requiresEtrn(row) || row.fields.quantity_litres !== expectedRow[0] || row.fields.quantity_tonnes !== expectedRow[1]; }) || !data.etrn?.trips[tripId]?.loadingFacts?.departedAt.startsWith('2026-10-20T11:28')) throw new ApiError(409, 'Рейс №27 не соответствует согласованным доставкам и подтверждённому убытию.');
  const progress = data.driverTripProgress![tripId], now = new Date().toISOString();
  const enrollment: NkDirectAutostart = { version: 'nk-direct-autostart-v1', actorId, createdAt: now, updatedAt: now, source: 'approved_existing_departure', sourceHash: expected.sourceHash, policyHash: directPolicyHash(config), certificate: config.automaticSigning?.carrier.thumbprint ?? null, state: 'waiting_departure', lastError: null, event: { driverId: progress.driverId, actorId: progress.departedBy!, departedAt: progress.departedAt!, factsHash: expected.factsHash } };
  data.etrn!.trips[tripId].directAutostart = enrollment;
  persistIntent(options, enrollment);
  return { enqueued: true };
}

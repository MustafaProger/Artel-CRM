import type { ShipmentAccessContext } from './shipment-operations';
import { createHash, randomUUID } from 'node:crypto';
import { NATIVE_APPROVED_REDIRECTION_METHOD } from './saby-consignment-evidence';
import Decimal from 'decimal.js';
import type { Snapshot } from '../web/src/model';
import type { TripSabyResponse } from '../web/src/trip-saby-model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { publicUser } from './auth';
import { requireWholeTrip } from './auth-scope';
import { requireTripSection } from './permissions';
import { currentSnapshot } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import { isNkDirectEtrn } from './trip-document-mode';
import { requiresEtrn } from './trip-etrn-scope';
import { verifiedDriverDeparture, departureHash } from './trip-saby-workflow';
import { prepareNkDirectEtrn } from './trip-saby-preparation';
import { SabyClient, SabyError, sabyConfigFromEnv, sabyCredentialBlockers, sabyObject, type SabyConfig } from './saby-client';
import { sabyConsignmentBlockers, type SabyConsignmentSnapshot } from './saby-consignment-note';
import { exchangePreparedEtrn, type EtrnOptions } from './etrn-service';
import { continueEtrnDispatch } from './etrn-dispatch';
import { authorizeNkDirectAutostart } from './nk-direct-autostart';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const stamp = () => new Date().toISOString();
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const dated = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
export const NK_DIRECT_REBUILD_HOLD = 'Рейс пересоздан как черновик. Прежние попытки Saby сохранены в истории; новая отправка приостановлена до сверки прежних накладных и подтверждения недостающих сведений.';
const phaseValues = ['creating_etrn', 'sending_etrn', 'unknown', 'completed', 'error'] as const;
export interface NkDirectEtrnRecord {
  version: 'nk-direct-v1'; attemptId: string; createdAt: string; updatedAt: string;
  authorization: {
    actorId: string; requestedAt: string; mode: 'sign_and_send'; grantedRoles: ['sender', 'carrier'];
    selection: { sender: string; carrier: string }; policyHash: string; factsHash: string; sourceHash: string;
    automatic?: { version: 'nk-direct-autostart-v1'; enrollmentHash: string; eventHash: string; source: 'driver_departure' | 'approved_existing_departure' };
  };
  deliveries: { shipmentId: string; snapshot: SabyConsignmentSnapshot }[];
  phase: typeof phaseValues[number]; lastError: string | null;
  leaseId: string | null; leaseUntil: string | null;
  lastCheckedAt?: string; lastCheckAttemptAt?: string; completedAt?: string;
}
export function validateNkDirectEtrn(value: unknown, tripId: string): asserts value is NkDirectEtrnRecord | undefined {
  if (value === undefined) return;
  if (!sabyObject(value) || value.version !== 'nk-direct-v1' || typeof value.attemptId !== 'string' || !value.attemptId || !dated(value.createdAt) || !dated(value.updatedAt) || !phaseValues.includes(value.phase as NkDirectEtrnRecord['phase']) || !(value.lastError === null || typeof value.lastError === 'string') || !(value.leaseId === null || typeof value.leaseId === 'string') || !(value.leaseUntil === null || dated(value.leaseUntil)) || !Array.isArray(value.deliveries) || !value.deliveries.length) throw new Error('Invalid direct ETRN record');
  const auth = value.authorization;
  if (!sabyObject(auth) || typeof auth.actorId !== 'string' || !auth.actorId || !dated(auth.requestedAt) || auth.mode !== 'sign_and_send' || JSON.stringify(auth.grantedRoles) !== '["sender","carrier"]' || !sabyObject(auth.selection) || typeof auth.selection.sender !== 'string' || !/^[a-f0-9]{40,128}$/.test(auth.selection.sender) || auth.selection.sender !== auth.selection.carrier || ![auth.policyHash, auth.factsHash, auth.sourceHash].every(digest)) throw new Error('Invalid direct ETRN authorization');
  if (auth.automatic !== undefined && (!sabyObject(auth.automatic) || auth.automatic.version !== 'nk-direct-autostart-v1' || !digest(auth.automatic.enrollmentHash) || !digest(auth.automatic.eventHash) || !['driver_departure', 'approved_existing_departure'].includes(String(auth.automatic.source)))) throw new Error('Invalid direct ETRN automatic source');
  const ids = new Set<string>();
  for (const row of value.deliveries) {
    if (!sabyObject(row) || typeof row.shipmentId !== 'string' || !row.shipmentId || ids.has(row.shipmentId) || !sabyObject(row.snapshot) || row.snapshot.documentMode !== 'nk-direct-v1' || row.snapshot.tripId !== tripId || row.snapshot.shipmentId !== row.shipmentId) throw new Error('Invalid direct ETRN delivery');
    ids.add(row.shipmentId);
  }
  for (const key of ['lastCheckedAt', 'lastCheckAttemptAt', 'completedAt']) if (value[key] !== undefined && !dated(value[key])) throw new Error('Invalid direct ETRN observation');
  if (value.completedAt && value.phase !== 'completed') throw new Error('Inconsistent direct ETRN completion');
}
export const directPolicyHash = (config: SabyConfig) => hash(['nk-direct-v1', config.carrierAccountNumber?.trim() || config.accountNumber, config.automaticSigning, config.automaticSigningError, config.carrier, config.nkConsignmentSigner, config.nkRegulatoryInstructions]);
export function directActorAccess(snapshot: ShipmentAccessContext, data: OperationsData, tripId: string, actorId: string): void {
  const user = data.accounts?.users.find(row => row.id === actorId && row.active && !row.deletedAt);
  if (!user) throw new ApiError(403, 'Инициатор прямой ЭТрН больше не имеет доступа.');
  const actor = publicUser(user); requireTripSection(actor, true); requireWholeTrip(actor, snapshot, tripId);
}
export function directCandidateBlockers(config: SabyConfig): string[] {
  const policy = config.automaticSigning;
  if (config.automaticSigningError || !policy?.enabled || policy.carrier.inn !== config.carrier.inn || policy.carrier.kpp !== config.carrier.kpp) return ['В настройке Saby не подтверждён сертификат НК АРТЭЛЬ. Запуск прямой ЭТрН недоступен.'];
  return [];
}
export function preparedNkDirectEtrn(base: Snapshot, data: OperationsData, tripId: string, config: SabyConfig) {
  return preparedNkDirectFromSnapshot(currentSnapshot(base, data), data, tripId, config);
}
export function preparedNkDirectFromSnapshot(source: Snapshot, data: OperationsData, tripId: string, config: SabyConfig) {
  const trip = getShipmentTrip(source, tripId);
  const prepared = prepareNkDirectEtrn(source, data, trip, config);
  const facts = data.etrn?.trips[tripId]?.loadingFacts;
  const deliveries = prepared.deliveries.map(row => {
    const snapshot = structuredClone(row.snapshot);
    if (facts?.deliveries[row.shipmentId]) snapshot.profile.loading = { arrivedAt: facts.arrivedAt, departedAt: facts.departedAt, ...facts.deliveries[row.shipmentId] };
    return { shipmentId: row.shipmentId, snapshot };
  });
  const blockers = [...prepared.blockers];
  if (!verifiedDriverDeparture(source, data, tripId)) blockers.push('Сначала назначенный водитель должен подтвердить прибытие, массы каждой доставки и убытие. Сохранённые факты должны соответствовать рейсу.');
  if (facts) {
    const total = Object.values(facts.deliveries).reduce((sum, row) => sum.plus(row.grossMassTonnes), new Decimal(0));
    if (deliveries.some(row => !row.snapshot.profile.vehicle.payloadTonnes || total.gt(row.snapshot.profile.vehicle.payloadTonnes))) blockers.push('Сумма фактических масс всех доставок превышает подтверждённую грузоподъёмность машины.');
  }
  blockers.push(...deliveries.flatMap(row => sabyConsignmentBlockers(row.snapshot)));
  return { deliveries, blockers: [...new Set(blockers)] };
}
export const directSourceHash = (base: Snapshot, data: OperationsData, tripId: string, prepared: ReturnType<typeof preparedNkDirectEtrn>) => directSourceHashFromSnapshot(base, currentSnapshot(base, data), data, tripId, prepared);
function directSourceHashFromSnapshot(base: Snapshot, snapshot: Snapshot, data: OperationsData, tripId: string, prepared: ReturnType<typeof preparedNkDirectEtrn>) {
  const trip = getShipmentTrip(snapshot, tripId);
  const loadingActorMode = data.etrn?.trips[tripId]?.loadingActorMode;
  return hash([base.provenance.sourceSha256, trip.id, trip.fields, trip.customers.map(row => [row.id, row.version, row.fields]), prepared.deliveries, ...(loadingActorMode ? [{ loadingActorMode }] : [])]);
};
/** Rechecked before every provider request; no old automatic grant authorizes the NK sender role. */
export function authorizeNkDirectEtrn(base: Snapshot, data: OperationsData, tripId: string, config: SabyConfig): NkDirectEtrnRecord {
  return authorizeNkDirectFromSnapshot(base, currentSnapshot(base, data), data, tripId, config);
}
// Only an internal synchronous caller may supply the exact full snapshot it just built.
// Callers and every provider guard must assemble from their own fresh store read; never reuse across await.
export function authorizeNkDirectFromSnapshot(base: Snapshot, snapshot: Snapshot, data: OperationsData, tripId: string, config: SabyConfig): NkDirectEtrnRecord {
  const trip = getShipmentTrip(snapshot, tripId), record = data.etrn?.trips[tripId]?.direct;
  if (data.etrn?.trips[tripId]?.rebuild?.externalRestartBlocked) throw new ApiError(409, NK_DIRECT_REBUILD_HOLD);
  if (!record || !isNkDirectEtrn(trip, data) || data.tripSaby?.trips[tripId] || data.saby?.trips[tripId]) throw new ApiError(403, 'Не подтверждено отдельное разрешение прямой ЭТрН НК.');
  if (Object.values(data.etrn!.trips[tripId].deliveries).some(row => row.document?.nativeAdoptionEvidence?.holdForReview)) throw new ApiError(403, 'Связанные черновики Saby проходят сверку. Подписание и отправка приостановлены до её завершения.');
  validateNkDirectEtrn(record, tripId);
  directActorAccess(snapshot, data, tripId, record.authorization.actorId);
  authorizeNkDirectAutostart(data, tripId, record);
  if (directCandidateBlockers(config).length || directPolicyHash(config) !== record.authorization.policyHash || record.authorization.selection.sender !== config.automaticSigning?.carrier.thumbprint || record.authorization.selection.carrier !== config.automaticSigning?.carrier.thumbprint) throw new ApiError(403, 'Настройка подписи НК изменилась. Прямой обмен остановлен.');
  const prepared = preparedNkDirectFromSnapshot(snapshot, data, tripId, config);
  if (prepared.blockers.length || record.authorization.factsHash !== departureHash(data, tripId) || record.authorization.sourceHash !== directSourceHashFromSnapshot(base, snapshot, data, tripId, prepared) || hash(prepared.deliveries) !== hash(record.deliveries)) throw new ApiError(409, 'Данные, состав или подтверждённые массы прямой ЭТрН изменились. Обмен остановлен для сверки.');
  return record;
}
export function nkDirectEtrnCompleted(data: OperationsData, tripId: string): boolean {
  const trip = data.etrn?.trips[tripId], direct = trip?.direct;
  if (!trip || !direct?.completedAt || direct.phase !== 'completed' || !direct.deliveries.length) return false;
  const required = Object.entries(data.shipments).filter(([, row]) => !row.deleted && row.fields.trip_id === tripId && requiresEtrn(row));
  return required.length === direct.deliveries.length && required.every(([id]) => direct.deliveries.some(item => item.shipmentId === id)) && direct.deliveries.every(row => {
    const doc = trip.deliveries[row.shipmentId]?.document;
    return !!doc?.id && doc.status === 'draft' && doc.payloadHash === hash(row.snapshot) && doc.snapshot.documentMode === 'nk-direct-v1' && !!doc.dispatch?.completedAt && doc.dispatch.sender.state === 'confirmed' && doc.dispatch.carrier.state === 'confirmed';
  });
}
interface DirectGetOptions { base: Snapshot; data: OperationsData; tripId: string; config?: SabyConfig; monitoringEnabled?: boolean; actorId?: string }
export function getNkDirectEtrnWorkflow({ base, data, tripId, config = sabyConfigFromEnv(), monitoringEnabled = false, actorId }: DirectGetOptions): TripSabyResponse {
  const snapshot = currentSnapshot(base, data), trip = getShipmentTrip(snapshot, tripId), record = data.etrn?.trips[tripId]?.direct;
  const required = trip.customers.filter(requiresEtrn), blockers: string[] = [];
  const automatic = data.etrn?.trips[tripId]?.directAutostart;
  if (data.etrn?.trips[tripId]?.rebuild?.externalRestartBlocked) blockers.push(NK_DIRECT_REBUILD_HOLD);
  let start: TripSabyResponse['start'];
  if (required.length && !record) {
    const prepared = preparedNkDirectEtrn(base, data, tripId, config);
    blockers.push(...prepared.blockers, ...directCandidateBlockers(config), ...sabyCredentialBlockers(new SabyClient(config).forNkDirectEtrn().config));
    if (data.tripSaby?.trips[tripId] || data.saby?.trips[tripId] || Object.values(data.etrn?.trips[tripId]?.deliveries ?? {}).some(row => row.document)) blockers.push('У рейса есть прежняя внешняя попытка. Новый прямой обмен не запускается.');
    if (actorId && !automatic) {
      try { directActorAccess(snapshot, data, tripId, actorId); }
      catch (error) { blockers.push(error instanceof ApiError ? error.message : 'Нет права запуска прямой ЭТрН.'); }
      if (!blockers.length) start = { mode: 'sign_and_send', previewToken: hash(['nk-direct-v1', actorId, directSourceHash(base, data, tripId, prepared), departureHash(data, tripId), directPolicyHash(config)]) };
    }
  } else if (record) {
    try { authorizeNkDirectEtrn(base, data, tripId, config); }
    catch (error) { blockers.push(error instanceof ApiError ? error.message : 'Основание прямого обмена требует сверки.'); }
  }
  if (automatic?.lastError) blockers.push(automatic.lastError);
  const completed = nkDirectEtrnCompleted(data, tripId);
  return { documentMode: 'nk_direct_etrn', parties: { sender: config.carrier.name, carrier: config.carrier.name }, notRequired: !required.length,
    status: record?.lastError || blockers.length ? 'error' : record?.deliveries.some(row => !!data.etrn?.trips[tripId]?.deliveries[row.shipmentId]?.document?.dispatch?.completedAt) ? 'sent' : 'not_sent', phase: record?.phase ?? (!required.length ? 'completed' : 'preparation'), ready: !!start, blockers: [...new Set(blockers)], locked: !!record,
    updatedAt: record?.updatedAt ?? null, lastError: record?.lastError ?? null, order: null,
    ...(data.etrn?.trips[tripId]?.exchangeHistory?.length ? { previousExchanges: data.etrn.trips[tripId].exchangeHistory!.map(entry => ({ at: entry.archivedAt, documents: Object.values(entry.exchange.deliveries).flatMap(row => row.document ? [{ number: row.document.number ?? null, url: row.document.url, status: row.document.remoteStatus }] : []) })) } : {}),
    deliveries: required.map(row => { const doc = data.etrn?.trips[tripId]?.deliveries[row.id]?.document; return { shipmentId: row.id, id: doc?.id ?? null, status: doc?.status ?? 'not_sent', lastError: doc?.dispatch?.lastError ?? doc?.lastError ?? null, ...(doc?.dispatch ? { dispatch: { sender: { state: doc.dispatch.sender.state }, carrier: { state: doc.dispatch.carrier.state }, completedAt: doc.dispatch.completedAt ?? null, ...(doc.dispatch.recipientAcceptedAt ? { recipientAcceptedAt: doc.dispatch.recipientAcceptedAt } : {}) } } : {}) };  }),
    carrierConfirmed: !!record && record.deliveries.every(row => data.etrn?.trips[tripId]?.deliveries[row.shipmentId]?.document?.dispatch?.carrier.state === 'confirmed'),
    lastCheckedAt: record?.lastCheckedAt ?? null, lastCheckAttemptAt: record?.lastCheckAttemptAt ?? null,
    monitoring: { enabled: monitoringEnabled && !!record && !blockers.length, intervalSeconds: monitoringEnabled && !!record && !blockers.length ? 60 : null }, history: [],
    automation: automatic ? { mode: 'after_driver_departure', enabled: automatic.state !== 'blocked' && !!required.length, enrolled: true, message: automatic.state === 'blocked' ? automatic.lastError! : !required.length ? 'ЭТрН не требуется для всех доставок.' : automatic.state === 'queued' ? 'После сохранённого убытия водителя ЭТрН поставлены в очередь подписания и отправки. Статусы ниже подтверждают фактические этапы обмена.' : 'После подтверждения назначенным водителем убытия и масс CRM автоматически поставит ЭТрН в очередь подписания и отправки.' } : { enabled: false, enrolled: false, message: 'Прямые ЭТрН запускаются отдельно после подтверждения водителем убытия. Запуск разрешает НК АРТЭЛЬ подписать титулы отправителя и перевозчика и передать документ каждому выбранному получателю.' },
    ...(start ? { start } : {}), stage6CompletedAt: completed ? record!.completedAt! : null,
  };
}
/** Must execute inside the storage transaction. Facts and driver versions are never rewritten. */
export function startNkDirectEtrn(options: DirectGetOptions & { actorId: string; config: SabyConfig; previewToken: string; mode: 'draft' | 'sign_and_send' }): void {
  const { base, data, tripId, actorId, config } = options;
  const trip = getShipmentTrip(currentSnapshot(base, data), tripId);
  if (data.etrn?.trips[tripId]?.rebuild?.externalRestartBlocked) throw new ApiError(409, NK_DIRECT_REBUILD_HOLD);
  directActorAccess(currentSnapshot(base, data), data, tripId, actorId);
  if (!isNkDirectEtrn(trip, data) || data.etrn?.trips[tripId]?.direct || data.etrn?.trips[tripId]?.directAutostart) throw new ApiError(409, 'Прямой обмен уже запущен или недоступен для этого рейса.');
  const preview = getNkDirectEtrnWorkflow(options);
  if (preview.blockers.length) throw new ApiError(422, preview.blockers.join(' '));
  if (options.mode !== 'sign_and_send' || !preview.start || preview.start.previewToken !== options.previewToken) throw new ApiError(409, 'Данные рейса или настройка подписи изменились. Обновите состояние перед запуском прямой ЭТрН.');
  const prepared = preparedNkDirectEtrn(base, data, tripId, config), time = stamp();
  data.etrn ??= { trips: {} };
  const saved = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: time };
  saved.direct = { version: 'nk-direct-v1', attemptId: randomUUID(), createdAt: time, updatedAt: time, phase: 'creating_etrn', lastError: null, leaseId: null, leaseUntil: null,
    authorization: { actorId, requestedAt: time, mode: 'sign_and_send', grantedRoles: ['sender', 'carrier'], selection: { sender: config.automaticSigning!.carrier.thumbprint, carrier: config.automaticSigning!.carrier.thumbprint }, policyHash: directPolicyHash(config), factsHash: departureHash(data, tripId), sourceHash: directSourceHash(base, data, tripId, prepared) }, deliveries: prepared.deliveries };
  saved.updatedAt = time;
}
/** Independent durable lifecycle, sharing document leases and uncertainty handling with normal ETRN. */
export async function runNkDirectEtrn(options: EtrnOptions): Promise<void> {
  const { base, store, tripId, authorize } = options, source = base.provenance.sourceSha256, leaseId = randomUUID();
  const originalClient = options.client ?? new SabyClient(sabyConfigFromEnv()), config = originalClient.config;
  const authority = (data: OperationsData) => {
    const snapshot = currentSnapshot(base, data);
    authorize(snapshot, data);
    return authorizeNkDirectFromSnapshot(base, snapshot, data, tripId, config);
  };
  const claimed = await store.mutate(source, data => {
    const record = authority(data);
    if (record.leaseId && Date.parse(record.leaseUntil ?? '') > Date.now()) throw new ApiError(409, 'Прямой обмен уже выполняется.');
    record.leaseId = leaseId; record.leaseUntil = new Date(Date.now() + 300_000).toISOString(); record.lastCheckAttemptAt = stamp();
    return { result: structuredClone(record), changed: true };
  });
  const check = async () => { const data = await store.read(source); const record = authority(data); if (record.attemptId !== claimed.attemptId || record.leaseId !== leaseId || Date.parse(record.leaseUntil ?? '') <= Date.now()) throw new ApiError(409, 'Сеанс прямого обмена изменился.'); };
  const client = originalClient.forNkDirectEtrn().withRequestGuard(check);
  const context = { ...options, client, authorize: (snapshot: ShipmentAccessContext, data: OperationsData) => { authorize(snapshot, data); authorizeNkDirectEtrn(base, data, tripId, config); } };
  let released = false;
  const update = async (change: (record: NkDirectEtrnRecord, data: OperationsData) => void, release = false) => store.mutate(source, data => {
    const record = authority(data);
    if (record.attemptId !== claimed.attemptId || record.leaseId !== leaseId || Date.parse(record.leaseUntil ?? '') <= Date.now()) throw new ApiError(409, 'Сеанс прямого обмена изменился.');
    change(record, data); record.updatedAt = stamp();
    record.leaseUntil = release ? null : new Date(Date.now() + 300_000).toISOString();
    if (release) record.leaseId = null;
    return { result: undefined, changed: true };
  });
  // Historical incomplete exchanges keep their saved execution boundary. Only
  // new sender-mode electronic snapshots opt into independent deliveries.
  const independent = claimed.deliveries.every(row => row.snapshot.loadingActorMode === 'sender' && row.snapshot.profile.instructions.redirectionMethod === NATIVE_APPROVED_REDIRECTION_METHOD);
  try {
    for (const row of claimed.deliveries) {
      await check();
      const exchanged = await exchangePreparedEtrn(context, { documentMode: 'nk-direct-v1', ...row });
      if (exchanged.status !== 'draft') { await update(record => { delete record.completedAt; record.phase = exchanged.status === 'error' ? 'error' : 'unknown'; record.lastError = exchanged.lastError; }); if (independent) continue; return; }
      if (claimed.completedAt) continue;
      await update(record => { record.phase = 'sending_etrn'; record.lastError = null; });
      const dispatched = await continueEtrnDispatch(context, row.shipmentId);
      if (!dispatched.completedAt) { await update(record => { record.lastError = dispatched.lastError; }); if (independent) continue; return; }
    }
    await update((record, data) => {
      const complete = record.deliveries.every(row => !!data.etrn?.trips[tripId]?.deliveries[row.shipmentId]?.document?.dispatch?.completedAt);
      const documents = record.deliveries.map(row => data.etrn?.trips[tripId]?.deliveries[row.shipmentId]?.document);
      record.lastCheckedAt = stamp();
      record.phase = complete ? 'completed' : documents.some(doc => !doc || doc.status !== 'draft') ? 'unknown' : 'sending_etrn';
      record.lastError = documents.map(doc => doc?.dispatch?.lastError || doc?.lastError).find(Boolean) ?? null;
      if (complete) record.completedAt ??= stamp();
      else delete record.completedAt;
    }, true);
    // Final local metadata and lease release share one durable transaction. There
    // is no provider action between them; errors/early returns still release below.
    released = true;
  } catch (error) {
    // Even when permissions were revoked, preserve diagnostics without granting another request.
    await store.mutate(source, data => {
      const record = data.etrn?.trips[tripId]?.direct;
      if (!record || record.attemptId !== claimed.attemptId || record.leaseId !== leaseId) return { result: undefined, changed: false };
      delete record.completedAt; record.phase = 'unknown'; record.lastError = error instanceof ApiError || error instanceof SabyError ? error.message : 'Прямой обмен требует сверки.'; record.updatedAt = stamp();
      return { result: undefined, changed: true };
    });
    if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
  } finally {
    if (!released) await store.mutate(source, data => {
      const record = data.etrn?.trips[tripId]?.direct;
      if (!record || record.attemptId !== claimed.attemptId || record.leaseId !== leaseId) return { result: undefined, changed: false };
      record.leaseId = null; record.leaseUntil = null; return { result: undefined, changed: true };
    });
  }
}

import { createHash, randomUUID } from 'node:crypto';
import type { ShipmentTrip, Snapshot } from '../web/src/model';
import type { TripSabyHistoryEntry, TripSabyMonitoring, TripSabyOrderSummary, TripSabyResponse } from '../web/src/trip-saby-model';
import { advanceTripSigning, authorizeSigningActor, beginTripSigning, ensureSigningCarrierDraft, publicTripSigning, validateSigningStart, validateTripSigning, type TripSigningRecord } from './trip-saby-signing';
import type { TripSabySigningStartRequest } from '../web/src/trip-saby-model';
import { publicUser } from './auth';
import { requireWholeTrip } from './auth-scope';
import { requireTripSection } from './permissions';
import { appendSabyHistory, sabyOrderProgress, sabyOrderStateCode, TRIP_SABY_HISTORY_LIMIT, tripSabyStages } from './trip-saby-progress';
import { verifySabySenderBusiness, verifySabyCarrierLink } from './saby-order-evidence';
import { ApiError } from './api-error';
import { carrierFastPolling, fillCarrierDetails, newCarrierFill, validateCarrierFill, type CarrierFillRecord } from './trip-saby-carrier';
import type { OperationsData, OperationsStorage } from './operations-store';
import { currentSnapshot } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import type { SabyConsignmentSnapshot } from './saby-consignment-note';
import { SabyClient, SabyError, sabyConfigFromEnv, sabyCredentialBlockers, sabyDocumentWorkflow, sabyObject, sabyText, type SabyConfig, type SabyObject } from './saby-client';
import { buildSabyTransportDocument, sabyTransportBlockers, serializeSabyTransportOrder, type SabyTransportSnapshot } from './saby-transport-order';

export interface TripSabyPreparation {
  scenario: 'artel_customer' | 'nk_own_customer';
  order: SabyTransportSnapshot;
  deliveries: Array<{ shipmentId: string; snapshot: SabyConsignmentSnapshot }>;
  blockers: string[];
}
export type PrepareTripSaby = (snapshot: Snapshot, data: OperationsData, trip: ShipmentTrip, config: SabyConfig) => TripSabyPreparation;
export interface TripSabyCarrierEvidence {
  revision: string;
  attachmentId: string;
  evidenceHash: string;
  confirmedAt: string;
  /** Saby-reported evidence, not local cryptographic validation. */
  stateCode: '7';
  carrierTitleHash?: string;
}
interface DeliveryRecord {
  shipmentId: string; snapshot: SabyConsignmentSnapshot; payloadHash: string;
  waitingForLoading?: boolean;
  id: string | null; status: 'not_sent' | 'pending' | 'unknown' | 'draft' | 'error'; lastError: string | null;
}
export interface TripSabyRecord {
  /** User who explicitly initiated this workflow; background continuation rechecks current rights. */
  initiatorId?: string;
  scenario: TripSabyPreparation['scenario'];
  snapshot: SabyTransportSnapshot; payloadHash: string;
  marker: string; attemptId: string; createdAt: string; updatedAt: string;
  leaseId: string | null; leaseUntil: string | null;
  reservationAttempted: boolean; uploadAttempted: boolean;
  unexpectedDocumentIds?: string[];
  order: TripSabyOrderSummary;
  carrierEvidence: TripSabyCarrierEvidence | null;
  carrierFill?: CarrierFillRecord;
  signing?: TripSigningRecord;
  phase: TripSabyResponse['phase']; lastError: string | null;
  /** These describe external observations, not local lease or storage writes. */
  lastCheckedAt?: string;
  lastCheckAttemptAt?: string;
  history?: TripSabyHistoryEntry[];
  deliveries: DeliveryRecord[];
}
export interface TripSabyData { trips: Record<string, TripSabyRecord> }
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const dated = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullable = (value: unknown) => value === null || typeof value === 'string';
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const rows = (value: unknown): SabyObject[] => Array.isArray(value) ? value.filter(sabyObject) : sabyObject(value) ? [value] : [];
const phases = ['preparation', 'submitting', 'unknown', 'awaiting_carrier', 'awaiting_loading', 'creating_etrn', 'completed', 'error'];

/** Unknown versions fail closed rather than silently discarding links to external documents. */
export function validateTripSabyData(value: unknown): asserts value is TripSabyData | undefined {
  if (value === undefined) return;
  if (!sabyObject(value) || !sabyObject(value.trips)) throw new Error('Invalid trip Saby storage');
  for (const [tripId, record] of Object.entries(value.trips)) {
    if (sabyObject(record)) { validateCarrierFill(record.carrierFill); validateTripSigning(record.signing); }
    if (sabyObject(record) && record.initiatorId !== undefined && !sabyText(record.initiatorId)) throw new Error('Invalid trip Saby initiator');
    if (!tripId || !sabyObject(record) || !['artel_customer', 'nk_own_customer'].includes(String(record.scenario)) || !sabyObject(record.snapshot) || record.snapshot.tripId !== tripId || record.snapshot.shipmentId !== tripId || !digest(record.payloadHash) || record.payloadHash !== hash(record.snapshot) || !dated(record.createdAt) || !dated(record.updatedAt) || !nullable(record.leaseId) || !(record.leaseUntil === null || dated(record.leaseUntil)) || typeof record.reservationAttempted !== 'boolean' || typeof record.uploadAttempted !== 'boolean' || typeof record.marker !== 'string' || !record.marker.startsWith('ARTEL-CRM:TRIP:') || typeof record.attemptId !== 'string' || !record.attemptId || !phases.includes(String(record.phase)) || !nullable(record.lastError) || !sabyObject(record.order) || !Array.isArray(record.deliveries) || !record.deliveries.length || record.deliveries.length > 100) throw new Error('Invalid trip Saby record');
    if (record.unexpectedDocumentIds !== undefined && (!Array.isArray(record.unexpectedDocumentIds) || record.unexpectedDocumentIds.some(id => typeof id !== 'string' || !id))) throw new Error('Invalid unexpected Saby document identifiers');
    if (record.signing) {
      const intent = record.signing as unknown as TripSigningRecord;
      if (intent.workflowAttemptId !== record.attemptId || intent.documentId !== record.order.id || intent.payloadHash !== record.payloadHash) throw new Error('Signing intent differs from saved trip');
      for (const side of ['sender', 'carrier'] as const) {
        const binding = intent[side].binding;
        const organization = (side === 'sender' ? record.snapshot.customerOrganization : record.snapshot.carrierOrganization) as SabyObject;
        const counterparty = (side === 'sender' ? record.snapshot.carrierOrganization : record.snapshot.customerOrganization) as SabyObject;
        if (binding && (binding.organizationInn !== organization.inn || binding.organizationKpp !== organization.kpp || binding.counterpartyInn !== counterparty.inn || binding.counterpartyKpp !== counterparty.kpp)) throw new Error('Signing binding differs from saved participants');
      }
      if (intent.carrierDraft && (intent.carrierDraft.binding.organizationInn !== (record.snapshot.carrierOrganization as SabyObject).inn || intent.carrierDraft.binding.organizationKpp !== (record.snapshot.carrierOrganization as SabyObject).kpp || intent.carrierDraft.binding.counterpartyInn !== (record.snapshot.customerOrganization as SabyObject).inn || intent.carrierDraft.binding.counterpartyKpp !== (record.snapshot.customerOrganization as SabyObject).kpp)) throw new Error('Carrier draft participants differ from saved trip');
    }
    const order = record.order;
    if (record.lastCheckedAt !== undefined && !dated(record.lastCheckedAt) || record.lastCheckAttemptAt !== undefined && !dated(record.lastCheckAttemptAt) || order.remoteStateCode !== undefined && order.remoteStateCode !== null && (typeof order.remoteStateCode !== 'string' || !/^\d{1,3}$/.test(order.remoteStateCode)) || order.exchangeStage !== undefined && !tripSabyStages.includes(order.exchangeStage as TripSabyOrderSummary['exchangeStage'] & string)) throw new Error('Invalid Saby progress');
    if (record.history !== undefined && (!Array.isArray(record.history) || record.history.length > TRIP_SABY_HISTORY_LIMIT || record.history.some(entry => !sabyObject(entry) || !dated(entry.at) || !tripSabyStages.includes(entry.stage as TripSabyOrderSummary['exchangeStage'] & string) || entry.remoteStateCode !== null && (typeof entry.remoteStateCode !== 'string' || !/^\d{1,3}$/.test(entry.remoteStateCode)) || Object.keys(entry).some(key => !['at', 'stage', 'remoteStateCode'].includes(key))))) throw new Error('Invalid Saby progress history');
    if (!['pending', 'unknown', 'draft', 'error'].includes(String(order.status)) || !['not_signed', 'reported_by_saby', 'unknown'].includes(String(order.signatureStatus)) || !['id', 'number', 'date', 'url', 'revision', 'remoteStatus'].every(key => nullable(order[key])) || order.status === 'draft' && (!order.id || !order.number || !order.revision) || record.uploadAttempted && (!order.id || !order.number)) throw new Error('Invalid trip Saby order');
    if (record.carrierEvidence !== null && (!sabyObject(record.carrierEvidence) || record.carrierEvidence.stateCode !== '7' || !dated(record.carrierEvidence.confirmedAt) || !digest(record.carrierEvidence.evidenceHash) || !sabyText(record.carrierEvidence.revision) || !sabyText(record.carrierEvidence.attachmentId))) throw new Error('Invalid Saby carrier evidence');
    const ids = new Set<string>();
    for (const delivery of record.deliveries) {
      if (!sabyObject(delivery) || !sabyText(delivery.shipmentId) || ids.has(String(delivery.shipmentId)) || !sabyObject(delivery.snapshot) || delivery.snapshot.tripId !== tripId || delivery.snapshot.shipmentId !== delivery.shipmentId || !digest(delivery.payloadHash) || delivery.payloadHash !== hash(delivery.snapshot) || !nullable(delivery.id) || !nullable(delivery.lastError) || !['not_sent', 'pending', 'unknown', 'draft', 'error'].includes(String(delivery.status)) || delivery.status === 'draft' && !delivery.id) throw new Error('Invalid trip Saby delivery');
      ids.add(String(delivery.shipmentId));
    }
    if (record.phase === 'completed' && record.signing && ((record.signing as unknown as TripSigningRecord).sender.state !== 'confirmed' || (record.signing as unknown as TripSigningRecord).carrier.state !== 'confirmed')) throw new Error('Unconfirmed completed signing workflow');
    if (record.phase === 'completed' && (!record.carrierEvidence || record.deliveries.some(row => (row as DeliveryRecord).status !== 'draft'))) throw new Error('Invalid completed Saby workflow');
  }
}
export function hasTripSabyWorkflow(data: OperationsData, tripId: string): boolean { return !!data.tripSaby?.trips[tripId]; }
const legacyBlockers = (data: OperationsData, tripId: string) => data.saby?.trips[tripId]?.documents.some(doc => doc.status !== 'error' || doc.id) || Object.values(data.etrn?.trips[tripId]?.deliveries ?? {}).some(row => row.document && (row.document.status !== 'error' || row.document.id)) ? ['По рейсу уже есть документы прежнего обмена. Проверьте сохранённые связи в Saby; общая заявка автоматически не создаётся.'] : [];
function preparationBlockers(preparation: TripSabyPreparation, trip: ShipmentTrip, data: OperationsData): string[] {
  const ids = preparation.deliveries.map(row => row.shipmentId);
  const actualIds = trip.customers.map(row => row.id);
  const errors = [...preparation.blockers, ...sabyTransportBlockers(preparation.order), ...legacyBlockers(data, trip.id)];
  if (!actualIds.length || ids.length !== actualIds.length || new Set(ids).size !== ids.length || actualIds.some(id => !ids.includes(id)) || preparation.order.tripId !== trip.id || preparation.order.shipmentId !== trip.id || preparation.deliveries.some(row => row.snapshot.tripId !== trip.id || row.snapshot.shipmentId !== row.shipmentId)) errors.push('Подготовка должна охватывать каждую доставку сохранённого рейса.');
  if (!preparation.order.deliveries || preparation.order.deliveries.length !== actualIds.length || preparation.order.deliveries.some((row, index) => row.shipmentId !== actualIds[index])) errors.push('Маршрут общей заявки должен сохранять порядок всех доставок рейса.');
  return [...new Set(errors)];
}
interface GetOptions { base: Snapshot; data: OperationsData; tripId: string; prepare: PrepareTripSaby; config?: SabyConfig; monitoringEnabled?: boolean }
function monitoringStatus(enabled: boolean, record: TripSabyRecord | undefined, snapshot: Snapshot, data: OperationsData, tripId: string, credentialsReady: boolean): TripSabyMonitoring {
  const disabled = (reason: string): TripSabyMonitoring => ({ enabled: false, intervalSeconds: null, reason });
  if (!enabled) return disabled('Автопроверка Saby на этом сервере не включена. Состояние можно обновить вручную.');
  if (!credentialsReady) return disabled('Автопроверка ожидает настройки доступа к Saby.');
  if (!record) return disabled('Автопроверка начнётся после создания заявки.');
  const authorityId = record.signing?.requestedBy ?? record.initiatorId;
  if (!authorityId) return disabled('У сохранённой попытки нет инициатора фонового обмена. Обновите состояние вручную.');
  try {
    const user = data.accounts?.users.find(row => row.id === authorityId && row.active && !row.deletedAt);
    if (!user) return disabled('Автопроверка приостановлена: у инициатора нет доступа.');
    const actor = publicUser(user); requireTripSection(actor, true); requireWholeTrip(actor, snapshot, tripId); authorizeSigningActor(snapshot, data, tripId, record);
  } catch { return disabled('Автопроверка приостановлена: у инициатора нет доступа к рейсу.'); }
  if (record.phase === 'error') return disabled('Автопроверка приостановлена после ошибки. Исправьте документ и выполните сверку.');
  return { enabled: true, intervalSeconds: carrierFastPolling(record) ? 15 : 300 };
}
export function getTripSabyWorkflow({ base, data, tripId, prepare, config = sabyConfigFromEnv(), monitoringEnabled = false }: GetOptions): TripSabyResponse {
  const snapshot = currentSnapshot(base, data); const trip = getShipmentTrip(snapshot, tripId);
  const record = data.tripSaby?.trips[tripId];
  const blockers = record ? sabyCredentialBlockers(config) : [...sabyCredentialBlockers(config), ...preparationBlockers(prepare(snapshot, data, trip, config), trip, data)];
  const monitoring = monitoringStatus(monitoringEnabled, record, snapshot, data, tripId, sabyCredentialBlockers(config).length === 0);
  if (!record) return { status: 'not_sent', phase: 'preparation', ready: blockers.length === 0, blockers: [...new Set(blockers)], locked: false, updatedAt: null, lastError: null, order: null, deliveries: trip.customers.map(row => ({ shipmentId: row.id, id: null, status: 'not_sent', lastError: null })), carrierConfirmed: false, lastCheckedAt: null, lastCheckAttemptAt: null, monitoring, history: [] };
  const expired = record.leaseId !== null && (!record.leaseUntil || Date.parse(record.leaseUntil) <= Date.now());
  const phase = expired && ['submitting', 'creating_etrn'].includes(record.phase) ? 'unknown' : record.phase;
  const sent = !!record.carrierEvidence || ['3', '4', '7'].includes(record.order.remoteStateCode ?? '');
  return { status: ['error', 'unknown'].includes(phase) ? 'error' : sent ? 'sent' : 'not_sent', phase, ready: blockers.length === 0, blockers, locked: true, updatedAt: record.updatedAt, lastError: record.lastError, order: { ...record.order, exchangeStage: record.order.exchangeStage ?? (record.carrierEvidence ? 'carrier_confirmed' : 'unknown'), status: expired && record.order.status === 'pending' ? 'unknown' : record.order.status }, deliveries: record.deliveries.map(({ shipmentId, id, status, lastError }) => ({ shipmentId, id, status: expired && status === 'pending' ? 'unknown' : status, lastError })), carrierConfirmed: !!record.carrierEvidence, lastCheckedAt: record.lastCheckedAt ?? null, lastCheckAttemptAt: record.lastCheckAttemptAt ?? null, monitoring, history: record.history ?? [], ...(record.carrierFill ? { carrierFill: { state: record.carrierFill.state, blockers: record.carrierFill.blockers, driverSaved: record.carrierFill.driverSaved, vehicleSaved: record.carrierFill.vehicleSaved, ...(record.carrierFill.responsibleSaved !== undefined ? { responsibleSaved: record.carrierFill.responsibleSaved } : {}), checkedAt: record.carrierFill.checkedAt } } : {}), ...(record.signing ? { signing: publicTripSigning(record.signing) } : {}), carrierHandoff: { driverName: record.snapshot.driver?.name ?? null, driverPhone: record.snapshot.driver?.phone ?? null, vehiclePlate: record.snapshot.vehicle?.plate ?? null, vehicleType: record.snapshot.vehicle?.type ?? null } };
}
function sameOrganization(raw: unknown, organization: SabyTransportSnapshot['customerOrganization']) {
  return sabyObject(raw) && sabyObject(raw.СвЮЛ) && raw.СвЮЛ.ИНН === organization.inn && raw.СвЮЛ.КПП === organization.kpp;
}
function validateRemoteIdentity(remote: SabyObject, record: TripSabyRecord): { number: string; revision: string | null } {
  const number = sabyText(remote.Номер);
  if (remote.Тип !== 'TransportOrder' || remote.Идентификатор !== record.order.id || remote.Примечание !== record.marker || !number || record.order.number && number !== record.order.number || remote.Дата !== record.snapshot.fields.date?.split('-').reverse().join('.') || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да' || !sameOrganization(remote.НашаОрганизация, record.snapshot.customerOrganization) || !sameOrganization(remote.Контрагент, record.snapshot.carrierOrganization)) throw new SabyError('unknown', 'Saby не подтвердил номер, дату, метку или участников сохранённой заявки. Повторное создание запрещено.', true);
  return { number, revision: sabyDocumentWorkflow(remote).revision };
}
const hasErrors = (value: SabyObject) => Number(value.КоличествоОшибок ?? 0) > 0 || !!value.Ошибка || Array.isArray(value.Ошибки) && value.Ошибки.length > 0;
function activeAttachments(remote: SabyObject): SabyObject[] {
  const revision = sabyDocumentWorkflow(remote).revision;
  return rows(remote.Вложение).filter(row => {
    if (row.Удален === 'Да' || row.Актуален === 'Нет') return false;
    // Standard attachment revision is { Номер, ДатаВремя }, not the document UUID.
    // readTransportOrder reads the current document; compare only an explicit UUID extension.
    const explicitRevision = sabyObject(row.Редакция) ? sabyText(row.Редакция.Идентификатор) : sabyText(row.Редакция);
    return !explicitRevision || explicitRevision === revision;
  });
}
function confirmOrder(remote: SabyObject, record: TripSabyRecord): TripSabyOrderSummary {
  const { number, revision } = validateRemoteIdentity(remote, record);
  const titles = activeAttachments(remote).filter(row => row.Подтип === '1110361' && row.ВерсияФормата === '5.01');
  if (!revision || titles.length !== 1 || hasErrors(remote) || titles.some(hasErrors) || sabyObject(remote.Состояние) && hasErrors(remote.Состояние)) throw new SabyError('unknown', 'Saby не подтвердил единственный актуальный титул заявки 1110361 и его проверку. Откройте заявку в Saby; новое создание запрещено.', true);
  const workflow = sabyDocumentWorkflow(remote);
  return { ...record.order, id: String(remote.Идентификатор), number, revision, date: record.snapshot.fields.date!, status: 'draft', url: workflow.url, remoteStatus: workflow.remoteStatus, signatureStatus: workflow.signatureStatus };
}
/** Exact approved state plus the carrier's signed title, never a status label or sender signature. */
export function sabyCarrierAcceptance(remote: SabyObject): TripSabyCarrierEvidence | null {
  const state = sabyObject(remote.Состояние) ? remote.Состояние : {};
  const code = state.Код === undefined ? sabyObject(remote.Код) ? String(remote.Код.Состояние ?? '') : '' : String(state.Код);
  const legacyCode = sabyObject(remote.Код) ? String(remote.Код.Состояние ?? '') : '';
  if (code !== '7' || legacyCode && legacyCode !== code || hasErrors(remote) || hasErrors(state) || [remote.НеполнаяОбработка, state.НеполнаяОбработка, state.Сложное].some(value => value === true || value === 'Да' || value === '1')) return null;
  const revision = sabyDocumentWorkflow(remote).revision;
  const titles = activeAttachments(remote).filter(row => row.Подтип === '1110362' && row.ВерсияФормата === '5.01');
  if (!revision || titles.length !== 1 || hasErrors(titles[0]) || !sabyText(titles[0].Идентификатор)) return null;
  const signatures = rows(titles[0].Подпись).filter(signature => !hasErrors(signature) && ((sabyObject(signature.Файл) && (sabyText(signature.Файл.Ссылка) || sabyText(signature.Файл.ДвоичныеДанные))) || (sabyObject(signature.Сертификат) && sabyText(signature.Сертификат.Отпечаток))));
  if (!signatures.length) return null;
  return { revision, attachmentId: String(titles[0].Идентификатор), evidenceHash: hash([titles[0].Идентификатор, revision, signatures.map(signature => [signature.ДатаВремя, signature.Тип, signature.Сертификат, sabyObject(signature.Файл) ? signature.Файл.Хеш ?? signature.Файл.ДвоичныеДанные : null])]), confirmedAt: now(), stateCode: '7' };
}

export interface CreateTripSabyDelivery {
  shipmentId: string; snapshot: SabyConsignmentSnapshot;
  order: { id: string; number: string; date: string };
  carrierEvidence: TripSabyCarrierEvidence; remoteOrder: SabyObject;
}
export interface RunTripSabyOptions {
  base: Snapshot; store: OperationsStorage; tripId: string; prepare: PrepareTripSaby;
  initiatorId?: string;
  monitoringEnabled?: boolean;
  enableCarrierFill?: boolean;
  signingStart?: { request: TripSabySigningStartRequest; requestedBy: string };
  authorize: (snapshot: Snapshot, data: OperationsData) => void; client?: SabyClient;
  /** Must preserve ETRN ID-before-read and unknown-result recovery in its own durable record. */
  createDelivery: (input: CreateTripSabyDelivery, client: SabyClient) => Promise<{ status: 'pending' | 'unknown' | 'draft' | 'error'; id: string | null; lastError: string | null; waitingForLoading?: boolean }>;
}

/** One durable lease covers documents and an explicitly requested signing chain. */
export async function runTripSabyWorkflow(options: RunTripSabyOptions): Promise<TripSabyResponse> {
  const { base, store, tripId, authorize, prepare, createDelivery } = options;
  let client = options.client ?? new SabyClient(sabyConfigFromEnv());
  if (options.signingStart) validateSigningStart(options.signingStart.request);
  const source = base.provenance.sourceSha256; const leaseId = randomUUID();
  const claimed = await store.mutate(source, data => {
    const snapshot = currentSnapshot(base, data); authorize(snapshot, data);
    const trip = getShipmentTrip(snapshot, tripId); const existing = data.tripSaby?.trips[tripId];
    if (existing?.signing) authorizeSigningActor(snapshot, data, tripId, existing);
    if (options.signingStart) {
      const requester = data.accounts?.users.find(row => row.id === options.signingStart!.requestedBy && row.active && !row.deletedAt);
      if (!requester) throw new ApiError(403, 'Для подписания нужен действующий доступ сотрудника.');
      requireTripSection(publicUser(requester), true); requireWholeTrip(publicUser(requester), snapshot, tripId);
    }
    if (existing?.leaseId && existing.leaseUntil && Date.parse(existing.leaseUntil) > Date.now()) throw new ApiError(409, 'Обмен этого рейса уже выполняется. Обновите состояние позже.');
    const credentials = sabyCredentialBlockers(client.config); if (credentials.length) throw new ApiError(422, credentials.join(' '));
    if (options.signingStart && !existing?.order.id) throw new ApiError(409, 'Сначала создайте заявку рейса в Saby.');
    if (existing?.phase === 'completed') return { result: null, changed: false };
    let record = existing;
    if (options.enableCarrierFill && !existing?.order.id) throw new ApiError(409, 'Сначала создайте заявку рейса в Saby.');
    if (!record) {
      const prepared = prepare(snapshot, data, trip, client.config); const errors = preparationBlockers(prepared, trip, data);
      if (errors.length) throw new ApiError(422, errors.join(' '));
      const stamp = now();
      record = { scenario: prepared.scenario, snapshot: structuredClone(prepared.order), payloadHash: hash(prepared.order), marker: `ARTEL-CRM:TRIP:${randomUUID()}`, attemptId: randomUUID(), createdAt: stamp, updatedAt: stamp, leaseId: null, leaseUntil: null, reservationAttempted: false, uploadAttempted: false, order: { id: null, number: null, date: prepared.order.fields.date, status: 'pending', url: null, revision: null, remoteStatus: null, signatureStatus: 'unknown' }, carrierEvidence: null, phase: 'submitting', lastError: null, deliveries: prepared.deliveries.map(row => ({ shipmentId: row.shipmentId, snapshot: structuredClone(row.snapshot), payloadHash: hash(row.snapshot), id: null, status: 'not_sent', lastError: null })) };
      if (options.initiatorId) record.initiatorId = options.initiatorId;
      record.carrierFill = newCarrierFill();
      data.tripSaby ??= { trips: {} }; data.tripSaby.trips[tripId] = record;
    }
    if (options.enableCarrierFill && !record.carrierFill) {
      record.carrierFill = newCarrierFill();
      if (options.initiatorId) record.initiatorId = options.initiatorId;
    }
    for (const row of record.deliveries) if (row.status === 'pending') row.status = 'unknown';
    if (record.order.status === 'pending' && record.reservationAttempted) record.order.status = 'unknown';
    record.leaseId = leaseId; record.leaseUntil = new Date(Date.now() + 300_000).toISOString(); record.updatedAt = now();
    return { result: structuredClone(record), changed: true };
  });
  if (!claimed) { const data = await store.read(source); authorize(currentSnapshot(base, data), data); return getTripSabyWorkflow({ base, data, tripId, prepare, config: client.config, monitoringEnabled: options.monitoringEnabled }); }
  let record = claimed;
  const update = async (mutate: (current: TripSabyRecord) => void) => {
    record = await store.mutate(source, data => {
      const current = data.tripSaby?.trips[tripId];
      if (!current || current.leaseId !== leaseId || !current.leaseUntil || Date.parse(current.leaseUntil) <= Date.now()) throw new ApiError(409, 'Сеанс обмена рейса изменился. Выполните сверку Saby.');
      mutate(current); current.updatedAt = now(); current.leaseUntil = new Date(Date.now() + 300_000).toISOString();
      return { result: structuredClone(current), changed: true };
    });
  };
  const checkAccess = async () => {
    const data = await store.read(source); const snapshot = currentSnapshot(base, data); authorize(snapshot, data);
    const current = data.tripSaby?.trips[tripId];
    if (!current || current.leaseId !== leaseId || !current.leaseUntil || Date.parse(current.leaseUntil) <= Date.now()) throw new ApiError(409, 'Сеанс обмена рейса истёк или изменился. Обновите состояние.');
    authorizeSigningActor(snapshot, data, tripId, current);
  };
  client = client.withRequestGuard(checkAccess);
  const signingContext = { client, record: () => record, update, checkAccess };
  let signingStarted = !options.signingStart;
  let writing: 'reservation' | 'upload' | null = null;
  let armedAction: 'reservation' | 'upload' | null = null;
  try {
    if (options.signingStart) {
      await beginTripSigning(client, record, options.signingStart.request, options.signingStart.requestedBy, update);
      signingStarted = true;
    }
    await client.verifyOrganizations(record.snapshot.customerOrganization, record.snapshot.carrierOrganization);
    await checkAccess();
    if (!record.order.id && record.reservationAttempted) {
      const found = await client.findDocuments(record.marker, record.order.date!.split('-').reverse().join('.'), record.snapshot.customerOrganization, record.order.number ?? undefined);
      if (found.length !== 1 || !sabyText(found[0].Идентификатор)) throw new SabyError('unknown', found.length ? 'Найдено несколько совпадений заявки. Нужна ручная сверка; новое создание запрещено.' : 'Прежняя заявка пока не найдена. Результат неизвестен; повторное создание запрещено.', true);
      await update(row => { row.order.id = sabyText(found[0].Идентификатор); row.order.status = 'unknown'; });
      await checkAccess();
    }
    if (!record.order.id) {
      armedAction = 'reservation';
      await update(row => { row.reservationAttempted = true; row.phase = 'submitting'; row.order.status = 'pending'; row.lastError = null; });
      await checkAccess(); writing = 'reservation'; armedAction = null;
      const reserved = await client.reserveNumberedDocument({ Тип: 'TransportOrder', Регламент: { Название: 'Заказ на перевозку' }, Дата: record.order.date!.split('-').reverse().join('.'), Примечание: record.marker, НашаОрганизация: { СвЮЛ: { ИНН: record.snapshot.customerOrganization.inn, КПП: record.snapshot.customerOrganization.kpp } }, Контрагент: { Идентификатор: record.snapshot.carrierOrganization.edoId, СвЮЛ: { ИНН: record.snapshot.carrierOrganization.inn, КПП: record.snapshot.carrierOrganization.kpp } } });
      await update(row => { row.order.id = sabyText(reserved.Идентификатор); row.order.status = 'unknown'; });
      writing = null;
      await checkAccess();
    }
    await update(row => { row.lastCheckAttemptAt = now(); });
    let remote = await client.readTransportOrder(record.order.id!);
    const identity = validateRemoteIdentity(remote, record);
    await update(row => { row.order.number = identity.number; row.order.revision = identity.revision; row.order.url = sabyDocumentWorkflow(remote).url; });
    await checkAccess();
    const hasTitle = activeAttachments(remote).some(row => row.Подтип === '1110361');
    if (!hasTitle && !['6', '9', '22'].includes(sabyOrderStateCode(remote) ?? '')) {
      if (record.uploadAttempted) throw new SabyError('unknown', 'Результат загрузки титула заявки пока не подтверждён. Повторная загрузка запрещена; проверьте сохранённую заявку в Saby.', true);
      const document = buildSabyTransportDocument(record.snapshot, record.marker, record.attemptId, record.createdAt, record.order.number!);
      armedAction = 'upload';
      await update(row => { row.uploadAttempted = true; row.order.status = 'pending'; row.phase = 'submitting'; });
      await checkAccess(); writing = 'upload'; armedAction = null;
      const uploaded = await client.writeDocument({ ...document, Идентификатор: record.order.id });
      if (uploaded.Идентификатор !== record.order.id) {
        await update(row => { const unexpected = sabyText(uploaded.Идентификатор); if (unexpected) row.unexpectedDocumentIds = [...new Set([...(row.unexpectedDocumentIds ?? []), unexpected])]; });
        throw new SabyError('unknown', 'Saby вернул другой идентификатор при дополнении заявки. Новое создание запрещено.', true);
      }
      writing = null;
      await checkAccess();
      await update(row => { row.lastCheckAttemptAt = now(); });
      remote = await client.readTransportOrder(record.order.id!);
    }
    if (record.signing) {
      await advanceTripSigning(signingContext, 'sender');
      await checkAccess(); remote = await client.readTransportOrder(record.order.id!);
    }
    let stateCode = sabyOrderStateCode(remote);
    let stopped = stateCode !== null && ['6', '9', '22'].includes(stateCode);
    // Terminal operator states may themselves contain validation errors. Confirm identity,
    // retain the operator's state, and stop before creating any downstream document.
    validateRemoteIdentity(remote, record);
    const workflow = sabyDocumentWorkflow(remote);
    let order = stopped ? { ...record.order, revision: workflow.revision, url: workflow.url, remoteStatus: workflow.remoteStatus, signatureStatus: workflow.signatureStatus } : confirmOrder(remote, record);
    const observed = sabyOrderProgress(remote);
    await update(row => {
      if (row.carrierFill?.state === 'waiting' && ['3', '4'].includes(observed.remoteStateCode ?? '') && !['3', '4'].includes(row.order.remoteStateCode ?? '')) row.carrierFill.requestedAt = now();
      row.order = { ...order, ...observed }; row.lastCheckedAt = now();
      row.carrierEvidence = null;
    });
    if (stateCode === '4' && record.signing) await ensureSigningCarrierDraft(signingContext);
    if (stateCode === '4' && record.carrierFill && !record.signing?.carrier.binding && (!record.signing || record.signing.sender.state === 'confirmed' && record.signing.carrier.state !== 'blocked' && (!record.signing.carrierDraft || record.signing.carrierDraft.state === 'ready'))) {
      await fillCarrierDetails({ client, record, update, checkAccess, snapshot: async () => {
        const data = await store.read(source); const snapshot = currentSnapshot(base, data); authorize(snapshot, data); return snapshot;
      } });
    }
    if (record.signing) {
      await advanceTripSigning(signingContext, 'carrier');
      // Recheck both exact signatures immediately before allowing downstream documents.
      await advanceTripSigning(signingContext, 'sender');
      await checkAccess(); remote = await client.readTransportOrder(record.order.id!);
      stateCode = sabyOrderStateCode(remote); stopped = stateCode !== null && ['6', '9', '22'].includes(stateCode);
      order = stopped ? { ...record.order, ...sabyDocumentWorkflow(remote) } : confirmOrder(remote, record);
    }
    let evidence = stopped || record.signing && (record.signing.sender.state !== 'confirmed' || record.signing.carrier.state !== 'confirmed') ? null : sabyCarrierAcceptance(remote);
    if (evidence) {
      await checkAccess();
      const senderTitle = activeAttachments(remote).find(row => row.Подтип === '1110361')!;
      const senderTitleId = sabyText(senderTitle.Идентификатор);
      if (!senderTitleId) throw new SabyError('unknown', 'Saby не вернул идентификатор текущего титула отправителя. Новые ЭТрН не создаются.', true);
      const senderAttachment = await client.downloadTransportOrderAttachment(record.order.id!, senderTitleId, evidence.revision);
      const frozenTitle = serializeSabyTransportOrder(record.snapshot, record.attemptId, record.createdAt, record.order.number!);
      const senderIdentity = verifySabySenderBusiness(senderAttachment.bytes, frozenTitle.xml);
      await checkAccess();
      const attachment = await client.downloadTransportOrderAttachment(record.order.id!, evidence.attachmentId, evidence.revision);
      verifySabyCarrierLink(attachment.bytes, senderIdentity);
      evidence = { ...evidence, carrierTitleHash: createHash('sha256').update(attachment.bytes).digest('hex') };
      await checkAccess();
    }
    await update(row => {
      const progress = sabyOrderProgress(remote, !!evidence);
      if (!evidence && progress.remoteStateCode === '4' && row.carrierFill?.state === 'saved') progress.exchangeStage = 'carrier_action_required';
      row.order = { ...order, ...progress }; row.carrierEvidence = evidence;
      row.history = appendSabyHistory(row.history, { at: row.lastCheckedAt!, stage: progress.exchangeStage, remoteStateCode: progress.remoteStateCode });
      row.phase = stopped ? 'error' : evidence ? 'creating_etrn' : 'awaiting_carrier';
      row.lastError = stateCode === '9' ? 'Перевозчик отклонил заявку в Saby. Исправления выполняются в Saby.' : stateCode === '6' ? 'Saby сообщил об ошибке обработки заявки. Проверьте документ в Saby.' : stateCode === '22' ? 'Заявка аннулирована в Saby. Автоматическое продолжение остановлено.' : null;
    });
    await checkAccess();
    if (evidence) {
      for (const delivery of record.deliveries) {
        if (delivery.status === 'draft') continue;
        await checkAccess();
        if (record.signing) {
          await advanceTripSigning(signingContext, 'sender'); await advanceTripSigning(signingContext, 'carrier');
          if (record.signing.sender.state !== 'confirmed' || record.signing.carrier.state !== 'confirmed') throw new SabyError('validation', 'Подписи сторон больше не подтверждены. Создание ЭТрН остановлено.');
        }
        await update(row => { const current = row.deliveries.find(item => item.shipmentId === delivery.shipmentId)!; current.status = current.status === 'unknown' ? 'unknown' : 'pending'; current.lastError = null; current.waitingForLoading = false; });
        try {
          const result = await createDelivery({ shipmentId: delivery.shipmentId, snapshot: structuredClone(delivery.snapshot), order: { id: record.order.id!, number: record.order.number!, date: record.order.date! }, carrierEvidence: evidence, remoteOrder: remote }, client);
          await update(row => { Object.assign(row.deliveries.find(item => item.shipmentId === delivery.shipmentId)!, result); });
          await checkAccess();
          // A partial network result stops further writes; already-created IDs are retained.
          if (result.status !== 'draft') break;
        } catch (error) {
          await update(row => { const current = row.deliveries.find(item => item.shipmentId === delivery.shipmentId)!; current.status = error instanceof ApiError && [400, 403, 422].includes(error.status) && !current.id ? 'error' : 'unknown'; current.lastError = error instanceof SabyError || error instanceof ApiError ? error.message : 'Результат создания ЭТрН не подтверждён. Выполните сверку.'; });
          if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
          break;
        }
      }
      await update(row => { const failure = row.deliveries.find(item => item.status !== 'draft'); row.phase = !failure ? 'completed' : failure.waitingForLoading ? 'awaiting_loading' : failure.status === 'unknown' || failure.status === 'pending' ? 'unknown' : 'error'; row.lastError = failure?.lastError ?? null; });
    }
  } catch (error) {
    if (!signingStarted) throw error;
    // If authorization/storage failed after intent persistence but before invoking the client, no external write ran.
    const definite = armedAction !== null || error instanceof SabyError && !error.uncertain && ['authorization', 'permission', 'configuration', 'validation'].includes(error.kind);
    await update(row => {
      const rejectedAction = armedAction ?? (definite ? writing : null);
      if (rejectedAction) { if (rejectedAction === 'reservation') row.reservationAttempted = false; else row.uploadAttempted = false; }
      const uncertain = !definite && (row.reservationAttempted || row.uploadAttempted) || error instanceof SabyError && error.uncertain;
      if (row.order.status !== 'draft') row.order.status = uncertain ? 'unknown' : 'error';
      row.phase = uncertain ? 'unknown' : 'error';
      row.lastError = error instanceof SabyError || error instanceof ApiError ? error.message : 'Обмен Saby не подтверждён. Выполните сверку состояния.';
      if (row.lastCheckedAt && row.order.exchangeStage) row.history = appendSabyHistory(row.history, { at: row.lastCheckedAt, stage: row.order.exchangeStage, remoteStateCode: row.order.remoteStateCode ?? null });
    });
    if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
  } finally {
    await store.mutate(source, data => {
      const row = data.tripSaby?.trips[tripId]; if (!row || row.leaseId !== leaseId) return { result: undefined, changed: false };
      row.leaseId = null; row.leaseUntil = null; row.updatedAt = now();
      return { result: undefined, changed: true };
    });
  }
  const data = await store.read(source); authorize(currentSnapshot(base, data), data);
  return getTripSabyWorkflow({ base, data, tripId, prepare, config: client.config, monitoringEnabled: options.monitoringEnabled });
}

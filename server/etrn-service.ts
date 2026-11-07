import { requiresEtrn, requireEtrnDelivery } from './trip-etrn-scope';
import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Snapshot } from '../web/src/model';
import type { SabyConsignmentProfile } from '../web/src/etrn-model';
import type { EtrnTripResponse, EtrnDocumentSummary } from '../web/src/etrn-api-model';
import { ApiError } from './api-error';
import type { OperationsData, OperationsStorage } from './operations-store';
import { currentSnapshot } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import { SabyClient, SabyError, SabyRequestError, isSabyRequestIntent, isSabyResponseDiagnostic, type SabyRequestIntent, type SabyResponseDiagnostic, sabyConfigFromEnv, sabyConfigurationBlockers, sabyCredentialBlockers, sabyDocumentWorkflow, sabyObject, sabyText, type SabyConfig, type SabyObject } from './saby-client';
import { buildSabyConsignmentSnapshot, readSabyConsignmentProfile, sabyConsignmentBlockers, buildSabyConsignmentDocument, serializeSabyConsignmentNote, type SabyConsignmentSnapshot } from './saby-consignment-note';
import type { CreateTripSabyDelivery } from './trip-saby-workflow';
import { validateEtrnDispatch, type EtrnDispatch } from './etrn-dispatch';
import { reconcileLinkedConsignmentDraft, validateLinkedDraftState, type LinkedDraftState } from './etrn-linked-draft';
import { validConsignmentOperatorUid, verifyConsignmentSenderBusiness } from './saby-consignment-evidence';
import { assertTripTransportDocumentsAllowed, isNkDirectEtrn } from './trip-document-mode';
import { validateNkDirectAutostart, type NkDirectAutostart } from './nk-direct-autostart';
import { authorizeNkDirectEtrn, preparedNkDirectEtrn, validateNkDirectEtrn, type NkDirectEtrnRecord } from './nk-direct-etrn';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stamp = () => new Date().toISOString();
const isDate = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullable = (v: unknown) => v === null || typeof v === 'string';
const LEASE_MS = 300_000;

interface EtrnArtifact { key: string; attachmentId: string; revision: string | null; name: string; extension: string; sha256?: string; size?: number; content?: string }
export interface EtrnWriteAttempt {
  action: 'reservation' | 'upload'; request: SabyRequestIntent;
  outcome: 'attempted' | 'received' | 'uncertain' | 'denied';
  response?: SabyResponseDiagnostic; result?: { id: string; receivedAt: string };
}
/** Explicit adoption of an independently created native draft; never resolves a prior unknown reservation. */
export interface EtrnNativeAdoptionEvidence {
  version: 'native-ui-adoption-v1'; origin: 'independently_created_native_ui';
  nativeDocumentId: string; nativeNumber: string; nativeRevision: string; nativeAttachmentId: string;
  nativeXmlSha256: string; nativeReadSha256: string; uiEvidenceSha256: string; planSha256: string; sourceSnapshotSha256: string;
  originalAttemptId: string; originalMarker: string; originalDocumentSha256: string;
  originalReservationAttempted: boolean; originalReservationOutcome: 'unknown' | 'not_attempted';
  originalWriteAttemptsCount: number; originalWriteAttemptsSha256: string;
  actorId: string; adoptedAt: string; stage: 'planned' | 'verified'; holdForReview: boolean;
  verified?: { at: string; revision: string; attachmentId: string; xmlSha256: string; remoteSha256: string };
}
export const DIRECT_ETRN_NUMBER_BLOCKER = 'Saby не подтвердил способ выдачи номера прямой ЭТрН до загрузки Т1. Пустое резервирование отключено; нумерация Saby сохраняется. Требуется подтверждение API нумерации от Saby.';
export interface EtrnDocument extends Omit<EtrnDocumentSummary, 'files'> {
  dispatch?: EtrnDispatch;
  /** Opt-in only when a new unsigned T1 is about to be uploaded. Historical XML stays unchanged. */
  senderTitleVersion?: 2;
  nativeAdoptionEvidence?: EtrnNativeAdoptionEvidence;
  /** Durable request fingerprints and safe outcomes; never headers, parameters or raw response bodies. */
  writeAttempts?: EtrnWriteAttempt[];
  /** Original native draft and exact requested fill; never replaces the frozen delivery. */
  linkedDraft?: LinkedDraftState;
  /** New driver attempts opt in; historical uncertain attempts require explicit scoped recovery. */
  nativeDraftEnabled?: boolean;
  number?: string; reservationAttempted?: boolean; uploadAttempted?: boolean;
  unexpectedDocumentIds?: string[];
  marker: string; attemptId: string; createdAt: string; payloadHash: string;
  snapshot: SabyConsignmentSnapshot; artifacts: EtrnArtifact[];
  leaseId: string | null; leaseUntil: string | null;
}
interface EtrnDelivery { profile: SabyConsignmentProfile; snapshot: SabyConsignmentSnapshot; preparedHash: string; document: EtrnDocument | null; updatedAt: string; sourceOrderId?: string }
export interface TripLoadingFacts {
  arrivedAt: string; departedAt: string;
  deliveries: Record<string, { grossMassTonnes: string; massMethod: string }>;
  recordedAt: string; actorId: string;
}
export interface EtrnData { trips: Record<string, { deliveries: Record<string, EtrnDelivery>; updatedAt: string; loadingFacts?: TripLoadingFacts; direct?: NkDirectEtrnRecord; directAutostart?: NkDirectAutostart }> }
const validLocalEvent = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) return false;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
};
function validateLoadingFacts(value: unknown): asserts value is TripLoadingFacts {
  if (!sabyObject(value) || !validLocalEvent(value.arrivedAt) || !validLocalEvent(value.departedAt) || value.departedAt < value.arrivedAt || !isDate(value.recordedAt) || typeof value.actorId !== 'string' || !value.actorId || !sabyObject(value.deliveries) || !Object.keys(value.deliveries).length) throw new Error('Invalid loading facts');
  for (const row of Object.values(value.deliveries)) if (!sabyObject(row) || Object.keys(row).some(key => !['grossMassTonnes', 'massMethod'].includes(key)) || typeof row.grossMassTonnes !== 'string' || !/^\d{1,11}(?:\.\d{1,6})?$/.test(row.grossMassTonnes) || !new Decimal(row.grossMassTonnes).gt(0) || !['01', '02', '03'].includes(String(row.massMethod))) throw new Error('Invalid loading mass');
}

/** Fail closed on corruption; all optional additions survive legacy store reads. */
export function validateEtrnData(value: unknown): asserts value is EtrnData | undefined {
  if (value === undefined) return;
  if (!sabyObject(value) || !sabyObject(value.trips)) throw new Error('Invalid ETRN data');
  for (const [tripId, trip] of Object.entries(value.trips)) {
    if (!tripId || !sabyObject(trip) || !isDate(trip.updatedAt) || !sabyObject(trip.deliveries)) throw new Error('Invalid ETRN trip');
    if (trip.loadingFacts !== undefined) validateLoadingFacts(trip.loadingFacts);
    validateNkDirectEtrn(trip.direct, tripId);
    validateNkDirectAutostart(trip.directAutostart);
    for (const [shipmentId, delivery] of Object.entries(trip.deliveries)) {
      if (!shipmentId || !sabyObject(delivery) || !sabyObject(delivery.profile) || !sabyObject(delivery.snapshot) || delivery.snapshot.tripId !== tripId || delivery.snapshot.shipmentId !== shipmentId || delivery.preparedHash !== hash(delivery.snapshot) || !isDate(delivery.updatedAt)) throw new Error('Invalid ETRN preparation');
      const doc = delivery.document;
      if (doc === null) continue;
      if (sabyObject(doc)) validateEtrnDispatch(doc.dispatch, typeof doc.id === 'string' ? doc.id : null);
      if (sabyObject(doc)) validateLinkedDraftState(doc.linkedDraft, typeof doc.id === 'string' ? doc.id : null);
      if (sabyObject(doc) && (doc.nativeDraftEnabled !== undefined && typeof doc.nativeDraftEnabled !== 'boolean' || doc.linkedDraft !== undefined && doc.nativeDraftEnabled !== true)) throw new Error('Invalid native ETRN recovery policy');
      if (sabyObject(doc) && doc.unexpectedDocumentIds !== undefined && (!Array.isArray(doc.unexpectedDocumentIds) || doc.unexpectedDocumentIds.length > 10 || !doc.unexpectedDocumentIds.every(id => typeof id === 'string' && id.trim() && id.length <= 256))) throw new Error('Invalid unexpected ETRN identifiers');
      if (sabyObject(doc) && (doc.number !== undefined && (typeof doc.number !== 'string' || !doc.number.trim()) || doc.reservationAttempted !== undefined && typeof doc.reservationAttempted !== 'boolean' || doc.uploadAttempted !== undefined && typeof doc.uploadAttempted !== 'boolean')) throw new Error('Invalid ETRN numbering');
      if (sabyObject(doc) && doc.senderTitleVersion === 2 && sabyObject(doc.dispatch) && sabyObject(doc.dispatch.sender) && doc.dispatch.sender.verified === true && !validConsignmentOperatorUid(doc.dispatch.operatorUid)) throw new Error('Missing verified ETRN operator UID');
      if (sabyObject(doc) && doc.senderTitleVersion !== undefined && doc.senderTitleVersion !== 2) throw new Error('Invalid ETRN title protocol');
      if (sabyObject(doc) && doc.writeAttempts !== undefined) {
        if (!Array.isArray(doc.writeAttempts) || doc.writeAttempts.length > 20) throw new Error('Invalid ETRN write audit');
        for (const attempt of doc.writeAttempts) {
          if (!sabyObject(attempt) || Object.keys(attempt).some(key => !['action', 'request', 'outcome', 'response', 'result'].includes(key)) || !['reservation', 'upload'].includes(String(attempt.action)) || !isSabyRequestIntent(attempt.request) || attempt.request.method !== 'СБИС.ЗаписатьДокумент' || !attempt.request.bodySha256 || !['attempted', 'received', 'uncertain', 'denied'].includes(String(attempt.outcome)) || attempt.response !== undefined && !isSabyResponseDiagnostic(attempt.response)) throw new Error('Invalid ETRN write audit');
          if (attempt.result !== undefined && (!sabyObject(attempt.result) || Object.keys(attempt.result).some(key => !['id', 'receivedAt'].includes(key)) || typeof attempt.result.id !== 'string' || !attempt.result.id.trim() || attempt.result.id.length > 256 || !isDate(attempt.result.receivedAt))) throw new Error('Invalid ETRN write result');
        }
      }
      if (!sabyObject(doc) || !['pending', 'unknown', 'draft', 'error'].includes(String(doc.status)) || !nullable(doc.id) || !nullable(doc.revision) || !nullable(doc.url) || !nullable(doc.remoteStatus) || !nullable(doc.lastError) || !nullable(doc.gisStatus) || !['not_signed','reported_by_saby','unknown'].includes(String(doc.signatureStatus)) || !Array.isArray(doc.availableActions) || !doc.availableActions.every(v => typeof v === 'string') || !isDate(doc.updatedAt) || !isDate(doc.createdAt) || typeof doc.marker !== 'string' || !doc.marker.startsWith('ARTEL-CRM:ETRN:') || typeof doc.attemptId !== 'string' || !doc.attemptId || !sabyObject(doc.snapshot) || doc.snapshot.tripId !== tripId || doc.snapshot.shipmentId !== shipmentId || doc.payloadHash !== hash(doc.snapshot) || !nullable(doc.leaseId) || !(doc.leaseUntil === null || isDate(doc.leaseUntil)) || !Array.isArray(doc.artifacts) || doc.artifacts.length > 500 || doc.status === 'draft' && !doc.id) throw new Error('Invalid ETRN document');
      validateNativeAdoptionEvidence(doc as unknown as EtrnDocument);
      const keys = new Set<string>();
      for (const file of doc.artifacts) {
        if (!sabyObject(file) || typeof file.key !== 'string' || !/^[a-f0-9]{64}$/.test(file.key) || keys.has(file.key) || typeof file.attachmentId !== 'string' || !file.attachmentId || !nullable(file.revision) || typeof file.name !== 'string' || typeof file.extension !== 'string') throw new Error('Invalid ETRN artifact');
        keys.add(file.key);
        if (file.content !== undefined) {
          if (typeof file.content !== 'string' || file.content.length > 28_000_000) throw new Error('Invalid ETRN file');
          const bytes = Buffer.from(file.content, 'base64');
          if (file.content !== bytes.toString('base64') || file.size !== bytes.length || file.sha256 !== bytesHash(bytes)) throw new Error('Invalid ETRN file checksum');
        }
      }
    }
  }
}

export function validateNativeAdoptionEvidence(doc: EtrnDocument): void {
  const evidence = doc.nativeAdoptionEvidence;
  if (evidence === undefined) return;
  const allowed = ['version', 'origin', 'nativeDocumentId', 'nativeNumber', 'nativeRevision', 'nativeAttachmentId', 'nativeXmlSha256', 'nativeReadSha256', 'uiEvidenceSha256', 'planSha256', 'sourceSnapshotSha256', 'originalAttemptId', 'originalMarker', 'originalDocumentSha256', 'originalReservationAttempted', 'originalReservationOutcome', 'originalWriteAttemptsCount', 'originalWriteAttemptsSha256', 'actorId', 'adoptedAt', 'stage', 'holdForReview', 'verified'];
  const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const nonempty = (value: unknown) => typeof value === 'string' && !!value.trim() && value.length <= 256;
  if (!sabyObject(evidence) || Object.keys(evidence).some(key => !allowed.includes(key)) || evidence.version !== 'native-ui-adoption-v1' || evidence.origin !== 'independently_created_native_ui' || ![evidence.nativeDocumentId, evidence.nativeNumber, evidence.nativeRevision, evidence.nativeAttachmentId, evidence.originalAttemptId, evidence.originalMarker, evidence.actorId].every(nonempty) || ![evidence.nativeXmlSha256, evidence.nativeReadSha256, evidence.uiEvidenceSha256, evidence.planSha256, evidence.sourceSnapshotSha256, evidence.originalDocumentSha256, evidence.originalWriteAttemptsSha256].every(digest) || !isDate(evidence.adoptedAt) || !['planned', 'verified'].includes(evidence.stage) || typeof evidence.holdForReview !== 'boolean' || evidence.stage === 'planned' && !evidence.holdForReview || typeof evidence.originalReservationAttempted !== 'boolean' || evidence.originalReservationOutcome !== (evidence.originalReservationAttempted ? 'unknown' : 'not_attempted') || !Number.isSafeInteger(evidence.originalWriteAttemptsCount) || evidence.originalWriteAttemptsCount < 0 || evidence.originalWriteAttemptsCount > 20) throw new Error('Invalid native ETRN adoption evidence');
  const verified = evidence.verified;
  if (evidence.stage === 'planned' ? verified !== undefined : !sabyObject(verified) || Object.keys(verified).sort().join(',') !== 'at,attachmentId,remoteSha256,revision,xmlSha256' || !isDate(verified.at) || !nonempty(verified.revision) || !nonempty(verified.attachmentId) || !digest(verified.xmlSha256) || !digest(verified.remoteSha256)) throw new Error('Invalid native ETRN verification receipt');
  if (doc.senderTitleVersion !== 2 || doc.snapshot.documentMode !== 'nk-direct-v1' || doc.id !== evidence.nativeDocumentId || doc.number !== evidence.nativeNumber || doc.payloadHash !== evidence.sourceSnapshotSha256 || doc.attemptId !== evidence.originalAttemptId || doc.marker !== evidence.originalMarker || !!doc.reservationAttempted !== evidence.originalReservationAttempted || (doc.writeAttempts?.length ?? 0) < evidence.originalWriteAttemptsCount || hash((doc.writeAttempts ?? []).slice(0, evidence.originalWriteAttemptsCount)) !== evidence.originalWriteAttemptsSha256 || evidence.stage === 'verified' && (!doc.uploadAttempted || !doc.artifacts.length)) throw new Error('Inconsistent native ETRN adoption evidence');
}

export function hasEtrnDocuments(data: OperationsData, tripId: string): boolean {
  return Object.values(data.etrn?.trips[tripId]?.deliveries ?? {}).some(row => row.document && (row.document.status !== 'error' || !!row.document.id));
}
function makeSnapshot(base: Snapshot, data: OperationsData, tripId: string, shipmentId: string, profile: SabyConsignmentProfile | null, config: SabyConfig) {
  const snapshot = currentSnapshot(base, data);
  const trip = getShipmentTrip(snapshot, tripId);
  assertTripTransportDocumentsAllowed(trip, data);
  if (!trip.customers.some(row => row.id === shipmentId)) throw new ApiError(404, 'Доставка не найдена в этом рейсе.');
  const prepared = buildSabyConsignmentSnapshot(snapshot, trip, shipmentId, config.customer, config.carrier, profile);
  if (!profile && config.consignmentSigner) Object.assign(prepared.profile.signer, config.consignmentSigner);
  return prepared;
}
function documentSummary(doc: EtrnDocument, tripId: string, shipmentId: string): EtrnDocumentSummary {
  return {
    id: doc.id, revision: doc.revision, status: doc.status === 'pending' && (!doc.leaseUntil || Date.parse(doc.leaseUntil) <= Date.now()) ? 'unknown' : doc.status,
    url: doc.url, remoteStatus: doc.remoteStatus, lastError: doc.lastError, updatedAt: doc.updatedAt,
    signatureStatus: doc.signatureStatus, gisStatus: doc.gisStatus, availableActions: doc.availableActions,
    files: doc.artifacts.map(file => ({ id: file.key, name: file.name, extension: file.extension, ...(file.sha256 ? { sha256: file.sha256, size: file.size } : {}), url: `/api/shipment-trips/${encodeURIComponent(tripId)}/etrn/files/${encodeURIComponent(shipmentId)}/${file.key}` })),
  };
}
export function getEtrnTrip(base: Snapshot, data: OperationsData, tripId: string, config = sabyConfigFromEnv()): EtrnTripResponse {
  const trip = getShipmentTrip(currentSnapshot(base, data), tripId);
  const direct = isNkDirectEtrn(trip, data);
  if (!direct) assertTripTransportDocumentsAllowed(trip, data);
  const saved = data.etrn?.trips[tripId];
  const directPrepared = direct && trip.customers.some(requiresEtrn) ? preparedNkDirectEtrn(base, data, tripId, config) : null;
  if (direct) config = new SabyClient(config).forNkDirectEtrn().config;
  const configurationBlockers = sabyConfigurationBlockers(config);
  const displayOrganization = (org: SabyConfig['customer']) => ({ name: org.name, inn: org.inn, kpp: org.kpp, address: org.address, phone: org.phone ?? '' });
  return { configured: !configurationBlockers.length, configurationBlockers, updatedAt: saved?.updatedAt ?? null,
    organizations: { consignor: displayOrganization(config.customer), carrier: displayOrganization(config.carrier) },
    deliveries: trip.customers.filter(requiresEtrn).map(row => {
      const preparation = saved?.deliveries[row.id];
      const doc = preparation?.document;
      const snapshot = directPrepared ? doc?.snapshot ?? saved?.direct?.deliveries.find(item => item.shipmentId === row.id)?.snapshot ?? directPrepared.deliveries.find(item => item.shipmentId === row.id)!.snapshot : doc && doc.status !== 'error' ? doc.snapshot : preparation?.sourceOrderId ? preparation.snapshot : makeSnapshot(base, data, tripId, row.id, preparation?.profile ?? null, config);
      const stale = preparation && !doc && hash(snapshot) !== preparation.preparedHash;
      return { shipmentId: row.id, profile: snapshot.profile, blockers: [...sabyConsignmentBlockers(snapshot), ...(stale ? ['Данные рейса или справочников изменились. Сохраните и проверьте подготовку повторно.'] : [])], document: doc ? documentSummary(doc, tripId, row.id) : null };
    }),
  };
}
type Authorize = (snapshot: Snapshot, data: OperationsData) => void;
export interface EtrnOptions { base: Snapshot; store: OperationsStorage; tripId: string; authorize: Authorize; client?: SabyClient }

export async function saveEtrnProfile(options: EtrnOptions, shipmentId: string, raw: unknown): Promise<EtrnTripResponse> {
  const { base, store, tripId, authorize } = options;
  const config = options.client?.config ?? sabyConfigFromEnv();
  if (!sabyObject(raw) || JSON.stringify(raw).length > 80_000) throw new ApiError(400, 'Некорректные данные подготовки ЭТрН.');
  const profile = readSabyConsignmentProfile(raw);
  await store.mutate(base.provenance.sourceSha256, data => {
    authorize(currentSnapshot(base, data), data);
    assertTripTransportDocumentsAllowed(getShipmentTrip(currentSnapshot(base, data), tripId), data);
    if (data.tripSaby?.trips[tripId]) throw new ApiError(409, 'Рейс запущен в Saby. Исправления документов выполняются в Saby; факты погрузки вводятся отдельно.');
    const previous = data.etrn?.trips[tripId]?.deliveries[shipmentId];
    if (previous?.document && (previous.document.status !== 'error' || previous.document.id)) throw new ApiError(409, 'ЭТрН уже передана или результат передачи неизвестен. Сначала выполните сверку.');
    const snapshot = makeSnapshot(base, data, tripId, shipmentId, profile, config);
    data.etrn ??= { trips: {} };
    const trip = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: stamp() };
    trip.deliveries[shipmentId] = { profile: snapshot.profile!, snapshot, preparedHash: hash(snapshot), document: null, updatedAt: stamp() };
    trip.updatedAt = stamp();
    return { result: undefined, changed: true };
  });
  const data = await store.read(base.provenance.sourceSha256); authorize(currentSnapshot(base, data), data);
  return getEtrnTrip(base, data, tripId, config);
}

function partyMatches(raw: unknown, expected: { inn: string; kpp: string }) {
  if (/^\d{12}$/.test(expected.inn)) return sabyObject(raw) && sabyObject(raw.СвФЛ) && raw.СвФЛ.ИНН === expected.inn;
  const party = sabyObject(raw) && sabyObject(raw.СвЮЛ) ? raw.СвЮЛ : null;
  return !!party && party.ИНН === expected.inn && party.КПП === expected.kpp;
}
function confirmed(remote: SabyObject, doc: EtrnDocument, verifiedLinkedDraft = false): Partial<EtrnDocument> {
  // A linked native draft has no CRM marker. Only the reciprocal-link and full-title
  // verification immediately preceding this call may establish its identity.
  if (remote.Тип !== 'ConsignmentNote' || remote.Идентификатор !== doc.id || remote.Номер !== (doc.number ?? `CRM-${doc.attemptId}`) || !verifiedLinkedDraft && remote.Примечание !== doc.marker || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да') throw new SabyError('unknown', 'Прочитанная ЭТрН не совпадает с отправленным документом. Повторное создание запрещено.', true);
  const parties = sabyObject(remote.Стороны) ? remote.Стороны : {};
  const sender = parties.Отправитель ?? remote.Грузоотправитель ?? remote.НашаОрганизация;
  const carrier = parties.Перевозчик ?? remote.Перевозчик ?? remote.ТранспортнаяКомпания;
  const recipient = parties.Получатель ?? remote.Грузополучатель;
  if (!partyMatches(sender, doc.snapshot.customerOrganization) || !partyMatches(carrier, doc.snapshot.carrierOrganization) || !partyMatches(recipient, doc.snapshot.profile!.recipient)) throw new SabyError('unknown', 'Saby не подтвердил всех трёх участников ЭТрН. Требуется сверка документа.', true);
  const attachments = Array.isArray(remote.Вложение) ? remote.Вложение.filter(sabyObject) : [];
  const firstTitles = attachments.filter(file => file.Подтип === '1110339' && file.ВерсияФормата === '5.01' && file.Удален !== 'Да');
  if (firstTitles.length !== 1) throw new SabyError('unknown', 'Saby не подтвердил единственный действующий первый титул ЭТрН 1110339 v5.01.', true);
  const hasErrors = (value: SabyObject) => Number(value.КоличествоОшибок ?? 0) > 0 || !!value.Ошибка || Array.isArray(value.Ошибки) && value.Ошибки.length > 0;
  if (hasErrors(remote) || hasErrors(firstTitles[0])) throw new SabyError('unknown', 'Saby вернул замечания проверки первого титула ЭТрН. Исправьте документ в Saby и обновите состояние.', true);
  const state = sabyObject(remote.Состояние) ? remote.Состояние : {};
  if (hasErrors(state)) throw new SabyError('unknown', 'Saby сохранил ЭТрН с ошибками. Откройте документ и проверьте обязательные сведения.', true);
  const workflow = sabyDocumentWorkflow(remote);
  if (!workflow.revision) throw new SabyError('unknown', 'Saby не подтвердил редакцию ЭТрН. Требуется повторная сверка.', true);
  const artifacts = [...doc.artifacts];
  for (const file of workflow.attachments) {
    const key = hash([workflow.revision, file.id]);
    if (!artifacts.some(saved => saved.key === key)) artifacts.push({ key, attachmentId: file.id, revision: workflow.revision, name: file.name, extension: file.extension });
  }
  return { status: 'draft', revision: workflow.revision, url: workflow.url, remoteStatus: workflow.remoteStatus, signatureStatus: workflow.signatureStatus, gisStatus: workflow.gisStatus, availableActions: workflow.availableActions, artifacts, lastError: null, updatedAt: stamp() };
}

/** Persist the intent before network; reconcile unknown results without any second write. */
export async function exchangeEtrn(options: EtrnOptions, shipmentId: string, refresh = false): Promise<EtrnTripResponse> {
  const { base, store, tripId, authorize } = options;
  let client = options.client ?? new SabyClient(sabyConfigFromEnv());
  const source = base.provenance.sourceSha256;
  const leaseId = randomUUID();
  const claimed = await store.mutate(source, data => {
    authorize(currentSnapshot(base, data), data);
    assertTripTransportDocumentsAllowed(getShipmentTrip(currentSnapshot(base, data), tripId), data);
    if (data.tripSaby?.trips[tripId] && !refresh) throw new ApiError(409, 'ЭТрН этого рейса создаются общей цепочкой Saby после подтверждения перевозчика.');
    const preparation = data.etrn?.trips[tripId]?.deliveries[shipmentId];
    if (!preparation) throw new ApiError(422, 'Сначала сохраните и проверьте сведения ЭТрН.');
    // Check membership even for old records, and forbid writes against another organization.
    const fresh = makeSnapshot(base, data, tripId, shipmentId, preparation.profile, client.config);
    const previous = preparation.document;
    if (refresh && preparation.sourceOrderId && !previous?.id) throw new ApiError(409, 'Сверьте результат общей цепочкой Saby: отдельное восстановление ЭТрН без идентификатора недоступно.');
    if (previous?.leaseId && previous.leaseUntil && Date.parse(previous.leaseUntil) > Date.now()) throw new ApiError(409, 'Запрос ЭТрН уже выполняется. Обновите состояние позже.');
    if (previous?.status === 'draft' && !refresh) return { result: null, changed: false };
    if (refresh && !previous) throw new ApiError(422, 'ЭТрН ещё не передавалась в Saby.');
    const recover = !!previous && (previous.status !== 'error' || !!previous.id);
    const errors = recover ? sabyCredentialBlockers(client.config) : [...sabyConfigurationBlockers(client.config), ...sabyConsignmentBlockers(fresh)];
    if (errors.length) throw new ApiError(422, [...new Set(errors)].join(' '));
    if (!recover && hash(fresh) !== preparation.preparedHash) throw new ApiError(409, 'Данные рейса или справочников изменились. Сохраните подготовку ЭТрН повторно.');
    if (refresh && previous?.status === 'error' && !previous.id) throw new ApiError(422, 'Запись не начиналась. Используйте создание после проверки данных.');
    const time = stamp();
    const doc: EtrnDocument = recover ? { ...previous!, status: previous!.status === 'pending' ? 'unknown' : previous!.status } : {
      id: null, revision: null, status: 'pending', url: null, remoteStatus: null, lastError: null,
      updatedAt: time, createdAt: time, attemptId: randomUUID(), marker: `ARTEL-CRM:ETRN:${randomUUID()}`,
      snapshot: fresh, payloadHash: hash(fresh), artifacts: [], signatureStatus: 'unknown', gisStatus: null, availableActions: [], leaseId: null, leaseUntil: null,
    };
    doc.leaseId = leaseId; doc.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    preparation.document = doc; preparation.updatedAt = time; data.etrn!.trips[tripId].updatedAt = time;
    return { result: structuredClone(doc), changed: true };
  });
  if (claimed) {
    const checkAccess = async () => {
      const data = await store.read(source); authorize(currentSnapshot(base, data), data);
      const document = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
      if (!document || document.leaseId !== leaseId || !document.leaseUntil || Date.parse(document.leaseUntil) <= Date.now()) throw new ApiError(409, 'Сеанс обмена ЭТрН истёк или изменился. Выполните сверку.');
    };
    client = client.withRequestGuard(checkAccess);
    let beganWrite = false;
    let id = claimed.id;
    const update = async (patch: Partial<EtrnDocument>) => store.mutate(source, data => {
      const row = data.etrn?.trips[tripId]?.deliveries[shipmentId];
      if (!row?.document || row.document.leaseId !== leaseId) throw new ApiError(409, 'Сеанс обмена ЭТрН изменился. Выполните сверку.');
      Object.assign(row.document, patch); row.updatedAt = stamp(); data.etrn!.trips[tripId].updatedAt = stamp();
      return { result: undefined, changed: true };
    });
    try {
      await client.verifyOrganizations(claimed.snapshot.customerOrganization, claimed.snapshot.carrierOrganization);
      const latest = await store.read(source); authorize(currentSnapshot(base, latest), latest);
      if (!id && claimed.status === 'unknown') {
        const rows = await client.findDocuments(claimed.marker, claimed.snapshot.fields.date!.split('-').reverse().join('.'), claimed.snapshot.customerOrganization, `CRM-${claimed.attemptId}`, 'ConsignmentNote');
        if (rows.length !== 1 || !sabyText(rows[0].Идентификатор)) throw new SabyError('unknown', rows.length ? 'Найдено несколько совпадений ЭТрН. Проверьте Saby; повторная запись запрещена.' : 'Прежняя ЭТрН пока не найдена. Результат неизвестен; повторная запись запрещена.', true);
        id = sabyText(rows[0].Идентификатор);
      }
      if (!id) {
        const request = buildSabyConsignmentDocument(claimed.snapshot, claimed.marker, claimed.attemptId, claimed.createdAt);
        beganWrite = true;
        id = sabyText((await client.writeConsignmentNote(request)).Идентификатор);
        if (!id) throw new SabyError('unknown', 'Saby не вернул идентификатор ЭТрН. Требуется сверка.', true);
      }
      await update({ id, status: 'unknown', updatedAt: stamp() });
      const linked = claimed.linkedDraft ? await reconcileLinkedConsignmentDraft({
        client, order: { id: claimed.linkedDraft.sourceOrderId, number: claimed.linkedDraft.sourceOrderNumber, date: claimed.linkedDraft.sourceOrderDate },
        deliveryCount: latest.tripSaby?.trips[tripId]?.deliveries.length ?? 0,
        current: () => ({ ...claimed, id }), update, readOnly: true,
        checkAccess,
      }) : null;
      const remote = linked ?? await client.readConsignmentNote(id!);
      await update(confirmed(remote, { ...claimed, id }, !!linked));
    } catch (error) {
      const uncertain = !!id || claimed.status === 'unknown' || beganWrite && (!(error instanceof SabyError) || error.uncertain);
      await update({ id, status: uncertain ? 'unknown' : 'error', lastError: error instanceof SabyError || error instanceof ApiError ? error.message : 'Обмен ЭТрН не подтверждён. Выполните сверку состояния.', updatedAt: stamp() });
      if (error instanceof ApiError) throw error;
    } finally {
      await update({ leaseId: null, leaseUntil: null });
    }
  }
  const data = await store.read(source); authorize(currentSnapshot(base, data), data);
  return getEtrnTrip(base, data, tripId, client.config);
}

export async function saveTripLoadingFacts(options: EtrnOptions, raw: unknown, actorId: string): Promise<void> {
  const { base, store, tripId, authorize } = options;
  if (!sabyObject(raw) || Object.keys(raw).some(key => !['arrivedAt', 'departedAt', 'deliveries'].includes(key))) throw new ApiError(400, 'Проверьте сведения о фактической погрузке.');
  const facts = { ...raw, recordedAt: stamp(), actorId };
  try { validateLoadingFacts(facts); } catch { throw new ApiError(400, 'Укажите фактические прибытие и убытие, положительную массу каждой доставки в тоннах и способ определения массы.'); }
  if (Date.parse(`${facts.departedAt}+03:00`) > Date.now()) throw new ApiError(400, 'Фактическое убытие не может быть в будущем.');
  await store.mutate(base.provenance.sourceSha256, data => {
    authorize(currentSnapshot(base, data), data);
    const workflow = data.tripSaby?.trips[tripId];
    if (getShipmentTrip(currentSnapshot(base, data), tripId).fields.trip_flow_version === 'driver-v1') throw new ApiError(409, 'Факты этого рейса фиксирует назначенный водитель действиями «Прибыл» и «Убыл».');
    if (!workflow?.carrierEvidence) throw new ApiError(409, 'Сначала дождитесь подтверждения заявки перевозчиком в Saby.');
    if (workflow.leaseId && workflow.leaseUntil && Date.parse(workflow.leaseUntil) > Date.now()) throw new ApiError(409, 'Обмен выполняется. Дождитесь его завершения.');
    const ids = workflow.deliveries.map(row => row.shipmentId);
    if (Object.keys(facts.deliveries).length !== ids.length || ids.some(id => !facts.deliveries[id])) throw new ApiError(400, 'Подтвердите фактическую массу каждой доставки рейса.');
    const previous = data.etrn?.trips[tripId];
    if (previous?.loadingFacts || Object.values(previous?.deliveries ?? {}).some(row => row.document)) throw new ApiError(409, 'Факты погрузки уже сохранены. Исправления переданных документов выполняются в Saby.');
    const actualTotal = Object.values(facts.deliveries).reduce((sum, row) => sum.plus(row.grossMassTonnes), new Decimal(0));
    if (workflow.deliveries.some(row => actualTotal.gt(row.snapshot.profile.vehicle.payloadTonnes))) throw new ApiError(422, 'Сумма фактических масс доставок превышает подтверждённую грузоподъёмность машины.');
    const order = { id: workflow.order.id!, number: workflow.order.number!, date: workflow.order.date! };
    const errors = workflow.deliveries.flatMap(row => sabyConsignmentBlockers(snapshotWithLoading(row.snapshot, facts, order)));
    if (errors.length) throw new ApiError(422, [...new Set(errors)].join(' '));
    data.etrn ??= { trips: {} };
    const trip = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: stamp() };
    trip.loadingFacts = facts; trip.updatedAt = stamp();
    return { result: undefined, changed: true };
  });
}

function snapshotWithLoading(snapshot: SabyConsignmentSnapshot, facts: TripLoadingFacts, order: CreateTripSabyDelivery['order']): SabyConsignmentSnapshot {
  const result = structuredClone(snapshot);
  result.profile.order = { number: order.number, date: order.date };
  result.profile.loading = { arrivedAt: facts.arrivedAt, departedAt: facts.departedAt, ...facts.deliveries[snapshot.shipmentId] };
  return result;
}

/** Recover a linked native draft for a single driver delivery; preserve the existing legacy path. */
export async function exchangePreparedEtrn(options: EtrnOptions, input: CreateTripSabyDelivery | { documentMode: 'nk-direct-v1'; shipmentId: string; snapshot: SabyConsignmentSnapshot }): Promise<{ status: 'pending' | 'unknown' | 'draft' | 'error'; id: string | null; lastError: string | null; waitingForLoading?: boolean }> {
  const { base, store, tripId, authorize } = options;
  let client = options.client ?? new SabyClient(sabyConfigFromEnv());
  const source = base.provenance.sourceSha256, shipmentId = input.shipmentId;
  const direct = 'documentMode' in input && input.documentMode === 'nk-direct-v1';
  const orderInput = direct ? null : input as CreateTripSabyDelivery;
  const leaseId = randomUUID();
  const initial = await store.read(source); authorize(currentSnapshot(base, initial), initial);
  if (direct) authorizeNkDirectEtrn(base, initial, tripId, client.config);
  else assertTripTransportDocumentsAllowed(getShipmentTrip(currentSnapshot(base, initial), tripId), initial);
  requireEtrnDelivery(getShipmentTrip(currentSnapshot(base, initial), tripId), shipmentId);
  const facts = initial.etrn?.trips[tripId]?.loadingFacts;
  if (!facts) return { status: 'error', id: null, lastError: 'Заявка подтверждена. Заполните фактические сведения погрузки всего рейса.', waitingForLoading: true };
  // Validate ALL deliveries before the first consignment reservation, including saved actual facts.
  const allErrors = direct ? preparedNkDirectEtrn(base, initial, tripId, client.config).blockers : (initial.tripSaby?.trips[tripId]?.deliveries ?? []).flatMap(row => sabyConsignmentBlockers(snapshotWithLoading(row.snapshot, facts, orderInput!.order)));
  if (allErrors.length) return { status: 'error', id: null, lastError: [...new Set(allErrors)].join(' ') };
  const claimed = await store.mutate(source, data => {
    authorize(currentSnapshot(base, data), data);
    if (direct) authorizeNkDirectEtrn(base, data, tripId, client.config);
    else assertTripTransportDocumentsAllowed(getShipmentTrip(currentSnapshot(base, data), tripId), data);
    requireEtrnDelivery(getShipmentTrip(currentSnapshot(base, data), tripId), shipmentId);
    const workflow = data.tripSaby?.trips[tripId];
    if (direct && !data.etrn?.trips[tripId]?.direct?.deliveries.some(row => row.shipmentId === shipmentId && hash(row.snapshot) === hash(input.snapshot))) throw new ApiError(409, 'Прямая ЭТрН не соответствует согласованной доставке.');
    if (!direct && !workflow?.deliveries.some(row => row.shipmentId === shipmentId)) throw new ApiError(409, 'Доставка не входит в согласованный состав ЭТрН.');
    if (!direct && (!workflow?.carrierEvidence || workflow.order.id !== orderInput!.order.id || workflow.carrierEvidence.evidenceHash !== orderInput!.carrierEvidence.evidenceHash)) throw new ApiError(409, 'Подтверждение общей заявки изменилось. Выполните сверку.');
    const existing = data.etrn?.trips[tripId]?.deliveries[shipmentId];
    if (existing?.document?.leaseUntil && Date.parse(existing.document.leaseUntil) > Date.now()) throw new ApiError(409, 'ЭТрН уже обрабатывается.');
    if (!direct && existing?.document?.status === 'draft') return { result: structuredClone(existing.document), changed: false };
    const snapshot = existing?.document?.snapshot ?? (direct ? structuredClone(input.snapshot) : snapshotWithLoading(input.snapshot, facts, orderInput!.order));
    const errors = sabyConsignmentBlockers(snapshot); if (errors.length) throw new ApiError(422, errors.join(' '));
    const time = stamp();
    const doc: EtrnDocument = existing?.document ?? { id: null, revision: null, status: 'pending', url: null, remoteStatus: null, lastError: null, updatedAt: time, createdAt: time, marker: `ARTEL-CRM:ETRN:${randomUUID()}`, attemptId: randomUUID(), payloadHash: hash(snapshot), snapshot, artifacts: [], signatureStatus: 'unknown', gisStatus: null, availableActions: [], leaseId: null, leaseUntil: null, reservationAttempted: false, uploadAttempted: false, ...(!direct && workflow?.driverFlow && workflow.deliveries.length === 1 ? { nativeDraftEnabled: true } : {}) };
    doc.leaseId = leaseId; doc.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    data.etrn ??= { trips: {} };
    const trip = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: time };
    trip.deliveries[shipmentId] = { profile: snapshot.profile, snapshot, preparedHash: hash(snapshot), document: doc, updatedAt: time, ...(!direct ? { sourceOrderId: orderInput!.order.id } : {}) };
    return { result: structuredClone(doc), changed: true };
  });
  if (!direct && claimed.status === 'draft') return { status: claimed.status, id: claimed.id, lastError: claimed.lastError };
  let doc = claimed;
  const update = async (patch: Partial<EtrnDocument>, receipt = false) => {
    doc = await store.mutate(source, data => {
      const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
      if (!current || current.leaseId !== leaseId || current.attemptId !== claimed.attemptId) throw new ApiError(409, 'Сеанс ЭТрН изменился. Выполните сверку.');
      const releasing = Object.keys(patch).every(key => ['leaseId', 'leaseUntil'].includes(key)) && patch.leaseId === null && patch.leaseUntil === null;
      if (!releasing && !receipt) {
        authorize(currentSnapshot(base, data), data);
        if (!current.leaseUntil || Date.parse(current.leaseUntil) <= Date.now()) throw new ApiError(409, 'Сеанс ЭТрН истёк. Выполните сверку.');
      }
      Object.assign(current, patch, { updatedAt: stamp() });
      return { result: structuredClone(current), changed: true };
    });
  };
  const checkAccess = async () => {
    const data = await store.read(source); authorize(currentSnapshot(base, data), data);
    const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
    if (!current || current.leaseId !== leaseId || !current.leaseUntil || Date.parse(current.leaseUntil) <= Date.now()) throw new ApiError(409, 'Сеанс ЭТрН истёк. Выполните сверку.');
  };
  client = client.withRequestGuard(checkAccess);
  const validateReservation = (remote: SabyObject) => {
    const parties = sabyObject(remote.Стороны) ? remote.Стороны : {};
    if (remote.Идентификатор !== doc.id || remote.Тип !== 'ConsignmentNote' || remote.Примечание !== doc.marker || remote.Дата !== doc.snapshot.fields.date?.split('-').reverse().join('.') || !sabyText(remote.Номер) || doc.number && remote.Номер !== doc.number || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да' || !partyMatches(remote.НашаОрганизация, doc.snapshot.customerOrganization) || direct && (!partyMatches(remote.Грузоотправитель ?? parties.Отправитель, doc.snapshot.customerOrganization) || !partyMatches(remote.ТранспортнаяКомпания ?? parties.Перевозчик, doc.snapshot.carrierOrganization) || !partyMatches(remote.Грузополучатель ?? parties.Получатель, doc.snapshot.profile.recipient) || !sabyDocumentWorkflow(remote).revision)) throw new SabyError('unknown', 'Saby не подтвердил номер, реквизиты и редакцию существующей ЭТрН. Новое создание запрещено.', true);
  };
  let currentRequest: SabyRequestIntent | null = null;
  const beforeWrite = (action: EtrnWriteAttempt['action']) => async (request: SabyRequestIntent) => {
    await checkAccess();
    if ((doc.writeAttempts?.length ?? 0) >= 20) throw new SabyError('validation', 'Журнал попыток ЭТрН требует сверки.');
    await update({ ...(action === 'reservation' ? { reservationAttempted: true } : { uploadAttempted: true }), status: 'pending', writeAttempts: [...(doc.writeAttempts ?? []), { action, request, outcome: 'attempted' }] });
    currentRequest = request;
  };
  const receiveWrite = async (id: string, patch: Partial<EtrnDocument> = {}) => {
    // Recording the response cannot authorize a further request. Preserve it even if
    // the actor lost access while Saby was processing the already authorised write.
    await update({ ...patch, writeAttempts: doc.writeAttempts?.map(attempt => attempt.request === currentRequest || hash(attempt.request) === hash(currentRequest) ? { ...attempt, outcome: 'received', result: { id, receivedAt: stamp() } } : attempt) }, true);
  };
  let writing: 'reservation' | 'upload' | null = null;
  let armedAction: 'reservation' | 'upload' | null = null;
  try {
    if (direct && !doc.id && !doc.reservationAttempted) throw new SabyError('validation', DIRECT_ETRN_NUMBER_BLOCKER);
    await client.verifyOrganizations(doc.snapshot.customerOrganization, doc.snapshot.carrierOrganization); await checkAccess();
    const linked = doc.nativeDraftEnabled ? await reconcileLinkedConsignmentDraft({
      client, order: orderInput!.order, deliveryCount: initial.tripSaby!.trips[tripId].deliveries.length,
      current: () => doc, update, checkAccess,
    }) : null;
    if (linked) {
      await update(confirmed(linked, doc, true));
      return { status: doc.status, id: doc.id, lastError: doc.lastError };
    }
    if (!doc.id && doc.reservationAttempted) {
      const found = await client.findDocuments(doc.marker, doc.snapshot.fields.date!.split('-').reverse().join('.'), doc.snapshot.customerOrganization, doc.number, 'ConsignmentNote');
      if (found.length !== 1 || !sabyText(found[0].Идентификатор)) throw new SabyError('unknown', 'Результат создания ЭТрН пока не установлен. Повторное создание запрещено.', true);
      await update({ id: sabyText(found[0].Идентификатор), status: 'unknown' }); await checkAccess();
    }
    if (!doc.id) {
      // Saby creates a native consignment from the accepted driver-flow order.
      // Wait for that exact relationship instead of reserving a duplicate shell.
      if (doc.nativeDraftEnabled) throw new SabyError('unknown', 'Saby ещё не подтвердил связанную ЭТрН принятой заявки. CRM ожидает документ; повторное создание не выполняется.', true);
      if (direct) throw new SabyError('validation', DIRECT_ETRN_NUMBER_BLOCKER);
      const full = buildSabyConsignmentDocument(doc.snapshot, doc.marker, doc.attemptId, doc.createdAt, '1');
      const { Номер: _number, Вложение: _attachments, ...metadata } = full; void _number; void _attachments;
      armedAction = 'reservation';
      await update({ reservationAttempted: true, status: 'pending' }); await checkAccess();
      armedAction = null; writing = 'reservation';
      const reserved = await client.reserveNumberedDocument(metadata);
      const id = sabyText(reserved.Идентификатор);
      if (!id) throw new SabyError('unknown', 'Saby не вернул идентификатор ЭТрН. Требуется сверка.', true);
      await update({ id, status: 'unknown' }); writing = null; await checkAccess();
    }
    let remote = await client.readConsignmentNote(doc.id!); validateReservation(remote);
    await update({ number: String(remote.Номер) }); await checkAccess();
    const hasTitle = Array.isArray(remote.Вложение) && remote.Вложение.some(row => sabyObject(row) && row.Подтип === '1110339' && row.Удален !== 'Да');
    if (!hasTitle) {
      if (doc.uploadAttempted) throw new SabyError('unknown', 'Результат загрузки первого титула ЭТрН неизвестен. Повторная загрузка запрещена.', true);
      if (direct) {
        const workflow = sabyDocumentWorkflow(remote);
        if (workflow.signatureStatus === 'reported_by_saby' || !sabyObject(remote.Состояние) || String(remote.Состояние.Код) !== '0' || (Array.isArray(remote.Вложение) && remote.Вложение.some(file => sabyObject(file) && file.Удален !== 'Да'))) throw new SabyError('unknown', 'Существующая ЭТрН содержит вложения или уже обрабатывается. Требуется адресная сверка перед загрузкой Т1.', true);
        await update({ senderTitleVersion: 2 });
      }
      const request = { ...buildSabyConsignmentDocument(doc.snapshot, doc.marker, doc.attemptId, doc.createdAt, doc.number, { senderTitleVersion: doc.senderTitleVersion }), Идентификатор: doc.id, ...(direct ? { Адресация: { Идентификатор: doc.id, Редакция: { Идентификатор: sabyDocumentWorkflow(remote).revision } } } : {}) };
      armedAction = 'upload';
      await checkAccess();
      armedAction = null; writing = 'upload';
      const uploaded = await client.writeConsignmentNote(request, beforeWrite('upload'));
      const returnedId = sabyText(uploaded.Идентификатор);
      if (returnedId) await receiveWrite(returnedId);
      if (uploaded.Идентификатор !== doc.id) {
        const unexpectedId = sabyText(uploaded.Идентификатор);
        if (unexpectedId && unexpectedId.length <= 256) await update({ unexpectedDocumentIds: [...new Set([...(doc.unexpectedDocumentIds || []), unexpectedId])].slice(0, 10) }, true);
        throw new SabyError('unknown', 'Saby вернул другой идентификатор ЭТрН при загрузке титула.', true);
      }
      writing = null; await checkAccess(); remote = await client.readConsignmentNote(doc.id!);
    }
    const titles = Array.isArray(remote.Вложение) ? remote.Вложение.filter(row => sabyObject(row) && row.Подтип === '1110339' && row.Удален !== 'Да') : [];
    const revision = sabyDocumentWorkflow(remote).revision;
    if (titles.length !== 1 || !sabyObject(titles[0]) || !sabyText(titles[0].Идентификатор) || !revision) throw new SabyError('unknown', 'Не подтверждён единственный титул ЭТрН для сверки содержимого.', true);
    const uploadedTitle = await client.downloadAttachment(doc.id!, String(titles[0].Идентификатор), revision);
    verifyConsignmentSenderBusiness(uploadedTitle.bytes, serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, doc.number, { senderTitleVersion: doc.senderTitleVersion }).xml, doc.snapshot.documentMode === 'nk-direct-v1' ? 'address-direct-v1' : undefined, { senderTitleVersion: doc.senderTitleVersion, phase: doc.dispatch?.operatorUid ? 'prepared' : 'unprepared', operatorUid: doc.dispatch?.operatorUid });
    await checkAccess();
    await update(confirmed(remote, doc));
  } catch (error) {
    if (currentRequest && error instanceof SabyRequestError && hash(error.request) === hash(currentRequest)) {
      await update({ writeAttempts: doc.writeAttempts?.map(attempt => hash(attempt.request) === hash(currentRequest) ? { ...attempt, outcome: error.uncertain ? 'uncertain' : 'denied', ...(error.response ? { response: error.response } : {}) } : attempt) }, true);
    }
    const localDenied = armedAction && error instanceof ApiError && [401, 403].includes(error.status);
    const denied = localDenied || writing && error instanceof SabyError && !error.uncertain && ['authorization', 'permission'].includes(error.kind);
    const deniedAction = localDenied ? armedAction : writing;
    await update({ ...(denied && deniedAction === 'reservation' ? { reservationAttempted: false } : {}), ...(denied && deniedAction === 'upload' ? { uploadAttempted: false } : {}), status: denied ? 'error' : doc.reservationAttempted || doc.id ? 'unknown' : 'error', lastError: error instanceof SabyError || error instanceof ApiError ? error.message : 'Результат обмена ЭТрН неизвестен. Выполните сверку.' }, true);
    // A persisted uncertain receipt does not turn an expired/replaced lease into
    // a successful caller operation. The queued request was stopped by its guard.
    if (error instanceof ApiError && [401, 403, 409].includes(error.status)) throw error;
  } finally { await update({ leaseId: null, leaseUntil: null }); }
  const latest = await store.read(source); authorize(currentSnapshot(base, latest), latest);
  return { status: doc.status, id: doc.id, lastError: doc.lastError };
}

export function preparedEtrnXml(base: Snapshot, data: OperationsData, tripId: string, shipmentId: string, config = sabyConfigFromEnv()) {
  const direct = isNkDirectEtrn(getShipmentTrip(currentSnapshot(base, data), tripId), data);
  if (!direct) assertTripTransportDocumentsAllowed(getShipmentTrip(currentSnapshot(base, data), tripId), data);
  requireEtrnDelivery(getShipmentTrip(currentSnapshot(base, data), tripId), shipmentId);
  const row = data.etrn?.trips[tripId]?.deliveries[shipmentId];
  if (!row) throw new ApiError(422, 'Сначала сохраните подготовку ЭТрН.');
  if (row.document?.linkedDraft) {
    const saved = row.document.linkedDraft;
    validateLinkedDraftState(saved, row.document.id);
    return { xml: Buffer.from(saved.filledBase64, 'base64'), name: saved.attachmentName, number: saved.documentNumber, uid: row.document.attemptId };
  }
  const snapshot = row.document?.snapshot ?? (direct ? row.snapshot : makeSnapshot(base, data, tripId, shipmentId, row.profile, config));
  const errors = sabyConsignmentBlockers(snapshot);
  if (errors.length) throw new ApiError(422, errors.join(' '));
  return serializeSabyConsignmentNote(snapshot, row.document?.attemptId ?? '00000000-0000-4000-8000-000000000001', row.document?.createdAt ?? row.updatedAt, row.document?.number, { senderTitleVersion: row.document?.senderTitleVersion });
}

/** Cache immutable bytes privately in the store; never expose session-bearing vendor links. */
export async function downloadEtrnFile(options: EtrnOptions, shipmentId: string, key: string) {
  const { base, store, tripId, authorize } = options;
  const source = base.provenance.sourceSha256;
  const data = await store.read(source); authorize(currentSnapshot(base, data), data);
  const direct = isNkDirectEtrn(getShipmentTrip(currentSnapshot(base, data), tripId), data);
  if (!direct) assertTripTransportDocumentsAllowed(getShipmentTrip(currentSnapshot(base, data), tripId), data);
  requireEtrnDelivery(getShipmentTrip(currentSnapshot(base, data), tripId), shipmentId);
  const doc = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
  const file = doc?.artifacts.find(file => file.key === key);
  if (!doc?.id || !file) throw new ApiError(404, 'Файл ЭТрН не найден.');
  if (file.content) return { bytes: Buffer.from(file.content, 'base64'), name: file.name, extension: file.extension };
  // A revision can change in Saby; uncached historical bytes must not be replaced by newer ones.
  if (file.revision !== doc.revision) throw new ApiError(409, 'Этот файл относится к предыдущей редакции. Откройте архив редакций в Saby.');
  const suppliedClient = options.client ?? new SabyClient(sabyConfigFromEnv());
  const client = (direct ? suppliedClient.forNkDirectEtrn() : suppliedClient).withRequestGuard(async () => {
    const latest = await store.read(source); authorize(currentSnapshot(base, latest), latest);
    const current = latest.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
    if (current?.id !== doc.id || current?.revision !== file.revision || !current.artifacts.some(item => item.key === key && item.attachmentId === file.attachmentId)) throw new ApiError(409, 'Редакция ЭТрН изменилась. Обновите список файлов.');
  });
  const read = await client.readConsignmentNote(doc.id);
  const workflow = sabyDocumentWorkflow(read);
  if (workflow.revision !== file.revision || !workflow.attachments.some(item => item.id === file.attachmentId)) throw new ApiError(409, 'Редакция документа в Saby изменилась. Обновите состояние ЭТрН.');
  const downloaded = await client.downloadAttachment(doc.id, file.attachmentId, file.revision);
  if (downloaded.bytes.length > 20_000_000) throw new ApiError(413, 'Файл слишком велик для CRM. Скачайте его в Saby.');
  await store.mutate(source, latest => {
    authorize(currentSnapshot(base, latest), latest);
    const current = latest.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
    const target = current?.artifacts.find(item => item.key === key);
    if (!target || current?.revision !== file.revision) throw new ApiError(409, 'Редакция ЭТрН изменилась. Обновите список файлов.');
    const content = Buffer.from(downloaded.bytes).toString('base64');
    if (target.content && target.content !== content) throw new ApiError(409, 'Saby вернул другие байты сохранённого файла. Требуется сверка.');
    target.content = content; target.size = downloaded.bytes.length; target.sha256 = bytesHash(downloaded.bytes);
    return { result: undefined, changed: true };
  });
  return { bytes: downloaded.bytes, name: file.name, extension: file.extension };
}

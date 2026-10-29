import type { ShipmentAccessContext } from './shipment-operations';
import { requiresEtrn, requireEtrnDelivery } from './trip-etrn-scope';
import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Snapshot } from '../web/src/model';
import type { SabyConsignmentProfile, EtrnLoadingDetails } from '../web/src/etrn-model';
import type { EtrnTripResponse, EtrnDocumentSummary } from '../web/src/etrn-api-model';
import { ApiError } from './api-error';
import type { OperationsData, OperationsStorage } from './operations-store';
import { currentSnapshot, currentShipmentAccess } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import { SabyClient, SabyError, SabyRequestError, isSabyRequestIntent, isSabyResponseDiagnostic, type SabyRequestIntent, type SabyResponseDiagnostic, sabyConfigFromEnv, sabyConfigurationBlockers, sabyCredentialBlockers, sabyDocumentWorkflow, sabyObject, sabyText, type SabyConfig, type SabyObject } from './saby-client';
import { buildSabyConsignmentSnapshot, readSabyConsignmentProfile, readEtrnLoadingDetails, sabyConsignmentBlockers, buildSabyConsignmentDocument, serializeSabyConsignmentNote, type SabyConsignmentSnapshot } from './saby-consignment-note';
import type { CreateTripSabyDelivery } from './trip-saby-workflow';
import { assertSigningManifest } from './saby-signing';
import { validateEtrnDispatch, type EtrnDispatch } from './etrn-dispatch';
import { reconcileLinkedConsignmentDraft, validateLinkedDraftState, type LinkedDraftState } from './etrn-linked-draft';
import { NATIVE_APPROVED_REDIRECTION_METHOD, validConsignmentOperatorUid, verifyConsignmentSenderBusiness, type SabyConsignmentEvidenceOptions } from './saby-consignment-evidence';
import { assertTripTransportDocumentsAllowed, isNkDirectEtrn } from './trip-document-mode';
import { validateNkDirectAutostart, type NkDirectAutostart } from './nk-direct-autostart';
import { authorizeNkDirectFromSnapshot, preparedNkDirectFromSnapshot, validateNkDirectEtrn, type NkDirectEtrnRecord } from './nk-direct-etrn';

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
/** A separate user instruction amends one field without rewriting the original source or signing grant. */
export interface EtrnNativeSenderAmendment {
  version: 'native-redirection-approval-v1' | 'direct-redirection-approval-v2'; tripId: string; documentId: string; documentNumber: string; documentRevision: string;
  attachmentId: string; payloadHash: string; directAttemptId: string; authorizationSha256: string;
  originalPreparedHash: string | null; sourceXmlSha256: string;
  beforeMethod: 'По телефону'; afterMethod: typeof NATIVE_APPROVED_REDIRECTION_METHOD;
  source: 'explicit_user_instruction'; answerText: string;
  approvalReference: string; recordedAt: string; approvalTextSha256: string;
}
export const DIRECT_ETRN_NUMBER_BLOCKER = 'Saby не подтвердил способ выдачи номера прямой ЭТрН до загрузки Т1. Пустое резервирование отключено; нумерация Saby сохраняется. Требуется подтверждение API нумерации от Saby.';
export interface OrderRedirectionApproval {
  version: 1; tripId: string; workflowAttemptId: string; authorizationSha256: string;
  answerText: string; answerSha256: string; recordedAt: string;
}
export function validateOrderRedirectionApproval(value: unknown): asserts value is OrderRedirectionApproval | undefined {
  if (value === undefined) return;
  if (!sabyObject(value) || Object.keys(value).some(k => !['version','tripId','workflowAttemptId','authorizationSha256','answerText','answerSha256','recordedAt'].includes(k)) || value.version !== 1 || !sabyText(value.tripId) || !sabyText(value.workflowAttemptId) || !sabyText(value.answerText) || !/^[a-f0-9]{64}$/.test(String(value.authorizationSha256)) || value.answerSha256 !== bytesHash(Buffer.from(String(value.answerText))) || !isDate(value.recordedAt)) throw new Error('Invalid order redirection approval');
}
export interface EtrnDocument extends Omit<EtrnDocumentSummary, 'files'> {
  dispatch?: EtrnDispatch;
  /** Opt-in only when a new unsigned T1 is about to be uploaded. Historical XML stays unchanged. */
  senderTitleVersion?: 2;
  /** Number is assigned by Saby from a complete, unsigned draft, then read back. */
  directDraftCreation?: { version: 'auto-number-v1'; numberFinalizationAttempted?: true; filenameCorrection?: { rejectedBodySha256: string; reconciledAt: string } };
  nativeAdoptionEvidence?: EtrnNativeAdoptionEvidence;
  nativeSenderAmendment?: EtrnNativeSenderAmendment;
  /** Durable request fingerprints and safe outcomes; never headers, parameters or raw response bodies. */
  writeAttempts?: EtrnWriteAttempt[];
  /** Original native draft and exact requested fill; never replaces the frozen delivery. */
  linkedDraft?: LinkedDraftState;
  /** New driver attempts opt in; historical uncertain attempts require explicit scoped recovery. */
  nativeDraftEnabled?: boolean;
  /** Frozen order allocation protocol; historical attempts require explicit scoped adoption. */
  orderDraftVersion?: 1;
  orderRedirectionApproval?: OrderRedirectionApproval;
  orderAutoNumber?: { version: 1; numberFinalizationAttempted?: true };
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
export interface EtrnExchangeHistoryEntry {
  id: string; archivedAt: string; actorId: string; sha256: string;
  exchange: { direct: NkDirectEtrnRecord; deliveries: Record<string, EtrnDelivery>; directAutostart?: NkDirectAutostart };
}
export interface EtrnRebuildRecord {
  id: string; at: string; actorId: string; archivedSha256: string; sourceFingerprint: string; externalRestartBlocked: true;
}
export interface EtrnTrip {
  orderRedirectionApproval?: OrderRedirectionApproval;
  deliveries: Record<string, EtrnDelivery>; updatedAt: string; loadingFacts?: TripLoadingFacts;
  direct?: NkDirectEtrnRecord; directAutostart?: NkDirectAutostart; loadingDetails?: EtrnLoadingDetails;
  /** Explicitly confirmed for this trip; absence retains the depot's loading party. */
  loadingActorMode?: 'sender';
  exchangeHistory?: EtrnExchangeHistoryEntry[]; rebuild?: EtrnRebuildRecord;
}
export interface EtrnData { trips: Record<string, EtrnTrip> }
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
    validateOrderRedirectionApproval(trip.orderRedirectionApproval);
    if (trip.loadingFacts !== undefined) validateLoadingFacts(trip.loadingFacts);
    if (trip.loadingActorMode !== undefined && trip.loadingActorMode !== 'sender') throw new Error('Invalid loading actor mode');
    if (trip.loadingDetails !== undefined && (!sabyObject(trip.loadingDetails) || JSON.stringify(trip.loadingDetails) !== JSON.stringify(readEtrnLoadingDetails(trip.loadingDetails)))) throw new Error('Invalid loading details');
    if (trip.exchangeHistory !== undefined) {
      if (!Array.isArray(trip.exchangeHistory) || !trip.exchangeHistory.length || trip.exchangeHistory.length > 20) throw new Error('Invalid ETRN exchange history');
      const ids = new Set<string>();
      for (const item of trip.exchangeHistory) {
        if (!sabyObject(item) || Object.keys(item).some(key => !['id','archivedAt','actorId','sha256','exchange'].includes(key)) || typeof item.id !== 'string' || !item.id || ids.has(item.id) || !isDate(item.archivedAt) || typeof item.actorId !== 'string' || !item.actorId || !sabyObject(item.exchange) || !item.exchange.direct || Object.keys(item.exchange).some(key => !['direct','deliveries','directAutostart'].includes(key)) || item.sha256 !== hash(item.exchange)) throw new Error('Invalid ETRN archived exchange');
        ids.add(item.id);
        validateEtrnData({ trips: { [tripId]: { ...item.exchange, updatedAt: item.archivedAt } } });
      }
    }
    if (trip.rebuild !== undefined) {
      const record = trip.rebuild;
      if (!sabyObject(record) || Object.keys(record).some(key => !['id','at','actorId','archivedSha256','sourceFingerprint','externalRestartBlocked'].includes(key)) || typeof record.id !== 'string' || !record.id || !isDate(record.at) || typeof record.actorId !== 'string' || !record.actorId || record.externalRestartBlocked !== true || typeof record.sourceFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.sourceFingerprint) || !trip.exchangeHistory?.some(item => item.id === record.id && item.sha256 === record.archivedSha256 && item.actorId === record.actorId && item.archivedAt === record.at)) throw new Error('Invalid ETRN rebuild record');
      if (trip.direct || trip.directAutostart || Object.values(trip.deliveries).some(row => sabyObject(row) && row.document)) throw new Error('Blocked ETRN rebuild cannot carry an active exchange');
    }

    validateNkDirectEtrn(trip.direct, tripId);
    validateNkDirectAutostart(trip.directAutostart);
    for (const [shipmentId, delivery] of Object.entries(trip.deliveries)) {
      if (!shipmentId || !sabyObject(delivery) || !sabyObject(delivery.profile) || !sabyObject(delivery.snapshot) || delivery.snapshot.tripId !== tripId || delivery.snapshot.shipmentId !== shipmentId || delivery.preparedHash !== hash(delivery.snapshot) || !isDate(delivery.updatedAt)) throw new Error('Invalid ETRN preparation');
      const doc = delivery.document;
      if (doc === null) continue;
      if (sabyObject(doc)) validateOrderRedirectionApproval(doc.orderRedirectionApproval);
      if (sabyObject(doc)) validateEtrnDispatch(doc.dispatch, typeof doc.id === 'string' ? doc.id : null);
      if (sabyObject(doc)) validateLinkedDraftState(doc.linkedDraft, typeof doc.id === 'string' ? doc.id : null);
      if (sabyObject(doc) && (doc.nativeDraftEnabled !== undefined && typeof doc.nativeDraftEnabled !== 'boolean' || doc.linkedDraft !== undefined && doc.nativeDraftEnabled !== true)) throw new Error('Invalid native ETRN recovery policy');
      if (sabyObject(doc) && doc.unexpectedDocumentIds !== undefined && (!Array.isArray(doc.unexpectedDocumentIds) || doc.unexpectedDocumentIds.length > 10 || !doc.unexpectedDocumentIds.every(id => typeof id === 'string' && id.trim() && id.length <= 256))) throw new Error('Invalid unexpected ETRN identifiers');
      if (sabyObject(doc) && (doc.number !== undefined && (typeof doc.number !== 'string' || !doc.number.trim()) || doc.reservationAttempted !== undefined && typeof doc.reservationAttempted !== 'boolean' || doc.uploadAttempted !== undefined && typeof doc.uploadAttempted !== 'boolean')) throw new Error('Invalid ETRN numbering');
      if (sabyObject(doc) && doc.senderTitleVersion === 2 && sabyObject(doc.dispatch) && sabyObject(doc.dispatch.sender) && doc.dispatch.sender.verified === true && !validConsignmentOperatorUid(doc.dispatch.operatorUid)) throw new Error('Missing verified ETRN operator UID');
      if (sabyObject(doc) && doc.senderTitleVersion !== undefined && doc.senderTitleVersion !== 2) throw new Error('Invalid ETRN title protocol');
      if (sabyObject(doc) && doc.orderDraftVersion !== undefined && (doc.orderDraftVersion !== 1 || doc.senderTitleVersion !== 2 || sabyObject(doc.snapshot) && doc.snapshot.documentMode === 'nk-direct-v1')) throw new Error('Invalid order allocation protocol');
      if (sabyObject(doc) && doc.orderAutoNumber !== undefined && (!sabyObject(doc.orderAutoNumber) || doc.orderAutoNumber.version !== 1 || Object.keys(doc.orderAutoNumber).some(key => !['version', 'numberFinalizationAttempted'].includes(key)) || doc.orderAutoNumber.numberFinalizationAttempted !== undefined && doc.orderAutoNumber.numberFinalizationAttempted !== true || doc.orderDraftVersion !== 1 || doc.nativeDraftEnabled)) throw new Error('Invalid order auto-number protocol');
      if (sabyObject(doc) && doc.directDraftCreation !== undefined && (!sabyObject(doc.directDraftCreation) || doc.directDraftCreation.version !== 'auto-number-v1' || Object.keys(doc.directDraftCreation).some(key => !['version', 'numberFinalizationAttempted', 'filenameCorrection'].includes(key)) || doc.directDraftCreation.numberFinalizationAttempted !== undefined && doc.directDraftCreation.numberFinalizationAttempted !== true || doc.senderTitleVersion !== 2 || !sabyObject(doc.snapshot) || doc.snapshot.documentMode !== 'nk-direct-v1')) throw new Error('Invalid direct ETRN auto-number protocol');
      if (sabyObject(doc) && sabyObject(doc.directDraftCreation) && doc.directDraftCreation.filenameCorrection !== undefined) {
        const repair = doc.directDraftCreation.filenameCorrection;
        if (!sabyObject(repair) || Object.keys(repair).some(key => !['rejectedBodySha256', 'reconciledAt'].includes(key)) || typeof repair.rejectedBodySha256 !== 'string' || !/^[a-f0-9]{64}$/.test(repair.rejectedBodySha256) || !isDate(repair.reconciledAt)) throw new Error('Invalid direct ETRN filename correction');
      }
      if (sabyObject(doc) && doc.writeAttempts !== undefined) {
        if (!Array.isArray(doc.writeAttempts) || doc.writeAttempts.length > 20) throw new Error('Invalid ETRN write audit');
        for (const attempt of doc.writeAttempts) {
          if (!sabyObject(attempt) || Object.keys(attempt).some(key => !['action', 'request', 'outcome', 'response', 'result'].includes(key)) || !['reservation', 'upload'].includes(String(attempt.action)) || !isSabyRequestIntent(attempt.request) || attempt.request.method !== 'СБИС.ЗаписатьДокумент' || !attempt.request.bodySha256 || !['attempted', 'received', 'uncertain', 'denied'].includes(String(attempt.outcome)) || attempt.response !== undefined && !isSabyResponseDiagnostic(attempt.response)) throw new Error('Invalid ETRN write audit');
          if (attempt.result !== undefined && (!sabyObject(attempt.result) || Object.keys(attempt.result).some(key => !['id', 'receivedAt'].includes(key)) || typeof attempt.result.id !== 'string' || !attempt.result.id.trim() || attempt.result.id.length > 256 || !isDate(attempt.result.receivedAt))) throw new Error('Invalid ETRN write result');
        }
      }
      if (!sabyObject(doc) || !['pending', 'unknown', 'draft', 'error'].includes(String(doc.status)) || !nullable(doc.id) || !nullable(doc.revision) || !nullable(doc.url) || !nullable(doc.remoteStatus) || !nullable(doc.lastError) || !nullable(doc.gisStatus) || !['not_signed','reported_by_saby','unknown'].includes(String(doc.signatureStatus)) || !Array.isArray(doc.availableActions) || !doc.availableActions.every(v => typeof v === 'string') || !isDate(doc.updatedAt) || !isDate(doc.createdAt) || typeof doc.marker !== 'string' || !doc.marker.startsWith('ARTEL-CRM:ETRN:') || typeof doc.attemptId !== 'string' || !doc.attemptId || !sabyObject(doc.snapshot) || doc.snapshot.tripId !== tripId || doc.snapshot.shipmentId !== shipmentId || doc.payloadHash !== hash(doc.snapshot) || !nullable(doc.leaseId) || !(doc.leaseUntil === null || isDate(doc.leaseUntil)) || !Array.isArray(doc.artifacts) || doc.artifacts.length > 500 || doc.status === 'draft' && !doc.id) throw new Error('Invalid ETRN document');
      validateNativeAdoptionEvidence(doc as unknown as EtrnDocument);
      validateNativeSenderAmendment(doc as unknown as EtrnDocument, tripId, trip.direct as NkDirectEtrnRecord | undefined);
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

export function validateNativeSenderAmendment(doc: EtrnDocument, tripId: string, direct: NkDirectEtrnRecord | undefined): void {
  const amendment = doc.nativeSenderAmendment;
  if (amendment === undefined) return;
  const keys = ['version', 'tripId', 'documentId', 'documentNumber', 'documentRevision', 'attachmentId', 'payloadHash', 'directAttemptId', 'authorizationSha256', 'originalPreparedHash', 'sourceXmlSha256', 'beforeMethod', 'afterMethod', 'source', 'answerText', 'approvalReference', 'recordedAt', 'approvalTextSha256'];
  const digest = (v: unknown) => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
  const text = (v: unknown) => typeof v === 'string' && !!v.trim() && v.length <= 256 && ![...v].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
  if (!sabyObject(amendment) || Object.keys(amendment).sort().join('|') !== keys.sort().join('|') || !['native-redirection-approval-v1', 'direct-redirection-approval-v2'].includes(amendment.version) ||
      ![amendment.tripId, amendment.documentId, amendment.documentNumber, amendment.documentRevision, amendment.attachmentId, amendment.directAttemptId, amendment.approvalReference].every(text) ||
      ![amendment.payloadHash, amendment.authorizationSha256, amendment.sourceXmlSha256, amendment.approvalTextSha256].every(digest) || amendment.originalPreparedHash !== null && !digest(amendment.originalPreparedHash) ||
      amendment.beforeMethod !== 'По телефону' || amendment.afterMethod !== NATIVE_APPROVED_REDIRECTION_METHOD || amendment.source !== 'explicit_user_instruction' ||
      (amendment.version === 'native-redirection-approval-v1' ? amendment.answerText !== 'Принять электронное уведомление Saby' : !text(amendment.answerText)) || amendment.approvalTextSha256 !== bytesHash(Buffer.from(amendment.answerText, 'utf8')) || !isDate(amendment.recordedAt)) throw new Error('Invalid native sender amendment');
  validateNativeAdoptionEvidence(doc);
  const adoption = doc.nativeAdoptionEvidence, prepared = doc.dispatch?.sender.prepared;
  const manifestTitle = prepared?.attachments.filter(file => file.subtype === '1110339' && file.id === amendment.attachmentId);
  const nativeOrigin = amendment.version === 'native-redirection-approval-v1' && adoption?.stage === 'verified' && !!adoption.verified &&
    amendment.documentRevision === adoption.verified.revision && amendment.attachmentId === adoption.verified.attachmentId;
  // The same scoped amendment can cover a CRM-created T1, without fabricating native UI adoption.
  // It must pin the already durable Prepare and the acknowledged creation of this exact document.
  const directOrigin = amendment.version === 'direct-redirection-approval-v2' && !adoption && doc.directDraftCreation?.version === 'auto-number-v1' &&
    !!amendment.originalPreparedHash && !!prepared && prepared.binding.documentId === doc.id && prepared.binding.revision === amendment.documentRevision &&
    prepared.binding.attachmentId === amendment.attachmentId && doc.revision === amendment.documentRevision && doc.uploadAttempted === true &&
    doc.writeAttempts?.some(attempt => attempt.action === 'reservation' && attempt.outcome === 'received' && attempt.result?.id === doc.id);
  if (!direct || !(nativeOrigin || directOrigin) || doc.senderTitleVersion !== 2 || doc.snapshot.documentMode !== 'nk-direct-v1' ||
      amendment.tripId !== tripId || doc.snapshot.tripId !== tripId || amendment.documentId !== doc.id || amendment.documentNumber !== doc.number ||
      amendment.payloadHash !== doc.payloadHash ||
      amendment.payloadHash !== hash(doc.snapshot) || amendment.directAttemptId !== direct.attemptId || amendment.authorizationSha256 !== hash(direct.authorization) ||
      direct.deliveries.filter(row => row.shipmentId === doc.snapshot.shipmentId && hash(row.snapshot) === doc.payloadHash).length !== 1 ||
      doc.snapshot.profile.instructions.redirectionMethod !== amendment.beforeMethod ||
      (amendment.originalPreparedHash === null ? amendment.sourceXmlSha256 !== adoption?.verified?.xmlSha256 :
        prepared?.preparedHash !== amendment.originalPreparedHash || manifestTitle?.length !== 1 || manifestTitle[0].sha256 !== amendment.sourceXmlSha256)) throw new Error('Unbound native sender amendment');
}

/** Build verification context only from the current API title and the saved document/grant-bound instruction. */
export function nativeSenderAmendmentOptions(doc: EtrnDocument, direct: NkDirectEtrnRecord | undefined, remote: SabyObject): SabyConsignmentEvidenceOptions {
  const result: SabyConsignmentEvidenceOptions = { senderTitleVersion: doc.senderTitleVersion, phase: doc.dispatch?.operatorUid ? 'prepared' : 'unprepared', operatorUid: doc.dispatch?.operatorUid };
  const amendment = doc.nativeSenderAmendment;
  const frozenElectronic = (doc.orderDraftVersion === 1 || doc.snapshot.documentMode === 'nk-direct-v1' && doc.snapshot.loadingActorMode === 'sender') && doc.senderTitleVersion === 2 && doc.snapshot.profile.instructions.redirectionMethod === NATIVE_APPROVED_REDIRECTION_METHOD;
  if (!amendment && (doc.orderRedirectionApproval || frozenElectronic) && doc.dispatch?.sender.prepared) {
    validateOrderRedirectionApproval(doc.orderRedirectionApproval);
    const manifest = doc.dispatch.sender.prepared;
    const revision = sabyDocumentWorkflow(remote).revision;
    const files = Array.isArray(remote.Вложение) ? remote.Вложение.filter(sabyObject).filter(x => x.Подтип === '1110339' && x.Удален !== 'Да' && x.Актуален !== 'Нет') : [];
    const saved = manifest.attachments.filter(x => x.subtype === '1110339' && x.id === manifest.binding.attachmentId);
    if ((!frozenElectronic && (doc.orderDraftVersion !== 1 || doc.orderRedirectionApproval?.tripId !== doc.snapshot.tripId)) || manifest.binding.documentId !== doc.id || remote.Идентификатор !== doc.id || remote.Тип !== 'ConsignmentNote' || remote.Номер !== doc.number || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да' || revision !== manifest.binding.revision || files.length !== 1 || files[0].Идентификатор !== manifest.binding.attachmentId || saved.length !== 1 || !sabyObject(files[0].Редакция) || !sabyText(files[0].Редакция.Номер) || !sabyText(files[0].СсылкаВКабинет)) throw new SabyError('validation', 'Не подтверждён подготовленный титул согласованной ЭТрН заявки.');
    result.phase = 'prepared'; result.orderCoordinatePolicy = doc.orderDraftVersion === 1;
    result.nativeAmendment = { beforeMethod: frozenElectronic ? NATIVE_APPROVED_REDIRECTION_METHOD : 'По телефону', afterMethod: NATIVE_APPROVED_REDIRECTION_METHOD, preparedXmlSha256: saved[0].sha256,
      attachment: { documentId: doc.id!, revision: revision!, attachmentId: String(files[0].Идентификатор), cabinetUrl: String(files[0].СсылкаВКабинет), revisionNumber: String(files[0].Редакция.Номер) } };
    return result;
  }
  if (!amendment) return result;
  validateNativeSenderAmendment(doc, doc.snapshot.tripId, direct);
  result.phase = doc.dispatch?.sender.prepared || doc.dispatch?.operatorUid ? 'prepared' : 'unprepared';
  const revision = sabyDocumentWorkflow(remote).revision;
  const titles = Array.isArray(remote.Вложение) ? remote.Вложение.filter(row => sabyObject(row) && row.Подтип === '1110339' && row.Удален !== 'Да' && row.Актуален !== 'Нет') : [];
  if (remote.Идентификатор !== amendment.documentId || remote.Тип !== 'ConsignmentNote' || remote.Номер !== amendment.documentNumber || remote.ЧастичныеДанные === 'Да' || remote.Удален === 'Да' ||
      revision !== amendment.documentRevision || titles.length !== 1 || !sabyObject(titles[0]) || titles[0].Идентификатор !== amendment.attachmentId ||
      !sabyObject(titles[0].Редакция) || !sabyText(titles[0].Редакция.Номер) || !sabyText(titles[0].СсылкаВКабинет)) throw new SabyError('validation', 'Не подтверждена текущая редакция и служебная ссылка согласованного титула Saby.');
  result.nativeAmendment = { beforeMethod: amendment.beforeMethod, afterMethod: amendment.afterMethod, ...(amendment.version === 'direct-redirection-approval-v2' ? { preparedXmlSha256: amendment.sourceXmlSha256 } : {}), attachment: {
    documentId: amendment.documentId, revision, attachmentId: amendment.attachmentId,
    cabinetUrl: String(titles[0].СсылкаВКабинет), revisionNumber: String(titles[0].Редакция.Номер),
  } };
  return result;
}

export function hasEtrnDocuments(data: OperationsData, tripId: string): boolean {
  if (data.etrn?.trips[tripId]?.exchangeHistory?.length || data.etrn?.trips[tripId]?.rebuild) return true;
  return Object.values(data.etrn?.trips[tripId]?.deliveries ?? {}).some(row => row.document && (row.document.status !== 'error' || !!row.document.id));
}
function makeSnapshot(snapshot: Snapshot, data: OperationsData, tripId: string, shipmentId: string, profile: SabyConsignmentProfile | null, config: SabyConfig) {
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
  return getEtrnTripFromSnapshot(currentSnapshot(base, data), data, tripId, config);
}
function getEtrnTripFromSnapshot(fullSnapshot: Snapshot, data: OperationsData, tripId: string, config: SabyConfig): EtrnTripResponse {
  const trip = getShipmentTrip(fullSnapshot, tripId);
  const direct = isNkDirectEtrn(trip, data);
  if (!direct) assertTripTransportDocumentsAllowed(trip, data);
  const saved = data.etrn?.trips[tripId];
  const directPrepared = direct && trip.customers.some(requiresEtrn) ? preparedNkDirectFromSnapshot(fullSnapshot, data, tripId, config) : null;
  if (direct) config = new SabyClient(config).forNkDirectEtrn().config;
  const configurationBlockers = sabyConfigurationBlockers(config);
  const displayOrganization = (org: SabyConfig['customer']) => ({ name: org.name, inn: org.inn, kpp: org.kpp, address: org.address, phone: org.phone ?? '' });
  return { configured: !configurationBlockers.length, configurationBlockers, updatedAt: saved?.updatedAt ?? null,
    organizations: { consignor: displayOrganization(config.customer), carrier: displayOrganization(config.carrier) },
    deliveries: trip.customers.filter(requiresEtrn).map(row => {
      const preparation = saved?.deliveries[row.id];
      const doc = preparation?.document;
      const snapshot = directPrepared ? doc?.snapshot ?? saved?.direct?.deliveries.find(item => item.shipmentId === row.id)?.snapshot ?? directPrepared.deliveries.find(item => item.shipmentId === row.id)!.snapshot : doc && doc.status !== 'error' ? doc.snapshot : preparation?.sourceOrderId ? preparation.snapshot : makeSnapshot(fullSnapshot, data, tripId, row.id, preparation?.profile ?? null, config);
      const stale = preparation && !doc && hash(snapshot) !== preparation.preparedHash;
      return { shipmentId: row.id, profile: snapshot.profile, blockers: [...sabyConsignmentBlockers(snapshot), ...(stale ? ['Данные рейса или справочников изменились. Сохраните и проверьте подготовку повторно.'] : [])], document: doc ? documentSummary(doc, tripId, row.id) : null };
    }),
  };
}
type Authorize = (snapshot: ShipmentAccessContext, data: OperationsData) => void;
export interface EtrnOptions { base: Snapshot; store: OperationsStorage; tripId: string; authorize: Authorize; client?: SabyClient }

export async function saveEtrnProfile(options: EtrnOptions, shipmentId: string, raw: unknown): Promise<EtrnTripResponse> {
  const { base, store, tripId, authorize } = options;
  const config = options.client?.config ?? sabyConfigFromEnv();
  if (!sabyObject(raw) || JSON.stringify(raw).length > 80_000) throw new ApiError(400, 'Некорректные данные подготовки ЭТрН.');
  const profile = readSabyConsignmentProfile(raw);
  await store.mutate(base.provenance.sourceSha256, data => {
    const fullSnapshot = currentSnapshot(base, data);
    authorize(fullSnapshot, data);
    assertTripTransportDocumentsAllowed(getShipmentTrip(fullSnapshot, tripId), data);
    if (data.tripSaby?.trips[tripId]) throw new ApiError(409, 'Рейс запущен в Saby. Исправления документов выполняются в Saby; факты погрузки вводятся отдельно.');
    const previous = data.etrn?.trips[tripId]?.deliveries[shipmentId];
    if (previous?.document && (previous.document.status !== 'error' || previous.document.id)) throw new ApiError(409, 'ЭТрН уже передана или результат передачи неизвестен. Сначала выполните сверку.');
    const snapshot = makeSnapshot(fullSnapshot, data, tripId, shipmentId, profile, config);
    data.etrn ??= { trips: {} };
    const trip = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: stamp() };
    trip.deliveries[shipmentId] = { profile: snapshot.profile!, snapshot, preparedHash: hash(snapshot), document: null, updatedAt: stamp() };
    trip.updatedAt = stamp();
    return { result: undefined, changed: true };
  });
  const data = await store.read(base.provenance.sourceSha256), fullSnapshot = currentSnapshot(base, data);
  authorize(fullSnapshot, data);
  return getEtrnTripFromSnapshot(fullSnapshot, data, tripId, config);
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

/** Refresh the title actually verified for signing, never the superseded pre-Prepare draft. */
export function verifyPreparedLinkedConsignmentTitle(doc: EtrnDocument, remote: SabyObject, bytes: Uint8Array): void {
  const sender = doc.dispatch?.sender, manifest = sender?.prepared;
  if (!doc.linkedDraft?.writeConfirmed || !sender?.verified || !manifest) throw new SabyError('validation', 'Нет проверенного задания на подпись связанной ЭТрН.');
  validateEtrnDispatch(doc.dispatch, doc.id);
  assertSigningManifest(manifest);
  const binding = manifest.binding;
  const titles = Array.isArray(remote.Вложение) ? remote.Вложение.filter(sabyObject).filter(file => file.Подтип === '1110339' && file.Удален !== 'Да' && file.Актуален !== 'Нет') : [];
  const pinned = manifest.attachments.filter(file => file.id === binding.attachmentId && file.subtype === '1110339');
  if (remote.Идентификатор !== doc.id || binding.documentId !== doc.id || binding.side !== 'sender' || binding.documentType !== 'ConsignmentNote' ||
      sabyDocumentWorkflow(remote).revision !== binding.revision || titles.length !== 1 || titles[0].Идентификатор !== binding.attachmentId ||
      pinned.length !== 1 || pinned[0].sha256 !== bytesHash(bytes)) throw new SabyError('validation', 'Текущий титул ЭТрН отличается от проверенного задания на подпись. Требуется сверка.');
  verifyConsignmentSenderBusiness(bytes, serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, doc.number, { senderTitleVersion: doc.senderTitleVersion }).xml,
    doc.orderDraftVersion === 1 ? 'address-order-v1' : undefined, nativeSenderAmendmentOptions(doc, undefined, remote));
}

/** Persist the intent before network; reconcile unknown results without any second write. */
export async function exchangeEtrn(options: EtrnOptions, shipmentId: string, refresh = false): Promise<EtrnTripResponse> {
  const { base, store, tripId, authorize } = options;
  let client = options.client ?? new SabyClient(sabyConfigFromEnv());
  const source = base.provenance.sourceSha256;
  const leaseId = randomUUID();
  const claimed = await store.mutate(source, data => {
    const fullSnapshot = currentSnapshot(base, data);
    authorize(fullSnapshot, data);
    assertTripTransportDocumentsAllowed(getShipmentTrip(fullSnapshot, tripId), data);
    if (data.tripSaby?.trips[tripId] && !refresh) throw new ApiError(409, 'ЭТрН этого рейса создаются общей цепочкой Saby после подтверждения перевозчика.');
    const preparation = data.etrn?.trips[tripId]?.deliveries[shipmentId];
    if (!preparation) throw new ApiError(422, 'Сначала сохраните и проверьте сведения ЭТрН.');
    // Check membership even for old records, and forbid writes against another organization.
    const fresh = makeSnapshot(fullSnapshot, data, tripId, shipmentId, preparation.profile, client.config);
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
      const data = await store.read(source); authorize(currentShipmentAccess(base, data), data);
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
        ...(claimed.dispatch?.sender.verified && claimed.dispatch.sender.prepared ? { verifyPreparedTitle: (remote: SabyObject, bytes: Uint8Array) => verifyPreparedLinkedConsignmentTitle({ ...claimed, id }, remote, bytes) } : {}),
        checkAccess,
        ...(claimed.linkedDraft.allocation ? {
          allocationSnapshots: latest.tripSaby!.trips[tripId].deliveries.map(row => latest.etrn!.trips[tripId].deliveries[row.shipmentId]?.document?.snapshot ?? snapshotWithLoading(row.snapshot, latest.etrn!.trips[tripId].loadingFacts!, { id: claimed.linkedDraft!.sourceOrderId, number: claimed.linkedDraft!.sourceOrderNumber, date: claimed.linkedDraft!.sourceOrderDate })),
          allocationDocumentIds: Object.values(latest.etrn!.trips[tripId].deliveries).map(row => row.document?.id).filter((id): id is string => !!id),
        } : {}),
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
  const data = await store.read(source), fullSnapshot = currentSnapshot(base, data);
  authorize(fullSnapshot, data);
  return getEtrnTripFromSnapshot(fullSnapshot, data, tripId, client.config);
}

export async function saveTripLoadingFacts(options: EtrnOptions, raw: unknown, actorId: string): Promise<void> {
  const { base, store, tripId, authorize } = options;
  if (!sabyObject(raw) || Object.keys(raw).some(key => !['arrivedAt', 'departedAt', 'deliveries'].includes(key))) throw new ApiError(400, 'Проверьте сведения о фактической погрузке.');
  const facts = { ...raw, recordedAt: stamp(), actorId };
  try { validateLoadingFacts(facts); } catch { throw new ApiError(400, 'Укажите фактические прибытие и убытие, положительную массу каждой доставки в тоннах и способ определения массы.'); }
  if (Date.parse(`${facts.departedAt}+03:00`) > Date.now()) throw new ApiError(400, 'Фактическое убытие не может быть в будущем.');
  await store.mutate(base.provenance.sourceSha256, data => {
    const fullSnapshot = currentSnapshot(base, data);
    authorize(fullSnapshot, data);
    const workflow = data.tripSaby?.trips[tripId];
    if (getShipmentTrip(fullSnapshot, tripId).fields.trip_flow_version === 'driver-v1') throw new ApiError(409, 'Факты этого рейса фиксирует назначенный водитель действиями «Прибыл» и «Убыл».');
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
  const initial = await store.read(source), initialSnapshot = currentSnapshot(base, initial);
  authorize(initialSnapshot, initial);
  if (direct) authorizeNkDirectFromSnapshot(base, initialSnapshot, initial, tripId, client.config);
  const initialTrip = getShipmentTrip(initialSnapshot, tripId);
  if (!direct) assertTripTransportDocumentsAllowed(initialTrip, initial);
  requireEtrnDelivery(initialTrip, shipmentId);
  const facts = initial.etrn?.trips[tripId]?.loadingFacts;
  if (!facts) return { status: 'error', id: null, lastError: 'Заявка подтверждена. Заполните фактические сведения погрузки всего рейса.', waitingForLoading: true };
  // Validate ALL deliveries before the first consignment reservation, including saved actual facts.
  const allErrors = direct ? preparedNkDirectFromSnapshot(initialSnapshot, initial, tripId, client.config).blockers : (initial.tripSaby?.trips[tripId]?.deliveries ?? []).flatMap(row => sabyConsignmentBlockers(snapshotWithLoading(row.snapshot, facts, orderInput!.order)));
  if (allErrors.length) return { status: 'error', id: null, lastError: [...new Set(allErrors)].join(' ') };
  const claimed = await store.mutate(source, data => {
    const current = currentSnapshot(base, data);
    authorize(current, data);
    if (direct) authorizeNkDirectFromSnapshot(base, current, data, tripId, client.config);
    const currentTrip = getShipmentTrip(current, tripId);
    if (!direct) assertTripTransportDocumentsAllowed(currentTrip, data);
    requireEtrnDelivery(currentTrip, shipmentId);
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
    const doc: EtrnDocument = existing?.document ?? { id: null, revision: null, status: 'pending', url: null, remoteStatus: null, lastError: null, updatedAt: time, createdAt: time, marker: `ARTEL-CRM:ETRN:${randomUUID()}`, attemptId: randomUUID(), payloadHash: hash(snapshot), snapshot, artifacts: [], signatureStatus: 'unknown', gisStatus: null, availableActions: [], leaseId: null, leaseUntil: null, reservationAttempted: false, uploadAttempted: false, ...(!direct && workflow?.driverFlow ? { orderDraftVersion: 1 as const, senderTitleVersion: 2 as const, ...(data.etrn?.trips[tripId]?.orderRedirectionApproval ? { orderRedirectionApproval: structuredClone(data.etrn.trips[tripId].orderRedirectionApproval) } : {}), ...(workflow.deliveries[0].shipmentId === shipmentId ? { nativeDraftEnabled: true } : {}) } : {}) };
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
    const data = await store.read(source); authorize(currentShipmentAccess(base, data), data);
    const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
    if (!current || current.leaseId !== leaseId || !current.leaseUntil || Date.parse(current.leaseUntil) <= Date.now()) throw new ApiError(409, 'Сеанс ЭТрН истёк. Выполните сверку.');
  };
  client = client.withRequestGuard(checkAccess);
  const validateReservation = (remote: SabyObject) => {
    const parties = sabyObject(remote.Стороны) ? remote.Стороны : {};
    if (remote.Идентификатор !== doc.id || remote.Тип !== 'ConsignmentNote' || remote.Примечание !== doc.marker || remote.Дата !== doc.snapshot.fields.date?.split('-').reverse().join('.') || !sabyText(remote.Номер) || doc.number && remote.Номер !== doc.number || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да' || !partyMatches(remote.НашаОрганизация, doc.snapshot.customerOrganization) || direct && (!partyMatches(remote.Грузоотправитель ?? parties.Отправитель, doc.snapshot.customerOrganization) || !partyMatches(remote.ТранспортнаяКомпания ?? parties.Перевозчик, doc.snapshot.carrierOrganization) || !partyMatches(remote.Грузополучатель ?? parties.Получатель, doc.snapshot.profile.recipient) || !sabyDocumentWorkflow(remote).revision)) throw new SabyError('unknown', 'Saby не подтвердил номер, реквизиты и редакцию существующей ЭТрН. Новое создание запрещено.', true);
  };
  const orderProtocol = !direct && doc.orderDraftVersion === 1;
  const allocationSnapshots = orderProtocol ? initial.tripSaby!.trips[tripId].deliveries.map(row =>
    initial.etrn?.trips[tripId]?.deliveries[row.shipmentId]?.document?.snapshot ?? snapshotWithLoading(row.snapshot, facts, orderInput!.order)) : undefined;
  const orderDocument = (request: SabyObject): SabyObject => orderProtocol ? { ...request,
    ДокументОснование: [{ ВидСвязи: 'Обычная связь', Документ: { Идентификатор: orderInput!.order.id, Тип: 'TransportOrder', Номер: orderInput!.order.number, Дата: orderInput!.order.date.split('-').reverse().join('.') } }],
  } : request;
  const checkAllocation = async () => {
    if (!orderProtocol || doc.nativeDraftEnabled) return;
    const data = await store.read(source); const workflow = data.tripSaby!.trips[tripId];
    const deliveries = data.etrn!.trips[tripId].deliveries;
    const first = deliveries[workflow.deliveries[0].shipmentId]?.document;
    const allocation = first?.linkedDraft?.allocation;
    if (!first?.id || first.status !== 'draft' || !first.linkedDraft?.writeConfirmed || !allocation ||
        JSON.stringify(allocation.shipmentIds) !== JSON.stringify(workflow.deliveries.map(x => x.shipmentId)) ||
        JSON.stringify(allocation.snapshotHashes) !== JSON.stringify(allocationSnapshots!.map(hash))) throw new SabyError('unknown', 'Исходная ЭТрН ещё не распределена по подтверждённым доставкам. Новая ЭТрН не создаётся.', true);
    const remoteOrder = await client.readTransportOrder(orderInput!.order.id);
    const links = Array.isArray(remoteOrder.ДокументСледствие) ? remoteOrder.ДокументСледствие.filter(sabyObject).map(x => x.Документ).filter(sabyObject).filter(x => x.Тип === 'ConsignmentNote') : [];
    const known = workflow.deliveries.map(x => deliveries[x.shipmentId]?.document?.id).filter(Boolean).sort();
    if (links.length !== known.length || JSON.stringify(links.map(x => x.Идентификатор).sort()) !== JSON.stringify(known)) throw new SabyError('unknown', 'Связанные ЭТрН заявки изменились. Создание следующей доставки остановлено для исключения дублей.', true);
    await checkAccess();
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
    await client.verifyOrganizations(doc.snapshot.customerOrganization, doc.snapshot.carrierOrganization); await checkAccess();
    if ((direct || orderProtocol && !doc.nativeDraftEnabled) && !doc.id && !doc.reservationAttempted) {
      if (doc.uploadAttempted || doc.writeAttempts?.length || doc.dispatch || doc.nativeAdoptionEvidence) throw new SabyError('unknown', 'Прежняя попытка ЭТрН требует сверки; новое создание запрещено.', true);
      // Official WriteDocument accepts T1 at creation and assigns an omitted number.
      // This is an unsigned draft; final numbering and every business field are
      // checked before the ordinary dispatch code can see status=draft.
      await checkAllocation();
      const request = orderDocument(buildSabyConsignmentDocument(doc.snapshot, doc.marker, doc.attemptId, doc.createdAt, undefined, { senderTitleVersion: 2, draftWithoutNumber: true }));
      writing = 'reservation';
      const created = await client.writeConsignmentNote(request, async intent => {
        await checkAccess();
        await checkAllocation();
        await update({ senderTitleVersion: 2, ...(direct ? { directDraftCreation: { version: 'auto-number-v1' as const } } : { orderAutoNumber: { version: 1 as const } }), uploadAttempted: true });
        await beforeWrite('reservation')(intent);
      });
      const id = sabyText(created.Идентификатор);
      if (!id) throw new SabyError('unknown', 'Saby не вернул идентификатор новой прямой ЭТрН. Повторное создание запрещено.', true);
      await receiveWrite(id, { id, status: 'unknown' });
      writing = null; await checkAccess();
    }
    const linked = doc.nativeDraftEnabled ? await reconcileLinkedConsignmentDraft({
      client, order: orderInput!.order, deliveryCount: initial.tripSaby!.trips[tripId].deliveries.length,
      current: () => doc, update, checkAccess, ...(orderProtocol ? { allocationSnapshots } : {}),
    }) : null;
    if (linked) {
      await update(confirmed(linked, doc, true));
      return { status: doc.status, id: doc.id, lastError: doc.lastError };
    }
    if (!doc.id && doc.reservationAttempted) {
      const found = await client.findDocuments(doc.marker, doc.snapshot.fields.date!.split('-').reverse().join('.'), doc.snapshot.customerOrganization, doc.number, 'ConsignmentNote');
      const rejected = doc.writeAttempts?.length === 1 ? doc.writeAttempts[0] : undefined;
      const response = rejected?.response;
      // A bounded correction of the specific, complete filename validation error.
      // The original receipt and every attempted flag remain intact. Other HTTP
      // 500s, missing/partial replies and old reservations can never enter here.
      if (found.length === 0 && direct && doc.directDraftCreation?.version === 'auto-number-v1' && !doc.directDraftCreation.filenameCorrection && !doc.dispatch && !doc.nativeAdoptionEvidence && rejected?.action === 'reservation' && rejected.outcome === 'uncertain' && response?.httpStatus === 500 && response.bodyState === 'complete' && response.rpcIdMatches === true && response.rpcCode === -32000 && response.message === 'Не указано имя файла вложения') {
        const request = buildSabyConsignmentDocument(doc.snapshot, doc.marker, doc.attemptId, doc.createdAt, undefined, { senderTitleVersion: 2, draftWithoutNumber: true });
        const original = structuredClone(request);
        delete ((original.Вложение as SabyObject[])[0].Файл as SabyObject).Имя;
        const originalBody = JSON.stringify({ jsonrpc: '2.0', method: 'СБИС.ЗаписатьДокумент', params: { Документ: original }, id: rejected.request.requestId });
        if (bytesHash(Buffer.from(originalBody)) !== rejected.request.bodySha256 || Buffer.byteLength(originalBody) !== rejected.request.bodyBytes) throw new SabyError('unknown', 'Исходный отказ Saby не соответствует исправлению имени файла. Повтор запрещён.', true);
        writing = 'reservation';
        const created = await client.writeConsignmentNote(request, async intent => {
          await checkAccess();
          await update({ directDraftCreation: { ...doc.directDraftCreation!, filenameCorrection: { rejectedBodySha256: bytesHash(Buffer.from(originalBody)), reconciledAt: stamp() } } });
          await beforeWrite('reservation')(intent);
        });
        const id = sabyText(created.Идентификатор);
        if (!id) throw new SabyError('unknown', 'Saby не вернул идентификатор после исправления имени файла. Повтор запрещён.', true);
        await receiveWrite(id, { id, status: 'unknown' }); writing = null; await checkAccess();
      } else {
        if (found.length !== 1 || !sabyText(found[0].Идентификатор)) throw new SabyError('unknown', 'Результат создания ЭТрН пока не установлен. Повторное создание запрещено.', true);
        await update({ id: sabyText(found[0].Идентификатор), status: 'unknown' }); await checkAccess();
      }
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
    let uploadedTitle = await client.downloadAttachment(doc.id!, String(titles[0].Идентификатор), revision);
    // Number finalization is only for the unsigned draft. Prepared titles are
    // checked below against their pinned manifest and frozen business fields.
    if ((direct && doc.directDraftCreation || orderProtocol && doc.orderAutoNumber) && !doc.nativeSenderAmendment && !doc.dispatch?.sender.prepared) {
      const expected = serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, doc.number, { senderTitleVersion: 2 }).xml;
      let numbered = false;
      try { verifyConsignmentSenderBusiness(uploadedTitle.bytes, expected, 'address-direct-v1'); numbered = true; } catch { /* Only the exact unnumbered draft below may be completed. */ }
      if (!numbered) {
        verifyConsignmentSenderBusiness(uploadedTitle.bytes, serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, undefined, { senderTitleVersion: 2, draftWithoutNumber: true }).xml, 'address-direct-v1');
        if (doc.directDraftCreation?.numberFinalizationAttempted || doc.orderAutoNumber?.numberFinalizationAttempted || sabyDocumentWorkflow(remote).signatureStatus === 'reported_by_saby' || !sabyObject(remote.Состояние) || String(remote.Состояние.Код) !== '0') throw new SabyError('unknown', 'Номер первого титула не подтверждён после записи либо документ уже подписан. Повторная запись запрещена.', true);
        const request = { ...orderDocument(buildSabyConsignmentDocument(doc.snapshot, doc.marker, doc.attemptId, doc.createdAt, doc.number, { senderTitleVersion: 2 })), Идентификатор: doc.id, Адресация: { Идентификатор: doc.id, Редакция: { Идентификатор: revision } }, Вложение: [{ Идентификатор: String(titles[0].Идентификатор), Файл: { Имя: uploadedTitle.name, ДвоичныеДанные: expected.toString('base64') } }] };
        writing = 'upload';
        const result = await client.writeConsignmentNote(request, async intent => {
          await checkAccess();
          await update(direct ? { directDraftCreation: { ...doc.directDraftCreation!, numberFinalizationAttempted: true } } : { orderAutoNumber: { version: 1, numberFinalizationAttempted: true } });
          await beforeWrite('upload')(intent);
        });
        const returnedId = sabyText(result.Идентификатор);
        if (returnedId) await receiveWrite(returnedId);
        if (returnedId !== doc.id) throw new SabyError('unknown', 'Saby вернул другой документ при подтверждении номера ЭТрН.', true);
        writing = null; await checkAccess();
        remote = await client.readConsignmentNote(doc.id!); validateReservation(remote);
        const currentTitles = Array.isArray(remote.Вложение) ? remote.Вложение.filter(row => sabyObject(row) && row.Подтип === '1110339' && row.Удален !== 'Да') : [];
        const currentRevision = sabyDocumentWorkflow(remote).revision;
        if (currentTitles.length !== 1 || !sabyObject(currentTitles[0]) || currentTitles[0].Идентификатор !== titles[0].Идентификатор || !currentRevision) throw new SabyError('unknown', 'Saby изменил идентификатор титула при подтверждении номера ЭТрН.', true);
        uploadedTitle = await client.downloadAttachment(doc.id!, String(currentTitles[0].Идентификатор), currentRevision);
      }
    }
    if (orderProtocol && !doc.nativeDraftEnabled) {
      const bases = Array.isArray(remote.ДокументОснование) ? remote.ДокументОснование.filter(sabyObject).map(x => x.Документ).filter(sabyObject).filter(x => x.Тип === 'TransportOrder') : [];
      if (bases.length !== 1 || bases[0].Идентификатор !== orderInput!.order.id) throw new SabyError('unknown', 'Созданная ЭТрН не подтверждает связь с исходной заявкой. Повторное создание запрещено.', true);
      await checkAllocation();
    }
    const amendmentData = await store.read(source);
    verifyConsignmentSenderBusiness(uploadedTitle.bytes, serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, doc.number, { senderTitleVersion: doc.senderTitleVersion }).xml, doc.snapshot.documentMode === 'nk-direct-v1' ? 'address-direct-v1' : undefined, nativeSenderAmendmentOptions(doc, amendmentData.etrn?.trips[tripId]?.direct, remote));
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
  const fullSnapshot = currentSnapshot(base, data), trip = getShipmentTrip(fullSnapshot, tripId);
  const direct = isNkDirectEtrn(trip, data);
  if (!direct) assertTripTransportDocumentsAllowed(trip, data);
  requireEtrnDelivery(trip, shipmentId);
  const row = data.etrn?.trips[tripId]?.deliveries[shipmentId];
  if (!row) throw new ApiError(422, 'Сначала сохраните подготовку ЭТрН.');
  if (row.document?.linkedDraft) {
    const saved = row.document.linkedDraft;
    validateLinkedDraftState(saved, row.document.id);
    return { xml: Buffer.from(saved.filledBase64, 'base64'), name: saved.attachmentName, number: saved.documentNumber, uid: row.document.attemptId };
  }
  const snapshot = row.document?.snapshot ?? (direct ? row.snapshot : makeSnapshot(fullSnapshot, data, tripId, shipmentId, row.profile, config));
  const errors = sabyConsignmentBlockers(snapshot);
  if (errors.length) throw new ApiError(422, errors.join(' '));
  return serializeSabyConsignmentNote(snapshot, row.document?.attemptId ?? '00000000-0000-4000-8000-000000000001', row.document?.createdAt ?? row.updatedAt, row.document?.number, { senderTitleVersion: row.document?.senderTitleVersion });
}

/** Cache immutable bytes privately in the store; never expose session-bearing vendor links. */
export async function downloadEtrnFile(options: EtrnOptions, shipmentId: string, key: string) {
  const { base, store, tripId, authorize } = options;
  const source = base.provenance.sourceSha256;
  const data = await store.read(source), fullSnapshot = currentSnapshot(base, data);
  authorize(fullSnapshot, data);
  const trip = getShipmentTrip(fullSnapshot, tripId);
  const direct = isNkDirectEtrn(trip, data);
  if (!direct) assertTripTransportDocumentsAllowed(trip, data);
  requireEtrnDelivery(trip, shipmentId);
  const doc = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
  const file = doc?.artifacts.find(file => file.key === key);
  if (!doc?.id || !file) throw new ApiError(404, 'Файл ЭТрН не найден.');
  if (file.content) return { bytes: Buffer.from(file.content, 'base64'), name: file.name, extension: file.extension };
  // A revision can change in Saby; uncached historical bytes must not be replaced by newer ones.
  if (file.revision !== doc.revision) throw new ApiError(409, 'Этот файл относится к предыдущей редакции. Откройте архив редакций в Saby.');
  const suppliedClient = options.client ?? new SabyClient(sabyConfigFromEnv());
  const client = (direct ? suppliedClient.forNkDirectEtrn() : suppliedClient).withRequestGuard(async () => {
    const latest = await store.read(source); authorize(currentShipmentAccess(base, latest), latest);
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

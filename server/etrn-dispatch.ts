import { requireEtrnDelivery } from './trip-etrn-scope';
import { getShipmentTrip } from './shipment-trips';
import { assertTripTransportDocumentsAllowed, isNkDirectEtrn } from './trip-document-mode';
import { authorizeNkDirectEtrn, type NkDirectEtrnRecord } from './nk-direct-etrn';
import { verifyNkRecipientAcceptance } from './nk-direct-recipient-evidence';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './api-error';
import { nativeSenderAmendmentOptions, validateNativeSenderAmendment, validateOrderRedirectionApproval, type EtrnDocument, type EtrnOptions } from './etrn-service';
import { currentShipmentAccess } from './shipment-operations';
import { authorizeAutomaticTripSaby } from './trip-saby-workflow';
import { SabyClient, SabyError, sabyConfigFromEnv, sabyDocumentWorkflow, sabyObject, sabyText, type SabyObject } from './saby-client';
import { assertSigningBinding, assertSigningManifest, captureSignedTitle, createCarrierDraftBinding, createSigningBinding, prepareBoundSigning, prepareCarrierDraft, readPreparedCarrierDraft, reconcileRegeneratedCarrierSigning, readSigningEvidence, restorePreparedSigning, verifyPreparedSigning, signingCertificateForOrganization, type SabySigningBinding, type SabySigningManifest, type SabySigningSide } from './saby-signing';
import { serializeSabyConsignmentNote } from './saby-consignment-note';
import { verifyConsignmentSenderBusiness, verifyConsignmentCarrierBusiness, verifyConsignmentCarrierSourceSignature, fillConsignmentCarrier, validConsignmentOperatorUid } from './saby-consignment-evidence';

export interface EtrnDispatchStep {
  state: 'not_started' | 'preparing' | 'waiting' | 'unknown' | 'blocked' | 'confirmed';
  binding?: SabySigningBinding; prepared?: SabySigningManifest;
  verified?: boolean; executeAttempted?: boolean;
  /** Positive read-only evidence of a signature completed outside this dispatch. Never an Execute intent. */
  observedSignature?: true;
  dispatchState?: 'not_sent' | 'attempted' | 'acknowledged';
}
export interface EtrnDispatch {
  version: 1; sender: EtrnDispatchStep; carrier: EtrnDispatchStep;
  /** Operator-issued UID read from the verified prepared v2 sender title. Never a CRM attempt id. */
  operatorUid?: string;
  /** Read-only linkage of the NK inbox copy to the exact signed sender title. */
  carrierIdentity?: { documentId: string; senderRevision: string; senderAttachmentId: string; titleSha256: string; signatureSha256: string };
  carrierReconciliation?: { version: 1; previousBinding: SabySigningBinding; preparedHash: string };
  carrierDraft?: { binding: SabySigningBinding; state: 'preparing' | 'ready' | 'unknown' };
  carrierFill?: { id: string; revision: string; name: string; beforeHash: string; afterHash: string; attempted: true };
  completedAt?: string; recipientAcceptedAt?: string; lastError?: string;
}
const rows = (value: unknown): SabyObject[] => Array.isArray(value) ? value.filter(sabyObject) : sabyObject(value) ? [value] : [];
const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stamp = () => new Date().toISOString();
const fail = (message: string): never => { throw new SabyError('validation', message); };
export function validateEtrnDispatch(value: unknown, documentId: string | null): void {
  if (value === undefined) return;
  if (!sabyObject(value) || value.version !== 1 || !documentId || Object.keys(value).some(key => !['version', 'sender', 'carrier', 'operatorUid', 'carrierDraft', 'carrierFill', 'carrierIdentity', 'carrierReconciliation', 'completedAt', 'recipientAcceptedAt', 'lastError'].includes(key))) throw new Error('Invalid ETRN dispatch');
  if (value.operatorUid !== undefined && (!validConsignmentOperatorUid(value.operatorUid) || !sabyObject(value.sender) || !value.sender.prepared)) throw new Error('Invalid ETRN operator UID evidence');
  const identity = value.carrierIdentity;
  if (identity !== undefined) {
    if (!sabyObject(identity) || Object.keys(identity).sort().join(',') !== 'documentId,senderAttachmentId,senderRevision,signatureSha256,titleSha256' ||
        !['documentId', 'senderRevision', 'senderAttachmentId'].every(key => /^[a-f0-9-]{36}$/i.test(String(identity[key]))) ||
        !['titleSha256', 'signatureSha256'].every(key => /^[a-f0-9]{64}$/.test(String(identity[key]))) || !sabyObject(value.sender) || value.sender.state !== 'confirmed') throw new Error('Invalid ETRN carrier identity');
    const manifest = value.sender.prepared as SabySigningManifest | undefined;
    if (!manifest || manifest.binding.documentId !== documentId || manifest.binding.revision !== identity.senderRevision || manifest.binding.attachmentId !== identity.senderAttachmentId ||
        !manifest.attachments.some(file => file.id === identity.senderAttachmentId && file.subtype === '1110339' && file.sha256 === identity.titleSha256)) throw new Error('Unbound ETRN carrier identity');
  }
  const carrierId = sabyObject(identity) ? String(identity.documentId) : documentId;
  for (const side of ['sender', 'carrier'] as const) {
    const step = value[side];
    if (!sabyObject(step) || Object.keys(step).some(key => !['state', 'binding', 'prepared', 'verified', 'executeAttempted', 'dispatchState', 'observedSignature'].includes(key)) || !['not_started', 'preparing', 'waiting', 'unknown', 'blocked', 'confirmed'].includes(String(step.state))) throw new Error('Invalid ETRN dispatch step');
    if (step.verified !== undefined && typeof step.verified !== 'boolean' || step.executeAttempted !== undefined && typeof step.executeAttempted !== 'boolean') throw new Error('Invalid ETRN execution flags');
    if (step.binding !== undefined) {
      assertSigningBinding(step.binding as unknown as SabySigningBinding);
      const binding = step.binding as unknown as SabySigningBinding;
      if (binding.documentType !== 'ConsignmentNote' || binding.documentId !== (side === 'carrier' ? carrierId : documentId) || binding.side !== side || binding.keyType !== 'Отложенный') throw new Error('Invalid ETRN dispatch binding');
    }
    if (step.prepared !== undefined) {
      assertSigningManifest(step.prepared as unknown as SabySigningManifest);
      if (JSON.stringify((step.prepared as SabySigningManifest).binding) !== JSON.stringify(step.binding)) throw new Error('Invalid ETRN dispatch manifest');
    }
    if (step.executeAttempted && (!step.prepared || step.verified !== true) || step.state === 'confirmed' && (!step.prepared || !step.executeAttempted && step.observedSignature !== true)) throw new Error('Missing ETRN execution evidence');
    if (step.observedSignature !== undefined && (step.observedSignature !== true || side !== 'carrier' || !identity ||
        !step.prepared || step.verified !== true || step.executeAttempted !== undefined || step.dispatchState !== undefined ||
        (step.binding as SabySigningBinding | undefined)?.stageId !== 'observed-signed' || value.carrierDraft || value.carrierFill || value.carrierReconciliation)) throw new Error('Invalid observed ETRN signature');
    if ((step.binding as SabySigningBinding | undefined)?.stageId === 'observed-signed' && step.observedSignature !== true) throw new Error('Missing observed ETRN signature evidence');
    if (step.dispatchState !== undefined && !['not_sent', 'attempted', 'acknowledged'].includes(String(step.dispatchState))) throw new Error('Invalid ETRN dispatch state');
    if (step.verified && !step.prepared || step.dispatchState === 'not_sent' && (step.executeAttempted || step.verified !== true) || ['attempted', 'acknowledged'].includes(String(step.dispatchState)) && step.executeAttempted !== true) throw new Error('Inconsistent ETRN dispatch state');
  }
  if (value.carrierReconciliation !== undefined) {
    const recovery = value.carrierReconciliation;
    const step = value.carrier as unknown as EtrnDispatchStep;
    const sender = value.sender as unknown as EtrnDispatchStep;
    const direct = sender.state === 'confirmed' && sender.binding?.routePolicy === 'nk-direct-v1' && step.binding?.routePolicy === 'nk-direct-v1' && sender.binding.documentId === documentId && step.binding.documentId === documentId && sender.binding.organizationInn === step.binding.organizationInn && sender.binding.organizationKpp === step.binding.organizationKpp;
    if (!sabyObject(recovery) || recovery.version !== 1 || Object.keys(recovery).sort().join(',') !== 'preparedHash,previousBinding,version' || (!identity && !direct) || !step.prepared || !step.binding || recovery.preparedHash !== step.prepared.preparedHash) throw new Error('Invalid ETRN carrier reconciliation');
    const prior = recovery.previousBinding as SabySigningBinding; assertSigningBinding(prior);
    if (prior.attachmentId === step.binding.attachmentId || prior.attachmentId === 'unprepared-carrier-title' || JSON.stringify({ ...prior, attachmentId: step.binding.attachmentId }) !== JSON.stringify(step.binding)) throw new Error('Changed ETRN carrier reconciliation intent');
  }
  if (value.carrierDraft !== undefined) {
    if (!sabyObject(value.carrierDraft) || !['preparing', 'ready', 'unknown'].includes(String(value.carrierDraft.state))) throw new Error('Invalid ETRN carrier preparation');
    const binding = value.carrierDraft.binding as SabySigningBinding;
    assertSigningBinding(binding);
    if (binding.documentType !== 'ConsignmentNote' || binding.documentId !== carrierId || binding.side !== 'carrier' || binding.attachmentId !== 'unprepared-carrier-title') throw new Error('Invalid ETRN carrier draft binding');
  }
  if (value.carrierFill !== undefined && (!sabyObject(value.carrierFill) || value.carrierFill.attempted !== true || !['id', 'revision', 'name'].every(key => sabyText((value.carrierFill as SabyObject)[key])) || !['beforeHash', 'afterHash'].every(key => /^[a-f0-9]{64}$/.test(String((value.carrierFill as SabyObject)[key]))))) throw new Error('Invalid ETRN carrier fill');
  if (value.recipientAcceptedAt !== undefined && (typeof value.recipientAcceptedAt !== 'string' || !Number.isFinite(Date.parse(value.recipientAcceptedAt)) || !value.completedAt)) throw new Error('Unconfirmed ETRN recipient acceptance');
  if (value.completedAt !== undefined && (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt)) || (value.sender as EtrnDispatchStep).state !== 'confirmed' || (value.carrier as EtrnDispatchStep).state !== 'confirmed')) throw new Error('Unconfirmed ETRN completion');
}
function partyMatches(value: unknown, expected: { inn: string; kpp: string }): boolean {
  if (!sabyObject(value)) return false;
  const party = /^\d{10}$/.test(expected.inn) ? value.СвЮЛ : value.СвФЛ;
  return sabyObject(party) && party.ИНН === expected.inn && (/^\d{12}$/.test(expected.inn) || party.КПП === expected.kpp);
}
function verifyIdentity(remote: SabyObject, doc: EtrnDocument, side: SabySigningSide, expectedId = side === 'carrier' ? doc.dispatch?.carrierIdentity?.documentId ?? doc.id : doc.id): void {
  const p = sabyObject(remote.Стороны) ? remote.Стороны : {};
  const own = side === 'sender' ? doc.snapshot.customerOrganization : doc.snapshot.carrierOrganization;
  if (remote.Тип !== 'ConsignmentNote' || remote.Идентификатор !== expectedId || remote.Номер !== doc.number || remote.Дата !== doc.snapshot.fields.date?.split('-').reverse().join('.') || !partyMatches(remote.НашаОрганизация, own) || !partyMatches(p.Отправитель ?? remote.Грузоотправитель, doc.snapshot.customerOrganization) || !partyMatches(p.Перевозчик ?? remote.ТранспортнаяКомпания ?? remote.Перевозчик, doc.snapshot.carrierOrganization) || !partyMatches(p.Получатель ?? remote.Грузополучатель, doc.snapshot.profile.recipient) || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да') fail('Участники, номер или содержимое ЭТрН изменились. Автоматическая отправка остановлена.');
}
function title(remote: SabyObject, subtype: string) {
  const revision = sabyDocumentWorkflow(remote).revision;
  const titles = rows(remote.Вложение).filter(row => row.Подтип === subtype && row.ВерсияФормата === '5.01' && row.Удален !== 'Да' && row.Актуален !== 'Нет' && (!row.Редакция || (sabyObject(row.Редакция) ? !row.Редакция.Идентификатор || row.Редакция.Идентификатор === revision : row.Редакция === revision)));
  if (!revision || titles.length !== 1 || !sabyText(titles[0].Идентификатор)) fail('Не подтверждён единственный актуальный титул ЭТрН.');
  return { id: String(titles[0].Идентификатор), revision: revision! };
}
/** Exact recipient assignment at the next stage, not a general state code or accepted Execute. */
export function consignmentClientDispatchConfirmed(remote: SabyObject, recipient: { inn: string; kpp: string }, verifiedNativeTitles = false): boolean {
  if (remote.ЧастичныеДанные === 'Да' || remote.Удален === 'Да' || remote.Ошибка || Number(remote.КоличествоОшибок ?? 0) > 0) return false;
  const stages = rows(remote.Этап);
  // Native API exposes a summary to the sender when the action belongs to its
  // external recipient. Saby documents Приемка груза as the recipient's T3.
  // This branch additionally requires exact T1/T2/signature read-back by caller.
  const summaries = rows(remote.ТекущиеЭтапы);
  if (verifiedNativeTitles && remote.Тип === 'ConsignmentNote' && remote.Направление === 'Исходящий' && stages.length === 0 &&
      summaries.length === 1 && sabyText(summaries[0].Идентификатор) && summaries[0].Наименование === 'Приемка груза' &&
      summaries[0].Завершен !== 'Да' && summaries[0].Актуален !== 'Нет' && summaries[0].Служебный !== 'Да' && !summaries[0].Ошибка &&
      Number(summaries[0].КоличествоОшибок ?? 0) === 0 && ['3', '4', '7'].includes(String(sabyObject(remote.Состояние) ? remote.Состояние.Код : '')) &&
      partyMatches(remote.Контрагент, recipient) && sabyObject(remote.Стороны) && partyMatches(remote.Стороны.Получатель, recipient) &&
      (remote.Грузополучатель === undefined || partyMatches(remote.Грузополучатель, recipient))) return true;
  return rows(remote.ТекущиеЭтапы).some(summary => {
    const found = stages.filter(stage => stage.Идентификатор === summary.Идентификатор);
    if (found.length > 1) return false;
    const stage = found.length === 1 ? found[0] : summary;
    if (stage.Название !== 'Приемка груза' || stage.Служебный === 'Да' || stage.Завершен === 'Да' || stage.Актуален === 'Нет') return false;
    return rows(stage.Исполнитель).some(executor => partyMatches(executor.Контрагент, recipient));
  });
}

/** Metadata candidate only; the caller must additionally verify positive T3 content and its exact signed T2 link. */
export function consignmentClientAcceptanceCandidate(remote: SabyObject, recipient: { inn: string; kpp: string }): boolean {
  const hasErrors = (value: SabyObject) => !!value.Ошибка || Number(value.КоличествоОшибок ?? 0) !== 0 || Array.isArray(value.Ошибки) && value.Ошибки.length > 0;
  if (remote.ЧастичныеДанные === 'Да' || remote.Удален === 'Да' || hasErrors(remote) || sabyObject(remote.Состояние) && (hasErrors(remote.Состояние) || ['6', '9', '22'].includes(String(remote.Состояние.Код)))) return false;
  const revision = sabyDocumentWorkflow(remote).revision;
  if (!revision) return false;
  const titles = rows(remote.Вложение).filter(row => row.Подтип === '1110341' && row.ВерсияФормата === '5.01' && row.Удален !== 'Да' && row.Актуален !== 'Нет'
    && (!row.Редакция || (sabyObject(row.Редакция) ? !row.Редакция.Идентификатор || row.Редакция.Идентификатор === revision : row.Редакция === revision)));
  if (titles.length !== 1 || !sabyText(titles[0].Идентификатор) || hasErrors(titles[0])) return false;
  const title = titles[0];
  const signatures = rows(title.Подпись);
  if (!signatures.length || signatures.some(signature => {
    const cert = sabyObject(signature.Сертификат) ? signature.Сертификат : {}, file = sabyObject(signature.Файл) ? signature.Файл : {};
    return hasErrors(signature) || signature.Удален === 'Да' || signature.Актуален === 'Нет' || cert.ИНН !== recipient.inn
      || (cert.КПП !== undefined && recipient.inn.length === 10 && cert.КПП !== recipient.kpp) || !/^[a-f0-9]{40,128}$/.test(String(cert.Отпечаток ?? '').replace(/[\s:]/g, '').toLowerCase()) || !(sabyText(file.Ссылка) || sabyText(file.ДвоичныеДанные));
  })) return false;
  const stages = rows(remote.Этап).filter(stage => stage.Название === 'Приемка груза' && stage.Служебный !== 'Да' && stage.Завершен === 'Да' && stage.Актуален !== 'Нет' && !hasErrors(stage));
  return stages.length === 1 && rows(stages[0].Исполнитель).some(executor => partyMatches(executor.Контрагент, recipient))
    && rows(stages[0].Вложение).some(file => file.Идентификатор === title.Идентификатор);
}

/** Automatic stage six exists only for new driver-v1 attempts carrying the saved server policy. */
export async function continueEtrnDispatch(options: EtrnOptions, shipmentId: string): Promise<{ completedAt: string | null; lastError: string | null }> {
  const { base, store, tripId, authorize } = options, source = base.provenance.sourceSha256;
  let client = options.client ?? new SabyClient(sabyConfigFromEnv());
  const leaseId = randomUUID();
  let directRecord: NkDirectEtrnRecord | undefined;
  const amendmentClaim: { hash?: string } = {};
  const amendmentHash = (row: EtrnDocument) => bytesHash(Buffer.from(JSON.stringify([row.nativeSenderAmendment ?? null, row.orderRedirectionApproval ?? null])));
  const authority = (data: import('./operations-store').OperationsData) => {
    const snapshot = currentShipmentAccess(base, data); authorize(snapshot, data);
    const trip = getShipmentTrip(snapshot, tripId);
    if (isNkDirectEtrn(trip, data)) {
      if (client.config.documentMode !== 'nk-direct-v1') throw new ApiError(403, 'Для прямой ЭТрН требуется кабинет НК.');
      requireEtrnDelivery(trip, shipmentId);
      const direct = authorizeNkDirectEtrn(base, data, tripId, client.config);
      const doc = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
      if (!direct.deliveries.some(row => row.shipmentId === shipmentId) || doc?.snapshot.documentMode !== 'nk-direct-v1') throw new ApiError(403, 'Документ не входит в разрешение прямой ЭТрН.');
      validateNativeSenderAmendment(doc, tripId, direct);
      if (amendmentClaim.hash !== undefined && amendmentHash(doc) !== amendmentClaim.hash) throw new ApiError(409, 'Согласование сведений ЭТрН изменилось во время проверки.');
      directRecord = direct;
      return direct;
    }
    assertTripTransportDocumentsAllowed(trip, data);
    requireEtrnDelivery(getShipmentTrip(snapshot, tripId), shipmentId);
    const workflow = data.tripSaby?.trips[tripId];
    if (!workflow?.driverFlow || workflow.driverFlow.state !== 'ready' || !workflow.autoAuthorization || !workflow.carrierEvidence || workflow.signing?.sender.state !== 'confirmed' || workflow.signing.carrier.state !== 'confirmed' || !data.driverTripProgress?.[tripId]?.departedAt) throw new ApiError(403, 'Не подтверждено основание автоматической отправки ЭТрН.');
    authorizeAutomaticTripSaby(snapshot, data, tripId, workflow, client.config);
    const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
    const approval = current?.orderRedirectionApproval;
    if (approval) {
      validateOrderRedirectionApproval(approval);
      if (current?.orderDraftVersion !== 1 || approval.tripId !== tripId || approval.workflowAttemptId !== workflow.attemptId || approval.authorizationSha256 !== bytesHash(Buffer.from(JSON.stringify(workflow.autoAuthorization))) || JSON.stringify(approval) !== JSON.stringify(data.etrn!.trips[tripId].orderRedirectionApproval)) throw new ApiError(409, 'Согласование переадресовки не относится к текущей заявке.');
    }
    if (amendmentClaim.hash !== undefined && current && amendmentHash(current) !== amendmentClaim.hash) throw new ApiError(409, 'Согласование ЭТрН изменилось во время подписи.');
    return workflow;
  };
  let doc = await store.mutate(source, data => {
    authority(data);
    const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
    if (!current?.id || current.status !== 'draft') throw new ApiError(409, 'Сначала подтвердите создание ЭТрН.');
    if (current.leaseId && current.leaseUntil && Date.parse(current.leaseUntil) > Date.now()) throw new ApiError(409, 'ЭТрН уже обрабатывается.');
    current.dispatch ??= { version: 1, sender: { state: 'not_started' }, carrier: { state: 'not_started' } };
    current.leaseId = leaseId; current.leaseUntil = new Date(Date.now() + 300_000).toISOString();
    return { result: structuredClone(current), changed: true };
  });
  amendmentClaim.hash = amendmentHash(doc);
  const update = async (change: (row: EtrnDocument) => void) => {
    doc = await store.mutate(source, data => {
      authority(data); const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
      if (!current || current.leaseId !== leaseId || Date.parse(current.leaseUntil ?? '') <= Date.now()) throw new ApiError(409, 'Сеанс отправки ЭТрН изменился.');
      change(current); current.updatedAt = stamp(); current.leaseUntil = new Date(Date.now() + 300_000).toISOString();
      return { result: structuredClone(current), changed: true };
    });
  };
  const checkAccess = async () => {
    const data = await store.read(source); authority(data);
    const latest = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
    if (!latest || latest.leaseId !== leaseId || Date.parse(latest.leaseUntil ?? '') <= Date.now()) throw new ApiError(409, 'Сеанс отправки ЭТрН истёк.');
  };
  client = client.withRequestGuard(checkAccess);
  const sideId = (side: SabySigningSide) => side === 'carrier' ? doc.dispatch?.carrierIdentity?.documentId ?? doc.id! : doc.id!;
  const directElectronic = doc.snapshot.documentMode === 'nk-direct-v1' && doc.snapshot.loadingActorMode === 'sender' && doc.senderTitleVersion === 2 && doc.snapshot.profile.instructions.redirectionMethod === 'Электронное уведомление перевозчика о переадресовке';
  let senderRemoteForCarrier: SabyObject | undefined;
  const titleOptions = () => ({ senderTitleVersion: doc.senderTitleVersion });
  const evidenceOptions = (remote: SabyObject, phase: 'unprepared' | 'prepared' = 'prepared') => ({
    ...(doc.nativeSenderAmendment || doc.orderRedirectionApproval || doc.snapshot.profile.instructions.redirectionMethod === 'Электронное уведомление перевозчика о переадресовке' ? nativeSenderAmendmentOptions(doc, directRecord!, remote.Идентификатор === doc.dispatch?.carrierIdentity?.documentId && senderRemoteForCarrier ? senderRemoteForCarrier : remote) : { ...titleOptions(), operatorUid: doc.dispatch?.operatorUid }), phase,
  });
  const resolveCarrierIdentity = async () => {
    const eligible = doc.snapshot.documentMode !== 'nk-direct-v1' && doc.orderDraftVersion === 1 && doc.senderTitleVersion === 2 &&
      (!!doc.orderRedirectionApproval || doc.snapshot.profile.instructions.redirectionMethod === 'Электронное уведомление перевозчика о переадресовке');
    if (!eligible) { if (doc.dispatch?.carrierIdentity) fail('Привязка входящей ЭТрН не разрешена для этого обмена.'); return; }
    if (doc.dispatch!.sender.state !== 'confirmed' || !doc.dispatch!.sender.prepared) fail('Подпись отправителя не подтверждена.');
    const manifest = doc.dispatch!.sender.prepared!;
    const sourceRemote = await client.readSigningDocument('sender', doc.id!, 'ConsignmentNote');
    verifyIdentity(sourceRemote, doc, 'sender');
    const sourceTitle = title(sourceRemote, '1110339');
    const meta = rows(sourceRemote.Вложение).find(row => row.Идентификатор === sourceTitle.id)!;
    const url = new URL(String(meta.СсылкаВКабинет));
    const candidate = url.searchParams.get('guid');
    if (url.protocol !== 'https:' || url.hostname !== 'tms.saby.ru' || url.pathname !== '/opendoc.html' || !candidate || !/^[a-f0-9-]{36}$/i.test(candidate) || url.searchParams.getAll('guid').length !== 1 || url.searchParams.get('file') !== sourceTitle.id) fail('Не подтверждён адрес входящей ЭТрН.');
    if (candidate === doc.id && !doc.dispatch?.carrierIdentity) return;
    if (doc.dispatch?.carrierIdentity && doc.dispatch.carrierIdentity.documentId !== candidate) fail('Привязка входящей ЭТрН изменилась.');
    const sourceBytes = await client.downloadSigningAttachment('sender', doc.id!, sourceTitle.id, sourceTitle.revision, 'ConsignmentNote');
    verifyConsignmentSenderBusiness(sourceBytes.bytes, serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, doc.number, titleOptions()).xml, 'address-order-v1', evidenceOptions(sourceRemote));
    const incoming = await client.readSigningDocument('carrier', candidate!, 'ConsignmentNote');
    verifyIdentity(incoming, doc, 'carrier', candidate!);
    const incomingTitle = title(incoming, '1110339');
    const incomingBytes = await client.downloadSigningAttachment('carrier', candidate!, incomingTitle.id, incomingTitle.revision, 'ConsignmentNote');
    const thumbprint = manifest.binding.certificateThumbprint;
    const sourceSignature = await client.downloadSigningSignature('sender', doc.id!, sourceTitle.id, sourceTitle.revision, thumbprint, 'ConsignmentNote');
    const incomingSignature = await client.downloadSigningSignature('carrier', candidate!, incomingTitle.id, incomingTitle.revision, thumbprint, 'ConsignmentNote');
    if (bytesHash(sourceBytes.bytes) !== bytesHash(incomingBytes.bytes) || bytesHash(sourceSignature) !== bytesHash(incomingSignature)) fail('Подписанный титул во входящей ЭТрН отличается от отправленного.');
    const identity = { documentId: candidate!, senderRevision: sourceTitle.revision, senderAttachmentId: sourceTitle.id, titleSha256: bytesHash(sourceBytes.bytes), signatureSha256: bytesHash(sourceSignature) };
    if (doc.dispatch?.carrierIdentity) {
      if (JSON.stringify(doc.dispatch.carrierIdentity) !== JSON.stringify(identity)) fail('Изменилось сохранённое доказательство входящей ЭТрН.');
    } else {
      if (doc.dispatch!.carrier.binding || doc.dispatch!.carrier.prepared || doc.dispatch!.carrier.executeAttempted || doc.dispatch!.carrierDraft || doc.dispatch!.carrierFill) fail('Нельзя менять идентификатор после начала приёмки перевозчиком.');
      await update(row => { row.dispatch!.carrierIdentity = identity; });
    }
    senderRemoteForCarrier = sourceRemote;
  };
  const business = async (remote: SabyObject, side: SabySigningSide, phase: 'unprepared' | 'prepared' = 'prepared') => {
    verifyIdentity(remote, doc, side);
    const sender = title(remote, '1110339');
    const bytes = (await client.downloadSigningAttachment(side, sideId(side), sender.id, sender.revision, 'ConsignmentNote')).bytes;
    if (side === 'carrier' && doc.dispatch?.carrierIdentity && bytesHash(bytes) !== doc.dispatch.carrierIdentity.titleSha256) fail('Входящий титул изменился после привязки.');
    const expected = serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, doc.number, titleOptions());
    const evidence = verifyConsignmentSenderBusiness(bytes, expected.xml, doc.snapshot.documentMode === 'nk-direct-v1' ? 'address-direct-v1' : doc.orderDraftVersion === 1 ? 'address-order-v1' : undefined, evidenceOptions(remote, phase));
    if (side === 'carrier') {
      const carrier = title(remote, '1110340');
      const reply = await client.downloadSigningAttachment(side, sideId(side), carrier.id, carrier.revision, 'ConsignmentNote');
      verifyConsignmentCarrierBusiness(reply.bytes, bytes, doc.snapshot, evidenceOptions(remote));
      const signature = await client.downloadSigningSignature(side, sideId(side), sender.id, sender.revision, doc.dispatch!.sender.prepared!.binding.certificateThumbprint, 'ConsignmentNote');
      verifyConsignmentCarrierSourceSignature(reply.bytes, signature);
    }
    return evidence;
  };
  try {
    if (doc.senderTitleVersion === 2 && doc.dispatch?.sender.verified && !validConsignmentOperatorUid(doc.dispatch.operatorUid)) fail('Не сохранено подтверждение операторского УИД подготовленной ЭТрН. Подписание остановлено.');
    if (doc.dispatch?.completedAt) return { completedAt: doc.dispatch.completedAt, lastError: null };
    for (const side of ['sender', 'carrier'] as const) {
      if (side === 'carrier') await resolveCarrierIdentity();
      let step = doc.dispatch![side];
      if (step.prepared) {
        const evidence = await readSigningEvidence(client, step.prepared);
        if (evidence.state === 'changed') fail(evidence.reason);
        if (evidence.state === 'confirmed') {
          await business(await client.readSigningDocument(side, sideId(side), 'ConsignmentNote'), side);
          await update(row => { row.dispatch![side].state = 'confirmed'; });
          continue;
        }
        if (step.executeAttempted) { await update(row => { row.dispatch![side].state = 'waiting'; row.dispatch!.lastError = evidence.reason; }); break; }
      }
      // Saby may complete the carrier title before CRM observes its signing stage.
      // Adopt only a positive signature with no prior local mutation intent. Never
      // replace a prepared/unknown operation or manufacture an Execute record.
      if (side === 'carrier' && doc.dispatch!.carrierIdentity && doc.dispatch!.sender.state === 'confirmed' &&
          !step.binding && !step.prepared && step.executeAttempted === undefined && step.dispatchState === undefined &&
          !doc.dispatch!.carrierDraft && !doc.dispatch!.carrierFill && !doc.dispatch!.carrierReconciliation) {
        const observed = await client.readSigningDocument('carrier', sideId('carrier'), 'ConsignmentNote');
        const signedTitles = rows(observed.Вложение).filter(file => file.Подтип === '1110340' && file.Удален !== 'Да' && file.Актуален !== 'Нет' && rows(file.Подпись).length > 0);
        if (signedTitles.length) {
          await business(observed, 'carrier');
          const latest = await store.read(source); authority(latest);
          const selection = latest.tripSaby!.trips[tripId].autoAuthorization!.selection.carrier;
          const certificate = signingCertificateForOrganization(await client.readSigningCertificate('carrier', selection), doc.snapshot.carrierOrganization);
          if (!certificate || certificate.thumbprint !== selection) fail('Выбранная подпись ЭТрН недоступна для организации.');
          const manifest = await captureSignedTitle(client, 'carrier', observed, certificate!, 'ConsignmentNote');
          await business(await client.readSigningDocument('carrier', sideId('carrier'), 'ConsignmentNote'), 'carrier');
          await update(row => {
            const current = row.dispatch!.carrier;
            if (current.binding || current.prepared || current.executeAttempted !== undefined || current.dispatchState !== undefined || row.dispatch!.carrierDraft || row.dispatch!.carrierFill || row.dispatch!.carrierReconciliation) fail('Намерение НК изменилось во время сверки подписи.');
            row.dispatch!.carrier = { state: 'confirmed', binding: manifest.binding, prepared: manifest, verified: true, observedSignature: true };
          });
          continue;
        }
      }
      // Only an explicit amendment pinned to this already durable native manifest
      // can reopen its business verification. It never authorizes another Prepare.
      const recoverApprovedPrepared = side === 'sender' && doc.senderTitleVersion === 2 &&
        ((doc.snapshot.documentMode === 'nk-direct-v1' && (!!doc.nativeAdoptionEvidence || doc.nativeSenderAmendment?.version === 'direct-redirection-approval-v2') && doc.nativeSenderAmendment?.originalPreparedHash === step.prepared?.preparedHash) ||
          (doc.orderDraftVersion === 1 && !!doc.orderRedirectionApproval) ||
          (doc.orderDraftVersion === 1 && doc.snapshot.profile.instructions.redirectionMethod === 'Электронное уведомление перевозчика о переадресовке')) &&
        !!step.prepared &&
        step.verified !== true && step.executeAttempted !== true && step.dispatchState === undefined;
      const reconcileCarrierDraft = side === 'carrier' && doc.nativeSenderAmendment?.version === 'direct-redirection-approval-v2' &&
        doc.dispatch!.sender.state === 'confirmed' && doc.dispatch!.carrierDraft?.state === 'preparing' &&
        !step.binding && !step.prepared && !step.executeAttempted && step.dispatchState === undefined;
      const reconcileCarrierTitle = side === 'carrier' && (!!doc.dispatch!.carrierIdentity || directElectronic) && doc.dispatch!.carrierDraft?.state === 'ready' &&
        doc.dispatch!.sender.state === 'confirmed' && !!step.binding && !step.prepared && !step.executeAttempted && step.dispatchState === undefined && !doc.dispatch!.carrierReconciliation;
      if (!recoverApprovedPrepared && !reconcileCarrierDraft && !reconcileCarrierTitle && (step.state === 'blocked' || step.binding && !step.prepared || step.prepared && (step.verified !== true || step.dispatchState !== 'not_sent'))) {
        await update(row => { row.dispatch![side].state = 'unknown'; row.dispatch!.lastError = 'Результат подготовки ЭТрН неизвестен. Повторное действие не выполняется.'; }); break;
      }
      let remote = await client.readSigningDocument(side, sideId(side), 'ConsignmentNote'); verifyIdentity(remote, doc, side);
      const currentData = await store.read(source); authority(currentData);
      const selection = client.config.documentMode === 'nk-direct-v1' ? currentData.etrn!.trips[tripId].direct!.authorization.selection[side] : currentData.tripSaby!.trips[tripId].autoAuthorization!.selection[side];
      const org = side === 'sender' ? doc.snapshot.customerOrganization : doc.snapshot.carrierOrganization;
      const certificate = signingCertificateForOrganization(await client.readSigningCertificate(side, selection), org);
      if (!certificate || certificate.thumbprint !== selection) fail('Выбранная подпись ЭТрН недоступна для организации.');
      if (reconcileCarrierDraft) {
        remote = await readPreparedCarrierDraft(client, doc.dispatch!.carrierDraft!.binding);
        verifyIdentity(remote, doc, side);
        await update(row => { row.dispatch!.carrierDraft!.state = 'ready'; });
      }
      if (side === 'carrier' && !rows(remote.Вложение).some(row => row.Подтип === '1110340' && row.Удален !== 'Да')) {
        if (doc.dispatch!.carrierDraft) { await update(row => { row.dispatch!.lastError = 'Ответ перевозчика ещё не подтверждён; повторная подготовка не выполняется.'; }); break; }
        const binding = createCarrierDraftBinding(remote, certificate!, client.config, 'Отложенный', 'ConsignmentNote');
        await update(row => { row.dispatch!.carrierDraft = { binding, state: 'preparing' }; });
        remote = await prepareCarrierDraft(client, binding);
        await update(row => { row.dispatch!.carrierDraft!.state = 'ready'; });
      }
      if (side === 'carrier' && !step.binding) {
        const sender = title(remote, '1110339'), carrier = title(remote, '1110340');
        const sourceFile = await client.downloadSigningAttachment(side, sideId(side), sender.id, sender.revision, 'ConsignmentNote');
        if (doc.dispatch?.carrierIdentity && bytesHash(sourceFile.bytes) !== doc.dispatch.carrierIdentity.titleSha256) fail('Входящий титул изменился после привязки.');
        verifyConsignmentSenderBusiness(sourceFile.bytes, serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, doc.number, titleOptions()).xml, doc.snapshot.documentMode === 'nk-direct-v1' ? 'address-direct-v1' : doc.orderDraftVersion === 1 ? 'address-order-v1' : undefined, evidenceOptions(remote));
        const reply = await client.downloadSigningAttachment(side, sideId(side), carrier.id, carrier.revision, 'ConsignmentNote');
        const sourceSignature = await client.downloadSigningSignature(side, sideId(side), sender.id, sender.revision, doc.dispatch!.sender.prepared!.binding.certificateThumbprint, 'ConsignmentNote');
        verifyConsignmentCarrierSourceSignature(reply.bytes, sourceSignature);
        const previous = doc.dispatch!.carrierFill;
        if (previous) {
          if (previous.id !== carrier.id || previous.revision !== carrier.revision || previous.name !== reply.name || previous.afterHash !== bytesHash(reply.bytes)) fail('Результат заполнения ответа перевозчика ЭТрН неизвестен или изменён. Повторная запись не выполняется.');
        } else {
          const filled = fillConsignmentCarrier(reply.bytes, sourceFile.bytes, doc.snapshot, evidenceOptions(remote));
          if (filled.changed) {
            const before = bytesHash(reply.bytes), after = bytesHash(filled.bytes);
            const fresh = await client.downloadSigningAttachment(side, sideId(side), carrier.id, carrier.revision, 'ConsignmentNote');
            if (fresh.name !== reply.name || bytesHash(fresh.bytes) !== before) fail('Ответ перевозчика ЭТрН изменился до заполнения.');
            await update(row => { row.dispatch!.carrierFill = { id: carrier.id, revision: carrier.revision, name: reply.name, beforeHash: before, afterHash: after, attempted: true }; });
            await client.writeCarrierAttachment(sideId('carrier'), carrier.revision, carrier.id, reply.name, filled.bytes);
            const saved = await client.downloadSigningAttachment(side, sideId(side), carrier.id, carrier.revision, 'ConsignmentNote');
            if (saved.name !== reply.name || bytesHash(saved.bytes) !== after) fail('Saby не подтвердил сохранённые сведения ответа перевозчика ЭТрН.');
            remote = await client.readSigningDocument(side, sideId(side), 'ConsignmentNote');
          }
        }
      }
      await business(remote, side, side === 'sender' && !step.prepared ? 'unprepared' : 'prepared');
      let prepared;
      if (reconcileCarrierTitle) {
        const previousBinding = structuredClone(step.binding!);
        prepared = await reconcileRegeneratedCarrierSigning(client, previousBinding, directElectronic);
        await business(await client.readSigningDocument('carrier', sideId('carrier'), 'ConsignmentNote'), 'carrier');
        const manifest: SabySigningManifest = { binding: prepared.binding, attachments: prepared.attachments.map(({ bytes: _bytes, ...file }) => file), preparedHash: prepared.preparedHash };
        await update(row => {
          const current = row.dispatch!.carrier;
          if (JSON.stringify(current.binding) !== JSON.stringify(previousBinding) || current.prepared || current.executeAttempted || current.dispatchState !== undefined || row.dispatch!.carrierReconciliation) throw new ApiError(409, 'Намерение подписи НК изменилось во время сверки.');
          row.dispatch!.carrierReconciliation = { version: 1, previousBinding, preparedHash: manifest.preparedHash };
          row.dispatch!.carrier = { state: 'preparing', binding: manifest.binding, prepared: manifest, verified: true, dispatchState: 'not_sent' };
        });
      } else if (recoverApprovedPrepared) {
        const manifest = step.prepared!, savedManifest = JSON.stringify(manifest), approval = amendmentClaim.hash;
        prepared = await restorePreparedSigning(client, manifest);
        await verifyPreparedSigning(client, prepared);
        const evidence = await business(await client.readSigningDocument(side, sideId(side), 'ConsignmentNote'), side);
        if (!validConsignmentOperatorUid(evidence.operatorUid)) fail('Saby не подтвердил операторский УИД подготовленной ЭТрН.');
        await update(row => {
          const current = row.dispatch!.sender;
          if (amendmentHash(row) !== approval || JSON.stringify(current.prepared) !== savedManifest ||
              current.executeAttempted === true || current.dispatchState !== undefined || current.verified === true ||
              (row.nativeSenderAmendment && row.nativeSenderAmendment.originalPreparedHash !== manifest.preparedHash)) {
            throw new ApiError(409, 'Сохранённое задание на подпись или его согласование изменилось.');
          }
          row.dispatch!.operatorUid = evidence.operatorUid;
          current.verified = true; current.dispatchState = 'not_sent'; current.state = 'preparing';
        });
      } else if (step.prepared && step.verified && step.dispatchState === 'not_sent') prepared = await restorePreparedSigning(client, step.prepared);
      else {
        const binding = createSigningBinding(remote, side, certificate!, client.config, 'Отложенный', 'ConsignmentNote');
        await update(row => { row.dispatch![side] = { state: 'preparing', binding }; });
        prepared = await prepareBoundSigning(client, binding);
        const manifest: SabySigningManifest = { binding: prepared.binding, attachments: prepared.attachments.map(({ bytes: _bytes, ...file }) => file), preparedHash: prepared.preparedHash };
        await update(row => { row.dispatch![side].prepared = manifest; });
        const evidence = await business(await client.readSigningDocument(side, sideId(side), 'ConsignmentNote'), side);
        await update(row => {
          if (row.senderTitleVersion === 2) {
            if (!evidence.operatorUid) fail('Saby не подтвердил операторский УИД подготовленной ЭТрН.');
            row.dispatch!.operatorUid = evidence.operatorUid;
          }
          row.dispatch![side].verified = true; row.dispatch![side].dispatchState = 'not_sent';
        });
      }
      await client.executeDeferredSigning(prepared, async () => {
        await update(row => {
          if (row.senderTitleVersion === 2 && !validConsignmentOperatorUid(row.dispatch!.operatorUid)) fail('Не сохранено подтверждение операторского УИД ЭТрН. Подписание остановлено.');
          row.dispatch![side].executeAttempted = true; row.dispatch![side].dispatchState = 'attempted'; row.dispatch![side].state = 'waiting';
        });
      });
      await update(row => { row.dispatch![side].dispatchState = 'acknowledged'; });
      step = doc.dispatch![side];
      const evidence = await readSigningEvidence(client, step.prepared!);
      if (evidence.state === 'changed') fail(evidence.reason);
      await update(row => { row.dispatch![side].state = evidence.state === 'confirmed' ? 'confirmed' : 'waiting'; row.dispatch!.lastError = evidence.state === 'confirmed' ? undefined : evidence.reason; });
      if (evidence.state !== 'confirmed') break;
    }
    if (doc.dispatch!.sender.state === 'confirmed' && doc.dispatch!.carrier.state === 'confirmed') {
      const remote = await client.readSigningDocument('sender', doc.id!, 'ConsignmentNote');
      await business(remote, 'sender');
      const workflow = sabyDocumentWorkflow(remote);
      await update(row => { row.remoteStatus = workflow.remoteStatus; row.signatureStatus = workflow.signatureStatus; row.gisStatus = workflow.gisStatus; row.availableActions = workflow.availableActions; row.lastError = null; });
      let verifiedNativeTitles = false;
      if ((doc.orderDraftVersion === 1 && doc.dispatch!.carrierIdentity || directElectronic) && rows(remote.ТекущиеЭтапы).some(stage => stage.Наименование === 'Приемка груза') && rows(remote.Этап).length === 0) {
        const carrierTitle = title(remote, '1110340'), manifest = doc.dispatch!.carrier.prepared!;
        const file = await client.downloadSigningAttachment('sender', doc.id!, carrierTitle.id, carrierTitle.revision, 'ConsignmentNote');
        const saved = manifest.attachments.filter(item => item.id === carrierTitle.id && item.subtype === '1110340');
        if (saved.length !== 1 || saved[0].name !== file.name || saved[0].sha256 !== bytesHash(file.bytes)) fail('Титул НК у отправителя не совпадает с подтверждённым подписанным титулом.');
        const senderSignature = await client.downloadSigningSignature('sender', doc.id!, carrierTitle.id, carrierTitle.revision, manifest.binding.certificateThumbprint, 'ConsignmentNote', '1110340');
        const carrierSignature = await client.downloadSigningSignature('carrier', sideId('carrier'), manifest.binding.attachmentId, manifest.binding.revision, manifest.binding.certificateThumbprint, 'ConsignmentNote', '1110340');
        if (bytesHash(senderSignature) !== bytesHash(carrierSignature)) fail('Подпись НК в кабинетах не совпадает.');
        verifiedNativeTitles = true;
      }
      let accepted = false;
      if (doc.snapshot.documentMode === 'nk-direct-v1' && consignmentClientAcceptanceCandidate(remote, doc.snapshot.profile.recipient)) {
        const receiptTitle = title(remote, '1110341'), carrierTitle = title(remote, '1110340');
        const receiptBytes = await client.downloadSigningAttachment('sender', doc.id!, receiptTitle.id, receiptTitle.revision, 'ConsignmentNote');
        const carrierBytes = await client.downloadSigningAttachment('sender', doc.id!, carrierTitle.id, carrierTitle.revision, 'ConsignmentNote');
        const carrierManifest = doc.dispatch!.carrier.prepared!.attachments.find(file => file.id === carrierTitle.id);
        if (!carrierManifest || carrierManifest.name !== carrierBytes.name || carrierManifest.sha256 !== bytesHash(carrierBytes.bytes)) fail('Исходный подписанный титул перевозчика изменился перед проверкой приёмки клиента.');
        const signature = await client.downloadSigningSignature('sender', doc.id!, carrierTitle.id, carrierTitle.revision, doc.dispatch!.carrier.prepared!.binding.certificateThumbprint, 'ConsignmentNote', '1110340');
        verifyNkRecipientAcceptance(receiptBytes.bytes, carrierBytes.bytes, signature);
        const fingerprints = (value: SabyObject) => rows(rows(value.Вложение).find(file => file.Идентификатор === receiptTitle.id)?.Подпись).map(row => row.Сертификат);
        const fresh = await client.readSigningDocument('sender', doc.id!, 'ConsignmentNote');
        verifyIdentity(fresh, doc, 'sender');
        const freshTitle = title(fresh, '1110341');
        if (!consignmentClientAcceptanceCandidate(fresh, doc.snapshot.profile.recipient) || freshTitle.id !== receiptTitle.id || freshTitle.revision !== receiptTitle.revision || JSON.stringify(fingerprints(fresh)) !== JSON.stringify(fingerprints(remote))) fail('Приёмка клиента изменилась во время сверки. Требуется обновить состояние.');
        accepted = true;
      }
      const delivered = accepted || consignmentClientDispatchConfirmed(remote, doc.snapshot.profile.recipient, verifiedNativeTitles);
      await update(row => { if (delivered) { row.dispatch!.completedAt ??= stamp(); if (accepted) row.dispatch!.recipientAcceptedAt ??= stamp(); row.dispatch!.lastError = undefined; } else { delete row.dispatch!.completedAt; delete row.dispatch!.recipientAcceptedAt; row.dispatch!.lastError = 'Подписи получены. Saby ещё не подтвердил передачу на этап приёмки именно этому клиенту.'; } });
    }
  } catch (error) {
    await update(row => {
      delete row.dispatch!.completedAt; delete row.dispatch!.recipientAcceptedAt;
      const step = row.dispatch!.sender.state !== 'confirmed' ? row.dispatch!.sender : row.dispatch!.carrier;
      step.state = error instanceof SabyError && !error.uncertain && error.kind === 'validation' ? 'blocked' : 'unknown';
      row.dispatch!.lastError = error instanceof SabyError || error instanceof ApiError ? error.message : 'Отправка ЭТрН не подтверждена. Нужна сверка.';
    });
  } finally {
    await store.mutate(source, data => {
      const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
      if (!current || current.leaseId !== leaseId) return { result: undefined, changed: false };
      current.leaseId = null; current.leaseUntil = null;
      return { result: undefined, changed: true };
    });
  }
  return { completedAt: doc.dispatch?.completedAt ?? null, lastError: doc.dispatch?.lastError ?? null };
}

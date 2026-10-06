import { createHash, randomUUID } from 'node:crypto';
import type { Snapshot } from '../web/src/model';
import type { TripSabySigning, TripSabySigningPreview, TripSabySigningStartRequest, TripSabySigningStep } from '../web/src/trip-saby-model';
import { newCarrierFill } from './trip-saby-carrier';
import { ApiError } from './api-error';
import { publicUser } from './auth';
import { requireWholeTrip } from './auth-scope';
import { requireTripSection } from './permissions';
import type { OperationsData, OperationsStorage } from './operations-store';
import { currentSnapshot } from './shipment-operations';
import { SabyClient, SabyError, sabyConfigFromEnv, sabyDocumentWorkflow, sabyObject, sabyText, type SabyObject } from './saby-client';
import { assertSigningBinding, assertSigningManifest, captureSignedTitle, createCarrierDraftBinding, createSigningBinding, prepareCarrierDraft, prepareBoundSigning, readSigningEvidence, signingCertificateForOrganization, type SabyPreparedSigning, type SabySigningBinding, type SabySigningCertificate, type SabySigningSide } from './saby-signing';
import { carrierBusinessHash, verifySabyCarrierBusiness, verifySabyCarrierLink, verifySabyCarrierVehicleAddition, verifySabySenderBusiness, type SabyCarrierVehicleIdentity } from './saby-order-evidence';
import { carrierXmlHash } from './saby-carrier-details';
import { serializeSabyTransportOrder } from './saby-transport-order';
import { sabyOrderStateCode } from './trip-saby-progress';
import type { TripSabyRecord } from './trip-saby-workflow';

const stamp = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const rows = (value: unknown): SabyObject[] => Array.isArray(value) ? value.filter(sabyObject) : sabyObject(value) ? [value] : [];
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
export type SigningMetadata = Omit<SabyPreparedSigning, 'attachments'> & { attachments: Array<Omit<SabyPreparedSigning['attachments'][number], 'bytes'>> };
const CARRIER_BUSINESS_CHANGED = 'Saby изменил сведения ответа НК при подготовке. Подписание остановлено; требуется сверка.';
export interface TripSigningRecovery {
  kind: 'verified_vehicle_identity_addition'; id: string; requestedAt: string; requestedBy: string;
  originalBinding: SabySigningBinding; originalBusinessHash: string; originalMessage: typeof CARRIER_BUSINESS_CHANGED;
  acceptedBusinessHash: string; currentRawHash: string; prepareAttempted: true;
}
export interface TripSigningStep extends TripSabySigningStep {
  /** Stored before preparation, which itself is a remote mutation. Never automatically repeated. */
  binding?: SabySigningBinding;
  prepared?: SigningMetadata;
  /** A prepared-file list is evidence of preparation, never permission to sign unchecked content. */
  preparedVerified?: boolean;
  recovery?: TripSigningRecovery;
  executeAttempted?: boolean;
  businessHash?: string;
}
export interface TripSigningRecord {
  requestedBy: string; requestedAt: string; requestId: string; previewToken: string;
  workflowAttemptId: string; documentId: string; revision: string; payloadHash: string;
  selection: { sender: string; carrier: string };
  mode?: 'automatic' | 'with_confirmation';
  sender: TripSigningStep; carrier: TripSigningStep;
  carrierDraft?: { binding: SabySigningBinding; state: 'preparing' | 'ready' | 'unknown' | 'blocked' };
}
export function publicTripSigning(value: TripSigningRecord | undefined): TripSabySigning | undefined {
  if (!value) return undefined;
  const state = [value.sender.state, value.carrier.state];
  return { requestedAt: value.requestedAt, mode: value.mode ?? 'with_confirmation', state: state.every(x => x === 'confirmed') ? 'completed' : state.includes('blocked') ? 'blocked' : state.some(x => ['unknown', 'preparing'].includes(x)) ? 'unknown' : 'active', sender: { state: value.sender.state, ...(value.sender.message ? { message: value.sender.message } : {}) }, carrier: { state: value.carrier.state, ...(value.carrier.message ? { message: value.carrier.message } : {}) } };
}
export function validateTripSigning(value: unknown): void {
  if (value === undefined) return;
  if (!sabyObject(value) || Object.keys(value).some(k => !['requestedBy', 'requestedAt', 'requestId', 'previewToken', 'workflowAttemptId', 'documentId', 'revision', 'payloadHash', 'selection', 'sender', 'carrier', 'carrierDraft', 'mode'].includes(k)) || !['requestedBy', 'requestId', 'workflowAttemptId', 'documentId', 'revision'].every(k => sabyText(value[k])) || !date(value.requestedAt) || !digest(value.previewToken) || !digest(value.payloadHash) || !sabyObject(value.selection) || Object.keys(value.selection).length !== 2 || !['sender', 'carrier'].every(k => typeof (value.selection as SabyObject)[k] === 'string' && /^[A-Fa-f0-9]{40,128}$/.test(String((value.selection as SabyObject)[k])))) throw new Error('Invalid trip signing intent');
  if (value.mode !== undefined && !['automatic', 'with_confirmation'].includes(String(value.mode))) throw new Error('Invalid signing mode');
  const expectedKey = value.mode === 'automatic' ? 'Отложенный' : 'ОтложенныйСПодтверждением';
  if (value.carrierDraft !== undefined) {
    const draft = value.carrierDraft;
    if (!sabyObject(draft) || Object.keys(draft).some(k => !['binding', 'state'].includes(k)) || !['preparing', 'ready', 'unknown', 'blocked'].includes(String(draft.state)) || !sabyObject(draft.binding) || draft.binding.side !== 'carrier' || draft.binding.documentId !== value.documentId || draft.binding.certificateThumbprint !== (value.selection as SabyObject).carrier || draft.binding.attachmentId !== 'unprepared-carrier-title') throw new Error('Invalid carrier draft preparation');
    assertSigningBinding(draft.binding as unknown as SabySigningBinding);
    if ((draft.binding.keyType ?? 'ОтложенныйСПодтверждением') !== expectedKey) throw new Error('Carrier draft signing mode changed');
  }
  for (const side of ['sender', 'carrier'] as const) {
    const step = value[side];
    if (!sabyObject(step) || Object.keys(step).some(k => !['state', 'message', 'binding', 'prepared', 'executeAttempted', 'businessHash', 'preparedVerified', 'recovery'].includes(k)) || !['not_started', 'preparing', 'requested', 'waiting', 'unknown', 'confirmed', 'blocked'].includes(String(step.state)) || step.message !== undefined && (typeof step.message !== 'string' || step.message.length > 1000) || step.executeAttempted !== undefined && typeof step.executeAttempted !== 'boolean') throw new Error('Invalid signing step');
    if (step.preparedVerified !== undefined && (typeof step.preparedVerified !== 'boolean' || !step.prepared || step.preparedVerified === false && (step.executeAttempted || step.state === 'confirmed'))) throw new Error('Invalid signing business verification');
    if (step.businessHash !== undefined && !digest(step.businessHash)) throw new Error('Invalid signing business digest');
    if (step.binding !== undefined) {
      const binding = step.binding;
      const keys = ['side', 'documentId', 'revision', 'stageId', 'stageName', 'actionName', 'certificateThumbprint', 'organizationInn', 'organizationKpp', 'counterpartyInn', 'counterpartyKpp', 'attachmentSubtype', 'attachmentId'];
      if (!sabyObject(binding) || Object.keys(binding).some(k => ![...keys, 'keyType'].includes(k)) || !keys.every(k => sabyText(binding[k])) || binding.side !== side || binding.documentId !== value.documentId || binding.certificateThumbprint !== (value.selection as SabyObject)[side] || binding.attachmentSubtype !== (side === 'sender' ? '1110361' : '1110362')) throw new Error('Invalid signing binding');
      if (binding.stageId !== 'observed-signed' && (binding.keyType ?? 'ОтложенныйСПодтверждением') !== expectedKey || binding.keyType !== undefined && !['Отложенный', 'ОтложенныйСПодтверждением'].includes(String(binding.keyType))) throw new Error('Signing mode changed');
    }
    if (step.prepared !== undefined) {
      const prepared = step.prepared;
      if (!step.binding || !sabyObject(prepared) || Object.keys(prepared).some(k => !['binding', 'attachments', 'preparedHash'].includes(k)) || JSON.stringify(prepared.binding) !== JSON.stringify(step.binding) || !digest(prepared.preparedHash) || !Array.isArray(prepared.attachments) || !prepared.attachments.length || prepared.attachments.length > 100 || prepared.attachments.some(a => !sabyObject(a) || Object.keys(a).some(k => !['id', 'name', 'subtype', 'sha256'].includes(k)) || !['id', 'name'].every(k => sabyText(a[k])) || typeof a.subtype !== 'string' || !digest(a.sha256))) throw new Error('Invalid signing digest');
      assertSigningManifest(prepared as unknown as SigningMetadata);
    }
    if (step.recovery !== undefined) {
      const recovery = step.recovery;
      if (side !== 'carrier' || !step.binding || !step.businessHash || !sabyObject(recovery) || Object.keys(recovery).some(k => !['kind', 'id', 'requestedAt', 'requestedBy', 'originalBinding', 'originalBusinessHash', 'originalMessage', 'acceptedBusinessHash', 'currentRawHash', 'prepareAttempted'].includes(k)) || recovery.kind !== 'verified_vehicle_identity_addition' || !sabyText(recovery.id) || !date(recovery.requestedAt) || !sabyText(recovery.requestedBy) || recovery.prepareAttempted !== true || recovery.originalMessage !== CARRIER_BUSINESS_CHANGED || recovery.originalBusinessHash !== step.businessHash || ![recovery.originalBusinessHash, recovery.acceptedBusinessHash, recovery.currentRawHash].every(digest) || !sabyObject(recovery.originalBinding)) throw new Error('Invalid signing recovery intent');
      assertSigningBinding(recovery.originalBinding as unknown as SabySigningBinding);
      const original = recovery.originalBinding;
      const keys = ['side', 'documentId', 'revision', 'stageId', 'stageName', 'actionName', 'certificateThumbprint', 'organizationInn', 'organizationKpp', 'counterpartyInn', 'counterpartyKpp', 'attachmentSubtype', 'attachmentId'];
      const sameKeys = (step.binding as SabyObject).stageId === 'observed-signed' ? keys.filter(k => !['stageId', 'stageName', 'actionName'].includes(k)) : keys;
      if (Object.keys(original).length !== keys.length + (original.keyType === undefined ? 0 : 1) || Object.keys(original).some(k => ![...keys, 'keyType'].includes(k)) || original.keyType !== (step.binding as SabyObject).keyType || !sameKeys.every(k => original[k] === (step.binding as SabyObject)[k]) || original.stageId === 'observed-signed') throw new Error('Signing recovery changed original binding');
    }
    if (['preparing', 'requested', 'confirmed'].includes(String(step.state)) && !step.binding || step.executeAttempted && !step.prepared || step.state === 'confirmed' && !step.prepared) throw new Error('Incomplete signing step');
  }
}
export function validateSigningStart(value: unknown): asserts value is TripSabySigningStartRequest {
  if (!sabyObject(value) || Object.keys(value).some(k => !['requestId', 'previewToken', 'senderSignatureId', 'carrierSignatureId', 'confirmed'].includes(k)) || value.confirmed !== true || typeof value.requestId !== 'string' || !/^[A-Za-z0-9_-]{16,100}$/.test(value.requestId) || !digest(value.previewToken) || ![value.senderSignatureId, value.carrierSignatureId].every(v => typeof v === 'string' && /^[A-Fa-f0-9]{40,128}$/.test(v))) throw new ApiError(400, 'Подтвердите конкретную заявку и выберите подпись каждой организации.');
}
/** The initiator of document creation cannot grant someone else's signing request. */
export function authorizeSigningActor(snapshot: Snapshot, data: OperationsData, tripId: string, record: TripSabyRecord): void {
  const intent = record.signing;
  if (!intent) return;
  if (intent.workflowAttemptId !== record.attemptId || intent.documentId !== record.order.id || intent.payloadHash !== record.payloadHash) throw new ApiError(403, 'Сохранённое поручение на подписание больше не соответствует заявке.');
  const user = data.accounts?.users.find(row => row.id === intent.requestedBy && row.active && !row.deletedAt);
  if (!user) throw new ApiError(403, 'Подписание остановлено: у запустившего его сотрудника больше нет доступа.');
  const actor = publicUser(user); requireTripSection(actor, true); requireWholeTrip(actor, snapshot, tripId);
  const recoveryActorId = intent.carrier.recovery?.requestedBy;
  if (recoveryActorId && recoveryActorId !== intent.requestedBy) {
    const recoveryUser = data.accounts?.users.find(row => row.id === recoveryActorId && row.active && !row.deletedAt);
    if (!recoveryUser) throw new ApiError(403, 'У сотрудника, запустившего сверку подписи, больше нет доступа.');
    const recoveryActor = publicUser(recoveryUser); requireTripSection(recoveryActor, true); requireWholeTrip(recoveryActor, snapshot, tripId);
  }
}
function identity(remote: SabyObject, record: TripSabyRecord, side: SabySigningSide): string {
  const org = side === 'sender' ? record.snapshot.customerOrganization : record.snapshot.carrierOrganization;
  const counterparty = side === 'sender' ? record.snapshot.carrierOrganization : record.snapshot.customerOrganization;
  const matches = (value: unknown, expected: typeof org) => sabyObject(value) && sabyObject(value.СвЮЛ) && value.СвЮЛ.ИНН === expected.inn && value.СвЮЛ.КПП === expected.kpp;
  const revision = sabyDocumentWorkflow(remote).revision;
  if (!revision || remote.Тип !== 'TransportOrder' || remote.Идентификатор !== record.order.id || remote.Номер !== record.order.number || remote.Дата !== record.order.date?.split('-').reverse().join('.') || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да' || !matches(remote.НашаОрганизация, org) || !matches(remote.Контрагент, counterparty) || side === 'sender' && remote.Примечание !== record.marker) throw new SabyError('validation', 'Заявка или её участники изменились. Автоматическое подписание остановлено.');
  return revision;
}
function title(remote: SabyObject, subtype: string): SabyObject | null {
  const revision = sabyDocumentWorkflow(remote).revision;
  const found = rows(remote.Вложение).filter(row => row.Подтип === subtype && row.ВерсияФормата === '5.01' && row.Удален !== 'Да' && row.Актуален !== 'Нет' && (!sabyObject(row.Редакция) || !row.Редакция.Идентификатор || row.Редакция.Идентификатор === revision));
  if (found.length > 1) throw new SabyError('validation', 'Saby вернул несколько текущих титулов одной стороны. Требуется сверка.');
  return found[0] ?? null;
}
const thumbprints = (attachment: SabyObject | null) => rows(attachment?.Подпись).map(signature => sabyObject(signature.Сертификат) ? sabyText(signature.Сертификат.Отпечаток)?.replace(/[\s:]/g, '').toLowerCase() : null).filter((v): v is string => !!v);
async function readBusiness(client: SabyClient, record: TripSabyRecord, remote: SabyObject, side: SabySigningSide) {
  const revision = identity(remote, record, side); const source = title(remote, '1110361');
  if (!source || !sabyText(source.Идентификатор)) throw new SabyError('validation', 'Исходный титул заявки ещё не готов. Обновите состояние Saby.');
  const sourceFile = await client.downloadSigningAttachment(side, record.order.id!, String(source.Идентификатор), revision);
  const frozen = serializeSabyTransportOrder(record.snapshot, record.attemptId, record.createdAt, record.order.number!);
  const sourceIdentity = verifySabySenderBusiness(sourceFile.bytes, frozen.xml);
  return { revision, source, sourceFile, sourceIdentity };
}
interface SigningContext { base: Snapshot; store: OperationsStorage; tripId: string; authorize: (snapshot: Snapshot, data: OperationsData) => void; client?: SabyClient }
async function previewFor(client: SabyClient, record: TripSabyRecord): Promise<TripSabySigningPreview> {
  const senderRemote = await client.readSigningOrder('sender', record.order.id!);
  const business = await readBusiness(client, record, senderRemote, 'sender');
  const blockers: string[] = [];
  const certificates: Record<SabySigningSide, SabySigningCertificate[]> = { sender: [], carrier: [] };
  for (const side of ['sender', 'carrier'] as const) {
    const org = side === 'sender' ? record.snapshot.customerOrganization : record.snapshot.carrierOrganization;
    certificates[side] = (await client.listSigningCertificates(side)).map(raw => signingCertificateForOrganization(raw, org)).filter((v): v is SabySigningCertificate => !!v);
    if (!certificates[side].length) blockers.push(`В Saby не найдена доступная действующая подпись ${org.name}.`);
  }
  const signed = thumbprints(business.source);
  if (signed.length) certificates.sender = certificates.sender.filter(cert => signed.includes(cert.thumbprint));
  if (signed.length && !certificates.sender.length) blockers.push('Исходная заявка подписана другой подписью. Автоматическое продолжение требует сверки.');
  if (record.signing) blockers.push('По этой заявке уже сохранено поручение на подписание. CRM проверяет его результат.');
  if (['6', '9', '22', '23'].includes(sabyOrderStateCode(senderRemote) ?? '')) blockers.push('На текущем этапе Saby новое поручение на подписание недоступно. Обновите состояние.');
  let carrierPreview: unknown = null;
  if (['4', '7'].includes(sabyOrderStateCode(senderRemote) ?? '')) {
    const incoming = await client.readSigningOrder('carrier', record.order.id!);
    const incomingBusiness = await readBusiness(client, record, incoming, 'carrier');
    if (bytesHash(incomingBusiness.sourceFile.bytes) !== bytesHash(business.sourceFile.bytes)) throw new SabyError('validation', 'Кабинеты сторон пока показывают разные исходные титулы. Подождите обновления Saby.');
    const reply = title(incoming, '1110362');
    const replyFile = reply ? await client.downloadSigningAttachment('carrier', record.order.id!, String(reply.Идентификатор), incomingBusiness.revision) : null;
    carrierPreview = { revision: incomingBusiness.revision, state: sabyOrderStateCode(incoming), stages: incoming.ТекущиеЭтапы ?? incoming.Этап ?? null, titleId: reply?.Идентификатор ?? null, hash: replyFile ? bytesHash(replyFile.bytes) : null, signed: thumbprints(reply) };
  }
  const token = hash({ carrierPreview, attempt: record.attemptId, payload: record.payloadHash, document: record.order.id, number: record.order.number, revision: business.revision, sourceHash: bytesHash(business.sourceFile.bytes), state: sabyOrderStateCode(senderRemote), stages: senderRemote.ТекущиеЭтапы ?? senderRemote.Этап ?? null, signed, certificates: { sender: certificates.sender.map(c => c.thumbprint), carrier: certificates.carrier.map(c => c.thumbprint) } });
  return { order: { id: record.order.id, number: record.order.number, date: record.order.date, revision: business.revision }, checkedAt: stamp(), previewToken: blockers.length ? null : token, ready: !blockers.length, blockers, sender: { organization: record.snapshot.customerOrganization.name, signatures: certificates.sender.map(c => ({ id: c.thumbprint, owner: c.ownerName, expiresAt: c.notAfter })), message: signed.length ? 'Подпись отправителя уже подтверждена в Saby; повторная отправка не нужна.' : 'Saby может запросить подтверждение владельца подписи.' }, carrier: { organization: record.snapshot.carrierOrganization.name, signatures: certificates.carrier.map(c => ({ id: c.thumbprint, owner: c.ownerName, expiresAt: c.notAfter })), message: 'Ответ НК будет подписан после проверки заполненных сведений. Подтверждение владельца сохраняется.' }, ...(record.signing ? { signing: publicTripSigning(record.signing) } : {}) };
}
/** Read-only capability check: does not prepare an action, create a request or touch a lease. */
export async function getTripSigningPreview(context: SigningContext): Promise<TripSabySigningPreview> {
  const { base, store, tripId, authorize } = context; const source = base.provenance.sourceSha256;
  const check = async () => { const data = await store.read(source); authorize(currentSnapshot(base, data), data); };
  await check(); const data = await store.read(source); const record = data.tripSaby?.trips[tripId];
  if (!record?.order.id) throw new ApiError(409, 'Сначала создайте заявку рейса в Saby.');
  const client = (context.client ?? new SabyClient(sabyConfigFromEnv())).withRequestGuard(check);
  return previewFor(client, record);
}
export async function beginTripSigning(client: SabyClient, record: TripSabyRecord, request: TripSabySigningStartRequest, requestedBy: string, update: (mutation: (row: TripSabyRecord) => void) => Promise<void>) {
  validateSigningStart(request);
  if (record.signing) {
    const previous = record.signing;
    if (previous.requestId !== request.requestId || previous.requestedBy !== requestedBy || previous.previewToken !== request.previewToken || previous.selection.sender !== request.senderSignatureId || previous.selection.carrier !== request.carrierSignatureId) throw new ApiError(409, 'По этой заявке уже запущено другое поручение. Обновите состояние.');
    return;
  }
  if (record.autoAuthorization) throw new ApiError(409, 'По этому рейсу уже сохранено поручение на автоматическую отправку.');
  const preview = await previewFor(client, record);
  if (!preview.ready || !preview.previewToken || preview.previewToken !== request.previewToken) throw new ApiError(409, 'Заявка или доступные подписи изменились. Проверьте сведения ещё раз перед запуском.');
  if (!preview.sender.signatures.some(c => c.id === request.senderSignatureId) || !preview.carrier.signatures.some(c => c.id === request.carrierSignatureId)) throw new ApiError(422, 'Выбранная подпись не принадлежит нужной стороне или больше недоступна.');
  await update(row => { row.initiatorId ??= requestedBy; row.carrierFill ??= newCarrierFill(); row.signing = { requestedBy, requestedAt: stamp(), requestId: request.requestId, previewToken: request.previewToken, workflowAttemptId: row.attemptId, documentId: row.order.id!, revision: preview.order.revision!, payloadHash: row.payloadHash, selection: { sender: request.senderSignatureId, carrier: request.carrierSignatureId }, sender: { state: 'not_started' }, carrier: { state: 'not_started' } }; });
}
/** Promotes only the request frozen by the trip-save transaction, after the source title exists. */
export async function beginAutomaticTripSigning(client: SabyClient, record: TripSabyRecord, update: (mutation: (row: TripSabyRecord) => void) => Promise<void>) {
  const authorization = record.autoAuthorization;
  if (!authorization || record.signing) return;
  const preview = await previewFor(client, record);
  if (!preview.ready || !preview.previewToken || !preview.order.revision || !preview.sender.signatures.some(cert => cert.id === authorization.selection.sender) || !preview.carrier.signatures.some(cert => cert.id === authorization.selection.carrier)) throw new SabyError('validation', preview.blockers.join(' ') || 'Сохранённые подписи организаций сейчас недоступны. Автоотправка остановлена.');
  await update(row => {
    if (!row.autoAuthorization || row.autoAuthorization.requestId !== authorization.requestId || row.signing) throw new ApiError(409, 'Сохранённое поручение автоотправки изменилось.');
    row.signing = { requestedBy: authorization.requestedBy, requestedAt: authorization.requestedAt, requestId: authorization.requestId, previewToken: preview.previewToken!, workflowAttemptId: row.attemptId, documentId: row.order.id!, revision: preview.order.revision!, payloadHash: row.payloadHash, selection: { ...authorization.selection }, mode: 'automatic', sender: { state: 'not_started' }, carrier: { state: 'not_started' } };
  });
}
const metadata = (prepared: SabyPreparedSigning): SigningMetadata => ({ binding: prepared.binding, preparedHash: prepared.preparedHash, attachments: prepared.attachments.map(({ id, name, subtype, sha256 }) => ({ id, name, subtype, sha256 })) });
interface AdvanceContext {
  client: SabyClient; record: () => TripSabyRecord;
  update: (mutation: (row: TripSabyRecord) => void) => Promise<void>;
  checkAccess: () => Promise<void>;
  allowSigningRecovery?: boolean;
  recoveryRequestedBy?: string;
}
/** Only the vehicle identity frozen in every delivery may justify Saby's extra VIN/STS attributes. */
export function signingVehicleIdentity(record: TripSabyRecord): SabyCarrierVehicleIdentity | undefined {
  const first = record.deliveries[0]?.snapshot.vehicle;
  if (!first || !first.vin || !first.stsNumber || first.id !== record.snapshot.fields.vehicle_id || first.plate !== record.snapshot.vehicle.plate || record.deliveries.some(row => row.snapshot.vehicle.id !== first.id || row.snapshot.vehicle.plate !== first.plate || row.snapshot.vehicle.vin !== first.vin || row.snapshot.vehicle.stsNumber !== first.stsNumber)) return undefined;
  return { plate: first.plate, vin: first.vin, stsNumber: first.stsNumber };
}
const verifiedManifest = (step: TripSigningStep) => step.preparedVerified === true || step.preparedVerified === undefined && (step.executeAttempted === true || step.binding?.stageId === 'observed-signed');

/** Carrier preparation does not include the incoming source in its signable-file manifest. */
async function verifyPreparedCarrierSource(client: SabyClient, record: TripSabyRecord, revision: string, carrierBytes: Uint8Array) {
  const intent = record.signing!; const sender = intent.sender.prepared!;
  const source = sender.attachments.find(file => file.id === sender.binding.attachmentId);
  const evidence = await readSigningEvidence(client, sender);
  if (!source || evidence.state !== 'confirmed') throw new SabyError('validation', 'Подписанный исходный титул изменился при подготовке ответа НК. Подписание остановлено.');
  const remote = await client.readSigningOrder('carrier', intent.documentId);
  const business = await readBusiness(client, record, remote, 'carrier');
  if (business.revision !== revision || bytesHash(business.sourceFile.bytes) !== source.sha256) throw new SabyError('validation', 'Исходный титул в кабинете НК изменился при подготовке. Подписание остановлено.');
  verifySabyCarrierLink(carrierBytes, business.sourceIdentity);
}

/** Persist all prepared files even when subsequent semantic validation rejects them. */
async function finishPreparedSigning(context: AdvanceContext, side: SabySigningSide, prepared: SabyPreparedSigning, verify: () => void | Promise<void>) {
  const { client, update, checkAccess } = context;
  await update(row => { row.signing![side] = { ...row.signing![side], state: 'preparing', binding: prepared.binding, prepared: metadata(prepared), preparedVerified: false, message: 'Файлы получены из Saby. CRM проверяет итоговые сведения перед подписанием.' }; });
  await verify();
  await checkAccess();
  await update(row => { row.signing![side] = { ...row.signing![side], state: 'requested', preparedVerified: true, executeAttempted: true, message: row.signing!.mode === 'automatic' ? 'Запрос на автоматическое подписание передан в Saby. CRM проверяет результат.' : 'Запрос на подпись передан в Saby. Если Saby требует согласие владельца, ожидается его подтверждение.' }; });
  await checkAccess(); await client.executeDeferredSigning(prepared); await checkAccess();
  const result = await readSigningEvidence(client, metadata(prepared));
  await update(row => { row.signing![side] = { ...row.signing![side], state: result.state === 'confirmed' ? 'confirmed' : result.state === 'changed' ? 'blocked' : result.state === 'unconfirmed' ? 'unknown' : 'waiting', message: result.reason }; });
}
/** A one-time correction for the known legacy block, never an automatic retry of unknown preparation. */
async function recoverLegacyCarrierSigning(context: AdvanceContext): Promise<void> {
  const { client, update, checkAccess } = context; const record = context.record(); const intent = record.signing!; const step = intent.carrier;
  if (!context.allowSigningRecovery || !context.recoveryRequestedBy || step.state !== 'blocked' || step.message !== CARRIER_BUSINESS_CHANGED || !step.binding || !step.businessHash || step.prepared || step.executeAttempted !== undefined || step.recovery || intent.sender.state !== 'confirmed' || !intent.sender.prepared || !verifiedManifest(intent.sender)) return;
  const expectedVehicle = signingVehicleIdentity(record);
  if (!expectedVehicle) throw new SabyError('validation', 'В сохранённых доставках не подтверждены одинаковые VIN и СТС выбранной машины. Автоматическое продолжение остановлено.');
  await checkAccess();
  const sourceEvidence = await readSigningEvidence(client, intent.sender.prepared);
  if (sourceEvidence.state !== 'confirmed') throw new SabyError('validation', 'Подписанный исходный титул больше не подтверждён. Продолжение остановлено.');
  const remote = await client.readSigningOrder('carrier', intent.documentId);
  const business = await readBusiness(client, record, remote, 'carrier');
  const sourceFile = intent.sender.prepared.attachments.find(file => file.id === intent.sender.prepared!.binding.attachmentId);
  if (!sourceFile || sourceFile.sha256 !== bytesHash(business.sourceFile.bytes)) throw new SabyError('validation', 'Исходный титул в кабинете НК изменился. Продолжение остановлено.');
  const attachment = title(remote, '1110362'); const fill = record.carrierFill;
  if (sabyOrderStateCode(remote) !== '10' || business.revision !== step.binding.revision || !attachment || attachment.Идентификатор !== step.binding.attachmentId || rows(attachment.Подпись).length || fill?.state !== 'saved' || !fill.driverSaved || !fill.vehicleSaved || fill.responsibleSaved === false || fill.blockers.length || !fill.intent?.verified || fill.intent.revision !== step.binding.revision || fill.intent.attachmentId !== step.binding.attachmentId) throw new SabyError('validation', 'Состояние или заполнение ответа НК изменилось. Продолжение остановлено.');
  const cert = signingCertificateForOrganization(await client.readSigningCertificate('carrier', intent.selection.carrier), record.snapshot.carrierOrganization);
  if (!cert || cert.thumbprint !== intent.selection.carrier) throw new SabyError('validation', 'Выбранная подпись НК больше не подтверждена.');
  const binding = createSigningBinding(remote, 'carrier', cert, client.config, intent.mode === 'automatic' ? 'Отложенный' : undefined);
  if (hash(binding) !== hash(step.binding)) throw new SabyError('validation', 'Этап или действие НК изменились после остановки. Продолжение остановлено.');
  const current = await client.downloadSigningAttachment('carrier', intent.documentId, binding.attachmentId, binding.revision);
  verifySabyCarrierLink(current.bytes, business.sourceIdentity);
  const accepted = verifySabyCarrierVehicleAddition(current.bytes, step.businessHash, expectedVehicle);
  await checkAccess();
  const recovery: TripSigningRecovery = { kind: 'verified_vehicle_identity_addition', id: randomUUID(), requestedAt: stamp(), requestedBy: context.recoveryRequestedBy, originalBinding: structuredClone(step.binding), originalBusinessHash: step.businessHash, originalMessage: CARRIER_BUSINESS_CHANGED, acceptedBusinessHash: accepted.businessHash, currentRawHash: bytesHash(current.bytes), prepareAttempted: true };
  await update(row => { row.signing!.carrier = { ...row.signing!.carrier, recovery, state: 'preparing', message: 'VIN и СТС сверены с сохранённой машиной. Saby повторно подготавливает итоговый список файлов.' }; });
  await checkAccess();
  // The preparation helper rechecks the exact stage, certificate trust and lease before its write.
  const latest = await client.downloadSigningAttachment('carrier', intent.documentId, binding.attachmentId, binding.revision);
  if (bytesHash(latest.bytes) !== recovery.currentRawHash) throw new SabyError('validation', 'Ответ НК изменился после сверки VIN и СТС. Продолжение остановлено.');
  const prepared = await prepareBoundSigning(client, binding);
  await finishPreparedSigning(context, 'carrier', prepared, async () => {
    const primary = prepared.attachments.find(file => file.id === binding.attachmentId);
    if (!primary) throw new SabyError('validation', 'В подготовленных файлах отсутствует ответ НК.');
    verifySabyCarrierLink(primary.bytes, business.sourceIdentity);
    if (carrierBusinessHash(primary.bytes) !== recovery.acceptedBusinessHash) throw new SabyError('validation', 'Saby повторно изменил сведения ответа НК. Подписание остановлено.');
    await verifyPreparedCarrierSource(client, context.record(), binding.revision, primary.bytes);
  });
}
/** Preparing the missing reply is a separate write, with its own non-repeatable durable intent. */
export async function ensureSigningCarrierDraft(context: AdvanceContext): Promise<void> {
  const { client, update, checkAccess } = context; const record = context.record(); const intent = record.signing;
  if (!intent || intent.sender.state !== 'confirmed' || intent.carrier.binding || intent.carrierDraft?.state === 'blocked') return;
  try {
    await checkAccess();
    const sourceEvidence = await readSigningEvidence(client, intent.sender.prepared!);
    if (sourceEvidence.state !== 'confirmed') { await update(row => { row.signing!.sender.state = sourceEvidence.state === 'changed' ? 'blocked' : sourceEvidence.state === 'unconfirmed' ? 'unknown' : 'waiting'; row.signing!.sender.message = sourceEvidence.reason; }); return; }
    const remote = await client.readSigningOrder('carrier', intent.documentId);
    const business = await readBusiness(client, record, remote, 'carrier');
    const senderFile = intent.sender.prepared!.attachments.find(file => file.id === intent.sender.prepared!.binding.attachmentId);
    if (!senderFile || senderFile.sha256 !== bytesHash(business.sourceFile.bytes)) throw new SabyError('validation', 'Входящая заявка НК не совпадает с подтверждённым подписанным титулом отправителя.');
    const draft = intent.carrierDraft;
    if (draft && business.revision !== draft.binding.revision) throw new SabyError('validation', 'Редакция ответа НК изменилась после запроса подготовки.');
    if (title(remote, '1110362')) {
      if (draft && draft.state !== 'ready') await update(row => { row.signing!.carrierDraft!.state = 'ready'; });
      return;
    }
    if (draft) {
      await update(row => { row.signing!.carrierDraft!.state = 'unknown'; row.signing!.carrier = { state: 'unknown', message: 'Saby ещё не вернул подготовленный ответ НК. Повторная подготовка не выполняется.' }; });
      return;
    }
    if (sabyOrderStateCode(remote) !== '10') return;
    const cert = signingCertificateForOrganization(await client.readSigningCertificate('carrier', intent.selection.carrier), record.snapshot.carrierOrganization);
    if (!cert || cert.thumbprint !== intent.selection.carrier) throw new SabyError('validation', 'Подпись НК больше не доступна выбранному сотруднику.');
    const binding = createCarrierDraftBinding(remote, cert, client.config, intent.mode === 'automatic' ? 'Отложенный' : undefined);
    await update(row => { row.signing!.carrierDraft = { binding, state: 'preparing' }; row.signing!.carrier = { state: 'waiting', message: 'Saby формирует черновик ответа НК; подписание ещё не выполняется.' }; });
    await checkAccess(); await prepareCarrierDraft(client, binding);
    await update(row => { row.signing!.carrierDraft!.state = 'ready'; });
  } catch (error) {
    const definite = error instanceof SabyError && error.kind === 'validation' && !error.uncertain;
    await update(row => { if (row.signing!.carrierDraft) row.signing!.carrierDraft!.state = definite ? 'blocked' : 'unknown'; row.signing!.carrier = { state: definite ? 'blocked' : 'unknown', message: definite ? (error as SabyError).message : 'Результат подготовки ответа НК пока неизвестен. CRM сверяет его без повторной подготовки.' }; });
    if (error instanceof ApiError && [401, 403, 409].includes(error.status)) throw error;
  }
}
/** Only a saved, explicitly confirmed request reaches this state machine. */
export async function advanceTripSigning(context: AdvanceContext, side: SabySigningSide): Promise<void> {
  const { client, update, checkAccess } = context;
  const initial = context.record(); const intent = initial.signing; if (!intent) return;
  const initialStep = intent[side];
  if (side === 'carrier' && intent.sender.state !== 'confirmed' || initialStep.state === 'blocked' && (side !== 'carrier' || !context.allowSigningRecovery)) return;
  const save = (step: TripSigningStep) => update(row => { row.signing![side] = step; });
  try {
    await checkAccess();
    if (initialStep.state === 'blocked') { await recoverLegacyCarrierSigning(context); return; }
    // A prior preparation or execution is reconciled by reads only, including after restart.
    if (initialStep.prepared) {
      if (!verifiedManifest(initialStep)) {
        await save({ ...initialStep, state: 'blocked', message: 'Подготовленные файлы сохранены, но их сведения не прошли проверку. Отправка на подпись не выполняется.' });
        return;
      }
      const result = await readSigningEvidence(client, initialStep.prepared);
      await save({ ...initialStep, state: result.state === 'confirmed' ? 'confirmed' : result.state === 'changed' ? 'blocked' : result.state === 'pending' && initialStep.executeAttempted ? 'waiting' : 'unknown', message: result.reason });
      return;
    }
    if (initialStep.binding) {
      // Preparation may have reached Saby before the connection disappeared. Read the actual
      // document, but never reconstruct a lost signable-file list to execute automatically.
      const observed = await client.readSigningOrder(side, intent.documentId);
      const revision = identity(observed, context.record(), side);
      if (revision !== initialStep.binding.revision) throw new SabyError('validation', 'Редакция изменилась после подготовки к подписи. Требуется сверка.');
      const current = title(observed, initialStep.binding.attachmentSubtype);
      if (!current || current.Идентификатор !== initialStep.binding.attachmentId) throw new SabyError('validation', 'Подготовленный титул изменился или отсутствует. Требуется сверка.');
      const signed = thumbprints(current);
      if (!signed.length || !(side === 'sender' ? ['3', '4', '7'].includes(sabyOrderStateCode(observed) ?? '') : sabyOrderStateCode(observed) === '7')) {
        await save({ ...initialStep, state: 'unknown', message: 'Saby ещё не подтвердил итог подготовки и подпись. CRM сверяет заявку без повторной подготовки или отправки.' });
        return;
      }
      // A later manual/remote completion may be adopted only through the same full business,
      // selected certificate and signed-byte checks used for already-signed documents below.
    }
    const record = context.record();
    if (side === 'carrier' && intent.carrierDraft && intent.carrierDraft.state !== 'ready') return;
    const remote = await client.readSigningOrder(side, intent.documentId);
    const business = await readBusiness(client, record, remote, side);
    if (side === 'sender' && business.revision !== intent.revision) throw new SabyError('validation', 'Редакция исходной заявки изменилась после подтверждения.');
    if (side === 'carrier') {
      const senderFile = intent.sender.prepared!.attachments.find(file => file.id === intent.sender.prepared!.binding.attachmentId);
      if (!senderFile || senderFile.sha256 !== bytesHash(business.sourceFile.bytes)) throw new SabyError('validation', 'Ответ НК относится к изменённому исходному титулу. Подписание остановлено.');
    }
    let carrierBefore: Uint8Array | undefined;
    const attachment = title(remote, side === 'sender' ? '1110361' : '1110362');
    if (!attachment) { await save({ state: 'waiting', message: 'Saby ещё готовит ответ НК. CRM продолжит проверку автоматически.' }); return; }
    const organization = side === 'sender' ? record.snapshot.customerOrganization : record.snapshot.carrierOrganization;
    const raw = await client.readSigningCertificate(side, intent.selection[side]);
    const cert = signingCertificateForOrganization(raw, organization);
    if (!cert || cert.thumbprint !== intent.selection[side]) throw new SabyError('validation', 'Выбранная подпись больше не доступна нужной организации.');
    const existing = thumbprints(attachment);
    // Adoption uses the selected signature and exact current bytes; no remote action is invoked.
    if (existing.length) {
      if (!existing.includes(cert.thumbprint)) throw new SabyError('validation', 'Титул подписан другой подписью. Требуется сверка.');
      if (side === 'carrier') {
        const file = await client.downloadSigningAttachment(side, intent.documentId, String(attachment.Идентификатор), business.revision);
        verifySabyCarrierLink(file.bytes, business.sourceIdentity);
        const fill = record.carrierFill;
        if (fill?.state !== 'saved' || !fill.intent?.verified || fill.intent.attachmentId !== attachment.Идентификатор || fill.intent.revision !== business.revision || (initialStep.businessHash ? carrierBusinessHash(file.bytes) !== (initialStep.recovery?.acceptedBusinessHash ?? initialStep.businessHash) : carrierXmlHash(file.bytes) !== fill.intent.afterHash)) throw new SabyError('validation', 'Ранее подписанный ответ НК не совпадает с последними подтверждёнными сведениями CRM. Требуется сверка.');
      }
      const prepared = await captureSignedTitle(client, side, remote, cert);
      const binding = prepared.binding;
      const result = await readSigningEvidence(client, prepared);
      await save({ ...initialStep, state: result.state === 'confirmed' ? 'confirmed' : result.state === 'changed' ? 'blocked' : result.state === 'unconfirmed' ? 'unknown' : 'waiting', message: result.reason, binding, prepared, preparedVerified: true });
      return;
    }
    if (side === 'sender' && business.revision !== intent.revision) throw new SabyError('validation', 'Редакция исходной заявки изменилась после подтверждения.');
    if (side === 'carrier') {
      const fill = record.carrierFill;
      if (fill?.state !== 'saved' || !fill.driverSaved || !fill.vehicleSaved || fill.responsibleSaved === false || fill.blockers.length || !fill.intent?.verified) { await save({ state: 'waiting', message: 'Сначала необходимо подтвердить все сведения водителя, машины и ответственного в ответе НК.' }); return; }
      if (fill.intent.revision !== business.revision || fill.intent.attachmentId !== attachment.Идентификатор) throw new SabyError('validation', 'Ответ НК изменился после заполнения. Автоматическое подписание остановлено.');
      const file = await client.downloadSigningAttachment(side, intent.documentId, String(attachment.Идентификатор), business.revision);
      if (carrierXmlHash(file.bytes) !== fill.intent.afterHash) throw new SabyError('validation', 'В ответе НК появились изменения после заполнения. Требуется сверка.');
      verifySabyCarrierLink(file.bytes, business.sourceIdentity);
      carrierBefore = file.bytes;
    }
    const binding = createSigningBinding(remote, side, cert, client.config, intent.mode === 'automatic' ? 'Отложенный' : undefined);
    await save({ state: 'preparing', binding, ...(carrierBefore ? { businessHash: carrierBusinessHash(carrierBefore) } : {}), message: 'Saby подготавливает выбранный титул к подписанию.' });
    await checkAccess();
    const prepared = await prepareBoundSigning(client, binding);
    await finishPreparedSigning(context, side, prepared, async () => {
      // Saby's additions are accepted only against the identity frozen in all deliveries.
      const primary = prepared.attachments.find(a => a.id === binding.attachmentId);
      if (!primary) throw new SabyError('validation', 'Saby не подтвердил подготовленный титул.');
      if (side === 'sender') {
        const frozen = serializeSabyTransportOrder(record.snapshot, record.attemptId, record.createdAt, record.order.number!);
        verifySabySenderBusiness(primary.bytes, frozen.xml);
      } else {
        verifySabyCarrierLink(primary.bytes, business.sourceIdentity);
        verifySabyCarrierBusiness(primary.bytes, carrierBefore!, signingVehicleIdentity(record));
        await verifyPreparedCarrierSource(client, context.record(), binding.revision, primary.bytes);
      }
    });
  } catch (error) {
    const latest = context.record().signing![side];
    // Read-only preflight failures must not consume the narrowly eligible legacy recovery.
    // The workflow records the error separately; the original blocked proof stays intact.
    if (side === 'carrier' && context.allowSigningRecovery && initialStep.state === 'blocked' && initialStep.message === CARRIER_BUSINESS_CHANGED && !latest.recovery && !latest.prepared && !latest.executeAttempted) throw error;
    const definite = error instanceof SabyError && ['validation', 'configuration', 'permission', 'authorization'].includes(error.kind) && !error.uncertain;
    await save({ ...latest, state: definite ? 'blocked' : 'unknown', message: definite ? (error as SabyError).message : 'Результат действия в Saby пока неизвестен. CRM проверяет его и не отправляет повторно.' });
    if (error instanceof ApiError && [401, 403, 409].includes(error.status)) throw error;
  }
}

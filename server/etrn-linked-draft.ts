import { createHash } from 'node:crypto';
import { SabyClient, SabyError, sabyDocumentWorkflow, sabyObject, sabyText, type SabyObject, type SabyOrganization } from './saby-client';
import type { SabyConsignmentSnapshot } from './saby-consignment-note';
import { allocateNativeConsignmentDraft, fillConsignmentDraft, hasExactConsignmentOrderLink, verifyConsignmentDraftUpdate, verifyDraftRequestedFields } from './saby-consignment-draft';

/** Private, immutable before/expected evidence; only dispatch and confirmation flags advance. */
export interface LinkedDraftState {
  version: 1;
  allocation?: { version: 1; shipmentIds: string[]; snapshotHashes: string[] };
  sourceOrderId: string; sourceOrderNumber: string; sourceOrderDate: string;
  documentId: string; documentNumber: string; documentDate: string; originalMarker: string;
  originalRevision: string; originalStateCode: '0'; originalMetadataHash: string;
  preservedHeadersHash: string; existingRecipientHash: string | null;
  attachmentId: string; attachmentName: string;
  beforeBase64: string; beforeHash: string; filledBase64: string; filledHash: string;
  writeAttempted: boolean; writeConfirmed: boolean; confirmedAt: string | null;
}
export interface LinkedDraftDocument {
  id: string | null; number?: string; marker: string; snapshot: SabyConsignmentSnapshot;
  linkedDraft?: LinkedDraftState;
}
export interface LinkedDraftContext {
  client: SabyClient;
  order: { id: string; number: string; date: string };
  deliveryCount: number;
  allocationSnapshots?: SabyConsignmentSnapshot[];
  allocationDocumentIds?: string[];
  readOnly?: boolean;
  /** A confirmed fill may later become an exactly pinned, verified signing title. */
  verifyPreparedTitle?: (remote: SabyObject, bytes: Uint8Array) => void;
  current: () => LinkedDraftDocument;
  update: (patch: { id?: string | null; number?: string; linkedDraft?: LinkedDraftState }) => Promise<void>;
  checkAccess: () => Promise<void>;
}
const digest = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const fail = (message: string): never => { throw new SabyError('unknown', message, true); };
const hasControls = (value: string) => [...value].some(character => character.charCodeAt(0) < 32);
const validString = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value && !hasControls(value);
const validHash = (value: unknown): value is string => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const base64Bytes = (value: unknown): Buffer => {
  if (typeof value !== 'string' || !value.length || value.length > 28 * 1024 * 1024 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Invalid linked draft bytes');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > 20 * 1024 * 1024 || bytes.toString('base64') !== value) throw new Error('Invalid linked draft bytes');
  return bytes;
};
const stateFields = ['version', 'allocation', 'sourceOrderId', 'sourceOrderNumber', 'sourceOrderDate', 'documentId', 'documentNumber', 'documentDate', 'originalMarker', 'originalRevision', 'originalStateCode', 'originalMetadataHash', 'preservedHeadersHash', 'existingRecipientHash', 'attachmentId', 'attachmentName', 'beforeBase64', 'beforeHash', 'filledBase64', 'filledHash', 'writeAttempted', 'writeConfirmed', 'confirmedAt'];

export function validateLinkedDraftState(value: unknown, documentId?: string | null): asserts value is LinkedDraftState | undefined {
  if (value === undefined) return;
  if (!sabyObject(value) || Object.keys(value).some(key => !stateFields.includes(key)) || value.version !== 1 || value.originalStateCode !== '0' ||
      !['sourceOrderId', 'sourceOrderNumber', 'sourceOrderDate', 'documentId', 'documentNumber', 'documentDate', 'originalRevision', 'attachmentId', 'attachmentName'].every(key => validString(value[key])) ||
      typeof value.originalMarker !== 'string' || value.originalMarker.length > 1024 || hasControls(value.originalMarker) ||
      !['originalMetadataHash', 'preservedHeadersHash', 'beforeHash', 'filledHash'].every(key => validHash(value[key])) || !(value.existingRecipientHash === null || validHash(value.existingRecipientHash)) ||
      typeof value.writeAttempted !== 'boolean' || typeof value.writeConfirmed !== 'boolean' ||
      !(value.confirmedAt === null || typeof value.confirmedAt === 'string' && Number.isFinite(Date.parse(value.confirmedAt))) ||
      value.writeConfirmed !== (value.confirmedAt !== null) || documentId !== undefined && value.documentId !== documentId ||
      !String(value.attachmentName).toLowerCase().endsWith('.xml') || /[/\\]/u.test(String(value.attachmentName))) throw new Error('Invalid linked draft evidence');
  if (value.allocation !== undefined && (!sabyObject(value.allocation) || Object.keys(value.allocation).some(key => !['version', 'shipmentIds', 'snapshotHashes'].includes(key)) || value.allocation.version !== 1 || !Array.isArray(value.allocation.shipmentIds) || !value.allocation.shipmentIds.length || !value.allocation.shipmentIds.every(validString) || new Set(value.allocation.shipmentIds).size !== value.allocation.shipmentIds.length || !Array.isArray(value.allocation.snapshotHashes) || value.allocation.snapshotHashes.length !== value.allocation.shipmentIds.length || !value.allocation.snapshotHashes.every(validHash))) throw new Error('Invalid native allocation evidence');
  if (digest(base64Bytes(value.beforeBase64)) !== value.beforeHash || digest(base64Bytes(value.filledBase64)) !== value.filledHash) throw new Error('Invalid linked draft evidence hash');
}

const ruDate = (date: string) => /^\d{4}-\d{2}-\d{2}$/.test(date) ? date.split('-').reverse().join('.') : date;
const marker = (remote: SabyObject) => remote.Примечание === undefined || remote.Примечание === null ? '' : typeof remote.Примечание === 'string' ? remote.Примечание : fail('Не подтверждена метка существующей ЭТрН.');
const list = (value: unknown): SabyObject[] => Array.isArray(value) ? value.filter(sabyObject) : [];
function consignmentLinks(order: SabyObject): SabyObject[] {
  const value = order.ДокументСледствие;
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.some(row => !sabyObject(row) || !sabyObject(row.Документ) || !validString(row.Документ.Идентификатор) || !validString(row.Документ.Тип))) return fail('Состав связанных документов заявки не подтверждён.');
  return value.filter((row): row is SabyObject => sabyObject(row) && sabyObject(row.Документ) && row.Документ.Тип === 'ConsignmentNote');
}
const partyMatches = (raw: unknown, expected: { inn: string; kpp: string }) => sabyObject(raw) && (/^\d{12}$/.test(expected.inn)
  ? sabyObject(raw.СвФЛ) && raw.СвФЛ.ИНН === expected.inn
  : sabyObject(raw.СвЮЛ) && raw.СвЮЛ.ИНН === expected.inn && raw.СвЮЛ.КПП === expected.kpp);
const roles = (remote: SabyObject) => {
  const parties = sabyObject(remote.Стороны) ? remote.Стороны : {};
  return {
    sender: [remote.Грузоотправитель, parties.Отправитель].filter(value => value !== undefined && value !== null),
    carrier: [remote.ТранспортнаяКомпания, remote.Перевозчик, parties.Перевозчик].filter(value => value !== undefined && value !== null),
    recipient: [remote.Грузополучатель, parties.Получатель].filter(value => value !== undefined && value !== null),
  };
};
function verifyParties(remote: SabyObject, snapshot: SabyConsignmentSnapshot, requireRecipient: boolean) {
  const found = roles(remote);
  if (!partyMatches(remote.НашаОрганизация, snapshot.customerOrganization) || !found.sender.length || !found.sender.every(row => partyMatches(row, snapshot.customerOrganization)) ||
      !found.carrier.length || !found.carrier.every(row => partyMatches(row, snapshot.carrierOrganization))) fail('Не подтверждены отправитель и перевозчик существующей ЭТрН.');
  // An empty role is accepted only before filling. A different populated participant is never overwritten.
  const recipients = found.recipient.filter(row => !sabyObject(row) || Object.keys(row).length > 0);
  if (requireRecipient && !recipients.length || recipients.some(row => !partyMatches(row, snapshot.profile.recipient))) fail('Получатель существующей ЭТрН отличается от сохранённой доставки.');
}
function hasSignature(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(hasSignature);
  if (!sabyObject(value)) return false;
  return Object.entries(value).some(([key, child]) => key === 'Подпись'
    ? Array.isArray(child) ? child.length > 0 : sabyObject(child) ? Object.keys(child).length > 0 : !!child
    : key === 'КоличествоПодписей' && Number(child) > 0 || key === 'Подписан' && child === 'Да' || hasSignature(child));
}
function revision(remote: SabyObject): string {
  const revisions = list(remote.Редакция), active = revisions.filter(row => row.Актуален === 'Да');
  if (active.length !== 1 || !validString(active[0].Идентификатор)) return fail('Не подтверждена единственная текущая редакция существующей ЭТрН.');
  return active[0].Идентификатор;
}
function senderAttachment(remote: SabyObject, mutable: boolean, expectedId?: string): { id: string; name: string } {
  if (!Array.isArray(remote.Вложение) || remote.Вложение.some(row => !sabyObject(row)) || mutable && remote.Вложение.length !== 1) return fail('Для дополнения ЭТрН требуется единственный неподписанный первый титул без других вложений.');
  const titles = list(remote.Вложение).filter(row => row.Подтип === '1110339' && row.ВерсияФормата === '5.01' && row.Удален !== 'Да' && row.Актуален !== 'Нет');
  if (titles.length !== 1 || !validString(titles[0].Идентификатор) || expectedId !== undefined && titles[0].Идентификатор !== expectedId) return fail('Исходное вложение ЭТрН изменилось. Автоматическая запись остановлена.');
  const file = sabyObject(titles[0].Файл) ? titles[0].Файл : {};
  const name = sabyText(file.Имя);
  if (!name || !validString(name) || !name.toLowerCase().endsWith('.xml') || /[/\\]/u.test(name)) return fail('Не подтверждено имя исходного XML ЭТрН.');
  return { id: titles[0].Идентификатор, name };
}
function validateOrder(remote: SabyObject, context: LinkedDraftContext) {
  const expected = context.order, snapshot = context.current().snapshot;
  if (remote.Тип !== 'TransportOrder' || remote.Идентификатор !== expected.id || remote.Номер !== expected.number || remote.Дата !== ruDate(expected.date) ||
      remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да' || !partyMatches(remote.НашаОрганизация, snapshot.customerOrganization) || !partyMatches(remote.Контрагент, snapshot.carrierOrganization)) fail('Связь ЭТрН с исходной заявкой не подтверждена.');
}
function validateNote(remote: SabyObject, order: SabyObject, context: LinkedDraftContext, state?: LinkedDraftState) {
  const doc = context.current();
  if (remote.Тип !== 'ConsignmentNote' || !validString(remote.Идентификатор) || doc.id !== null && remote.Идентификатор !== doc.id || !validString(remote.Номер) ||
      remote.Дата !== ruDate(doc.snapshot.fields.date ?? '') || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да' || (state?.allocation && context.allocationDocumentIds ? JSON.stringify(consignmentLinks(order).map(x => (x.Документ as SabyObject).Идентификатор).sort()) !== JSON.stringify([...new Set([...context.allocationDocumentIds, state.documentId])].sort()) : consignmentLinks(order).length !== 1) || !hasExactConsignmentOrderLink(remote, order)) fail('Не подтверждена однозначная связь существующей ЭТрН с этой заявкой.');
  if (doc.number !== undefined && doc.number !== remote.Номер || state && (state.documentId !== remote.Идентификатор || state.documentNumber !== remote.Номер || state.documentDate !== remote.Дата || marker(remote) !== state.originalMarker) ||
      !state && marker(remote) !== '' && marker(remote) !== doc.marker) fail('Номер или метка существующей ЭТрН не совпадают с сохранённой попыткой.');
  verifyParties(remote, doc.snapshot, false);
}
function validateMutable(remote: SabyObject) {
  if (!sabyObject(remote.Состояние) || remote.Состояние.Код !== '0' || hasSignature(remote)) fail('Существующая ЭТрН уже вышла из неподписанного черновика. Автоматическое дополнение остановлено.');
  senderAttachment(remote, true);
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : sabyObject(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const hashObject = (value: unknown) => digest(JSON.stringify(canonical(value)));
const existingRecipient = (remote: SabyObject) => roles(remote).recipient.find(row => sabyObject(row) && Object.keys(row).length > 0);
function preservedHeadersHash(remote: SabyObject): string {
  const parties = roles(remote), regulation = sabyObject(remote.Регламент) ? remote.Регламент : {};
  return hashObject({ type: remote.Тип, number: remote.Номер, date: remote.Дата, marker: marker(remote),
    own: remote.НашаОрганизация, sender: parties.sender[0] ?? null, carrier: parties.carrier[0] ?? null,
    counterpart: remote.Контрагент ?? null,
    regulation: { id: regulation.Идентификатор ?? null, name: regulation.Название ?? null },
    sourceLinks: remote.ДокументОснование ?? [], consequenceLinks: remote.ДокументСледствие ?? [],
  });
}
/** Saby may derive the previously empty counterpart from the newly filled recipient.
 * Accept that one addition only when removing it restores every pinned business header. */
function preservedHeadersMatch(remote: SabyObject, state: LinkedDraftState, snapshot: SabyConsignmentSnapshot): boolean {
  if (preservedHeadersHash(remote) === state.preservedHeadersHash) return true;
  if (state.existingRecipientHash !== null || !partyMatches(remote.Контрагент, snapshot.profile.recipient)) return false;
  return [null, {}].some(empty => preservedHeadersHash({ ...remote, Контрагент: empty }) === state.preservedHeadersHash);
}
/** Signature download URLs expire independently; all signature identity/content metadata stays pinned. */
function signatureMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(signatureMetadata);
  if (!sabyObject(value) || !sabyObject(value.Файл)) return value;
  return { ...value, Файл: Object.fromEntries(Object.entries(value.Файл).filter(([key]) => key !== 'Ссылка')) };
}
/** URLs and polling timestamps change between reads; pin business headers and the full file inventory. */
function metadataHash(remote: SabyObject): string {
  const keys = ['Идентификатор', 'Тип', 'Номер', 'Дата', 'Примечание', 'Направление', 'Удален', 'ЧастичныеДанные', 'НашаОрганизация', 'Грузоотправитель', 'ТранспортнаяКомпания', 'Перевозчик', 'Грузополучатель', 'Стороны', 'Контрагент', 'Регламент', 'ДокументОснование', 'ДокументСледствие', 'Состояние'];
  return digest(JSON.stringify(canonical({ ...Object.fromEntries(keys.map(key => [key, remote[key] ?? null])), revision: revision(remote),
    files: list(remote.Вложение).map(row => ({ ...Object.fromEntries(Object.entries(row).filter(([key]) => !['Файл', 'СсылкаНаPDF', 'Подпись'].includes(key))), Подпись: signatureMetadata(row.Подпись), Файл: sabyObject(row.Файл) ? { Имя: row.Файл.Имя ?? null } : null })),
  })));
}
function recipientHeader(snapshot: SabyConsignmentSnapshot): SabyObject {
  const recipient = snapshot.profile.recipient;
  if (/^\d{12}$/.test(recipient.inn)) {
    if (!recipient.person) return fail('Не подтверждены реквизиты получателя существующей ЭТрН.');
    return { ...(recipient.edoId ? { Идентификатор: recipient.edoId } : {}), СвФЛ: { ИНН: recipient.inn, Фамилия: recipient.person.surname, Имя: recipient.person.name, Отчество: recipient.person.patronymic, ЧастноеЛицо: 'Нет' } };
  }
  return { ...(recipient.edoId ? { Идентификатор: recipient.edoId } : {}), СвЮЛ: { ИНН: recipient.inn, КПП: recipient.kpp, Название: recipient.name } };
}
const organizationHeader = (value: SabyOrganization): SabyObject => ({ ...(value.edoId ? { Идентификатор: value.edoId } : {}), СвЮЛ: { ИНН: value.inn, КПП: value.kpp, Название: value.name } });
function updateRequest(remote: SabyObject, state: LinkedDraftState, snapshot: SabyConsignmentSnapshot): SabyObject {
  const regulation = remote.Регламент;
  if (!sabyObject(regulation) || !validString(regulation.Идентификатор) || !validString(regulation.Название)) return fail('Не подтверждён регламент существующей ЭТрН.');
  return {
    // The official update example includes BOTH the document ID and nested addressing.
    // Omitting Документ.Идентификатор created another document in production.
    // https://online.saby.ru/disksharedrest/963ac623-133d-4426-b73f-df13a5afcdcb_f79e38c6-0c3f-4224-9727-d6eeca287f1c
    Идентификатор: state.documentId,
    Адресация: { Идентификатор: state.documentId, Редакция: { Идентификатор: state.originalRevision } },
    Тип: 'ConsignmentNote', Номер: state.documentNumber, Дата: state.documentDate,
    Регламент: { Идентификатор: regulation.Идентификатор, Название: regulation.Название },
    ...(Object.hasOwn(remote, 'Примечание') ? { Примечание: remote.Примечание } : {}),
    ДокументОснование: structuredClone(remote.ДокументОснование),
    ...(Object.hasOwn(remote, 'ДокументСледствие') ? { ДокументСледствие: structuredClone(remote.ДокументСледствие) } : {}),
    НашаОрганизация: structuredClone(remote.НашаОрганизация),
    Грузоотправитель: structuredClone(remote.Грузоотправитель ?? roles(remote).sender[0] ?? organizationHeader(snapshot.customerOrganization)),
    ТранспортнаяКомпания: structuredClone(remote.ТранспортнаяКомпания ?? roles(remote).carrier[0] ?? organizationHeader(snapshot.carrierOrganization)),
    Грузополучатель: structuredClone(existingRecipient(remote) ?? recipientHeader(snapshot)),
    Вложение: [{ Идентификатор: state.attachmentId, Файл: { Имя: state.attachmentName, ДвоичныеДанные: state.filledBase64 } }],
  };
}

type DraftUpdateIdentity = Pick<LinkedDraftState, 'documentId' | 'originalRevision'>;

/** A document ID alone does not pin the revision; nested addressing alone can create a document. */
export function assertLinkedDraftUpdateAddressing(document: unknown, expected: DraftUpdateIdentity): asserts document is SabyObject {
  const addressing = sabyObject(document) ? document.Адресация : null;
  if (!validString(expected.documentId) || !validString(expected.originalRevision) ||
      !sabyObject(document) || !validString(document.Идентификатор) || document.Идентификатор !== expected.documentId ||
      !sabyObject(addressing) || addressing.Идентификатор !== expected.documentId ||
      !sabyObject(addressing.Редакция) || addressing.Редакция.Идентификатор !== expected.originalRevision ||
      Object.hasOwn(document, 'Редакция')) fail('Не подтверждена точная адресация существующей ЭТрН. Запись запрещена.');
}

/** This private candidate is not an authorization to retry any previously attempted write. */
export async function dispatchLinkedDraftUpdate(client: SabyClient, document: SabyObject, expected: DraftUpdateIdentity, beforeDispatch: () => Promise<void>): Promise<unknown> {
  const identity = { documentId: expected.documentId, originalRevision: expected.originalRevision };
  const request = structuredClone(document);
  assertLinkedDraftUpdateAddressing(request, identity);
  // Do not allow caller-held references to change selectors during authentication or checks.
  const addressing = request.Адресация as SabyObject;
  Object.freeze(addressing.Редакция); Object.freeze(addressing); Object.freeze(request);
  return client.call('СБИС.ЗаписатьДокумент', { Документ: request }, true, false, async () => {
    assertLinkedDraftUpdateAddressing(request, identity);
    await beforeDispatch();
    assertLinkedDraftUpdateAddressing(request, identity);
  });
}

/** Adopt and fill only Saby's one linked native draft. This function never reserves a document. */
export async function reconcileLinkedConsignmentDraft(context: LinkedDraftContext): Promise<SabyObject | null> {
  const { client, order, current, update, checkAccess } = context;
  validateLinkedDraftState(current().linkedDraft, current().id);
  if (context.readOnly && !current().linkedDraft) return fail('Для сверки требуется сохранённая связь и исходные сведения существующей ЭТрН.');
  await checkAccess();
  let remoteOrder = await client.readTransportOrder(order.id); validateOrder(remoteOrder, context);
  const links = consignmentLinks(remoteOrder);
  if (!links.length && !current().linkedDraft) return null;
  if ((!context.allocationSnapshots && context.deliveryCount !== 1) || (!current().linkedDraft?.allocation && links.length !== 1) || !links.length || !sabyObject(links[0].Документ) || !validString(links[0].Документ.Идентификатор)) return fail('Для автоматической сверки требуется одна ЭТрН, связанная с единственной доставкой заявки. Новые документы не создаются.');
  const linkedId = current().linkedDraft?.documentId ?? links[0].Документ.Идентификатор;
  if (current().id !== null && current().id !== linkedId) return fail('У сохранённой попытки уже есть другая ЭТрН. Автоматическая замена запрещена.');
  let remote = await client.readConsignmentNote(linkedId);
  let state = current().linkedDraft;
  validateNote(remote, remoteOrder, context, state);
  if (state && (state.sourceOrderId !== order.id || state.sourceOrderNumber !== order.number || state.sourceOrderDate !== order.date)) return fail('Исходная заявка сохранённой сверки ЭТрН изменилась.');
  if (!state) {
    validateMutable(remote);
    const file = senderAttachment(remote, true), originalRevision = revision(remote);
    const before = await client.downloadAttachment(linkedId, file.id, originalRevision);
    if (before.name !== file.name) return fail('Имя скачанного исходного XML ЭТрН изменилось.');
    const allocation = context.allocationSnapshots;
    if (allocation && (allocation.length !== context.deliveryCount || JSON.stringify(allocation[0]) !== JSON.stringify(current().snapshot))) return fail('Состав распределения ЭТрН изменился.');
    const filled = allocation ? allocateNativeConsignmentDraft(before.bytes, allocation, String(remote.Номер)) : fillConsignmentDraft(before.bytes, current().snapshot, String(remote.Номер));
    state = { version: 1, ...(allocation ? { allocation: { version: 1 as const, shipmentIds: allocation.map(x => x.shipmentId), snapshotHashes: allocation.map(x => digest(JSON.stringify(x))) } } : {}), sourceOrderId: order.id, sourceOrderNumber: order.number, sourceOrderDate: order.date,
      documentId: linkedId, documentNumber: String(remote.Номер), documentDate: String(remote.Дата), originalMarker: marker(remote),
      originalRevision, originalStateCode: '0', originalMetadataHash: metadataHash(remote), attachmentId: file.id, attachmentName: file.name,
      preservedHeadersHash: preservedHeadersHash(remote), existingRecipientHash: existingRecipient(remote) ? hashObject(existingRecipient(remote)) : null,
      beforeBase64: Buffer.from(before.bytes).toString('base64'), beforeHash: digest(before.bytes), filledBase64: Buffer.from(filled.bytes).toString('base64'), filledHash: digest(filled.bytes),
      writeAttempted: false, writeConfirmed: false, confirmedAt: null,
    };
    validateLinkedDraftState(state, linkedId);
    await checkAccess(); await update({ id: linkedId, number: state.documentNumber, linkedDraft: state });
  }
  const saved = state;
  if (saved.allocation && (!context.allocationSnapshots || JSON.stringify(saved.allocation.snapshotHashes) !== JSON.stringify(context.allocationSnapshots.map(x => digest(JSON.stringify(x)))) || JSON.stringify(saved.allocation.shipmentIds) !== JSON.stringify(context.allocationSnapshots.map(x => x.shipmentId)))) return fail('Снимки распределения ЭТрН изменились.');
  const verifyReadback = async (): Promise<SabyObject> => {
    await checkAccess();
    remoteOrder = await client.readTransportOrder(order.id); validateOrder(remoteOrder, context);
    const result = await client.readConsignmentNote(saved.documentId); validateNote(result, remoteOrder, context, saved);
    verifyParties(result, current().snapshot, true);
    if (!preservedHeadersMatch(result, saved, current().snapshot) || saved.existingRecipientHash !== null && hashObject(existingRecipient(result)) !== saved.existingRecipientHash) return fail('Исходные реквизиты или связи ЭТрН изменились после дополнения. Требуется сверка.');
    const title = senderAttachment(result, false, saved.attachmentId), readRevision = revision(result);
    if (!saved.writeConfirmed && readRevision !== saved.originalRevision) return fail('Редакция существующей ЭТрН изменилась. Результат дополнения не подтверждён. Повторная запись запрещена.');
    const read = await client.downloadAttachment(saved.documentId, title.id, readRevision);
    if (context.readOnly && saved.writeConfirmed && context.verifyPreparedTitle) {
      context.verifyPreparedTitle(result, read.bytes);
    } else {
      verifyConsignmentDraftUpdate(read.bytes, base64Bytes(saved.filledBase64));
      verifyDraftRequestedFields(read.bytes, current().snapshot, saved.documentNumber);
    }
    const finalOrder = await client.readTransportOrder(order.id); validateOrder(finalOrder, context);
    const final = await client.readConsignmentNote(saved.documentId); validateNote(final, finalOrder, context, saved); verifyParties(final, current().snapshot, true);
    if (sabyDocumentWorkflow(final).revision !== readRevision || metadataHash(final) !== metadataHash(result)) return fail('Сведения дополненной ЭТрН изменились во время сверки.');
    await checkAccess();
    if (!current().linkedDraft?.writeConfirmed) await update({ linkedDraft: { ...saved, writeAttempted: current().linkedDraft?.writeAttempted ?? saved.writeAttempted, writeConfirmed: true, confirmedAt: new Date().toISOString() } });
    return final;
  };
  // Neither a lost response nor an already signed document can authorize another write.
  if (context.readOnly || saved.writeAttempted || saved.writeConfirmed || saved.beforeHash === saved.filledHash) return verifyReadback();
  await checkAccess();
  remote = await client.readConsignmentNote(saved.documentId); validateNote(remote, remoteOrder, context, saved); validateMutable(remote);
  verifyDraftRequestedFields(base64Bytes(saved.filledBase64), current().snapshot, saved.documentNumber);
  if (metadataHash(remote) !== saved.originalMetadataHash || revision(remote) !== saved.originalRevision) return fail('Сведения исходной ЭТрН изменились до дополнения. Автоматическая запись остановлена.');
  const request = updateRequest(remote, saved, current().snapshot);
  const response = await dispatchLinkedDraftUpdate(client, request, saved, async () => {
    await checkAccess();
    if (!current().linkedDraft || current().id !== saved.documentId || current().linkedDraft?.documentId !== saved.documentId || current().linkedDraft?.originalRevision !== saved.originalRevision || current().linkedDraft?.writeAttempted || current().linkedDraft?.writeConfirmed || current().linkedDraft?.beforeHash !== saved.beforeHash || current().linkedDraft?.filledHash !== saved.filledHash) return fail('Сохранённое намерение дополнения ЭТрН изменилось. Повторная запись запрещена.');
    const latestOrder = await client.readTransportOrder(order.id); validateOrder(latestOrder, context);
    const latest = await client.readConsignmentNote(saved.documentId); validateNote(latest, latestOrder, context, saved); validateMutable(latest);
    if (metadataHash(latest) !== saved.originalMetadataHash || revision(latest) !== saved.originalRevision) return fail('Сведения исходной ЭТрН изменились перед отправкой. Автоматическая запись остановлена.');
    const before = await client.downloadAttachment(saved.documentId, saved.attachmentId, saved.originalRevision);
    if (before.name !== saved.attachmentName || digest(before.bytes) !== saved.beforeHash) return fail('Исходный XML ЭТрН изменился перед отправкой. Автоматическая запись остановлена.');
    const finalOrder = await client.readTransportOrder(order.id); validateOrder(finalOrder, context);
    const final = await client.readConsignmentNote(saved.documentId); validateNote(final, finalOrder, context, saved); validateMutable(final);
    if (metadataHash(final) !== saved.originalMetadataHash) return fail('Сведения исходной ЭТрН изменились во время последней сверки. Автоматическая запись остановлена.');
    verifyDraftRequestedFields(base64Bytes(saved.filledBase64), current().snapshot, saved.documentNumber);
    await checkAccess();
    assertLinkedDraftUpdateAddressing(request, { documentId: current().id ?? '', originalRevision: current().linkedDraft?.originalRevision ?? '' });
    await update({ linkedDraft: { ...saved, writeAttempted: true } });
  });
  const acknowledged = sabyObject(response) && sabyObject(response.Документ) ? response.Документ : response;
  if (!sabyObject(acknowledged) || acknowledged.Идентификатор !== saved.documentId) return fail('Saby не подтвердил прежний идентификатор дополненной ЭТрН. Повторная запись запрещена.');
  return verifyReadback();
}

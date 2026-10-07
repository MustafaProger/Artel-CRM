import { createHash } from 'node:crypto';
import { SabyError, sabyObject, sabyText, type SabyClient, type SabyConfig, type SabyObject, type SabyOrganization } from './saby-client';
import { sabyOrderStateCode } from './trip-saby-progress';

/** Server-only protocol. No function here grants permission to start a signing chain. */
export type SabySigningSide = 'sender' | 'carrier';
export type SabySigningKeyType = 'Отложенный' | 'ОтложенныйСПодтверждением';
export interface SabySigningCertificate {
  thumbprint: string; organizationInn: string; organizationKpp: string; qualified: boolean; valid: boolean;
  notBefore: string; notAfter: string; type: string; ownerName: string;
}
export interface SabySigningBinding {
  side: SabySigningSide; documentId: string; revision: string; stageId: string; stageName: string; actionName: string;
  certificateThumbprint: string; organizationInn: string; organizationKpp: string; counterpartyInn: string; counterpartyKpp: string;
  attachmentSubtype: '1110361' | '1110362'; attachmentId: string;
  /** Omitted only by legacy records; they retain owner confirmation. */
  keyType?: SabySigningKeyType;
}
export interface SabySigningAttachment { id: string; name: string; subtype: string; sha256: string }
export interface SabySigningManifest { binding: SabySigningBinding; attachments: SabySigningAttachment[]; preparedHash: string }
export interface SabyPreparedSigning extends SabySigningManifest { attachments: Array<SabySigningAttachment & { bytes: Uint8Array }> }
export interface SabySigningEvidence { state: 'confirmed' | 'pending' | 'unconfirmed' | 'changed'; reason: string; signatureThumbprints: string[] }
export const SIGNING_STAGE_UNAVAILABLE = 'Saby не вернул единственный доступный этап и титул для подписания.';
const rows = (value: unknown): SabyObject[] => Array.isArray(value) ? value.filter(sabyObject) : sabyObject(value) ? [value] : [];
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const thumbprint = (value: unknown) => {
  const result = sabyText(value)?.replace(/\s|:/g, '').toLowerCase();
  return result && /^[a-f0-9]{40,128}$/.test(result) ? result : null;
};
const safeIdentifier = (value: unknown): value is string => typeof value === 'string' && !!value && value.length <= 256 && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);

/** List/Read use the same documented Certificate + OurCompany envelope. Missing facts stay unknown. */
export function normalizeSigningCertificate(raw: unknown): SabySigningCertificate | null {
  if (!sabyObject(raw) || !sabyObject(raw.Certificate) || !sabyObject(raw.Certificate.CertificateInfo) || !sabyObject(raw.OurCompany)) return null;
  const certificate = raw.Certificate; const info = certificate.CertificateInfo as SabyObject;
  const subject = sabyObject(info.SubjectName) ? info.SubjectName : {};
  const inn = sabyText(subject['1.2.643.100.4']);
  const fp = thumbprint(info.Thumbprint); const kpp = sabyText(raw.OurCompany.Kpp);
  if (!fp || !inn || !/^\d{10}$/.test(inn) || raw.OurCompany.Inn !== inn || !kpp || !/^\d{9}$/.test(kpp)) return null;
  return { thumbprint: fp, organizationInn: inn, organizationKpp: kpp, qualified: info.IsQualified === true, valid: info.IsValid === true,
    notBefore: sabyText(info.NotBefore) ?? '', notAfter: sabyText(info.NotAfter) ?? '', type: sabyText(certificate.Type) ?? '',
    ownerName: [sabyText(subject['2.5.4.4']), sabyText(subject['2.5.4.42'])].filter(Boolean).join(' ') || sabyText(subject['2.5.4.3']) || '' };
}
function certificateDate(value: string): number {
  // Current API returns ISO; accept the API's Russian date representation explicitly, never Date's US interpretation.
  const russian = /^(\d{2})\.(\d{2})\.(\d{4})(?: (\d{2}):(\d{2})(?::(\d{2}))?)?$/.exec(value);
  return Date.parse(russian ? `${russian[3]}-${russian[2]}-${russian[1]}T${russian[4] ?? '00'}:${russian[5] ?? '00'}:${russian[6] ?? '00'}+03:00` : value);
}
export function signingCertificateForOrganization(raw: unknown, organization: Pick<SabyOrganization, 'inn' | 'kpp'>, now = Date.now()): SabySigningCertificate | null {
  const result = normalizeSigningCertificate(raw);
  return result && result.organizationInn === organization.inn && result.organizationKpp === organization.kpp && result.qualified && result.valid &&
    certificateDate(result.notBefore) <= now && certificateDate(result.notAfter) > now ? result : null;
}
function currentRevision(document: SabyObject): string | null {
  const revisions = rows(document.Редакция);
  const active = revisions.filter(row => row.Актуален === 'Да');
  const selected = active.length === 1 ? active[0] : revisions.length === 1 && revisions[0].Актуален !== 'Нет' ? revisions[0] : null;
  return selected ? sabyText(selected.Идентификатор) : null;
}
function currentAttachments(document: SabyObject, revision: string) {
  return rows(document.Вложение).filter(row => row.Удален !== 'Да' && row.Актуален !== 'Нет' &&
    (!row.Редакция || (sabyObject(row.Редакция) ? !row.Редакция.Идентификатор || row.Редакция.Идентификатор === revision : row.Редакция === revision)));
}
function organizationMatches(raw: unknown, inn: string, kpp: string): boolean {
  return sabyObject(raw) && sabyObject(raw.СвЮЛ) && raw.СвЮЛ.ИНН === inn && raw.СвЮЛ.КПП === kpp;
}
function availableStages(document: SabyObject): SabyObject[] {
  // Current-stage rows may be summaries without actions. Resolve their IDs against full Этап records.
  const stages = rows(document.Этап);
  const current = rows(document.ТекущиеЭтапы);
  // A new outgoing draft has no running workflow yet: Saby returns
  // ТекущиеЭтапы: [] and advertises its initial send action in Этап.
  // Only this explicit draft shape may use that action; a nonempty, malformed,
  // or stale current-stage list must never fall back to historical stages.
  if (document.Тип === 'TransportOrder' && document.Направление === 'Исходящий' && sabyOrderStateCode(document) === '0' &&
      Array.isArray(document.ТекущиеЭтапы) && document.ТекущиеЭтапы.length === 0) {
    return stages.filter(stage => stage.Название === 'Отправка' && stage.Служебный !== 'Да' && stage.Завершен !== 'Да' && stage.Актуален !== 'Нет');
  }
  const selected = Object.hasOwn(document, 'ТекущиеЭтапы') ? current.map(stage => {
    const detailed = stages.filter(detail => detail.Идентификатор === stage.Идентификатор);
    return detailed.length === 1 ? detailed[0] : stage;
  }) : stages;
  return selected.filter(stage => stage.Завершен !== 'Да' && stage.Актуален !== 'Нет');
}
export function assertSigningBinding(binding: SabySigningBinding): void {
  if (!binding || !['sender', 'carrier'].includes(binding.side) ||
      (binding.keyType !== undefined && !['Отложенный', 'ОтложенныйСПодтверждением'].includes(binding.keyType)) ||
      ![binding.documentId, binding.revision, binding.stageId, binding.stageName, binding.actionName, binding.attachmentId].every(safeIdentifier) ||
      !thumbprint(binding.certificateThumbprint) || ![binding.organizationInn, binding.counterpartyInn].every(value => /^\d{10}$/.test(value)) ||
      ![binding.organizationKpp, binding.counterpartyKpp].every(value => /^\d{9}$/.test(value)) || binding.organizationInn === binding.counterpartyInn ||
      (binding.side === 'sender' ? binding.attachmentSubtype !== '1110361' || binding.stageName !== 'Отправка' || binding.actionName !== 'Отправить' :
        binding.attachmentSubtype !== '1110362' || binding.stageName !== 'Утверждение' || !['Утвердить', 'Утверждено'].includes(binding.actionName))) {
    throw new SabyError('validation', 'Не удалось однозначно привязать подписание к стороне, заявке и этапу Saby.');
  }
}
function assertDocumentIdentity(document: SabyObject, binding: SabySigningBinding) {
  assertSigningBinding(binding);
  if (document.Идентификатор !== binding.documentId || document.Тип !== 'TransportOrder' || document.Удален === 'Да' || document.ЧастичныеДанные === 'Да' ||
      document.Направление !== (binding.side === 'sender' ? 'Исходящий' : 'Входящий') || currentRevision(document) !== binding.revision ||
      !organizationMatches(document.НашаОрганизация, binding.organizationInn, binding.organizationKpp) || !organizationMatches(document.Контрагент, binding.counterpartyInn, binding.counterpartyKpp)) {
    throw new SabyError('validation', 'Заявка, её редакция или участники изменились. Подписание остановлено.');
  }
  if (hasErrors(document) || ['6', '9', '22'].includes(sabyOrderStateCode(document) ?? '')) throw new SabyError('validation', 'Saby сообщил ошибку, отклонение или отмену заявки. Подписание остановлено.');
  const currentCode = sabyObject(document.Состояние) ? document.Состояние.Код : undefined;
  const legacyCode = sabyObject(document.Код) ? document.Код.Состояние : undefined;
  if (currentCode !== undefined && legacyCode !== undefined && String(currentCode) !== String(legacyCode)) throw new SabyError('validation', 'Saby вернул противоречащие состояния заявки. Подписание остановлено.');
}
function assertCurrentAction(document: SabyObject, binding: SabySigningBinding) {
  if (sabyOrderStateCode(document) !== (binding.side === 'sender' ? '0' : '10')) throw new SabyError('validation', 'Заявка уже обрабатывается или вышла из этапа подписания. Новое действие остановлено.');
  const stages = availableStages(document).filter(stage => stage.Идентификатор === binding.stageId && stage.Название === binding.stageName);
  if (stages.length !== 1 || rows(stages[0].Действие).filter(action => action.Название === binding.actionName).length !== 1) throw new SabyError('validation', 'Этап или действие Saby изменились. Обновите состояние заявки.');
  const action = rows(stages[0].Действие).find(action => action.Название === binding.actionName)!;
  if (['ТребуетКомментария', 'ТребуетИсполнителя', 'ТребуетРасшифровки'].some(field => action[field] === 'Да')) throw new SabyError('validation', 'Saby требует дополнительные сведения для этого действия. Автоматическое подписание остановлено.');
  assertAdvertisedSigningMode(action, binding);
}
function assertAdvertisedSigningMode(action: SabyObject, binding: SabySigningBinding) {
  if (binding.keyType !== 'Отложенный') return;
  const selected = rows(action.Сертификат).filter(certificate => thumbprint(certificate.Отпечаток) === thumbprint(binding.certificateThumbprint));
  if (selected.length !== 1 || !sabyObject(selected[0].Ключ) || selected[0].Ключ.Тип !== 'Отложенный' ||
      (selected[0].Ключ.Активирован !== undefined && selected[0].Ключ.Активирован !== 'Да')) {
    throw new SabyError('validation', 'Saby не подтвердил доступность выбранной подписи без подтверждения владельца. Автоматическое подписание остановлено.');
  }
}
function hasErrors(value: SabyObject): boolean {
  return !!value.Ошибка || Number(value.КоличествоОшибок ?? 0) !== 0 || (Array.isArray(value.Ошибки) && value.Ошибки.length > 0);
}
function assertDocument(document: SabyObject, binding: SabySigningBinding, requireAction: boolean) {
  assertDocumentIdentity(document, binding);
  const attachments = currentAttachments(document, binding.revision);
  const title = attachments.filter(row => row.Подтип === binding.attachmentSubtype);
  if (title.length !== 1 || title[0].Идентификатор !== binding.attachmentId || title[0].ВерсияФормата !== '5.01' || title[0].Направление !== 'Исходящий') {
    throw new SabyError('validation', 'Нельзя однозначно подтвердить титул выбранной стороны. Подписание остановлено.');
  }
  if (hasErrors(title[0])) throw new SabyError('validation', 'Saby сообщил ошибку в выбранном титуле. Подписание остановлено.');
  if (requireAction) {
    assertCurrentAction(document, binding);
    if (rows(title[0].Подпись).length) throw new SabyError('validation', 'Выбранный титул уже подписан. Повторное подписание остановлено.');
  }
  return { attachments, title: title[0] };
}
export function createSigningBinding(remote: SabyObject, side: SabySigningSide, certificate: SabySigningCertificate, config: SabyConfig, keyType?: SabySigningKeyType): SabySigningBinding {
  const organization = side === 'sender' ? config.customer : config.carrier;
  const counterparty = side === 'sender' ? config.carrier : config.customer;
  if (certificate.organizationInn !== organization.inn || certificate.organizationKpp !== organization.kpp || !certificate.valid || !certificate.qualified ||
      certificateDate(certificate.notBefore) > Date.now() || !(certificateDate(certificate.notAfter) > Date.now())) throw new SabyError('validation', 'Выбранная подпись не подтверждена для этой организации.');
  const revision = currentRevision(remote); const subtype = side === 'sender' ? '1110361' : '1110362';
  const title = currentAttachments(remote, revision ?? '').filter(row => row.Подтип === subtype);
  const candidates = availableStages(remote).flatMap(stage => rows(stage.Действие).filter(action => side === 'sender' ? stage.Название === 'Отправка' && action.Название === 'Отправить' : stage.Название === 'Утверждение' && ['Утвердить', 'Утверждено'].includes(String(action.Название))).map(action => ({ stage, action })));
  if (!revision || title.length !== 1 || candidates.length !== 1) throw new SabyError('validation', SIGNING_STAGE_UNAVAILABLE);
  const { stage, action } = candidates[0];
  const binding: SabySigningBinding = { side, documentId: String(remote.Идентификатор ?? ''), revision, stageId: String(stage.Идентификатор ?? ''), stageName: String(stage.Название), actionName: String(action.Название),
    certificateThumbprint: certificate.thumbprint, organizationInn: organization.inn, organizationKpp: organization.kpp, counterpartyInn: counterparty.inn, counterpartyKpp: counterparty.kpp,
    attachmentSubtype: subtype, attachmentId: String(title[0].Идентификатор ?? ''), ...(keyType !== undefined ? { keyType } : {}) };
  assertDocument(remote, binding, true); return binding;
}
/** Saby's documented preparation creates the missing reply; this is never a made-up title generator. */
export function createCarrierDraftBinding(remote: SabyObject, certificate: SabySigningCertificate, config: SabyConfig, keyType?: SabySigningKeyType): SabySigningBinding {
  const revision = currentRevision(remote);
  if (!revision || currentAttachments(remote, revision).some(row => row.Подтип === '1110362')) throw new SabyError('validation', 'Ответ НК уже существует или его редакция не подтверждена. Новая подготовка остановлена.');
  const synthetic = structuredClone(remote);
  synthetic.Вложение = [...rows(remote.Вложение), { Идентификатор: 'unprepared-carrier-title', Подтип: '1110362', ВерсияФормата: '5.01', Направление: 'Исходящий' }];
  const binding = createSigningBinding(synthetic, 'carrier', certificate, config, keyType);
  assertCarrierDraftSource(remote, binding); return binding;
}
function assertCarrierDraftSource(remote: SabyObject, binding: SabySigningBinding) {
  assertDocumentIdentity(remote, binding); assertCurrentAction(remote, binding);
  const attachments = currentAttachments(remote, binding.revision);
  const sender = attachments.filter(row => row.Подтип === '1110361' && row.ВерсияФормата === '5.01' && row.Направление === 'Входящий');
  if (binding.side !== 'carrier' || binding.attachmentId !== 'unprepared-carrier-title' || sabyOrderStateCode(remote) !== '10' ||
      attachments.some(row => row.Подтип === '1110362') || sender.length !== 1 || !rows(sender[0].Подпись).some(signature => !hasErrors(signature) && sabyObject(signature.Сертификат) && signature.Сертификат.ИНН === binding.counterpartyInn && thumbprint(signature.Сертификат.Отпечаток))) {
    throw new SabyError('validation', 'Для подготовки ответа НК не подтверждён подписанный исходный титул и текущий этап.');
  }
}
/** Persist a separate draft-preparation intent before calling; a lost response is reconciled by reads only. */
export async function prepareCarrierDraft(client: SabyClient, binding: SabySigningBinding): Promise<SabyObject> {
  assertCarrierDraftSource(await client.readSigningOrder('carrier', binding.documentId), binding);
  await assertCurrentCertificate(client, binding);
  const prepared = await client.prepareSigningAction(binding);
  if (prepared.Идентификатор !== binding.documentId || currentRevision(prepared) !== binding.revision) throw new SabyError('unknown', 'Saby не подтвердил редакцию подготовленного ответа НК.', true);
  const fresh = await client.readSigningOrder('carrier', binding.documentId);
  const titles = currentAttachments(fresh, binding.revision).filter(row => row.Подтип === '1110362');
  if (titles.length !== 1 || !sabyText(titles[0].Идентификатор)) throw new SabyError('unknown', 'Saby ещё не подтвердил созданный ответ НК. Повторная подготовка не выполняется.', true);
  assertDocument(fresh, { ...binding, attachmentId: String(titles[0].Идентификатор) }, true);
  return fresh;
}
export function signingManifestHash(manifest: Pick<SabySigningManifest, 'binding' | 'attachments'>): string {
  const b = manifest.binding;
  const identity = [b.side, b.documentId, b.revision, b.stageId, b.stageName, b.actionName, b.certificateThumbprint, b.organizationInn, b.organizationKpp, b.counterpartyInn, b.counterpartyKpp, b.attachmentSubtype, b.attachmentId];
  // Legacy manifests must retain their original digest. Explicit modes are immutable signed intent.
  if (b.keyType !== undefined) identity.push(b.keyType);
  return hash(JSON.stringify([identity,
    manifest.attachments.map(file => [file.id, file.name, file.subtype, file.sha256]).sort((a, b) => a[0].localeCompare(b[0]))]));
}
export function assertSigningManifest(manifest: SabySigningManifest): void {
  assertSigningBinding(manifest.binding);
  if (!Array.isArray(manifest.attachments) || !manifest.attachments.length || manifest.attachments.length > 100 ||
      new Set(manifest.attachments.map(file => file.id)).size !== manifest.attachments.length ||
      manifest.attachments.some(file => !safeIdentifier(file.id) || !safeIdentifier(file.name) || !/^[a-f0-9]{64}$/.test(file.sha256) || typeof file.subtype !== 'string') ||
      !manifest.attachments.some(file => file.id === manifest.binding.attachmentId && file.subtype === manifest.binding.attachmentSubtype) ||
      manifest.preparedHash !== signingManifestHash(manifest)) throw new SabyError('validation', 'Не подтверждены сохранённые файлы задания на подпись.');
}
/** The provider supports revision addressing instead of document ID. Never send both (latest revision could win). */
export function signingActionRequest(binding: SabySigningBinding, prepared?: SabyPreparedSigning): SabyObject {
  assertSigningBinding(binding);
  if (binding.stageId === 'observed-signed') throw new SabyError('validation', 'Полученная ранее подпись доступна только для проверки, повторное действие запрещено.');
  if (prepared && binding.attachmentId === 'unprepared-carrier-title') throw new SabyError('validation', 'Создание черновика ответа НК не разрешает его подписание.');
  const action = { Название: binding.actionName, Сертификат: { Отпечаток: binding.certificateThumbprint, ...(prepared ? { Ключ: { Тип: binding.keyType ?? 'ОтложенныйСПодтверждением' } } : {}) } };
  if (prepared) {
    assertSigningManifest(prepared);
    if (signingManifestHash({ binding, attachments: prepared.attachments }) !== prepared.preparedHash || prepared.attachments.some(file => !(file.bytes instanceof Uint8Array) || !file.bytes.length || hash(file.bytes) !== file.sha256)) throw new SabyError('validation', 'Подготовленные байты изменились. Выполнение остановлено.');
  }
  return { Документ: { Редакция: { Идентификатор: binding.revision }, Этап: { Идентификатор: binding.stageId, Название: binding.stageName,
    Действие: prepared ? [action] : action,
    ...(prepared ? { Вложение: prepared.attachments.map(file => ({ Идентификатор: file.id, Файл: { Имя: file.name, ДвоичныеДанные: Buffer.from(file.bytes).toString('base64') } })) } : {}) } } };
}
async function assertCurrentCertificate(client: SabyClient, binding: SabySigningBinding) {
  const organization = { inn: binding.organizationInn, kpp: binding.organizationKpp };
  // Read can expose certificate metadata after trust has changed. Membership in the current user's
  // own/trusted list is a separate prerequisite; it still does not prove that the device is online.
  const available = (await client.listSigningCertificates(binding.side)).map(row => signingCertificateForOrganization(row, organization));
  if (!available.some(certificate => certificate?.thumbprint === thumbprint(binding.certificateThumbprint))) throw new SabyError('permission', 'Выбранная подпись больше не доступна текущему пользователю Saby.');
  const raw = await client.readSigningCertificate(binding.side, binding.certificateThumbprint);
  const certificate = signingCertificateForOrganization(raw, organization);
  if (!certificate || certificate.thumbprint !== thumbprint(binding.certificateThumbprint)) throw new SabyError('validation', 'Выбранная подпись сейчас не подтверждена для нужной организации.');
}
/** Caller must durably record its preparation intent BEFORE invoking this mutating helper. */
export async function prepareBoundSigning(client: SabyClient, binding: SabySigningBinding): Promise<SabyPreparedSigning> {
  assertDocument(await client.readSigningOrder(binding.side, binding.documentId), binding, true);
  await assertCurrentCertificate(client, binding);
  const prepared = await client.prepareSigningAction(binding);
  if (prepared.Идентификатор !== binding.documentId || currentRevision(prepared) !== binding.revision) throw new SabyError('unknown', 'Saby подготовил неподтверждённую редакцию. Новая подготовка без сверки запрещена.', true);
  const stages = rows(prepared.Этап).filter(stage => stage.Идентификатор === binding.stageId && stage.Название === binding.stageName);
  if (stages.length !== 1 || rows(stages[0].Действие).filter(action => action.Название === binding.actionName && action.ТребуетПодписания === 'Да').length !== 1) throw new SabyError('unknown', 'Saby не подтвердил точное подписывающее действие. Выполнение остановлено.', true);
  // Prepare uses the certificate to populate signer details; its response is
  // not the current action-capability listing. Require the selected deferred
  // mode from fresh Read below and again immediately before Execute instead.
  const signable = rows(stages[0].Вложение).filter(file => file.ТребуемоеДействие === 'Подписать');
  if (!signable.length || signable.length > 100 || new Set(signable.map(file => file.Идентификатор)).size !== signable.length) throw new SabyError('unknown', 'Saby не вернул однозначный список итоговых файлов для подписи.', true);
  const fresh = await client.readSigningOrder(binding.side, binding.documentId);
  const { attachments: current } = assertDocument(fresh, binding, true);
  const attachments: SabyPreparedSigning['attachments'] = [];
  for (const file of signable) {
    const id = sabyText(file.Идентификатор); const metadata = current.find(row => row.Идентификатор === id);
    if (!id || !metadata) throw new SabyError('unknown', 'Подготовленный файл отсутствует в текущей редакции. Выполнение остановлено.', true);
    const download = await client.downloadPreparedSigningAttachment(binding, prepared, id);
    const actual = await client.downloadSigningAttachment(binding.side, binding.documentId, id, binding.revision);
    if (!download.bytes.length || hash(download.bytes) !== hash(actual.bytes) || download.name !== actual.name) throw new SabyError('unknown', 'Итоговые файлы Saby изменились после подготовки. Выполнение остановлено.', true);
    attachments.push({ id, name: download.name, subtype: sabyText(metadata.Подтип) ?? '', sha256: hash(download.bytes), bytes: download.bytes });
  }
  const result = { binding: structuredClone(binding), attachments, preparedHash: signingManifestHash({ binding, attachments }) };
  assertSigningManifest(result); return result;
}
/** Read-only preflight; never regenerates files or resubmits a lost request. */
export async function verifyPreparedSigning(client: SabyClient, prepared: SabyPreparedSigning): Promise<void> {
  assertSigningManifest(prepared);
  signingActionRequest(prepared.binding, prepared); // Also validate the transient bytes.
  const binding = prepared.binding;
  assertDocument(await client.readSigningOrder(binding.side, binding.documentId), binding, true);
  await assertCurrentCertificate(client, binding);
  for (const file of prepared.attachments) {
    const fresh = await client.downloadSigningAttachment(binding.side, binding.documentId, file.id, binding.revision);
    if (fresh.name !== file.name || hash(fresh.bytes) !== file.sha256) throw new SabyError('validation', 'Файл Saby изменился после подготовки. Подписание остановлено.');
  }
  // A final read catches changes while certificate/file reads were in flight.
  assertDocument(await client.readSigningOrder(binding.side, binding.documentId), binding, true);
}
/** Rehydrate an already verified, definitely unsent manifest; never invoke preparation here. */
export async function restorePreparedSigning(client: SabyClient, manifest: SabySigningManifest): Promise<SabyPreparedSigning> {
  assertSigningManifest(manifest);
  const binding = structuredClone(manifest.binding);
  const attachments: SabyPreparedSigning['attachments'] = [];
  for (const file of manifest.attachments) {
    const fresh = await client.downloadSigningAttachment(binding.side, binding.documentId, file.id, binding.revision);
    if (fresh.name !== file.name || hash(fresh.bytes) !== file.sha256) throw new SabyError('validation', 'Файл Saby изменился после подготовки. Подписание остановлено.');
    attachments.push({ ...file, bytes: fresh.bytes });
  }
  const prepared = { binding, attachments, preparedHash: manifest.preparedHash };
  signingActionRequest(binding, prepared);
  return prepared;
}
/** Capture a pre-existing signature by reading it. The sentinel binding can never be submitted as an action. */
export async function captureSignedTitle(client: SabyClient, side: SabySigningSide, remote: SabyObject, certificate: SabySigningCertificate): Promise<SabySigningManifest> {
  const organization = side === 'sender' ? client.config.customer : client.config.carrier;
  const counterparty = side === 'sender' ? client.config.carrier : client.config.customer;
  const revision = currentRevision(remote); const subtype = side === 'sender' ? '1110361' : '1110362';
  const titles = currentAttachments(remote, revision ?? '').filter(row => row.Подтип === subtype);
  if (!revision || titles.length !== 1 || certificate.organizationInn !== organization.inn || certificate.organizationKpp !== organization.kpp) throw new SabyError('validation', 'Не подтверждены ранее подписанный титул и его сторона.');
  const binding: SabySigningBinding = { side, documentId: String(remote.Идентификатор ?? ''), revision, stageId: 'observed-signed', stageName: side === 'sender' ? 'Отправка' : 'Утверждение', actionName: side === 'sender' ? 'Отправить' : 'Утвердить',
    certificateThumbprint: certificate.thumbprint, organizationInn: organization.inn, organizationKpp: organization.kpp, counterpartyInn: counterparty.inn, counterpartyKpp: counterparty.kpp, attachmentSubtype: subtype, attachmentId: String(titles[0].Идентификатор ?? '') };
  assertDocument(remote, binding, false);
  const downloaded = await client.downloadSigningAttachment(side, binding.documentId, binding.attachmentId, revision);
  const attachments = [{ id: binding.attachmentId, name: downloaded.name, subtype, sha256: hash(downloaded.bytes) }];
  const manifest = { binding, attachments, preparedHash: signingManifestHash({ binding, attachments }) };
  const evidence = await readSigningEvidence(client, manifest);
  if (evidence.state !== 'confirmed') throw new SabyError('validation', evidence.reason);
  return manifest;
}
/** Read-back is evidence reported by Saby, not a claim of independent CMS cryptographic verification. */
export async function readSigningEvidence(client: SabyClient, manifest: SabySigningManifest): Promise<SabySigningEvidence> {
  assertSigningManifest(manifest); const binding = manifest.binding;
  const changed = (reason: string): SabySigningEvidence => ({ state: 'changed', reason, signatureThumbprints: [] });
  const document = await client.readSigningOrder(binding.side, binding.documentId);
  let attachments: SabyObject[];
  try { ({ attachments } = assertDocument(document, binding, false)); }
  catch (error) { if (error instanceof SabyError && error.kind === 'validation') return changed(error.message); throw error; }
  const fingerprints = new Set<string>(); let unsigned = false;
  for (const file of manifest.attachments) {
    const current = attachments.find(row => row.Идентификатор === file.id);
    if (!current || (sabyText(current.Подтип) ?? '') !== file.subtype) return changed('Набор подписываемых файлов изменился. Продолжение остановлено.');
    const download = await client.downloadSigningAttachment(binding.side, binding.documentId, file.id, binding.revision);
    if (download.name !== file.name || hash(download.bytes) !== file.sha256) return changed('Полученные подписанные файлы отличаются от подготовленных. Продолжение остановлено.');
    const signatures = rows(current.Подпись);
    if (!signatures.length) { unsigned = true; continue; }
    let matched = false;
    for (const signature of signatures) {
      if (hasErrors(signature)) return changed('Saby сообщил ошибку проверки подписи. Продолжение остановлено.');
      const certificate = sabyObject(signature.Сертификат) ? signature.Сертификат : {};
      const fp = thumbprint(certificate.Отпечаток);
      // A signature record without the requested fingerprint cannot prove the selected signer's action.
      if (!fp || fp !== thumbprint(binding.certificateThumbprint)) return changed('Saby вернул подпись, не совпадающую с выбранной. Продолжение остановлено.');
      if (sabyText(certificate.ИНН) && certificate.ИНН !== binding.organizationInn) return changed('Подпись принадлежит другой стороне. Продолжение остановлено.');
      const signatureFile = sabyObject(signature.Файл) ? signature.Файл : {};
      if (!sabyText(signatureFile.Ссылка) && !sabyText(signatureFile.ДвоичныеДанные)) { unsigned = true; continue; }
      matched = true; fingerprints.add(fp);
    }
    if (!matched) unsigned = true;
  }
  const code = sabyOrderStateCode(document) ?? '';
  if (unsigned && ['0', '10'].includes(code)) return { state: 'unconfirmed', reason: 'Saby не подтвердил постановку на подписание: заявка остаётся на исходном этапе без подписей всех подготовленных файлов.', signatureThumbprints: [...fingerprints] };
  if (unsigned) return { state: 'pending', reason: code === '23' ? 'Saby поставил заявку в ожидание подписания.' : 'Saby ещё не вернул подписи всех подготовленных файлов.', signatureThumbprints: [...fingerprints] };
  await assertCurrentCertificate(client, binding);
  const complete = binding.side === 'sender' ? ['3', '4', '7'].includes(code) : code === '7';
  return { state: complete ? 'confirmed' : 'pending', reason: complete ? 'Saby подтвердил выбранную подпись и завершение этапа.' : 'Подпись получена; ожидается завершение этапа Saby.', signatureThumbprints: [...fingerprints] };
}

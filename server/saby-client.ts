import { createHash } from 'node:crypto';
import { readSabyTransportProfile, type SabyTransportProfile } from './saby-transport-order';

/** Server-only Saby TMS JSON-RPC transport. See docs/saby-integration.md. */
export type SabyObject = Record<string, unknown>;
export interface SabyOrganization { inn: string; kpp: string; name: string; address: string; phone?: string; edoId?: string }
export interface SabyConsignmentSigner { surname: string; name: string; patronymic: string; position: string }
export interface SabyCarrierResponsible { surname: string; name: string; patronymic: string; phone: string }
export interface SabyConfig {
  login?: string; password?: string; accountNumber?: string; carrierAccountNumber?: string; sessionId?: string;
  customer: SabyOrganization; carrier: SabyOrganization;
  timeoutMs?: number; transportProfile?: SabyTransportProfile; consignmentSigner?: SabyConsignmentSigner;
  carrierResponsible?: SabyCarrierResponsible | null;
}
export const sabyObject = (value: unknown): value is SabyObject => !!value && typeof value === 'object' && !Array.isArray(value);
export const sabyText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
export class SabyError extends Error {
  constructor(readonly kind: 'configuration' | 'authorization' | 'permission' | 'validation' | 'transport' | 'protocol' | 'unknown', message: string, readonly uncertain = false) { super(message); }
}
function carrierResponsibleFromEnv(raw: string | undefined): SabyCarrierResponsible | null | undefined {
  if (raw === undefined) return undefined;
  if (!raw || raw.length > 4000) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!sabyObject(value)) return null;
    const responsible = Object.fromEntries(['surname', 'name', 'patronymic', 'phone'].map(key => [key, sabyText(value[key]) ?? ''])) as unknown as SabyCarrierResponsible;
    if (!responsible.surname || !responsible.name || !responsible.patronymic || [responsible.surname, responsible.name, responsible.patronymic].some(value => value.length > 60 || [...value].some(char => char.charCodeAt(0) < 32)) || !/^\+\d{11,15}$/.test(responsible.phone)) return null;
    return responsible;
  } catch { return null; }
}
function consignmentSignerFromEnv(raw: string | undefined): SabyConsignmentSigner | undefined {
  if (!raw || raw.length > 4000) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    if (!sabyObject(value)) return undefined;
    const signer = Object.fromEntries(['surname', 'name', 'patronymic', 'position'].map(key => [key, sabyText(value[key]) ?? ''])) as unknown as SabyConsignmentSigner;
    if (!signer.surname || !signer.name || !signer.position || Object.values(signer).some(text => text.length > 256 || [...text].some(character => character.charCodeAt(0) < 32))) return undefined;
    return signer;
  } catch { return undefined; }
}
export function sabyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SabyConfig {
  const organization = (prefix: string): SabyOrganization => ({ inn: env[`${prefix}_INN`]?.trim() ?? '', kpp: env[`${prefix}_KPP`]?.trim() ?? '', name: env[`${prefix}_NAME`]?.trim() ?? '', address: env[`${prefix}_ADDRESS`]?.trim() ?? '', phone: env[`${prefix}_PHONE`]?.trim(), edoId: env[`${prefix}_EDO_ID`]?.trim() });
  return { login: env.SABY_LOGIN, password: env.SABY_PASSWORD, accountNumber: env.SABY_ACCOUNT_NUMBER, carrierAccountNumber: env.SABY_CARRIER_ACCOUNT_NUMBER?.trim() || undefined, sessionId: env.SABY_SESSION_ID, customer: organization('SABY_CUSTOMER'), carrier: organization('SABY_CARRIER'), transportProfile: readSabyTransportProfile(env.SABY_TRANSPORT_PROFILE_JSON), consignmentSigner: consignmentSignerFromEnv(env.SABY_CONSIGNMENT_SIGNER_JSON), carrierResponsible: carrierResponsibleFromEnv(env.SABY_CARRIER_RESPONSIBLE_JSON) };
}
const CARRIER_CREDENTIALS_ERROR = 'Для проверки отдельного кабинета перевозчика Saby нужны серверные логин и пароль.';
function separateCarrierAccountNumber(config: SabyConfig): string | null {
  const account = sabyText(config.carrierAccountNumber);
  return account && account !== sabyText(config.accountNumber) ? account : null;
}
export function sabyCredentialBlockers(config: SabyConfig): string[] {
  const blockers = !config.sessionId && !(config.login && config.password && config.accountNumber) ? ['На сервере не настроены доступ к API Saby и номер кабинета.'] : [];
  if (separateCarrierAccountNumber(config) && !(sabyText(config.login) && sabyText(config.password))) blockers.push(CARRIER_CREDENTIALS_ERROR);
  return blockers;
}
export function sabyConfigurationBlockers(config: SabyConfig): string[] {
  const blockers: string[] = sabyCredentialBlockers(config);
  for (const [role, org] of [['заказчика (Артэль)', config.customer], ['перевозчика (НК Артэль)', config.carrier]] as const) {
    if (!/^\d{10}$/.test(org.inn) || !/^\d{9}$/.test(org.kpp) || !org.name || !org.address) blockers.push(`Не настроены подтверждённые реквизиты ${role} в Saby: ИНН, КПП, название и адрес.`);
  }
  if (config.customer.inn && config.customer.inn === config.carrier.inn) blockers.push('Заказчик и перевозчик Saby должны быть настроены как две разные организации.');
  return blockers;
}
const AUTH_URL = 'https://online.sbis.ru/auth/service/';
const DOCUMENT_URL = 'https://tms.saby.ru/service/';
const DIRECTORY_URL = 'https://online.sbis.ru/service/?srv=1';

export type SabyDocumentType = 'TransportOrder' | 'ConsignmentNote';
export interface SabyAttachmentInfo { id: string; name: string; extension: string }
export interface SabyDocumentWorkflow {
  url: string | null; remoteStatus: string | null; revision: string | null;
  signatureStatus: 'not_signed' | 'reported_by_saby' | 'unknown';
  gisStatus: string | null; availableActions: string[]; attachments: SabyAttachmentInfo[];
}
export interface SabyDownloadedAttachment extends SabyAttachmentInfo { bytes: Uint8Array; mimeType: string }
const objects = (value: unknown): SabyObject[] => Array.isArray(value) ? value.filter(sabyObject) : sabyObject(value) ? [value] : [];

/** Only Saby-owned HTTPS origins are accepted, including for session-authenticated downloads. */
export function sabySafeUrl(value: unknown): string | null {
  const text = sabyText(value);
  if (!text || [...text].some(character => character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === '\\')) return null;
  try {
    const url = new URL(text);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return null;
    if (!['saby.ru', 'sbis.ru'].some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`))) return null;
    if ([...url.searchParams.keys()].some(key => /(?:session|password|passwd|login|authorization|access.?token|refresh.?token|api.?key)/i.test(key))) return null;
    return url.href;
  } catch { return null; }
}
function attachmentInfo(attachment: SabyObject): SabyAttachmentInfo | null {
  const id = sabyText(attachment.Идентификатор);
  if (!id) return null;
  const file = sabyObject(attachment.Файл) ? attachment.Файл : {};
  const name = [...(sabyText(file.Имя) ?? sabyText(attachment.Название) ?? 'document')].map(character => character.charCodeAt(0) <= 31 || character.charCodeAt(0) === 127 || character === '/' || character === '\\' ? '_' : character).join('').slice(0, 240);
  const extension = /\.([a-zA-Z0-9]{1,10})$/.exec(name)?.[1].toLowerCase() ?? '';
  return { id, name, extension };
}
interface SabyFileReference extends SabyAttachmentInfo { url: string | null }
// Generated PDF/archive bytes can change when signatures/events arrive without an XML edit.
// Exclude short-lived signed URLs so refreshing links does not manufacture new file versions.
const evidenceHash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
function attachmentEvidence(attachment: SabyObject): unknown {
  const file = sabyObject(attachment.Файл) ? attachment.Файл : {};
  return [attachment.Идентификатор, attachment.Редакция, attachment.Подтип, file.Имя, file.Хеш,
    objects(attachment.Подпись).map(signature => {
      const signedFile = sabyObject(signature.Файл) ? signature.Файл : {};
      const certificate = sabyObject(signature.Сертификат) ? signature.Сертификат : {};
      return [signature.Тип, signature.Направление, signature.ДатаВремя, certificate.Отпечаток, signedFile.Имя, signedFile.Хеш, signedFile.ДвоичныеДанные];
    })];
}
function documentFiles(document: SabyObject): SabyFileReference[] {
  const files: SabyFileReference[] = [];
  const attachments = objects(document.Вложение).filter(row => row.Удален !== 'Да');
  const documentEvidence = [document.Редакция, document.Состояние, document.КодПеревозки, document.ГИС_УИД,
    objects(document.Событие).map(event => [event.Идентификатор, event.ДатаВремя, event.Название]), attachments.map(attachmentEvidence)];
  const representationVersion = evidenceHash(documentEvidence);
  const add = (id: string, name: string, url: unknown) => {
    const safe = sabySafeUrl(url);
    const info = attachmentInfo({ Идентификатор: id, Файл: { Имя: name } });
    if (safe && info) files.push({ ...info, url: safe });
  };
  for (const attachment of attachments) {
    const info = attachmentInfo(attachment);
    if (!info) continue;
    const file = sabyObject(attachment.Файл) ? attachment.Файл : {};
    files.push({ ...info, url: sabySafeUrl(file.Ссылка) });
    objects(attachment.Подпись).forEach((signature, index) => {
      const signatureFile = sabyObject(signature.Файл) ? signature.Файл : {};
      add(`signature:${info.id}:${index}:${evidenceHash(attachmentEvidence(attachment))}`, sabyText(signatureFile.Имя) ?? `${info.name}.${index + 1}.sgn`, signatureFile.Ссылка);
    });
    add(`pdf:${info.id}:${representationVersion}`, `${info.name}.pdf`, attachment.СсылкаНаPDF);
  }
  add(`document:pdf:${representationVersion}`, 'etrn.pdf', document.СсылкаНаPDF);
  add(`document:archive:${representationVersion}`, 'etrn.zip', document.СсылкаНаАрхив);
  return files;
}

/** Evidence returned by Saby, never an assertion of locally verified CMS signatures or participant completion. */
export function sabyDocumentWorkflow(document: SabyObject): SabyDocumentWorkflow {
  const attachments = objects(document.Вложение).filter(row => row.Удален !== 'Да');
  const revisions = objects(document.Редакция);
  const signatureReported = attachments.some(row => objects(row.Подпись).some(signature =>
    (sabyObject(signature.Файл) && (sabyText(signature.Файл.Ссылка) || sabyText(signature.Файл.ДвоичныеДанные))) ||
    (sabyObject(signature.Сертификат) && sabyText(signature.Сертификат.Отпечаток))));
  const expansion = sabyObject(document.Расширение) ? document.Расширение : {};
  const gisId = sabyText(document.ГИС_УИД) ?? sabyText(expansion.ГИС_УИД);
  const phases = objects(document.КодПеревозки).map(row => sabyText(row.НазваниеФазы)).filter((name): name is string => !!name);
  const availableActions = [...new Set([...objects(document.Этап), ...objects(document.ТекущиеЭтапы)].flatMap(stage => objects(stage.Действие).map(action => sabyText(action.Название))).filter((name): name is string => !!name))];
  return {
    url: sabySafeUrl(document.СсылкаДляНашаОрганизация),
    remoteStatus: sabyObject(document.Состояние) ? sabyText(document.Состояние.Название) : null,
    revision: sabyText((revisions.find(row => row.Актуален === 'Да') ?? revisions[0])?.Идентификатор),
    signatureStatus: signatureReported ? 'reported_by_saby' : attachments.length && document.ЧастичныеДанные !== 'Да' ? 'not_signed' : 'unknown',
    gisStatus: gisId ? `Saby вернул идентификатор ГИС ЭПД${phases.length ? `; ${phases.at(-1)}` : ''}` : null,
    availableActions,
    attachments: documentFiles(document).map(({ id, name, extension }) => ({ id, name, extension })),
  };
}

export class SabyClient {
  private session: string | undefined;
  private authenticating?: Promise<string>;
  private carrierClient?: SabyClient;
  private requestId = 0;
  constructor(readonly config: SabyConfig, private readonly send: typeof fetch = fetch) { this.session = config.sessionId; }

  private async request(url: string, method: string, params: SabyObject, session?: string, writing = false): Promise<unknown> {
    let response: Response;
    const id = ++this.requestId;
    try {
      response = await this.send(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs ?? 25_000), headers: { 'Content-Type': 'application/json-rpc; charset=utf-8', ...(session ? { 'X-SBISSessionID': session } : {}) }, body: JSON.stringify({ jsonrpc: '2.0', method, params, id }) });
    } catch { throw new SabyError('transport', writing ? 'Нет подтверждения результата Saby. Перед повтором нужна сверка существующего документа.' : 'Не удалось соединиться с API Saby.', writing); }
    if (response.status === 401) throw new SabyError('authorization', 'Сессия Saby истекла или доступ к кабинету отклонён.');
    if (response.status === 403) throw new SabyError('permission', 'Saby запретил действие. Проверьте права API и доступ к организации.');
    if (!response.ok) throw new SabyError('transport', `API Saby вернул HTTP ${response.status}. ${writing ? 'Результат записи необходимо сверить.' : 'Повторите проверку позже.'}`, writing);
    let body: unknown;
    try { body = await response.json(); } catch { throw new SabyError('protocol', 'Saby вернул ответ без корректного JSON-RPC. Результат не подтверждён.', writing); }
    if (!sabyObject(body) || body.jsonrpc !== '2.0' || body.id !== id) throw new SabyError('protocol', 'Saby вернул несогласованный ответ JSON-RPC. Результат не подтверждён.', writing);
    // Do not return vendor messages/stack traces: they can contain payloads or credentials.
    if (body.error) throw new SabyError('validation', writing ? 'Saby вернул ошибку обработки документа. Перед повтором проверьте созданный черновик и его обязательные поля в Saby.' : 'Saby отклонил запрос. Проверьте авторизацию, тариф API и права организации.', writing);
    if (!Object.hasOwn(body, 'result')) throw new SabyError('protocol', 'В ответе Saby отсутствует результат.', writing);
    return body.result;
  }

  private async authenticate(): Promise<string> {
    if (this.session) return this.session;
    if (!this.config.login || !this.config.password || !this.config.accountNumber) throw new SabyError('configuration', 'На сервере не настроен доступ к API Saby.');
    if (!this.authenticating) this.authenticating = (async () => {
      const result = await this.request(AUTH_URL, 'СБИС.Аутентифицировать', { Параметр: { Логин: this.config.login, Пароль: this.config.password, НомерАккаунта: this.config.accountNumber } });
      const session = sabyText(result);
      if (!session || /[\r\n]/.test(session)) throw new SabyError('authorization', 'Saby не подтвердил авторизацию.');
      this.session = session; return session;
    })().finally(() => { this.authenticating = undefined; });
    return this.authenticating;
  }

  async call(method: string, params: SabyObject, writing = false, directory = false): Promise<unknown> {
    const invoke = async () => this.request(directory ? DIRECTORY_URL : DOCUMENT_URL, method, params, await this.authenticate(), writing);
    try { return await invoke(); }
    catch (error) {
      // A definite HTTP 401 rejects execution. Never retry a timeout/RPC error automatically.
      if (!(error instanceof SabyError) || error.kind !== 'authorization' || !this.config.login || !this.config.password || !this.config.accountNumber) throw error;
      this.session = undefined; return invoke();
    }
  }

  private carrierOrganizationClient(): SabyClient {
    const accountNumber = separateCarrierAccountNumber(this.config);
    if (!accountNumber) return this;
    if (!sabyText(this.config.login) || !sabyText(this.config.password)) throw new SabyError('configuration', CARRIER_CREDENTIALS_ERROR);
    // A session is bound to one account. Never seed the carrier client with the customer's session.
    this.carrierClient ??= new SabyClient({ ...this.config, accountNumber, carrierAccountNumber: undefined, sessionId: undefined }, this.send);
    return this.carrierClient;
  }

  /** Read-only account/role check, performed before any document creation. */
  async verifyOrganizations(customer = this.config.customer, carrier = this.config.carrier): Promise<void> {
    const carrierClient = this.carrierOrganizationClient();
    for (const [role, org, client] of [['заказчика', customer, this], ['перевозчика', carrier, carrierClient]] as const) {
      const result = await client.call('СБИС.СписокНашихОрганизаций', { Фильтр: { НашаОрганизация: { СвЮЛ: { ИНН: org.inn, КПП: org.kpp } }, Навигация: { РазмерСтраницы: '200', Страница: '0' } } }, false, true);
      const rows = sabyObject(result) && Array.isArray(result.НашаОрганизация) ? result.НашаОрганизация : [];
      if (!rows.some(row => sabyObject(row) && sabyObject(row.СвЮЛ) && row.СвЮЛ.ИНН === org.inn && row.СвЮЛ.КПП === org.kpp && row.ДокументооборотПодключен === 'Да')) throw new SabyError('permission', `В текущем кабинете Saby не подтверждены реквизиты, права и ЭДО ${role}.`);
    }
  }

  async readDocument(id: string, additionalFields?: string): Promise<SabyObject> {
    return this.document(await this.call('СБИС.ПрочитатьДокумент', { Документ: { Идентификатор: id, ...(additionalFields ? { ДопПоля: additionalFields } : {}) } }));
  }
  async writeDocument(document: SabyObject): Promise<SabyObject> {
    return this.document(await this.call('СБИС.ЗаписатьДокумент', { Документ: document }, true), true);
  }
  /** Saby assigns a number using the selected registry when both number and XML are absent.
   * Persist its ID before reading or uploading; never reserve again after an uncertain response.
   */
  async reserveNumberedDocument(metadata: SabyObject): Promise<SabyObject> {
    if (!['TransportOrder', 'ConsignmentNote'].includes(String(metadata.Тип)) || Object.hasOwn(metadata, 'Номер') || Object.hasOwn(metadata, 'Вложение') || Object.hasOwn(metadata, 'Идентификатор')) throw new SabyError('validation', 'Некорректный запрос номера документа Saby.');
    return this.writeDocument(metadata);
  }
  async readTransportOrder(id: string): Promise<SabyObject> {
    const document = await this.readDocument(id, 'Расширение,ЭПД,Стороны,ТекущиеЭтапы');
    if (document.Идентификатор !== id || document.Тип !== 'TransportOrder') throw new SabyError('protocol', 'Saby вернул другой документ вместо запрошенной заявки.');
    return document;
  }
  /** Incoming order and its unsent carrier title exist in the carrier's own account. */
  async readCarrierOrder(id: string): Promise<SabyObject> {
    return this.carrierOrganizationClient().readTransportOrder(id);
  }
  async downloadCarrierOrderAttachment(id: string, attachmentId: string, revision: string): Promise<SabyDownloadedAttachment> {
    return this.carrierOrganizationClient().downloadTransportOrderAttachment(id, attachmentId, revision);
  }
  /** Updates only an existing unsigned attachment. This never prepares or executes an action. */
  async writeCarrierAttachment(id: string, revision: string, attachmentId: string, name: string, bytes: Uint8Array): Promise<void> {
    if (![id, revision, attachmentId, name].every(value => typeof value === 'string' && value.trim())) throw new SabyError('validation', 'Не определены документ, редакция или вложение ответа НК.');
    await this.carrierOrganizationClient().call('СБИС.ЗаписатьВложение', { Документ: {
      Идентификатор: id, Редакция: { Идентификатор: revision },
      Вложение: [{ Идентификатор: attachmentId, Файл: { Имя: name, ДвоичныеДанные: Buffer.from(bytes).toString('base64') } }],
    } }, true);
  }
  async readConsignmentNote(id: string): Promise<SabyObject> {
    const document = await this.readDocument(id, 'Расширение,ЭПД,Стороны,ТекущиеЭтапы');
    if (document.Идентификатор !== id || document.Тип !== 'ConsignmentNote') throw new SabyError('protocol', 'Saby вернул другой документ вместо запрошенной ЭТрН.');
    return document;
  }
  async writeConsignmentNote(document: SabyObject): Promise<SabyObject> {
    if (document.Тип !== 'ConsignmentNote') throw new SabyError('validation', 'Для ЭТрН требуется документ ConsignmentNote.');
    return this.writeDocument(document);
  }

  /** Does not activate keys, request SMS, or sign. The legacy list covers server certificates only. */
  async listCertificates(): Promise<SabyObject[]> {
    const result = await this.call('СБИС.СписокСертификатов', { Фильтр: {} }, false, true);
    if (!sabyObject(result) || !Array.isArray(result.Сертификат)) throw new SabyError('protocol', 'Saby вернул некорректный список серверных сертификатов.');
    return result.Сертификат.filter(sabyObject);
  }
  /** Includes registered local qualified certificates and certificates delegated to the current user. */
  async listRegisteredCertificates(): Promise<SabyObject[]> {
    const certificates: SabyObject[] = [];
    for (let page = 0; page < 20; page++) {
      const result = await this.call('sabyCertificate.List', { Parameter: { AddTrustedCertificates: true, PageNumber: page, PageSize: 20 } }, false, true);
      if (!Array.isArray(result)) throw new SabyError('protocol', 'Saby вернул некорректный список зарегистрированных сертификатов.');
      certificates.push(...result.filter(sabyObject));
      if (result.length < 20) return certificates;
    }
    throw new SabyError('protocol', 'Список сертификатов слишком велик для полной проверки.');
  }

  /** Fresh read resolves the file from a document ID, never from a caller-supplied URL. */
  async downloadAttachment(documentId: string, attachmentId: string, expectedRevision?: string | null): Promise<SabyDownloadedAttachment> {
    return this.downloadDocumentAttachment(await this.readConsignmentNote(documentId), attachmentId, expectedRevision);
  }
  async downloadTransportOrderAttachment(documentId: string, attachmentId: string, expectedRevision?: string | null): Promise<SabyDownloadedAttachment> {
    return this.downloadDocumentAttachment(await this.readTransportOrder(documentId), attachmentId, expectedRevision);
  }
  private async downloadDocumentAttachment(document: SabyObject, attachmentId: string, expectedRevision?: string | null): Promise<SabyDownloadedAttachment> {
    if (expectedRevision !== undefined && sabyDocumentWorkflow(document).revision !== expectedRevision) throw new SabyError('validation', 'Редакция документа изменилась. Обновите состояние перед скачиванием.');
    const file = documentFiles(document).find(row => row.id === attachmentId);
    if (!file) throw new SabyError('validation', 'Вложение отсутствует в текущей редакции документа.');
    const { url, ...info } = file;
    if (!url) throw new SabyError('protocol', 'Saby не вернул безопасную ссылку на файл.');
    // These are the documented/observed download hosts, not arbitrary Saby subdomains.
    if (!['disk.saby.ru', 'disk.sbis.ru', 'online.saby.ru', 'online.sbis.ru', 'tms.saby.ru'].includes(new URL(url).hostname)) throw new SabyError('protocol', 'Saby вернул неподдерживаемый адрес скачивания файла.');
    let response: Response;
    try {
      response = await this.send(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs ?? 25_000), headers: { 'X-SBISSessionID': await this.authenticate() } });
    } catch { throw new SabyError('transport', 'Не удалось скачать вложение из Saby.'); }
    if (!response.ok || response.redirected) throw new SabyError('transport', 'Saby не подтвердил скачивание вложения. Обновите статус документа.');
    const maximumBytes = 20 * 1024 * 1024;
    if (Number(response.headers.get('content-length')) > maximumBytes) { await response.body?.cancel(); throw new SabyError('protocol', 'Вложение Saby превышает допустимый размер.'); }
    if (!response.body) throw new SabyError('protocol', 'Saby вернул пустой ответ при скачивании вложения.');
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let total = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        total += part.value.length;
        if (total > maximumBytes) { await reader.cancel(); throw new SabyError('protocol', 'Вложение Saby превышает допустимый размер.'); }
        chunks.push(part.value);
      }
    } catch (error) { if (error instanceof SabyError) throw error; throw new SabyError('transport', 'Загрузка вложения Saby прервана. Повторите скачивание.'); }
    const bytes = new Uint8Array(total); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const mimeType = ({ xml: 'application/xml', pdf: 'application/pdf', zip: 'application/zip', sig: 'application/octet-stream', sgn: 'application/octet-stream' } as Record<string, string>)[info.extension] ?? 'application/octet-stream';
    return { ...info, bytes, mimeType };
  }
  private document(result: unknown, writing = false): SabyObject {
    const doc = sabyObject(result) && sabyObject(result.Документ) ? result.Документ : result;
    if (!sabyObject(doc) || !sabyText(doc.Идентификатор)) throw new SabyError('protocol', 'Saby не вернул идентификатор документа. Результат записи необходимо сверить.', writing);
    return doc;
  }
  async findDocuments(marker: string, date: string, organization = this.config.customer, number?: string, type: SabyDocumentType = 'TransportOrder'): Promise<SabyObject[]> {
    const found: SabyObject[] = [];
    for (let page = 0; page < 20; page++) {
      const result = await this.call('СБИС.СписокДокументов', { Фильтр: { Тип: type, Направление: 'Исходящий', ДатаС: date, ДатаПо: date, ...(number ? { Маска: number } : {}), НашаОрганизация: { СвЮЛ: { ИНН: organization.inn, КПП: organization.kpp } }, Навигация: { РазмерСтраницы: '200', Страница: String(page) } } }, false, true);
      if (!sabyObject(result) || !Array.isArray(result.Документ)) throw new SabyError('protocol', 'Saby вернул некорректный список документов. Повторная запись запрещена.');
      found.push(...result.Документ.filter(sabyObject).filter(doc => doc.Примечание === marker));
      if (!sabyObject(result.Навигация) || result.Навигация.ЕстьЕще !== 'Да') return found;
    }
    throw new SabyError('protocol', 'Список Saby слишком велик для безопасной сверки. Нужна проверка документа в кабинете.');
  }
}

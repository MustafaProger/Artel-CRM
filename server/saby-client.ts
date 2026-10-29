import { createHash } from 'node:crypto';
import { readSabyResponseBody, sabyRequestIntent, sabyResponseDiagnostic, type SabyBeforeDispatch, type SabyRequestIntent, type SabyResponseDiagnostic } from './saby-request-audit';
export { isSabyRequestIntent, isSabyResponseDiagnostic, type SabyBeforeDispatch, type SabyRequestIntent, type SabyResponseDiagnostic } from './saby-request-audit';
import { readSabyTransportProfile, type SabyTransportProfile } from './saby-transport-order';
import { signingActionRequest, verifyPreparedSigning, type SabyPreparedSigning, type SabySigningBinding, type SabySigningSide } from './saby-signing';
import { readAutomaticSigningPolicy, type SabyAutomaticSigningPolicy } from './saby-auto-policy';

/** Server-only Saby TMS JSON-RPC transport. See docs/saby-integration.md. */
export type SabyObject = Record<string, unknown>;
export interface SabyOrganization { inn: string; kpp: string; name: string; address: string; phone?: string; edoId?: string }
export interface SabyConsignmentSigner { surname: string; name: string; patronymic: string; position: string }
export interface SabyCarrierResponsible { surname: string; name: string; patronymic: string; phone: string }
export interface SabyConfig {
  /** Scoped to direct consignment notes; never enables a self-addressed TransportOrder. */
  documentMode?: 'nk-direct-v1';
  login?: string; password?: string; accountNumber?: string; carrierAccountNumber?: string; sessionId?: string;
  customer: SabyOrganization; carrier: SabyOrganization;
  timeoutMs?: number; transportProfile?: SabyTransportProfile; consignmentSigner?: SabyConsignmentSigner;
  nkConsignmentSigner?: SabyConsignmentSigner;
  nkRegulatoryInstructions?: string;
  carrierResponsible?: SabyCarrierResponsible | null;
  automaticSigning?: SabyAutomaticSigningPolicy; automaticSigningError?: string;
}
export const sabyObject = (value: unknown): value is SabyObject => !!value && typeof value === 'object' && !Array.isArray(value);
export const sabyText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
const diagnosticMethods = ['СБИС.Аутентифицировать', 'СБИС.ПрочитатьДокумент', 'СБИС.ЗаписатьДокумент', 'СБИС.ЗаписатьВложение', 'sabyCertificate.Read', 'sabyCertificate.List', 'СБИС.ПодготовитьДействие', 'СБИС.ВыполнитьДействие', 'download_attachment', 'other'] as const;
const diagnosticCategories = ['configuration', 'authorization', 'permission', 'validation', 'transport', 'protocol', 'unknown', 'provider_error', 'carrier_payment_missing', 'access_denied', 'lease_changed'] as const;
export interface SabyFailureDiagnostic {
  method: typeof diagnosticMethods[number]; phase: 'preflight' | 'dispatch' | 'response';
  category: typeof diagnosticCategories[number]; rpcCode?: number; httpStatus?: number;
  formatCode?: '0001.006.406.020';
}
/** Only controlled enums/numbers may be persisted. Provider messages, data and traces stay private. */
export function isSabyFailureDiagnostic(value: unknown): value is SabyFailureDiagnostic {
  return sabyObject(value) && !Object.keys(value).some(key => !['method', 'phase', 'category', 'rpcCode', 'httpStatus', 'formatCode'].includes(key)) &&
    diagnosticMethods.includes(value.method as SabyFailureDiagnostic['method']) && ['preflight', 'dispatch', 'response'].includes(String(value.phase)) &&
    diagnosticCategories.includes(value.category as SabyFailureDiagnostic['category']) &&
    (value.rpcCode === undefined || Number.isSafeInteger(value.rpcCode) && Math.abs(Number(value.rpcCode)) <= 2_147_483_647) &&
    (value.httpStatus === undefined || Number.isInteger(value.httpStatus) && Number(value.httpStatus) >= 100 && Number(value.httpStatus) <= 599) &&
    (value.formatCode === undefined ? value.category !== 'carrier_payment_missing' : value.formatCode === '0001.006.406.020' && value.category === 'carrier_payment_missing');
}
/** Recognize only an audited format-rule literal, never retain surrounding provider text. */
function paymentFormatCode(error: unknown): SabyFailureDiagnostic['formatCode'] {
  let remaining = 128;
  const inspect = (value: unknown, depth: number): boolean => {
    if (--remaining < 0 || depth > 4) return false;
    if (typeof value === 'string') return /(?:^|[^\d.])0001\.006\.406\.020(?:$|[^\d.])/.test(value.slice(0, 65_536));
    if (Array.isArray(value) || sabyObject(value)) return Object.values(value).slice(0, 32).some(child => inspect(child, depth + 1));
    return false;
  };
  return inspect(error, 0) ? '0001.006.406.020' : undefined;
}
export class SabyError extends Error {
  constructor(readonly kind: 'configuration' | 'authorization' | 'permission' | 'validation' | 'transport' | 'protocol' | 'unknown', message: string, readonly uncertain = false, readonly diagnostic?: SabyFailureDiagnostic) { super(message); }
}
/** Server-only audit; public callers still receive the controlled SabyError message. */
export class SabyRequestError extends SabyError {
  constructor(kind: SabyError['kind'], message: string, uncertain: boolean, diagnostic: SabyFailureDiagnostic, readonly request: SabyRequestIntent, readonly response?: SabyResponseDiagnostic) {
    super(kind, message, uncertain, diagnostic);
  }
}
/** Exact bounded signature encoding; Buffer's permissive base64 decoder alone is insufficient. */
export function decodeSabySignatureBase64(value: unknown): Buffer {
  if (typeof value !== 'string' || !value.length || value.length > 28 * 1024 * 1024 || value.length % 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new SabyError('validation', 'Saby вернул некорректные данные подписи исходного титула.');
  const bytes = Buffer.from(value, 'base64');
  if (!bytes.length || bytes.length > 20 * 1024 * 1024 || bytes.toString('base64') !== value) throw new SabyError('validation', 'Saby вернул некорректные данные подписи исходного титула.');
  return bytes;
}
export function sabyFailureDiagnostic(error: unknown, phase: SabyFailureDiagnostic['phase'] = 'preflight', method: SabyFailureDiagnostic['method'] = 'other'): SabyFailureDiagnostic {
  if (error instanceof SabyError && isSabyFailureDiagnostic(error.diagnostic)) return structuredClone(error.diagnostic);
  return { method, phase, category: error instanceof SabyError ? error.kind : 'unknown' };
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
  const automatic = readAutomaticSigningPolicy(env.SABY_AUTO_SIGNING_JSON);
  return { login: env.SABY_LOGIN, password: env.SABY_PASSWORD, accountNumber: env.SABY_ACCOUNT_NUMBER, carrierAccountNumber: env.SABY_CARRIER_ACCOUNT_NUMBER?.trim() || undefined, sessionId: env.SABY_SESSION_ID, customer: organization('SABY_CUSTOMER'), carrier: organization('SABY_CARRIER'), transportProfile: readSabyTransportProfile(env.SABY_TRANSPORT_PROFILE_JSON), consignmentSigner: consignmentSignerFromEnv(env.SABY_CONSIGNMENT_SIGNER_JSON), nkConsignmentSigner: consignmentSignerFromEnv(env.SABY_NK_CONSIGNMENT_SIGNER_JSON), nkRegulatoryInstructions: sabyText(env.SABY_NK_REGULATORY_INSTRUCTIONS) ?? undefined, carrierResponsible: carrierResponsibleFromEnv(env.SABY_CARRIER_RESPONSIBLE_JSON), automaticSigning: automatic.policy, automaticSigningError: automatic.error };
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
  if (config.documentMode === 'nk-direct-v1') {
    if (config.customer.inn !== config.carrier.inn || config.customer.kpp !== config.carrier.kpp || config.customer.edoId !== config.carrier.edoId) blockers.push('Прямая ЭТрН НК требует одну подтверждённую организацию в ролях грузоотправителя и перевозчика.');
  } else if (config.customer.inn && config.customer.inn === config.carrier.inn) blockers.push('Заказчик и перевозчик Saby должны быть настроены как две разные организации.');
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

interface SabySessionState { session?: string; authenticating?: Promise<string> }

export class SabyClient {
  private readonly authentication: SabySessionState;
  private carrierClient?: SabyClient;
  private requestId = 0;
  constructor(readonly config: SabyConfig, private readonly send: typeof fetch = fetch, private readonly beforeRequest?: () => Promise<void>, private readonly runRequest?: <T>(action: () => Promise<T>) => Promise<T>, private readonly sessionPool = new Map<string, SabySessionState>()) {
    const account = config.accountNumber ?? 'configured-session';
    let authentication = sessionPool.get(account);
    if (!authentication) { authentication = { session: config.sessionId }; sessionPool.set(account, authentication); }
    this.authentication = authentication;
  }

  /** Independent wrapper: every HTTP request, including auth/downloads, rechecks the durable lease and user rights. */
  withRequestGuard(checkAccess: () => Promise<void>): SabyClient {
    const guard = async () => { await this.beforeRequest?.(); await checkAccess(); };
    return new SabyClient(this.config, this.send, guard, this.runRequest, this.sessionPool);
  }

  /** One runtime budget and its guarded wrappers share authentication per account. */
  withRequestBudget(runRequest: <T>(action: () => Promise<T>) => Promise<T>): SabyClient {
    return new SabyClient(this.config, this.send, this.beforeRequest, runRequest, this.sessionPool);
  }

  /** Both direct titles run in the verified NK account. Retains guards, budget and account-isolated sessions. */
  forNkDirectEtrn(): SabyClient {
    if (this.config.documentMode === 'nk-direct-v1') return this;
    const accountNumber = sabyText(this.config.carrierAccountNumber) ?? this.config.accountNumber;
    const separate = accountNumber !== this.config.accountNumber;
    return new SabyClient({ ...this.config, documentMode: 'nk-direct-v1',
      accountNumber, carrierAccountNumber: undefined, sessionId: separate ? undefined : this.config.sessionId,
      customer: { ...this.config.carrier }, carrier: { ...this.config.carrier },
      consignmentSigner: this.config.nkConsignmentSigner,
    }, this.send, this.beforeRequest, this.runRequest, this.sessionPool);
  }

  private async request(url: string, method: string, params: SabyObject, session?: string, writing = false, beforeDispatch?: SabyBeforeDispatch): Promise<unknown> {
    const dispatch = () => this.dispatchRequest(url, method, params, session, writing, beforeDispatch);
    // Wait for runtime capacity before checking the lease, writing a dispatch
    // marker or starting the transport timeout. Keep the slot through body read.
    return this.runRequest ? this.runRequest(dispatch) : dispatch();
  }

  private async dispatchRequest(url: string, method: string, params: SabyObject, session?: string, writing = false, beforeDispatch?: SabyBeforeDispatch): Promise<unknown> {
    const id = ++this.requestId;
    const diagnostic = (category: SabyFailureDiagnostic['category'], phase: SabyFailureDiagnostic['phase'], extra: Pick<SabyFailureDiagnostic, 'httpStatus' | 'rpcCode' | 'formatCode'> = {}): SabyFailureDiagnostic => ({ method: diagnosticMethods.includes(method as SabyFailureDiagnostic['method']) ? method as SabyFailureDiagnostic['method'] : 'other', phase, category, ...extra });
    const bodyText = JSON.stringify({ jsonrpc: '2.0', method, params, id });
    // A local access failure occurs before any HTTP and must not become an uncertain transport error.
    await this.beforeRequest?.();
    const intent = sabyRequestIntent(method, id, bodyText);
    // A durable marker failure must never reach fetch. The callback gets only safe evidence.
    await beforeDispatch?.(structuredClone(intent));
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs ?? 25_000);
    try {
      let response: Response;
      try {
        response = await this.send(url, { method: 'POST', redirect: 'error', signal: controller.signal, headers: { 'Content-Type': 'application/json-rpc; charset=utf-8', ...(session ? { 'X-SBISSessionID': session } : {}) }, body: bodyText });
      } catch { throw new SabyRequestError('transport', writing ? 'Нет подтверждения результата Saby. Перед повтором нужна сверка существующего документа.' : 'Не удалось соединиться с API Saby.', writing, diagnostic('transport', 'dispatch'), intent); }
      const read = await readSabyResponseBody(response, controller.signal);
      let body: unknown;
      if (read.bodyState === 'complete') try { body = JSON.parse(read.bytes.toString('utf8')); } catch { /* Bounded fingerprints remain available for non-JSON errors. */ }
      const audit = sabyResponseDiagnostic(intent, response.status, read.bytes, read.bodyState, body, [this.config.login, this.config.password, this.config.sessionId, session]);
      const extra = { httpStatus: response.status, ...(audit.rpcCode === undefined ? {} : { rpcCode: audit.rpcCode }) };
      if (response.status === 401) throw new SabyRequestError('authorization', 'Сессия Saby истекла или доступ к кабинету отклонён.', false, diagnostic('authorization', 'response', extra), intent, audit);
      if (response.status === 403) throw new SabyRequestError('permission', 'Saby запретил действие. Проверьте права API и доступ к организации.', false, diagnostic('permission', 'response', extra), intent, audit);
      // An HTTP error, including a JSON-RPC error/result inside it, never proves a write was rolled back.
      if (!response.ok) throw new SabyRequestError('transport', `API Saby вернул HTTP ${response.status}. ${writing ? 'Результат записи необходимо сверить.' : 'Повторите проверку позже.'}`, writing, diagnostic('transport', 'response', extra), intent, audit);
      if (read.bodyState !== 'complete' || !sabyObject(body)) throw new SabyRequestError('protocol', 'Saby вернул ответ без корректного JSON-RPC. Результат не подтверждён.', writing, diagnostic('protocol', 'response', extra), intent, audit);
      if (body.jsonrpc !== '2.0' || body.id !== id) throw new SabyRequestError('protocol', 'Saby вернул несогласованный ответ JSON-RPC. Результат не подтверждён.', writing, diagnostic('protocol', 'response', extra), intent, audit);
      // Never copy nested vendor data/trace into the public error or the persisted audit.
      if (body.error) {
        const formatCode = paymentFormatCode(body.error);
        // Keep the existing public/signing diagnostic shape stable. The full HTTP
        // status remains available in the separate, durable response audit.
        throw new SabyRequestError('validation', formatCode ? 'Saby сообщил об отсутствии расчёта платы в ответе НК (0001.006.406.020).' : writing ? 'Saby вернул ошибку обработки документа. Перед повтором проверьте созданный черновик и его обязательные поля в Saby.' : 'Saby отклонил запрос. Проверьте авторизацию, тариф API и права организации.', writing, diagnostic(formatCode ? 'carrier_payment_missing' : 'provider_error', 'response', { ...(audit.rpcCode === undefined ? {} : { rpcCode: audit.rpcCode }), ...(formatCode ? { formatCode } : {}) }), intent, audit);
      }
      if (!Object.hasOwn(body, 'result')) throw new SabyRequestError('protocol', 'В ответе Saby отсутствует результат.', writing, diagnostic('protocol', 'response', extra), intent, audit);
      return body.result;
    } finally { clearTimeout(timeout); }
  }

  private async authenticate(): Promise<string> {
    if (this.authentication.session) return this.authentication.session;
    if (!this.config.login || !this.config.password || !this.config.accountNumber) throw new SabyError('configuration', 'На сервере не настроен доступ к API Saby.');
    if (!this.authentication.authenticating) this.authentication.authenticating = (async () => {
      const result = await this.request(AUTH_URL, 'СБИС.Аутентифицировать', { Параметр: { Логин: this.config.login, Пароль: this.config.password, НомерАккаунта: this.config.accountNumber } });
      const session = sabyText(result);
      if (!session || /[\r\n]/.test(session)) throw new SabyError('authorization', 'Saby не подтвердил авторизацию.');
      this.authentication.session = session; return session;
    })().finally(() => { this.authentication.authenticating = undefined; });
    return this.authentication.authenticating;
  }

  async call(method: string, params: SabyObject, writing = false, directory = false, beforeDispatch?: SabyBeforeDispatch): Promise<unknown> {
    let usedSession: string | undefined;
    const invoke = async () => {
      usedSession = await this.authenticate();
      return this.request(directory ? DIRECTORY_URL : DOCUMENT_URL, method, params, usedSession, writing, beforeDispatch);
    };
    try { return await invoke(); }
    catch (error) {
      // A definite HTTP 401 rejects execution. Never retry a timeout/RPC error automatically.
      if (beforeDispatch || !(error instanceof SabyError) || error.kind !== 'authorization' || !this.config.login || !this.config.password || !this.config.accountNumber) throw error;
      // A delayed 401 for the old session must not discard another job's refresh.
      if (this.authentication.session === usedSession) this.authentication.session = undefined;
      return invoke();
    }
  }

  private carrierOrganizationClient(): SabyClient {
    const accountNumber = separateCarrierAccountNumber(this.config);
    if (!accountNumber) return this;
    if (!sabyText(this.config.login) || !sabyText(this.config.password)) throw new SabyError('configuration', CARRIER_CREDENTIALS_ERROR);
    // A session is bound to one account. Never seed the carrier client with the customer's session.
    this.carrierClient ??= new SabyClient({ ...this.config, accountNumber, carrierAccountNumber: undefined, sessionId: undefined }, this.send, this.beforeRequest, this.runRequest, this.sessionPool);
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
  async writeDocument(document: SabyObject, beforeDispatch?: SabyBeforeDispatch): Promise<SabyObject> {
    if (this.config.documentMode === 'nk-direct-v1') {
      if (document.Тип !== 'ConsignmentNote') throw new SabyError('validation', 'В прямом сценарии НК создаётся только ЭТрН без заказа-заявки.');
      if (!sabyText(document.Идентификатор) && !(sabyObject(document.Редакция) && sabyText(document.Редакция.Идентификатор)) && (!Array.isArray(document.Вложение) || !document.Вложение.length)) throw new SabyError('validation', 'Прямая ЭТрН НК требует первого титула. Создание пустого документа не подтверждено протоколом Saby.');
    }
    return this.document(await this.call('СБИС.ЗаписатьДокумент', { Документ: document }, true, false, beforeDispatch), true);
  }
  /** Sender-session update of an existing unsigned title, addressed by revision only.
   * Saby accepts document OR revision identity; document headers must not be resubmitted.
   * The durable dispatch callback also disables the transport's automatic 401 retry.
   */
  async writeTransportOrderAttachment(revision: string, attachmentId: string, name: string, bytes: Uint8Array, beforeDispatch: () => Promise<void>): Promise<void> {
    if (![revision, attachmentId, name].every(value => typeof value === 'string' && value.trim() === value && value.length > 0 && value.length <= 1024 && ![...value].some(char => char.charCodeAt(0) < 32)) || !name.toLowerCase().endsWith('.xml') || /[/\\]/.test(name) || !(bytes instanceof Uint8Array) || !bytes.length || bytes.length > 20 * 1024 * 1024 || typeof beforeDispatch !== 'function') throw new SabyError('validation', 'Не определены редакция, исходное XML-вложение или намерение дозаполнения заявки.');
    await this.call('СБИС.ЗаписатьВложение', { Документ: {
      Редакция: { Идентификатор: revision },
      Вложение: [{ Идентификатор: attachmentId, Файл: { Имя: name, ДвоичныеДанные: Buffer.from(bytes).toString('base64') } }],
    } }, true, false, beforeDispatch);
  }
  /** Historical two-step write used by the ordinary workflow, not a dedicated Saby reservation API.
   * Empty direct ConsignmentNote creation is unsupported here. Preserve existing uncertainty flags.
   */
  async reserveNumberedDocument(metadata: SabyObject): Promise<SabyObject> {
    if (this.config.documentMode === 'nk-direct-v1') throw new SabyError('validation', 'Пустое резервирование прямой ЭТрН НК не подтверждено протоколом Saby и не выполняется.');
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
  async writeConsignmentNote(document: SabyObject, beforeDispatch?: SabyBeforeDispatch): Promise<SabyObject> {
    if (document.Тип !== 'ConsignmentNote') throw new SabyError('validation', 'Для ЭТрН требуется документ ConsignmentNote.');
    return this.writeDocument(document, beforeDispatch);
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
      if (result.some(row => !sabyObject(row))) throw new SabyError('protocol', 'Saby вернул неполные сведения о доступных подписях.');
      certificates.push(...result as SabyObject[]);
      if (result.length < 20) return certificates;
    }
    throw new SabyError('protocol', 'Список сертификатов слишком велик для полной проверки.');
  }

  /** Account selection is server-owned; never pass the sender's session to the carrier. */
  private signingClient(side: SabySigningSide): SabyClient {
    if (side !== 'sender' && side !== 'carrier') throw new SabyError('validation', 'Не определена сторона подписания Saby.');
    return side === 'carrier' ? this.carrierOrganizationClient() : this;
  }
  async listSigningCertificates(side: SabySigningSide): Promise<SabyObject[]> {
    return this.signingClient(side).listRegisteredCertificates();
  }
  async readSigningCertificate(side: SabySigningSide, thumbprint: string): Promise<SabyObject> {
    if (!/^[a-fA-F0-9]{40,128}$/.test(thumbprint)) throw new SabyError('validation', 'Не определена выбранная подпись Saby.');
    const result = await this.signingClient(side).call('sabyCertificate.Read', { Parameter: { CertificateThumbprint: thumbprint } }, false, true);
    if (!sabyObject(result)) throw new SabyError('protocol', 'Saby не вернул сведения о выбранной подписи.');
    return result;
  }
  async readSigningOrder(side: SabySigningSide, id: string): Promise<SabyObject> {
    return this.signingClient(side).readTransportOrder(id);
  }
  async readSigningDocument(side: SabySigningSide, id: string, documentType?: 'ConsignmentNote'): Promise<SabyObject> {
    return documentType === 'ConsignmentNote' ? this.signingClient(side).readConsignmentNote(id) : this.readSigningOrder(side, id);
  }
  async downloadSigningAttachment(side: SabySigningSide, id: string, attachmentId: string, revision: string, documentType?: 'ConsignmentNote'): Promise<SabyDownloadedAttachment> {
    return documentType === 'ConsignmentNote' ? this.signingClient(side).downloadAttachment(id, attachmentId, revision) : this.signingClient(side).downloadTransportOrderAttachment(id, attachmentId, revision);
  }
  /** Fresh exact source-title signature for a linked response, never a caller-supplied URL. */
  async downloadSigningSignature(side: SabySigningSide, id: string, attachmentId: string, revision: string, selectedThumbprint: string, documentType?: 'ConsignmentNote', sourceSubtype: '1110339' | '1110340' = '1110339'): Promise<Uint8Array> {
    if (sourceSubtype === '1110340' && documentType !== 'ConsignmentNote') throw new SabyError('validation', 'Титул перевозчика допустим только для ЭТрН.');
    const fingerprint = (value: unknown) => sabyText(value)?.replace(/\s|:/g, '').toLowerCase();
    const selected = fingerprint(selectedThumbprint);
    if (!selected || !/^[a-f0-9]{40,128}$/.test(selected)) throw new SabyError('validation', 'Не определена выбранная подпись исходного титула.');
    const client = this.signingClient(side);
    const document = documentType === 'ConsignmentNote' ? await client.readConsignmentNote(id) : await client.readTransportOrder(id);
    const revisions = objects(document.Редакция).filter(row => row.Актуален !== 'Нет');
    const titles = objects(document.Вложение).filter(row => row.Идентификатор === attachmentId && row.Удален !== 'Да' && row.Актуален !== 'Нет');
    const invalid = (value: SabyObject) => !!value.Ошибка || Number(value.КоличествоОшибок ?? 0) !== 0 || Array.isArray(value.Ошибки) && value.Ошибки.length > 0;
    if (document.Удален === 'Да' || document.ЧастичныеДанные === 'Да' || invalid(document) || revisions.length !== 1 || revisions[0].Идентификатор !== revision || titles.length !== 1) throw new SabyError('validation', 'Редакция или исходный титул Saby изменились до чтения подписи.');
    const title = titles[0];
    if (title.Подтип !== (documentType === 'ConsignmentNote' ? sourceSubtype : '1110361') || title.ВерсияФормата !== '5.01' || invalid(title) || sabyObject(title.Редакция) && title.Редакция.Идентификатор && title.Редакция.Идентификатор !== revision) throw new SabyError('validation', 'Не подтверждён актуальный исходный титул Saby.');
    const signatures = objects(title.Подпись);
    const matching = signatures.map((signature, index) => ({ signature, index })).filter(({ signature }) => sabyObject(signature.Сертификат) && fingerprint(signature.Сертификат.Отпечаток) === selected);
    if (matching.length !== 1 || invalid(matching[0].signature) || matching[0].signature.Удален === 'Да' || matching[0].signature.Актуален === 'Нет') throw new SabyError('validation', 'Не подтверждена единственная выбранная подпись исходного титула.');
    const { signature, index } = matching[0];
    const file = sabyObject(signature.Файл) ? signature.Файл : {};
    if (file.ДвоичныеДанные !== undefined) return decodeSabySignatureBase64(file.ДвоичныеДанные);
    const downloaded = await client.downloadDocumentAttachment(document, `signature:${attachmentId}:${index}:${evidenceHash(attachmentEvidence(title))}`, revision);
    if (!downloaded.bytes.length) throw new SabyError('validation', 'Saby вернул пустую подпись исходного титула.');
    return downloaded.bytes;
  }
  /** Preparation can regenerate XML, so a lost response is an uncertain write. */
  async prepareSigningAction(binding: SabySigningBinding): Promise<SabyObject> {
    return this.document(await this.signingClient(binding.side).call('СБИС.ПодготовитьДействие', signingActionRequest(binding), true), true);
  }
  /** Only consume links returned by this preparation, and only through the safe download transport. */
  async downloadPreparedSigningAttachment(binding: SabySigningBinding, prepared: SabyObject, attachmentId: string): Promise<SabyDownloadedAttachment> {
    const stages = objects(prepared.Этап).filter(stage => stage.Идентификатор === binding.stageId);
    if (prepared.Идентификатор !== binding.documentId || stages.length !== 1 || sabyDocumentWorkflow(prepared).revision !== binding.revision) throw new SabyError('validation', 'Подготовленные файлы относятся к другому этапу или редакции Saby.');
    return this.signingClient(binding.side).downloadDocumentAttachment({ ...prepared, Вложение: stages[0].Вложение }, attachmentId, binding.revision);
  }
  /** Persist the dispatch intent through the hook after preflight/auth, immediately before HTTP. */
  async executeDeferredSigning(prepared: SabyPreparedSigning, beforeDispatch?: SabyBeforeDispatch): Promise<SabyObject> {
    await verifyPreparedSigning(this, prepared);
    const params = signingActionRequest(prepared.binding, prepared);
    const raw = await this.signingClient(prepared.binding.side).call('СБИС.ВыполнитьДействие', params, true, false, beforeDispatch);
    const result = sabyObject(raw) && sabyObject(raw.Документ) ? raw.Документ : raw;
    if (!sabyObject(result) || result.Идентификатор !== prepared.binding.documentId) throw new SabyError('protocol', 'Saby не подтвердил заявку в ответе на подписание. Результат необходимо сверить.', true, { method: 'СБИС.ВыполнитьДействие', phase: 'response', category: 'protocol' });
    return result;
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
    const session = await this.authenticate();
    const download = async (): Promise<SabyDownloadedAttachment> => {
      let response: Response;
      await this.beforeRequest?.();
      try {
        response = await this.send(url, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(this.config.timeoutMs ?? 25_000), headers: { 'X-SBISSessionID': session } });
      } catch { throw new SabyError('transport', 'Не удалось скачать вложение из Saby.', false, { method: 'download_attachment', phase: 'dispatch', category: 'transport' }); }
      if (!response.ok || response.redirected) {
        await response.body?.cancel().catch(() => undefined);
        throw new SabyError('transport', 'Saby не подтвердил скачивание вложения. Обновите статус документа.', false, { method: 'download_attachment', phase: 'response', category: 'transport', httpStatus: response.status });
      }
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
      } catch (error) { if (error instanceof SabyError) throw error; throw new SabyError('transport', 'Загрузка вложения Saby прервана. Повторите скачивание.', false, { method: 'download_attachment', phase: 'response', category: 'transport' }); }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
      const mimeType = ({ xml: 'application/xml', pdf: 'application/pdf', zip: 'application/zip', sig: 'application/octet-stream', sgn: 'application/octet-stream' } as Record<string, string>)[info.extension] ?? 'application/octet-stream';
      return { ...info, bytes, mimeType };
    };
    return this.runRequest ? this.runRequest(download) : download();
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

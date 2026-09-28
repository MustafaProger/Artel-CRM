import { readSabyTransportProfile, type SabyTransportProfile } from './saby-transport-order';

/** Server-only Saby TMS JSON-RPC transport. See docs/saby-integration.md. */
export type SabyObject = Record<string, unknown>;
export interface SabyOrganization { inn: string; kpp: string; name: string; address: string; phone?: string; edoId?: string }
export interface SabyConfig {
  login?: string; password?: string; accountNumber?: string; sessionId?: string;
  customer: SabyOrganization; carrier: SabyOrganization;
  timeoutMs?: number; transportProfile?: SabyTransportProfile;
}
export const sabyObject = (value: unknown): value is SabyObject => !!value && typeof value === 'object' && !Array.isArray(value);
export const sabyText = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;
export class SabyError extends Error {
  constructor(readonly kind: 'configuration' | 'authorization' | 'permission' | 'validation' | 'transport' | 'protocol' | 'unknown', message: string, readonly uncertain = false) { super(message); }
}
export function sabyConfigFromEnv(env: NodeJS.ProcessEnv = process.env): SabyConfig {
  const organization = (prefix: string): SabyOrganization => ({ inn: env[`${prefix}_INN`]?.trim() ?? '', kpp: env[`${prefix}_KPP`]?.trim() ?? '', name: env[`${prefix}_NAME`]?.trim() ?? '', address: env[`${prefix}_ADDRESS`]?.trim() ?? '', phone: env[`${prefix}_PHONE`]?.trim(), edoId: env[`${prefix}_EDO_ID`]?.trim() });
  return { login: env.SABY_LOGIN, password: env.SABY_PASSWORD, accountNumber: env.SABY_ACCOUNT_NUMBER, sessionId: env.SABY_SESSION_ID, customer: organization('SABY_CUSTOMER'), carrier: organization('SABY_CARRIER'), transportProfile: readSabyTransportProfile(env.SABY_TRANSPORT_PROFILE_JSON) };
}
export function sabyCredentialBlockers(config: SabyConfig): string[] {
  return !config.sessionId && !(config.login && config.password && config.accountNumber) ? ['На сервере не настроены доступ к API Saby и номер кабинета.'] : [];
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

export class SabyClient {
  private session: string | undefined;
  private authenticating?: Promise<string>;
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

  /** Read-only account/role check, performed before any document creation. */
  async verifyOrganizations(customer = this.config.customer, carrier = this.config.carrier): Promise<void> {
    for (const [role, org] of [['заказчика', customer], ['перевозчика', carrier]] as const) {
      const result = await this.call('СБИС.СписокНашихОрганизаций', { Фильтр: { НашаОрганизация: { СвЮЛ: { ИНН: org.inn, КПП: org.kpp } }, Навигация: { РазмерСтраницы: '200', Страница: '0' } } }, false, true);
      const rows = sabyObject(result) && Array.isArray(result.НашаОрганизация) ? result.НашаОрганизация : [];
      if (!rows.some(row => sabyObject(row) && sabyObject(row.СвЮЛ) && row.СвЮЛ.ИНН === org.inn && row.СвЮЛ.КПП === org.kpp && row.ДокументооборотПодключен === 'Да')) throw new SabyError('permission', `В текущем кабинете Saby не подтверждены реквизиты, права и ЭДО ${role}.`);
    }
  }

  async readDocument(id: string): Promise<SabyObject> {
    return this.document(await this.call('СБИС.ПрочитатьДокумент', { Документ: { Идентификатор: id } }));
  }
  async writeDocument(document: SabyObject): Promise<SabyObject> {
    return this.document(await this.call('СБИС.ЗаписатьДокумент', { Документ: document }, true), true);
  }
  private document(result: unknown, writing = false): SabyObject {
    const doc = sabyObject(result) && sabyObject(result.Документ) ? result.Документ : result;
    if (!sabyObject(doc) || !sabyText(doc.Идентификатор)) throw new SabyError('protocol', 'Saby не вернул идентификатор документа. Результат записи необходимо сверить.', writing);
    return doc;
  }
  async findDocuments(marker: string, date: string, organization = this.config.customer, number?: string): Promise<SabyObject[]> {
    const found: SabyObject[] = [];
    for (let page = 0; page < 20; page++) {
      const result = await this.call('СБИС.СписокДокументов', { Фильтр: { Тип: 'TransportOrder', Направление: 'Исходящий', ДатаС: date, ДатаПо: date, Маска: number ?? marker, НашаОрганизация: { СвЮЛ: { ИНН: organization.inn, КПП: organization.kpp } }, Навигация: { РазмерСтраницы: '200', Страница: String(page) } } }, false, true);
      if (!sabyObject(result) || !Array.isArray(result.Документ)) throw new SabyError('protocol', 'Saby вернул некорректный список документов. Повторная запись запрещена.');
      found.push(...result.Документ.filter(sabyObject).filter(doc => doc.Примечание === marker));
      if (!sabyObject(result.Навигация) || result.Навигация.ЕстьЕще !== 'Да') return found;
    }
    throw new SabyError('protocol', 'Список Saby слишком велик для безопасной сверки. Нужна проверка документа в кабинете.');
  }
}

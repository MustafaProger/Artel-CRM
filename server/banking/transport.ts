import { request } from 'node:https';
import { randomUUID, X509Certificate } from 'node:crypto';
import { networkInterfaces } from 'node:os';
import { rootCertificates } from 'node:tls';
import { bankConnections, type BankAccount } from '../../web/src/banking-model';
import { ApiError } from '../api-error';
import { object } from './domain';

export const activeBankConnections = bankConnections.filter(row => row.provider === 'tbank');
export type BankDefinition = typeof activeBankConnections[number];
export interface BankConfig { definition: BankDefinition; accounts: BankAccount[]; missing: string[]; env: Record<string, string | undefined> }
export function bankConfig(definition: BankDefinition, env: Record<string, string | undefined> = process.env): BankConfig {
  const prefix = definition.envPrefix, missing: string[] = [];
  let accounts: BankAccount[] = [];
  try {
    const parsed: unknown = JSON.parse(env[`${prefix}_ACCOUNTS`] ?? '[]');
    if (!Array.isArray(parsed) || parsed.some(a => !/^\d{20}$/.test(object(a).number as string) || !/^(?:[A-Z]{3}|\d{3})$/.test(object(a).currency as string)) || new Set(parsed.map(a => a.number)).size !== parsed.length) throw new Error();
    accounts = parsed.map(a => ({ number: a.number, currency: a.currency }));
  } catch { missing.push('Корректный список счетов и валют на сервере'); }
  if (!accounts.length) missing.push('Расчётные счета и валюты');
  if (!env[`${prefix}_TOKEN`]) missing.push('Токен Т-Бизнеса с правами чтения счетов и операций');
  return { definition, accounts, missing, env };
}

/** Preserve JSON numbers (including large IDs and decimal money) without IEEE-754 conversion. */
export function parseBankJson(raw: string): unknown {
  const quoted = raw.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => token.startsWith('"') ? token : JSON.stringify(token));
  return JSON.parse(quoted);
}
export class BankHttpError extends ApiError {
  constructor(public readonly bankStatus: number, public readonly retryAfterSeconds = bankStatus === 202 ? 60 : 0) {
    super(502, bankStatus === 202 ? 'Банк формирует выписку. Сохранённые операции доступны; повторный запрос запланирован.' : bankStatus === 401 ? 'Банк отклонил авторизацию. Обновите серверные настройки доступа.' : bankStatus === 403 ? 'Банк не разрешил доступ к выписке или счёту. Проверьте согласие и права токена.' : bankStatus === 429 ? 'Достигнут лимит банка. Повторная попытка запланирована.' : bankStatus === 404 ? 'Банк не предоставил выписку или документ за эту дату. Проверьте доступную историю.' : bankStatus === 400 || bankStatus === 422 ? 'Банк отклонил параметры запроса. Проверьте счёт, период и доступ к API.' : 'Банк временно недоступен. Сохранённые операции доступны; загрузка будет повторена.');
  }
  get transient() { return this.bankStatus === 202 || this.bankStatus === 429 || this.bankStatus >= 500 || this.bankStatus === 408; }
}
const tlsCodes = new Set(['SELF_SIGNED_CERT_IN_CHAIN', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'UNABLE_TO_GET_ISSUER_CERT', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'CERT_HAS_EXPIRED', 'CERT_NOT_YET_VALID', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ERR_TLS_CERT_SIGNATURE_ALGORITHM_UNSUPPORTED']);
const networkMessages: Record<string, string> = {
  ENOTFOUND: 'Не удалось определить адрес сервера Т-Банка. Проверьте DNS сервера CRM.',
  EAI_AGAIN: 'DNS сервера Т-Банка временно недоступен. Повторная попытка запланирована.',
  EHOSTUNREACH: 'Сервер Т-Банка недоступен по настроенному сетевому маршруту.',
  ENETUNREACH: 'Сеть Т-Банка недоступна. Проверьте исходящий маршрут сервера CRM.',
  EADDRNOTAVAIL: 'Исходящий адрес Т-Банка недоступен. Проверьте настроенный сетевой интерфейс.',
  ECONNREFUSED: 'Сервер Т-Банка отклонил соединение. Проверьте исходящий доступ по HTTPS.',
  ECONNRESET: 'Соединение с Т-Банком прервано. Повторная попытка запланирована.',
  ETIMEDOUT: 'Т-Банк не ответил за отведённое время. Повторная попытка запланирована.',
};
/** Only allowlisted error codes are surfaced; raw errors may contain credentials or account URLs. */
export class BankTransportError extends BankHttpError {
  constructor(error: unknown) {
    const code = typeof object(error).code === 'string' ? String(object(error).code) : '';
    const tls = tlsCodes.has(code);
    super(tls ? 495 : 503);
    if (tls) this.message = `Не удалось проверить TLS-сертификат Т-Банка (${code}). Проверьте доверенную цепочку сертификатов и время сервера CRM. Сохранённая выписка не изменена.`;
    else if (Object.hasOwn(networkMessages, code)) this.message = `${networkMessages[code]} Сохранённая выписка не изменена.`;
  }
}
export type BankRequest = (config: BankConfig, path: string, token: string) => Promise<unknown>;
/** Extra public CA certificates apply only to this bank connection, never to the global TLS agent. */
export function bankTlsOptions(config: BankConfig): { ca?: string[] } {
  const encoded = config.env[`${config.definition.envPrefix}_TLS_CA_BASE64`]?.trim();
  if (!encoded) return {};
  try {
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error();
    const pem = Buffer.from(encoded, 'base64').toString('utf8');
    const pattern = /-----BEGIN CERTIFICATE-----[\s\S]*?-----END CERTIFICATE-----/g;
    const certificates = pem.match(pattern);
    if (!certificates?.length || pem.replace(pattern, '').trim() || certificates.some(cert => !new X509Certificate(cert).ca)) throw new Error();
    return { ca: [...rootCertificates, ...certificates] };
  } catch { throw new ApiError(503, 'Некорректная доверенная цепочка Т-Банка. Настройте серверную переменную TLS_CA_BASE64 с CA-сертификатами в формате PEM.'); }
}
/** Bind only T-Bank traffic to an explicitly selected local IPv4 interface. */
export function bankNetworkOptions(config: BankConfig, interfaces = networkInterfaces()): { localAddress?: string; family?: 4 } {
  const name = config.env[`${config.definition.envPrefix}_INTERFACE`]?.trim();
  if (!name) return {};
  const entries = Object.hasOwn(interfaces, name) ? interfaces[name] : undefined;
  const address = entries?.find(row => row.family === 'IPv4' && !row.internal)?.address;
  // Never silently fall back to the VPN/default route when the selected network disappears.
  if (!address) throw new ApiError(503, 'Сетевой интерфейс Т-Банка недоступен. Подключите настроенную сеть и повторите запрос.');
  return { localAddress: address, family: 4 };
}
export const bankRequest: BankRequest = async (config, path, token) => {
  if (config.definition.provider !== 'tbank' || !path.startsWith('/openapi/api/')) throw new ApiError(500, 'Недопустимый банковский метод.');
  const url = new URL(path, 'https://business.tbank.ru');
  const network = bankNetworkOptions(config);
  const tls = bankTlsOptions(config);
  const raw = await new Promise<string>((resolve, reject) => {
    const req = request(url, { ...network, ...tls, method: 'GET', minVersion: 'TLSv1.2', rejectUnauthorized: true, headers: { Accept: 'application/json', 'X-Request-Id': randomUUID(), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      const status = res.statusCode ?? 502;
      if (status !== 200) { res.resume(); const retry = res.headers['retry-after']; reject(new BankHttpError(status, Math.min(3600, Math.max(status === 202 ? 60 : 0, Number(retry) || (Date.parse(String(retry)) - Date.now()) / 1000 || 0)))); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 12 * 1024 * 1024) req.destroy(new Error('size')); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', error => reject(new BankTransportError(error)));
    });
    const timer = setTimeout(() => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })), 12000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', error => reject(new BankTransportError(error)));
    req.end();
  });
  try { return parseBankJson(raw); } catch { throw new ApiError(502, 'Неизвестный формат ответа банка. Выписка не изменена.'); }
};

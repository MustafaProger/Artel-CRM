import { request } from 'node:https';
import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { bankConnections, type BankAccount } from '../../web/src/banking-model';
import { ApiError } from '../api-error';
import { object, str } from './domain';

export type BankDefinition = typeof bankConnections[number];
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
  if (definition.provider === 'sber') {
    for (const [key, label] of [['CLIENT_ID','Client ID'],['CLIENT_SECRET','Client secret'],['REFRESH_TOKEN','Первичная авторизация и refresh token'],['TLS_CERT_PATH','TLS-сертификат'],['TLS_KEY_PATH','Закрытый ключ TLS']] as const) {
      if (!env[`${prefix}_${key}`] && !(key.endsWith('_PATH') && env[`${prefix}_${key.replace('_PATH','_BASE64')}`])) missing.push(label);
    }
    if (!/^[a-f\d]{64}$/i.test(env.ARTEL_BANK_ENCRYPTION_KEY ?? '')) missing.push('Серверный ключ шифрования банковских токенов');
  } else if (!env[`${prefix}_TOKEN`]) missing.push('Токен Т-Бизнеса с правами чтения счетов и операций');
  return { definition, accounts, missing, env };
}

/** Preserve JSON numbers (including large IDs and decimal money) without IEEE-754 conversion. */
export function parseBankJson(raw: string): unknown {
  const quoted = raw.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g, token => token.startsWith('"') ? token : JSON.stringify(token));
  return JSON.parse(quoted);
}
export class BankHttpError extends ApiError {
  constructor(public readonly bankStatus: number, public readonly retryAfterSeconds = 0) {
    super(502, bankStatus === 401 ? 'Банк отклонил авторизацию. Обновите серверные настройки доступа.' : bankStatus === 403 ? 'Банк не разрешил доступ к выписке или счёту. Проверьте согласие и права токена.' : bankStatus === 429 ? 'Достигнут лимит банка. Повторная попытка запланирована.' : bankStatus === 404 ? 'Банк не предоставил выписку или документ за эту дату. Проверьте доступную историю.' : bankStatus === 400 || bankStatus === 422 ? 'Банк отклонил параметры запроса. Проверьте счёт, период и доступ к API.' : 'Банк временно недоступен. Сохранённые операции доступны; загрузка будет повторена.');
  }
  get transient() { return this.bankStatus === 429 || this.bankStatus >= 500 || this.bankStatus === 408; }
}
export type BankRequest = (config: BankConfig, path: string, token: string, form?: URLSearchParams) => Promise<unknown>;
export const bankRequest: BankRequest = async (config, path, token, form) => {
  const sber = config.definition.provider === 'sber';
  // No bank-supplied URL is followed; credentials can only go to these official origins.
  if (!path.startsWith(sber ? '/fintech/api/' : '/openapi/api/') && !(sber && path === '/ic/sso/api/v2/oauth/token')) throw new ApiError(500, 'Недопустимый банковский метод.');
  const url = new URL(path, sber ? 'https://fintech.sberbank.ru:9443' : 'https://business.tbank.ru');
  const prefix = config.definition.envPrefix;
  const material = async (key: string) => config.env[`${prefix}_${key}_BASE64`] ? Buffer.from(config.env[`${prefix}_${key}_BASE64`]!, 'base64') : config.env[`${prefix}_${key}_PATH`] ? readFile(config.env[`${prefix}_${key}_PATH`]!) : undefined;
  let cert: Buffer | undefined, key: Buffer | undefined, ca: Buffer | undefined;
  try { if (sber) [cert, key, ca] = await Promise.all([material('TLS_CERT'), material('TLS_KEY'), material('TLS_CA')]); }
  catch { throw new ApiError(503, 'Не удалось прочитать серверные TLS-файлы СберБизнеса.'); }
  const body = form?.toString();
  const raw = await new Promise<string>((resolve, reject) => {
    const req = request(url, { method: form ? 'POST' : 'GET', cert, key, ca, minVersion: 'TLSv1.2', rejectUnauthorized: true, headers: { Accept: 'application/json', 'X-Request-Id': randomUUID(), ...(token ? { Authorization: sber ? token : `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}) } }, res => {
      const status = res.statusCode ?? 502;
      if (status !== 200) { res.resume(); const retry = res.headers['retry-after']; reject(new BankHttpError(status, Math.min(3600, Math.max(0, Number(retry) || (Date.parse(String(retry)) - Date.now()) / 1000 || 0)))); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 12 * 1024 * 1024) req.destroy(new Error('size')); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => reject(new BankHttpError(503)));
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), 12000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(new BankHttpError(503)));
    req.end(body);
  });
  try { return parseBankJson(raw); } catch { throw new ApiError(502, 'Неизвестный формат ответа банка. Выписка не изменена.'); }
};

export function encryptTokens(tokens: unknown, encryptionKey: string, connectionId: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), iv);
  cipher.setAAD(Buffer.from(connectionId));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64');
}
export function decryptTokens(value: string, encryptionKey: string, connectionId: string) {
  try {
    const buffer = Buffer.from(value, 'base64'), decipher = createDecipheriv('aes-256-gcm', Buffer.from(encryptionKey, 'hex'), buffer.subarray(0, 12));
    decipher.setAAD(Buffer.from(connectionId)); decipher.setAuthTag(buffer.subarray(12, 28));
    return object(JSON.parse(Buffer.concat([decipher.update(buffer.subarray(28)), decipher.final()]).toString('utf8')));
  } catch { throw new ApiError(503, 'Не удалось расшифровать банковские токены. Проверьте серверный ключ шифрования.'); }
}
export async function bankToken(config: BankConfig, encrypted: string | undefined, save: (encrypted: string) => Promise<void>, http: BankRequest = bankRequest): Promise<string> {
  if (config.definition.provider === 'tbank') return config.env[`${config.definition.envPrefix}_TOKEN`]!;
  const key = config.env.ARTEL_BANK_ENCRYPTION_KEY!, prefix = config.definition.envPrefix;
  const saved = encrypted ? decryptTokens(encrypted, key, config.definition.id) : {};
  if (str(saved.access_token) && Number(saved.expiresAt) > Date.now() + 60000) return saved.access_token as string;
  const token = object(await http(config, '/ic/sso/api/v2/oauth/token', '', new URLSearchParams({ grant_type: 'refresh_token', client_id: config.env[`${prefix}_CLIENT_ID`]!, client_secret: config.env[`${prefix}_CLIENT_SECRET`]!, refresh_token: str(saved.refresh_token) ?? config.env[`${prefix}_REFRESH_TOKEN`]! })));
  if (!str(token.access_token) || !str(token.refresh_token) || !(Number(token.expires_in) > 0)) throw new ApiError(502, 'СберБизнес не вернул действующую пару токенов.');
  await save(encryptTokens({ access_token: token.access_token, refresh_token: token.refresh_token, expiresAt: Date.now() + Number(token.expires_in) * 1000 }, key, config.definition.id));
  return token.access_token as string;
}

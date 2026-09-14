import { request } from 'node:https';
import { randomUUID } from 'node:crypto';
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
export type BankRequest = (config: BankConfig, path: string, token: string) => Promise<unknown>;
export const bankRequest: BankRequest = async (config, path, token) => {
  if (config.definition.provider !== 'tbank' || !path.startsWith('/openapi/api/')) throw new ApiError(500, 'Недопустимый банковский метод.');
  const url = new URL(path, 'https://business.tbank.ru');
  const raw = await new Promise<string>((resolve, reject) => {
    const req = request(url, { method: 'GET', minVersion: 'TLSv1.2', rejectUnauthorized: true, headers: { Accept: 'application/json', 'X-Request-Id': randomUUID(), ...(token ? { Authorization: `Bearer ${token}` } : {}) } }, res => {
      const status = res.statusCode ?? 502;
      if (status !== 200) { res.resume(); const retry = res.headers['retry-after']; reject(new BankHttpError(status, Math.min(3600, Math.max(status === 202 ? 60 : 0, Number(retry) || (Date.parse(String(retry)) - Date.now()) / 1000 || 0)))); return; }
      const chunks: Buffer[] = []; let size = 0;
      res.on('data', chunk => { size += chunk.length; if (size > 12 * 1024 * 1024) req.destroy(new Error('size')); else chunks.push(chunk); });
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      res.on('error', () => reject(new BankHttpError(503)));
    });
    const timer = setTimeout(() => req.destroy(new Error('timeout')), 12000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', () => reject(new BankHttpError(503)));
    req.end();
  });
  try { return parseBankJson(raw); } catch { throw new ApiError(502, 'Неизвестный формат ответа банка. Выписка не изменена.'); }
};

import { request } from 'node:https';
import { rootCertificates } from 'node:tls';
import { randomUUID } from 'node:crypto';
import { ApiError } from '../api-error';
import { parseBankJson } from './transport';

export interface SberTokens { accessToken: string; refreshToken: string; expiresAt?: number }
export interface SberTokenVault { read(): Promise<SberTokens | undefined>; save(tokens: SberTokens): Promise<void> }
export interface SberRequestOptions { path: string; query?: Record<string, string>; accessToken?: string; form?: Record<string, string> }
export type SberRequest = (env: Record<string, string | undefined>, options: SberRequestOptions, prefix?: string) => Promise<unknown>;
export const SBER_PREFIX = 'ARTEL_BANK_SBER_NK';
const ORIGIN = 'https://fintech.sberbank.ru:9443';
const TOKEN_PATH = '/ic/sso/api/v2/oauth/token';
const READ_PATHS = new Set(['/fintech/api/v2/statement/transactions', '/fintech/api/v2/statement/summary', '/fintech/api/v2/statement/transactionId']);

export function sberMissing(env: Record<string, string | undefined>, hasSavedTokens = false, prefix = SBER_PREFIX): string[] {
  const missing: string[] = [];
  for (const [key, label] of [['CLIENT_ID', 'Идентификатор сервиса'], ['CLIENT_SECRET', 'Секрет сервиса'], ['TLS_PFX_BASE64', 'Клиентский сертификат'], ['TLS_PASSPHRASE', 'Пароль клиентского сертификата'], ['TLS_CA_BASE64', 'Доверенная цепочка сертификатов']] as const) {
    if (!env[`${prefix}_${key}`]) missing.push(label);
  }
  if (!hasSavedTokens && (!env[`${prefix}_ACCESS_TOKEN`] || !env[`${prefix}_REFRESH_TOKEN`])) missing.push('Ключи доступа к выпискам');
  const key = env.ARTEL_BANK_ENCRYPTION_KEY ?? '';
  if (!/^[a-f0-9]{64}$/i.test(key) && !(/^[A-Za-z0-9+/]{43}=$/.test(key) && Buffer.from(key, 'base64').length === 32)) missing.push('Ключ защиты банковского доступа на сервере');
  return missing;
}

/** Only controlled messages are surfaced: Sber error bodies may echo the access token. */
export class SberHttpError extends ApiError {
  constructor(public readonly bankStatus: number, public readonly retryAfterSeconds = 0, public readonly reason?: string) {
    super(502, bankStatus === 401 ? 'Сбер отклонил ключ доступа. Требуется действующая пара ключей.' : bankStatus === 403 ? 'Сбер не разрешил просмотр этого счёта. Проверьте права сервиса и согласие на доступ.' : bankStatus === 429 ? 'Сбер ограничил частоту запросов. Повторите обновление после паузы.' : bankStatus === 404 ? 'Сбер не предоставил данные за выбранную дату. Сохранённая выписка не изменена.' : bankStatus === 400 ? 'Сбер отклонил параметры запроса. Сохранённая выписка не изменена.' : bankStatus === 495 ? 'Не удалось проверить защищённое соединение со Сбером. Проверьте сертификат и доверенную цепочку.' : 'Сбер временно недоступен. Сохранённая выписка остаётся доступной.');
  }
  get transient() { return this.bankStatus === 429 || this.bankStatus === 408 || this.bankStatus >= 500; }
}

export const sberRequest: SberRequest = async (env, options, prefix = SBER_PREFIX) => {
  const refresh = options.path === TOKEN_PATH && !!options.form;
  if ((!refresh && (!READ_PATHS.has(options.path) || options.form)) || (refresh && options.form?.grant_type !== 'refresh_token')) throw new ApiError(500, 'Недопустимый метод Сбера.');
  const url = new URL(options.path, ORIGIN);
  for (const [key, value] of Object.entries(options.query ?? {})) url.searchParams.set(key, value);
  const body = refresh ? new URLSearchParams(options.form).toString() : undefined;
  let pfx: Buffer, ca: string;
  try {
    pfx = Buffer.from(env[`${prefix}_TLS_PFX_BASE64`] ?? '', 'base64');
    ca = Buffer.from(env[`${prefix}_TLS_CA_BASE64`] ?? '', 'base64').toString('utf8');
    if (!pfx.length || !ca.includes('-----BEGIN CERTIFICATE-----')) throw new Error();
  } catch { throw new SberHttpError(495); }
  const raw = await new Promise<string>((resolve, reject) => {
    let req: ReturnType<typeof request>;
    try {
      req = request(url, {
        method: refresh ? 'POST' : 'GET', minVersion: 'TLSv1.2', rejectUnauthorized: true,
        pfx, passphrase: env[`${prefix}_TLS_PASSPHRASE`], ca: [...rootCertificates, ca],
        headers: { Accept: 'application/json', 'X-Request-ID': randomUUID(), ...(options.accessToken ? { Authorization: options.accessToken } : {}), ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) } : {}) },
      }, res => {
        const status = res.statusCode ?? 502;
        if (status !== 200) {
          res.resume();
          const retry = res.headers['retry-after'];
          const seconds = Number(retry) || Math.ceil((Date.parse(String(retry)) - Date.now()) / 1000) || 0;
          reject(new SberHttpError(status, Math.min(3600, Math.max(status === 429 ? 5 : 0, seconds))));
          return;
        }
        const chunks: Buffer[] = []; let size = 0;
        res.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 12 * 1024 * 1024) req.destroy(); else chunks.push(chunk); });
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', () => reject(new SberHttpError(503)));
        res.on('aborted', () => reject(new SberHttpError(503)));
      });
    } catch { reject(new SberHttpError(495)); return; }
    const timer = setTimeout(() => req.destroy(), 12000);
    req.on('close', () => clearTimeout(timer));
    req.on('error', (error: NodeJS.ErrnoException) => reject(new SberHttpError(/CERT|TLS|SSL|SELF_SIGNED|ISSUER/.test(error.code ?? '') ? 495 : 503)));
    req.end(body);
  });
  try { return parseBankJson(raw); } catch { throw new ApiError(502, 'Сбер вернул неизвестный формат данных. Сохранённая выписка не изменена.'); }
};

/** Caller holds the durable connection lease, including during refresh and token persistence. */
export class SberClient {
  private lastRequestAt = 0;
  constructor(private readonly env: Record<string, string | undefined>, private readonly vault: SberTokenVault, private readonly request: SberRequest = sberRequest, private readonly prefix = SBER_PREFIX) {}
  private async call(options: SberRequestOptions) {
    const wait = this.lastRequestAt + 250 - Date.now();
    if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
    this.lastRequestAt = Date.now();
    return this.request(this.env, options, this.prefix);
  }
  private async tokens(): Promise<SberTokens> {
    const saved = await this.vault.read();
    if (saved) return saved;
    const accessToken = this.env[`${this.prefix}_ACCESS_TOKEN`], refreshToken = this.env[`${this.prefix}_REFRESH_TOKEN`];
    if (!accessToken || !refreshToken) throw new ApiError(503, 'На сервере не сохранены ключи доступа Сбера.');
    const expiresAt = Number(this.env[`${this.prefix}_ACCESS_TOKEN_EXPIRES_AT`]);
    const tokens: SberTokens = { accessToken, refreshToken, ...(Number.isFinite(expiresAt) && expiresAt > 0 ? { expiresAt } : {}) };
    await this.vault.save(tokens);
    return tokens;
  }
  private async refresh(tokens: SberTokens) {
    const result = await this.call({ path: TOKEN_PATH, form: { grant_type: 'refresh_token', refresh_token: tokens.refreshToken, client_id: this.env[`${this.prefix}_CLIENT_ID`] ?? '', client_secret: this.env[`${this.prefix}_CLIENT_SECRET`] ?? '' } });
    if (!result || typeof result !== 'object') throw new ApiError(502, 'Сбер не вернул новую пару ключей.');
    const row = result as Record<string, unknown>;
    if (typeof row.access_token !== 'string' || !row.access_token || typeof row.refresh_token !== 'string' || !row.refresh_token) throw new ApiError(502, 'Сбер не вернул новую пару ключей.');
    const lifetime = Number(row.expires_in);
    const next: SberTokens = { accessToken: row.access_token, refreshToken: row.refresh_token, ...(Number.isFinite(lifetime) && lifetime > 0 ? { expiresAt: Date.now() + lifetime * 1000 } : {}) };
    await this.vault.save(next);
    return next;
  }
  async get(path: string, query: Record<string, string>) {
    if (!READ_PATHS.has(path)) throw new ApiError(500, 'Недопустимый метод Сбера.');
    let tokens = await this.tokens();
    // The supplied cabinet token is used first; its expiry is never guessed from a screenshot.
    if (tokens.expiresAt && tokens.expiresAt <= Date.now() + 30000) tokens = await this.refresh(tokens);
    try { return await this.call({ path, query, accessToken: tokens.accessToken }); }
    catch (error) {
      if (!(error instanceof SberHttpError) || error.bankStatus !== 401) throw error;
      tokens = await this.refresh(tokens);
      return this.call({ path, query, accessToken: tokens.accessToken });
    }
  }
}

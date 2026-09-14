import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ApiError } from '../api-error';
import { canManage, requireManage, requireUser, sessionToken } from '../auth';
import type { OperationsData } from '../operations-store';
import { emptyBanking, object, str } from './domain';
import { decryptTokens, encryptTokens, type BankConfig } from './transport';
import type { BankingService } from './service';

export const sberReadScope = 'openid GET_STATEMENT_ACCOUNT inn orgFullName accounts iss aud sub';
export const sberCallbackPath = '/api/banking/oauth/sber/callback';
const cookieName = 'artel_sber_oauth';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const ttl = 10 * 60 * 1000;
const fail = () => new ApiError(400, 'Подключение не подтверждено. Вернитесь в «Платежи» и начните авторизацию заново.');

export class SberOAuthError extends ApiError {
  constructor(readonly reason: string, message: string) { super(400, message); }
}
const rejectToken = (reason: string, message: string): never => { throw new SberOAuthError(reason, message + ' Токены не сохранены.'); };

/** Safe metadata for all checks, so one failed login can diagnose the whole response.
 * No raw tokens, personal identifiers, account numbers, nonce or audience values.
 */
export function sberTokenDiagnostics(token: Record<string, unknown>, config: BankConfig, nonce: string) {
  let claims: Record<string, unknown> = {};
  try { claims = object(JSON.parse(Buffer.from(String(token.id_token).split('.')[1], 'base64url').toString('utf8'))); } catch { /* Format is reported by validation. */ }
  const settings = oauthSettings(config);
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  const accounts = Array.isArray(claims.accounts) ? claims.accounts.map(value => str(object(value).accountNumber)) : [];
  let issuer: string | undefined;
  try {
    const value = str(claims.iss), candidate = new URL(value!);
    // Exact public endpoint, including its path. Do not save arbitrary text/URLs.
    if (value && value.length <= 256 && candidate.protocol === 'https:' && /^(?:[a-z0-9-]+\.)*sberbank\.ru$/.test(candidate.hostname) && !candidate.username && !candidate.password && !candidate.search && !candidate.hash && /^\/[a-zA-Z0-9_./-]*$/.test(candidate.pathname)) issuer = value;
  } catch { /* Missing/malformed issuer is recorded only as a boolean. */ }
  return { ...(issuer ? { issuer } : {}), checks: {
    issuerPresent: typeof claims.iss === 'string' && !!claims.iss,
    issuerMatches: claims.iss === settings.issuer,
    audienceMatches: audiences.length === 1 && String(audiences[0]) === settings.clientId,
    authorizedPartyMatches: claims.azp === undefined || String(claims.azp) === settings.clientId,
    nonceMatches: claims.nonce === nonce,
    subjectPresent: !!str(claims.sub),
    notExpired: Number(claims.exp) * 1000 > Date.now(),
    issuedRecently: Number(claims.iat) * 1000 <= Date.now() + 60000 && Number(claims.iat) * 1000 > Date.now() - ttl,
    companyMatches: String(claims.inn) === settings.inn,
    companyNamePresent: !!str(claims.orgFullName),
    accountsMatch: !!config.accounts.length && config.accounts.every(account => accounts.includes(account.number)),
  } };
}

export function sberOAuthAvailability(config: BankConfig, request: IncomingMessage) {
  try {
    const settings = oauthSettings(config);
    if (request.headers.host !== new URL(settings.redirect).host) return { available: false, message: 'Возврат из Сбера настроен на другой адрес CRM. Для этой версии нужен собственный HTTPS-адрес, зарегистрированный в СберБизнесе. Локальная и опубликованная версии подключаются отдельно.' };
    return { available: true };
  } catch (error) {
    return { available: false, message: error instanceof ApiError ? error.message : 'Настройки подключения недоступны.' };
  }
}

/** Never echo the callback URL, bank response, credentials or arbitrary exception text. */
export function sberOAuthErrorPage(response: ServerResponse, error: unknown) {
  const message = error instanceof ApiError ? error.message : 'Не удалось завершить подключение. Повторите попытку из CRM.';
  const escaped = message.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
  response.writeHead(error instanceof ApiError ? error.status : 500, {
    'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  });
  response.end(`<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Подключение СберБизнеса</title><style>body{font:18px/1.6 system-ui;background:#f5f7f6;color:#24342d;margin:0;padding:24px}main{max-width:620px;margin:12vh auto;background:white;padding:32px;border-radius:20px}h1{font-size:28px;line-height:1.2}a{display:inline-block;background:#216c50;color:white;padding:12px 20px;border-radius:10px;text-decoration:none}</style><main><h1>СберБизнес пока не подключён</h1><p>${escaped}</p><p>Старая ссылка возврата не подходит для повторного входа. Начните новую попытку в том же браузере.</p><a href="/#payments">Вернуться в «Платежи»</a></main></html>`);
}

export function oauthSettings(config: BankConfig) {
  const prefix = config.definition.envPrefix;
  const redirect = config.env[`${prefix}_REDIRECT_URI`];
  const inn = config.env[`${prefix}_EXPECTED_INN`];
  const issuer = config.env[`${prefix}_OAUTH_ISSUER`];
  let url: URL;
  try { url = new URL(redirect!); } catch { throw new ApiError(409, 'Не настроен HTTPS callback СберБизнеса.'); }
  if (url.protocol !== 'https:' || url.pathname !== sberCallbackPath || url.search || url.hash || url.username || url.password || !/^\d{10}(?:\d{2})?$/.test(inn ?? '') || !issuer) throw new ApiError(409, 'Проверьте серверные настройки callback, ИНН и эмитента СберБизнеса.');
  const missing = config.missing.filter(label => label !== 'Первичная авторизация и refresh token');
  if (missing.length) throw new ApiError(409, 'Сначала настройте серверный доступ: ' + missing.join(', ') + '.');
  if (!config.env[`${prefix}_TLS_CA_BASE64`] && !config.env[`${prefix}_TLS_CA_PATH`]) throw new ApiError(409, 'Не настроена доверенная цепочка СберБизнеса.');
  return { redirect: url.href, inn: inn!, issuer: issuer!, key: config.env.ARTEL_BANK_ENCRYPTION_KEY!, clientId: config.env[`${prefix}_CLIENT_ID`]! };
}

function validInitiator(data: OperationsData, sessionHash: string, userId: string) {
  const session = data.accounts?.sessions.find(row => row.hash === sessionHash && row.userId === userId && row.expiresAt > Date.now());
  const user = data.accounts?.users.find(row => row.id === userId && row.active);
  if (!session || !user || !canManage(user)) throw fail();
}

export async function startSberOAuth(service: BankingService, id: string, request: IncomingMessage, response: ServerResponse) {
  const config = service.config(id);
  if (config.definition.provider !== 'sber') throw fail();
  const settings = oauthSettings(config);
  const data = await service.store.read(service.source), user = requireUser(data, request);
  requireManage(user);
  const availability = sberOAuthAvailability(config, request);
  if (!availability.available) throw new ApiError(409, availability.message!);
  if (request.headers.origin !== new URL(settings.redirect).origin) throw fail();
  const state = randomBytes(32).toString('hex'), browser = randomBytes(32).toString('hex');
  const nonce = randomBytes(32).toString('hex'), verifier = randomBytes(48).toString('base64url');
  const sessionHash = hash(sessionToken(request)!);
  const pending = { stateHash: hash(state), browserHash: hash(browser), nonce, verifier, sessionHash, userId: user.id, expiresAt: Date.now() + ttl, redirect: settings.redirect, inn: settings.inn, issuer: settings.issuer, accounts: config.accounts };
  const encrypted = encryptTokens(pending, settings.key, id + ':oauth');
  await service.mutate(data => {
    validInitiator(data, sessionHash, user.id);
    const connection = (data.banking ??= emptyBanking()).connections[id] ??= { accounts: [] };
    if (connection.job || connection.lease && connection.lease.until > Date.now()) throw new ApiError(409, 'Дождитесь завершения синхронизации перед повторной авторизацией.');
    connection.encryptedOAuth = encrypted;
    connection.oauthAttemptHash = hash(state);
    return { result: null, changed: true };
  });
  const url = new URL('https://sbi.sberbank.ru:9443/ic/sso/api/v2/oauth/authorize');
  url.search = new URLSearchParams({ response_type: 'code', client_id: settings.clientId, redirect_uri: settings.redirect, scope: sberReadScope, state, nonce, code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).toString();
  response.setHeader('Set-Cookie', `${cookieName}=${browser}; Path=${sberCallbackPath}; HttpOnly; Secure; SameSite=Lax; Max-Age=600`);
  return { authorizationUrl: url.href };
}

/** Only a direct response from our fixed, verified mTLS Token Endpoint is accepted.
 * OIDC Core 3.1.3.7(6) permits TLS issuer authentication in place of a JWS check
 * for this back-channel response. Browser-supplied ID/access tokens are never accepted.
 * Sber's GOST/CMS signature is not represented as an independently verified JWS.
 */
export function validateSberTokens(token: Record<string, unknown>, config: BankConfig, nonce: string) {
  const settings = oauthSettings(config);
  if (!str(token.access_token) || !str(token.refresh_token) || !(Number(token.expires_in) > 0) || Number(token.expires_in) > 86400 || String(token.token_type).toLowerCase() !== 'bearer') rejectToken('token_response', 'Сбер вернул неполный или неподдерживаемый ответ авторизации.');
  const scopes = (str(token.scope) ?? '').split(/\s+/).filter(Boolean);
  if (!scopes.includes('GET_STATEMENT_ACCOUNT') || scopes.some(scope => !sberReadScope.split(' ').includes(scope))) throw new ApiError(403, 'Банк вернул неподтверждённый набор прав. Токены не сохранены.');
  const parts = str(token.id_token)?.split('.');
  if (!parts || parts.length !== 3 || parts.some(part => !/^[A-Za-z0-9_-]+$/.test(part))) rejectToken('id_token_format', 'Формат подтверждения личности Сбера не поддерживается.');
  let claims: Record<string, unknown>;
  try { claims = object(JSON.parse(Buffer.from(parts![1], 'base64url').toString('utf8'))); } catch { return rejectToken('id_token_format', 'Не удалось прочитать подтверждение личности Сбера.'); }
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!str(claims.iss)) rejectToken('issuer_missing', 'Сбер не передал эмитента токена. Требуется проверить запрошенные поля авторизации.');
  if (claims.iss !== settings.issuer) rejectToken('issuer_mismatch', 'Эмитент токена Сбера не совпадает с настройками CRM. Требуется сверить настройку эмитента на сервере.');
  if (audiences.length !== 1 || String(audiences[0]) !== settings.clientId || claims.azp !== undefined && String(claims.azp) !== settings.clientId) rejectToken('audience_mismatch', 'Подтверждение Сбера выдано для другого сервиса.');
  if (claims.nonce !== nonce) rejectToken('nonce_mismatch', 'Ответ Сбера не соответствует начатой попытке входа.');
  if (!str(claims.sub)) rejectToken('subject_missing', 'Сбер не передал идентификатор пользователя.');
  if (!(Number(claims.exp) * 1000 > Date.now()) || !(Number(claims.iat) * 1000 <= Date.now() + 60000) || !(Number(claims.iat) * 1000 > Date.now() - ttl)) rejectToken('token_expired', 'Истёк срок подтверждения личности Сбера или не совпадает время сервера.');
  if (String(claims.inn) !== settings.inn || !str(claims.orgFullName)) throw new ApiError(403, 'ИНН организации в ответе СберБизнеса не совпадает с подключением.');
  const accounts = Array.isArray(claims.accounts) ? claims.accounts.map(value => str(object(value).accountNumber)) : [];
  if (!config.accounts.length || config.accounts.some(account => !accounts.includes(account.number))) throw new ApiError(403, 'Банк не подтвердил доступ ко всем разрешённым счетам.');
  return { access_token: token.access_token, refresh_token: token.refresh_token, expiresAt: Date.now() + Number(token.expires_in) * 1000, scope: scopes.join(' ') };
}

export async function finishSberOAuth(service: BankingService, request: IncomingMessage, response: ServerResponse, url: URL) {
  if (request.method !== 'GET') throw new ApiError(405, 'Метод не поддерживается.');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Cache-Control', 'no-store');
  const state = url.searchParams.get('state');
  const browserCookies = request.headers.cookie?.split(';').map(item => item.trim()).filter(item => item.startsWith(cookieName + '=')) ?? [];
  const browser = browserCookies[0]?.slice(cookieName.length + 1);
  if (!state || !/^[a-f0-9]{64}$/.test(state) || !browser || !/^[a-f0-9]{64}$/.test(browser) || browserCookies.length !== 1 || url.searchParams.getAll('state').length !== 1 || url.searchParams.getAll('code').length > 1) throw fail();
  const candidates = Object.entries((await service.store.read(service.source)).banking?.connections ?? {}).filter(([, value]) => value.encryptedOAuth);
  let matched: { id: string; encrypted: string; pending: Record<string, unknown> } | undefined;
  for (const [id, connection] of candidates) {
    const settings = oauthSettings(service.config(id));
    const pending = decryptTokens(connection.encryptedOAuth!, settings.key, id + ':oauth');
    if (pending.stateHash === hash(state) && pending.browserHash === hash(browser)) matched = { id, pending, encrypted: connection.encryptedOAuth! };
  }
  if (!matched) throw new SberOAuthError('attempt_missing', 'Эта попытка подключения уже использована или заменена новой. Начните авторизацию заново из «Платежей».');
  const { id, pending, encrypted } = matched, config = service.config(id), settings = oauthSettings(config);
  if (Number(pending.expiresAt) <= Date.now()) throw new SberOAuthError('attempt_expired', 'Истекли 10 минут, отведённые на вход в СберБизнес. Начните авторизацию заново из «Платежей».');
  if (pending.redirect !== settings.redirect || pending.inn !== settings.inn || pending.issuer !== settings.issuer || JSON.stringify(pending.accounts) !== JSON.stringify(config.accounts) || request.headers.host !== new URL(settings.redirect).host) throw fail();
  await service.mutate(data => {
    validInitiator(data, String(pending.sessionHash), String(pending.userId));
    const connection = data.banking!.connections[id];
    if (connection.encryptedOAuth !== encrypted || connection.job || connection.lease && connection.lease.until > Date.now()) throw fail();
    delete connection.encryptedOAuth; // Atomic consume precedes the bank request, including error returns.
    return { result: null, changed: true };
  });
  response.setHeader('Set-Cookie', `${cookieName}=; Path=${sberCallbackPath}; HttpOnly; Secure; SameSite=Lax; Max-Age=0`);
  const code = url.searchParams.get('code');
  if (url.searchParams.has('error') || !code || code.length > 4096) throw fail();
  const token = object(await service.http(config, '/ic/sso/api/v2/oauth/token', '', new URLSearchParams({ grant_type: 'authorization_code', code, client_id: settings.clientId, client_secret: config.env[`${config.definition.envPrefix}_CLIENT_SECRET`]!, redirect_uri: settings.redirect, code_verifier: String(pending.verifier) })));
  let tokens: ReturnType<typeof validateSberTokens>;
  try { tokens = validateSberTokens(token, config, String(pending.nonce)); }
  catch (error) {
    const diagnostics = sberTokenDiagnostics(token, config, String(pending.nonce));
    await service.mutate(data => {
      const connection = data.banking!.connections[id];
      if (connection.oauthAttemptHash !== pending.stateHash) return { result: null, changed: false };
      connection.lastOAuthError = { message: error instanceof ApiError ? error.message : 'Не удалось проверить ответ Сбера.', reason: error instanceof SberOAuthError ? error.reason : 'token_validation', at: new Date().toISOString(), ...diagnostics };
      return { result: null, changed: true };
    });
    throw error;
  }
  await service.mutate(data => {
    validInitiator(data, String(pending.sessionHash), String(pending.userId));
    const connection = data.banking!.connections[id];
    if (connection.oauthAttemptHash !== pending.stateHash || connection.encryptedOAuth || connection.job || connection.lease && connection.lease.until > Date.now()) throw fail();
    connection.encryptedTokens = encryptTokens(tokens, settings.key, id);
    connection.accounts = config.accounts;
    delete connection.lastError;
    delete connection.lastOAuthError;
    return { result: null, changed: true };
  });
  response.writeHead(303, { Location: '/#payments' });
  response.end();
}

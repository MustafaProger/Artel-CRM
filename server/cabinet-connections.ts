import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cabinetProviders, type CabinetAccount, type CabinetConnection, type CabinetProvider, type CabinetResponse } from '../web/src/cabinet-model';
import { GloProClient, GloProError } from './glopro-client';
import { FuelCabinetClient, FuelCabinetError, normalizeCabinetOrganization } from './fuel-cabinet-client';
import { ApiError } from './api-error';
import { requireUser } from './auth';
import { requireSection } from './permissions';
import type { OperationsStorage } from './operations-store';

type Environment = Record<string, string | undefined>;
export interface CabinetStorage { version: 1; connections: Record<string, CabinetConnection & { encryptedCredentials: string }> }
const providerIds = new Set<string>(cabinetProviders.map(provider => provider.id));
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
export function validateCabinets(value: unknown) {
  if (value === undefined) return;
  if (!object(value) || value.version !== 1 || !object(value.connections)) throw new Error('Invalid cabinet storage');
  for (const [id, connection] of Object.entries(value.connections)) {
    if (!/^cabinet-[a-f0-9-]{36}$/.test(id) || !object(connection) || connection.id !== id
      || typeof connection.provider !== 'string' || !providerIds.has(connection.provider)
      || typeof connection.label !== 'string' || !connection.label.trim() || connection.label.length > 120
      || typeof connection.createdAt !== 'string' || !Number.isFinite(Date.parse(connection.createdAt))
      || !['awaiting_setup', 'connected', 'error', 'auth_required'].includes(String(connection.state)) || typeof connection.encryptedCredentials !== 'string'
      || !/^v1\.[A-Za-z0-9+/]{16}\.[A-Za-z0-9+/]{22}==\.[A-Za-z0-9+/]+={0,2}$/.test(connection.encryptedCredentials)
      || Object.keys(connection).some(key => !['id', 'provider', 'label', 'createdAt', 'state', 'encryptedCredentials', 'lastAttemptAt', 'lastSuccessAt', 'error', 'accounts', 'organizationNames'].includes(key))) throw new Error('Invalid cabinet connection');
    for (const key of ['lastAttemptAt', 'lastSuccessAt']) if (connection[key] !== undefined && (typeof connection[key] !== 'string' || !Number.isFinite(Date.parse(connection[key] as string)))) throw new Error('Invalid cabinet time');
    if (connection.error !== undefined && (typeof connection.error !== 'string' || connection.error.length > 300)) throw new Error('Invalid cabinet error');
    if (connection.organizationNames !== undefined && (connection.provider !== 'natcar' || !validOrganizationNames(connection.organizationNames))) throw new Error('Invalid cabinet organizations');
    if (connection.accounts !== undefined) {
      if (!Array.isArray(connection.accounts) || !connection.accounts.length || connection.accounts.length > 200) throw new Error('Invalid cabinet accounts');
      const ids = new Set();
      for (const account of connection.accounts) {
        if (!object(account) || typeof account.id !== 'string' || !(connection.provider === 'glopro' ? /^\d+:\d+$/.test(account.id) : new RegExp(`^${connection.provider}:\\d+$`).test(account.id)) || ids.has(account.id)
            || typeof account.supplier !== 'string' || !account.supplier || account.supplier.length > 300
            || (account.contract !== undefined && (typeof account.contract !== 'string' || !account.contract || account.contract.length > 300))
            || (connection.provider === 'glopro' && !account.contract)
            || ['organization', 'balanceLabel'].some(key => account[key] !== undefined && (typeof account[key] !== 'string' || !account[key] || (account[key] as string).length > 300))
            || !Number.isSafeInteger(account.amountMinor) || account.currency !== 'RUB'
            || (account.sourceUpdatedAt !== undefined && (typeof account.sourceUpdatedAt !== 'string' || !Number.isFinite(Date.parse(account.sourceUpdatedAt))))
            || (connection.provider === 'glopro' && !account.sourceUpdatedAt)
            || (account.details !== undefined && (!Array.isArray(account.details) || account.details.length > 10 || account.details.some(d => !object(d) || typeof d.label !== 'string' || !d.label || d.label.length > 100 || !Number.isSafeInteger(d.amountMinor) || Object.keys(d).some(k => !['label', 'amountMinor'].includes(k)))))
            || Object.keys(account).some(key => !['id', 'supplier', 'contract', 'amountMinor', 'currency', 'sourceUpdatedAt', 'organization', 'balanceLabel', 'details'].includes(key))) throw new Error('Invalid cabinet account');
        ids.add(account.id);
      }
      if (!connection.lastSuccessAt || !['glopro', 'natcar', 'rosneft'].includes(String(connection.provider))) throw new Error('Invalid cabinet snapshot');
    }
    if (connection.state === 'connected' && !connection.accounts) throw new Error('Missing cabinet snapshot');
  }
}
function validOrganizationNames(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.length <= 20 && value.every(n => typeof n === 'string' && n.trim().length > 0 && n.length <= 300 && normalizeCabinetOrganization(n)) && new Set(value.map(normalizeCabinetOrganization)).size === value.length;
}
function encryptionKey(env: Environment) {
  const key = env.ARTEL_CABINET_ENCRYPTION_KEY;
  if (!key || !/^[a-f0-9]{64}$/i.test(key)) throw new ApiError(409, 'Сохранение доступов ещё не настроено на сервере.');
  return Buffer.from(key, 'hex');
}
const aad = (id: string, provider: string) => Buffer.from(`artel:cabinet:${id}:${provider}:v1`);
export function encryptCabinetCredentials(id: string, provider: CabinetProvider, credentials: { login: string; password: string }, env: Environment) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(env), iv);
  cipher.setAAD(aad(id, provider));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(credentials), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}
export function decryptCabinetCredentials(id: string, provider: CabinetProvider, encrypted: string, env: Environment): { login: string; password: string } {
  try {
    const [version, iv, tag, bytes, extra] = encrypted.split('.');
    if (version !== 'v1' || !iv || !tag || !bytes || extra) throw new Error('Invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(env), Buffer.from(iv, 'base64'));
    decipher.setAAD(aad(id, provider)); decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const value: unknown = JSON.parse(Buffer.concat([decipher.update(Buffer.from(bytes, 'base64')), decipher.final()]).toString('utf8'));
    if (!object(value) || typeof value.login !== 'string' || !value.login || typeof value.password !== 'string' || !value.password) throw new Error('Invalid credentials');
    return { login: value.login, password: value.password };
  } catch { throw new ApiError(409, 'Не удалось прочитать сохранённый доступ к кабинету.'); }
}
function publicConnection(connection: CabinetConnection): CabinetConnection {
  return { id: connection.id, provider: connection.provider, label: connection.label, createdAt: connection.createdAt, state: connection.state,
    ...(connection.lastAttemptAt ? { lastAttemptAt: connection.lastAttemptAt } : {}),
    ...(connection.lastSuccessAt ? { lastSuccessAt: connection.lastSuccessAt } : {}),
    ...(connection.error ? { error: connection.error } : {}),
    ...(connection.accounts ? { accounts: connection.accounts } : {}),
    ...(connection.organizationNames ? { organizationNames: connection.organizationNames } : {}) };
}
function inputText(value: unknown, name: string, max: number, trim = true) {
  if (typeof value !== 'string') throw new ApiError(400, `Заполните поле «${name}».`);
  const text = trim ? value.trim() : value;
  if (!text || text.length > max || [...text].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) throw new ApiError(400, `Проверьте поле «${name}».`);
  return text;
}
export async function cabinetRoutes(store: OperationsStorage, source: string, env: Environment, request: IncomingMessage, response: ServerResponse, readBody: () => Promise<Record<string, unknown>>) {
  requireSection(requireUser(await store.read(source), request), 'cabinet-balances');
  const send = (status: number, value: unknown) => { response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
  const path = request.url?.split('?')[0];
  const organizationsId = path?.match(/^\/api\/cabinets\/(cabinet-[a-f0-9-]{36})\/organizations$/)?.[1];
  if (organizationsId) {
    if (request.method !== 'PATCH') throw new ApiError(405, 'Метод не поддерживается.');
    const body = await readBody();
    if (Object.keys(body).some(key => !['organizationNames', 'expectedOrganizationNames'].includes(key))
      || !validOrganizationNames(body.organizationNames) || !validOrganizationNames(body.expectedOrganizationNames)) throw new ApiError(400, 'Укажите наши организации в natcar отдельными строками.');
    const connection = await store.mutate(source, data => {
      requireSection(requireUser(data, request), 'cabinet-balances');
      const row = data.cabinets?.connections[organizationsId];
      if (!row) throw new ApiError(404, 'Кабинет не найден.');
      if (row.provider !== 'natcar') throw new ApiError(409, 'Выбор организаций доступен только для natcar.');
      if (syncRuns.get(store)?.has(organizationsId)) throw new ApiError(409, 'Дождитесь завершения обновления остатков.');
      if (JSON.stringify(row.organizationNames) !== JSON.stringify(body.expectedOrganizationNames)) throw new ApiError(409, 'Состав организаций уже изменён. Обновите страницу и откройте форму заново.');
      if (JSON.stringify(row.organizationNames) === JSON.stringify(body.organizationNames)) return { changed: false, result: publicConnection(row) };
      row.organizationNames = (body.organizationNames as string[]).map(name => name.trim());
      row.state = 'awaiting_setup';
      row.error = 'Состав организаций изменён. Показан предыдущий снимок; обновите остатки.';
      return { changed: true, result: publicConnection(row) };
    });
    return send(200, { connection });
  }
  const syncId = path?.match(/^\/api\/cabinets\/(cabinet-[a-f0-9-]{36})\/sync$/)?.[1];
  if (syncId) {
    if (request.method !== 'POST') throw new ApiError(405, 'Метод не поддерживается.');
    const body = await readBody(); if (Object.keys(body).length) throw new ApiError(400, 'Обновление не принимает дополнительные поля.');
    await syncCabinetConnection(store, source, env, syncId, request);
    const connection = (await store.read(source)).cabinets?.connections[syncId];
    requireSection(requireUser(await store.read(source), request), 'cabinet-balances');
    return send(200, { connection: connection ? publicConnection(connection) : null });
  }
  if (path !== '/api/cabinets') throw new ApiError(404, 'Маршрут кабинетов не найден.');
  if (request.method === 'GET') {
    let ready = false;
    try { encryptionKey(env); ready = true; } catch { /* Read-only page remains available before setup. */ }
    const data = await store.read(source);
    requireSection(requireUser(data, request), 'cabinet-balances');
    const result: CabinetResponse = { connections: Object.values(data.cabinets?.connections ?? {}).map(publicConnection), credentialStorageReady: ready };
    return send(200, result);
  }
  if (request.method !== 'POST') throw new ApiError(405, 'Метод не поддерживается.');
  const body = await readBody();
  if (Object.keys(body).some(key => !['provider', 'label', 'login', 'password', 'organizationNames'].includes(key))) throw new ApiError(400, 'Неизвестное поле подключения.');
  if (typeof body.provider !== 'string' || !providerIds.has(body.provider)) throw new ApiError(400, 'Выберите сервис.');
  const provider = body.provider as CabinetProvider, label = inputText(body.label, 'Название кабинета', 120);
  const login = inputText(body.login, 'Логин', 320), password = inputText(body.password, 'Пароль', 4096, false);
  const organizationNames = body.organizationNames;
  if ((provider === 'natcar' && !validOrganizationNames(organizationNames)) || (provider !== 'natcar' && organizationNames !== undefined)) throw new ApiError(400, 'Укажите наши организации в natcar отдельными строками.');
  const id = `cabinet-${randomUUID()}`;
  const encryptedCredentials = encryptCabinetCredentials(id, provider, { login, password }, env);
  const connection: CabinetConnection = { id, provider, label, createdAt: new Date().toISOString(), state: 'awaiting_setup', ...(provider === 'natcar' ? { organizationNames: organizationNames as string[] } : {}) };
  await store.mutate(source, data => {
    requireSection(requireUser(data, request), 'cabinet-balances');
    const saved = data.cabinets ?? { version: 1 as const, connections: {} };
    if (Object.keys(saved.connections).length >= 100) throw new ApiError(409, 'Достигнут предел сохранённых кабинетов.');
    if (Object.values(saved.connections).some(item => item.provider === provider && item.label.toLocaleLowerCase('ru') === label.toLocaleLowerCase('ru'))) throw new ApiError(409, 'Кабинет с таким названием уже сохранён.');
    saved.connections[id] = { ...connection, encryptedCredentials }; data.cabinets = saved;
    return { result: null, changed: true };
  });
  return send(201, { connection });
}

const syncRuns = new WeakMap<OperationsStorage, Map<string, Promise<void>>>();
const sessions = new WeakMap<OperationsStorage, Map<string, { envelope: string; client: GloProClient | FuelCabinetClient }>>();
export async function syncCabinetConnection(store: OperationsStorage, source: string, env: Environment, id: string, request?: IncomingMessage, clientOverride?: GloProClient | FuelCabinetClient) {
  let runs = syncRuns.get(store); if (!runs) { runs = new Map(); syncRuns.set(store, runs); }
  if (runs.has(id)) throw new ApiError(409, 'Обновление уже выполняется.');
  const operation = (async () => {
    const connection = await store.mutate(source, data => {
      if (request) requireSection(requireUser(data, request), 'cabinet-balances');
      const row = data.cabinets?.connections[id];
      if (!row) throw new ApiError(404, 'Кабинет не найден.');
      if (!['glopro', 'natcar', 'rosneft'].includes(row.provider)) throw new ApiError(409, 'Получение остатков этого сервиса ещё не подключено.');
      if (row.lastAttemptAt && Date.now() - Date.parse(row.lastAttemptAt) < 60_000) throw new ApiError(409, 'Повторное обновление доступно через минуту.');
      row.lastAttemptAt = new Date().toISOString();
      return { changed: true, result: structuredClone(row) };
    });
    let accounts: CabinetAccount[] | undefined, failure: GloProError | FuelCabinetError | undefined;
    try {
      const credentials = decryptCabinetCredentials(id, connection.provider, connection.encryptedCredentials, env);
      let cache = sessions.get(store); if (!cache) { cache = new Map(); sessions.set(store, cache); }
      let session = cache.get(id);
      if (!session || session.envelope !== connection.encryptedCredentials) { session = { envelope: connection.encryptedCredentials, client: connection.provider === 'glopro' ? new GloProClient() : new FuelCabinetClient(connection.provider as 'natcar' | 'rosneft') }; cache.set(id, session); }
      const client = clientOverride ?? session.client;
      accounts = client instanceof FuelCabinetClient ? await client.balances(credentials, connection.organizationNames) : await client.balances(credentials);
    } catch (error) {
      failure = error instanceof GloProError || error instanceof FuelCabinetError ? error : new FuelCabinetError('auth', 'Не удалось прочитать доступ к кабинету. Требуется проверка настройки.');
      if (failure.kind === 'auth') sessions.get(store)?.delete(id);
    }
    await store.mutate(source, data => {
      if (request) requireSection(requireUser(data, request), 'cabinet-balances');
      const row = data.cabinets?.connections[id];
      if (!row || row.encryptedCredentials !== connection.encryptedCredentials || row.lastAttemptAt !== connection.lastAttemptAt || JSON.stringify(row.organizationNames) !== JSON.stringify(connection.organizationNames)) return { changed: false, result: null };
      if (failure) { row.state = failure.kind === 'auth' ? 'auth_required' : 'error'; row.error = failure.message; }
      else { row.accounts = accounts; row.lastSuccessAt = new Date().toISOString(); row.state = 'connected'; delete row.error; }
      return { changed: true, result: null };
    });
  })();
  runs.set(id, operation);
  try { await operation; } finally { runs.delete(id); }
}
export async function refreshDueCabinets(store: OperationsStorage, source: string, env: Environment) {
  const data = await store.read(source);
  let refreshed = 0;
  for (const row of Object.values(data.cabinets?.connections ?? {})) {
    if (!['glopro', 'natcar', 'rosneft'].includes(row.provider) || row.state === 'auth_required' || (row.lastAttemptAt && Date.now() - Date.parse(row.lastAttemptAt) < 300_000)) continue;
    if (refreshed++ >= 4) break; // Bound shutdown time even when many saved cabinets are unavailable.
    try { await syncCabinetConnection(store, source, env, row.id); } catch { /* A competing refresh or revoked access must not stop other cabinets. */ }
  }
}

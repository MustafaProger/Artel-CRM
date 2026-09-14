import { randomUUID, createHash, timingSafeEqual } from 'node:crypto';
import { bankConnections, type BankCard, type BankConnectionState, type BankListResult, type BankOperation } from '../../web/src/banking-model';
import type { OperationsData, OperationsStorage } from '../operations-store';
import { ApiError } from '../api-error';
import { bankConfig, bankRequest, bankToken, BankHttpError, type BankConfig, type BankRequest, decryptTokens, encryptTokens } from './transport';
import { sberAdapter, tbankAdapter } from './adapters';
import { emptyBanking, filterOperations, nextDay, object, str, today, totals, upsertOperations, validDate } from './domain';

const limitations = {
  sber: ['Выписка доступна за предыдущие 5 лет и текущий год. Статусы платёжных поручений в выписке отсутствуют.', 'Вебхуки Сбера требуют отдельного шлюза mTLS и проверки ГОСТ-подписи; здесь используется сверка выписки.'],
  tbank: ['История API доступна с июня 2023 года. Загружаются подтверждённые транзакции; авторизации не входят в фактические обороты.', 'Смена ID и удаление операций учитываются при полной повторной сверке дня. Печатная форма доступна для поддерживаемых исполненных документов.'],
};
export class BankingService {
  constructor(readonly store: OperationsStorage, readonly source: string, readonly env: Record<string, string | undefined> = process.env, readonly http: BankRequest = bankRequest) {}
  config(id: string, state?: BankConnectionState) {
    const definition = bankConnections.find(row => row.id === id);
    if (!definition) throw new ApiError(404, 'Подключение не найдено.');
    const config = bankConfig(definition, this.env);
    if (state?.encryptedTokens) config.missing = config.missing.filter(label => label !== 'Первичная авторизация и refresh token');
    return config;
  }
  async mutate<T>(update: (data: OperationsData) => { result: T; changed: boolean }) {
    // Retry CAS conflicts only; the callback is pure and never calls a bank.
    for (let attempt = 0; ; attempt++) {
      try { return await this.store.mutate(this.source, update); }
      catch (error) { if (!(error instanceof ApiError) || error.status !== 409 || attempt >= 4) throw error; await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1))); }
    }
  }
  async list(query: URLSearchParams): Promise<BankListResult> {
    const data = (await this.store.read(this.source)).banking ?? emptyBanking();
    const rows = filterOperations(data.operations, query);
    const allCardsRows = filterOperations(data.operations, query, true);
    const size = Number(query.get('pageSize') ?? 25), requested = Number(query.get('page') ?? 1);
    if (![10,25,50,100].includes(size) || !Number.isSafeInteger(requested) || requested < 1) throw new ApiError(400, 'Некорректная страница.');
    const page = Math.min(requested, Math.max(1, Math.ceil(rows.length / size)));
    const connections: BankCard[] = bankConnections.map(definition => {
      const state = data.connections[definition.id], config = this.config(definition.id, state);
      return { id: definition.id, provider: definition.provider, bankName: definition.bankName, company: definition.company,
        accounts: state?.accounts.length ? state.accounts : config.accounts,
        state: config.missing.length ? 'not_configured' : state?.lastError ? 'error' : state?.job ? 'syncing' : state?.lastSuccessAt ? 'connected' : 'ready',
        missing: config.missing, lastSuccessAt: state?.lastSuccessAt, lastError: state?.lastError, lastCompletedPeriod: state?.lastCompletedPeriod,
        progress: state?.job ? { from: state.job.from, to: state.job.to, day: state.job.day, pages: state.job.pages, attempts: state.job.attempts, nextAttemptAt: state.job.nextAttemptAt } : undefined,
        totals: totals(allCardsRows.filter(row => row.connectionId === definition.id)), limitations: limitations[definition.provider],
      };
    });
    const scope = data.operations.filter(row => !query.get('connection') || row.connectionId === query.get('connection'));
    return { connections, items: rows.slice((page - 1) * size, page * size).map(row => ({ ...row, bankData: {} })), total: rows.length, page, pageSize: size, totals: totals(rows), statuses: [...new Set(scope.map(row => row.status ?? '__missing__'))].sort(), storedCount: scope.length, scheduleEnabled: this.env.ARTEL_BANK_SYNC_ENABLED === 'true' };
  }
  async rows(query: URLSearchParams) { return filterOperations((await this.store.read(this.source)).banking?.operations ?? [], query); }
  async operation(id: string) {
    const row = (await this.store.read(this.source)).banking?.operations.find(row => row.id === id);
    if (!row) throw new ApiError(404, 'Банковская операция не найдена.');
    return row;
  }
  async start(id: string, from: unknown, to: unknown) {
    const config = this.config(id, (await this.store.read(this.source)).banking?.connections[id]);
    if (config.missing.length) throw new ApiError(409, 'Подключение не настроено. Требуются: ' + config.missing.join(', ') + '.');
    const earliest = config.definition.provider === 'sber' ? `${Number(today().slice(0, 4)) - 5}-01-01` : '2023-06-01';
    if (!validDate(from) || !validDate(to) || from > to || to > today() || from < earliest) throw new ApiError(400, `Укажите период с ${earliest} до сегодняшнего дня.`);
    await this.mutate(data => {
      const banking = data.banking ??= emptyBanking(), state = banking.connections[id] ??= { accounts: [] };
      if (state.job) {
        if (state.job.from !== from || state.job.to !== to) throw new ApiError(400, 'Уже загружается другой период. Дождитесь завершения или продолжите текущую загрузку.');
        if (state.lease && state.lease.until > Date.now()) return { result: null, changed: false };
        state.job.attempts = 0; delete state.job.nextAttemptAt; delete state.lastError;
        return { result: null, changed: true };
      }
      state.job = { id: randomUUID(), from, to, day: from, accountIndex: 0, accounts: config.accounts, startedAt: new Date().toISOString(), pages: 0, attempts: 0 };
      state.webhookPending = false; delete state.lastError;
      return { result: null, changed: true };
    });
  }
  async locked<T>(id: string, work: (config: BankConfig, state: BankConnectionState, fence: string) => Promise<T>): Promise<T | null> {
    const config = this.config(id, (await this.store.read(this.source)).banking?.connections[id]);
    if (config.missing.length) throw new ApiError(409, 'Сначала настройте серверный доступ к банку.');
    const fence = randomUUID();
    const state = await this.mutate(data => {
      const state = (data.banking ??= emptyBanking()).connections[id] ??= { accounts: [] };
      if (state.lease && state.lease.until > Date.now()) return { result: null as BankConnectionState | null, changed: false };
      state.lease = { id: fence, until: Date.now() + 45000 };
      state.requestNotBefore = Math.max(Date.now(), state.requestNotBefore ?? 0) + 1100;
      return { result: structuredClone(state), changed: true };
    });
    if (!state) return null;
    try {
      // Durable pacing also covers different serverless instances and the 1 RPS PDF method.
      const wait = (state.requestNotBefore ?? 0) - 1100 - Date.now();
      if (wait > 0) await new Promise(resolve => setTimeout(resolve, Math.min(wait, 1500)));
      return await work(config, state, fence);
    }
    finally { await this.mutate(data => { const state = data.banking!.connections[id]; if (state.lease?.id !== fence) return { result: null, changed: false }; delete state.lease; return { result: null, changed: true }; }); }
  }
  async token(config: BankConfig, state: BankConnectionState, fence: string) {
    return bankToken(config, state.encryptedTokens, encrypted => this.mutate(data => {
      const stored = data.banking!.connections[config.definition.id];
      if (stored.lease?.id !== fence) throw new ApiError(423, 'Загрузка была продолжена другим процессом. Повторите запрос.');
      stored.encryptedTokens = encrypted; state.encryptedTokens = encrypted;
      return { result: undefined, changed: true };
    }), this.http);
  }
  adapter(config: BankConfig) { return config.definition.provider === 'sber' ? sberAdapter(this.http) : tbankAdapter(this.http); }
  async tick(id: string) {
    const queued = (await this.store.read(this.source)).banking?.connections[id]?.job;
    if (!queued || queued.attempts >= 5 || queued.nextAttemptAt && Date.parse(queued.nextAttemptAt) > Date.now()) return { pending: !!queued };
    return this.locked(id, async (config, state, fence) => {
      const job = state.job;
      if (!job || job.attempts >= 5 || job.nextAttemptAt && Date.parse(job.nextAttemptAt) > Date.now()) return { pending: !!job };
      try {
        const token = await this.token(config, state, fence);
        const account = job.accounts[job.accountIndex];
        const result = await this.adapter(config).page(config, token, account, job.day, job.cursor);
        if (result.nextCursor && (job.seenCursors?.includes(result.nextCursor) || (job.seenCursors?.length ?? 0) >= 10000)) throw new ApiError(502, 'Банк повторил указатель страницы или превысил предел страниц. Незавершённая выписка не заменяет сохранённую.');
        await this.mutate(data => {
          const banking = data.banking!, current = banking.connections[id];
          if (current.lease?.id !== fence || current.job?.id !== job.id) throw new ApiError(423, 'Истёк срок текущей загрузки.');
          const updated = current.job;
          const stage = emptyBanking(); stage.operations = updated.staged ?? []; upsertOperations(stage, result.operations); updated.staged = stage.operations;
          updated.pages++; updated.attempts = 0; delete updated.nextAttemptAt; delete current.lastError;
          current.lastAttemptAt = new Date().toISOString();
          if (result.nextCursor) { updated.cursor = result.nextCursor; updated.seenCursors = [...(updated.seenCursors ?? []), result.nextCursor]; return { result: null, changed: true }; }
          // Replace only a fully downloaded account/day, preserving previous data on partial failures.
          const partition = (row: BankOperation) => row.connectionId === id && row.account === account.number && row.statementDate === job.day;
          const incoming = new Set(stage.operations.map(row => row.id));
          const removed = banking.operations.filter(row => partition(row) && !incoming.has(row.id));
          if (removed.length) {
            const archive = new Map((banking.archivedOperations ?? []).map(row => [row.id, row]));
            removed.forEach(row => archive.set(row.id, row)); banking.archivedOperations = [...archive.values()];
          }
          banking.operations = banking.operations.filter(row => !partition(row) || incoming.has(row.id));
          upsertOperations(banking, stage.operations);
          updated.staged = []; delete updated.cursor; delete updated.seenCursors;
          if (job.day < job.to) updated.day = nextDay(job.day);
          else if (job.accountIndex + 1 < job.accounts.length) { updated.accountIndex++; updated.day = job.from; }
          else {
            current.accounts = job.accounts; current.lastSuccessAt = new Date().toISOString(); current.lastCompletedPeriod = { from: job.from, to: job.to }; delete current.job;
          }
          return { result: null, changed: true };
        });
        return { pending: !!(await this.store.read(this.source)).banking?.connections[id].job };
      } catch (error) {
        await this.mutate(data => {
          const current = data.banking!.connections[id];
          if (current.lease?.id !== fence || current.job?.id !== job.id) return { result: null, changed: false };
          current.lastAttemptAt = new Date().toISOString();
          current.lastError = error instanceof ApiError ? error.message : 'Не удалось сохранить страницу выписки. Предыдущие данные доступны.';
          current.job.attempts++;
          if (error instanceof BankHttpError && error.bankStatus === 401 && config.definition.provider === 'sber' && current.encryptedTokens) {
            const key = config.env.ARTEL_BANK_ENCRYPTION_KEY!;
            const tokens = decryptTokens(current.encryptedTokens, key, id);
            current.encryptedTokens = encryptTokens({ ...tokens, expiresAt: 0 }, key, id);
          }
          if (error instanceof BankHttpError && !error.transient && !(error.bankStatus === 401 && config.definition.provider === 'sber')) current.job.attempts = 5;
          if (current.job.attempts >= 5) {
            delete current.job.nextAttemptAt;
            current.lastError += ' Автоматические попытки остановлены. Проверьте доступ и нажмите «Продолжить загрузку».';
          } else current.job.nextAttemptAt = new Date(Date.now() + Math.max(error instanceof BankHttpError ? error.retryAfterSeconds : 0, Math.min(900, 5 * 2 ** current.job.attempts)) * 1000).toISOString();
          return { result: null, changed: true };
        });
        return { pending: true, failed: true };
      }
    });
  }
  async enrich(id: string) {
    const row = await this.operation(id);
    if (row.provider === 'tbank') return row;
    const result = await this.locked(row.connectionId, async (config, state, fence) => {
      const token = await this.token(config, state, fence), enriched = await this.adapter(config).detail(config, token, row);
      await this.mutate(data => {
        if (data.banking!.connections[row.connectionId].lease?.id !== fence) throw new ApiError(423, 'Загрузка продолжается в другом процессе.');
        // A detail lookup cannot add a removed statement movement.
        if (!data.banking!.operations.some(item => item.id === row.id)) throw new ApiError(409, 'Операция изменилась. Обновите выписку.');
        upsertOperations(data.banking!, [enriched]); return { result: null, changed: true };
      });
      return this.operation(id);
    });
    if (!result) throw new ApiError(423, 'Сейчас идёт синхронизация этого банка. Сохранённые реквизиты доступны.');
    return result;
  }
  async print(id: string) {
    const row = await this.operation(id);
    const result = await this.locked(row.connectionId, async (config, state, fence) => this.adapter(config).print(config, await this.token(config, state, fence), row));
    if (!result) throw new ApiError(423, 'Банк занят синхронизацией. Повторите получение формы позже.');
    return result;
  }
  async dispatch() {
    if (this.env.ARTEL_BANK_SYNC_ENABLED !== 'true') return { enabled: false };
    const data = (await this.store.read(this.source)).banking ?? emptyBanking();
    const due = bankConnections.filter(def => !this.config(def.id, data.connections[def.id]).missing.length).map(def => ({ def, state: data.connections[def.id] })).filter(({state}) => state?.job ? state.job.attempts < 5 && (!state.job.nextAttemptAt || Date.parse(state.job.nextAttemptAt) <= Date.now()) : state?.lastSuccessAt && (state.webhookPending || Date.now() - Date.parse(state.lastSuccessAt) >= 15 * 60000)).sort((a, b) => (a.state?.lastAttemptAt ?? '').localeCompare(b.state?.lastAttemptAt ?? ''))[0];
    if (!due) return { enabled: true, pending: false };
    if (!due.state?.job) await this.start(due.def.id, nextDay((due.state?.lastSuccessAt ?? today()).slice(0, 10), -7), today());
    return { enabled: true, ...await this.tick(due.def.id) };
  }
  async webhook(id: string, authorization: string | undefined, raw: Record<string, unknown>) {
    const config = this.config(id), secret = this.env[`${config.definition.envPrefix}_WEBHOOK_TOKEN`];
    if (config.definition.provider !== 'tbank' || !secret || !authorization) throw new ApiError(403, 'Вебхук не настроен.');
    const expected = Buffer.from(`Bearer ${secret}`), actual = Buffer.from(authorization);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new ApiError(403, 'Подпись доступа вебхука не подтверждена.');
    // Events are hints only: webhook IDs can differ from statement IDs. Money comes from a reconciliation.
    const body = object(raw), account = str(body.accountNumber);
    if (!account || !config.accounts.some(row => row.number === account)) throw new ApiError(400, 'Неизвестный счёт события.');
    const hash = createHash('sha256').update(JSON.stringify(body)).digest('hex');
    await this.mutate(data => {
      const state = (data.banking ??= emptyBanking()).connections[id] ??= { accounts: [] };
      if (state.webhookHashes?.includes(hash)) return { result: null, changed: false };
      state.webhookHashes = [...(state.webhookHashes ?? []).slice(-199), hash]; state.webhookPending = true;
      return { result: null, changed: true };
    });
  }
}

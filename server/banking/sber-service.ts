import { createHash, randomUUID } from 'node:crypto';
import type { BankOperation } from '../../web/src/banking-model';
import type { SberStatementsResult } from '../../web/src/sber-model';
import { ApiError } from '../api-error';
import { syncDue } from './schedule';
import type { OperationsData, OperationsStorage } from '../operations-store';
import { nextDay, object, today } from './domain';
import { SberClient, sberMissing, sberRequest, type SberRequest, type SberTokenVault } from './sber-client';
import { decryptSberTokens, emptySber, encryptSberTokens, mergeSberRows, normalizeSberOperation, normalizeSberSummary, parseSberPage, reconcileSberDay, SBER_ACCOUNT, SBER_COMPANY, SBER_FIRST_DAY, SBER_INN, sberEncryptionKey, sberPeriod, type SberData } from './sber-domain';

export class SberService {
  constructor(readonly store: OperationsStorage, readonly source: string, readonly env: Record<string, string | undefined> = process.env, readonly request?: SberRequest) {}
  async mutate<T>(update: (data: OperationsData) => { result: T; changed: boolean }): Promise<T> {
    // Storage CAS retries never repeat a request to the bank or token endpoint.
    for (let attempt = 0; ; attempt++) {
      try { return await this.store.mutate(this.source, update); }
      catch (error) {
        if (!(error instanceof ApiError) || error.status !== 409 || attempt >= 4) throw error;
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
      }
    }
  }
  private missing(state: SberData) {
    const missing = sberMissing(this.env, !!state.encryptedTokens);
    try { sberEncryptionKey(this.env); } catch { if (!missing.includes('Ключ защиты банковского доступа на сервере')) missing.push('Ключ защиты банковского доступа на сервере'); }
    return missing;
  }
  async list(query: URLSearchParams): Promise<SberStatementsResult> {
    const period = sberPeriod(query.get('from') ?? SBER_FIRST_DAY, query.get('to') ?? today());
    const state = (await this.store.read(this.source)).sber ?? emptySber(), job = state.job;
    const direction = query.get('direction'), term = (query.get('q') ?? '').trim().toLocaleLowerCase('ru-RU');
    if (direction && !['incoming', 'outgoing'].includes(direction)) throw new ApiError(400, 'Некорректное направление платежа.');
    const operations = state.operations.filter(row => row.statementDate >= period.from && row.statementDate <= period.to && (!direction || row.direction === direction) && (!term || [row.payer.name, row.payee.name, row.payer.inn, row.payee.inn, row.payer.account, row.payee.account, row.purpose, row.documentNumber].some(value => value?.toLocaleLowerCase('ru-RU').includes(term))));
    const completeCount = job ? Math.round((Date.parse(job.day) - Date.parse(job.from)) / 86400000) : 0;
    return {
      account: SBER_ACCOUNT, company: SBER_COMPANY, inn: SBER_INN,
      days: state.days.filter(day => day.date >= period.from && day.date <= period.to).sort((a, b) => b.date.localeCompare(a.date)),
      operations: operations.sort((a, b) => b.statementDate.localeCompare(a.statementDate) || (b.bookedAt ?? '').localeCompare(a.bookedAt ?? '') || a.id.localeCompare(b.id)).map(row => ({ ...row, bankData: {} })),
      missing: this.missing(state), lastSuccessAt: state.lastSuccessAt, lastError: state.lastError, lastCompletedPeriod: state.lastCompletedPeriod,
      scheduleEnabled: this.env.ARTEL_BANK_SYNC_ENABLED === 'true',
      progress: job ? { from: job.from, to: job.to, day: job.day, completedDays: completeCount, totalDays: Math.round((Date.parse(job.to) - Date.parse(job.from)) / 86400000) + 1, pages: job.pages, nextAttemptAt: job.nextAttemptAt } : undefined,
    };
  }
  async start(from: unknown, to: unknown) {
    const period = sberPeriod(from, to), state = (await this.store.read(this.source)).sber ?? emptySber();
    const missing = this.missing(state);
    if (missing.length) throw new ApiError(409, 'Доступ к Сберу не настроен на сервере. Требуются: ' + missing.join(', ') + '.');
    await this.mutate(data => {
      const current = data.sber ??= emptySber();
      if (current.lease && current.lease.until > Date.now()) throw new ApiError(423, 'Запрос к Сберу уже выполняется. Дождитесь его завершения.');
      if (current.job && (current.job.from !== period.from || current.job.to !== period.to)) throw new ApiError(409, 'Уже загружается другой период. Сначала завершите текущую загрузку.');
      if (!current.job) current.job = { id: randomUUID(), ...period, day: period.from, page: 1, pages: 0, staged: [], seenPages: [], attempts: 0 };
      else if (current.lastError) {
        // A failed paginated day restarts from its first page; the last complete day remains visible.
        current.job.id = randomUUID(); current.job.page = 1; current.job.staged = []; current.job.seenPages = []; delete current.job.summary;
      }
      current.job.attempts = 0; delete current.job.nextAttemptAt; delete current.lastError;
      return { result: null, changed: true };
    });
    return { pending: true };
  }
  async dispatch(now = Date.now()) {
    if (this.env.ARTEL_BANK_SYNC_ENABLED !== 'true') return { enabled: false, pending: false };
    const state = (await this.store.read(this.source)).sber ?? emptySber();
    if (this.missing(state).length || !state.job && !syncDue(state.lastScheduledAt, state.lastSuccessAt, now)) return { enabled: true, pending: false };
    if (!state.job) await this.mutate(data => {
      const current = data.sber!;
      if (current.job || !syncDue(current.lastScheduledAt, current.lastSuccessAt, now)) return { result: null, changed: false };
      const to = today(), from = [SBER_FIRST_DAY, nextDay(to, -6)].sort().at(-1)!;
      current.job = { id: randomUUID(), from, to, day: from, page: 1, pages: 0, staged: [], seenPages: [], attempts: 0 };
      current.lastScheduledAt = new Date(now).toISOString(); delete current.lastError;
      return { result: null, changed: true };
    });
    const result = await this.tick();
    const after = (await this.store.read(this.source)).sber;
    return { enabled: true, ...result, failed: !!after?.lastError };
  }
  private async locked<T>(work: (state: SberData, fence: string, client: SberClient) => Promise<T>): Promise<T | null> {
    const fence = randomUUID();
    const state = await this.mutate(data => {
      const current = data.sber ??= emptySber();
      if (current.lease && current.lease.until > Date.now()) return { result: null as SberData | null, changed: false };
      const missing = this.missing(current);
      if (missing.length) throw new ApiError(409, 'Доступ к Сберу не настроен на сервере. Требуются: ' + missing.join(', ') + '.');
      // Longer than the cloud invocation limit: a timed-out invocation cannot race token rotation.
      current.lease = { id: fence, until: Date.now() + 120000 };
      return { result: structuredClone(current), changed: true };
    });
    if (!state) return null;
    const vault: SberTokenVault = {
      read: async () => {
        const current = (await this.store.read(this.source)).sber;
        if (current?.lease?.id !== fence || current.lease.until <= Date.now()) throw new ApiError(423, 'Истёк срок текущего запроса к Сберу.');
        return current.encryptedTokens ? decryptSberTokens(current.encryptedTokens, this.env) : undefined;
      },
      save: async tokens => {
        const encrypted = encryptSberTokens(tokens, this.env);
        await this.mutate(data => {
          const current = data.sber!;
          if (current.lease?.id !== fence || current.lease.until <= Date.now()) throw new ApiError(423, 'Истёк срок текущего запроса к Сберу. Новые ключи не перезаписывают состояние другого запроса.');
          current.encryptedTokens = encrypted;
          return { result: null, changed: true };
        });
      },
    };
    const guardedRequest: SberRequest = async (env, request) => {
      const slot = await this.mutate(data => {
        const current = data.sber!;
        if (current.lease?.id !== fence || current.lease.until <= Date.now()) throw new ApiError(423, 'Истёк срок запроса к Сберу.');
        const slot = Math.max(Date.now(), current.requestNotBefore ?? 0);
        current.requestNotBefore = slot + 250;
        current.lease.until = Date.now() + 120000;
        return { result: slot, changed: true };
      });
      if (slot > Date.now()) await new Promise(resolve => setTimeout(resolve, slot - Date.now()));
      // Every actual request (including refresh/retry) rechecks the fence after pacing.
      await this.mutate(data => {
        const current = data.sber!;
        if (current.lease?.id !== fence || current.lease.until <= Date.now()) throw new ApiError(423, 'Истёк срок запроса к Сберу.');
        current.lease.until = Date.now() + 120000;
        return { result: null, changed: true };
      });
      return (this.request ?? sberRequest)(env, request);
    };
    try { return await work(state, fence, new SberClient(this.env, vault, guardedRequest)); }
    finally {
      await this.mutate(data => {
        if (data.sber?.lease?.id !== fence) return { result: null, changed: false };
        delete data.sber.lease; return { result: null, changed: true };
      });
    }
  }
  async tick(): Promise<{ pending: boolean }> {
    const queued = (await this.store.read(this.source)).sber?.job;
    if (!queued || queued.attempts >= 5 || queued.nextAttemptAt && Date.parse(queued.nextAttemptAt) > Date.now()) return { pending: !!queued };
    return await this.locked(async (state, fence, client) => {
      const job = state.job;
      if (!job) return { pending: false };
      try {
        let summary = job.summary;
        if (job.page === 1) {
          try { summary = normalizeSberSummary(await client.get('/fintech/api/v2/statement/summary', { accountNumber: SBER_ACCOUNT, statementDate: job.day }), job.day); }
          catch (error) {
            if ((error as { bankStatus?: number }).bankStatus !== 404) throw error;
            summary = { ...normalizeSberSummary({}, job.day), error: 'Сбер не предоставил дневные итоги за эту дату. Остатки и обороты неизвестны.' };
          }
        }
        const page = parseSberPage(await client.get('/fintech/api/v2/statement/transactions', { accountNumber: SBER_ACCOUNT, statementDate: job.day, page: String(job.page) }), job.day, job.page);
        const signature = createHash('sha256').update(JSON.stringify(page.operations.map(row => row.bankOperationId))).digest('hex');
        if (page.nextPage && job.seenPages.includes(signature)) throw new ApiError(502, 'Сбер повторил содержимое страницы. Незавершённая выписка не заменяет сохранённую.');
        await this.mutate(data => {
          const current = data.sber!;
          if (current.lease?.id !== fence || current.lease.until <= Date.now() || current.job?.id !== job.id) throw new ApiError(423, 'Истёк срок текущей загрузки Сбера.');
          const active = current.job;
          active.staged = mergeSberRows(active.staged, page.operations); active.summary = summary;
          active.pages++; active.attempts = 0; delete active.nextAttemptAt;
          current.lastAttemptAt = new Date().toISOString(); delete current.lastError;
          if (page.nextPage) { active.page = page.nextPage; active.seenPages.push(signature); return { result: null, changed: true }; }
          if (!summary) throw new ApiError(502, 'Не удалось получить дневные итоги Сбера.');
          if (summary.status === 'partial' && current.days.some(day => day.date === job.day && day.status === 'complete')) throw new ApiError(502, 'Сбер не предоставил полные дневные итоги. Ранее загруженная полная выписка за этот день сохранена.');
          reconcileSberDay(summary, active.staged);
          const kept = current.operations.filter(row => row.statementDate !== job.day);
          current.operations = mergeSberRows(kept, active.staged);
          current.days = [...current.days.filter(day => day.date !== job.day), { ...summary, syncedAt: new Date().toISOString() }];
          if (job.day < job.to) {
            active.day = nextDay(job.day); active.page = 1; active.staged = []; active.seenPages = []; delete active.summary;
          } else {
            current.lastCompletedPeriod = { from: job.from, to: job.to };
            const incomplete = current.days.some(day => day.date >= job.from && day.date <= job.to && day.status === 'partial');
            if (incomplete) current.lastError = 'Операции загружены, но Сбер передал не все дневные итоги. Неизвестные суммы показаны прочерком.';
            else current.lastSuccessAt = new Date().toISOString();
            delete current.job;
          }
          return { result: null, changed: true };
        });
      } catch (error) {
        await this.mutate(data => {
          const current = data.sber!;
          if (current.lease?.id !== fence || current.job?.id !== job.id) return { result: null, changed: false };
          current.lastAttemptAt = new Date().toISOString();
          current.lastError = error instanceof ApiError ? error.message : 'Не удалось обновить выписку Сбера. Ранее загруженные данные сохранены.';
          current.job.attempts++;
          current.job.page = 1; current.job.staged = []; current.job.seenPages = []; delete current.job.summary;
          const bankStatus = (error as { bankStatus?: number }).bankStatus;
          if (bankStatus && bankStatus >= 400 && bankStatus < 500 && bankStatus !== 429) current.job.attempts = 5;
          if (current.job.attempts >= 5) { delete current.job.nextAttemptAt; current.lastError += ' Нажмите «Обновить», чтобы повторить загрузку.'; }
          else current.job.nextAttemptAt = new Date(Date.now() + Math.max((error as { retryAfterSeconds?: number }).retryAfterSeconds ?? 0, Math.min(900, 5 * 2 ** current.job.attempts)) * 1000).toISOString();
          return { result: null, changed: true };
        });
      }
      return { pending: !!(await this.store.read(this.source)).sber?.job };
    }) ?? { pending: true };
  }
  async operation(id: string): Promise<BankOperation> {
    const row = (await this.store.read(this.source)).sber?.operations.find(row => row.id === id);
    if (!row) throw new ApiError(404, 'Операция Сбера не найдена.');
    return row;
  }
  async enrich(id: string): Promise<BankOperation> {
    const result = await this.locked(async (_state, fence, client) => {
      const previous = await this.operation(id);
      const raw = object(await client.get('/fintech/api/v2/statement/transactionId', { accountNumber: SBER_ACCOUNT, id: previous.bankOperationId, operationDate: previous.statementDate }));
      if (raw.operationId && raw.operationId !== previous.bankOperationId) throw new ApiError(502, 'Сбер вернул подробности другой операции. Сохранённые реквизиты не изменены.');
      const updated = { ...normalizeSberOperation({ ...previous.bankData, ...raw, operationId: previous.bankOperationId }, previous.statementDate), detailsFetchedAt: new Date().toISOString() };
      if (updated.amount !== previous.amount || updated.direction !== previous.direction || updated.currency !== previous.currency || updated.account !== previous.account || updated.bookedAt?.slice(0, 10) !== previous.bookedAt?.slice(0, 10)) throw new ApiError(409, 'Сбер изменил сумму, направление или дату операции. Обновите выписку за день для повторной сверки итогов. Сохранённые данные не изменены.');
      await this.mutate(data => {
        const current = data.sber!;
        if (current.lease?.id !== fence || current.lease.until <= Date.now()) throw new ApiError(423, 'Истёк срок запроса подробностей Сбера.');
        const index = current.operations.findIndex(row => row.id === id);
        if (index < 0) throw new ApiError(409, 'Операция изменилась. Обновите выписку.');
        current.operations[index] = updated;
        return { result: null, changed: true };
      });
      return updated;
    });
    if (!result) throw new ApiError(423, 'Синхронизация Сбера уже выполняется. Повторите после её завершения.');
    return result;
  }
}

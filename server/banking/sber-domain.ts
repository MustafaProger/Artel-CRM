import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import Decimal from 'decimal.js';
import type { BankOperation, BankParty } from '../../web/src/banking-model';
import type { SberDailySummary } from '../../web/src/sber-model';
import { ApiError } from '../api-error';
import { validDate, today, operationId, object, str, cleanBankData } from './domain';
import { defaultSberConnection, type SberConnection } from './sber-connections';
import type { SberTokens } from './sber-client';

export const SBER_ACCOUNT = defaultSberConnection.account;
export const SBER_COMPANY = defaultSberConnection.company;
export const SBER_INN = defaultSberConnection.inn;
export const SBER_CONNECTION = defaultSberConnection.id;
export const SBER_FIRST_DAY = '2026-09-01';
const Exact = Decimal.clone({ precision: 80 });

export interface SberJob {
  id: string; from: string; to: string; day: string; page: number; pages: number;
  attempts: number; nextAttemptAt?: string; staged: BankOperation[];
  summary?: SberDailySummary; seenPages: string[];
}
export interface SberData {
  version: 1;
  account: string;
  days: SberDailySummary[];
  operations: BankOperation[];
  job?: SberJob;
  lease?: { id: string; until: number };
  requestNotBefore?: number;
  encryptedTokens?: string;
  lastSuccessAt?: string;
  lastScheduledAt?: string;
  lastAttemptAt?: string;
  lastError?: string;
  lastCompletedPeriod?: { from: string; to: string };
}
export const emptySber = (connection: SberConnection = defaultSberConnection): SberData => ({ version: 1, account: connection.account, days: [], operations: [] });

export function sberPeriod(from: unknown, to: unknown): { from: string; to: string } {
  if (!validDate(from) || !validDate(to) || from > to || to > today() || Date.parse(to) - Date.parse(from) > 30 * 86400000) throw new ApiError(400, 'Выберите период не более 31 дня, без будущих дат.');
  return { from, to };
}
export function sberAmount(value: unknown, signed = false): string {
  if (typeof value !== 'string' || !(signed ? /^-?\d{1,35}(?:\.\d{1,18})?$/ : /^\d{1,35}(?:\.\d{1,18})?$/).test(value)) throw new ApiError(502, 'Сбер вернул некорректную сумму. Предыдущая выписка сохранена.');
  return new Exact(value).toFixed();
}
export function sberOptionalAmount(value: unknown, signed = false): string | null {
  return value === null || value === undefined ? null : sberAmount(value, signed);
}
export function mergeSberRows(prior: BankOperation[], incoming: BankOperation[]): BankOperation[] {
  const rows = new Map(prior.map(row => [row.id, row]));
  for (const row of incoming) rows.set(row.id, row);
  return [...rows.values()];
}
const ruble = (value: unknown) => value === 'RUB' || value === 'RUR' || value === '643' || value === '810';
function moneyObject(value: unknown, optional: boolean, signed = false): string | null {
  if (optional && (value === undefined || value === null)) return null;
  const amount = object(value);
  if (optional && (amount.amount === undefined || amount.amount === null)) return null;
  if (!ruble(amount.currencyName)) throw new ApiError(502, 'Сбер не подтвердил рублёвую валюту суммы. Предыдущая выписка сохранена.');
  return sberAmount(amount.amount, signed);
}
export function normalizeSberSummary(raw: unknown, day: string): SberDailySummary {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ApiError(502, 'Сбер вернул некорректные дневные итоги.');
  const r = object(raw);
  const result: SberDailySummary = { date: day, openingBalance: moneyObject(r.openingBalance, true, true), incoming: moneyObject(r.creditTurnover, true), outgoing: moneyObject(r.debitTurnover, true), closingBalance: moneyObject(r.closingBalance, true, true), currency: 'RUB', syncedAt: new Date().toISOString() };
  result.status = [result.openingBalance, result.incoming, result.outgoing, result.closingBalance].every(value => value !== null) ? 'complete' : 'partial';
  if (result.status === 'partial') result.error = 'Сбер передал не все дневные итоги. Отсутствующие значения показаны прочерком.';
  return result;
}
export function normalizeSberOperation(raw: unknown, day: string, connection: SberConnection = defaultSberConnection): BankOperation {
  const r = object(raw), bankId = str(r.operationId);
  if (!bankId || !['CREDIT', 'DEBIT'].includes(String(r.direction)) || !validDate(day)) throw new ApiError(502, 'Сбер не передал идентификатор или направление операции. Предыдущая выписка сохранена.');
  const transfer = object(r.rurTransfer ?? r.curTransfer);
  const ownAccount = str(transfer[r.direction === 'CREDIT' ? 'payeeAccount' : 'payerAccount']);
  if (ownAccount && ownAccount !== connection.account) throw new ApiError(502, 'Сбер вернул операцию другого счёта. Предыдущая выписка сохранена.');
  const party = (prefix: 'payer' | 'payee'): BankParty => ({ name: str(transfer[`${prefix}Name`]), inn: str(transfer[`${prefix}Inn`]), kpp: str(transfer[`${prefix}Kpp`]), account: str(transfer[`${prefix}Account`]), bic: str(transfer[`${prefix}BankBic`]), bankName: str(transfer[`${prefix}BankName`]), correspondentAccount: str(transfer[`${prefix}BankCorrAccount`]) });
  const amount = ruble(object(r.amount).currencyName) ? r.amount : r.amountRub;
  return {
    id: operationId(connection.id, connection.account, bankId), connectionId: connection.id, provider: 'sber', bankOperationId: bankId,
    account: connection.account, statementDate: day, amount: moneyObject(amount, false)!, currency: 'RUB', direction: r.direction === 'CREDIT' ? 'incoming' : 'outgoing',
    documentNumber: str(r.number), documentDate: str(r.documentDate), bookedAt: str(r.operationDate), purpose: str(r.paymentPurpose),
    payer: party('payer'), payee: party('payee'), booked: true, bankData: object(cleanBankData(r)), source: 'statement-api', updatedAt: new Date().toISOString(),
    counterpartyId: null, allocations: [], importedSourceIds: [],
  };
}
export function parseSberPage(raw: unknown, day: string, page: number, connection: SberConnection = defaultSberConnection): { operations: BankOperation[]; nextPage?: number } {
  const body = object(raw);
  if (!Array.isArray(body.transactions) || body._links !== undefined && !Array.isArray(body._links)) throw new ApiError(502, 'Сбер не передал список операций или ссылки страниц. Предыдущая выписка сохранена.');
  const links = (body._links as unknown[] | undefined ?? []).map(object).filter(link => link.rel === 'next');
  if (links.length > 1) throw new ApiError(502, 'Сбер вернул неоднозначную следующую страницу.');
  let nextPage: number | undefined;
  if (links.length) {
    try {
      if (!str(links[0].href)) throw new Error('Missing link');
      // Never follow a bank-provided URL: extract and validate only its page index.
      const url = new URL(String(links[0].href), 'https://fintech.sberbank.ru:9443/fintech/api/v2/statement/transactions');
      const value = url.searchParams.get('page');
      if (!value || !/^\d+$/.test(value)) throw new Error('Missing page');
      nextPage = Number(value);
      if (nextPage !== page + 1 || nextPage > 10000 || url.searchParams.has('accountNumber') && url.searchParams.get('accountNumber') !== connection.account || url.searchParams.has('statementDate') && url.searchParams.get('statementDate') !== day) throw new Error('Invalid page');
    } catch { throw new ApiError(502, 'Сбер повторил страницу или вернул некорректную ссылку продолжения. Предыдущая выписка сохранена.'); }
  }
  return { operations: body.transactions.map(row => normalizeSberOperation(row, day, connection)), nextPage };
}
export function reconcileSberDay(summary: SberDailySummary, operations: BankOperation[]) {
  const incoming = operations.filter(row => row.direction === 'incoming').reduce((sum, row) => sum.plus(row.amount), new Exact(0));
  const outgoing = operations.filter(row => row.direction === 'outgoing').reduce((sum, row) => sum.plus(row.amount), new Exact(0));
  if (summary.incoming !== null && !incoming.equals(summary.incoming) || summary.outgoing !== null && !outgoing.equals(summary.outgoing)) throw new ApiError(502, 'Список операций Сбера не совпал с дневными оборотами. Данные могли измениться во время загрузки; предыдущая выписка сохранена. Повторите обновление.');
  if (summary.openingBalance !== null && summary.closingBalance !== null && summary.incoming !== null && summary.outgoing !== null && !new Exact(summary.openingBalance).plus(summary.incoming).minus(summary.outgoing).equals(summary.closingBalance)) throw new ApiError(502, 'Остатки и обороты Сбера не согласованы. Предыдущая выписка сохранена. Повторите обновление.');
}
export function validateSber(value: SberData | undefined, connection: SberConnection = defaultSberConnection) {
  if (value === undefined) return;
  if (!value || value.version !== 1 || value.account !== connection.account || !Array.isArray(value.days) || !Array.isArray(value.operations)) throw new Error('Invalid Sber storage');
  const seenDays = new Set<string>();
  for (const day of value.days) {
    if (!day || !validDate(day.date) || seenDays.has(day.date) || day.currency !== 'RUB' || typeof day.syncedAt !== 'string') throw new Error('Invalid Sber summary');
    for (const key of ['openingBalance', 'closingBalance'] as const) sberOptionalAmount(day[key], true);
    for (const key of ['incoming', 'outgoing'] as const) sberOptionalAmount(day[key]);
    seenDays.add(day.date);
  }
  const rows = (values: BankOperation[]) => {
    const seen = new Set<string>();
    for (const row of values) {
      if (!row || row.provider !== 'sber' || row.connectionId !== connection.id || row.account !== connection.account || !row.bankOperationId || row.id !== operationId(connection.id, connection.account, row.bankOperationId) || seen.has(row.id) || !validDate(row.statementDate) || !['incoming', 'outgoing'].includes(row.direction) || row.currency !== 'RUB' || row.source !== 'statement-api' || !row.payer || !row.payee || !row.bankData || row.counterpartyId !== null || row.allocations.length || row.importedSourceIds.length) throw new Error('Invalid Sber operation');
      sberAmount(row.amount); seen.add(row.id);
    }
  };
  rows(value.operations);
  if (value.encryptedTokens !== undefined && typeof value.encryptedTokens !== 'string') throw new Error('Invalid Sber token envelope');
  if (value.lease && (!value.lease.id || !Number.isFinite(value.lease.until))) throw new Error('Invalid Sber lease');
  if (value.requestNotBefore !== undefined && !Number.isFinite(value.requestNotBefore)) throw new Error('Invalid Sber pacing');
  if (value.job) {
    const job = value.job;
    if (!job.id || !validDate(job.from) || !validDate(job.to) || !validDate(job.day) || job.from > job.day || job.day > job.to || !Number.isSafeInteger(job.page) || job.page < 1 || !Number.isSafeInteger(job.pages) || job.pages < 0 || !Number.isSafeInteger(job.attempts) || job.attempts < 0 || !Array.isArray(job.staged) || !Array.isArray(job.seenPages)) throw new Error('Invalid Sber job');
    rows(job.staged);
  }
}
export function sberEncryptionKey(env: Record<string, string | undefined>): Buffer {
  const value = env.ARTEL_BANK_ENCRYPTION_KEY;
  if (value && /^[a-f0-9]{64}$/i.test(value)) return Buffer.from(value, 'hex');
  if (!value || !/^[A-Za-z0-9+/]{43}=$/.test(value) || Buffer.from(value, 'base64').length !== 32) throw new ApiError(409, 'На сервере не настроен ключ шифрования банковских токенов.');
  return Buffer.from(value, 'base64');
}
export function encryptSberTokens(tokens: SberTokens, env: Record<string, string | undefined>, connection: SberConnection = defaultSberConnection): string {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', sberEncryptionKey(env), iv);
  cipher.setAAD(Buffer.from(`artel:sber:${connection.account}:v1`));
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(tokens), 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), encrypted.toString('base64')].join('.');
}
export function decryptSberTokens(encoded: string, env: Record<string, string | undefined>, connection: SberConnection = defaultSberConnection): SberTokens {
  try {
    const [version, iv, tag, data, extra] = encoded.split('.');
    if (version !== 'v1' || !iv || !tag || !data || extra) throw new Error('Invalid envelope');
    const decipher = createDecipheriv('aes-256-gcm', sberEncryptionKey(env), Buffer.from(iv, 'base64'));
    decipher.setAAD(Buffer.from(`artel:sber:${connection.account}:v1`));
    decipher.setAuthTag(Buffer.from(tag, 'base64'));
    const tokens = JSON.parse(Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')) as SberTokens;
    if (!tokens.accessToken || !tokens.refreshToken || tokens.expiresAt !== undefined && !Number.isFinite(tokens.expiresAt)) throw new Error('Invalid token pair');
    return tokens;
  } catch { throw new ApiError(409, 'Не удалось прочитать сохранённые ключи Сбера. Проверьте серверный ключ шифрования.'); }
}

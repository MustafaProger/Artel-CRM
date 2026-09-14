import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { bankConnections, type BankingData, type BankOperation, type BankTotals } from '../../web/src/banking-model';
import { ApiError } from '../api-error';

const Exact = Decimal.clone({ precision: 80 });
export const emptyBanking = (): BankingData => ({ version: 1, connections: {}, operations: [] });
export const object = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export const str = (value: unknown): string | undefined => typeof value === 'string' && value !== '' ? value : undefined;
export function exactAmount(value: unknown): string {
  // HTTP JSON numeric literals are parsed as strings before normalization.
  if (typeof value !== 'string' || !/^\d{1,35}(?:\.\d{1,18})?$/.test(value)) throw new ApiError(502, 'Банк вернул некорректную сумму. Страница выписки не сохранена.');
  return new Exact(value).toFixed();
}
export function validDate(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
}
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
export const nextDay = (day: string, days = 1) => new Date(Date.parse(day) + days * 86400000).toISOString().slice(0, 10);
export const operationId = (connection: string, account: string, bankId: string) => createHash('sha256').update(JSON.stringify([connection, account, bankId])).digest('hex');
export function cleanBankData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(cleanBankData);
  const secretKeys = new Set(['token','accesstoken','refreshtoken','idtoken','clientsecret','secret','password','authorization','certificate','privatekey','tlskey','clientcertificate']);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([key]) => !secretKeys.has(key.replace(/[^a-z0-9]/gi, '').toLowerCase())).map(([key, item]) => [key, cleanBankData(item)]));
  return value;
}
export function validateBanking(value: BankingData | undefined) {
  if (value === undefined) return;
  if (value.version !== 1 || !value.connections || !Array.isArray(value.operations)) throw new Error('Invalid banking storage');
  const validateRows = (rows: BankOperation[]) => {
    if (!Array.isArray(rows)) throw new Error('Invalid bank operations');
    const seen = new Set<string>();
    for (const row of rows) {
      if (!row || !bankConnections.some(c => c.id === row.connectionId && c.provider === row.provider) || typeof row.bankOperationId !== 'string' || !row.bankOperationId || !/^\d{20}$/.test(row.account) || row.id !== operationId(row.connectionId, row.account, row.bankOperationId) || seen.has(row.id) || !['incoming', 'outgoing'].includes(row.direction) || !validDate(row.statementDate) || !/^(?:[A-Z]{3}|\d{3})$/.test(row.currency) || typeof row.booked !== 'boolean' || row.source !== 'statement-api' || !row.payer || !row.payee || !row.bankData || !Array.isArray(row.allocations) || !Array.isArray(row.importedSourceIds)) throw new Error('Invalid bank operation');
      exactAmount(row.amount); seen.add(row.id);
    }
  };
  validateRows(value.operations);
  if (value.archivedOperations) validateRows(value.archivedOperations);
  for (const [id, state] of Object.entries(value.connections)) {
    if (!bankConnections.some(c => c.id === id) || !state || !Array.isArray(state.accounts) || state.accounts.some(a => !/^\d{20}$/.test(a.number) || !/^(?:[A-Z]{3}|\d{3})$/.test(a.currency)) || state.encryptedTokens !== undefined && typeof state.encryptedTokens !== 'string') throw new Error('Invalid bank connection');
    if (state.lease && (typeof state.lease.id !== 'string' || !Number.isFinite(state.lease.until))) throw new Error('Invalid bank lease');
    if (state.requestNotBefore !== undefined && !Number.isFinite(state.requestNotBefore)) throw new Error('Invalid bank pacing');
    if (state.job) {
      const job = state.job;
      if (!job.id || !validDate(job.from) || !validDate(job.to) || !validDate(job.day) || job.day < job.from || job.day > job.to || !Array.isArray(job.accounts) || !job.accounts.length || !Number.isInteger(job.accountIndex) || job.accountIndex < 0 || job.accountIndex >= job.accounts.length || !Number.isInteger(job.attempts) || job.attempts < 0 || !Number.isInteger(job.pages) || job.pages < 0) throw new Error('Invalid bank sync job');
      if (job.staged) validateRows(job.staged);
    }
  }
}
export function upsertOperations(data: BankingData, rows: BankOperation[]) {
  const indexes = new Map(data.operations.map((row, i) => [row.id, i]));
  for (const row of rows) {
    const i = indexes.get(row.id);
    if (i === undefined) { indexes.set(row.id, data.operations.length); data.operations.push(row); }
    else {
      const prior = data.operations[i];
      // Each bank response is authoritative for its fields. Do not silently retain
      // a field the bank removed or label old detail values as freshly synchronized.
      data.operations[i] = { ...row, counterpartyId: prior.counterpartyId, allocations: prior.allocations, importedSourceIds: prior.importedSourceIds };
    }
  }
}
export function totals(rows: BankOperation[]): BankTotals[] {
  const currencies = new Map<string, BankTotals>();
  for (const row of rows.filter(row => row.booked)) {
    const group = currencies.get(row.currency) ?? { currency: row.currency, incoming: '0', outgoing: '0', count: 0 };
    group[row.direction] = new Exact(group[row.direction]).plus(row.amount).toFixed(); group.count++;
    currencies.set(row.currency, group);
  }
  return [...currencies.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}
export function filterOperations(rows: BankOperation[], query: URLSearchParams, ignoreConnection = false) {
  const from = query.get('from'), to = query.get('to');
  if (from && !validDate(from) || to && !validDate(to) || from && to && from > to) throw new ApiError(400, 'Проверьте период: начальная дата должна быть не позже конечной.');
  const term = (query.get('q') ?? '').trim().toLocaleLowerCase('ru-RU');
  return rows.filter(row => (ignoreConnection || !query.get('connection') || row.connectionId === query.get('connection')) && (!from || row.statementDate >= from) && (!to || row.statementDate <= to) && (!query.get('direction') || row.direction === query.get('direction')) && (!query.get('account') || row.account === query.get('account')) && (!query.get('status') || (row.status ?? '__missing__') === query.get('status')) && (!term || [row.payer.name, row.payer.inn, row.payee.name, row.payee.inn, row.purpose, row.documentNumber].some(value => value?.toLocaleLowerCase('ru-RU').includes(term)))).sort((a, b) => b.statementDate.localeCompare(a.statementDate) || a.id.localeCompare(b.id));
}
export function csv(rows: BankOperation[]) {
  const cell = (value: unknown) => { let s = value == null ? '' : String(value); if (/^[\s]*[=+@-]/.test(s)) s = `'${s}`; return `"${s.replaceAll('"', '""')}"`; };
  return '\uFEFF' + [['Подключение','Счёт','ID банка','Дата','Документ','Контрагент','ИНН','Назначение','Направление','Сумма','Валюта','Статус'], ...rows.map(row => { const party = row.direction === 'incoming' ? row.payer : row.payee; return [row.connectionId,row.account,row.bankOperationId,row.statementDate,row.documentNumber,party.name,party.inn,row.purpose,row.direction === 'incoming' ? 'Поступление' : 'Списание',row.amount,row.currency,row.status]; })].map(row => row.map(cell).join(';')).join('\r\n');
}

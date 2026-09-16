import { bankConnections, type BankAccount, type BankingData, type BankOperation } from '../../web/src/banking-model';
import { ApiError } from '../api-error';
import { upsertOperations, validDate, validateBanking } from './domain';

const currency = (value: string) => ({ RUR: 'RUB', '643': 'RUB', '810': 'RUB', '840': 'USD', '978': 'EUR', '156': 'CNY', '398': 'KZT', '933': 'BYN', '784': 'AED' }[value] ?? value);

/** Publish only after the caller has fetched and validated a COMPLETE account/day.
 * Call inside OperationsStore.mutate. Validation and staging leave the input intact
 * on failure; no bank requests or partial-page publication happen here.
 */
export function replaceStatementDay(data: BankingData, connectionId: string, account: BankAccount, day: string, rows: BankOperation[], syncedAt = new Date().toISOString()): void {
  validateBanking(data);
  const definition = bankConnections.find(connection => connection.id === connectionId);
  if (!definition || !validDate(day)) throw new ApiError(502, 'Не удалось подтвердить подключение или дату полной выписки.');
  const partition = (row: BankOperation) => row.connectionId === connectionId && row.account === account.number && row.statementDate === day;
  try {
    // Reuse storage validation before publishing any financial fields or markers.
    validateBanking({ version: 1, connections: { [connectionId]: { accounts: [account], settlementVerifiedDays: [{ account: account?.number, date: day, syncedAt }] } }, operations: rows });
    if (rows.some(row => row.connectionId !== connectionId || row.provider !== definition.provider || row.account !== account.number || row.statementDate !== day || currency(row.currency) !== currency(account.currency))) throw new Error('Wrong statement partition');
    const existingById = new Map(data.operations.map(row => [row.id, row]));
    if (rows.some(row => existingById.has(row.id) && !partition(existingById.get(row.id)!))) throw new Error('Operation belongs to another statement day');
  } catch {
    throw new ApiError(502, 'Полная выписка содержит некорректные операции, счёт, валюту или дату. Сохранённые данные не изменены.');
  }

  const draft = structuredClone(data);
  const incoming = new Set(rows.map(row => row.id));
  const removed = draft.operations.filter(row => partition(row) && !incoming.has(row.id));
  if (removed.length) {
    const archive = new Map((draft.archivedOperations ?? []).map(row => [row.id, row]));
    for (const row of removed) archive.set(row.id, row);
    draft.archivedOperations = [...archive.values()];
  }
  draft.operations = draft.operations.filter(row => !partition(row) || incoming.has(row.id));
  upsertOperations(draft, structuredClone(rows));
  const state = draft.connections[connectionId] ??= { accounts: [] };
  const accountIndex = state.accounts.findIndex(row => row.number === account.number);
  if (accountIndex < 0) state.accounts.push(structuredClone(account));
  else state.accounts[accountIndex] = structuredClone(account);
  const days = state.settlementVerifiedDays ??= [];
  const dayIndex = days.findIndex(row => row.account === account.number && row.date === day);
  const verified = { account: account.number, date: day, syncedAt };
  if (dayIndex < 0) days.push(verified); else days[dayIndex] = verified;
  validateBanking(draft);

  // Preserve existing state/job object identities for the sync caller's lease and
  // progress updates after publication. Commit only the fields this helper owns.
  data.operations = draft.operations;
  if (draft.archivedOperations !== undefined) data.archivedOperations = draft.archivedOperations;
  const current = data.connections[connectionId] ??= { accounts: [] };
  current.accounts = state.accounts;
  current.settlementVerifiedDays = state.settlementVerifiedDays;
}

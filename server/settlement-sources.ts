import { bankConnections, type BankOperation } from '../web/src/banking-model';
import { decimal } from '../web/src/shipment-calculations';
import type { SettlementSource } from '../web/src/settlements-model';
import { SBER_ACCOUNT, SBER_CONNECTION, SBER_INN } from './banking/sber-domain';
import type { OperationsData } from './operations-store';

/** The legacy Sber array is not authoritative. ARTEL's new connector must publish
 * complete days through replaceStatementDay before its receipts can be counted. */
export const settlementConnections = bankConnections.map(connection => ({
  ...connection,
  storage: connection.id === SBER_CONNECTION ? 'sber' as const : 'banking' as const,
  requiresVerifiedDay: connection.id === 'sber-artel',
}));

export function settlementSources(store: OperationsData) {
  const candidates: BankOperation[] = [];
  const ownAccounts = new Set([SBER_ACCOUNT]);
  const ownInns = new Set([SBER_INN]);
  const sources: SettlementSource[] = [];
  for (const definition of settlementConnections) {
    const state = definition.storage === 'sber' ? store.sber : store.banking?.connections[definition.id];
    const connection = store.banking?.connections[definition.id];
    for (const account of connection?.accounts ?? []) ownAccounts.add(account.number);
    const confirmed = new Set((connection?.settlementVerifiedDays ?? []).map(day => `${day.account}:${day.date}`));
    const rows = (definition.storage === 'sber' ? store.sber?.operations : store.banking?.operations) ?? [];
    const active = rows.filter(row => row.connectionId === definition.id && row.provider === definition.provider && (!definition.requiresVerifiedDay || confirmed.has(`${row.account}:${row.statementDate}`)));
    candidates.push(...active);
    for (const row of active) ownAccounts.add(row.account);
    // An old connection success timestamp does not attest to newly verified ARTEL data.
    const verified = !definition.requiresVerifiedDay || confirmed.size > 0;
    const loaded = verified && (!!state?.lastSuccessAt || active.length > 0 || confirmed.size > 0);
    const published = connection?.settlementVerifiedDays ?? [];
    const lastPublished = [...published].sort((a, b) => a.syncedAt.localeCompare(b.syncedAt) || a.date.localeCompare(b.date)).at(-1);
    sources.push({
      id: definition.id, name: `${definition.bankName} · ${definition.company}`,
      status: state?.job ? 'syncing' : state?.lastError ? 'error' : loaded ? 'ready' : 'not_loaded',
      lastError: state?.lastError ?? null,
      lastSuccessAt: definition.requiresVerifiedDay ? lastPublished?.syncedAt ?? null : state?.lastSuccessAt ?? null,
      from: definition.requiresVerifiedDay ? lastPublished?.date ?? null : state?.lastCompletedPeriod?.from ?? null,
      to: definition.requiresVerifiedDay ? lastPublished?.date ?? null : state?.lastCompletedPeriod?.to ?? null,
    });
  }
  // Identity belongs to a bank, account and bank operation, not to the CRM slot.
  // Two imports of the same account cannot create another copy of its money.
  const byIdentity = new Map<string, BankOperation[]>();
  for (const row of candidates) {
    const key = JSON.stringify([row.provider, row.account, row.bankOperationId]);
    byIdentity.set(key, [...byIdentity.get(key) ?? [], row]);
  }
  const signature = (row: BankOperation) => JSON.stringify([
    row.statementDate, row.direction, row.booked, decimal(row.amount)?.toFixed() ?? row.amount,
    ['RUB', 'RUR', '643', '810'].includes(row.currency) ? 'RUB' : row.currency,
    row.payer.inn?.replace(/\s/g, '') ?? '', row.payer.account ?? '',
    row.payee.inn?.replace(/\s/g, '') ?? '', row.payee.account ?? '',
  ]);
  const operations: BankOperation[] = [], conflicts: BankOperation[] = [];
  for (const rows of byIdentity.values()) {
    if (new Set(rows.map(signature)).size > 1) conflicts.push(...new Map(rows.map(row => [row.id, row])).values());
    else operations.push(rows[0]);
  }
  operations.sort((a, b) => a.statementDate.localeCompare(b.statementDate) || a.id.localeCompare(b.id));
  return { operations, conflicts, sources, ownAccounts, ownInns };
}

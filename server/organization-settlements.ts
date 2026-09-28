import Decimal from 'decimal.js';
import type { AccountUser } from '../web/src/auth-model';
import type { BankOperation } from '../web/src/banking-model';
import type { Company, PaymentAllocation, Shipment, Snapshot } from '../web/src/model';
import type { OrganizationSettlement } from '../web/src/organization-settlements-model';
import { ourOrganizations, organizationForConnection, shipmentOrganizationId, type OurOrganizationId } from '../web/src/our-organizations';
import type { SettlementCompany, SettlementReceipt, SettlementReview, SettlementsReport } from '../web/src/settlements-model';
import { decimal, SHIPMENT_DECIMAL_PRECISION } from '../web/src/shipment-calculations';
import { canManage } from './auth';
import { ownsShipment } from './auth-scope';
import { validDate } from './banking/domain';
import { sberConnections } from './banking/sber-connections';
import { validInn } from './checko';
import type { OperationsData } from './operations-store';
import { scopeSettlements } from './settlement-scope';
import { settlementConnections, settlementSources } from './settlement-sources';
import { buildSettlements } from './settlements';

const Exact = Decimal.clone({ precision: SHIPMENT_DECIMAL_PRECISION });
const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new Exact(0)).toFixed();
const innText = (value: string | null | undefined) => value?.replace(/\s/g, '') || null;
const checkedInn = (value: string | null | undefined) => { const inn = innText(value); return inn && validInn(inn) ? inn : null; };
const keys = ['shipped', 'incoming', 'debt', 'advance', 'allocated'] as const;
const totals = (companies: SettlementCompany[]): SettlementsReport['totals'] => Object.fromEntries(keys.map(key => [key, sum(companies.map(group => group[key]))])) as SettlementsReport['totals'];
const sourceFor = (row: BankOperation) => settlementConnections.find(connection => connection.id === row.connectionId)!;
const bankReview = (row: BankOperation, reason: string): SettlementReview => {
  const source = sourceFor(row), party = row.direction === 'incoming' ? row.payer : row.payee;
  return { id: row.id, date: row.statementDate, name: party.name ?? 'Контрагент не указан', inn: innText(party.inn), amount: row.amount, currency: row.currency, reason, connectionId: row.connectionId, company: source.company, bank: source.bankName, account: row.account };
};

/** The connector owns the organization. A contradictory bank party or account is
 * a review item, never a reason to transfer money to another organization. */
function ownOrganizationIssue(row: BankOperation, id: OurOrganizationId): string | null {
  const own = row.direction === 'incoming' ? row.payee : row.payer;
  const expected = sberConnections[id === 'artel' ? 'sber-artel' : 'sber-nk-artel'];
  if (own.inn && innText(own.inn) !== expected.inn) return 'ИНН нашей организации в операции не совпадает с организацией банковского подключения.';
  if (own.account && own.account !== row.account) return 'Собственный счёт в операции не совпадает со счётом выписки.';
  const knownAccount = Object.values(sberConnections).find(connection => connection.account === row.account);
  if (knownAccount && organizationForConnection(knownAccount.id) !== id) return 'Счёт выписки относится к другой нашей организации.';
  return null;
}

function storeWithOperations(store: OperationsData, operations: BankOperation[]): OperationsData {
  return {
    ...store,
    sber: store.sber && { ...store.sber, operations: operations.filter(row => row.connectionId === 'sber-nk-artel') },
    banking: { version: 1, ...store.banking, connections: store.banking?.connections ?? {}, operations: operations.filter(row => row.connectionId !== 'sber-nk-artel') },
  };
}

function addPaymentReferences(report: SettlementsReport, operations: BankOperation[]) {
  const byId = new Map(operations.map(row => [row.id, row]));
  for (const group of report.companies) for (const receipt of group.receipts) {
    const operation = byId.get(receipt.id);
    receipt.bankOperationId = operation?.bankOperationId;
    receipt.documentNumber = operation?.documentNumber ?? null;
  }
}

/** A separate payable ledger: customer opening payments must never reduce a
 * purchase. All allocations are derived from active saved bank rows on each read. */
function supplierSettlements(shipments: Shipment[], companies: Company[], operations: BankOperation[], ownAccounts: Set<string>, ownInns: Set<string>): SettlementsReport {
  const groups = new Map<string, SettlementCompany>(), eligible = new Set<string>();
  const companyById = new Map(companies.map(company => [company.id, company]));
  const supplierIds = new Set(shipments.flatMap(row => row.supplierId ? [row.supplierId] : []));
  const suppliers = companies.filter(company => company.roles.includes('supplier') || supplierIds.has(company.id));
  const groupFor = (key: string, inn: string | null, name: string, companyId?: string | null) => {
    let group = groups.get(key);
    if (!group) {
      const known = inn ? suppliers.filter(company => checkedInn(company.inn) === inn) : [];
      group = { key, name: known[0]?.name ?? name, inn, companyIds: known.map(company => company.id), shipped: '0', openingPaid: '0', incoming: '0', allocated: '0', debt: '0', advance: '0', issues: [], shipments: [], receipts: [] };
      groups.set(key, group);
    }
    if (companyId && !group.companyIds.includes(companyId)) group.companyIds.push(companyId);
    return group;
  };
  const ordered = [...shipments].sort((a, b) => (validDate(a.date) ? a.date : '9999-99-99').localeCompare(validDate(b.date) ? b.date : '9999-99-99') || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
  for (const row of ordered) {
    const company = companyById.get(row.supplierId ?? '');
    const fieldInn = innText(row.fields.supplier_inn), companyInn = innText(company?.inn), chosenInn = fieldInn ?? companyInn;
    const issues: string[] = [];
    if (!chosenInn || !validInn(chosenInn) || companyInn && !validInn(companyInn)) issues.push('ИНН поставщика отсутствует или некорректен. Автоматическая оплата недоступна.');
    if (fieldInn && companyInn && fieldInn !== companyInn) issues.push('ИНН отгрузки не совпадает с ИНН поставщика в справочнике.');
    const inn = issues.length ? null : chosenInn;
    const key = inn ? `inn:${inn}` : row.supplierId ? `company:${row.supplierId}` : `shipment:${row.id}`;
    const group = groupFor(key, inn, company?.name ?? row.supplier ?? 'Поставщик не указан', row.supplierId);
    const value = decimal(Object.hasOwn(row.fields, 'purchase_amount') ? row.fields.purchase_amount : row.cost);
    const amount = value && value.gte(0) ? value.toFixed() : null;
    if (amount === null) issues.push('Сумма закупки неизвестна или некорректна.');
    if (!validDate(row.date)) issues.push('Дата закупки неизвестна. Укажите дату для очереди оплаты.');
    group.shipments.push({ id: row.id, date: row.date, number: row.fields.document_number ?? null, amount, openingPaid: '0', bankPaid: '0', paid: '0', debt: amount, issue: issues.join(' ') || null });
    group.issues = [...new Set([...group.issues, ...issues])];
    if (!issues.length) eligible.add(row.id);
  }
  const review: SettlementReview[] = [];
  for (const row of operations) {
    if (row.direction !== 'outgoing') continue;
    const reject = (reason: string) => review.push(bankReview(row, reason));
    if (!row.booked) { reject('Банк не подтвердил проведение оплаты поставщику.'); continue; }
    if (!['RUB', 'RUR', '643', '810'].includes(row.currency)) { reject('Оплата в другой валюте не распределяется на рублёвые закупки.'); continue; }
    const amount = decimal(row.amount);
    if (!amount || !amount.gt(0)) { reject('Сумма оплаты поставщику должна быть положительной.'); continue; }
    if (!validDate(row.statementDate)) { reject('Дата банковской оплаты некорректна.'); continue; }
    if (row.payee.account && ownAccounts.has(row.payee.account)) { reject('Перевод на собственный счёт не является оплатой поставщику.'); continue; }
    const inn = checkedInn(row.payee.inn);
    if (!inn) { reject('ИНН получателя отсутствует или некорректен.'); continue; }
    if (ownInns.has(inn)) { reject('Перевод между собственными счетами не является оплатой поставщику.'); continue; }
    if (!groups.has(`inn:${inn}`) && !suppliers.some(company => checkedInn(company.inn) === inn)) { reject('Получатель не сопоставлен с поставщиком. Проверьте справочник; списание не включено в аванс.'); continue; }
    const source = sourceFor(row), group = groupFor(`inn:${inn}`, inn, row.payee.name ?? `ИНН ${inn}`);
    const receipt: SettlementReceipt = { id: row.id, bankOperationId: row.bankOperationId, documentNumber: row.documentNumber ?? null, date: row.statementDate, bank: source.bankName, company: source.company, connectionId: row.connectionId, account: row.account, purpose: row.purpose ?? null, amount: amount.toFixed(), allocated: '0', advance: amount.toFixed(), allocations: [] };
    group.receipts.push(receipt);
  }
  for (const group of groups.values()) {
    const queue = group.shipments.filter(row => eligible.has(row.id));
    let index = 0;
    for (const receipt of group.receipts) {
      let remaining = new Exact(receipt.amount);
      while (remaining.gt(0) && index < queue.length) {
        const shipment = queue[index], debt = new Exact(shipment.debt!);
        if (!debt.gt(0)) { index++; continue; }
        const amount = Exact.min(remaining, debt);
        receipt.allocations.push({ shipmentId: shipment.id, paymentId: receipt.id, amount: amount.toFixed(), date: receipt.date });
        shipment.bankPaid = new Exact(shipment.bankPaid).plus(amount).toFixed();
        shipment.paid = shipment.bankPaid;
        shipment.debt = debt.minus(amount).toFixed();
        remaining = remaining.minus(amount);
        if (shipment.debt === '0') index++;
      }
      receipt.advance = remaining.toFixed();
      receipt.allocated = new Exact(receipt.amount).minus(remaining).toFixed();
    }
    group.shipped = sum(group.shipments.flatMap(row => row.amount === null ? [] : [row.amount]));
    group.incoming = sum(group.receipts.map(row => row.amount));
    group.allocated = sum(group.receipts.map(row => row.allocated));
    group.debt = sum(group.shipments.flatMap(row => row.debt === null ? [] : [row.debt]));
    group.advance = sum(group.receipts.map(row => row.advance));
    group.companyIds.sort();
  }
  const result = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.key.localeCompare(b.key));
  return { scope: 'all', companies: result, totals: totals(result), review, sources: [] };
}

export function buildOrganizationSettlements(shipments: Shipment[], companies: Company[], store: OperationsData): { organizations: OrganizationSettlement[]; clientAllocations: PaymentAllocation[] } {
  // Deduplicate across ALL connectors before separating organizations. Otherwise
  // one bank operation imported into two slots could be spent once per company.
  const { operations, conflicts, organizationConflicts, sources, ownAccounts, ownInns } = settlementSources(store);
  const ambiguousIdentities = new Set(organizationConflicts.map(row => JSON.stringify([row.provider, row.account, row.bankOperationId])));
  const clientAllocations: PaymentAllocation[] = [];
  const organizations = ourOrganizations.map(organization => {
    const rows = shipments.filter(row => shipmentOrganizationId(row) === organization.id);
    const review: SettlementReview[] = [];
    const active = operations.filter(row => {
      if (organizationForConnection(row.connectionId) !== organization.id) return false;
      if (ambiguousIdentities.has(JSON.stringify([row.provider, row.account, row.bankOperationId]))) return false;
      const issue = ownOrganizationIssue(row, organization.id);
      if (issue) { review.push(bankReview(row, issue)); return false; }
      return true;
    });
    for (const row of conflicts) if (organizationForConnection(row.connectionId) === organization.id) review.push(bankReview(row, 'Одна операция банка загружена через несколько подключений с разными реквизитами или суммами. Требуется сверка выписок.'));
    for (const row of organizationConflicts) if (organizationForConnection(row.connectionId) === organization.id && !review.some(item => item.id === row.id)) review.push(bankReview(row, 'Одна операция банка загружена в подключениях разных наших организаций. Принадлежность платежа требует сверки.'));
    const result = buildSettlements(rows, companies, storeWithOperations(store, active));
    const clients = result.report;
    clients.scope = 'all';
    clientAllocations.push(...result.allocations);
    addPaymentReferences(clients, active);
    const suppliers = supplierSettlements(rows, companies, active, ownAccounts, ownInns);
    clients.sources = sources.filter(source => organizationForConnection(source.id) === organization.id);
    suppliers.sources = clients.sources;
    const byId = new Map([...operations, ...conflicts, ...organizationConflicts].map(row => [row.id, row]));
    clients.review.push(...review.filter(row => byId.get(row.id)?.direction === 'incoming'));
    suppliers.review.push(...review.filter(row => byId.get(row.id)?.direction === 'outgoing'));
    return { id: organization.id, name: organization.name, clients, suppliers };
  });
  return { organizations, clientAllocations };
}

function scopeSuppliers(report: SettlementsReport, snapshot: Snapshot, actor: AccountUser): SettlementsReport {
  const visible = new Set(snapshot.shipments.filter(row => ownsShipment(actor, row, snapshot)).map(row => row.id));
  const companies = report.companies.flatMap(group => {
    const shipments = group.shipments.filter(row => visible.has(row.id));
    if (!shipments.length) return [];
    const visibleRows = snapshot.shipments.filter(row => shipments.some(item => item.id === row.id));
    const supplierIds = new Set(visibleRows.flatMap(row => row.supplierId ? [row.supplierId] : []));
    const companyIds = group.companyIds.filter(id => supplierIds.has(id));
    const name = snapshot.companies.find(company => companyIds.includes(company.id))?.name ?? visibleRows[0]?.supplier ?? 'Поставщик не указан';
    const receipts = group.receipts.flatMap(receipt => {
      const allocations = receipt.allocations.filter(row => visible.has(row.shipmentId));
      const amount = sum(allocations.map(row => row.amount));
      // A supplier is shared operational reference data, not a manager-owned
      // customer. Never expose its unrelated spending or free company advance.
      return amount === '0' ? [] : [{ ...receipt, amount, allocated: amount, advance: '0', amountIsScoped: true, purpose: null, allocations }];
    });
    return [{ ...group, name, companyIds, shipments, receipts, shipped: sum(shipments.flatMap(row => row.amount === null ? [] : [row.amount])), openingPaid: '0', incoming: sum(receipts.map(row => row.amount)), allocated: sum(receipts.map(row => row.allocated)), debt: sum(shipments.flatMap(row => row.debt === null ? [] : [row.debt])), advance: '0', issues: [...new Set([...shipments.flatMap(row => row.issue ? [row.issue] : []), 'Показаны только ваши закупки и зачтённые в них оплаты. Общий аванс поставщику доступен руководителю.'])] }];
  });
  return { scope: 'own', companies, sources: [], review: [], totals: totals(companies) };
}

export function organizationSettlementsForActor(organizations: OrganizationSettlement[], snapshot: Snapshot, actor: AccountUser | null): Pick<SettlementsReport, 'organizations' | 'unassignedShipmentCount'> {
  const all = !actor || canManage(actor);
  return {
    organizations: all ? organizations : organizations.map(organization => {
      // Without an organization relationship, an idle directory client must not
      // appear as an assigned client of both legal entities automatically.
      const represented = new Set(organization.clients.companies.flatMap(group => group.companyIds));
      const clientSnapshot = { ...snapshot, companies: snapshot.companies.filter(company => represented.has(company.id)) };
      return { ...organization, clients: scopeSettlements(organization.clients, clientSnapshot, actor!), suppliers: scopeSuppliers(organization.suppliers, snapshot, actor!) };
    }),
    unassignedShipmentCount: snapshot.shipments.filter(row => !shipmentOrganizationId(row) && (all || ownsShipment(actor!, row, snapshot))).length,
  };
}

/** Global totals remain a compatibility view. Once a client has assigned rows,
 * unassigned history cannot consume the same money again alongside org FIFO. */
export function shipmentSettlementAllocations(shipments: Shipment[], companies: Company[], store: OperationsData): PaymentAllocation[] {
  const global = buildSettlements(shipments, companies, store);
  if (!shipments.some(shipmentOrganizationId)) return global.allocations;
  const assigned = new Set(shipments.filter(shipmentOrganizationId).map(row => row.id));
  const legacyIds = new Set(global.report.companies.filter(group => !group.shipments.some(row => assigned.has(row.id))).flatMap(group => group.shipments.map(row => row.id)));
  return [...global.allocations.filter(row => legacyIds.has(row.shipmentId)), ...buildOrganizationSettlements(shipments, companies, store).clientAllocations];
}

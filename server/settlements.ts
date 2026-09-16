import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import type { BankOperation } from '../web/src/banking-model';
import type { Company, PaymentAllocation, Shipment } from '../web/src/model';
import type { SettlementCompany, SettlementReceipt, SettlementShipment, SettlementsReport } from '../web/src/settlements-model';
import { decimal, SHIPMENT_DECIMAL_PRECISION } from '../web/src/shipment-calculations';
import { validInn } from './checko';
import { validDate } from './banking/domain';
import { settlementConnections, settlementSources } from './settlement-sources';
import type { OperationsData } from './operations-store';

const Exact = Decimal.clone({ precision: SHIPMENT_DECIMAL_PRECISION });
const innText = (value: string | null | undefined) => value?.replace(/\s/g, '') || null;
const checkedInn = (value: string | null | undefined) => {
  const inn = innText(value);
  return inn && validInn(inn) ? inn : null;
};
const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new Exact(0)).toFixed();
const positivePart = (value: Decimal) => Exact.max(0, value).toFixed();
const addIssue = (group: SettlementCompany, issue: string) => { if (!group.issues.includes(issue)) group.issues.push(issue); };

/** Rebuild allocations from authoritative saved records. This never mutates storage,
 * calls a bank, or includes incomplete statement pages or archived transactions.
 * Shipments must contain their existing payments, before this bank projection.
 */
export function buildSettlements(shipments: Shipment[], companies: Company[], store: OperationsData): { report: SettlementsReport; allocations: PaymentAllocation[] } {
  const groups = new Map<string, SettlementCompany>();
  const companyById = new Map(companies.map(company => [company.id, company]));
  const companiesByInn = new Map<string, Company[]>();
  for (const company of companies) {
    const inn = checkedInn(company.inn);
    if (inn) companiesByInn.set(inn, [...companiesByInn.get(inn) ?? [], company]);
  }
  const groupFor = (key: string, inn: string | null, name: string, companyId?: string | null) => {
    let group = groups.get(key);
    if (!group) {
      const known = inn ? companiesByInn.get(inn) ?? [] : [];
      group = { key, inn, name: known[0]?.name ?? name, companyIds: known.map(company => company.id), shipped: '0', openingPaid: '0', incoming: '0', allocated: '0', debt: '0', advance: '0', issues: [], shipments: [], receipts: [] };
      groups.set(key, group);
    }
    if (companyId && !group.companyIds.includes(companyId)) group.companyIds.push(companyId);
    return group;
  };
  const eligible = new Set<string>();
  const orderedShipments = [...shipments].sort((a, b) => (validDate(a.date) ? a.date : '9999-99-99').localeCompare(validDate(b.date) ? b.date : '9999-99-99') || (a.createdAt ?? '').localeCompare(b.createdAt ?? '') || a.id.localeCompare(b.id));
  for (const row of orderedShipments) {
    const company = companyById.get(row.customerId ?? '');
    const fieldInn = innText(row.fields.customer_inn), companyInn = innText(company?.inn);
    const chosenInn = fieldInn ?? companyInn;
    const issues: string[] = [];
    if (!chosenInn) issues.push('У покупателя не указан ИНН. Автоматическая оплата недоступна.');
    else if (!validInn(chosenInn) || companyInn && !validInn(companyInn)) issues.push('ИНН покупателя некорректен. Проверьте справочник и отгрузку.');
    if (fieldInn && companyInn && fieldInn !== companyInn) issues.push('ИНН отгрузки не совпадает с ИНН покупателя в справочнике.');
    const identityValid = issues.length === 0;
    const inn = identityValid ? chosenInn : null;
    const key = inn ? `inn:${inn}` : row.customerId ? `company:${row.customerId}` : `shipment:${row.id}`;
    const group = groupFor(key, inn, company?.name ?? row.customer ?? 'Покупатель не указан', row.customerId);
    const amount = decimal(Object.hasOwn(row.fields, 'customer_amount') ? row.fields.customer_amount : row.revenue);
    const opening = decimal(row.fields.paid_amount_source);
    if (!amount || amount.lt(0)) issues.push('Сумма отгрузки неизвестна или некорректна.');
    if (!opening || opening.lt(0)) issues.push('Ранее оплаченная сумма неизвестна или некорректна. Автоматическая оплата недоступна.');
    if (!validDate(row.date)) issues.push('Дата отгрузки неизвестна. Укажите дату для очереди оплаты.');
    const knownAmount = amount && amount.gte(0) ? amount : null;
    const knownOpening = opening && opening.gte(0) ? opening : null;
    if (knownAmount && knownOpening && knownOpening.gt(knownAmount)) {
      // A historical excess may already describe an opening balance elsewhere.
      // Display it, but never spend it again on another shipment automatically.
      issues.push('Историческая переплата показана в авансе и не распределяется повторно.');
      group.advance = new Exact(group.advance).plus(knownOpening.minus(knownAmount)).toFixed();
    }
    const item: SettlementShipment = { id: row.id, date: row.date, number: row.fields.document_number ?? null, amount: knownAmount?.toFixed() ?? null, openingPaid: knownOpening?.toFixed() ?? null, bankPaid: '0', paid: knownOpening?.toFixed() ?? null, debt: knownAmount && knownOpening ? positivePart(knownAmount.minus(knownOpening)) : null, issue: issues.join(' ') || null };
    group.shipments.push(item);
    for (const issue of issues) addIssue(group, issue);
    if (identityValid && knownAmount && knownOpening && validDate(row.date) && knownOpening.lt(knownAmount)) eligible.add(row.id);
  }

  const { operations, conflicts, sources, ownAccounts, ownInns } = settlementSources(store);
  const report: SettlementsReport = { companies: [], review: [], totals: { shipped: '0', incoming: '0', debt: '0', advance: '0', allocated: '0' }, sources };
  for (const row of operations) {
    const inn = checkedInn(row.direction === 'incoming' ? row.payee.inn : row.payer.inn);
    if (inn) ownInns.add(inn);
  }
  const sourceFor = (row: BankOperation) => settlementConnections.find(connection => connection.id === row.connectionId)!;
  const review = (row: BankOperation, reason: string) => report.review.push({ id: row.id, date: row.statementDate, name: row.payer.name ?? 'Плательщик не указан', inn: innText(row.payer.inn), amount: row.amount, currency: row.currency, reason, connectionId: row.connectionId, company: sourceFor(row).company, bank: sourceFor(row).bankName, account: row.account });
  for (const row of conflicts) review(row, 'Одна операция банка загружена через несколько подключений с разными реквизитами или суммами. Требуется сверка выписок.');
  for (const row of operations) {
    if (row.direction !== 'incoming') continue;
    if (!row.booked) { review(row, 'Банк не подтвердил проведение операции.'); continue; }
    if (!['RUB', 'RUR', '643', '810'].includes(row.currency)) { review(row, 'Оплата в другой валюте не распределяется на рублёвые отгрузки.'); continue; }
    const amount = decimal(row.amount);
    if (!amount || !amount.gt(0)) { review(row, 'Сумма поступления должна быть положительной.'); continue; }
    if (!validDate(row.statementDate)) { review(row, 'Дата банковского поступления некорректна.'); continue; }
    if (row.payer.account && ownAccounts.has(row.payer.account)) { review(row, 'Перевод с собственного счёта не является оплатой покупателя.'); continue; }
    const inn = checkedInn(row.payer.inn);
    if (!inn) { review(row, 'ИНН плательщика отсутствует или некорректен.'); continue; }
    if (ownInns.has(inn)) { review(row, 'Перевод между собственными счетами не является оплатой покупателя.'); continue; }
    const group = groupFor(`inn:${inn}`, inn, row.payer.name ?? `ИНН ${inn}`);
    const source = sourceFor(row);
    const receipt: SettlementReceipt = { id: row.id, date: row.statementDate, bank: source.bankName, company: source.company, connectionId: source.id, account: row.account, purpose: row.purpose ?? null, amount: amount.toFixed(), allocated: '0', advance: amount.toFixed(), allocations: [] };
    group.receipts.push(receipt);
  }

  const allocations: PaymentAllocation[] = [];
  for (const group of groups.values()) {
    const queue = group.shipments.filter(row => eligible.has(row.id));
    let index = 0;
    for (const receipt of group.receipts) {
      let remaining = new Exact(receipt.amount);
      while (remaining.gt(0) && index < queue.length) {
        const shipment = queue[index];
        const debt = new Exact(shipment.debt!);
        if (!debt.gt(0)) { index++; continue; }
        const amount = Exact.min(remaining, debt);
        const allocation = { shipmentId: shipment.id, paymentId: receipt.id, amount: amount.toFixed(), date: receipt.date };
        receipt.allocations.push(allocation);
        allocations.push({ ...allocation, id: `bank-allocation-${createHash('sha256').update(JSON.stringify([receipt.id, shipment.id])).digest('hex')}` });
        shipment.bankPaid = new Exact(shipment.bankPaid).plus(amount).toFixed();
        shipment.paid = new Exact(shipment.openingPaid!).plus(shipment.bankPaid).toFixed();
        shipment.debt = debt.minus(amount).toFixed();
        remaining = remaining.minus(amount);
        if (shipment.debt === '0') index++;
      }
      receipt.advance = remaining.toFixed();
      receipt.allocated = new Exact(receipt.amount).minus(remaining).toFixed();
    }
    group.shipped = sum(group.shipments.flatMap(row => row.amount === null ? [] : [row.amount]));
    group.openingPaid = sum(group.shipments.flatMap(row => row.openingPaid === null ? [] : [row.openingPaid]));
    group.incoming = sum(group.receipts.map(row => row.amount));
    group.allocated = sum(group.receipts.map(row => row.allocated));
    group.debt = sum(group.shipments.flatMap(row => row.debt === null ? [] : [row.debt]));
    group.advance = sum([group.advance, ...group.receipts.map(row => row.advance)]);
    group.companyIds.sort();
  }
  report.companies = [...groups.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.key.localeCompare(b.key));
  for (const key of ['shipped', 'incoming', 'debt', 'advance', 'allocated'] as const) report.totals[key] = sum(report.companies.map(group => group[key]));
  return { report, allocations };
}

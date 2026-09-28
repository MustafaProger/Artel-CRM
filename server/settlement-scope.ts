import Decimal from 'decimal.js';
import type { AccountUser } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import type { SettlementCompany, SettlementsReport } from '../web/src/settlements-model';
import { SHIPMENT_DECIMAL_PRECISION } from '../web/src/shipment-calculations';
import { canManage } from './auth';
import { ownCustomerIds, ownsShipment } from './auth-scope';
import { validInn } from './checko';

const Exact = Decimal.clone({ precision: SHIPMENT_DECIMAL_PRECISION });
const sum = (values: string[]) => values.reduce((total, value) => total.plus(value), new Exact(0)).toFixed();
const keys = ['shipped', 'incoming', 'debt', 'advance', 'allocated'] as const;
const sharedBalanceNotice = 'Показаны только ваши отгрузки и зачтённые в них поступления. Общий аванс клиента доступен руководителю.';

/** Directory clients belong in Overview even before the first accounting event. */
export function includeIdleCustomers(report: SettlementsReport, snapshot: Snapshot): SettlementsReport {
  const companies = report.companies.map(group => ({ ...group, companyIds: [...group.companyIds] }));
  const represented = new Set(companies.flatMap(group => group.companyIds));
  for (const company of snapshot.companies) {
    if (company.directoryArchived || !company.roles.includes('customer') || represented.has(company.id)) continue;
    const candidate = company.inn?.replace(/\s/g, '') ?? '';
    const inn = validInn(candidate) ? candidate : null, key = inn ? `inn:${inn}` : `company:${company.id}`;
    const existing = companies.find(group => group.key === key);
    if (existing) existing.companyIds.push(company.id);
    else companies.push({ key, inn, name: company.name, companyIds: [company.id], shipped: '0', openingPaid: '0', incoming: '0', allocated: '0', debt: '0', advance: '0', issues: [], shipments: [], receipts: [] });
    represented.add(company.id);
  }
  companies.sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.key.localeCompare(b.key));
  return { ...report, companies };
}

/** Project the already calculated global FIFO. Re-running allocation over a subset
 * would spend the same receipt twice and change an employee's paid shipment amount.
 * A shared receipt exposes only allocations against visible shipments; neither its
 * original amount nor its other shipment references may cross the manager boundary.
 */
export function scopeSettlements(report: SettlementsReport, snapshot: Snapshot, actor: AccountUser): SettlementsReport {
  report = includeIdleCustomers(report, snapshot);
  if (canManage(actor)) return { ...report, scope: 'all' };
  const customerIds = ownCustomerIds(snapshot, actor);
  const shipmentIds = new Set(snapshot.shipments.filter(row => ownsShipment(actor, row, snapshot)).map(row => row.id));
  const companyById = new Map(snapshot.companies.map(company => [company.id, company]));
  const companies: SettlementCompany[] = [];
  for (const group of report.companies) {
    const companyIds = group.companyIds.filter(id => customerIds.has(id));
    const shipments = group.shipments.filter(row => shipmentIds.has(row.id));
    if (!companyIds.length && !shipments.length) continue;
    const shared = shipments.length !== group.shipments.length || group.companyIds.some(id =>
      !customerIds.has(id)
      || snapshot.directories?.customerManagers?.some(link => link.companyId === id && link.managerId !== actor.managerId));
    const receipts = group.receipts.flatMap(receipt => {
      const allocations = receipt.allocations.filter(allocation => shipmentIds.has(allocation.shipmentId));
      if (!shared) return [{ ...receipt, allocations }];
      const allocated = sum(allocations.map(allocation => allocation.amount));
      return allocated === '0' ? [] : [{ ...receipt, amount: allocated, allocated, advance: '0', purpose: null, allocations }];
    });
    const historicalAdvance = sum(shipments.flatMap(row => row.amount !== null && row.openingPaid !== null
      ? [Exact.max(0, new Exact(row.openingPaid).minus(row.amount)).toFixed()] : []));
    const visibleName = companyIds.map(id => companyById.get(id)?.name).find(Boolean);
    const ownShipmentName = snapshot.shipments.find(row => shipmentIds.has(row.id) && group.shipments.some(item => item.id === row.id))?.customer;
    companies.push({
      ...group, name: visibleName ?? ownShipmentName ?? 'Покупатель не указан', companyIds, shipments, receipts,
      shipped: sum(shipments.flatMap(row => row.amount === null ? [] : [row.amount])),
      openingPaid: sum(shipments.flatMap(row => row.openingPaid === null ? [] : [row.openingPaid])),
      incoming: sum(receipts.map(row => row.amount)), allocated: sum(receipts.map(row => row.allocated)),
      debt: sum(shipments.flatMap(row => row.debt === null ? [] : [row.debt])),
      advance: sum([historicalAdvance, ...receipts.map(row => row.advance)]),
      issues: [...new Set([...shipments.flatMap(row => row.issue ? [row.issue] : []), ...(shared ? [sharedBalanceNotice] : [])])],
    });
  }
  companies.sort((a, b) => a.name.localeCompare(b.name, 'ru') || a.key.localeCompare(b.key));
  return { scope: 'own', companies, sources: [], review: [], totals: Object.fromEntries(keys.map(key => [key, sum(companies.map(company => company[key]))])) as SettlementsReport['totals'] };
}

import type { Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { currentSnapshot } from './shipment-operations';

/** One-off maintenance only. Keep companies needed by payments, work and other roles. */
export function prepareCustomerShipmentCleanup(base: Snapshot, original: OperationsData, now = new Date().toISOString()) {
  const data = structuredClone(original);
  const before = currentSnapshot(base, data);
  const targets = before.companies.filter(company => company.roles.includes('customer'));
  data.directories = structuredClone(before.directories!);
  const ids = new Set(targets.map(company => company.id));
  if (data.directories.customerManagers) data.directories.customerManagers = data.directories.customerManagers.filter(row => !ids.has(row.companyId));
  if (data.directories.assignedCustomerIds) data.directories.assignedCustomerIds = data.directories.assignedCustomerIds.filter(id => !ids.has(id));
  for (const row of before.shipments) {
    data.shipments[row.id] = { fields: { ...row.fields }, version: (row.version ?? 0) + 1, createdAt: row.createdAt ?? now, updatedAt: now, deleted: true };
  }
  data.paymentAllocations = [];
  for (const company of targets) {
    const roles = company.roles.filter(role => role !== 'customer');
    const updated = { ...company, roles, ...(!roles.some(role => ['supplier', 'carrier'].includes(role)) ? { directoryArchived: true } : {}), version: (company.version ?? 0) + 1 };
    const index = data.companies.findIndex(row => row.id === company.id);
    if (index < 0) data.companies.push(updated); else data.companies[index] = updated;
  }
  const after = currentSnapshot(base, data);
  if (after.shipments.length || after.companies.some(company => company.roles.includes('customer'))) throw new Error('Cleanup did not remove all customers and shipments');
  return { data, removed: { shipments: before.shipments.length, customers: targets.filter(company => !company.directoryArchived).length, archivedCustomerRoles: targets.filter(company => company.directoryArchived).length, paymentAllocations: original.paymentAllocations?.length ?? 0 } };
}

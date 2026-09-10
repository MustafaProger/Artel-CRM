import type { Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { currentSnapshot } from './shipment-operations';
import { deleteDirectoryEntry } from './directory-deletion';

/** Prepare the complete change on a copy. Any external dependency cancels the whole cleanup. */
export function prepareDirectoryCleanup(base: Snapshot, original: OperationsData) {
  const data = structuredClone(original);
  let snapshot = currentSnapshot(base, data);
  const catalog = snapshot.directories!;
  const targets = snapshot.companies.filter(company => company.roles.some(role => ['customer','supplier'].includes(role)));
  const counts = { customers: targets.filter(company => company.roles.includes('customer')).length, suppliers: targets.filter(company => company.roles.includes('supplier')).length, managers: catalog.managers.length, products: catalog.products.length, vehicles: catalog.vehicles.length, drivers: catalog.drivers.length };
  data.directories = structuredClone(catalog);
  delete data.directories.assignedCustomerIds;
  // These relations belong to the cleared directories. Documents, accounts and work are untouched.
  data.directories.customerManagers = [];
  snapshot = currentSnapshot(base, data);
  const remove = (kind: string, id: string, version: number) => {
    deleteDirectoryEntry(kind, id, { version }, snapshot, data);
    snapshot = currentSnapshot(base, data);
  };
  for (const address of catalog.addresses.filter(address => targets.some(company => company.id === address.companyId))) remove('addresses', address.id, address.version ?? 0);
  for (const kind of ['drivers', 'vehicles', 'managers', 'products'] as const) for (const row of catalog[kind]) remove(kind, row.id, row.version ?? 0);
  for (const target of targets) for (const [role, kind] of [['customer','customers'],['supplier','suppliers']] as const) {
    const company = snapshot.companies.find(company => company.id === target.id);
    if (company?.roles.includes(role)) remove(kind, company.id, company.version ?? 0);
  }
  return { data, counts };
}

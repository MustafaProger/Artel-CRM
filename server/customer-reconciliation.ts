import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import type { Company, Snapshot } from '../web/src/model';
import { ApiError } from './api-error';
import { validInn } from './checko';
import { encodeOperations, type OperationsData, type OperationsStorage } from './operations-store';

export interface CustomerReconciliationPlan {
  revision: number;
  fingerprint: string;
  counts: { importedShipments: number; referencedCustomers: number; missingCustomerReferences: number; active: number; restore: number; create: number; unresolvedCustomers: number };
  restoreIds: string[];
  createCards: Company[];
  unresolved: { shipmentIds: string[]; customerId: string | null; reason: string }[];
}
const fingerprint = (data: OperationsData) => createHash('sha256').update(encodeOperations(data)).digest('hex');

/** Plan only against shipments already present in this dataset. Never imports operations. */
export function planCustomerReconciliation(base: Snapshot, data: OperationsData): CustomerReconciliationPlan {
  const sources = new Map(base.shipments.map(row => [row.id, row]));
  const rows: { id: string; customerId: string | null }[] = [];
  const unresolved: CustomerReconciliationPlan['unresolved'] = [];
  if (!data.sourceOperationsCleared) for (const row of base.shipments) if (!data.shipments[row.id]) rows.push({ id: row.id, customerId: row.customerId });
  for (const [id, override] of Object.entries(data.shipments)) {
    if (override.deleted) continue;
    const original = sources.get(id) ?? (id.startsWith('shipment-local-source-') ? sources.get(id.slice('shipment-local-source-'.length)) : undefined);
    if (!original) {
      if (id.startsWith('shipment-local-source-')) unresolved.push({ shipmentIds: [id], customerId: override.fields.customer_id ?? null, reason: 'unknown-source-shipment' });
      continue;
    }
    // Explicit saved identity wins; never reconstruct a replaced customer's ID from its name.
    const customerId = Object.hasOwn(override.fields, 'customer_id') ? override.fields.customer_id : override.fields.customer_name === original.fields.customer_name ? original.customerId : null;
    rows.push({ id, customerId });
  }
  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    if (!row.customerId) unresolved.push({ shipmentIds: [row.id], customerId: null, reason: 'missing-customer-reference' });
    else grouped.set(row.customerId, [...(grouped.get(row.customerId) ?? []), row.id]);
  }
  const cards = new Map(base.companies.map(company => [company.id, company]));
  for (const company of data.companies) cards.set(company.id, company);
  const restoreIds: string[] = [], createCards: Company[] = [];
  let active = 0;
  for (const [id, shipmentIds] of [...grouped].sort(([a], [b]) => a.localeCompare(b))) {
    if (data.directories?.deletedEntries?.companies?.includes(id)) {
      unresolved.push({ shipmentIds, customerId: id, reason: 'deleted-card-requires-review' }); continue;
    }
    const card = cards.get(id);
    if (card) { if (card.directoryArchived) restoreIds.push(id); else active++; continue; }
    const evidence = base.shipments.filter(row => row.customerId === id);
    const names = [...new Set(evidence.map(row => row.customer?.trim()).filter((name): name is string => !!name))];
    const inns = [...new Set(evidence.flatMap(row => row.fields.customer_inn ? [row.fields.customer_inn] : []))];
    if (names.length !== 1 || inns.length > 1 || inns.some(inn => !validInn(inn))) {
      unresolved.push({ shipmentIds, customerId: id, reason: 'insufficient-or-conflicting-source-details' }); continue;
    }
    if (inns[0] && [...cards.values(), ...createCards].some(company => company.inn === inns[0] && company.id !== id)) {
      unresolved.push({ shipmentIds, customerId: id, reason: 'tax-id-belongs-to-another-card-review-required' }); continue;
    }
    createCards.push({ id, name: names[0], ...(inns[0] ? { inn: inns[0] } : {}), roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [], version: 1 });
  }
  return { revision: data.revision, fingerprint: fingerprint(data), counts: { importedShipments: rows.length, referencedCustomers: grouped.size, missingCustomerReferences: rows.filter(row => !row.customerId).length, active, restore: restoreIds.length, create: createCards.length, unresolvedCustomers: unresolved.filter(row => row.customerId !== null).length }, restoreIds, createCards, unresolved };
}

export async function reconcileCustomers(store: OperationsStorage, base: Snapshot, expected: Pick<CustomerReconciliationPlan, 'revision' | 'fingerprint'>, authorize?: (data: OperationsData) => void) {
  let expectedAfter: OperationsData | undefined;
  const result = await store.mutate(base.provenance.sourceSha256, async data => {
    authorize?.(data);
    if (data.revision !== expected.revision || fingerprint(data) !== expected.fingerprint) throw new ApiError(409, 'Данные изменились. Повторите предварительную сверку.');
    const plan = planCustomerReconciliation(base, data);
    if (!plan.restoreIds.length && !plan.createCards.length) return { result: { plan, backup: null as string | null, changed: false }, changed: false };
    if (!store.backup) throw new ApiError(503, 'Проверенная резервная копия обязательна.');
    const backup = await store.backup(data);
    for (const id of plan.restoreIds) {
      const index = data.companies.findIndex(company => company.id === id);
      const previous = index >= 0 ? data.companies[index] : base.companies.find(company => company.id === id)!;
      const restored = { ...previous, directoryArchived: false, version: (previous.version ?? 0) + 1 };
      if (index >= 0) data.companies[index] = restored; else data.companies.push(restored);
    }
    data.companies.push(...plan.createCards);
    expectedAfter = structuredClone(data); expectedAfter.revision++;
    return { result: { plan, backup, changed: true }, changed: true };
  });
  const saved = await store.read(base.provenance.sourceSha256);
  if (expectedAfter && !isDeepStrictEqual(saved, expectedAfter)) throw new ApiError(409, 'Запись выполнена, но данные изменились до контрольного чтения. Сверьте резервную копию и повторите проверку; не перезаписывайте базу.');
  const after = planCustomerReconciliation(base, saved);
  if (result.changed && (after.restoreIds.length || after.createCards.length)) throw new Error('Reconciliation verification failed');
  return { ...result, after, verified: true };
}

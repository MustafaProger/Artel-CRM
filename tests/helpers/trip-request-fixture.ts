import { randomUUID } from 'node:crypto';
import type { OperationsStore } from '../../server/operations-store';
import type { Snapshot } from '../../web/src/model';
import { currentSnapshot } from '../../server/shipment-operations';
import { saveTripRequest } from '../../server/trip-requests';

/** Explicit synthetic setup for older authenticated trip tests after requests became required.
 * Leaves malformed/foreign inputs to the real API and keeps the same IDs for retry tests.
 * New request contract tests do not use this helper.
 */
const preparations = new WeakMap<object, Promise<void>>();
export function prepareTripRequestFixture(store: OperationsStore, base: Snapshot, input: unknown): Promise<void> {
  if (!input || typeof input !== 'object') return Promise.resolve();
  const existing = preparations.get(input); if (existing) return existing;
  const pending = prepare(store, base, input); preparations.set(input, pending); return pending;
}
async function prepare(store: OperationsStore, base: Snapshot, input: unknown) {
  if (!input || typeof input !== 'object' || !('customers' in input) || !Array.isArray(input.customers)) return;
  const customers = input.customers as { id?: string; sourceRequestId?: string; sourceRequestVersion?: number; fields?: Record<string, string | null> }[];
  const newRows = customers.filter(row => !row.id && !row.sourceRequestId && row.fields?.customer_id);
  if (!newRows.length) return;
  await store.mutate(base.provenance.sourceSha256, data => {
    const snapshot = currentSnapshot(base, data);
    if (newRows.some(row => !snapshot.companies.some(company => company.id === row.fields!.customer_id && company.roles.includes('customer')))) return { changed: false, result: null };
    for (const row of newRows) {
      const fields = row.fields!;
      const customerId = fields.customer_id!;
      let addressId = fields.unloading_address_id;
      if (!addressId) {
        addressId = `qa-request-place-${customerId}`;
        if (!data.directories!.addresses.some(address => address.id === addressId)) data.directories!.addresses.push({ id: addressId, companyId: customerId, kind: 'delivery', name: 'Учебная площадка', address: 'Синтетический адрес заявки' });
        fields.unloading_address_id = addressId;
      }
      if (!data.directories!.addresses.some(address => address.id === addressId && address.companyId === customerId && address.kind === 'delivery')) continue;
      const quantity = fields.quantity_litres && /^\d+(?:\.\d{1,6})?$/.test(fields.quantity_litres) && Number(fields.quantity_litres) > 0 ? fields.quantity_litres : '1';
      const { request } = saveTripRequest(data, currentSnapshot(base, data), null, { companyId: customerId, addressId, quantityLitres: quantity, comment: fields.delivery_notes || '', idempotencyKey: randomUUID() });
      row.sourceRequestId = request.id; row.sourceRequestVersion = request.version;
    }
    return { changed: true, result: null };
  });
}

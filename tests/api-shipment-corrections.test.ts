import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { loadSnapshot } from '../server/local-api';
import { currentSnapshot, prepareShipmentFields } from '../server/shipment-operations';
import { emptyDirectories, addDirectoryEntry } from '../server/directory-operations';
import { OperationsStore, type OperationsData } from '../server/operations-store';
import { saveShipmentTrip } from '../server/shipment-trips';
import { calculateShipment, daysSinceShipment, today } from '../web/src/shipment-calculations';
import { shipmentTemplates } from '../web/src/shipment-templates';
import { customerManagerId } from '../web/src/customer-manager';

const base = await loadSnapshot();
const empty = (): OperationsData => ({ schemaVersion: 2, sourceSha256: base.provenance.sourceSha256, revision: 0, shipments: {}, companies: [], directories: emptyDirectories(), paymentAllocations: [] });

test('Excel profit handles both branches, KVP, expenses, rounding, zero and losses', () => {
  const rules = { sale: 'litres', purchase: 'tonnes', profit: 'excel-rounded', debtSign: 'paid-minus-sale' } as const;
  const input = { quantity_litres: '1', quantity_tonnes: '1', sale_price_per_litre: '1200', purchase_price_unspecified_unit: '1000', transport_amount: '10', kvp_source: '2', additional_costs: '5' };
  for (const [sale, expense, expected] of [['1200', '5', '183'], ['900', '5', '53'], ['1200.5', '5', '184'], ['1200', '188', '0'], ['1200', '188.5', '-1'], ['700', '5', '-147']]) {
    const result = calculateShipment({ ...input, sale_price_per_litre: sale, additional_costs: expense }, rules);
    assert.equal(result.fields.profit_source, expected);
    assert.deepEqual(result.warnings, []);
  }
});

test('elapsed days hide fully paid shipments and retain calendar date boundaries', () => {
  assert.equal(daysSinceShipment('2026-09-01T00:00:00', '2026-09-10'), '9');
  assert.equal(daysSinceShipment('2026-09-10', '2026-09-10'), '0');
  assert.equal(daysSinceShipment('2026-09-11', '2026-09-10'), '0');
  assert.equal(daysSinceShipment('2024-02-28', '2024-03-01'), '2');
  for (const date of [null, '', '0', '2026-02-30']) assert.equal(daysSinceShipment(date, '2026-09-10'), null);
  const input = { date: '2026-09-01', customer_amount: '100', paid_amount_source: '100', payment_date: '2026-09-02', payment_due_date: '2026-10-01' };
  const rules = { sale: null, purchase: null, profit: null, debtSign: 'paid-minus-sale' } as const;
  assert.equal(calculateShipment(input, rules, { historical: true, asOf: '2026-09-10' }).fields.days_since_shipment, null);
  assert.equal(calculateShipment({ ...input, paid_amount_source: null }, rules, { historical: true, asOf: '2026-09-10' }).fields.days_since_shipment, '9');
  for (const template of Object.values(shipmentTemplates)) {
    assert.equal(template.columns.filter(column => column.key === 'carrier_name').length, 1);
    assert.ok(template.columns.some(column => column.key === 'days_since_shipment'));
    assert.ok(!template.columns.some(column => ['driver_name', 'payment_due_date', 'overdue_days', 'term_source'].includes(column.key)));
  }
  assert.ok(!shipmentTemplates.reduced.columns.some(column => column.key === 'vehicle_plate'));
  assert.ok(shipmentTemplates.expanded.columns.some(column => column.key === 'vehicle_plate'));
});

test('customer manager assignments persist, can be changed or removed, and populate truck customers on the server', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-customer-managers-'));
  try {
    const store = new OperationsStore(directory);
    const snapshot = currentSnapshot(base, empty()), catalog = snapshot.directories!;
    const customer = snapshot.companies[0], other = snapshot.companies[1];
    const first = catalog.managers[0], second = catalog.managers[1];
    const assign = (companyId: string, managerId: string | null) => store.mutate(base.provenance.sourceSha256, data => {
      const result = addDirectoryEntry({ kind: 'customerManagers', companyId, managerId }, currentSnapshot(base, data), data);
      return { result, changed: result.created };
    });
    assert.equal((await assign(customer.id, first.id)).created, true);
    assert.equal((await assign(customer.id, first.id)).created, false);
    assert.equal((await assign(customer.id, second.id)).created, true);
    await assign(other.id, first.id);
    await assert.rejects(assign('missing', first.id), /клиента/);
    await assert.rejects(assign(customer.id, 'missing'), /менеджера/);
    const data = await new OperationsStore(directory).read(base.provenance.sourceSha256);
    assert.equal(data.directories!.customerManagers!.length, 2);
    const loaded = currentSnapshot(base, data);
    assert.equal(customerManagerId(loaded.directories!, customer.id), second.id);
    const created = saveShipmentTrip(base, data, {
      fields: { date: '2026-09-01', supplier_id: snapshot.companies[2].id, purchase_price_unspecified_unit: '60000', quantity_tonnes: '16', product_id: catalog.products[0].id, driver_id: catalog.drivers[0].id, additional_costs: '1600' },
      customers: [customer, other].map((company, index) => ({ fields: { customer_id: company.id, payment_form_id: catalog.paymentForms[0].id, quantity_litres: index ? '6000' : '10000', sale_price_per_litre: '65', transport_amount: index ? '600' : '1000' } })),
    });
    assert.deepEqual(created.shipments.map(row => row.fields.manager_id), [second.id, first.id]);
    assert.deepEqual(created.shipments.map(row => row.fields.profit_source), ['48000', '28800']);
    assert.ok(created.shipments.every(row => row.fields.days_since_shipment === daysSinceShipment('2026-09-01', today())));
    const previous = created.shipments[0];
    const legacy = loaded.shipments.find(row => row.customerId !== customer.id)!;
    assert.equal(prepareShipmentFields({ customer_id: customer.id }, legacy, loaded).manager_id, second.id);
    await assign(customer.id, null);
    const unassigned = currentSnapshot(base, await store.read(base.provenance.sourceSha256));
    assert.equal(customerManagerId(unassigned.directories!, customer.id), '');
    assert.equal(previous.fields.manager_id, second.id);
    assert.throws(() => prepareShipmentFields({ customer_id: customer.id }, legacy, unassigned), /менеджера/);
    assert.deepEqual(unassigned.shipments.map(row => row.manager), loaded.shipments.map(row => row.manager));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('existing automatic rows with no selected profit rule recalculate on read without overwriting imported values', () => {
  const data = empty();
  data.directories!.defaults.profit = null;
  const snapshot = currentSnapshot(base, data), catalog = snapshot.directories!;
  assert.equal(catalog.defaults.profit, 'template-payment-form');
  const originalProfits = base.shipments.map(row => row.fields.profit_source);
  assert.deepEqual(snapshot.shipments.map(row => row.fields.profit_source), originalProfits);
  const result = prepareShipmentFields({ date: '2026-09-01', customer_id: snapshot.companies[0].id, supplier_id: snapshot.companies[1].id, manager_id: catalog.managers[0].id, product_id: catalog.products[0].id, payment_form_id: catalog.paymentForms[0].id, quantity_litres: '1000', quantity_tonnes: '1', purchase_unit: 'tonnes', sale_price_per_litre: '70', purchase_price_unspecified_unit: '80000', transport_amount: '1000', additional_costs: '100' }, undefined, snapshot);
  data.shipments['shipment-local-existing'] = { fields: { ...result, profit_rule: null, profit_source: null }, version: 1, createdAt: '2026-09-01', updatedAt: '2026-09-01' };
  const updated = currentSnapshot(base, data);
  assert.equal(updated.shipments.find(row => row.id === 'shipment-local-existing')!.fields.profit_source, '-11100');
});

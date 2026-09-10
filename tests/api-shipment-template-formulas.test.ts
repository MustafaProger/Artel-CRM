import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { calculateShipment, TEMPLATE_PROFIT_RULE, unpaidShipmentDays } from '../web/src/shipment-calculations';
import { createSnapshotMiddleware, loadSnapshot } from './test-api';
import { currentSnapshot, prepareShipmentFields } from '../server/shipment-operations';
import { emptyDirectories } from '../server/directory-operations';
import { OperationsStore, type OperationsData } from '../server/operations-store';
import type { Shipment, Snapshot } from '../web/src/model';

const rules = { sale: 'litres', purchase: 'tonnes', profit: TEMPLATE_PROFIT_RULE, debtSign: 'paid-minus-sale' } as const;
const input = { date: '2026-09-01', quantity_litres: '20000', quantity_tonnes: '16', sale_price_per_litre: '50', purchase_price_unspecified_unit: '56250', transport_amount: '40000', additional_costs: '10000', payment_form: 'б/нал' };
const base = await loadSnapshot();
const empty = (): OperationsData => ({ schemaVersion: 2, sourceSha256: base.provenance.sourceSha256, revision: 0, shipments: {}, companies: [], directories: emptyDirectories(), paymentAllocations: [] });

test('template profit uses payment form for both profitable and loss-making purchase totals, with f2 as cashless', () => {
  for (const [price, expected] of [ ['56250', ['50000', '203000', '50000']], ['68750', ['-150000', '37000', '-150000']] ] as const) {
    for (const [index, payment_form] of ['б/нал', 'нал', 'ф2'].entries()) {
      const result = calculateShipment({ ...input, purchase_price_unspecified_unit: price, payment_form }, rules);
      assert.equal(result.fields.profit_source, expected[index], `${payment_form}, purchase price ${price}`);
      assert.equal(result.fields.customer_amount, '1000000');
      assert.equal(result.fields.sale_price_per_tonne, '62500');
      assert.deepEqual(result.warnings, []);
    }
  }
  for (const payment_form of [' НАЛ ', 'наличные', 'cash']) assert.equal(calculateShipment({ ...input, payment_form }, rules).fields.profit_source, '203000');
  for (const payment_form of ['Б / НАЛ', 'безнал', 'cashless', 'F2']) assert.equal(calculateShipment({ ...input, payment_form }, rules).fields.profit_source, '50000');
  const unknown = calculateShipment({ ...input, payment_form: 'неизвестно' }, rules);
  assert.equal(unknown.fields.profit_source, null);
  assert.equal(unknown.warnings.length, 1);
});

test('template retains fractional rubles and deducts a single explicit expense or legacy KVP fallback', () => {
  const fields = { ...input, quantity_litres: '1', quantity_tonnes: '1', sale_price_per_litre: '100', purchase_price_unspecified_unit: '50.5', transport_amount: '0', additional_costs: '0' };
  assert.equal(calculateShipment(fields, rules).fields.profit_source, '49.5');
  assert.equal(calculateShipment({ ...fields, sale_price_per_litre: '50' }, rules).fields.profit_source, '-0.5');
  assert.equal(calculateShipment({ ...fields, payment_form: 'нал' }, rules).fields.profit_source, '58.085');
  assert.equal(calculateShipment({ ...input, kvp_source: '10000' }, rules).fields.profit_source, '50000');
  assert.equal(calculateShipment({ ...input, additional_costs: null, kvp_source: '10000' }, rules).fields.profit_source, '50000');
  assert.equal(calculateShipment({ ...input, additional_costs: '0', kvp_source: '10000' }, rules).fields.profit_source, '60000');
});

test('shipment days remain for unpaid and partial payments, disappear on full payment and return when debt increases', () => {
  const allocation = (amount: string) => ({ id: 'allocation', shipmentId: 'shipment', paymentId: 'payment', amount, date: '2026-09-03' });
  for (const [amount, days, debt] of [['0', '9', '-1000000'], ['400000', '9', '-600000'], ['1000000', null, '0'], ['1000001', null, '1']] as const) {
    const result = calculateShipment(input, rules, { allocations: [allocation(amount)], asOf: '2026-09-10' }).fields;
    assert.equal(result.days_since_shipment, days);
    assert.equal(result.debt_overpayment_source, debt);
  }
  const increased = calculateShipment({ ...input, sale_price_per_litre: '51' }, rules, { allocations: [allocation('1000000')], asOf: '2026-09-10' }).fields;
  assert.equal(increased.days_since_shipment, '9');
  assert.equal(unpaidShipmentDays('2026-09-01', '100', null, '2026-09-10'), '9');
});

test('all automatic rows adopt template profit on read, while imported amounts and stored records remain intact', () => {
  const data = empty();
  data.directories!.defaults.profit = 'excel-rounded';
  const snapshot = currentSnapshot(base, data), catalog = snapshot.directories!;
  const manual = Object.fromEntries(Object.entries(input).filter(([key]) => key !== 'payment_form'));
  const prepared = prepareShipmentFields({ ...manual, purchase_unit: 'tonnes', customer_id: snapshot.companies[0].id, supplier_id: snapshot.companies[1].id, manager_id: catalog.managers[0].id, product_id: catalog.products[0].id, payment_form_id: catalog.paymentForms.find(p => p.name === 'нал')!.id }, undefined, snapshot);
  for (const [index, rule] of [null, 'excel-rounded', 'excel-exact'].entries()) data.shipments[`shipment-local-rule-${index}`] = { fields: { ...prepared, profit_rule: rule, profit_source: 'wrong-old-value' }, version: 1, createdAt: '2026-09-01', updatedAt: '2026-09-01' };
  const before = structuredClone(data);
  const updated = currentSnapshot(base, data);
  assert.deepEqual(data, before);
  for (const row of updated.shipments.filter(row => row.id.startsWith('shipment-local-rule-'))) {
    assert.equal(row.fields.profit_source, '203000');
    assert.equal(row.fields.profit_rule, TEMPLATE_PROFIT_RULE);
  }
  assert.deepEqual(updated.shipments.filter(row => row.sourceRow).map(row => row.fields.profit_source), base.shipments.map(row => row.fields.profit_source));
});

test('editing only historical payment form switches profit to template and carries KVP once without replacing source sums', () => {
  const snapshot = currentSnapshot(base, empty());
  const previous = snapshot.shipments.find(row => row.fields.kvp_source === '8500')!;
  assert.ok(previous);
  const cash = snapshot.directories!.paymentForms.find(p => p.name === 'нал')!;
  const result = prepareShipmentFields({ payment_form_id: cash.id }, previous, snapshot);
  assert.equal(result.profit_rule, TEMPLATE_PROFIT_RULE);
  assert.equal(result.additional_costs, previous.fields.additional_costs ?? '8500');
  assert.equal(result.customer_amount, previous.fields.customer_amount);
  assert.equal(result.purchase_amount, previous.fields.purchase_amount);
  assert.equal(result.kvp_source, '8500');
  const expected = calculateShipment({ ...previous.fields, payment_form: 'нал', additional_costs: result.additional_costs }, rules, { historical: true, recalculate: true, changedFields: ['payment_form_id'] });
  assert.equal(result.profit_source, expected.fields.profit_source);
});

test('HTTP payment-only edits recalculate and survive reload; full payment hides elapsed days', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-template-formulas-'));
  const middleware = createSnapshotMiddleware(undefined, { operationsDirectory: directory });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (method: string, path: string, body?: unknown) => {
    const response = await fetch(url + path, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    assert.ok(response.ok, JSON.stringify(value));
    return value;
  };
  try {
    const snapshot: Snapshot = await request('GET', '/api/snapshot?shipments=omit');
    const catalog = snapshot.directories!;
    const fields = { ...input, purchase_unit: 'tonnes', customer_id: snapshot.companies[0].id, supplier_id: snapshot.companies[1].id, manager_id: catalog.managers[0].id, product_id: catalog.products[0].id, payment_form_id: catalog.paymentForms.find(p => p.name === 'б/нал')!.id };
    const { payment_form: _paymentForm, ...payload } = fields;
    void _paymentForm;
    let row: Shipment = (await request('POST', '/api/shipments', { fields: payload })).shipment;
    assert.equal(row.fields.profit_source, '50000');
    for (const [name, expected] of [['нал', '203000'], ['ф2', '50000'], ['б/нал', '50000']]) {
      row = (await request('PATCH', `/api/shipments/${row.id}`, { version: row.version, fields: { payment_form_id: catalog.paymentForms.find(p => p.name === name)!.id } })).shipment;
      assert.equal(row.fields.profit_source, expected);
      assert.equal((await request('GET', `/api/shipments/${row.id}`)).shipment.fields.profit_source, expected);
    }
    const store = new OperationsStore(directory);
    await store.mutate(base.provenance.sourceSha256, data => {
      data.paymentAllocations!.push({ id: 'full-payment', shipmentId: row.id, paymentId: base.payments[0].id, amount: '1000000', date: '2026-09-10' });
      return { result: null, changed: true };
    });
    const paid = (await request('GET', `/api/shipments/${row.id}`)).shipment;
    assert.equal(paid.fields.days_since_shipment, null);
    assert.equal(paid.fields.debt_overpayment_source, '0');
    const saved = await new OperationsStore(directory).read(base.provenance.sourceSha256);
    assert.equal(saved.shipments[row.id].fields.profit_rule, TEMPLATE_PROFIT_RULE);
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(directory, { recursive: true, force: true });
  }
});

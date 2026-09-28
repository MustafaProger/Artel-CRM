import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createSnapshotMiddleware, loadSnapshot } from './test-api';
import type { Shipment, ShipmentTripResponse, Snapshot } from '../web/src/model';
import { shipmentOrganizationId } from '../web/src/our-organizations';
import { fieldValue } from '../web/src/shipment-templates';

const source = await loadSnapshot();
async function serve(directory: string) {
  const middleware = createSnapshotMiddleware(undefined, { operationsDirectory: directory });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = async <T>(path: string) => (await (await fetch(url + path)).json()) as T;
  const snapshot = await get<Snapshot>('/api/snapshot?shipments=omit');
  const catalog = snapshot.directories!;
  const request = (method: string, path: string, body: unknown) => fetch(url + path, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const close = () => new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
  const sample = (organizationId?: string) => ({ shipment_type: 'azs', date: '2029-06-01', ...(organizationId === undefined ? {} : { organization_id: organizationId }), customer_id: source.companies.find(row => row.roles.includes('customer'))!.id, supplier_id: source.companies.find(row => row.roles.includes('supplier'))!.id, manager_id: catalog.managers[0].id, product_id: catalog.products[0].id, payment_form_id: catalog.paymentForms.find(entry => entry.name === 'б/нал')!.id, quantity_litres: '1000', customer_amount: '80000', purchase_amount: '70000' });
  return { get, request, close, sample, catalog };
}

test('explicit organization survives save and restart; page totals, facets and search use its scope', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-shipment-organizations-'));
  let runtime = await serve(directory);
  try {
    const created: Shipment[] = [];
    for (const organization of ['nk-artel', 'artel', undefined]) {
      const response = await runtime.request('POST', '/api/shipments', { fields: runtime.sample(organization) });
      assert.equal(response.status, 201, await response.clone().text());
      created.push((await response.json()).shipment);
    }
    assert.deepEqual(created.map(shipmentOrganizationId), ['nk-artel', 'artel', null]);
    assert.deepEqual(created.map(row => fieldValue(row, 'organization_id')), ['НК АРТЕЛЬ', 'АРТЕЛЬ', null]);
    for (const [index, organization] of ['nk-artel', 'artel', 'unassigned'].entries()) {
      const page = await runtime.get<{ items: Shipment[]; total: number; summary: { revenue: { total: string }; cost: { total: string } }; facetValues: string[] }>(`/api/shipments?period=2029-06&organization=${organization}&facet=organization_id`);
      assert.deepEqual(page.items.map(row => row.id), [created[index].id]);
      assert.equal(page.total, 1);
      assert.equal(page.summary.revenue.total, '80000');
      assert.equal(page.summary.cost.total, '70000');
      assert.deepEqual(page.facetValues, [fieldValue(created[index], 'organization_id') ?? '']);
    }
    const query = new URLSearchParams({ period: '2029-06', query: 'НК АРТЕЛЬ' });
    assert.deepEqual((await runtime.get<{ items: Shipment[] }>(`/api/shipments?${query}`)).items.map(row => row.id), [created[0].id]);
    await runtime.close(); runtime = await serve(directory);
    assert.equal((await runtime.get<{ shipment: Shipment }>(`/api/shipments/${created[0].id}`)).shipment.fields.organization_id, 'nk-artel');
    const changed = await runtime.request('PATCH', `/api/shipments/${created[0].id}`, { version: created[0].version, fields: { purchase_amount: '73000' } });
    assert.equal(changed.status, 200);
    assert.equal((await changed.json()).shipment.fields.organization_id, 'nk-artel');
    const historical = source.shipments.find(row => !row.fields.organization_id)!;
    assert.equal(shipmentOrganizationId((await runtime.get<{ shipment: Shipment }>(`/api/shipments/${historical.id}`)).shipment), null);
    const before = await readFile(resolve(directory, 'operations.json'), 'utf8');
    assert.equal((await runtime.request('POST', '/api/shipments', { fields: runtime.sample('some-bank') })).status, 400);
    assert.equal((await runtime.request('PATCH', `/api/shipments/${created[1].id}`, { version: created[1].version, fields: { organization_id: 'some-bank' } })).status, 400);
    assert.equal(await readFile(resolve(directory, 'operations.json'), 'utf8'), before);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

test('trip organization is shared and preserved when an older client adds customers without the new input', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-trip-organization-'));
  const runtime = await serve(directory);
  try {
    const azs = runtime.sample('artel');
    const shared = { organization_id: 'artel', date: azs.date, supplier_id: azs.supplier_id, product_id: azs.product_id, purchase_price_unspecified_unit: '60000', quantity_tonnes: '16', driver_id: runtime.catalog.drivers[0].id, additional_costs: '0' };
    const customer = { customer_id: azs.customer_id, manager_id: azs.manager_id, payment_form_id: azs.payment_form_id, quantity_litres: '1000', sale_price_per_litre: '65', transport_amount: '0' };
    const response = await runtime.request('POST', '/api/shipment-trips', { fields: shared, customers: [{ fields: customer }] });
    assert.equal(response.status, 201, await response.clone().text());
    const created = await response.json() as ShipmentTripResponse;
    assert.equal(created.trip.fields.organization_id, 'artel');
    const fields = { ...created.trip.fields }; delete fields.organization_id;
    const edited = await runtime.request('PATCH', `/api/shipment-trips/${created.trip.id}`, { fields, customers: [{ id: created.shipment.id, fields: customer }, { fields: customer }], versions: { [created.shipment.id]: created.shipment.version } });
    assert.equal(edited.status, 200, await edited.clone().text());
    const updated = await edited.json() as ShipmentTripResponse;
    assert.deepEqual(updated.shipments.map(shipmentOrganizationId), ['artel', 'artel']);
    const rejected = await runtime.request('PATCH', `/api/shipments/${updated.shipment.id}`, { version: updated.shipment.version, fields: { organization_id: 'nk-artel' } });
    assert.equal(rejected.status, 409, 'one customer cannot split the shared trip organization');
    const changed = await runtime.request('PATCH', `/api/shipment-trips/${created.trip.id}`, { fields: { ...updated.trip.fields, organization_id: 'nk-artel' }, customers: updated.trip.customers.map(({ id, fields }) => ({ id, fields })), versions: Object.fromEntries(updated.trip.customers.map(row => [row.id, row.version])) });
    assert.equal(changed.status, 200, await changed.clone().text());
    assert.deepEqual(((await changed.json()) as ShipmentTripResponse).shipments.map(shipmentOrganizationId), ['nk-artel', 'nk-artel']);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});

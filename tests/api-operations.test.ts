import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import type { AddressInfo } from 'node:net';
import Decimal from 'decimal.js';
import { createSnapshotMiddleware, loadSnapshot, type LocalApiOptions } from '../server/local-api';
import { validInn } from '../server/checko';
import { directoriesFor } from '../server/directory-operations';
import type { Company, Shipment, ShipmentsResponse, Snapshot } from '../web/src/model';
const ExactDecimal = Decimal.clone({ precision: 80 });

const dataDirectory = resolve('data/local-xlsx-final');
const source = await loadSnapshot(dataDirectory);
const customer = source.companies.find(row => row.roles.includes('customer'))!;
const supplier = source.companies.find(row => row.roles.includes('supplier'))!;
const sourceBytes = await readFile(resolve(dataDirectory, 'shipments.json'));
const digest = (value: Buffer | string) => createHash('sha256').update(value).digest('hex');

async function serve(directory: string, options: LocalApiOptions = {}) {
  const middleware = createSnapshotMiddleware(dataDirectory, { ...options, operationsDirectory: directory });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { server, url };
}
async function close(server: Server) { await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done())); }
const body = (value: unknown) => ({ headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
const catalog = directoriesFor(source,{schemaVersion:1,sourceSha256:source.provenance.sourceSha256,revision:0,shipments:{},companies:[]});
const sample = (fields: Record<string, string | null> = {}) => ({ date: '2027-02-01', customer_id: customer.id, supplier_id: supplier.id, manager_id: catalog.managers[0].id, product_id: catalog.products[0].id, payment_form_id: catalog.paymentForms.find(p=>p.name==='б/нал')!.id, quantity_litres: '0.1', quantity_tonnes: '0.0001', sale_price_per_litre: '2', purchase_price_unspecified_unit: '1', purchase_unit: 'litres', ...fields });

test('shipment CRUD persists, retains nulls/source references, and refreshes every related aggregate', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-crud-'));
  let runtime = await serve(directory);
  try {
    const managerResponse=await fetch(`${runtime.url}/api/directories`,{method:'POST',...body({kind:'managers',name:'QA новый менеджер'})});
    const managerId=(await managerResponse.json()).entry.id;
    const create = await fetch(`${runtime.url}/api/shipments`, { method: 'POST', ...body({ fields: sample({ manager_id: managerId, additional_costs: '1 000,12', payment_due_date: '2027-02-02' }) }) });
    assert.equal(create.status, 201);
    const { shipment: added } = await create.json() as { shipment: Shipment };
    assert.equal(added.version, 1);
    assert.equal(added.customerId, customer.id);
    assert.equal(added.fields.additional_costs, '1000.12');
    assert.equal(added.fields.paid_amount_source, '0');
    assert.equal(added.fields.debt_overpayment_source, '-0.2');
    assert.equal(added.fields.profit_source, null);
    const initial = await (await fetch(`${runtime.url}/api/snapshot?shipments=omit`)).json() as Snapshot;
    assert.deepEqual(initial.shipments, []);
    assert.equal(initial.overview.shipmentCount, source.shipments.length + 1);
    assert.equal(initial.overview.revenue.total, new ExactDecimal(source.overview.revenue.total!).plus('0.2').toFixed());
    assert.equal(initial.monthly.find(row => row.month === '2027-02')?.revenue.total, '0.2');
    assert.ok(initial.companies.find(row => row.id === customer.id)?.shipmentIds.includes(added.id));
    assert.equal(initial.managers.find(row => row.label === 'QA новый менеджер')?.shipmentCount, 1);
    assert.deepEqual(initial.quality, source.quality);
    const edit = await fetch(`${runtime.url}/api/shipments/${added.id}`, { method: 'PATCH', ...body({ version: 1, fields: { date: '2028-03-01', sale_price_per_litre: '3', manager_id: catalog.managers[0].id } }) });
    assert.equal(edit.status, 200);
    const changed = (await edit.json() as { shipment: Shipment }).shipment;
    assert.equal(changed.version, 2);
    assert.equal(changed.liters, '0.1');
    assert.equal(changed.fields.paid_amount_source, '0');
    assert.equal(changed.fields.debt_overpayment_source, '-0.3');
    assert.equal(changed.fields.customer_amount, '0.3');
    await close(runtime.server);
    runtime = await serve(directory);
    const reloaded = (await (await fetch(`${runtime.url}/api/shipments/${added.id}`)).json() as { shipment: Shipment }).shipment;
    assert.deepEqual(reloaded, changed);
    const updated = await (await fetch(`${runtime.url}/api/snapshot?shipments=omit`)).json() as Snapshot;
    assert.equal(updated.monthly.find(row => row.month === '2027-02'), undefined);
    assert.equal(updated.monthly.find(row => row.month === '2028-03')?.revenue.total, '0.3');
    assert.equal(updated.managers.find(row => row.label === 'QA новый менеджер'), undefined);
    const original = source.shipments.find(row => row.customerId === customer.id)!;
    const editOriginal = await fetch(`${runtime.url}/api/shipments/${original.id}`, { method: 'PATCH', ...body({ version: 0, fields: { payment_due_date: '2027-03-01' } }) });
    assert.equal(editOriginal.status, 200);
    const overridden = (await editOriginal.json() as { shipment: Shipment }).shipment;
    assert.equal(overridden.sourceRow, original.sourceRow);
    assert.equal(overridden.sourceSheet, original.sourceSheet);
    assert.equal(overridden.customerId, original.customerId);
    assert.equal(overridden.fields.profit_source, original.fields.profit_source);
    assert.equal((await fetch(`${runtime.url}/api/shipments/${added.id}`, { method: 'DELETE', ...body({ version: 2 }) })).status, 200);
    assert.equal((await fetch(`${runtime.url}/api/shipments/${added.id}`)).status, 404);
    const deleted = await (await fetch(`${runtime.url}/api/snapshot`)).json() as Snapshot;
    assert.equal(deleted.overview.shipmentCount, source.shipments.length);
    assert.equal(deleted.overview.revenue.total, source.overview.revenue.total);
    assert.ok(!deleted.companies.find(row => row.id === customer.id)?.shipmentIds.includes(added.id));
    assert.equal((await stat(resolve(directory, 'operations.json'))).mode & 0o777, 0o600);
    assert.equal(digest(await readFile(resolve(dataDirectory, 'shipments.json'))), digest(sourceBytes));
  } finally { await close(runtime.server); await rm(directory, { recursive: true, force: true }); }
});

test('pagination counts the complete filter, remains stable, separates f2 and never truncates at 20', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-page-'));
  const runtime = await serve(directory);
  try {
    const getPage = async (query: string) => await (await fetch(`${runtime.url}/api/shipments?${query}`)).json() as ShipmentsResponse;
    const page = await getPage('limit=50&offset=0');
    const metadata = await (await fetch(`${runtime.url}/api/snapshot?shipments=omit`)).json() as Snapshot;
    assert.equal(metadata.managers.length, source.managers.length);
    for (const manager of source.managers) {
      const current = metadata.managers.find(row => row.id === manager.id)!;
      assert.equal(current.shipmentCount, manager.shipmentCount);
      assert.equal(current.revenue.total, manager.revenue.total);
      assert.equal((await getPage(`manager=${encodeURIComponent(manager.label.toLocaleLowerCase('ru'))}`)).total, manager.shipmentCount);
    }
    const second = await getPage('limit=50&offset=50');
    assert.equal(page.items.length, 50); assert.equal(page.total, 2092); assert.equal(page.nextOffset, 50); assert.equal(page.hasMore, true);
    assert.equal(new Set([...page.items, ...second.items].map(row => row.id)).size, 100);
    assert.deepEqual((await getPage('limit=50')).items.map(row => row.id), page.items.map(row => row.id));
    assert.equal((await getPage('limit=9999')).items.length, 100);
    assert.equal((await getPage('offset=2091&limit=50')).hasMore, false);
    assert.equal((await getPage('offset=999999')).nextOffset, 2092);
    assert.equal(page.summary.revenue.total, source.overview.revenue.total);
    for (const [settlement, count] of [['cashless', 1337], ['cash', 317], ['f2', 358], ['unspecified', 80]]) assert.equal((await getPage(`settlement=${settlement}`)).total, count);
    const period = source.monthly[0].month;
    assert.equal((await getPage(`period=${period}`)).total, source.monthly[0].shipmentCount);
    const manager = source.managers[0];
    assert.equal((await getPage(`manager=${encodeURIComponent(manager.label)}`)).total, manager.shipmentCount);
    assert.equal((await getPage('manager=none')).total, source.shipments.filter(row => row.manager === null).length);
    assert.equal((await getPage(`companyId=${customer.id}`)).total, source.shipments.filter(row => [row.customerId, row.supplierId, row.carrierId].includes(customer.id)).length);
    assert.equal((await getPage('query=NOT-A-REAL-RECORD')).total, 0);
    assert.equal(page.summary.customerCount, new Set(source.shipments.flatMap(row => row.customerId ? [row.customerId] : [])).size);
    assert.ok(page.topCustomers.length <= 4);
    for (const query of ['offset=-1', 'limit=oops', 'period=2026-99', 'settlement=illegal']) assert.equal((await fetch(`${runtime.url}/api/shipments?${query}`)).status, 400);
  } finally { await close(runtime.server); await rm(directory, { recursive: true, force: true }); }
});

test('invalid fields and hostile requests cannot mutate data; concurrent edits use versions', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-validation-'));
  const runtime = await serve(directory);
  const second = await serve(directory);
  try {
    const id = source.shipments[0].id;
    for (const fields of [{ unknown: 'x' }, { date: '2027-02-30' }, { customer_amount: '1e1000' }, { customer_amount: 55 }, { quantity_litres: 'NaN' }, { customer_name: 'Not present' }, { customer_inn: '0000000000' }, { month: '13' }, { payment_date: 'nope' }]) assert.equal((await fetch(`${runtime.url}/api/shipments/${id}`, { method: 'PATCH', ...body({ fields }) })).status, 400);
    assert.equal((await fetch(`${runtime.url}/api/shipments`, { method: 'POST', body: '{}' })).status, 415);
    assert.equal((await fetch(`${runtime.url}/api/shipments`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{' })).status, 400);
    assert.equal((await fetch(`${runtime.url}/api/shipments`, { method: 'POST', ...body({ fields: { unlabelled_note: 'x'.repeat(140000) } }) })).status, 413);
    assert.equal((await fetch(`${runtime.url}/api/shipments/${id}`, { method: 'DELETE', headers: { Origin: 'http://example.com' } })).status, 403);
    assert.equal((await fetch(`${runtime.url}/api/shipments/${id}`, { method: 'DELETE', headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
    const responses = await Promise.all([runtime, second].map((server, index) => fetch(`${server.url}/api/shipments/${id}`, { method: 'PATCH', ...body({ version: 0, fields: { payment_due_date: `2027-03-0${index+1}` } }) })));
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 409]);
    assert.equal((await fetch(`${runtime.url}/api/shipments/${id}`, { method: 'DELETE', ...body({ version: 0 }) })).status, 409);
    const rows = await Promise.all([runtime, second].map(async server => (await (await fetch(`${server.url}/api/shipments/${id}`)).json() as { shipment: Shipment }).shipment));
    assert.deepEqual(rows[0], rows[1]);
    assert.equal(rows[0].version, 1);
    assert.equal(digest(await readFile(resolve(dataDirectory, 'shipments.json'))), digest(sourceBytes));
  } finally { await close(runtime.server); await close(second.server); await rm(directory, { recursive: true, force: true }); }
});

test('a corrupt operations store fails closed and is never overwritten', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-corrupt-store-'));
  const runtime = await serve(directory);
  try {
    const damaged = '{"data": "BROKEN';
    await writeFile(resolve(directory, 'operations.json'), damaged);
    assert.equal((await fetch(`${runtime.url}/api/snapshot`)).status, 500);
    assert.equal((await fetch(`${runtime.url}/api/shipments`, { method: 'POST', ...body({ fields: sample() }) })).status, 500);
    assert.equal(await readFile(resolve(directory, 'operations.json'), 'utf8'), damaged);
  } finally { await close(runtime.server); await rm(directory, { recursive: true, force: true }); }
});

test('Checko validates INNs, imports company and entrepreneur metadata, deduplicates and links operations', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-checko-'));
  const calls: { url: string; inn: string }[] = [];
  const legalInn = '4027148080';
  const individualInn = '500100732259';
  assert.equal(validInn(legalInn), true); assert.equal(validInn(individualInn), true);
  const mock: typeof fetch = async (url, options) => {
    const form = new URLSearchParams(String(options?.body));
    calls.push({ url: String(url), inn: form.get('inn')! });
    assert.equal(options?.method, 'POST'); assert.equal(String(url).includes('?'), false);
    const inn = form.get('inn');
    return Response.json({ meta: { status: 'ok' }, data: inn === individualInn ? { ИНН: inn, ОГРНИП: '304500116000157', ФИО: 'ТЕСТОВЫЙ ПРЕДПРИНИМАТЕЛЬ', НасПункт: 'г. Калуга', Статус: { Наим: 'Действует' } } : { ИНН: inn, КПП: '402701001', ОГРН: '1224000000278', НаимСокр: 'ООО ТЕСТ API', НаимПолн: 'ОБЩЕСТВО ТЕСТ API', ЮрАдрес: { АдресРФ: 'Адрес из реестра' }, Статус: { Наим: 'Действует' } } });
  };
  const runtime = await serve(directory, { fetcher: mock, checkoApiKey: 'test-fixture-key' });
  try {
    const add = async (inn: string) => fetch(`${runtime.url}/api/companies/from-inn`, { method: 'POST', ...body({ inn }) });
    assert.equal((await add('4027148081')).status, 400); assert.equal(calls.length, 0);
    const response = await add(legalInn); assert.equal(response.status, 201);
    const imported = await response.json() as { company: Company; created: boolean };
    assert.equal(imported.company.inn, legalInn); assert.equal(imported.company.address, 'Адрес из реестра'); assert.equal(imported.company.registrySource, 'checko');
    assert.equal((await add(legalInn)).status, 200); assert.equal(calls.length, 1);
    assert.equal((await add(individualInn)).status, 201); assert.ok(calls[1].url.endsWith('/entrepreneur'));
    const creation = await fetch(`${runtime.url}/api/shipments`, { method: 'POST', ...body({ fields: sample({ customer_id: imported.company.id }) }) });
    assert.equal(creation.status, 201);
    assert.equal((await creation.json() as { shipment: Shipment }).shipment.customerId, imported.company.id);
    const snapshot = await (await fetch(`${runtime.url}/api/snapshot?shipments=omit`)).json() as Snapshot;
    assert.equal(snapshot.overview.companyCount, source.companies.length + 2);
    assert.equal(snapshot.companies.find(company => company.inn === individualInn)?.address, 'г. Калуга');
    assert.equal(snapshot.companies.find(company => company.inn === legalInn)?.shipmentIds.length, 1);
    assert.ok(!JSON.stringify(snapshot).includes('test-fixture-key'));
  } finally { await close(runtime.server); await rm(directory, { recursive: true, force: true }); }
});

test('Checko failures and mismatched provider data never save partial companies or provider error text', async () => {
  const fixtures = [
    async () => { throw new Error('SECRET_PROVIDER_URL'); },
    async () => Response.json({ meta: { status: 'error', message: 'SECRET_PROVIDER_URL' } }),
    async () => Response.json({ meta: { status: 'ok' }, data: { ИНН: '7735560386', НаимСокр: 'Wrong' } }),
    async () => Response.json({ meta: { status: 'ok' }, data: {} }),
  ];
  for (const fixture of fixtures) {
    const directory = await mkdtemp(resolve(tmpdir(), 'artel-checko-error-'));
    const runtime = await serve(directory, { fetcher: fixture as typeof fetch, checkoApiKey: 'test-fixture-key' });
    try {
      const response = await fetch(`${runtime.url}/api/companies/from-inn`, { method: 'POST', ...body({ inn: '4027148080' }) });
      assert.ok([404, 502].includes(response.status));
      assert.ok(!(await response.text()).includes('SECRET_PROVIDER_URL'));
      const snapshot = await (await fetch(`${runtime.url}/api/snapshot?shipments=omit`)).json() as Snapshot;
      assert.equal(snapshot.overview.companyCount, source.companies.length);
      await assert.rejects(readFile(resolve(directory, 'operations.json')), { code: 'ENOENT' });
    } finally { await close(runtime.server); await rm(directory, { recursive: true, force: true }); }
  }
});

test('legacy name collisions do not create new companies or alter existing links', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-identities-'));
  const fetcher: typeof fetch = async (_url, options) => Response.json({meta:{status:'ok'},data:{ИНН:new URLSearchParams(String(options?.body)).get('inn'),НаимСокр:customer.name,НаимПолн:customer.name}});
  const runtime = await serve(directory,{fetcher,checkoApiKey:'test-fixture-key'});
  try {
    const response=await fetch(`${runtime.url}/api/companies/from-inn`,{method:'POST',...body({inn:'4027148080'})});
    assert.equal(response.status,409);
    const snapshot=await(await fetch(`${runtime.url}/api/snapshot?shipments=omit`)).json() as Snapshot;
    assert.equal(snapshot.companies.length,source.companies.length);
    assert.deepEqual(snapshot.companies.find(c=>c.id===customer.id)?.shipmentIds.sort(),[...customer.shipmentIds].sort());
    assert.equal((await fetch(`${runtime.url}/api/shipments`,{method:'POST',...body({fields:sample({customer_id:'missing'})})})).status,400);
    assert.equal((await fetch(`${runtime.url}/api/shipments`,{method:'POST',...body({fields:sample({customer_inn:'4027148080'})})})).status,400);
  } finally {await close(runtime.server);await rm(directory,{recursive:true,force:true});}
});

test('source integrity is rechecked after files change, even when a prior response was cached', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-source-cache-'));
  const names = ['manifest', 'companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report'];
  await Promise.all(names.map(name => copyFile(resolve(dataDirectory, `${name}.json`), resolve(directory, `${name}.json`))));
  const middleware = createSnapshotMiddleware(directory, { operationsDirectory: resolve(directory, 'operations') });
  const server = createServer((request, response) => middleware(request, response, () => response.end()));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    assert.equal((await fetch(`${url}/api/snapshot?shipments=omit`)).status, 200);
    const original = await readFile(resolve(directory, 'companies.json'));
    await writeFile(resolve(directory, 'companies.json'), Buffer.concat([original, Buffer.from(' ')]));
    assert.equal((await fetch(`${url}/api/snapshot?shipments=omit`)).status, 500);
    assert.equal((await fetch(`${url}/api/shipments`, { method: 'POST', ...body({ fields: sample() }) })).status, 500);
    await writeFile(resolve(directory, 'companies.json'), original);
    assert.equal((await fetch(`${url}/api/shipments?limit=50`)).status, 200);
  } finally { await close(server); await rm(directory, { recursive: true, force: true }); }
});

test('missing server key is actionable without contacting Checko', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-no-key-'));
  const runtime = await serve(directory, { checkoApiKey: '', fetcher: async () => { assert.fail('Network must not be called without a key'); } });
  try {
    const response = await fetch(`${runtime.url}/api/companies/from-inn`, { method: 'POST', ...body({ inn: '4027148080' }) });
    assert.equal(response.status, 503);
    assert.match(await response.text(), /CHECKO_API_KEY/);
  } finally { await close(runtime.server); await rm(directory, { recursive: true, force: true }); }
});

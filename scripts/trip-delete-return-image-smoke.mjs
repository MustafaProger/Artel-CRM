import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
const { createProductionRuntime } = await import(process.env.ARTEL_SYNTHETIC_BUNDLE || '/app/server-render/production.mjs');

// These constants are copied from the repository's synthetic integration fixture.
// No production store, account, credential, signature or document is used.
const fixture = {"data":{"schemaVersion":2,"sourceSha256":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","revision":0,"shipments":{},"companies":[{"name":"Синтетический перевозчик","inn":"0392816475","kpp":"037195284","address":"Синтетический юридический адрес перевозчика","phone":"+70000000004","edoId":"SYNTHETICCARRIER","id":"carrier","roles":["carrier"],"managerLabels":[],"shipmentIds":[],"paymentIds":[],"flags":[]},{"id":"supplier","name":"Синтетический поставщик","inn":"7707083893","kpp":"770701001","address":"Синтетический юридический адрес","phone":"+70000000007","roles":["supplier"],"managerLabels":[],"shipmentIds":[],"paymentIds":[],"flags":[]},{"id":"customer","name":"ИП ПолучательТестовый Тест","inn":"010000000102","address":"Синтетический юридический адрес ИП","phone":"+70000000008","roles":["customer"],"managerLabels":[],"shipmentIds":[],"paymentIds":[],"flags":[]}],"directories":{"managers":[{"id":"manager","name":"Тест"}],"products":[{"id":"product","name":"ДТ","documentName":"Синтетическое дизельное топливо","transportProductKind":"diesel","cargoPackaging":"bulk","dangerousGoodsSource":"Синтетический паспорт","dangerousGoodsUnNumber":"1202","dangerousGoodsShippingName":"ТОПЛИВО ДИЗЕЛЬНОЕ","dangerousGoodsClass":"3","dangerousGoodsClassificationCode":"F1","dangerousGoodsPackingGroup":"III","dangerousGoodsHazardSign":"3","dangerousGoodsTunnelCode":"D/E"}],"paymentForms":[{"id":"payment","name":"б/нал"}],"vehicles":[{"id":"vehicle","carrierId":"carrier","plate":"Т001ЕЕ777","vehicleType":"Синтетическая цистерна","transportVehicleType":"Синтетическая цистерна","brand":"Синтетическая марка","capacityLitres":"25000","payloadTonnes":"20","payloadSource":"Синтетический ПТС","ownershipType":"1"}],"drivers":[{"id":"driver","carrierId":"carrier","name":"Тест","fullName":"ВодительТестовый Тест","phone":"+70000000003","inn":"048172639504","vehicleId":"vehicle"}],"addresses":[{"id":"loading","companyId":"supplier","kind":"loading","name":"Погрузка","address":"Синтетическая погрузка"},{"id":"delivery","companyId":"customer","kind":"delivery","name":"Доставка","address":"Синтетическая доставка","receiverName":"ПриёмщикТестовый Тест","receiverPhone":"+70000000009"}],"oilDepots":[{"id":"depot","name":"Синтетическая нефтебаза","address":"Синтетическая погрузка","ownerCompanyId":"supplier","loadingActorCompanyId":"supplier","infrastructureOwnerCompanyId":"supplier"}],"defaults":{"profit":"template-payment-form"},"duplicates":[],"customerManagers":[],"fleetSeedApplied":true},"paymentAllocations":[],"tripNumbers":{"shipment-trip-bcba86bc-8b97-422a-aae7-6231c7585156":1},"push":{"devices":[],"deliveries":{},"tripAssignments":{"shipment-trip-bcba86bc-8b97-422a-aae7-6231c7585156":{"token":"62f261b0-25ac-4d4c-9385-75f98e85bca7","driverId":"driver","at":1792489775592}}}},"config":{"sessionId":"private-integration-session","customer":{"name":"Синтетический отправитель","inn":"0148372956","kpp":"015927183","address":"Синтетический юридический адрес отправителя","phone":"+70000000001","edoId":"SYNTHETICSENDER"},"carrier":{"name":"Синтетический перевозчик","inn":"0392816475","kpp":"037195284","address":"Синтетический юридический адрес перевозчика","phone":"+70000000004","edoId":"SYNTHETICCARRIER"},"consignmentSigner":{"surname":"ПодписантТестовый","name":"Тест","patronymic":"","position":"Директор"},"transportProfile":{"function":"Заявка","contract":{"name":"Синтетический договор","number":"SYNTHETIC-CONTRACT","date":"2025-01-01","issuerInns":["0148372956","0392816475"]},"regulatoryInstructions":"","foodInstructions":"Отсутствуют","signatory":{"surname":"ПодписантТестовый","name":"Тест","position":"Директор","authorityMethod":"1"},"cargoByProductId":{"product":{"name":"Синтетический ДТ","condition":"Жидкий","packagingCode":"TY","packageCount":"1","massMethod":"03","distributable":"1","divisible":"1","heightMetres":"1","lengthMetres":"1","widthMetres":"1","dangerousGoods":null}},"vehicleById":{}}},"autofill":{"signerStatus":"1","instructions":{"redirectionParty":"Грузоотправитель","redirectionMethod":"Телефон","redirectionPhone":"+70000000001"},"loadingByAddressId":{"loading":{"loadingActorCompanyId":"supplier","infrastructureOwnerCompanyId":"supplier"}}}};
const hash = value => createHash('sha256').update(value).digest('hex');
let externalRequests = 0, cookie, runtime;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { externalRequests++; throw new Error('External provider forbidden in autostart image smoke'); };
const previousAutofill = process.env.SABY_AUTOFILL_PROFILE_JSON;
process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(fixture.autofill);
const root = await mkdtemp(resolve(tmpdir(), 'artel-autostart-image-smoke-'));
const snapshot = resolve(root, 'snapshot'), store = resolve(root, 'operations');
await Promise.all([mkdir(snapshot), mkdir(store)]);
const source = fixture.data.sourceSha256;
const meta = { source_file: 'synthetic.xlsx', source_sha256: source, created_at_utc: '2026-10-20T00:00:00Z', source_kind: 'test', google_verified: false, formula_policy: '', ownership_policy: '' };
const validation = { status: 'ok', registry_verified: false, issue_counts: {}, cell_issues: [], record_flag_counts: {}, duplicate_record_candidates: [], legal_form_alias_candidate_groups: [], limitations: [] };
const files = {};
for (const name of ['companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report']) {
  const raw = JSON.stringify({ meta, data: name === 'validation_report' ? validation : [] });
  await writeFile(resolve(snapshot, `${name}.json`), raw);
  files[`${name}.json`] = { sha256: hash(raw), bytes: Buffer.byteLength(raw) };
}
await writeFile(resolve(snapshot, 'manifest.json'), JSON.stringify({ meta, counts: {}, files }));
await writeFile(resolve(store, 'operations.json'), JSON.stringify({ sha256: hash(JSON.stringify(fixture.data)), data: fixture.data }));
const origin = 'https://synthetic.example.test';
const partyEnv = (prefix, party) => Object.fromEntries(Object.entries(party).map(([key, value]) => [`${prefix}_${key === 'edoId' ? 'EDO_ID' : key.toUpperCase()}`, value]));
const env = {
  ARTEL_GEOCODER_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_PUBLIC_ORIGIN: origin,
  ARTEL_SNAPSHOT_DIR: snapshot, ARTEL_STORE_DIR: store, ARTEL_SETUP_TOKEN: 'synthetic-test-only',
  ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', PORT: '0',
  SABY_SESSION_ID: 'synthetic-image-session', SABY_WORKFLOW_ENABLED: 'false',
  ...partyEnv('SABY_CUSTOMER', fixture.config.customer), ...partyEnv('SABY_CARRIER', fixture.config.carrier),
  SABY_NK_CONSIGNMENT_SIGNER_JSON: JSON.stringify({ surname: 'НКПодписантТестовый', name: 'Тест', patronymic: '', position: 'Директор' }),
  SABY_NK_REGULATORY_INSTRUCTIONS: 'Синтетические подтверждённые указания НК для проверки очереди.',
  SABY_TRANSPORT_PROFILE_JSON: JSON.stringify(fixture.config.transportProfile),
  SABY_AUTO_SIGNING_JSON: JSON.stringify({
    id: 'synthetic-image-autostart', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z',
    sender: { inn: fixture.config.customer.inn, kpp: fixture.config.customer.kpp, thumbprint: 'ab'.repeat(20) },
    carrier: { inn: fixture.config.carrier.inn, kpp: fixture.config.carrier.kpp, thumbprint: 'cd'.repeat(20) },
  }),
};
const request = (path, method = 'GET', body) => new Promise((done, reject) => {
  const payload = body ? JSON.stringify(body) : undefined;
  const req = httpRequest({ hostname: '127.0.0.1', port: runtime.server.address().port, path, method, headers: {
    host: 'synthetic.example.test', origin, 'content-type': 'application/json',
    ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}), ...(cookie ? { cookie } : {}),
  } }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
    response.on('end', () => done(new Response(Buffer.concat(chunks), { status: response.statusCode, headers: Object.fromEntries(Object.entries(response.headers).map(([key, value]) => [key, Array.isArray(value) ? value.join(', ') : value])) })));
  }); req.on('error', reject); req.end(payload);
});
const call = async (path, method = 'GET', body) => {
  const response = await request(path, method, body);
  assert.ok([200, 201].includes(response.status), `${method} ${path}: ${await response.clone().text()}`);
  return response.json();
};
const disk = async () => JSON.parse(await readFile(resolve(store, 'operations.json'), 'utf8')).data;
const checks = [];
try {
  runtime = await createProductionRuntime(env); await runtime.start();
  const setup = await request('/api/auth/setup', 'POST', { name: 'Synthetic director', login: 'trip-return-qa', password: randomUUID(), setupToken: env.ARTEL_SETUP_TOKEN });
  assert.equal(setup.status, 200); cookie = setup.headers.get('set-cookie').split(';')[0];
  const requests = [];
  for (const index of [0, 1]) requests.push((await call('/api/trip-requests', 'POST', { companyId: 'customer', addressId: 'delivery', quantityLitres: String(1000 + index), salePricePerLitre: '60', comment: 'Synthetic return ' + index, idempotencyKey: randomUUID() })).request);
  const fields = { organization_id: 'artel', trip_flow_version: 'driver-v1', loading_at: '2027-02-03T09:15', supplier_id: 'supplier', carrier_id: 'carrier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000', driver_id: 'driver', vehicle_id: 'vehicle', additional_costs: '0' };
  const body = rows => ({ fields, customers: rows.map(row => ({ sourceRequestId: row.id, sourceRequestVersion: row.version, fields: { customer_id: row.companyId, manager_id: 'manager', unloading_address_id: row.addressId, quantity_litres: row.quantityLitres, delivery_notes: row.comment, payment_form_id: 'payment', sale_price_per_litre: '60', transport_amount: '0' } })), idempotencyKey: randomUUID() });
  const original = structuredClone((await disk()).tripRequests);
  const input = body(requests), created = await call('/api/shipment-trips', 'POST', input), id = created.trip.id;
  assert.equal((await call('/api/trip-requests')).requests.length, 0);
  const versions = Object.fromEntries(created.trip.customers.map(row => [row.id, row.version]));
  const beforeRejected = await disk();
  assert.equal((await request('/api/shipment-trips/' + id, 'DELETE', { versions: {} })).status, 409);
  assert.deepEqual(await disk(), beforeRejected);
  const deleted = await call('/api/shipment-trips/' + id, 'DELETE', { versions });
  assert.equal(deleted.deletedCount, 2);
  const returned = await disk();
  for (const request of requests) assert.deepEqual(returned.tripRequests[request.id], { ...original[request.id], version: original[request.id].version + 2, updatedAt: returned.tripRequests[request.id].updatedAt });
  assert.ok(created.trip.customers.every(row => returned.shipments[row.id].deleted));
  assert.equal((await request('/api/shipment-trips/' + id, 'DELETE', { versions })).status, 404);
  assert.equal((await request('/api/shipment-trips', 'POST', input)).status, 409);
  assert.equal((await request('/api/shipment-trips', 'POST', body(requests))).status, 409);
  checks.push('two original requests returned atomically; stale versions and replay rejected');
  await runtime.stop(); runtime = await createProductionRuntime(env); await runtime.start();
  const active = (await call('/api/trip-requests')).requests;
  assert.equal(active.length, 2);
  assert.equal((await request('/api/shipment-trips/' + id)).status, 404);
  const reused = await call('/api/shipment-trips', 'POST', body(active));
  assert.notEqual(reused.trip.id, id); assert.equal((await call('/api/trip-requests')).requests.length, 0);
  await runtime.stop(); runtime = await createProductionRuntime(env); await runtime.start();
  assert.equal((await call('/api/shipment-trips/' + reused.trip.id)).trip.customers.length, 2);
  checks.push('restart preserves returned requests and reuse keeps historical deleted deliveries readable');
  assert.equal(externalRequests, 0);
  console.log(JSON.stringify({ passed: true, syntheticOnly: true, externalRequests, checks }));
} finally { await runtime?.stop(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true }); }

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
  const setup = await request('/api/auth/setup', 'POST', { name: 'Synthetic director', login: 'autostart-image-qa', password: randomUUID(), setupToken: env.ARTEL_SETUP_TOKEN });
  assert.equal(setup.status, 200); cookie = setup.headers.get('set-cookie').split(';')[0];
  const employeeCookie = cookie;
  const issued = await call('/api/drivers/driver/access', 'POST', { version: 0, action: 'issue' });
  for (const excluded of [[false, false], [false, true], [true, false], [true, true]]) {
    cookie = employeeCookie;
    const fields = { organization_id: 'nk-artel', trip_flow_version: 'driver-v1', loading_at: '2026-10-20T09:15',
      supplier_id: 'supplier', carrier_id: 'carrier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000',
      driver_id: 'driver', vehicle_id: 'vehicle', additional_costs: '0', trip_notes: `Synthetic image autostart ${excluded}`,
    };
    const customers = excluded.map((skip, index) => ({ fields: {
      customer_id: 'customer', manager_id: 'manager', payment_form_id: 'payment', unloading_address_id: 'delivery',
      quantity_litres: index ? '9500' : '8000', sale_price_per_litre: '60', transport_amount: '1000',
      invoice_not_required: String(!index), etrn_not_required: String(skip),
    } }));
    const created = await call('/api/shipment-trips', 'POST', { fields, customers, idempotencyKey: randomUUID() });
    const id = created.trip.id, required = excluded.filter(value => !value).length;
    if (required) {
      const current = await call(`/api/shipment-trips/${id}/etrn/loading-details`);
      assert.equal(current.mode, 'sender'); assert.equal(current.required, false); assert.equal(current.editable, true);
      assert.equal(current.details, null); assert.equal(current.infrastructureOwner.inn, '7707083893');
      assert.equal(externalRequests, 0);
    }
    const workflowPath = `/api/shipment-trips/${id}/saby-workflow`;
    assert.equal(created.trip.fields.trip_document_policy, 'nk-direct-autostart-v1');
    assert.equal((await disk()).etrn.trips[id].directAutostart.state, 'waiting_departure');
    const before = JSON.stringify((await disk()).etrn.trips[id]);
    await call(workflowPath); await call(workflowPath);
    assert.equal(JSON.stringify((await disk()).etrn.trips[id]), before);
    assert.equal((await disk()).etrn.trips[id].direct, undefined);
    const login = await request('/api/auth/login', 'POST', { login: issued.access.login, password: issued.temporaryPassword });
    assert.equal(login.status, 200); cookie = login.headers.get('set-cookie').split(';')[0]; const driverCookie = cookie;
    const driverPath = `/api/driver/trips/${id}`, assigned = (await call(driverPath)).trip;
    assert.equal(assigned.documentAutomation, 'after_driver_departure');
    const arrived = (await call(driverPath + '/arrive', 'POST', { versions: assigned.versions })).trip;
    const departure = { versions: arrived.versions, masses: created.trip.customers.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '7,985' : '6,745' })) };
    const outcomes = await Promise.all([call(driverPath + '/depart', 'POST', departure), call(driverPath + '/depart', 'POST', departure)]);
    assert.deepEqual(outcomes[0].trip, outcomes[1].trip);
    const departed = outcomes[0].trip;
    assert.equal(departed.archived, false); assert.deepEqual(departed.deliveries.map(row => row.netTonnes), ['6.745', '7.985']);
    const saved = (await disk()).etrn.trips[id];
    assert.equal(saved.directAutostart.state, required ? 'queued' : 'not_required');
    assert.ok(saved.directAutostart.event);
    assert.equal(Object.keys(saved.deliveries).length, 0);
    if (required) {
      assert.equal(saved.loadingActorMode, 'sender');
      for (const row of saved.direct.deliveries) {
        assert.equal(row.snapshot.profile.loadingActor.sameAsConsignor, true);
        assert.equal(row.snapshot.profile.loadingActor.basis, undefined);
        assert.equal(row.snapshot.profile.loadingActor.worker, undefined);
        assert.equal(row.snapshot.profile.infrastructureOwner.party.inn, '7707083893');
      }
      assert.equal(saved.direct.phase, 'creating_etrn');
      assert.equal(saved.direct.authorization.automatic.source, 'driver_departure');
      assert.equal(saved.direct.authorization.selection.sender, 'cd'.repeat(20));
      assert.equal(saved.direct.authorization.selection.sender, saved.direct.authorization.selection.carrier);
      assert.deepEqual(saved.direct.deliveries.map(row => row.shipmentId), created.trip.customers.filter((_, index) => !excluded[index]).map(row => row.id));
    } else assert.equal(saved.direct, undefined);
    const protectedProjection = data => ({
      etrn: data.etrn.trips[id], progress: data.driverTripProgress[id],
      shipments: Object.fromEntries(created.trip.customers.map(row => [row.id, data.shipments[row.id]])),
      workflow: data.tripSaby?.trips[id], saby: data.saby?.trips[id],
    });
    const protectedBefore = protectedProjection(await disk());
    assert.equal(protectedBefore.workflow, undefined); assert.equal(protectedBefore.saby, undefined);
    cookie = employeeCookie;
    const projection = await call(workflowPath);
    assert.equal(projection.start, undefined); assert.equal(projection.locked, required > 0);
    assert.equal(projection.automation.mode, 'after_driver_departure');
    assert.equal(projection.stage6CompletedAt, null); assert.equal(projection.order, null);
    assert.equal((await request(workflowPath + '/start', 'POST', { mode: 'sign_and_send', previewToken: 'a'.repeat(64) })).status, 409);
    await runtime.stop(); runtime = await createProductionRuntime(env); await runtime.start();
    await call(workflowPath);
    cookie = driverCookie;
    assert.deepEqual((await call(driverPath)).trip, departed);
    assert.deepEqual((await call(driverPath + '/depart', 'POST', departure)).trip, departed);
    assert.deepEqual(protectedProjection(await disk()), protectedBefore);
    assert.equal(externalRequests, 0);
    checks.push(`configuredQueueConcurrentDepartureRestartScope-${excluded.join('-')}`);
  }
  checks.push('readOnlyGetNeverEnqueues', 'driverEventAndGrantAtomic', 'onlyNkCertificateForBothTitles', 'singleStableAttemptAfterConcurrentReplay', 'perDeliveryEtrnFlagsIndependentOfInvoices', 'allSkipLocalCompletionWithoutGrant', 'noTransportOrder', 'noSignatureOrTransmissionClaimWithoutEvidence');
  console.log(JSON.stringify({ synthetic: true, realProductionBundle: true, schedulerDisabled: true, networkDisabled: true, externalRequests, checks }));
} finally {
  globalThis.fetch = originalFetch;
  if (previousAutofill === undefined) delete process.env.SABY_AUTOFILL_PROFILE_JSON; else process.env.SABY_AUTOFILL_PROFILE_JSON = previousAutofill;
  await runtime?.stop(); await rm(root, { recursive: true, force: true });
}

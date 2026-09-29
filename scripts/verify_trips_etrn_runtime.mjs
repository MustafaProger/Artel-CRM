// Browser -> authenticated HTTP -> real OperationsStore / SabyClient -> injected synthetic provider.
// No working records, credentials, Saby connection or bank requests.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { OperationsStore } from '../server/operations-store.ts';
import { SabyClient } from '../server/saby-client.ts';
import { emptyDirectories } from '../server/directory-operations.ts';
import { carrier, sender, syntheticEtrnFixture } from '../tests/helpers/etrn-fixture.ts';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { writeTripsQaSnapshot, startTripsQaServer } from './qa-trips-runtime.mjs';

const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'artel-etrn-runtime-ui-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store'), output = resolve(root, 'qa/trips-etrn-runtime-2026-09-29');
await mkdir(output, { recursive: true });
const source = await writeTripsQaSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const fixture = syntheticEtrnFixture();
const profile = { ...fixture.profile, recipient: { ...fixture.profile.recipient, inn: '7728168971', kpp: '772801001' }, consignorPhone: sender.phone, carrierPhone: carrier.phone };
const config = { login: 'synthetic-login', password: 'synthetic-password', accountNumber: 'synthetic-customer-account', carrierAccountNumber: 'synthetic-carrier-account', customer: { ...sender, phone: '' }, carrier: { ...carrier, phone: '' } };
const company = (id, name, role, details = {}) => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [], ...details });
await store.mutate(source, data => {
  data.sourceOperationsCleared = true;
  data.companies = [company('supplier-synthetic', 'Синтетический склад', 'supplier'), company('customer-synthetic', profile.recipient.name, 'customer', profile.recipient)];
  data.directories = {
    ...emptyDirectories(), fleetSeedApplied: true,
    managers: [{ id: 'qa-manager', name: 'Синтетический сотрудник' }], products: [{ id: 'product-synthetic', name: 'Синтетический продукт' }], paymentForms: [{ id: 'qa-payment', name: 'б/нал' }],
    drivers: [{ ...fixture.source.directories.drivers[0], vehicleId: 'vehicle-synthetic' }], vehicles: fixture.source.directories.vehicles,
    addresses: [{ id: 'qa-loading', companyId: 'supplier-synthetic', kind: 'loading', name: 'Синтетическая погрузка', address: 'Синтетическая площадка погрузки' }, { id: 'qa-unloading', companyId: 'customer-synthetic', kind: 'delivery', name: 'Синтетическая доставка', address: 'Синтетическая площадка получателя' }],
    customerManagers: [{ companyId: 'customer-synthetic', managerId: 'qa-manager' }],
  };
  return { result: undefined, changed: true };
});
const report = { fixtureOnly: true, workingStoreAccessed: false, realSabyRequests: 0, bankRequests: 0, checks: [], errors: [], unexpectedRequests: [], screenshots: [], providerMethods: {} };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const calls = [], documents = new Map(), sessions = new Map(), downloaded = [];
let loseNextWrite = false;
const bytes = Buffer.from('<synthetic-etrn>Authenticated artifact</synthetic-etrn>', 'utf8');
const provider = async (url, init) => {
  const address = String(url), session = new Headers(init.headers).get('X-SBISSessionID');
  if (init.method === 'GET') {
    assert.equal(sessions.get(session), 'customer'); assert.ok(address.startsWith('https://disk.saby.ru/synthetic/')); downloaded.push(address);
    return new Response(bytes, { headers: { 'content-type': 'application/xml' } });
  }
  assert.ok(['https://online.sbis.ru/auth/service/', 'https://online.sbis.ru/service/?srv=1', 'https://tms.saby.ru/service/'].includes(address));
  const rpc = JSON.parse(init.body), result = body => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: body }));
  calls.push({ method: rpc.method, account: rpc.params.Параметр?.НомерАккаунта });
  if (rpc.method === 'СБИС.Аутентифицировать') {
    assert.equal(rpc.params.Параметр.Логин, config.login); assert.equal(rpc.params.Параметр.Пароль, config.password);
    const role = rpc.params.Параметр.НомерАккаунта === config.accountNumber ? 'customer' : rpc.params.Параметр.НомерАккаунта === config.carrierAccountNumber ? 'carrier' : null;
    assert.ok(role); const token = `synthetic-${role}-${sessions.size}`; sessions.set(token, role); return result(token);
  }
  const role = sessions.get(session); assert.ok(role);
  if (rpc.method === 'СБИС.СписокНашихОрганизаций') {
    const organization = config[role]; assert.deepEqual(rpc.params.Фильтр.НашаОрганизация.СвЮЛ, { ИНН: organization.inn, КПП: organization.kpp });
    return result({ НашаОрганизация: [{ СвЮЛ: { ИНН: organization.inn, КПП: organization.kpp }, ДокументооборотПодключен: 'Да' }] });
  }
  assert.equal(role, 'customer');
  if (rpc.method === 'СБИС.ЗаписатьДокумент') {
    const sent = rpc.params.Документ, xml = new TextDecoder('windows-1251').decode(Buffer.from(sent.Вложение[0].Файл.ДвоичныеДанные, 'base64'));
    assert.equal(sent.Тип, 'ConsignmentNote'); assert.match(xml, /КНД="1110339"/); assert.doesNotMatch(xml, /1110361|Подпись|NEVER-COPY/);
    const id = `synthetic-etrn-${documents.size + 1}`;
    const document = { ...sent, Идентификатор: id, Редакция: [{ Идентификатор: `${id}-revision`, Актуален: 'Да' }], СсылкаДляНашаОрганизация: `https://online.saby.ru/document/${id}`, Состояние: { Название: 'Черновик' }, Стороны: { Отправитель: sent.Грузоотправитель, Получатель: sent.Грузополучатель, Перевозчик: sent.ТранспортнаяКомпания }, Вложение: [{ Идентификатор: `${id}-file`, Подтип: '1110339', ВерсияФормата: '5.01', Файл: { Имя: 'Синтетическая ЭТрН.xml', Ссылка: `https://disk.saby.ru/synthetic/${id}.xml` } }], ТекущиеЭтапы: [{ Действие: [{ Название: 'Подписать и отправить' }] }] };
    documents.set(id, document);
    if (loseNextWrite) { loseNextWrite = false; throw new Error('Synthetic lost response'); }
    return result(document);
  }
  if (rpc.method === 'СБИС.ПрочитатьДокумент') { assert.ok(documents.has(rpc.params.Документ.Идентификатор)); return result(documents.get(rpc.params.Документ.Идентификатор)); }
  if (rpc.method === 'СБИС.СписокДокументов') {
    assert.equal(rpc.params.Фильтр.Тип, 'ConsignmentNote');
    return result({ Документ: [...documents.values()].filter(document => document.Номер === rpc.params.Фильтр.Маска), Навигация: { ЕстьЕще: 'Нет' } });
  }
  throw new Error(`Unexpected synthetic provider method: ${rpc.method}`);
};
const count = method => calls.filter(call => call.method === method).length;
let runtime, browser, page;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient: new SabyClient(config, provider) });
  const { base } = runtime, { cookie } = await bootstrapQaAuth(base);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    report.unexpectedRequests.push(route.request().url()); return route.abort();
  });
  await authenticateContext(context, base, cookie);
  const api = async (path, method = 'GET', data) => {
    const response = await context.request.fetch(base + path, { method, ...(data === undefined ? {} : { data }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`); return response.json();
  };
  const tripBody = note => ({ idempotencyKey: randomUUID(), fields: { organization_id: 'artel', date: '2025-04-01', supplier_id: 'supplier-synthetic', product_id: 'product-synthetic', driver_id: 'driver-synthetic', vehicle_id: 'vehicle-synthetic', quantity_tonnes: '5.123125', purchase_price_unspecified_unit: '50000', loading_address_id: 'qa-loading', loading_planned_at: '2025-04-01T08:15', trip_notes: note }, customers: [{ fields: { customer_id: 'customer-synthetic', payment_form_id: 'qa-payment', manager_id: 'qa-manager', quantity_litres: '7125', sale_price_per_litre: '70', transport_amount: '1000', unloading_address_id: 'qa-unloading', unloading_planned_at: '2025-04-01T14:00' } }] });
  const trip = (await api('/api/shipment-trips', 'POST', tripBody('Основная синтетическая ЭТрН'))).trip;
  const shipmentId = trip.customers[0].id, endpoint = `/api/shipment-trips/${trip.id}/etrn`;
  const initial = await api(endpoint); assert.equal(initial.configured, true); assert.equal(initial.deliveries[0].profile.confirmed, false); assert.ok(initial.deliveries[0].blockers.length);
  assert.equal(initial.deliveries[0].profile.recipient.inn, profile.recipient.inn); assert.equal(initial.deliveries[0].profile.loading.arrivedAt, ''); assert.equal(initial.deliveries[0].profile.deliveryMassTonnes, '');
  assert.equal(calls.length, 0);
  const prepared = await api(endpoint, 'PUT', { shipmentId, profile }); assert.deepEqual(prepared.deliveries[0].blockers, []);
  page = await context.newPage(); page.on('pageerror', reason => report.errors.push(reason.message));
  await page.goto(base + '/#trips'); await page.getByRole('button', { name: 'Saby', exact: true }).click();
  const panel = page.getByRole('region', { name: 'ЭТрН в Saby', exact: true }), delivery = page.getByTestId('etrn-delivery');
  await expect(delivery).toContainText('Данные проверены'); await expect(delivery.getByLabel('Телефон грузоотправителя', { exact: true })).toHaveValue(sender.phone);
  await delivery.getByLabel('Номер заявки на перевозку', { exact: true }).fill('SYNTHETIC-UI-ORDER');
  await expect(delivery.getByRole('checkbox', { name: /Данные проверены/ })).not.toBeChecked();
  await expect(delivery.getByRole('button', { name: 'Создать ЭТрН в Saby', exact: true })).toBeDisabled();
  await delivery.getByRole('checkbox', { name: /Данные проверены/ }).check(); await delivery.getByRole('button', { name: 'Сохранить и проверить', exact: true }).click();
  const submit = delivery.getByRole('button', { name: 'Создать ЭТрН в Saby', exact: true }); await expect(submit).toBeEnabled();
  assert.equal((await api(endpoint)).deliveries[0].profile.order.number, 'SYNTHETIC-UI-ORDER');
  const xmlResponse = await context.request.get(base + `${endpoint}/xml/${shipmentId}`); assert.equal(xmlResponse.status(), 200); assert.match(new TextDecoder('windows-1251').decode(await xmlResponse.body()), /КНД="1110339"/);
  check('Authenticated trip GET derives only known directory facts; ordinary UI edits save/validate a full per-delivery profile and download a generated sender XML through the real API');
  const accounting = (await store.read(source)).shipments;
  await submit.evaluate(button => { button.click(); button.click(); }); await expect(delivery).toContainText('Создано в Saby');
  assert.equal(count('СБИС.ЗаписатьДокумент'), 1); assert.equal(count('СБИС.ПрочитатьДокумент'), 1);
  const confirmed = await api(endpoint), document = confirmed.deliveries[0].document;
  assert.equal(document.status, 'draft'); assert.ok(document.id); assert.equal(document.signatureStatus, 'not_signed'); assert.equal(document.gisStatus, null);
  await expect(delivery.getByRole('link', { name: 'Открыть для подписания в Saby' })).toBeVisible(); await expect(delivery).toContainText('Подпись не получена'); await expect(delivery).toContainText('Подтверждение не получено');
  assert.deepEqual((await store.read(source)).shipments, accounting);
  const beforeRepeat = calls.length;
  assert.equal((await api(endpoint + '/submit', 'POST', { shipmentId })).deliveries[0].document.id, document.id); assert.equal(calls.length, beforeRepeat);
  check('Browser double click creates one ConsignmentNote through two account sessions, separately reads it, persists the link and makes repeated submission idempotent without accounting changes');
  const fileLink = delivery.getByRole('link', { name: 'Синтетическая ЭТрН.xml', exact: true });
  const fileUrl = await fileLink.getAttribute('href'); const file = await context.request.get(base + fileUrl); assert.equal(file.status(), 200); assert.ok((await file.body()).equals(bytes));
  const downloadCount = downloaded.length; assert.ok((await (await context.request.get(base + fileUrl)).body()).equals(bytes)); assert.equal(downloaded.length, downloadCount);
  const afterFile = await api(endpoint); assert.equal(afterFile.deliveries[0].document.files[0].size, bytes.length); assert.match(afterFile.deliveries[0].document.files[0].sha256, /^[a-f0-9]{64}$/);
  check('Artifact links download with CRM authorization; immutable bytes and checksum persist privately, and a repeat download is served without another provider request');
  const remote = documents.get(document.id); remote.Состояние = { Название: 'Ожидается действие перевозчика' }; remote.Вложение[0].Подпись = [{ Сертификат: { Отпечаток: 'SYNTHETIC-REPORTED-ONLY' } }]; remote.ГИС_УИД = 'SYNTHETIC-GIS-ID'; remote.ТекущиеЭтапы = [{ Действие: [{ Название: 'Открыть' }] }];
  await delivery.getByRole('button', { name: 'Обновить из Saby', exact: true }).click(); await expect(delivery).toContainText('Saby сообщает о наличии подписи'); await expect(delivery).toContainText('Saby вернул идентификатор ГИС ЭПД'); await expect(delivery).toContainText('Ожидается действие перевозчика');
  assert.equal(count('СБИС.ЗаписатьДокумент'), 1);
  check('Explicit read-back updates remote state, reported signature and GIS evidence separately without asserting local signature validation or full participant completion');
  runtime.replaceMiddleware(new SabyClient(config, provider)); await page.reload(); await page.getByRole('button', { name: 'Saby', exact: true }).click();
  await expect(delivery).toContainText('Saby сообщает о наличии подписи'); assert.equal((await api(endpoint)).deliveries[0].document.id, document.id);
  const patch = { fields: trip.fields, customers: trip.customers.map(({ id, fields }) => ({ id, fields })), versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) };
  assert.equal((await context.request.patch(base + `/api/shipment-trips/${trip.id}`, { data: patch })).status(), 409);
  assert.equal((await context.request.delete(base + `/api/shipment-trips/${trip.id}`, { data: { versions: patch.versions } })).status(), 409);
  check('Fresh middleware/store and browser reload preserve all document evidence; transmitted trip editing/deletion is rejected by the server');
  const retryTrip = (await api('/api/shipment-trips', 'POST', tripBody('Потерянный ответ ЭТрН'))).trip, retryId = retryTrip.customers[0].id, retryEndpoint = `/api/shipment-trips/${retryTrip.id}/etrn`;
  await api(retryEndpoint, 'PUT', { shipmentId: retryId, profile }); loseNextWrite = true; await page.reload();
  const retryCard = page.getByTestId('trip-card').filter({ hasText: 'Потерянный ответ ЭТрН' }); await retryCard.getByRole('button', { name: 'Saby', exact: true }).click();
  await retryCard.getByRole('button', { name: 'Создать ЭТрН в Saby', exact: true }).click(); await expect(retryCard).toContainText('Результат требует сверки');
  assert.equal(count('СБИС.ЗаписатьДокумент'), 2); await retryCard.getByRole('button', { name: 'Сверить с Saby', exact: true }).click(); await expect(retryCard).toContainText('Создано в Saby');
  assert.equal(count('СБИС.ЗаписатьДокумент'), 2); assert.equal(count('СБИС.СписокДокументов'), 1); assert.equal((await api(retryEndpoint)).deliveries[0].document.id, 'synthetic-etrn-2');
  check('A lost write response remains unknown; browser reconciliation finds and reads the existing ConsignmentNote with zero duplicate writes');
  const persisted = await readFile(resolve(operationsDirectory, 'operations.json'), 'utf8'), publicResponse = JSON.stringify(await api(endpoint));
  for (const secret of [config.login, config.password, config.accountNumber, config.carrierAccountNumber, ...sessions.keys()]) { assert.ok(!persisted.includes(secret)); assert.ok(!publicResponse.includes(secret)); }
  assert.ok(!publicResponse.includes('ДвоичныеДанные')); assert.ok(!publicResponse.includes('NEVER-COPY')); assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
  await page.setViewportSize({ width: 390, height: 1000 }); await retryCard.scrollIntoViewIfNeeded();
  const path = resolve(output, 'reconciled-etrn-mobile.png'); await page.screenshot({ path, fullPage: false }); report.screenshots.push(path);
  check('No real provider/network calls, account secrets, sessions or file bytes escape into the browser response or persisted connector records');
  void panel;
} catch (reason) {
  report.failure = reason.message; await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: false }).catch(() => {}); throw reason;
} finally {
  for (const call of calls) report.providerMethods[call.method] = (report.providerMethods[call.method] ?? 0) + 1;
  await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive: true, force: true });
  await writeFile(resolve(output, 'browser.json'), JSON.stringify(report, null, 2));
}

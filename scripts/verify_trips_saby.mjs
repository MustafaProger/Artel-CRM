// Run with: node --import tsx scripts/verify_trips_saby.mjs
// Real browser, HTTP API, authentication, serialization and persistence; synthetic Saby transport only.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { OperationsStore } from '../server/operations-store.ts';
import { SabyClient } from '../server/saby-client.ts';
import { emptyDirectories } from '../server/directory-operations.ts';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { writeTripsQaSnapshot, startTripsQaServer } from './qa-trips-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-trips-saby-ui-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store');
const output = resolve(root, 'qa/trips-saby-2026-09-29');
await mkdir(output, { recursive: true });
const source = await writeTripsQaSnapshot(snapshotDirectory);
const store = new OperationsStore(operationsDirectory);
const organization = (inn, kpp, name, role) => ({ inn, kpp, name, address: `Синтетический адрес ${role}`, phone: '+79990000001', edoId: `2BE-${role}-synthetic` });
const config = {
  login: 'synthetic-login', password: 'synthetic-password', accountNumber: 'synthetic-customer-account', carrierAccountNumber: 'synthetic-carrier-account',
  customer: organization('7707083893', '770701001', 'QA Заказчик', 'customer'), carrier: organization('7736050003', '773601001', 'QA Перевозчик', 'carrier'),
  transportProfile: {
    function: 'Заказ', regulatoryInstructions: 'Синтетические требования', foodInstructions: 'Не пищевая продукция',
    signatory: { surname: 'Тестов', name: 'Тест', patronymic: 'Тестович', position: 'Директор', authorityMethod: '1' },
    cargoByProductId: { 'qa-product': { name: 'Синтетический груз', condition: 'Исправный', packagingCode: '00', packageCount: '1', massMethod: '01', distributable: '1', divisible: '1', heightMetres: '1', lengthMetres: '1', widthMetres: '1', dangerousGoods: null } },
    vehicleById: { 'qa-vehicle': { type: 'Синтетическая цистерна', payloadTonnes: '20', capacityCubicMetres: '25' } },
  },
};
await store.mutate(source, data => {
  data.sourceOperationsCleared = true;
  data.companies = [['qa-supplier', 'QA Склад', 'supplier'], ['qa-customer-a', 'QA Клиент А', 'customer'], ['qa-customer-b', 'QA Клиент Б', 'customer']].map(([id, name, role], index) => ({ id, name, roles: [role], inn: ['7707083893', '7736050003', '7728168971'][index], kpp: '770701001', address: 'Синтетический юридический адрес', shipmentIds: [], paymentIds: [], managerLabels: [], flags: [] }));
  data.directories = {
    ...emptyDirectories(), fleetSeedApplied: true,
    managers: [{ id: 'qa-manager', name: 'QA Сотрудник' }], products: [{ id: 'qa-product', name: 'QA Груз' }], paymentForms: [{ id: 'qa-payment', name: 'б/нал' }],
    vehicles: [{ id: 'qa-vehicle', plate: 'Т001ЕЕ777', capacityLitres: '25000' }], drivers: [{ id: 'qa-driver', name: 'QA Водитель', phone: '+79990000002', vehicleId: 'qa-vehicle' }],
    addresses: [{ id: 'qa-loading', companyId: 'qa-supplier', kind: 'loading', name: 'QA Погрузка', address: 'Синтетическая улица, 1' }, { id: 'qa-delivery-a', companyId: 'qa-customer-a', kind: 'delivery', name: 'QA Площадка А', address: 'Синтетическая улица, 2' }, { id: 'qa-delivery-b', companyId: 'qa-customer-b', kind: 'delivery', name: 'QA Площадка Б', address: 'Синтетическая улица, 3' }],
    customerManagers: [{ companyId: 'qa-customer-a', managerId: 'qa-manager' }, { companyId: 'qa-customer-b', managerId: 'qa-manager' }],
  };
  return { result: null, changed: true };
});
const report = { fixtureOnly: true, workingStoreAccessed: false, realSabyRequests: 0, bankRequests: 0, checks: [], errors: [], unexpectedRequests: [], screenshots: [], providerMethods: {} };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const providerCalls = [], documents = new Map(), sessions = new Map();
let loseNextWrite = false, documentUrl = id => `https://online.saby.ru/document/${id}`;
const provider = async (url, init) => {
  assert.ok(['https://online.sbis.ru/auth/service/', 'https://online.sbis.ru/service/?srv=1', 'https://tms.saby.ru/service/'].includes(String(url)));
  const rpc = JSON.parse(init.body), session = new Headers(init.headers).get('X-SBISSessionID');
  const result = data => new Response(JSON.stringify({ jsonrpc: '2.0', id: rpc.id, result: data }));
  providerCalls.push({ method: rpc.method, session, account: rpc.params.Параметр?.НомерАккаунта });
  if (rpc.method === 'СБИС.Аутентифицировать') {
    assert.equal(session, null); assert.equal(rpc.params.Параметр.Логин, config.login); assert.equal(rpc.params.Параметр.Пароль, config.password);
    const role = rpc.params.Параметр.НомерАккаунта === config.accountNumber ? 'customer' : rpc.params.Параметр.НомерАккаунта === config.carrierAccountNumber ? 'carrier' : null;
    assert.ok(role); const token = `synthetic-${role}-session-${sessions.size}`; sessions.set(token, role); return result(token);
  }
  const role = sessions.get(session); assert.ok(role, 'Every request needs the correct account session');
  if (rpc.method === 'СБИС.СписокНашихОрганизаций') {
    const org = config[role]; assert.deepEqual(rpc.params.Фильтр.НашаОрганизация.СвЮЛ, { ИНН: org.inn, КПП: org.kpp });
    return result({ НашаОрганизация: [{ СвЮЛ: { ИНН: org.inn, КПП: org.kpp }, ДокументооборотПодключен: 'Да' }] });
  }
  assert.equal(role, 'customer', 'Only the customer account may access documents');
  if (rpc.method === 'СБИС.ЗаписатьДокумент') {
    const sent = rpc.params.Документ, xml = new TextDecoder('windows-1251').decode(Buffer.from(sent.Вложение[0].Файл.ДвоичныеДанные, 'base64'));
    assert.equal(sent.Тип, 'TransportOrder'); assert.equal(sent.НашаОрганизация.СвЮЛ.ИНН, config.customer.inn); assert.equal(sent.Контрагент.СвЮЛ.ИНН, config.carrier.inn);
    assert.match(xml, /КНД="1110361"/); assert.match(xml, /ВерсФорм="5.01"/); assert.ok(!xml.includes('Подпись'));
    const id = `qa-saby-${documents.size + 1}`;
    const saved = { ...sent, Идентификатор: id, Редакция: [{ Идентификатор: `${id}-revision` }], Состояние: { Название: 'Черновик' }, СсылкаДляНашаОрганизация: documentUrl(id), Вложение: [{ Тип: 'ЗаказЗаявка', Подтип: '1110361', ВерсияФормата: '5.01' }] };
    documents.set(id, saved);
    if (loseNextWrite) { loseNextWrite = false; throw new Error('Synthetic lost write response'); }
    return result(saved);
  }
  if (rpc.method === 'СБИС.ПрочитатьДокумент') { assert.ok(documents.has(rpc.params.Документ.Идентификатор)); return result(documents.get(rpc.params.Документ.Идентификатор)); }
  if (rpc.method === 'СБИС.СписокДокументов') return result({ Документ: [...documents.values()].filter(doc => doc.Номер === rpc.params.Фильтр.Маска), Навигация: { ЕстьЕще: 'Нет' } });
  throw new Error(`Forbidden provider method ${rpc.method}`);
};
const count = method => providerCalls.filter(call => call.method === method).length;
let runtime, browser, page;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient: new SabyClient(config, provider) });
  const { base } = runtime, { cookie } = await bootstrapQaAuth(base);
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
  await context.route('**/*', route => {
    if (new URL(route.request().url()).origin === base) return route.continue();
    report.unexpectedRequests.push(route.request().url()); return route.abort();
  });
  await authenticateContext(context, base, cookie); page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  const api = async (path, method = 'GET', data) => {
    const response = await context.request.fetch(base + path, { method, ...(data === undefined ? {} : { data }) });
    assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${await response.text()}`); return response.json();
  };
  const screenshot = async name => { const path = resolve(output, name + '.png'); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
  const choose = async (scope, label, name) => { const input = scope.getByRole('combobox', { name: new RegExp('^' + label) }); await input.fill(name); await scope.getByRole('listbox').getByRole('option', { name: new RegExp('^' + name + '(?:\\s|$)') }).click(); await expect(input).toHaveValue(name); };
  let savedBody, sabyPostRequests = 0;
  page.on('request', request => {
    if (request.method() === 'POST' && request.url() === base + '/api/shipment-trips') savedBody = request.postDataJSON();
    if (request.method() === 'POST' && request.url().startsWith(base + '/api/shipment-trips/') && request.url().endsWith('/saby')) sabyPostRequests++;
  });
  await page.goto(base + '/#trips'); await expect(page.getByRole('heading', { name: 'Рейсов пока нет' })).toBeVisible();
  await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await choose(dialog, 'Наша организация', 'АРТЕЛЬ'); await dialog.getByLabel('Дата отгрузки', { exact: false }).fill('2026-09-29');
  await choose(dialog, 'Поставщик', 'QA Склад'); await choose(dialog, 'Место загрузки', 'QA Погрузка');
  await dialog.getByLabel('Плановая погрузка', { exact: true }).fill('2026-09-29T10:30');
  await dialog.getByLabel('Цена поставщика за тонну, ₽', { exact: false }).fill('50000'); await dialog.getByLabel('Тоннаж всей машины, т', { exact: false }).fill('8'); await choose(dialog, 'Товар', 'QA Груз');
  for (const [index, name, litres, place] of [[0, 'QA Клиент А', '6000', 'QA Площадка А'], [1, 'QA Клиент Б', '4000', 'QA Площадка Б']]) {
    if (index) await dialog.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
    const row = dialog.getByTestId('trip-customer').nth(index);
    await choose(row, 'Клиент', name); await row.getByLabel('Количество литров, л', { exact: false }).fill(litres); await row.getByLabel('Цена за литр, ₽', { exact: false }).fill('70'); await row.getByLabel('Сумма перевозки, ₽', { exact: true }).fill('1000');
    await choose(row, 'Место выгрузки', place); await row.getByLabel('Плановая выгрузка').fill(`2026-09-29T${index ? '14' : '12'}:30`);
  }
  await choose(dialog, 'Перевозчик / водитель', 'QA Водитель');
  assert.equal((await api('/api/shipment-trips')).trips.length, 0); assert.equal((await api('/api/shipments')).total, 0);
  await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId('trip-card')).toHaveCount(1);
  const trip = (await api('/api/shipment-trips')).trips[0], endpoint = `/api/shipment-trips/${trip.id}/saby`;
  const accounting = (await store.read(source)).shipments;
  assert.equal(trip.customers.length, 2); assert.equal((await api('/api/shipments')).total, 2);
  assert.equal((await api('/api/shipment-trips', 'POST', savedBody)).trip.id, trip.id); assert.equal((await api('/api/shipments')).total, 2);
  check('UI save creates one trip and two shipments through authenticated HTTP; replay preserves IDs and accounting rows');
  const panel = page.getByRole('region', { name: 'Передача рейса в Saby' });
  await expect(panel).toContainText('Готов к передаче'); assert.equal(providerCalls.length, 0);
  const submit = panel.getByRole('button', { name: 'Передать в Saby', exact: true }); await expect(submit).toBeEnabled();
  await submit.evaluate(button => { button.click(); button.click(); });
  await expect(panel.locator('.trip-saby-heading')).toContainText('Создано в Saby, ожидает подписания'); await expect(submit).toBeDisabled();
  await expect(panel.getByRole('link', { name: 'Открыть в Saby', exact: false })).toHaveCount(2);
  assert.equal(sabyPostRequests, 1); assert.equal(count('СБИС.ЗаписатьДокумент'), 2); assert.equal(count('СБИС.ПрочитатьДокумент'), 2);
  assert.deepEqual(providerCalls.filter(call => call.method === 'СБИС.Аутентифицировать').map(call => call.account), [config.accountNumber, config.carrierAccountNumber]);
  assert.deepEqual((await store.read(source)).shipments, accounting);
  const confirmed = await api(endpoint), ids = confirmed.saby.documents.map(doc => doc.id);
  assert.equal(confirmed.saby.status, 'draft'); assert.equal(new Set(ids).size, 2);
  check('UI double-click calls the real backend once; two separate account sessions produce two formal drafts with read-back and visible Saby links');
  await screenshot('confirmed-drafts');
  const callsBeforeRepeat = providerCalls.length;
  assert.deepEqual((await api(endpoint, 'POST', {})).saby.documents.map(doc => doc.id), ids); assert.equal(providerCalls.length, callsBeforeRepeat);
  runtime.replaceMiddleware(new SabyClient(config, provider)); await page.reload();
  await page.getByRole('button', { name: 'Saby', exact: true }).click(); await expect(panel.locator('.trip-saby-heading')).toContainText('Создано в Saby, ожидает подписания');
  assert.deepEqual((await api(endpoint, 'POST', {})).saby.documents.map(doc => doc.id), ids); assert.equal(providerCalls.length, callsBeforeRepeat);
  const edit = { fields: trip.fields, customers: trip.customers.map(({ id, fields }) => ({ id, fields })), versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) };
  assert.equal((await context.request.patch(base + `/api/shipment-trips/${trip.id}`, { data: edit })).status(), 409);
  assert.equal((await context.request.delete(base + `/api/shipment-trips/${trip.id}`, { data: { versions: edit.versions } })).status(), 409);
  assert.deepEqual((await store.read(source)).shipments, accounting);
  check('Reload and fresh middleware/store preserve draft IDs; repeated POST makes zero provider requests and editing/deleting transmitted rows is blocked');
  const retryBody = { ...structuredClone(savedBody), idempotencyKey: randomUUID(), fields: { ...savedBody.fields, trip_notes: 'Потерянный ответ Saby' } };
  const retryTrip = (await api('/api/shipment-trips', 'POST', retryBody)).trip;
  const accountingBeforeLoss = (await store.read(source)).shipments;
  loseNextWrite = true; await page.reload();
  const retryCard = page.getByTestId('trip-card').filter({ hasText: 'Потерянный ответ Saby' }); await retryCard.getByRole('button', { name: 'Saby', exact: true }).click();
  await retryCard.getByRole('button', { name: 'Передать в Saby', exact: true }).click();
  await expect(retryCard.locator('.trip-saby-heading')).toContainText('Результат требует проверки'); assert.equal(count('СБИС.ЗаписатьДокумент'), 4);
  assert.deepEqual((await store.read(source)).shipments, accountingBeforeLoss);
  const retryEndpoint = `/api/shipment-trips/${retryTrip.id}/saby`;
  assert.equal((await api(retryEndpoint)).saby.status, 'unknown');
  await retryCard.getByRole('button', { name: 'Сверить с Saby', exact: true }).click();
  await expect(retryCard.locator('.trip-saby-heading')).toContainText('Создано в Saby, ожидает подписания');
  assert.equal(count('СБИС.ЗаписатьДокумент'), 4); assert.equal(count('СБИС.СписокДокументов'), 1);
  assert.equal((await api(retryEndpoint)).saby.status, 'draft'); assert.deepEqual((await store.read(source)).shipments, accountingBeforeLoss);
  check('Lost provider write response is shown as unknown; UI reconciliation finds the existing draft without a duplicate or accounting changes');
  await screenshot('reconciled-drafts');
  documentUrl = () => 'https://saby.ru.attacker.example/document';
  const unsafeTrip = (await api('/api/shipment-trips', 'POST', { ...structuredClone(savedBody), idempotencyKey: randomUUID() })).trip;
  const unsafe = await api(`/api/shipment-trips/${unsafeTrip.id}/saby`, 'POST', {});
  assert.ok(unsafe.saby.documents.every(doc => doc.url === null)); assert.equal(unsafe.saby.status, 'draft');
  check('Provider document links outside Saby/sbis are stripped by the real backend');
  const persisted = await readFile(resolve(operationsDirectory, 'operations.json'), 'utf8');
  for (const secret of [config.login, config.password, config.accountNumber, config.carrierAccountNumber, ...sessions.keys()]) {
    assert.ok(!persisted.includes(secret)); assert.ok(!JSON.stringify(confirmed).includes(secret));
  }
  assert.ok(!JSON.stringify(confirmed).includes('snapshot')); assert.ok(!JSON.stringify(confirmed).includes('QA Водитель'));
  assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
  check('Persisted and public responses contain no credentials or sessions; browser made no external requests');
} catch (error) {
  report.failure = error.message;
  if (page) { await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {}); console.error(await page.locator('body').innerText().catch(() => '')); }
  throw error;
} finally {
  for (const call of providerCalls) report.providerMethods[call.method] = (report.providerMethods[call.method] ?? 0) + 1;
  await browser?.close(); await runtime?.server.close(); await rm(temporary, { recursive: true, force: true });
  await writeFile(resolve(output, 'browser.json'), JSON.stringify(report, null, 2));
}

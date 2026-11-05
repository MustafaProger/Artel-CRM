// Genuine local CRM/API with a new persistent synthetic store per browser/viewport.
// Never changes the user-facing demo, source business data, or external providers.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { once } from 'node:events';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const root = resolve(import.meta.dirname, '..');
const qaRoot = resolve(root, '../qa-runtime');
const built = process.argv.includes('--built');
const runId = new Date().toISOString().replace(/[:.]/g, '-');
const fixedOutput = process.env.ARTEL_TRANSPORT_PRICING_QA_OUTPUT;
const output = fixedOutput ? resolve(fixedOutput) : resolve(root, built ? '../ui-transport-pricing-built' : '../ui-transport-pricing', runId);
// A stable report path must not reuse a consumed fixture or erase prior evidence.
const artifactsDirectory = fixedOutput ? resolve(output, 'runs', runId) : output;
const requestedEngine = process.argv.find(arg => arg.startsWith('--engine='))?.slice('--engine='.length);
const requestedWidth = Number(process.argv.find(arg => arg.startsWith('--width='))?.slice('--width='.length) || 0);
const engines = Object.entries({ chromium, webkit }).filter(([name]) => !requestedEngine || name === requestedEngine);
const widths = [1440, 375].filter(width => !requestedWidth || width === requestedWidth);
const report = { passed: false, mode: built ? 'built' : 'source', syntheticOnly: true, artifactsDirectory, checks: [], scenarios: [], externalRequests: [], pageErrors: [], failedRequests: [], axe: [] };
await mkdir(artifactsDirectory, { recursive: true });
async function saveReport() {
  const body = JSON.stringify(report, null, 2);
  await writeFile(resolve(artifactsDirectory, 'report.json'), body);
  if (artifactsDirectory !== output) await writeFile(resolve(output, 'report.json'), body);
}
async function readBuildManifest() {
  const entries = [];
  const walk = async relative => {
    for (const entry of (await readdir(resolve(root, 'app-dist', relative), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) { const bytes = await readFile(resolve(root, 'app-dist', name)); entries.push([name, { sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }]); }
      else throw new Error(`Unexpected build file: ${name}`);
    }
  };
  await walk('');
  const manifest = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)));
  assert.ok(manifest['index.html'], 'No built index.html; rebuild explicitly before running --built.');
  return { manifest, digest: createHash('sha256').update(JSON.stringify(manifest)).digest('hex') };
}
const buildBefore = built ? await readBuildManifest() : undefined;
if (built) { report.builtDigest = buildBefore.digest; report.builtFiles = Object.keys(buildBefore.manifest).length; await writeFile(resolve(artifactsDirectory, 'built-manifest.json'), JSON.stringify(buildBefore.manifest, null, 2)); }
const expect = baseExpect.configure({ timeout: 15000 });
const check = (name, details = {}) => { report.checks.push({ name, ...details }); console.log('PASS', name); };

async function startRuntime(name) {
  const state = resolve(artifactsDirectory, name, 'state');
  await mkdir(state, { recursive: true });
  const child = spawn(process.execPath, ['--import', 'tsx', resolve(qaRoot, 'serve.mjs'), '--port=5212', `--state=${state}`, ...(built ? ['--built'] : [])], { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  const ready = new Promise((done, fail) => {
    const timer = setTimeout(() => fail(new Error(`Runtime start timeout: ${log}`)), 30000);
    child.stdout.on('data', chunk => { log += chunk.toString(); if (log.includes('SYNTHETIC_PRICING_PREVIEW')) { clearTimeout(timer); done(); } });
    child.stderr.on('data', chunk => { log += chunk.toString(); });
    child.once('exit', code => { clearTimeout(timer); fail(new Error(`Runtime exited ${code}: ${log}`)); });
  });
  await ready;
  return { state, base: 'http://127.0.0.1:5212', async close() {
    const exit = once(child, 'exit'); child.kill('SIGTERM'); await exit;
    await writeFile(resolve(artifactsDirectory, name, 'runtime.log'), log);
  } };
}

for (const [engine, launcher] of engines) for (const width of widths) {
  const name = `${engine}-${width}`, directory = resolve(artifactsDirectory, name), runtime = await startRuntime(name);
  let browser, page;
  const scenario = { engine, width, reducedMotion: width === 375, passed: false };
  report.scenarios.push(scenario);
  try {
    browser = await launcher.launch();
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: width === 375 ? 'reduce' : 'no-preference', serviceWorkers: 'block' });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== runtime.base) { report.externalRequests.push({ engine, width, url: url.origin + url.pathname }); return route.abort(); }
      return route.continue();
    });
    page = await context.newPage();
    page.setDefaultTimeout(15000);
    page.on('pageerror', error => report.pageErrors.push({ engine, width, message: error.message, stack: error.stack, url: page.url() }));
    page.on('requestfailed', request => report.failedRequests.push({ engine, width, method: request.method(), url: request.url(), failure: request.failure() }));
    await page.goto(runtime.base + '/__preview');
    await expect(page.locator('.trips-section-tabs')).toBeVisible();
    const api = async (path, method = 'GET', body) => {
      const response = await context.request.fetch(runtime.base + path, { method, ...(body === undefined ? {} : { data: body }), headers: { Origin: runtime.base } });
      const value = await response.json();
      assert.ok(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(value)}`);
      return value;
    };
    if (built) {
      const status = await api('/__qa/status'); assert.equal(status.mode, 'built'); assert.equal(status.builtDigest, buildBefore.digest);
      if (report.scenarios.length === 1) {
        for (const [file, expected] of Object.entries(buildBefore.manifest)) {
          const response = await context.request.get(runtime.base + '/' + file), bytes = await response.body();
          assert.equal(response.status(), 200, file); assert.equal(bytes.length, expected.bytes, file); assert.equal(createHash('sha256').update(bytes).digest('hex'), expected.sha256, file);
        }
        report.builtFilesHttpExact = Object.keys(buildBefore.manifest).length;
      }
    }
    const catalog = async () => (await api('/api/directories')).directories;
    const settings = async values => { const current = (await catalog()).transportPricing; return api('/api/transport-pricing', 'PATCH', { ...current, ...values }); };
    const vehiclePatch = async values => {
      const row = (await catalog()).vehicles.find(row => row.id === 'vehicle'); const { id, version, ...fields } = row;
      return api(`/api/directories/vehicles/${id}`, 'PATCH', { ...fields, ...values, version: version ?? 0 });
    };
    let navigation = 0;
    const navigate = async hash => { await page.waitForLoadState('networkidle'); await page.goto(runtime.base + '/?qaNavigation=' + (++navigation) + '#' + hash); };
    const dialog = () => page.getByRole('dialog');
    const choose = async (scope, label, text) => {
      const box = scope.getByRole('combobox', { name: new RegExp('^' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '(?: \\*)?$') });
      await box.fill(text);
      await scope.getByRole('option').filter({ hasText: text }).first().click();
    };
    const cancel = async () => {
      await dialog().getByRole('button', { name: 'Отмена', exact: true }).click();
      const discard = dialog().getByRole('button', { name: 'Закрыть без сохранения', exact: true });
      if (await discard.count()) await discard.click();
      await expect(dialog()).toHaveCount(0);
    };
    const fit = async (locator, label) => {
      assert.ok(await locator.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${name}: horizontal overflow ${label}`);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}: viewport overflow ${label}`);
    };
    const axe = async (selector, phase) => {
      const result = await new AxeBuilder({ page }).include(selector).analyze();
      report.axe.push({ engine, width, phase, violations: result.violations.map(row => ({ id: row.id, impact: row.impact, nodes: row.nodes.map(node => ({ target: node.target, failureSummary: node.failureSummary })) })) });
      assert.deepEqual(result.violations.map(row => row.id), [], `${name}: axe ${phase}`);
    };

    // Vehicle tariff UI: positional input, invalid count/value, persistence.
    await navigate('directories');
    const tabs = page.getByRole('group', { name: 'Справочники', exact: true });
    await tabs.getByRole('button', { name: 'Автомобили', exact: true }).click();
    await page.getByRole('button', { name: 'Редактировать: Учебный бензовоз 3 секции', exact: true }).click();
    const prices = dialog().getByLabel('Стоимость выезда секций, ₽ (через +)', { exact: true });
    await expect(prices).toHaveValue('3000 + 4000 + 4000');
    await prices.fill('3000 + 4000');
    await dialog().getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(dialog().getByRole('alert')).toContainText('секций');
    await prices.fill('3000 + -4000 + 4000');
    await dialog().getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(dialog().getByRole('alert')).toContainText('Стоимость');
    await prices.fill('3000 + 4100 + 4700');
    await fit(dialog(), 'vehicle'); await axe('dialog', 'vehicle');
    await page.screenshot({ path: resolve(directory, 'vehicle-tariffs.png'), fullPage: true });
    await dialog().getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog()).toHaveCount(0);
    assert.deepEqual((await catalog()).vehicles.find(row => row.id === 'vehicle').compartmentDeparturePricesRub, ['3000', '4100', '4700']);
    await page.getByRole('button', { name: 'Редактировать: Учебный бензовоз 3 секции', exact: true }).click();
    await expect(prices).toHaveValue('3000 + 4100 + 4700');
    await dialog().getByRole('button', { name: 'Отмена', exact: true }).click();
    check(`${name}: vehicle positional tariffs validate and persist`);

    // General settings: explicit rounding choice, validation and reload.
    const general = page.locator('.transport-settings');
    await general.getByRole('button', { name: 'Изменить тарифы', exact: true }).click();
    await general.getByLabel('Ставка за километр, ₽/км', { exact: true }).fill('-1');
    await general.getByRole('button', { name: 'Сохранить тарифы', exact: true }).click();
    await expect(general.getByRole('alert')).toBeVisible();
    await general.getByLabel('Ставка за километр, ₽/км', { exact: true }).fill('46');
    await general.getByLabel('Доплата за клиента, ₽', { exact: true }).fill('1800');
    await general.getByLabel(/^Округление итога/).selectOption('ceil100');
    await general.getByRole('button', { name: 'Сохранить тарифы', exact: true }).click();
    await expect(general.getByRole('status')).toContainText('Тарифы сохранены');
    await page.waitForLoadState('networkidle'); await page.reload(); await tabs.getByRole('button', { name: 'Автомобили', exact: true }).click();
    await expect(general).toContainText('46 ₽/км'); await expect(general).toContainText('вверх до 100 ₽');
    await fit(general, 'settings'); await axe('.transport-settings', 'settings');
    await page.screenshot({ path: resolve(directory, 'general-tariffs.png'), fullPage: true });
    await settings({ ratePerKmRub: '45', customerSurchargeRub: '1750', rounding: 'nearest100' });
    check(`${name}: common settings validation, rounding and reload`);

    const tripsView = async () => { await navigate('trips'); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Рейсы', exact: true }).click(); };
    const newTrip = async (customerText = 'Площадка 50 км') => {
      await tripsView(); await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
      await expect(dialog()).toBeVisible();
      await choose(dialog(), 'Поставщик', 'Поставщик — учебный');
      await choose(dialog(), 'Нефтебаза', 'Нефтебаза А — учебная');
      await choose(dialog(), 'Товар', 'ДТ — учебный');
      await dialog().getByLabel('Цена поставщика за тонну, ₽', { exact: false }).fill('50000');
      await dialog().getByLabel('Плановая дата рейса · Москва — время', { exact: true }).fill('09:00');
      await choose(dialog(), 'Водитель', 'Учебный водитель');
      await choose(customer(0), 'Заявка на доставку', customerText);
      return customer(0);
    };
    const customer = index => dialog().getByTestId('trip-customer').nth(index);
    const amount = index => customer(index).getByLabel('Сумма перевозки, ₽', { exact: true });
    const sections = async (index, indexes) => {
      const inputs = customer(index).locator('.trip-transport-sections input[type=checkbox]');
      for (let section = 0; section < await inputs.count(); section++) await inputs.nth(section).setChecked(indexes.includes(section));
    };
    const automatic = async index => {
      const button = customer(index).getByRole('button', { name: /^(Рассчитать автоматически|Пересчитать по текущим тарифам)$/ });
      if (await button.count()) await button.click();
    };
    const saveTrip = async () => {
      const response = page.waitForResponse(response => new URL(response.url()).pathname.startsWith('/api/shipment-trips') && ['POST', 'PATCH'].includes(response.request().method()));
      await dialog().getByRole('button', { name: 'Сохранить рейс', exact: true }).click();
      const result = await response, body = await result.json(); assert.ok(result.ok(), JSON.stringify(body));
      await expect(dialog()).toHaveCount(0); return body.trip;
    };
    const editTrip = async trip => {
      await tripsView();
      const card = page.locator('.trip-card').filter({ has: page.getByRole('heading', { name: `Рейс №${trip.number}`, exact: true }) });
      await card.getByRole('button', { name: 'Изменить рейс', exact: true }).click();
      await expect(dialog().getByLabel('Сумма перевозки, ₽', { exact: true }).first()).toBeVisible();
    };

    // Equal capacities must keep distinct physical section identity and tariffs.
    await newTrip('Клиент 70 км — секция 3');
    await sections(0, [1]); await expect(amount(0)).toHaveValue('9000');
    await sections(0, [2]); await expect(amount(0)).toHaveValue('9600');
    await cancel(); await vehiclePatch({ compartmentDeparturePricesRub: ['3000', '4000', '4000'] });
    check(`${name}: equal-volume sections retain their own tariffs`);

    // A request-specific address cannot reuse kilometres from its original directory place.
    await api('/api/trip-requests', 'POST', { companyId: 'customer-70', addressId: 'delivery-70', address: 'Учебный другой адрес — собственное расстояние', quantityLitres: '4000', salePricePerLitre: '60', comment: 'Проверка другого адреса', executionDate: '2026-11-05' });
    await newTrip('Учебный другой адрес — собственное расстояние'); await sections(0, [2]); await expect(amount(0)).toHaveValue('');
    await customer(0).getByRole('button', { name: 'Показать расчёт', exact: true }).click();
    await expect(customer(0).locator('.trip-transport-breakdown')).toContainText(/[Аа]дрес/);
    await amount(0).fill('9999'); const customManualTrip = await saveTrip();
    assert.equal((await api('/api/shipment-trips/' + customManualTrip.id)).trip.customers[0].fields.transport_amount, '9999');
    check(`${name}: request address override blocks unrelated kilometres and manual9999 saves`);

    // Full truck example, live dependency changes, incomplete and manual cases.
    await newTrip();
    await expect(amount(0)).toHaveValue('');
    await sections(0, [0, 1, 2]); await expect(amount(0)).toHaveValue('15000');
    let toggle = customer(0).getByRole('button', { name: 'Показать расчёт', exact: true });
    await expect(toggle).toHaveAttribute('aria-expanded', 'false'); await toggle.focus(); await page.keyboard.press('Enter');
    toggle = customer(0).getByRole('button', { name: 'Скрыть расчёт', exact: true }); await expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await expect(customer(0).locator('.trip-transport-breakdown')).toContainText('50 км × 45');
    await expect(customer(0).locator('.trip-transport-breakdown')).toContainText('До округления');
    await expect(customer(0).locator('.trip-transport-breakdown')).toContainText('До ближайших 100 ₽, половина вверх.');
    await expect(customer(0).locator('.trip-transport-breakdown')).toHaveCSS('opacity', '1');
    await fit(dialog(), 'calculation'); await axe('dialog', 'new-trip');
    if (width === 375) assert.equal(await customer(0).locator('.trip-transport-breakdown').evaluate(element => getComputedStyle(element).transitionDuration), '0s');
    await page.screenshot({ path: resolve(directory, 'full-calculation.png'), fullPage: true });
    await customer(0).locator('.trip-transport-breakdown-body').scrollIntoViewIfNeeded();
    await page.screenshot({ path: resolve(directory, 'calculation-details.png'), fullPage: true });
    await toggle.focus(); await page.keyboard.press('Space');
    await expect(customer(0).getByRole('button', { name: 'Показать расчёт', exact: true })).toHaveAttribute('aria-expanded', 'false');
    await choose(dialog(), 'Нефтебаза', 'Нефтебаза Б — учебная'); await expect(amount(0)).toHaveValue('16400');
    await choose(dialog(), 'Нефтебаза', 'Нефтебаза А — учебная');
    await choose(customer(0), 'Заявка на доставку', 'Вторая площадка 20 км'); await sections(0, [0, 1, 2]); await expect(amount(0)).toHaveValue('13700');
    await choose(customer(0), 'Заявка на доставку', 'Площадка без километров'); await expect(amount(0)).toHaveValue('');
    await amount(0).fill('12345'); await choose(dialog(), 'Нефтебаза', 'Нефтебаза Б — учебная'); await expect(amount(0)).toHaveValue('12345');
    await automatic(0); await expect(amount(0)).toHaveValue('');
    await choose(customer(0), 'Заявка на доставку', 'Площадка 50 км'); await choose(dialog(), 'Нефтебаза', 'Нефтебаза А — учебная');
    await choose(dialog(), 'Автомобиль', 'Учебный бензовоз 2 секции'); await expect(amount(0)).toHaveValue('');
    await expect(customer(0).locator('.trip-transport-sections input')).toHaveCount(2); await sections(0, [0, 1]); await expect(amount(0)).toHaveValue('12700');
    await choose(dialog(), 'Автомобиль', 'Учебная машина без тарифов'); await sections(0, [0, 1, 2]); await expect(amount(0)).toHaveValue('');
    await choose(dialog(), 'Автомобиль', 'Учебный бензовоз 3 секции'); await sections(0, [0, 1, 2]);
    await customer(0).getByLabel('Количество литров, л', { exact: false }).fill('10000'); await expect(amount(0)).toHaveValue('');
    await customer(0).getByLabel('Количество литров, л', { exact: false }).fill('11000'); await expect(amount(0)).toHaveValue('15000');
    const fullTrip = await saveTrip();
    let savedFull = (await api('/api/shipment-trips/' + fullTrip.id)).trip;
    assert.equal(savedFull.customers[0].fields.transport_amount, '15000');
    const originalSnapshot = savedFull.customers[0].fields.transport_price_snapshot;
    assert.deepEqual(JSON.parse(originalSnapshot).sections.map(section => section.index), [0, 1, 2]);
    check(`${name}: full15000, live depot/address/vehicle, missing inputs, partial loading, manual override and save`);

    // Existing auto snapshots and historical manual sums survive tariff changes/reload.
    await settings({ ratePerKmRub: '60', customerSurchargeRub: '2000' });
    await editTrip(fullTrip); await expect(amount(0)).toHaveValue('15000');
    await customer(0).getByRole('button', { name: 'Показать расчёт', exact: true }).click();
    await expect(customer(0).locator('.trip-transport-breakdown')).toContainText('50 км × 45');
    await dialog().getByLabel(/^Примечание к рейсу/).fill('Учебное редактирование без пересчёта'); await saveTrip();
    savedFull = (await api('/api/shipment-trips/' + fullTrip.id)).trip;
    assert.equal(savedFull.customers[0].fields.transport_price_snapshot, originalSnapshot);
    const seed = JSON.parse(await readFile(resolve(runtime.state, 'seed.json'), 'utf8'));
    const legacyTrip = (await api('/api/shipment-trips/' + seed.legacyTripId)).trip;
    await editTrip(legacyTrip); await expect(amount(0)).toHaveValue('4321'); await sections(0, [0, 1, 2]); await expect(amount(0)).toHaveValue('4321');
    await dialog().getByLabel(/^Примечание к рейсу/).fill('Учебная ручная сумма сохранена'); await saveTrip();
    assert.equal((await api('/api/shipment-trips/' + seed.legacyTripId)).trip.customers[0].fields.transport_amount, '4321');
    await settings({ ratePerKmRub: '45', customerSurchargeRub: '1750' });
    check(`${name}: frozen snapshot and old manual4321 survive tariff changes and reload/edit`);

    // Two customer example and explicit conflict on shared section assignment.
    await newTrip('Клиент 30 км — секции 1 и 2'); await sections(0, [0, 1]); await expect(amount(0)).toHaveValue('10100');
    await dialog().getByRole('button', { name: 'Добавить клиента', exact: true }).click();
    await choose(customer(1), 'Заявка на доставку', 'Клиент 70 км — секция 3'); await sections(1, [2]); await expect(amount(1)).toHaveValue('8900');
    await sections(0, [0, 1, 2]); await expect(amount(0)).toHaveValue(''); await expect(amount(1)).toHaveValue('');
    await sections(0, [0, 1]); await expect(amount(0)).toHaveValue('10100'); await expect(amount(1)).toHaveValue('8900');
    for (let index = 0; index < 2; index++) { await customer(index).getByRole('button', { name: 'Показать расчёт', exact: true }).click(); await expect(customer(index).locator('.trip-transport-breakdown')).toHaveCSS('opacity', '1'); }
    await fit(dialog(), 'split'); await axe('dialog', 'split-trip');
    await page.screenshot({ path: resolve(directory, 'split-calculation.png'), fullPage: true });
    const splitTrip = await saveTrip();
    const savedSplit = (await api('/api/shipment-trips/' + splitTrip.id)).trip;
    assert.deepEqual(savedSplit.customers.map(row => row.fields.transport_amount), ['10100', '8900']);
    await editTrip(splitTrip); await expect(amount(0)).toHaveValue('10100'); await expect(amount(1)).toHaveValue('8900'); await cancel();
    check(`${name}: split10100/8900, duplicate section guard, persistence and reopen`);

    const external = await api('/__qa/status'); assert.deepEqual(external.externalAttempts, []);
    scenario.passed = true;
  } catch (error) {
    scenario.error = error.stack || String(error);
    if (page) { await page.screenshot({ path: resolve(directory, 'failure.png'), fullPage: true }).catch(() => {}); await writeFile(resolve(directory, 'failure.html'), await page.content().catch(() => '')); }
    throw error;
  } finally {
    await page?.waitForLoadState('networkidle').catch(() => {}); await browser?.close(); await runtime.close();
    await saveReport();
  }
}
assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.pageErrors, []);
for (const request of report.failedRequests) {
  const url = new URL(request.url);
  assert.ok(url.origin === 'http://127.0.0.1:5212' && url.pathname.startsWith('/api/') && request.method === 'GET' && ['cancelled', 'net::ERR_ABORTED'].includes(request.failure?.errorText), `Unexpected failed request: ${JSON.stringify(request)}`);
}
report.localReadAbortCount = report.failedRequests.length;
if (built) { assert.deepEqual(await readBuildManifest(), buildBefore, 'Built files changed during the browser matrix.'); report.builtFilesUnchanged = true; }
report.passed = true;
await saveReport();
console.log(JSON.stringify({ passed: true, scenarios: report.scenarios.length, checks: report.checks.length, output }));

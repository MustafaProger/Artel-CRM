// Real application/API against a fresh synthetic store. No working data or provider writes.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { SabyClient, sabyConfigFromEnv } from '../server/saby-client.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-trip-requests-ui-'));
const output = resolve(root, 'qa/request-price-2026-10-17');
await mkdir(output, { recursive: true });
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
const source = await writeTripsQaSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const company = (id, name, role) => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
await store.mutate(source, data => {
  data.sourceOperationsCleared = true;
  data.companies = [company('qa-supplier', 'Учебная нефтебаза', 'supplier'), ...[1,2,3,4].map(n => company(`qa-${n}`, `ООО «Ромашка ${n}»`, 'customer'))];
  data.directories = {
    fleetSeedApplied: true, managers: [{ id: 'qa-manager', name: 'Учебный сотрудник' }],
    products: [{ id: 'qa-product', name: 'Дизельное топливо', transportProductKind: 'diesel', cargoPackaging: 'bulk' }],
    paymentForms: [{ id: 'qa-payment', name: 'б/нал' }],
    vehicles: [{ id: 'qa-vehicle', plate: 'Т000ЕЕ00', capacityLitres: '20000' }],
    drivers: [{ id: 'qa-driver', name: 'Учебный водитель', vehicleId: 'qa-vehicle' }],
    oilDepots: [{ id: 'qa-depot', name: 'Учебный терминал', address: 'Учебная погрузка, 1', ownerCompanyId: 'qa-supplier', loadingActorCompanyId: 'qa-supplier', infrastructureOwnerCompanyId: 'qa-supplier' }],
    addresses: [1,2,3,4].map(n => ({ id: `qa-place-${n}`, companyId: `qa-${n}`, kind: 'delivery', name: `База ${n}`, address: `Учебный адрес, ${n}`, latitude: String(55.65 + n / 50), longitude: String(37.5 + n / 40) })),
    customerManagers: [1,2,3,4].map(n => ({ companyId: `qa-${n}`, managerId: 'qa-manager' })), defaults: { profit: 'template-payment-form' }, duplicates: [],
  };
  // Imported locations may store the complete street address in name only.
  data.directories.addresses.push({ id: 'qa-place-second', companyId: 'qa-1', kind: 'delivery', name: 'Другой учебный адрес, 5', latitude: '55.8', longitude: '37.8' });
  return { changed: true, result: null };
});
const report = { fixtureOnly: true, workingStoreAccessed: false, realLeaflet: false, stubbedTiles: true, realTileProviderVerified: false, tileRequests: 0, externalRequests: [], providerCalls: 0, checks: [], screenshots: [], browserErrors: [] };
const tileSvg = '<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eaf0e5"/><path d="M0 75H256M65 0V256M0 190H256M194 0V256" stroke="#fff" stroke-width="12"/><text x="80" y="142" fill="#85917d" font-family="sans-serif" font-size="12">QA TILE</text></svg>';
const check = name => { report.checks.push(name); console.log('PASS', name); };
const commentFor = n => n === 1 ? `Перед разгрузкой позвонить.\nВъезд со стороны склада.\n${'ДлинныйКомментарий'.repeat(14)}` : `Доставка ${n}: учебный комментарий`;
let runtime, browser;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient: new SabyClient(sabyConfigFromEnv({}), async () => { report.providerCalls++; throw new Error('External provider writes forbidden'); }) });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.ok, `${method} ${path}: ${result.error || response.status}`); return result;
  };
  if (process.argv.includes('--review')) {
    for (const n of [1,2,3,4]) await call('/api/trip-requests', 'POST', { companyId: `qa-${n}`, addressId: n === 1 ? 'qa-place-second' : `qa-place-${n}`, quantityLitres: String(n === 1 ? 15000 : n * 1000), comment: `Доставка ${n}: учебный комментарий` });
    // Available only on this synthetic loopback review server; the session stays in memory.
    runtime.server.middlewares.stack.unshift({ route: '', handle(req, res, next) {
      if (req.url !== '/__qa/open') return next();
      res.writeHead(302, { 'Set-Cookie': `${cookie}; HttpOnly; SameSite=Strict; Path=/`, Location: '/#trips' }); res.end();
    } });
    console.log(`Synthetic review: ${runtime.base}/__qa/open`);
    await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
  } else {
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await authenticateContext(context, runtime.base, cookie);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin === runtime.base && url.pathname === '/api/trip-requests/geocode') return route.fulfill({ json: { status: 'not_found', message: 'Synthetic fixture has no geocode result.' } });
      if (url.hostname === 'tile.openstreetmap.org') {
        report.tileRequests++;
        return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: tileSvg });
      }
      if (url.origin !== runtime.base) { report.externalRequests.push(url.href); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => report.browserErrors.push(`${engine}: ${error.message}`));
    const choose = async (scope, label, name) => { const picker = scope.getByRole('combobox', { name: new RegExp('^' + label) }); await picker.fill(name); await scope.getByRole('listbox').getByRole('option', { name: new RegExp(name) }).first().click(); };
    const previousTripIds = new Set((await call('/api/shipment-trips')).trips.map(trip => trip.id));
    await page.goto(runtime.base + '/#trips');
    const tabs = page.getByRole('group', { name: 'Разделы рейсов', exact: true });
    await expect(tabs.getByRole('button', { name: 'Заявки', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await tabs.getByRole('button', { name: 'Рейсы', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Новый рейс', exact: true })).toBeEnabled();
    await expect(tabs.locator('button svg')).toHaveCount(3);
    await expect(page.getByText(/Для нового рейса сначала/)).toHaveCount(0);
    await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
    const directDialog = page.getByRole('dialog');
    await directDialog.getByLabel('Плановая дата рейса · Москва', { exact: true }).fill('2099-10-08');
    await directDialog.getByLabel('Плановая дата рейса · Москва — время', { exact: true }).fill('09:00');
    await choose(directDialog, 'Поставщик', 'Учебная нефтебаза'); await choose(directDialog, 'Нефтебаза', 'Учебный терминал'); await choose(directDialog, 'Товар', 'Дизельное топливо');
    await directDialog.getByLabel('Цена поставщика за тонну, ₽', { exact: false }).fill('60000');
    const directRow = directDialog.getByTestId('trip-customer');
    await choose(directRow, 'Клиент', 'Ромашка 1');
    await choose(directRow, 'Место выгрузки', 'Другой учебный адрес, 5');
    await directRow.getByLabel('Количество литров, л', { exact: false }).fill('500');
    await directRow.getByLabel('Цена за литр, ₽', { exact: false }).fill('75');
    await choose(directDialog, 'Водитель', 'Учебный водитель');
    await directDialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click();
    await expect(directDialog).toHaveCount(0);
    const directTrip = (await call('/api/shipment-trips')).trips.find(trip => !previousTripIds.has(trip.id));
    assert.equal(directTrip.customers[0].fields.quantity_litres, '500');
    assert.ok(!directTrip.customers[0].fields.source_request_id);
    assert.equal((await call('/api/trip-requests')).requests.length, 0);
    check(`${engine}: empty request queue permits direct trip creation from directory; tab icons and removed hints verified`);
    await tabs.getByRole('button', { name: 'Заявки', exact: true }).click();
    await expect(page.getByText(/Заявки, доступные для создания рейса/)).toHaveCount(0);
    for (const n of [1,2,3,4]) {
      await page.getByRole('button', { name: 'Новая заявка', exact: true }).click();
      const editor = page.getByRole('dialog');
      await choose(editor, 'Компания', `Ромашка ${n}`);
      await choose(editor, 'Место доставки', n === 1 ? 'Другой учебный адрес, 5' : `База ${n}`);
      if (n === 1) {
        await expect(editor.getByRole('combobox', { name: /^Место доставки/ })).toHaveValue('Другой учебный адрес, 5');
        await expect(editor.locator('.trip-request-selected-address')).toHaveCount(0);
        await expect(editor.getByRole('textbox', { name: 'Адрес доставки *', exact: true })).toHaveValue('Другой учебный адрес, 5');
        await expect(editor.getByText('Для этого места ещё не заполнен адрес в справочнике.', { exact: true })).toHaveCount(0);
      } else {
        await expect(editor.getByRole('textbox', { name: 'Адрес доставки *', exact: true })).toHaveValue(`Учебный адрес, ${n}`);
      }
      await editor.getByLabel('Количество литров, л', { exact: false }).fill(String(n === 1 ? 15000 : n * 1000));
      if (n === 1) await editor.getByLabel('Цена за литр для клиента, ₽', { exact: true }).fill('64,5');
      await editor.getByLabel('Комментарий', { exact: true }).fill(commentFor(n));
      await editor.getByRole('button', { name: 'Сохранить заявку', exact: true }).click();
      await expect(editor).toHaveCount(0);
    }
    await expect(page.getByTestId('trip-request-card')).toHaveCount(4);
    const initial = (await call('/api/trip-requests')).requests;
    assert.equal(initial.length, 4); assert.equal(initial.find(row => row.companyId === 'qa-1').addressId, 'qa-place-second');
    assert.equal(initial.find(row => row.companyId === 'qa-1').address, 'Другой учебный адрес, 5');
    check(`${engine}: request entry selects company and one of its places; four requests persist; requests remain optional`);
    const legacyCard = page.getByTestId('trip-request-card').filter({ has: page.getByRole('heading', { name: 'ООО «Ромашка 1»', exact: true }) });
    const namedCard = page.getByTestId('trip-request-card').filter({ has: page.getByRole('heading', { name: 'ООО «Ромашка 2»', exact: true }) });
    await legacyCard.getByRole('button', { name: /^Изменить заявку:/ }).click();
    const priceEditor = page.getByRole('dialog');
    await expect(priceEditor.getByLabel('Цена за литр для клиента, ₽', { exact: true })).toHaveValue('64.5');
    await expect(priceEditor.getByRole('button', { name: 'Сохранить заявку', exact: true })).toBeDisabled();
    await priceEditor.getByLabel('Цена за литр для клиента, ₽', { exact: true }).fill('65');
    await priceEditor.getByRole('button', { name: 'Сохранить заявку', exact: true }).click();
    await expect(priceEditor).toHaveCount(0);
    await page.reload();
    assert.equal((await call('/api/trip-requests')).requests.find(row => row.companyId === 'qa-1').salePricePerLitre, '65');
    check(`${engine}: decimal request price persists, edits alone enable save and reload retains 65`);
    await expect(legacyCard.getByText('Другой учебный адрес, 5', { exact: true })).toHaveCount(1);
    await expect(legacyCard.getByText('Площадка', { exact: true })).toHaveCount(0);
    await expect(namedCard.locator('.trip-request-location dt')).toHaveText(['Площадка', 'Адрес доставки']);
    await expect(namedCard.locator('.trip-request-location dd')).toHaveText(['База 2', 'Учебный адрес, 2']);
    await expect(legacyCard.getByRole('heading', { name: 'Комментарий', exact: true })).toBeVisible();
    assert.equal(await legacyCard.locator('.trip-request-comment p').textContent(), commentFor(1));
    const commentStyle = await legacyCard.locator('.trip-request-comment p').evaluate(node => ({ whiteSpace: getComputedStyle(node).whiteSpace, overflowWrap: getComputedStyle(node).overflowWrap }));
    assert.deepEqual(commentStyle, { whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' });
    check(`${engine}: legacy address appears once; distinct site has a label; comment preserves multiline text and long words`);
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), { message: `${engine} requests fit ${width}` }).toBe(true).catch(async error => { console.log(JSON.stringify(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => ({ tag: node.tagName, class: node.className, width: node.getBoundingClientRect().width, right: node.getBoundingClientRect().right })).slice(0,30)))); await page.screenshot({ path: resolve(output, `${engine}-overflow.png`), fullPage: true }); throw error; });
      for (const [action, label] of [['edit', 'Изменить'], ['delete', 'Удалить']]) {
        const button = legacyCard.locator(`.trip-request-${action}`);
        await expect(button).toBeVisible(); await expect(button).toHaveText(label);
        assert.ok(await button.evaluate(node => node.getBoundingClientRect().height >= 44 && node.scrollWidth <= node.clientWidth + 1), `${engine} ${label} touch target at ${width}`);
      }
      const tones = await legacyCard.evaluate(node => {
        const edit = getComputedStyle(node.querySelector('.trip-request-edit'));
        const remove = getComputedStyle(node.querySelector('.trip-request-delete'));
        return { yellow: edit.backgroundColor.match(/\d+/g).map(Number), red: remove.color.match(/\d+/g).map(Number) };
      });
      assert.ok(tones.yellow[0] > 230 && tones.yellow[1] > 200 && tones.yellow[2] < 210, `${engine} edit button is yellow`);
      assert.ok(tones.red[0] > tones.red[1] * 2 && tones.red[0] > tones.red[2] * 2, `${engine} delete button is red`);
      await page.getByRole('heading', { name: 'Рейсы', exact: true }).click();
      const screenshot = resolve(output, `${engine}-requests-${width}.png`); await page.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
      await legacyCard.getByRole('button', { name: /^Изменить заявку:/ }).click();
      const editDialog = page.getByRole('dialog');
      await expect(editDialog.getByRole('textbox', { name: 'Адрес доставки *', exact: true })).toHaveValue('Другой учебный адрес, 5');
      await expect(editDialog.locator('.trip-request-place dd')).toHaveCount(0);
      await expect(editDialog.getByRole('textbox', { name: 'Комментарий', exact: true })).toHaveValue(commentFor(1));
      await expect(editDialog.getByLabel('Цена за литр для клиента, ₽', { exact: true })).toHaveValue('65');
      assert.ok(await editDialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine} request editor fits ${width}`);
      const editorScreenshot = resolve(output, `${engine}-editor-${width}.png`); await page.screenshot({ path: editorScreenshot, fullPage: true }); report.screenshots.push(editorScreenshot);
      await editDialog.getByRole('button', { name: 'Отмена', exact: true }).click(); await expect(editDialog).toHaveCount(0);
    }
    await legacyCard.getByRole('button', { name: /^Удалить заявку:/ }).click();
    await expect(page.getByRole('dialog').getByRole('heading', { name: 'Удалить заявку?', exact: true })).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    assert.equal((await call('/api/trip-requests')).requests.length, 4);
    check(`${engine}: labeled yellow edit/red delete controls and request editor fit 320–1440 px; cancelling deletion preserves requests`);
    await tabs.getByRole('button', { name: 'Рейсы', exact: true }).click();
    await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Плановая дата рейса · Москва', { exact: true }).fill('2099-10-08');
    await dialog.getByLabel('Плановая дата рейса · Москва — время', { exact: true }).fill('09:00');
    await choose(dialog, 'Поставщик', 'Учебная нефтебаза'); await choose(dialog, 'Нефтебаза', 'Учебный терминал'); await choose(dialog, 'Товар', 'Дизельное топливо');
    await dialog.getByLabel('Цена поставщика за тонну, ₽', { exact: false }).fill('60000');
    for (const [index,n] of [1,3].entries()) {
      if (index) await dialog.getByRole('button', { name: 'Добавить клиента', exact: true }).click();
      const row = dialog.getByTestId('trip-customer').nth(index);
      await choose(row, 'Заявка на доставку', `Ромашка ${n}`);
      await expect(row.getByLabel('Количество литров, л', { exact: false })).toHaveValue(String(n === 1 ? 15000 : n * 1000));
      await expect(row.getByLabel('Примечание к доставке', { exact: true })).toHaveValue(commentFor(n));
      await expect(row.getByLabel('Цена за литр, ₽', { exact: false })).toHaveValue(n === 1 ? '65' : '');
      if (n === 1) {
        await choose(row, 'Заявка на доставку', 'Ромашка 2');
        await expect(row.getByLabel('Цена за литр, ₽', { exact: false })).toHaveValue('');
        await choose(row, 'Заявка на доставку', 'Ромашка 1');
        await expect(row.getByLabel('Цена за литр, ₽', { exact: false })).toHaveValue('65');
        await row.getByLabel('Цена за литр, ₽', { exact: false }).fill('66');
        await row.getByLabel('Количество литров, л', { exact: false }).fill('14500');
      } else await row.getByLabel('Цена за литр, ₽', { exact: false }).fill('75');
    }
    await choose(dialog, 'Водитель', 'Учебный водитель');
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({ width, height: 1000 }); assert.ok(await dialog.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${engine} trip editor fits ${width}`);
    }
    await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await expect(dialog).toHaveCount(0);
    const remaining = (await call('/api/trip-requests')).requests;
    assert.deepEqual(remaining.map(row => row.companyId).sort(), ['qa-2','qa-4']);
    const trips = (await call('/api/shipment-trips')).trips;
    const trip = trips.find(trip => trip.customers.some(row => row.fields.source_request_id === initial.find(request => request.companyId === 'qa-1').id)); assert.deepEqual(trip.customers.map(row => row.fields.quantity_litres), ['14500','3000']);
    assert.equal(trip.customers[0].fields.sale_price_per_litre, '66');
    const consumed = (await store.read(source)).tripRequests[initial.find(row => row.companyId === 'qa-1').id];
    assert.equal(consumed.salePricePerLitre, '65'); assert.equal(consumed.quantityLitres, '15000');
    check(`${engine}: 15000 litres and 65 autofill; independent 14500/66 overrides persist while request remains 15000/65`);
    assert.equal(trip.customers[0].fields.unloading_address, 'Другой учебный адрес, 5');
    check(`${engine}: name-only directory address displays, creates a request and transfers unchanged into the trip`);
    assert.equal(trip.customers[0].fields.delivery_notes, commentFor(1));
    await tabs.getByRole('button', { name: 'Заявки', exact: true }).click(); await expect(page.getByTestId('trip-request-card')).toHaveCount(2);
    await page.reload(); await expect(page.getByTestId('trip-request-card')).toHaveCount(2);
    check(`${engine}: four requests become two after trip creation; selected liters/place/comment persist; reload retains queue`);
    await tabs.getByRole('button', { name: 'Рейсы', exact: true }).click();
    await page.getByRole('button', { name: 'Новый рейс', exact: true }).click();
    const picker = page.getByRole('dialog').getByRole('combobox', { name: /^Заявка на доставку/ }); await picker.click();
    await expect(page.getByRole('listbox').getByRole('option')).toHaveCount(2);
    check(`${engine}: next trip offers only the two remaining requests`);
    await context.close(); await browser.close(); browser = null;
    for (const request of remaining) await call(`/api/trip-requests/${request.id}`, 'DELETE', { version: request.version });
  }
  assert.deepEqual(report.externalRequests, []);
  assert.equal(report.providerCalls, 0); assert.deepEqual(report.browserErrors, []); report.passed = true;
  }
} catch (error) { report.passed = false; report.error = error.message; throw error; }
finally { await browser?.close(); await runtime?.server.close(); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); await rm(temporary, { recursive: true, force: true }); }

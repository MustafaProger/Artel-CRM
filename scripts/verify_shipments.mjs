import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import Decimal from 'decimal.js';
const ExactDecimal = Decimal.clone({ precision: 80 });

// This test always owns a new server and a fresh mutable store. It never writes
// through the normal application server or modifies the imported XLSX snapshot.
const root = resolve(import.meta.dirname, '..');
const port = Number(process.env.ARTEL_SHIPMENTS_QA_PORT || 5174);
assert(Number.isInteger(port) && port !== 5173 && port !== 4173, 'Use a dedicated QA port');
const base = `http://127.0.0.1:${port}`;
const output = resolve(root, 'qa/shipments');
const reportPath = resolve(root, 'qa/shipments-verification.json');
const storeDirectory = await mkdtemp(resolve(tmpdir(), 'artel-shipments-qa-'));
await mkdir(output, { recursive: true });
const digest = value => createHash('sha256').update(value).digest('hex');
const hashIfPresent = async path => existsSync(path) ? digest(await readFile(path)) : null;
const originalStore = resolve(root, 'data/local-operations/operations.json');
const originalStoreHash = await hashIfPresent(originalStore);
const sourceManifest = resolve(root, 'data/local-xlsx-final/manifest.json');
const sourceHash = await hashIfPresent(sourceManifest);
const report = {
  status: 'running', base, checkedAt: new Date().toISOString(), storeDirectory,
  checks: [], measurements: {}, screenshots: [], consoleErrors: [],
  expectedConsoleErrors: [], providerMode: 'Playwright mocks; no live Checko requests',
};
const check = (name, details = {}) => { report.checks.push({ name, ...details }); console.log(`PASS ${name}`); };
const sleep = ms => new Promise(resolveWait => setTimeout(resolveWait, ms));
let server;
let browser;
let page;
let expectedProviderFailure = false;
let serverLog = '';

// These are independently transcribed from the supplied template workbooks.
const expectedHeaders = {
  'Расширенный': ['УПД','Месяц','Дата','Контрагент','ИНН Контрагент','Менеджер','Форма оплаты','Товар','Кол-во, т','Кол-во, л','Цена продажи, т','цена продажи за л','Сумма покупателя','Поставщик','ИНН Поставщика','Цена закупа','Сумма закупки','Перевозчик','Сумма перевозки','адрес загрузки','адрес выгрузки','Доп Затраты','Прибыль','Оплата','Дата оплаты','Долг/Переплата','Срок'],
  'Стандарт': ['Дата','Контрагент','Менеджер','Форма оплаты','Товар','Кол-во, т','Кол-во, л','Цена продажи, т','цена продажи за л','Сумма покупателя','Поставщик','Цена закупа','Сумма закупки','Перевозчик','Сумма перевозки','Прибыль','Оплата','Долг/Переплата','Срок'],
  'Уменьшенный': ['Дата','Контрагент','Менеджер','Товар','Кол-во, л','Сумма покупателя','Поставщик','Сумма закупки','Перевозчик','Прибыль'],
};

try {
  try {
    await fetch(base, { signal: AbortSignal.timeout(500) });
    throw new Error(`QA port ${port} is already in use; refusing to use an existing server`);
  } catch (error) {
    if (String(error).includes('already in use')) throw error;
  }
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: root,
    env: { ...process.env, ARTEL_STORE_DIR: storeDirectory, CHECKO_API_KEY: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  server.stdout.on('data', value => { serverLog = (serverLog + value.toString()).slice(-6000); });
  server.stderr.on('data', value => { serverLog = (serverLog + value.toString()).slice(-6000); });
  let baseline;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error(`QA server exited ${server.exitCode}`);
    try {
      const response = await fetch(`${base}/api/snapshot`);
      if (response.ok) { baseline = await response.json(); break; }
    } catch { /* Vite is still starting. */ }
    await sleep(100);
  }
  assert(baseline, 'Dedicated QA server became ready');
  assert.equal(baseline.overview.shipmentCount, 2092, 'Fresh source contains all imported operations');
  const baselineIds = new Set(baseline.shipments.map(row => row.id));
  assert.equal(baselineIds.size, 2092);
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  browser = await chromium.launch({ headless: true, ...(existsSync(chrome) ? { executablePath: chrome } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  page = await context.newPage();
  page.on('pageerror', error => report.consoleErrors.push(error.message));
  page.on('console', message => {
    if (message.type() === 'error') (expectedProviderFailure ? report.expectedConsoleErrors : report.consoleErrors).push(message.text());
  });
  const go = async () => {
    await page.goto(`${base}/#shipments`);
    await expect(page.locator('h1')).toHaveText('Отгрузки.');
    await expect(page.getByTestId('shipments-scroll')).toBeVisible();
    await expect(page.getByTestId('shipment-row').first()).toBeVisible();
  };
  const screenshot = async name => {
    const path = resolve(output, `${name}.png`);
    await page.screenshot({ path, fullPage: true, animations: 'disabled' });
    report.screenshots.push(path);
  };
  const noOverflow = async name => {
    const measured = await page.evaluate(() => ({ viewport: innerWidth, document: document.documentElement.scrollWidth }));
    assert(measured.document <= measured.viewport + 1, `${name}: page overflow ${JSON.stringify(measured)}`);
  };
  const renderedIds = async () => page.getByTestId('shipment-row').evaluateAll(rows => rows.map(row => row.dataset.shipmentId));
  const search = () => page.getByLabel('Поиск отгрузок', { exact: true });
  const dialog = () => page.getByRole('dialog', { name: /Добавить отгрузку|Изменить отгрузку/ });
  const cancelEditor = async () => {
    await dialog().getByRole('button', { name: 'Закрыть редактор', exact: true }).click();
    const discard = page.getByRole('button', { name: 'Закрыть без сохранения', exact: true });
    if (await discard.isVisible()) await discard.click();
    await expect(dialog()).toHaveCount(0);
  };
  await go();
  await expect(page.locator('nav').getByRole('button', { name: 'Контрагенты', exact: true })).toHaveCount(0);
  await expect(page.locator('nav').getByRole('link', { name: 'Контрагенты', exact: true })).toHaveCount(0);
  check('Counterparty navigation page removed; companies retained', { companyCount: baseline.companies.length });

  for (const [name, titles] of Object.entries(expectedHeaders)) {
    await page.getByRole('button', { name, exact: true }).click();
    const actual = await page.getByTestId('shipments-scroll').locator('thead tr').last().locator('th').allTextContents();
    assert.deepEqual(actual.map(title => title.trim()).filter(title => title && title !== 'Действия'), titles, `${name}: exact workbook headers`);
    const firstRenderedId = (await renderedIds())[0];
    const firstSource = baseline.shipments.find(row => row.id === firstRenderedId);
    if (firstSource?.date) {
      const [year, month, day] = firstSource.date.split('-');
      await expect(page.getByTestId('shipment-row').first().locator('td').nth(titles.indexOf('Дата'))).toHaveText(`${day}.${month}.${year}`);
    }
    await screenshot(`template-${titles.length}-desktop`);
    await page.getByTestId('shipments-scroll').evaluate(element => { element.scrollLeft = element.scrollWidth; });
    await expect(page.getByTestId('shipments-scroll').locator('thead tr').last().locator('th').last()).toBeInViewport();
    await screenshot(`template-${titles.length}-last-columns`);
    await page.getByTestId('shipments-scroll').evaluate(element => { element.scrollLeft = 0; });
    check(`${name}: exact ${titles.length} workbook headers`);
  }
  const readability = await page.getByTestId('shipments-scroll').evaluate(element => {
    const cell = element.querySelector('[data-testid="shipment-row"] td');
    return {
      bodyFontSize: cell ? parseFloat(getComputedStyle(cell).fontSize) : null,
      headerFontSize: parseFloat(getComputedStyle(element.querySelector('thead tr:last-child th')).fontSize),
      groupColors: [...new Set([...element.querySelectorAll('.shipment-group-headings th')].map(header => getComputedStyle(header).backgroundColor))],
    };
  });
  assert(readability.bodyFontSize >= 14 && readability.headerFontSize >= 14, 'Table text is at least 14 pixels');
  assert(readability.groupColors.length >= 4, 'Different table groups have visibly distinct backgrounds');
  report.measurements.readability = readability;
  check('Larger readable table text and distinct group colors', readability);

  // Payment controls, loading counters and table selectors are stable test hooks.
  const segmentCounts = [['Бензовозы · безнал', 1337], ['Наличка', 317], ['Ф2', 358], ['Не указано', 80], ['Все', 2092]];
  const loadingCounts = async () => {
    const match = (await page.getByTestId('shipments-loaded-count').textContent()).replace(/\s/g, '').match(/Загружено(\d+)из(\d+)/);
    assert(match, 'Visible loaded counter has loaded and total numbers');
    return { loaded: Number(match[1]), total: Number(match[2]) };
  };
  for (const [name, count] of segmentCounts) {
    await page.getByRole('button', { name, exact: true }).click();
    await expect.poll(async () => (await loadingCounts()).total).toBe(count);
    check(`Payment group ${name}`, { count });
  }
  await expect.poll(async () => (await loadingCounts()).loaded).toBe(50);
  const scroll = page.getByTestId('shipments-scroll');
  await scroll.evaluate(element => { element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 100); });
  await expect.poll(async () => (await loadingCounts()).loaded).toBeGreaterThanOrEqual(100);
  check('Initial 50 operations and automatic next batch on scroll');
  await scroll.evaluate(element => { element.scrollTop = 0; });
  const reached = new Set();
  let maxRows = 0;
  let previousTop = -1;
  let stagnant = 0;
  for (let iteration = 0; iteration < 1200; iteration++) {
    await page.evaluate(() => new Promise(resolveFrame => requestAnimationFrame(() => requestAnimationFrame(resolveFrame))));
    const ids = await renderedIds();
    assert.equal(new Set(ids).size, ids.length, 'No duplicate operation is rendered');
    ids.forEach(id => reached.add(id));
    maxRows = Math.max(maxRows, ids.length);
    assert(ids.length <= 80, `Bounded DOM: ${ids.length} rendered operation rows`);
    if (reached.size === baselineIds.size) break;
    const state = await scroll.evaluate(element => ({ top: element.scrollTop, height: element.clientHeight, totalHeight: element.scrollHeight }));
    stagnant = state.top === previousTop ? stagnant + 1 : 0;
    previousTop = state.top;
    if (stagnant > 12) throw new Error(`Scroll stalled at ${reached.size} of ${baselineIds.size} operations`);
    await scroll.evaluate(element => { element.scrollTop += Math.max(180, Math.floor(element.clientHeight * 0.55)); });
    if (state.top + state.height >= state.totalHeight - 600) await sleep(50);
  }
  assert.deepEqual([...reached].sort(), [...baselineIds].sort(), 'Every imported operation is reachable by continuous scrolling');
  report.measurements.virtualization = { sourceRows: baselineIds.size, reachedRows: reached.size, maxRenderedRows: maxRows };
  check('All 2092 operations reachable without duplicates; DOM stays bounded', report.measurements.virtualization);

  await scroll.evaluate(element => { element.scrollTop = 0; element.scrollLeft = 0; });
  await page.getByRole('button', { name: 'Расширенный', exact: true }).click();
  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    await noOverflow(`Shipments at ${width}px`);
    await screenshot(`shipments-${width}`);
    await scroll.scrollIntoViewIfNeeded();
    await scroll.evaluate(element => { element.scrollLeft = element.scrollWidth; });
    const lastHeader = scroll.locator('thead tr').last().locator('th').last();
    await expect.poll(() => lastHeader.evaluate(header => {
      const bounds = header.getBoundingClientRect();
      const container = header.closest('.shipment-grid-scroll').getBoundingClientRect();
      const left = Math.max(bounds.left, container.left);
      const right = Math.min(bounds.right, container.right);
      const target = document.elementFromPoint((left + right) / 2, bounds.top + bounds.height / 2);
      return right > left && target?.closest('th') === header;
    }), { message: `The final column is readable, without frozen columns covering it at ${width}px` }).toBe(true);
    await screenshot(`last-columns-${width}`);
    await scroll.evaluate(element => { element.scrollLeft = 0; });
    await page.getByRole('button', { name: 'Добавить отгрузку', exact: true }).click();
    await expect(dialog()).toBeVisible();
    await noOverflow(`Shipment editor at ${width}px`);
    await screenshot(`editor-${width}`);
    await cancelEditor();
  }
  check('Responsive shipment table and editor at 1440, 768, 390 and 320 pixels');
  await page.setViewportSize({ width: 1440, height: 1000 });
  const sourceId = (await renderedIds())[0];
  const sourceShipment = baseline.shipments.find(row => row.id === sourceId);
  assert(sourceShipment?.date);
  await page.getByRole('button', { name: `Редактировать отгрузку ${sourceId}`, exact: true }).click();
  await expect(dialog().getByLabel('Дата', { exact: true })).toHaveValue(sourceShipment.date);
  await expect(dialog().getByRole('button', { name: 'Сохранить отгрузку', exact: true })).toBeDisabled();
  await cancelEditor();
  check('Original shipment date appears correctly in editor; unchanged record cannot be resaved');

  // Company success and failure are simulated at the browser boundary. Only the
  // newly created shipment below is ever persisted to the isolated local store.
  const mockCompany = { id: 'qa-checko-company', name: 'ООО «QA ЧЕККО»', inn: '7707083893', fullName: 'ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ «QA ЧЕККО»', roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [], address: 'Тестовый адрес', registrySource: 'checko', registryCheckedAt: new Date().toISOString() };
  let companyAttempts = 0;
  let releaseLookup;
  const lookupGate = new Promise(resolveLookup => { releaseLookup = resolveLookup; });
  await page.route('**/api/companies/from-inn', async route => {
    companyAttempts++;
    assert.equal(route.request().method(), 'POST');
    assert.equal(route.request().postDataJSON().inn, '7707083893');
    if (companyAttempts === 1) {
      await lookupGate;
      await route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ company: mockCompany, created: true }) });
    }
    else await route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ error: 'Чекко временно недоступен. Повторите позже.' }) });
  });
  await page.getByRole('button', { name: 'Добавить отгрузку', exact: true }).click();
  const buyer = dialog().locator('.company-picker').filter({ has: page.getByRole('combobox', { name: 'Контрагент', exact: true }) });
  await buyer.getByLabel('ИНН: Контрагент', { exact: true }).fill('7707083893');
  await buyer.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(dialog().getByRole('button', { name: 'Сохранить отгрузку', exact: true })).toBeDisabled();
  await expect(dialog().getByRole('button', { name: 'Закрыть редактор', exact: true })).toBeDisabled();
  releaseLookup();
  check('Shipment save and close remain disabled while Checko lookup is pending');
  await expect(dialog().getByRole('combobox', { name: 'Контрагент', exact: true })).toHaveValue(mockCompany.name);
  await expect(dialog().getByLabel('ИНН Контрагент', { exact: true })).toHaveValue(mockCompany.inn);
  await expect(buyer.getByRole('status')).toContainText('Компания добавлена и выбрана');
  await dialog().getByRole('combobox', { name: 'Контрагент', exact: true }).fill('QA ЧЕККО');
  await expect(buyer.getByRole('option')).toHaveCount(1);
  await buyer.getByRole('option').click();
  expectedProviderFailure = true;
  await buyer.getByLabel('ИНН: Контрагент', { exact: true }).fill('7707083893');
  await buyer.getByRole('button', { name: 'Добавить', exact: true }).click();
  await expect(buyer.getByRole('alert')).toHaveText('Чекко временно недоступен. Повторите позже.');
  await sleep(100);
  expectedProviderFailure = false;
  await expect(dialog().getByRole('combobox', { name: 'Контрагент', exact: true })).toHaveValue(mockCompany.name);
  await screenshot('company-inn-error');
  await cancelEditor();
  assert.equal(companyAttempts, 2);
  await page.unroute('**/api/companies/from-inn');
  check('Company by INN: mocked Checko success, selected company, search and recoverable failure', { attempts: companyAttempts });

  const marker = `QA-ОТГРУЗКА-${Date.now()}`;
  await page.getByRole('button', { name: 'Добавить отгрузку', exact: true }).click();
  await dialog().getByLabel('УПД', { exact: true }).fill(marker);
  await dialog().getByLabel('Дата', { exact: true }).fill('2026-09-09');
  await dialog().getByLabel('Товар', { exact: true }).fill('QA ДТ');
  await dialog().getByLabel('Кол-во, л', { exact: true }).fill('123,45');
  await dialog().getByLabel('Сумма покупателя', { exact: true }).fill('9999,99');
  const customer = baseline.companies.find(company => company.roles.includes('customer'));
  assert(customer, 'Source buyer exists');
  await dialog().getByRole('combobox', { name: 'Контрагент', exact: true }).fill(customer.name);
  await dialog().getByRole('option', { name: customer.name, exact: true }).click();
  const createResponse = page.waitForResponse(response => response.url() === `${base}/api/shipments` && response.request().method() === 'POST');
  await dialog().getByRole('button', { name: 'Сохранить отгрузку', exact: true }).click();
  const createdResponse = await createResponse;
  assert.equal(createdResponse.status(), 201, await createdResponse.text());
  const created = (await createdResponse.json()).shipment;
  assert(created?.id);
  await expect(dialog()).toHaveCount(0);
  assert(existsSync(resolve(storeDirectory, 'operations.json')), 'CRUD persisted only in the temporary store');
  assert.equal(await hashIfPresent(originalStore), originalStoreHash, 'Real mutable store remains untouched');
  await search().fill(marker);
  await expect(page.getByTestId('shipment-row')).toHaveCount(1);
  await page.reload();
  await search().fill(marker);
  await expect(page.getByTestId('shipment-row')).toHaveCount(1);
  const afterCreate = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(afterCreate.shipments.find(row => row.id === created.id)?.liters, '123.45');
  assert.equal(afterCreate.overview.shipmentCount, baseline.overview.shipmentCount + 1);
  assert(new ExactDecimal(afterCreate.overview.liters.total).equals(new ExactDecimal(baseline.overview.liters.total).plus('123.45')), 'Created quantity is included in overall totals');
  assert(new ExactDecimal(afterCreate.overview.revenue.total).equals(new ExactDecimal(baseline.overview.revenue.total).plus('9999.99')), 'Created revenue is included in overall totals');
  check('Create shipment, decimal input and persistence after reload', { id: created.id });

  await page.getByRole('button', { name: `Редактировать отгрузку ${created.id}`, exact: true }).click();
  await dialog().getByLabel('Кол-во, л', { exact: true }).fill('234,56');
  const editResponse = page.waitForResponse(response => response.url().endsWith(`/api/shipments/${created.id}`) && response.request().method() === 'PATCH');
  await dialog().getByRole('button', { name: 'Сохранить отгрузку', exact: true }).click();
  assert.equal((await editResponse).status(), 200);
  await expect(dialog()).toHaveCount(0);
  await page.reload();
  await search().fill(marker);
  await expect(page.getByTestId('shipment-row')).toHaveCount(1);
  const afterEdit = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(afterEdit.shipments.find(row => row.id === created.id)?.liters, '234.56');
  assert(new ExactDecimal(afterEdit.overview.liters.total).equals(new ExactDecimal(baseline.overview.liters.total).plus('234.56')), 'Edited quantity replaces the previous value in totals');
  check('Edit shipment and persistence after reload');

  await page.getByRole('button', { name: `Удалить отгрузку ${created.id}`, exact: true }).click();
  const deleteResponse = page.waitForResponse(response => response.url().endsWith(`/api/shipments/${created.id}`) && response.request().method() === 'DELETE');
  await page.getByRole('button', { name: 'Удалить операцию', exact: true }).click();
  assert((await deleteResponse).ok());
  await page.reload();
  await search().fill(marker);
  await expect(page.getByTestId('shipment-row')).toHaveCount(0);
  const finalSnapshot = await (await fetch(`${base}/api/snapshot`)).json();
  assert.equal(finalSnapshot.overview.shipmentCount, 2092);
  assert.deepEqual(finalSnapshot.overview, baseline.overview, 'Delete restores every original aggregate');
  assert.deepEqual(finalSnapshot.shipments, baseline.shipments, 'Original shipment records are unchanged after test CRUD');
  check('Delete shipment persists; all original operations remain unchanged');

  assert.equal(await hashIfPresent(originalStore), originalStoreHash, 'Real application store was never changed');
  assert.equal(await hashIfPresent(sourceManifest), sourceHash, 'Source snapshot was never changed');
  assert.equal(report.consoleErrors.length, 0, report.consoleErrors.join('\n'));
  report.status = 'passed';
  check('No unexpected browser errors; source snapshot and real mutable store preserved');
} catch (error) {
  report.status = 'failed';
  report.error = String(error);
  if (page) await page.screenshot({ path: resolve(output, 'failure.png'), fullPage: true, animations: 'disabled' }).catch(() => {});
  process.exitCode = 1;
  console.error(String(error));
} finally {
  if (browser) await browser.close();
  if (server && server.exitCode === null) server.kill('SIGTERM');
  report.completedAt = new Date().toISOString();
  report.originalStorePreserved = await hashIfPresent(originalStore) === originalStoreHash;
  report.sourceManifestPreserved = await hashIfPresent(sourceManifest) === sourceHash;
  await writeFile(reportPath, JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify({ status: report.status, checks: report.checks.length, reportPath, storeDirectory }));
}

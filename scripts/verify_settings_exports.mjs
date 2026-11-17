import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect, webkit } from '@playwright/test';
import ExcelJS from 'exceljs';
import { shipmentTemplates, azsShipmentTemplates } from '../web/src/shipment-templates.ts';
import { emptyDirectories } from '../server/directory-operations.ts';
import { OperationsStore } from '../server/operations-store.ts';
import { authenticateContext } from './qa-auth.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const temp = await mkdtemp(resolve(tmpdir(), 'artel-export-'));
const snapshotDirectory = resolve(temp, 'snapshot');
const operationsDirectory = resolve(temp, 'store');
const evidence = process.env.ARTEL_EXPORT_QA_OUTPUT;
const own = 'Клиент QA', other = 'Чужой клиент QA', supplier = 'Скрытый поставщик QA', depot = 'Нефтебаза QA';
const dates = 'from=2026-11-10&to=2026-11-12';
const rangePath = '/api/shipments/export.xlsx';
const catalogPath = '/api/directories/export.xlsx';
const views = [
  ['Бензовозы — Расширенный', shipmentTemplates.expanded, 'start'],
  ['Бензовозы — Стандарт', shipmentTemplates.standard, 'start'],
  ['Бензовозы — Уменьшенный', shipmentTemplates.reduced, 'start'],
  ['АЗС — Средний', azsShipmentTemplates.medium, 'end'],
  ['АЗС — Малый', azsShipmentTemplates.small, 'end'],
];
let runtime;

async function workbook(bytes) {
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(bytes);
  return book;
}

function rows(sheet) {
  return sheet.getSheetValues().slice(2).map(row => row.slice(1));
}

try {
  const source = await writeTripsQaSnapshot(snapshotDirectory);
  runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
  const { base } = runtime;
  const director = await runtime.bootstrap();
  const request = (path, cookie, body) => fetch(base + path, {
    headers: { ...(cookie ? { Cookie: cookie } : {}), ...(body ? { Origin: base, 'Content-Type': 'application/json' } : {}) },
    ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
  });
  const store = new OperationsStore(operationsDirectory);
  await store.mutate(source, data => {
    const company = (id, name, role, extra = {}) => ({ id, name, roles: [role], shipmentIds: [], paymentIds: [], managerLabels: [], flags: [], ...extra });
    data.companies = [
      company('own', own, 'customer', { inn: '0012345678', fullName: '=1+1' }),
      company('other', other, 'customer'),
      company('supplier', supplier, 'supplier'),
      company('archived', 'Архивный клиент QA', 'customer', { directoryArchived: true }),
    ];
    data.directories = {
      ...emptyDirectories(), fleetSeedApplied: true,
      managers: [{ id: 'employee', name: 'Менеджер QA' }, { id: 'other-manager', name: 'Другой менеджер QA' }],
      products: [{ id: 'fuel', name: 'ДТ QA' }],
      oilDepots: [{ id: 'depot', name: depot, address: 'Адрес нефтебазы QA' }],
      addresses: [
        { id: 'own-address', name: 'Своя точка QA', kind: 'delivery', companyId: 'own' },
        { id: 'other-address', name: 'Чужая точка QA', kind: 'delivery', companyId: 'other' },
      ],
      customerManagers: [{ companyId: 'own', managerId: 'employee' }, { companyId: 'other', managerId: 'other-manager' }],
    };
    for (const [key, date, type, manager, customer] of [
      ['before', '2026-11-09', 'tanker', 'employee', 'own'],
      ['start', '2026-11-10', 'tanker', 'employee', 'own'],
      ['end', '2026-11-12', 'azs', 'employee', 'own'],
      ['after', '2026-11-13', 'azs', 'employee', 'own'],
      ['other', '2026-11-11', 'tanker', 'other-manager', 'other'],
    ]) {
      const now = date + 'T12:00:00Z';
      data.shipments['shipment-local-' + key] = {
        fields: {
          shipment_type: type, date, customer_id: customer, customer_name: customer === 'own' ? own : other,
          manager_id: manager, supplier_id: 'supplier', supplier_name: supplier, carrier_name: null,
          quantity_litres: '1234.5', document_number: key,
        },
        version: 1, createdAt: now, updatedAt: now,
      };
    }
    return { result: null, changed: true };
  });

  async function createEmployee(login, managerId, sections, directoryGrants) {
    const password = randomUUID();
    const added = await request('/api/auth/users', director.cookie, { role: 'manager', name: login, login, password, managerId, sections, directoryGrants });
    assert.equal(added.status, 201, await added.text());
    const session = await request('/api/auth/login', null, { login, password });
    assert.equal(session.status, 200, await session.text());
    return session.headers.get('set-cookie').split(';')[0];
  }

  const employee = await createEmployee('export-employee', 'employee', ['shipments', 'directories'], ['oilDepots']);
  const restricted = await createEmployee('export-restricted', 'other-manager', ['work'], []);
  for (const path of [catalogPath, rangePath + '?' + dates]) {
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, restricted)).status, 403);
  }
  for (const invalid of ['', '?from=2026-11-10', '?from=2026-11-31&to=2026-12-01', '?from=2026-11-12&to=2026-11-10', '?from=2026-11-10&from=2026-11-09&to=2026-11-12']) {
    assert.equal((await request(rangePath + invalid, employee)).status, 400, invalid);
  }
  assert.equal((await request(rangePath + '?from=2025-11-10&to=2025-11-12', employee)).status, 404);
  const full = await request(catalogPath, director.cookie);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('cache-control'), 'private, no-store');
  const fullBook = await workbook(await full.arrayBuffer());
  assert.ok(fullBook.getWorksheet('Поставщики'));
  assert.ok(rows(fullBook.getWorksheet('Клиенты')).some(row => row.includes(other)));
  assert.ok(!rows(fullBook.getWorksheet('Клиенты')).some(row => row.includes('Архивный клиент QA')));
  const allShipments = await request(rangePath + '?' + dates, director.cookie);
  assert.equal(allShipments.status, 200);
  assert.equal(rows((await workbook(await allShipments.arrayBuffer())).getWorksheet('Бензовозы — Расширенный')).length, 2);
  const tankerOnly = await request(rangePath + '?from=2026-11-10&to=2026-11-10', employee);
  assert.equal(tankerOnly.status, 200);
  const tankerOnlyBook = await workbook(await tankerOnly.arrayBuffer());
  assert.deepEqual(tankerOnlyBook.worksheets.map(sheet => sheet.name), views.map(([name]) => name));
  assert.equal(rows(tankerOnlyBook.getWorksheet('АЗС — Средний')).length, 0);
  assert.equal(rows(tankerOnlyBook.getWorksheet('АЗС — Малый')).length, 0);

  async function download(page, button) {
    const pending = page.waitForEvent('download');
    await button.click();
    const file = await pending;
    assert.match(file.suggestedFilename(), /\.xlsx$/);
    return workbook(await readFile(await file.path()));
  }

  for (const [name, engine] of [['chromium', chromium], ['webkit', webkit]]) {
    const browser = await engine.launch();
    try {
      const context = await browser.newContext({ serviceWorkers: 'block', reducedMotion: 'reduce', viewport: { width: 1440, height: 1100 } });
      await context.route('**/*', route => route.request().url().startsWith(base + '/') ? route.continue() : route.abort());
      await authenticateContext(context, base, employee);
      const page = await context.newPage();
      const pageErrors = [];
      page.on('pageerror', error => pageErrors.push(error.message));
      await page.goto(base + '/#settings');
      const exports = page.getByRole('region', { name: 'Выгрузка данных' });
      const directoryForm = exports.getByRole('form', { name: 'Справочники' });
      const shipmentForm = exports.getByRole('form', { name: 'Отгрузки за период' });
      await expect(directoryForm).toBeVisible();
      await expect(shipmentForm).toBeVisible();
      const notifications = await page.getByRole('region', { name: 'Уведомления' }).boundingBox();
      const exportBox = await exports.boundingBox();
      assert.equal(Math.round(exportBox.x), Math.round(notifications.x));
      assert.ok(exportBox.y >= notifications.y + notifications.height);
      const directoryBook = await download(page, directoryForm.getByRole('button', { name: 'Скачать Excel со справочниками' }));
      assert.deepEqual(directoryBook.worksheets.map(sheet => sheet.name), ['Клиенты', 'Нефтебазы', 'Места погрузки и доставки']);
      const clients = rows(directoryBook.getWorksheet('Клиенты'));
      assert.equal(clients.length, 1);
      assert.deepEqual(clients[0].slice(0, 3), [own, '0012345678', '=1+1']);
      assert.equal(directoryBook.getWorksheet('Клиенты').getCell('C2').type, ExcelJS.ValueType.String);
      assert.equal(rows(directoryBook.getWorksheet('Нефтебазы'))[0][0], depot);
      assert.deepEqual(rows(directoryBook.getWorksheet('Места погрузки и доставки')).map(row => row[0]), ['Своя точка QA']);

      const from = shipmentForm.getByLabel('Дата с', { exact: true });
      const to = shipmentForm.getByLabel('Дата по', { exact: true });
      const shipmentButton = shipmentForm.getByRole('button', { name: 'Скачать Excel с отгрузками' });
      await shipmentButton.click();
      assert.equal(await from.evaluate(input => input.validity.valueMissing), true);
      await from.fill('2025-11-10');
      await to.fill('2025-11-12');
      await shipmentButton.click();
      await expect(shipmentForm.getByRole('alert')).toContainText('нет доступных отгрузок');

      await from.fill('2026-11-10');
      await to.fill('2026-11-12');
      for (const width of [1440, 375, 320, 127]) {
        await page.setViewportSize({ width, height: 1050 });
        const layout = await page.evaluate(() => ({
          root: document.querySelector('#root').getBoundingClientRect().width,
          scroll: document.documentElement.scrollWidth,
          heading: document.querySelector('h1').getBoundingClientRect().height,
          datesFit: [...document.querySelectorAll('.settings-export-dates input')].every(input =>
            input.getBoundingClientRect().right <= input.closest('section').getBoundingClientRect().right),
        }));
        assert.equal(layout.root, Math.max(width, 375));
        assert.equal(layout.scroll, Math.max(width, 375));
        assert.ok(layout.heading < 65, JSON.stringify(layout));
        assert.ok(layout.datesFit);
        if (evidence && name === 'chromium' && [1440, 375].includes(width)) {
          await mkdir(evidence, { recursive: true });
          await page.evaluate(() => window.scrollTo(0, 0));
          await page.screenshot({ path: resolve(evidence, `settings-${width}.png`), fullPage: true });
        }
      }
      await page.setViewportSize({ width: 375, height: 900 });
      const shipmentBook = await download(page, shipmentButton);
      assert.deepEqual(shipmentBook.worksheets.map(sheet => sheet.name), views.map(([name]) => name));
      for (const [name, template, id] of views) {
        const sheet = shipmentBook.getWorksheet(name);
        assert.deepEqual(sheet.getRow(1).values.slice(1), template.columns.map(column => column.title));
        assert.equal(rows(sheet).length, 1);
        assert.equal(rows(sheet)[0][template.columns.findIndex(column => column.key === 'customer_name')], own);
        assert.equal(rows(sheet)[0][template.columns.findIndex(column => column.key === 'quantity_litres')], 1234.5);
        const documentIndex = template.columns.findIndex(column => column.key === 'document_number');
        if (documentIndex >= 0) assert.equal(rows(sheet)[0][documentIndex], id);
      }

      await page.goto(base + '/#shipments');
      const csv = page.getByRole('button', { name: 'CSV', exact: true });
      await expect(csv).toBeDisabled();
      await page.getByLabel('Период отгрузок').selectOption('2026-11');
      await expect(csv).toBeEnabled();
      const csvFile = page.waitForEvent('download');
      await csv.click();
      assert.match((await csvFile).suggestedFilename(), /\.csv$/);

      const restrictedContext = await browser.newContext({ serviceWorkers: 'block' });
      await authenticateContext(restrictedContext, base, restricted);
      const restrictedPage = await restrictedContext.newPage();
      await restrictedPage.goto(base + '/#settings');
      await expect(restrictedPage.getByRole('heading', { name: 'Настройки', exact: true })).toBeVisible();
      await expect(restrictedPage.getByRole('heading', { name: /Выгрузка/ })).toHaveCount(0);
      assert.deepEqual(pageErrors, []);
      console.log(`${runtime.mode} ${name}: scope, real downloads, dates, CSV and 375 px layout passed`);
    } finally {
      await browser.close();
    }
  }
} finally {
  await runtime?.server.close();
  await rm(temp, { recursive: true, force: true });
}

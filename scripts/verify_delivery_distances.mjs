// Isolated synthetic server only. No production records or provider requests.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(resolve(tmpdir(), 'artel-distances-ui-runtime-'));
const output = process.env.ARTEL_QA_OUTPUT || resolve(tmpdir(), 'artel-delivery-distances-ui-proof');
await mkdir(output, { recursive: true });
const snapshotDirectory = resolve(directory, 'snapshot'), operationsDirectory = resolve(directory, 'operations');
await writeTripsQaSnapshot(snapshotDirectory);
let runtime, browser;
const report = { checks: [], screenshots: [] };
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory });
  const auth = await bootstrapQaAuth(runtime.base);
  const request = async (path, method = 'GET', body) => {
    const response = await fetch(runtime.base + path, { method, headers: { cookie: auth.cookie, origin: runtime.base, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json() };
  };
  for (const [browserName, launcher, options] of [['chromium', chromium, { executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' }], ['webkit', webkit, {}]]) {
    browser = await launcher.launch({ headless: true, ...options });
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errors = []; page.on('pageerror', error => errors.push(error.message));
    await authenticateContext(page.context(), runtime.base, auth.cookie);
    const depotNames = [`QA Нефтебаза Северная с длинным названием ${browserName}`, `QA Нефтебаза Южная ${browserName}`];
    const depots = [];
    for (const name of depotNames) {
      const response = await request('/api/directories', 'POST', { kind: 'oilDepots', name });
      assert.equal(response.status, 201); depots.push(response.body.entry.id);
    }
    const companyName = `QA Расстояния ${browserName}`;
    const created = await request('/api/directories', 'POST', { kind: 'companies', name: companyName, roles: ['customer'], addresses: [{ name: 'QA Улица Первая, 1', kind: 'delivery' }, { name: 'QA Улица Вторая, 2', kind: 'delivery' }] });
    assert.equal(created.status, 201); const companyId = created.body.entry.id;
    const current = async () => {
      const response = await request('/api/directories');
      return { company: response.body.companies.find(row => row.id === companyId), addresses: response.body.directories.addresses.filter(row => row.companyId === companyId) };
    };
    const remoteDistance = async value => {
      const state = await current(), address = state.addresses[0];
      const result = await request(`/api/directories/addresses/${address.id}`, 'PATCH', { version: address.version ?? 0, name: address.name, companyId, addressKind: address.kind, oilDepotDistancesKm: { ...address.oilDepotDistancesKm, [depots[0]]: value } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
    };
    await page.goto(runtime.base + '/#directories');
    const open = async () => { await page.getByLabel('Поиск в справочнике', { exact: true }).fill(companyName); await page.getByRole('button', { name: `Редактировать: ${companyName}`, exact: true }).click(); return page.getByRole('dialog', { name: 'Карточка клиента', exact: true }); };
    const distance = (dialog, depot = 0, address = 1) => dialog.getByLabel(`${depotNames[depot]}: расстояние, км (адрес ${address})`, { exact: true });
    const save = async dialog => { await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog).toHaveCount(0); };
    let dialog = await open();
    await distance(dialog).fill('12,75'); await distance(dialog, 1).fill('0'); await distance(dialog, 0, 2).fill('89');
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1000 });
      await distance(dialog).scrollIntoViewIfNeeded();
      assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${browserName} dialog overflows at ${width}`);
      for (const input of await dialog.locator('.directory-depot-distance').all()) {
        assert.ok(await input.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${browserName} distance row overflows at ${width}`);
      }
      const path = resolve(output, `distances-${browserName}-${width}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
    }
    // Hold the post-save refresh to make an immediate reopen race deterministic.
    // The preflight snapshot remains available; only the read after PATCH waits.
    let patchStarted = false, refreshBlocked = false, releaseRefresh = () => {}, finishRefresh = () => {};
    const refreshGate = new Promise(done => { releaseRefresh = done; });
    const refreshHandled = new Promise(done => { finishRefresh = done; });
    const patchListener = request => { if (request.method() === 'PATCH' && new URL(request.url()).pathname === `/api/directories/companies/${companyId}`) patchStarted = true; };
    page.on('request', patchListener);
    const holdSnapshot = async route => {
      if (patchStarted) {
        refreshBlocked = true; await refreshGate;
        try { await route.continue(); } finally { finishRefresh(); }
        return;
      }
      await route.continue();
    };
    await page.route('**/api/snapshot?shipments=omit', holdSnapshot);
    try {
      await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
      await expect.poll(() => refreshBlocked).toBe(true);
      // Exceed the complete close-animation fallback while the network is held.
      // The dialog must still be open and prevent reopening from stale props.
      await page.waitForTimeout(500);
      await expect(dialog).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Сохранить', exact: true })).toBeDisabled();
    } finally {
      releaseRefresh();
      if (refreshBlocked) await refreshHandled;
      page.off('request', patchListener);
      await page.unroute('**/api/snapshot?shipments=omit', holdSnapshot);
    }
    await expect(dialog).toHaveCount(0); dialog = await open();
    await expect(distance(dialog)).toHaveValue('12.75'); await expect(distance(dialog, 1)).toHaveValue('0'); await expect(distance(dialog, 0, 2)).toHaveValue('89');
    assert.deepEqual((await current()).addresses.map(address => address.oilDepotDistancesKm), [{ [depots[0]]: '12.75', [depots[1]]: '0' }, { [depots[0]]: '89' }]);
    report.checks.push(`${browserName}: held post-save snapshot cannot close or reopen stale editor; per-address and per-depot save/reopen, comma normalization, zero, four viewport widths`);
    await distance(dialog).fill('-1'); await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    await expect(dialog.locator('.shipment-error')).toContainText('Расстояние должно быть числом');
    assert.equal((await current()).addresses[0].oilDepotDistancesKm[depots[0]], '12.75');
    await distance(dialog).fill('12.75'); await dialog.getByText('Контакты и банковские реквизиты', { exact: true }).click(); await dialog.getByLabel('Телефон компании', { exact: true }).fill('+7 900 000-00-00');
    await remoteDistance('45'); await save(dialog); dialog = await open();
    await expect(distance(dialog)).toHaveValue('45'); await expect(dialog.getByLabel('Телефон компании', { exact: true })).toHaveValue('+7 900 000-00-00');
    report.checks.push(`${browserName}: invalid value leaves saved data unchanged; unrelated local edit preserves concurrent distance`);
    await distance(dialog).fill('72'); await remoteDistance('63');
    await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
    const conflict = dialog.getByRole('region', { name: 'Сверка изменений' }); await expect(conflict).toBeVisible(); await expect(conflict).toContainText('Адреса компании');
    assert.equal((await current()).addresses[0].oilDepotDistancesKm[depots[0]], '63');
    await conflict.getByRole('radio', { name: /^Моё значение:/ }).check();
    await conflict.getByRole('button', { name: 'Применить выбор', exact: true }).click();
    await save(dialog); dialog = await open(); await expect(distance(dialog)).toHaveValue('72');
    await distance(dialog, 1).fill(''); await save(dialog);
    assert.equal((await current()).addresses[0].oilDepotDistancesKm[depots[1]], undefined);
    report.checks.push(`${browserName}: overlapping edit requires explicit choice; clearing only chosen distance preserves other address values`);
    assert.deepEqual(errors, []); await browser.close(); browser = undefined;
  }
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ passed: report.checks.length, screenshots: report.screenshots.length, output }, null, 2));
} finally { if (browser) await browser.close(); if (runtime) await runtime.server.close(); await rm(directory, { recursive: true, force: true }); }

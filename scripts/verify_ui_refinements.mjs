import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';

// A full legacy snapshot can take several seconds in WebKit on a busy QA host.
const expect = baseExpect.configure({ timeout: 15000 });

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'qa/ui-refinements-2026-09-11');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-ui-refinements-'));
const base = 'http://127.0.0.1:5199';
const live = resolve(root, 'data/local-operations/operations.json');
const checksum = async () => {
  if (!existsSync(live)) return { full: null, records: null };
  const bytes = await readFile(live), { data } = JSON.parse(bytes);
  // An independently running dev server updates its push heartbeat every 30s.
  // Retain all business records, accounts, devices and deliveries in the comparison.
  delete data.revision;
  if (data.push) delete data.push.lastRunAt;
  return { full: createHash('sha256').update(bytes).digest('hex'), records: createHash('sha256').update(JSON.stringify(data)).digest('hex') };
};
const before = await checksum();
const report = { checks: [], errors: [], measurements: [], status: 'running' };
const check = name => { report.checks.push(name); console.log('PASS', name); };
await mkdir(output, { recursive: true });
let server, browser, safari, page;
try {
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(500) }));
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '5199', '--strictPort'], { cwd: root, env: { ...process.env, ARTEL_STORE_DIR: temporary, CHECKO_API_KEY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/auth/session')).ok) break; } catch {} await new Promise(done => setTimeout(done, 100)); }
  const { cookie } = await bootstrapQaAuth(base);
  const api = async (path, body) => { const response = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify(result)); return result; };
  const snapshot = await api('/api/snapshot');
  const supplier = snapshot.companies.find(company => company.roles.includes('supplier'));
  await api('/api/china/days', { date: '2026-09-10', fuels: [{ supplierId: supplier.id, litres: '12000', amount: '1320000' }] });
  await api('/api/china/payments', { date: '2026-09-10', amount: '500000' });
  await api('/api/work/tasks', { title: 'Согласовать отгрузку', description: 'Проверить договор и передать документы', companyId: supplier.id });
  await api('/api/work/notes', { title: 'Документы', content: 'Проверить реквизиты перед отправкой.' });
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', timezoneId: 'Europe/Moscow' });
  await authenticateContext(context, base, cookie);
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  const visit = async (target, route) => {
    await target.goto(`${base}/#${route}`);
    await expect(target.locator('.loading-state')).toHaveCount(0);
    if (route === 'work') await expect(target.getByRole('button', { name: 'Новая задача', exact: true })).toBeEnabled();
    if (route === 'china') await expect(target.getByRole('button', { name: 'Добавить день', exact: true })).toBeEnabled();
    if (route === 'directories') await expect(target.getByLabel('Поиск в справочнике', { exact: true })).toBeVisible();
    if (route === 'shipments') await expect(target.getByTestId('shipment-row').first()).toBeVisible();
  };
  for (const width of [1920, 1440, 1280, 1100, 1024, 834, 768, 650, 425, 390, 375, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const route of ['work', 'china', 'directories', 'shipments']) {
      await visit(page, route);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route}: page overflow at ${width}`);
      if (route === 'work') {
        const inset = await page.locator('.work-toolbar').evaluate(toolbar => {
          const box = toolbar.getBoundingClientRect();
          const children = [...toolbar.children].flatMap(child => child.classList.contains('work-views') ? [...child.children] : [child]);
          return Math.min(...children.flatMap(child => { const rect = child.getBoundingClientRect(); return [rect.left - box.left, rect.top - box.top, box.right - rect.right, box.bottom - rect.bottom]; }));
        });
        assert.ok(inset >= 11, `Toolbar inset ${inset} at ${width}`);
      }
      if (route === 'china') {
        const measurement = await page.locator('.china-table').evaluate(table => ({ widths: [...table.querySelectorAll('th')].map(node => node.getBoundingClientRect().width), fonts: [...table.querySelectorAll('tbody tr:first-child td')].map(node => getComputedStyle(node).fontSize), tableWidth: table.getBoundingClientRect().width, scrollerWidth: table.parentElement.clientWidth }));
        assert.ok(Math.max(...measurement.widths) - Math.min(...measurement.widths) < 1, JSON.stringify(measurement));
        assert.equal(new Set(measurement.fonts).size, 1);
        assert.ok(width < 425 ? measurement.tableWidth > measurement.scrollerWidth : measurement.tableWidth <= measurement.scrollerWidth + 1, `China scroll ${width}: ${JSON.stringify(measurement)}`);
        report.measurements.push({ width, route, ...measurement });
      }
      if (route === 'directories') {
        const measurements = await page.locator('.directory-toolbar').evaluate(toolbar => {
          const card = toolbar.parentElement.getBoundingClientRect(), search = toolbar.querySelector('.shipment-search').getBoundingClientRect(), button = toolbar.querySelector(':scope > button').getBoundingClientRect();
          return { top: search.top - card.top, left: search.left - card.left, right: card.right - button.right, gap: button.top >= search.bottom ? button.top - search.bottom : button.left - search.right };
        });
        assert.ok(Object.values(measurements).every(value => value >= 11), JSON.stringify(measurements));
      }
      if (route === 'shipments') await expect(page.getByRole('separator')).toHaveCount(width >= 1100 ? await page.locator('.shipment-column-headings th').count() : 0);
      if ([1440, 425, 390, 320].includes(width)) await page.screenshot({ path: resolve(output, `${route}-${width}.png`), fullPage: true });
    }
    check(`Four changed pages fit ${width}px; Work/Directories spacing, China equal type and 425px scroll threshold`);
  }

  await page.setViewportSize({ width: 1440, height: 1000 }); await visit(page, 'shipments');
  await page.getByLabel('Вид таблицы', { exact: true }).selectOption('reduced');
  const date = page.locator('th[data-field="date"]'), customer = page.locator('th[data-field="customer_name"]');
  const widthOf = locator => locator.evaluate(el => el.getBoundingClientRect().width);
  const original = await widthOf(date), customerWidth = await widthOf(customer), totalWidth = await widthOf(page.locator('.shipment-grid'));
  const sort = await date.getAttribute('aria-sort');
  const handle = date.getByRole('separator'), box = await handle.boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 12 });
  await expect.poll(() => widthOf(date)).toBe(original + 100);
  await page.mouse.up();
  assert.equal(await widthOf(customer), customerWidth); assert.equal(await widthOf(page.locator('.shipment-grid')), totalWidth + 100);
  assert.equal(await date.getAttribute('aria-sort'), sort); await expect(page.getByRole('dialog')).toHaveCount(0);
  assert.equal(await customer.evaluate(el => parseFloat(getComputedStyle(el).left)), original + 100);
  await page.reload(); await expect.poll(() => widthOf(date)).toBe(original + 100);
  await page.getByLabel('Вид таблицы', { exact: true }).selectOption('standard'); await expect.poll(() => widthOf(date)).toBe(original);
  await page.getByLabel('Вид таблицы', { exact: true }).selectOption('reduced'); await expect.poll(() => widthOf(date)).toBe(original + 100);
  await handle.focus(); await page.keyboard.press('ArrowRight'); await expect.poll(() => widthOf(date)).toBe(original + 110);
  await page.keyboard.press('Home'); await expect.poll(() => widthOf(date)).toBe(64);
  await page.keyboard.press('End'); await expect.poll(() => widthOf(date)).toBe(640);
  await handle.dblclick(); await expect.poll(() => widthOf(date)).toBe(original);
  await handle.focus(); await page.keyboard.press('ArrowRight'); await page.getByRole('button', { name: 'Сбросить ширину столбцов' }).click(); await expect.poll(() => widthOf(date)).toBe(original);
  await page.getByRole('button', { name: 'Фильтр: Дата', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  check('Desktop resize tracks drag, preserves neighbors and sorting, updates sticky offsets, persists per view, and supports keyboard bounds / double-click / reset');
  await page.getByRole('tab', { name: 'АЗС', exact: true }).click();
  await page.getByLabel('Формат таблицы АЗС').selectOption('small');
  await page.locator('th[data-field="date"]').getByRole('separator').focus(); await page.keyboard.press('ArrowRight');
  await page.reload(); await page.getByRole('tab', { name: 'АЗС', exact: true }).click();
  await expect.poll(() => widthOf(page.locator('th[data-field="date"]'))).toBe(130);
  check('AZS widths persist separately from tanker views');

  await visit(page, 'directories');
  await page.getByLabel('Поиск в справочнике', { exact: true }).fill('нет такой компании QA');
  await expect(page.locator('.directory-record')).toHaveCount(0);
  await page.getByRole('button', { name: 'Очистить поиск в справочнике' }).click();
  await expect(page.locator('.directory-record').first()).toBeVisible();
  await page.getByRole('button', { name: 'Добавить', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  check('Directory search, clearing and Add remain functional');

  const manifest = await (await fetch(base + '/manifest.webmanifest')).json();
  assert.equal(manifest.display, 'standalone'); assert.equal(manifest.id, '/');
  assert.ok(manifest.icons.some(icon => icon.purpose === 'maskable'));
  for (const icon of [...manifest.icons, { src: '/icons/apple-touch-icon.png', sizes: '180x180' }, { src: '/icons/favicon-32.png', sizes: '32x32' }, { src: '/apple-touch-icon.png', sizes: '180x180' }]) {
    const response = await fetch(base + icon.src); assert.equal(response.status, 200); assert.ok(response.headers.get('content-type').includes('image/png'));
    const bytes = Buffer.from(await response.arrayBuffer()); assert.equal(bytes.subarray(1, 4).toString(), 'PNG');
    assert.equal(`${bytes.readUInt32BE(16)}x${bytes.readUInt32BE(20)}`, icon.sizes);
  }
  await expect(page.locator('link[rel="apple-touch-icon"]')).toHaveAttribute('sizes', '180x180');
  check('Manifest, cache-versioned icons, full-size Apple touch icon and root fallback serve valid PNGs at declared dimensions');

  for (const [name, width, height, touch] of [['mac-webkit', 1440, 1000, false], ['iphone', 390, 844, true], ['ipad', 834, 1194, true], ['ipad-landscape', 1366, 1024, true]]) {
    safari = await webkit.launch({ headless: true });
    const mobile = await safari.newContext({ viewport: { width, height }, isMobile: touch, hasTouch: touch, deviceScaleFactor: touch ? 2 : 1, reducedMotion: 'reduce', timezoneId: 'Europe/Moscow', serviceWorkers: touch ? 'allow' : 'block' });
    await authenticateContext(mobile, base, cookie);
    const screen = await mobile.newPage(); screen.setDefaultTimeout(15000); screen.on('pageerror', error => report.errors.push(`${name}: ${error.message}`));
    await screen.addInitScript(() => localStorage.setItem('artel:shipment-column-widths:v1', JSON.stringify({ 'tanker:expanded': { date: 400 } })));
    for (const route of ['work', 'china', 'directories', 'shipments']) {
      try { await visit(screen, route); } catch (error) {
        await screen.screenshot({ path: resolve(output, `failure-${name}-${route}.png`), fullPage: true, timeout: 5000 }).catch(() => {});
        report.errors.push(`${name}/${route}: ${await screen.locator('body').innerText({ timeout: 5000 }).catch(() => 'WebKit did not respond')}`);
        throw error;
      }
      assert.ok(await screen.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name}/${route}: overflow`);
      if (route === 'shipments') {
        await expect(screen.getByRole('separator')).toHaveCount(touch ? 0 : await screen.locator('.shipment-column-headings th').count());
        assert.equal(await widthOf(screen.locator('th[data-field="date"]')), touch ? 88 : 400);
        await screen.getByTestId('shipments-scroll').evaluate(el => { el.scrollLeft = 160; });
        assert.ok(await screen.getByTestId('shipments-scroll').evaluate(el => el.scrollLeft > 0));
      }
      await screen.screenshot({ path: resolve(output, `${route}-${name}.png`), fullPage: true });
    }
    await visit(screen, 'work'); await screen.getByRole('button', { name: 'Новая задача', exact: true }).click();
    await screen.getByRole('dialog').getByLabel('Название', { exact: true }).fill(`Задача ${name}`);
    await screen.getByRole('dialog').getByRole('button', { name: 'Сохранить', exact: true }).click();
    const card = screen.getByRole('button', { name: `Задача: Задача ${name}`, exact: true }); await card.click();
    await screen.getByRole('dialog').getByRole('button', { name: 'В архив задач', exact: true }).click();
    await expect(screen.getByRole('dialog')).toHaveCount(0); await expect(card).toHaveCount(0);
    check(`${name}: WebKit layouts, scrolling, desktop-only width preferences, task creation and one-click archive${touch ? '' : ' (push service workers blocked in headless runtime)'}`);
    await mobile.close(); await safari.close(); safari = null;
  }
  assert.deepEqual(report.errors, []); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error.stack || error); await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {}); throw error; }
finally {
  await browser?.close(); await safari?.close();
  if (server && server.exitCode === null) { server.kill('SIGTERM'); await new Promise(done => { server.once('exit', done); setTimeout(done, 5000); }); }
  const isolatedPath = resolve(temporary, 'operations.json');
  report.temporaryStoreVerified = existsSync(isolatedPath) && JSON.stringify(JSON.parse(await readFile(isolatedPath, 'utf8')).data.accounts).includes('qa.director');
  await rm(temporary, { recursive: true, force: true });
  const after = await checksum(); report.liveStoreUnchanged = before.full === after.full; report.liveRecordsUnchanged = before.records === after.records;
  if (!report.temporaryStoreVerified || !report.liveRecordsUnchanged) report.status = 'failed';
  await writeFile(resolve(output, 'verification.json'), JSON.stringify(report, null, 2));
  assert.ok(report.temporaryStoreVerified, 'QA account exists in the isolated store');
  assert.ok(report.liveRecordsUnchanged, 'Real records remain unchanged, excluding the independent push heartbeat');
}

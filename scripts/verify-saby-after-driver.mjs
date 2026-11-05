import assert from 'node:assert/strict';
import { dirname, resolve } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { chromium, webkit } from 'playwright';
import AxeBuilder from '@axe-core/playwright';
import { afterDriverFixture } from '../tests/helpers/after-driver-fixture.ts';
import { startTripsQaServer } from './qa-trips-runtime.mjs';
import { SabyClient } from '../server/saby-client.ts';
import { currentSnapshot } from '../server/shipment-operations.ts';
import { recordDriverTripAction } from '../server/driver-trips.ts';
const root = resolve(import.meta.dirname, '..'), built = process.argv.includes('--built'), out = resolve(root, built ? '../ui-after-driver-built' : '../ui-after-driver');
async function startBuilt(f) {
  const app = resolve(root, 'app-dist');
  const server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/')) {
      const upstream = httpRequest(f.origin + req.url, { method: req.method, headers: req.headers }, reply => { res.writeHead(reply.statusCode, reply.headers); reply.pipe(res); });
      upstream.on('error', () => { res.writeHead(502); res.end(); }); req.pipe(upstream); return;
    }
    const path = resolve(app, '.' + (req.url.split('?')[0] === '/' ? '/index.html' : req.url.split('?')[0]));
    if (!path.startsWith(app + '/')) { res.writeHead(404); res.end(); return; }
    try { const body = await readFile(path); res.setHeader('Content-Type', path.endsWith('.js') ? 'text/javascript' : path.endsWith('.css') ? 'text/css' : path.endsWith('.svg') ? 'image/svg+xml' : path.endsWith('.html') ? 'text/html' : 'application/octet-stream'); res.end(body); } catch { res.writeHead(404); res.end(); }
  });
  await new Promise(done => server.listen(0, '127.0.0.1', done));
  return { base: `http://127.0.0.1:${server.address().port}`, server: { close: () => new Promise(done => server.close(done)) } };
}
await mkdir(out, { recursive: true });
const report = { passed: false, syntheticOnly: true, externalRequests: [], checks: [], errors: [] };
for (const [name, launcher] of Object.entries({ chromium, webkit })) for (const width of [375, 1440]) {
  const f = await afterDriverFixture(); let runtime, browser;
  try {
    await f.patch('100');
    const driver = { id: 'qa-driver', login: 'qa-driver', name: 'Водитель', role: 'driver', driverId: 'driver', managerId: null, active: true, version: 1, sections: [] };
    await f.store.mutate(f.source, data => {
      data.accounts.users.push({ ...driver, passwordHash: 'a'.repeat(128), salt: 'a'.repeat(32) });
      const rows = currentSnapshot(f.base, data).shipments.filter(row => row.fields.trip_id === f.tripId);
      return recordDriverTripAction(f.base, data, driver, f.tripId, 'arrive', { versions: Object.fromEntries(rows.map(row => [row.id, row.version])) }, f.config);
    });
    runtime = built ? await startBuilt(f) : await startTripsQaServer({ root, snapshotDirectory: f.snapshotDirectory, operationsDirectory: dirname(f.store.path), sabyClient: new SabyClient(f.config, async () => { throw new Error('External provider forbidden'); }) });
    browser = await launcher.launch();
    const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addCookies([{ name: 'artel_session', value: f.ownerCookie.split('=')[1], url: runtime.base }]);
    await context.route('**/*', route => { if (new URL(route.request().url()).origin !== runtime.base) { report.externalRequests.push(route.request().url()); return route.abort(); } return route.continue(); });
    const page = await context.newPage(); page.on('pageerror', e => report.errors.push(String(e)));
    await page.goto(runtime.base + '/#trips');
    await page.locator('.trips-section-tabs').getByRole('button', { name: 'Рейсы', exact: true }).click();
    const number = (await f.http('/' + f.tripId)).body.trip.number;
    const card = page.locator('.trip-card').filter({ has: page.getByRole('heading', { name: `Рейс №${number}`, exact: true }) });
    await card.waitFor();
    await card.getByRole('button', { name: 'Saby', exact: true }).click();
    await card.getByText('Ожидаем данные водителя', { exact: true }).waitFor();
    assert.equal(await card.getByRole('button', { name: 'Запустить обмен', exact: true }).count(), 0);
    await page.screenshot({ path: resolve(out, `${name}-${width}-waiting.png`), fullPage: true });
    await card.getByRole('button', { name: 'Изменить рейс', exact: true }).click();
    const dialog = page.getByRole('dialog'); await dialog.waitFor();
    await dialog.getByLabel('Примечание к рейсу', { exact: true }).fill('Уточнение после прибытия');
    // Saving closes the form before the three lists finish refreshing. Wait for
    // those reads before reloading; WebKit cancels unfinished reads on navigation.
    const refreshedLists = Promise.all(['/api/shipment-trips', '/api/trip-requests', '/api/trip-requests/context'].map(path =>
      page.waitForResponse(response => new URL(response.url()).pathname === path && response.request().method() === 'GET' && response.ok()).then(response => response.finished()),
    ));
    await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await refreshedLists;
    await card.getByText('Уточнение после прибытия', { exact: true }).waitFor();
    assert.ok((await f.store.read(f.source)).driverTripProgress[f.tripId].arrivedAt, 'unchanged composition preserves arrival');
    await page.reload();
    await page.locator('.trips-section-tabs').getByRole('button', { name: 'Рейсы', exact: true }).click();
    await card.getByRole('button', { name: 'Saby', exact: true }).click();
    await card.getByText('Ожидаем данные водителя', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Удалить рейс', exact: true }).click(); await dialog.waitFor();
    const remove = dialog.getByRole('button', { name: 'Удалить рейс', exact: true });
    await remove.waitFor(); await page.waitForFunction(() => !document.querySelector('dialog .button.danger')?.disabled);
    const axe = await new AxeBuilder({ page }).include('dialog').analyze(); assert.deepEqual(axe.violations.map(v => v.id), []);
    await page.screenshot({ path: resolve(out, `${name}-${width}-delete.png`), fullPage: true });
    await remove.click(); await dialog.waitFor({ state: 'hidden' }); await card.waitFor({ state: 'detached' });
    assert.equal(f.api.calls.length, 0);
    report.checks.push({ engine: name, width, waiting: true, earlyStartAbsent: true, editAfterArrival: true, deleteAfterArrival: true, axeViolations: 0, providerCalls: 0 });
  } finally { await browser?.close(); await runtime?.server.close(); await f.close(); await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2)); }
}
assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
report.passed = true; await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));

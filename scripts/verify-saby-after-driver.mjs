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
// Dialog visibility changes before React starts refreshing its lists. Bind each
// awaited read to the successful mutation, then consume its entire response.
function afterMutationRefresh(page, method, tripId) {
  const paths = ['/api/shipment-trips', '/api/trip-requests', '/api/trip-requests/context'];
  let acknowledged = false;
  const requests = new Set();
  const acknowledge = response => { if (response.request().method() === method && new URL(response.url()).pathname === `/api/shipment-trips/${tripId}` && response.ok()) acknowledged = true; };
  const track = request => { if (acknowledged && request.method() === 'GET' && paths.includes(new URL(request.url()).pathname)) requests.add(request); };
  page.on('response', acknowledge); page.on('request', track);
  return Promise.all(paths.map(path => page.waitForResponse(response => requests.has(response.request()) && new URL(response.url()).pathname === path).then(async response => {
    assert.equal(response.ok(), true, `Refresh failed: ${path}`);
    assert.equal(await response.finished(), null, `Refresh body interrupted: ${path}`);
  }))).finally(() => { page.off('response', acknowledge); page.off('request', track); });
}
await mkdir(out, { recursive: true });
const report = { passed: false, syntheticOnly: true, externalRequests: [], checks: [], errors: [], errorDetails: [] };
for (const [name, launcher] of Object.entries({ chromium, webkit })) for (const width of [375, 1440]) {
  const f = await afterDriverFixture(true); let runtime, browser, phase = 'opening';
  try {
    await f.patch('100');
    const originalRequests = [];
    const trip = (await f.http('/' + f.tripId)).body.trip;
    for (const customer of trip.customers) {
      const made = await f.raw('/api/trip-requests', 'POST', { companyId: customer.fields.customer_id, addressId: customer.fields.unloading_address_id, quantityLitres: '100', comment: 'Возврат заявки ' + customer.fields.customer_id });
      assert.equal(made.status, 201); originalRequests.push(made.body.request);
    }
    await f.store.mutate(f.source, data => {
      originalRequests.forEach((request, i) => {
        Object.assign(data.tripRequests[request.id], { status: 'consumed', tripId: f.tripId, shipmentId: trip.customers[i].id, version: request.version + 1 });
        data.shipments[trip.customers[i].id].fields.source_request_id = request.id;
      });
      return { changed: true, result: null };
    });
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
    const page = await context.newPage(); page.on('pageerror', e => { report.errors.push(String(e)); report.errorDetails.push({ at: new Date().toISOString(), engine: name, width, phase, error: String(e) }); });
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
    phase = 'saving';
    const savedRefresh = afterMutationRefresh(page, 'PATCH', f.tripId);
    await dialog.getByRole('button', { name: 'Сохранить рейс', exact: true }).click(); await dialog.waitFor({ state: 'hidden' });
    await savedRefresh;
    await card.getByText('Уточнение после прибытия', { exact: true }).waitFor();
    assert.ok((await f.store.read(f.source)).driverTripProgress[f.tripId].arrivedAt, 'unchanged composition preserves arrival');
    await page.waitForLoadState('networkidle');
    phase = 'reload';
    await page.reload();
    await page.locator('.trips-section-tabs').getByRole('button', { name: 'Рейсы', exact: true }).click();
    await card.getByRole('button', { name: 'Saby', exact: true }).click();
    await card.getByText('Ожидаем данные водителя', { exact: true }).waitFor();
    await card.getByRole('button', { name: 'Удалить рейс', exact: true }).click(); await dialog.waitFor();
    const remove = dialog.getByRole('button', { name: 'Удалить рейс', exact: true });
    await remove.waitFor(); await page.waitForFunction(() => !document.querySelector('dialog .button.danger')?.disabled);
    const axe = await new AxeBuilder({ page }).include('dialog').analyze(); assert.deepEqual(axe.violations.map(v => v.id), []);
    await page.screenshot({ path: resolve(out, `${name}-${width}-delete.png`), fullPage: true });
    phase = 'delete';
    const deletedRefresh = afterMutationRefresh(page, 'DELETE', f.tripId);
    await remove.click(); await dialog.waitFor({ state: 'hidden' }); await card.waitFor({ state: 'detached' });
    await deletedRefresh;
    await page.locator('.trips-list').waitFor({ state: 'visible' });
    assert.equal(await card.count(), 0, 'deleted trip must remain absent after the lists finish refreshing');
    await page.waitForLoadState('networkidle');
    phase = 'returned-requests';
    await page.locator('.trips-section-tabs').getByRole('button', { name: 'Заявки', exact: true }).click();
    for (const request of originalRequests) await page.getByText(request.comment, { exact: true }).waitFor();
    await page.reload();
    for (const request of originalRequests) await page.getByText(request.comment, { exact: true }).waitFor();
    const returned = (await f.raw('/api/trip-requests')).body.requests;
    for (const original of originalRequests) {
      const request = returned.find(row => row.id === original.id);
      assert.deepEqual(request, { ...original, version: original.version + 2, updatedAt: request.updatedAt });
    }
    phase = 'closing';
    assert.equal(f.api.calls.length, 0);
    report.checks.push({ engine: name, width, waiting: true, earlyStartAbsent: true, editAfterArrival: true, deleteAfterArrival: true, returnedRequests: 2, returnedAfterReload: true, axeViolations: 0, providerCalls: 0 });
  } finally { await browser?.close(); await runtime?.server.close(); await f.close(); await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2)); }
}
assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
report.passed = true; await writeFile(resolve(out, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report));

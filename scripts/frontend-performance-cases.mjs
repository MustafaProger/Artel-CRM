import assert from 'node:assert/strict';
import { expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { resolve } from 'node:path';

export async function frontendCases({ context, base, engine, report, baseline, output }) {
  const mapPage = await context.newPage();
  const mapModules = path => /\/yandex-map(?:-|\.ts)|\/TripRequestsMap|\/DeliveryPointMap|\/DeliveryPointPicker-|\/ol[._/]/.test(path) && !path.includes('coordinates') && !/ol\.css$|ol_proj/.test(path);
  await mapPage.goto(base + '/#trips');
  await expect(mapPage.locator('.trips-page')).toBeVisible();
  const closedScripts = await mapPage.evaluate(() => performance.getEntriesByType('resource').map(row => ({ path: new URL(row.name).pathname, bytes: row.decodedBodySize })));
  const closedMapScripts = closedScripts.filter(row => mapModules(row.path));
  if (!baseline) assert.deepEqual(closedMapScripts, [], 'closed map does not download map engine');
  await mapPage.getByRole('button', { name: 'Карта', exact: true }).click();
  await expect(mapPage.locator('.trip-map-empty')).toBeVisible();
  const openScripts = await mapPage.evaluate(() => performance.getEntriesByType('resource').map(row => ({ path: new URL(row.name).pathname, bytes: row.decodedBodySize })));
  assert.ok(openScripts.some(row => mapModules(row.path)), 'opening map loads its module');
  report.maps.push({ engine, closedMapScripts, closedTotalJsBytes: closedScripts.filter(row => /\.js(?:\?|$)/.test(row.path)).reduce((sum, row) => sum + row.bytes, 0), openMapScripts: openScripts.filter(row => mapModules(row.path)) });
  await mapPage.close();

  const journal = await context.newPage();
  const original = await (await context.request.get(base + '/api/operator')).json();
  let count = 100;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  await journal.route('**/api/operator', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ...original, plans: Array.from({ length: count / 10 }, (_, group) => ({ id: `qa-plan-${group}`, version: 1, clientName: `QA client ${group}`, status: 'active', totalLimit: '16000', allocated: '8000', remaining: '8000', createdAt: `${today}T10:00:00Z`, updatedAt: `${today}T10:00:00Z`, createdBy: 'qa-actor', recipients: Array.from({ length: 10 }, (_, index) => ({ id: `qa-recipient-${group * 10 + index}`, name: `QA recipient ${group * 10 + index}`, bank: 'QA bank', card: '', phone: '', details: '', limit: '1600', used: '800', remaining: '800' })) })), refuellings: Array.from({ length: count }, (_, index) => ({
    id: `qa-operation-${index}`, version: 1, schemaVersion: 3, date: today, name: `QA driver ${index}`,
    serviceId: original.services[0].id, service: original.services[0].name, serviceVersion: original.services[0].version,
    discountPercent: '0', litres: '10', pricePerLitre: '80', amount: '800', paid: false,
    planId: `qa-plan-${Math.floor(index / 10)}`, planClientName: `QA client ${Math.floor(index / 10)}`,
    allocations: [{ kind: 'recipient', recipientId: `qa-recipient-${index}`, amount: '800', planId: `qa-plan-${Math.floor(index / 10)}`, planClientName: `QA client ${Math.floor(index / 10)}`, recipient: { id: `qa-recipient-${index}`, name: `QA recipient ${index}`, bank: 'QA bank', card: '', phone: '', details: '' } }],
    amountMode: 'manual', createdBy: 'qa-actor', recipientText: `QA recipient ${index}`, comment: '', createdAt: `${today}T10:00:00Z`, updatedAt: `${today}T10:00:00Z`, paymentHistory: [],
  })) }) }));
  for (const width of [1440, 390]) {
    await journal.setViewportSize({ width, height: 1000 });
    for (const multiplier of [1, 5, 10]) {
      count = 100 * multiplier;
      await journal.goto('about:blank');
      await journal.goto(base + '/#operator');
      await expect(journal.locator('.operator-workspace')).toBeVisible();
      await expect(journal.locator(width > 700 ? '.operator-desktop-journal tbody' : '.operator-operation-card')).toHaveCount(baseline ? count : 50);
      await journal.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
      const result = await journal.evaluate(() => ({ readyMs: performance.now(), domNodes: document.getElementsByTagName('*').length, operations: document.querySelectorAll('[data-operation-id]').length, longTaskSupported: window.__qaLongTaskSupported, longTasks: window.__qaLongTasks }));
      if (!baseline) assert.equal(result.operations, 50, 'one responsive DOM for each of fifty visible operations');
      report.growth.push({ engine, width, multiplier, count, ...result });
      if (!baseline && multiplier === 10) {
        const axe = await new AxeBuilder({ page: journal }).include('.operator-workspace').analyze();
        assert.deepEqual(axe.violations, []);
        report.axe.push({ engine, width, violations: axe.violations });
        await journal.getByRole('navigation', { name: 'Страницы операций', exact: true }).scrollIntoViewIfNeeded();
        const screenshot = resolve(output, `${engine}-pagination-${width}.png`);
        await journal.screenshot({ path: screenshot }); report.screenshots.push(screenshot);
      }
    }
  }
  await journal.setViewportSize({ width: 700, height: 1000 }); await expect(journal.locator('.operator-operation-card')).toHaveCount(baseline ? count : 50);
  await journal.setViewportSize({ width: 701, height: 1000 }); await expect(journal.locator('.operator-desktop-journal tbody')).toHaveCount(baseline ? count : 50);
  if (!baseline) {
    await journal.getByRole('button', { name: 'Следующая страница операций', exact: true }).click();
    await expect(journal.locator('[data-operation-id="qa-operation-50"]')).toBeVisible();
    await journal.setViewportSize({ width: 390, height: 1000 });
    await expect(journal.locator('[data-operation-id="qa-operation-50"]')).toBeVisible();
    await journal.getByLabel('Поиск операций', { exact: true }).fill('QA driver 999');
    await expect(journal.locator('[data-operation-id]')).toHaveCount(1);
    await expect(journal.locator('[data-operation-id="qa-operation-999"]')).toBeVisible();
    await journal.getByLabel('Поиск операций', { exact: true }).fill('');
    await expect(journal.locator('[data-operation-id="qa-operation-0"]')).toBeVisible();
    await expect(journal.getByRole('button', { name: 'Предыдущая страница операций', exact: true })).toBeDisabled();
  }
  await journal.close();
  console.log('PASS', engine, 'linked operator records x1/x5/x10, responsive 700/701');

  // The browser clock advances timers; HTTP still uses the isolated middleware.
  // Authentication refresh is intentionally outside these endpoint counters.
  for (const [routeId, endpoint, selector] of [['overview', '/api/settlements', '.overview-page'], ['cabinet-balances', '/api/cabinets', '.cabinet-page'], ['payments', '/api/banking', '.banking-page'], ['invoices', '/api/invoices', '.invoice-workspace']]) {
    const poll = await context.newPage(); let reads = 0;
    poll.on('request', request => { if (new URL(request.url()).pathname === endpoint) reads++; });
    await poll.goto(`${base}/#${routeId}`); await expect(poll.locator(selector)).toBeVisible(); await poll.waitForTimeout(200);
    await poll.clock.install();
    const initial = reads;
    await poll.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' }); document.dispatchEvent(new Event('visibilitychange')); });
    await poll.clock.runFor(65_000); await poll.waitForTimeout(100);
    const hidden = reads - initial, beforeReturn = reads;
    await poll.evaluate(() => { Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' }); document.dispatchEvent(new Event('visibilitychange')); window.dispatchEvent(new Event('focus')); });
    await poll.clock.runFor(100); await poll.waitForTimeout(100);
    const returned = reads - beforeReturn;
    if (!baseline) { assert.equal(hidden, 0, `${routeId}: hidden reads`); assert.equal(returned, 1, `${routeId}: coalesced return read`); }
    report.polling.push({ engine, route: routeId, hiddenMs: 65_000, hiddenReads: hidden, returnReads: returned });
    await poll.close();
  }
  console.log('PASS', engine, 'hidden polling and paired focus/visibility');
}

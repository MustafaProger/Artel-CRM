// Real application and API, with a disposable synthetic store only.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-request-copy-'));
const output = resolve(root, '../request-copy-20261119-qa');
await mkdir(output, { recursive: true });
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
const source = await writeTripsQaSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
await store.mutate(source, data => {
  data.sourceOperationsCleared = true;
  data.companies = [{ id: 'qa-company', name: 'ООО «Тестовая доставка»', roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] }];
  data.directories = { fleetSeedApplied: true, managers: [], products: [], paymentForms: [], vehicles: [], drivers: [], oilDepots: [], addresses: [
    { id: 'qa-place', companyId: 'qa-company', kind: 'delivery', name: 'Учебная площадка', address: 'Москва, Учебная улица, 1', mapUrl: 'https://yandex.ru/maps/?pt=37.6,55.7&z=16', receiverName: 'Иван', receiverPhone: '+7 (900) 000-00-01' },
    { id: 'qa-empty', companyId: 'qa-company', kind: 'delivery', name: 'Без контакта', address: 'Москва, Учебная улица, 2' },
  ], customerManagers: [], defaults: { profit: 'template-payment-form' }, duplicates: [] };
  return { changed: true, result: null };
});
const report = { checks: [], screenshots: [], browserErrors: [], externalRequests: [] };
let runtime, browser;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const call = async (path, body) => {
    const res = await fetch(runtime.base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await res.json(); assert.ok(res.ok, result.error); return result;
  };
  await call('/api/trip-requests', { companyId: 'qa-company', addressId: 'qa-place', quantityLitres: '1000.5', salePricePerLitre: '95.3', executionDate: '2099-11-19', comment: 'Желательно после обеда\nПозвонить за час' });
  await call('/api/trip-requests', { companyId: 'qa-company', addressId: 'qa-empty', quantityLitres: '2000', executionDate: '2099-11-20', comment: '' });
  const before = (await call('/api/trip-requests')).requests;
  const expected = ['19.11.2099', 'ООО «Тестовая доставка»', '1\u00a0000,5 л | 95,3 ₽/л', 'Москва, Учебная улица, 1', 'https://yandex.ru/maps/?pt=37.6,55.7&z=16', 'Иван | +7 (900) 000-00-01', 'Желательно после обеда\nПозвонить за час'].join('\n');
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await authenticateContext(context, runtime.base, cookie);
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== runtime.base) { report.externalRequests.push(url.href); return route.abort(); }
      return route.continue();
    });
    const page = await context.newPage();
    page.on('pageerror', error => report.browserErrors.push(`${engine}: ${error.message}`));
    // The browser's clipboard is deterministic here; Chromium is also checked against the OS clipboard below.
    await page.addInitScript(() => { window.qaClipboard = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async text => { window.qaClipboard = text; } } }); });
    await page.goto(runtime.base + '/#trips');
    const card = page.getByTestId('trip-request-card').filter({ hasText: 'Москва, Учебная улица, 1' });
    await expect(card).toBeVisible();
    for (const width of [1440, 768, 390, 375]) {
      await page.setViewportSize({ width, height: 1000 });
      const buttons = card.locator('.trip-request-actions > button');
      await expect(buttons).toHaveCount(3);
      await expect(buttons).toHaveText(['', '', '']);
      const bounds = await buttons.evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; }));
      assert.ok(bounds.every(b => b.w >= 44 && b.h >= 44));
      assert.ok(bounds[0].x < bounds[1].x && bounds[1].x < bounds[2].x);
      assert.ok(bounds.every(b => b.y === bounds[0].y));
      const footer = await card.locator('footer').boundingBox();
      const last = bounds[2];
      assert.ok(Math.abs(last.x + last.w - (footer.x + footer.width)) <= 1, `${engine}: actions align right at ${width}px`);
      await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), { message: `${engine} layout at ${width}px` }).toBe(true).catch(async error => {
        console.log(await page.evaluate(() => [...document.querySelectorAll('body *')].filter(node => node.getBoundingClientRect().right > innerWidth + 1).map(node => ({ tag: node.tagName, class: node.className, right: node.getBoundingClientRect().right, width: node.getBoundingClientRect().width })).slice(0, 20)));
        await page.screenshot({ path: resolve(output, `${engine}-overflow.png`), fullPage: true }); throw error;
      });
      await card.getByRole('button', { name: /^(Скопировать заявку|Заявка скопирована):/ }).click();
      await expect(card.getByRole('button', { name: /^Заявка скопирована:/ })).toBeVisible();
      assert.equal(await page.evaluate(() => window.qaClipboard), expected);
      await card.scrollIntoViewIfNeeded();
      const path = resolve(output, `${engine}-${width}.png`); await card.screenshot({ path }); report.screenshots.push(path);
    }
    await card.getByRole('button', { name: /^Изменить заявку:/ }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.getByRole('dialog').getByRole('button', { name: 'Отмена', exact: true }).click();
    const emptyCard = page.getByTestId('trip-request-card').filter({ hasText: 'Москва, Учебная улица, 2' });
    await emptyCard.getByRole('button', { name: /^Скопировать заявку:/ }).click();
    const missing = await page.evaluate(() => window.qaClipboard);
    assert.ok(missing.includes('Цена не указана') && missing.includes('Приёмщик не указан | Телефон не указан') && missing.endsWith('Комментарий не указан'));
    if (engine === 'chromium') {
      await context.grantPermissions(['clipboard-read', 'clipboard-write']);
      await page.evaluate(() => { delete navigator.clipboard; });
      await card.getByRole('button', { name: /^(Скопировать заявку|Заявка скопирована):/ }).click();
      assert.equal(await page.evaluate(() => navigator.clipboard.readText()), expected);
    }
    await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => { throw Error('Denied'); } } }));
    await card.getByRole('button', { name: /^(Скопировать заявку|Заявка скопирована):/ }).click();
    await expect(card.getByRole('alert')).toContainText('Не удалось скопировать');
    await expect(card.getByRole('textbox', { name: /^Текст заявки:/ })).toHaveValue(expected);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await card.getByRole('button', { name: 'Закрыть', exact: true }).click();
    assert.deepEqual((await call('/api/trip-requests')).requests, before);
    report.checks.push(`${engine}: exact text, icon order and 44px targets at 375–1440px, edit opens, missing fields, clipboard failure fallback, saved requests unchanged`);
    await context.close(); await browser.close(); browser = null;
  }
  assert.deepEqual(report.browserErrors, []); assert.deepEqual(report.externalRequests, []); report.passed = true;
  console.log(JSON.stringify(report, null, 2));
} finally {
  await browser?.close(); await runtime?.server.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true });
}

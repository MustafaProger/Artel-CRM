import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'operator-notifications-'));
const output = resolve(root, '.local/operator-notifications-ui'); await mkdir(output, { recursive: true });
const snapshotDirectory = resolve(temporary, 'snapshot'); await writeTripsQaSnapshot(snapshotDirectory);
const runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory: resolve(temporary, 'store') });
const { cookie } = await runtime.bootstrap();
const response = await fetch(runtime.base + '/api/operator/plans', { method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: runtime.base }, body: JSON.stringify({ clientName: 'Синтетическое задание для уведомлений', recipients: [{ id: randomUUID(), name: 'Получатель QA', bank: 'Банк QA', card: '0000', phone: '', details: '', limit: '100' }], idempotencyKey: randomUUID() }) });
assert.equal(response.status, 201); const plan = await response.json();
const report = { synthetic: true, serviceWorkers: 'blocked for layout checks; API delivery tested separately', mode: runtime.mode, checks: [], errors: [], screenshots: [] }; let browser;
try {
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]].filter(([engine]) => !process.env.QA_ENGINE || process.env.QA_ENGINE === engine)) {
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await authenticateContext(context, runtime.base, cookie);
    await context.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
    const page = await context.newPage();
    if (process.env.QA_TRACE) {
      page.on('request', req => console.log('request', new URL(req.url()).pathname));
      page.on('requestfinished', req => console.log('finished', new URL(req.url()).pathname));
      page.on('requestfailed', req => console.log('failed', new URL(req.url()).pathname, req.failure()));
      page.on('console', msg => console.log('console', msg.type(), msg.text()));
    }
    page.on('pageerror', error => report.errors.push(error.message));
    await page.goto(runtime.base + '/#operator');
    try { await expect(page.getByRole('tab', { name: 'Операции', exact: true })).toBeVisible({ timeout: 15000 }); }
    catch (error) { console.log(engine, await page.locator('body').innerText({ timeout: 3000 }).catch(() => 'Renderer did not respond')); await page.screenshot({ path: resolve(output, `${engine}-failure.png`), timeout: 3000 }).catch(() => {}); throw error; }
    for (const width of [375, 390, 600, 768, 1024, 1100, 1101, 1440, 1920]) {
      await page.setViewportSize({ width, height: 900 });
      for (const tab of ['Операции', 'Задания']) {
        await page.getByRole('tab', { name: tab, exact: true }).click();
        const bell = page.getByRole('button', { name: 'Уведомления операторской', exact: true });
        const refresh = page.getByRole('button', { name: 'Обновить', exact: true });
        const add = page.getByRole('button', { name: tab === 'Задания' ? 'Новое задание' : 'Новая операция', exact: true });
        const boxes = await Promise.all([bell, refresh, add].map(row => row.boundingBox()));
        assert.ok(boxes.every(Boolean));
        assert.ok(Math.max(...boxes.map(b => b.y)) - Math.min(...boxes.map(b => b.y)) < 2);
        assert.ok(boxes[0].x + boxes[0].width <= boxes[1].x);
        assert.ok(boxes[1].x + boxes[1].width <= boxes[2].x);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
        for (const control of [bell, refresh, add]) {
          const label = control.locator('.mobile-action-label');
          if (width <= 1100) { await expect(label).toBeHidden(); const box = await control.boundingBox(); assert.equal(box.width, 44); assert.equal(box.height, 44); }
          else await expect(label).toBeVisible();
        }
        await bell.click(); const dialog = page.getByRole('dialog', { name: 'Уведомления операторской', exact: true });
        await expect(dialog).toBeVisible(); await expect(dialog).toContainText('о выполнении ваших заданий');
        assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        const axe = await new AxeBuilder({ page }).include('.driver-notifications-dialog').analyze();
        assert.deepEqual(axe.violations, []);
        await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(bell).toBeFocused();
      }
      if ([375, 1440].includes(width)) { const path = resolve(output, `${engine}-${width}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); }
      report.checks.push(`${engine}: ${width}px, both tabs, order/size/labels/dialog/axe/focus`);
    }
    await page.goto(runtime.base + `/?operatorPlan=${plan.id}#operator`);
    await expect(page.getByRole('tab', { name: 'Операции', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByLabel('Фильтр по заданию', { exact: true })).toHaveValue(plan.id);
    report.checks.push(`${engine}: notification link opens matching plan`);
    await context.close(); await browser.close(); browser = null;
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await browser?.close(); await runtime.server.close(); await rm(temporary, { recursive: true, force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));

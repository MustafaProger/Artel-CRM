import { chromium, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'qa/apple-refresh');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-apple-qa-'));
const base = 'http://127.0.0.1:5198';
const report = { checks: [], violations: [], errors: [], status: 'running' };
const check = name => { report.checks.push(name); console.log('PASS', name); };
await mkdir(output, { recursive: true });
let server, browser, page;
try {
  await assert.rejects(fetch(base, { signal: AbortSignal.timeout(500) }));
  server = spawn(process.execPath, [resolve(root, 'node_modules/vite/bin/vite.js'), 'preview', '--host', '127.0.0.1', '--port', '5198', '--strictPort'], { cwd: root, env: { ...process.env, ARTEL_STORE_DIR: temporary, CHECKO_API_KEY: '' }, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(base + '/api/auth/session')).ok) break; } catch {} await new Promise(done => setTimeout(done, 100)); }
  const { cookie } = await bootstrapQaAuth(base);
  const api = async (path, body) => { const r = await fetch(base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await r.json(); assert.ok(r.ok, JSON.stringify(value)); return value; };
  const snapshot = await api('/api/snapshot');
  const supplier = snapshot.companies.find(c => c.roles.includes('supplier'));
  await api('/api/china/days', { date: '2026-09-10', fuels: [{ supplierId: supplier.id, litres: '1200.25', amount: '85400.75' }, { supplierId: supplier.id, litres: '900', amount: '64400' }] });
  await api('/api/china/payments', { date: '2025-12-31', amount: '150801' });
  await api('/api/work/tasks', { title: 'Подготовить документы', description: 'Проверить договор и отгрузку', companyId: supplier.id, dueDate: '2026-09-11', reminderAt: null });
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, reducedMotion: 'reduce', timezoneId: 'Europe/Moscow' });
  await authenticateContext(context, base, cookie);
  page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
  const routes = { overview: ['Обзор', '.blank-workspace'], work: ['Работа', '.work-toolbar'], shipments: ['Отгрузки', '.shipment-grid'], payments: ['Платежи', '.payment-stats'], stock: ['Склад', '.blank-workspace'], china: ['Китай', '.china-table'], operator: ['Операторская', '.soft-notice'], payroll: ['ЗП', '.payroll-tabs'], directories: ['Справочники', '.directory-list'] };
  const visit = async route => { await page.goto(base + '/#' + route); await expect(page.locator('h1').first()).toContainText(routes[route][0]); await page.locator(routes[route][1]).waitFor(); await expect(page.locator('.loading-state')).toHaveCount(0); if (route === 'china') await expect(page.getByRole('button', {name:'Добавить день',exact:true})).toBeEnabled(); if (route === 'work') await expect(page.getByRole('button', {name:'Новая задача',exact:true})).toBeEnabled(); if (route === 'shipments') await page.getByTestId('shipment-row').first().waitFor(); };
  const screenshot = name => page.screenshot({ path: resolve(output, name + '.png'), fullPage: true });
  const audit = async name => { const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa']).analyze(); report.violations.push(...result.violations.map(v => ({ page: name, id: v.id, impact: v.impact, nodes: v.nodes.map(n => ({ target: n.target, failureSummary: n.failureSummary })) }))); };
  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 960 });
    for (const route of Object.keys(routes)) {
      await visit(route);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${route} overflow at ${width}`);
      if ([1440, 320].includes(width)) { await screenshot(`${route}-${width}`); await audit(`${route}-${width}`); }
    }
    check(`All 9 pages without page overflow at ${width}px`);
  }
  await visit('china');
  await expect(page.getByTestId('china-balance')).toHaveText('1\u00a0000,25');
  const widths = await page.locator('.china-table th').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().width));
  assert.ok(widths[0] <= 50 && widths[1] <= 62);
  assert.ok(await page.locator('.china-table-scroll').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
  await page.locator('.china-details summary').first().click(); await screenshot('china-details-320');
  await page.getByRole('button', { name: 'Добавить платёж', exact: true }).click();
  let dialog = page.getByRole('dialog'); await dialog.getByLabel('Сумма платежа').fill('1000.25'); await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByTestId('china-balance')).toHaveText('2\u00a0000,5');
  await page.reload(); await expect(page.getByTestId('china-balance')).toHaveText('2\u00a0000,5');
  await page.getByRole('button', { name: 'Открыть день 2026-09-10' }).click(); dialog = page.getByRole('dialog');
  await dialog.getByLabel('Сумма 1', { exact: true }).fill('86400.75'); await audit('china-editor-320'); await screenshot('china-editor-320');
  await dialog.getByRole('button', { name: 'Сохранить', exact: true }).click(); await expect(dialog).toHaveCount(0); await expect(page.getByTestId('china-balance')).toHaveText('1\u00a0000,5');
  check('China all-time balance updates after receipts, edits and reload; compact mobile columns and details');
  await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Меню разделов' }); await expect(menu).toBeVisible();
  await expect(menu.getByRole('button', { name: 'Выйти', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Команды и роли', exact: true })).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Глобальный поиск контрагентов' })).toHaveCount(0);
  await audit('mobile-menu'); await screenshot('menu-320');
  await menu.getByRole('button', { name: 'Закрыть меню', exact: true }).focus(); await page.keyboard.press('Shift+Tab');
  assert.ok(await menu.evaluate(el => el.contains(document.activeElement)), 'Menu traps focus');
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0); await expect(page.getByRole('button', { name: 'Открыть меню', exact: true })).toBeFocused();
  check('Two-line menu, logout inside, keyboard focus trap, Escape and focus restoration; removed team/search');
  await visit('shipments'); await page.getByRole('button', { name: 'Добавить отгрузку', exact: true }).click(); dialog = page.getByRole('dialog'); await audit('shipment-editor-320'); await screenshot('shipment-editor-320'); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  await page.setViewportSize({ width: 1440, height: 960 }); await page.getByLabel('Вид таблицы', { exact: true }).selectOption('reduced');
  const productWidth = await page.locator('th[data-field="product"]').evaluate(el => el.getBoundingClientRect().width); assert.ok(productWidth <= 66);
  await page.getByRole('button', { name: 'Фильтр: Товар', exact: true }).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  await page.locator('.shipment-grid tbody tr:not(.shipment-spacer) td').first().focus(); await page.keyboard.press('Enter'); await expect(page.getByRole('dialog')).toBeVisible(); await page.keyboard.press('Escape');
  check('Shipment compact column widths, filtering and keyboard editor');
  await page.setViewportSize({ width: 320, height: 960 }); await visit('directories'); await page.getByRole('button', { name: 'Добавить', exact: true }).click(); await audit('directory-editor-320'); await screenshot('directory-editor-320'); await page.keyboard.press('Escape');
  await visit('work'); await page.getByRole('button', { name: 'Новая задача', exact: true }).click(); await audit('work-editor-320'); await screenshot('work-editor-320'); await page.keyboard.press('Escape');
  assert.ok(await page.evaluate(() => [...document.querySelectorAll('*')].filter(el => el.getClientRects().length).every(el => getComputedStyle(el).transitionDuration.split(',').every(value => parseFloat(value) === 0) && getComputedStyle(el).animationName === 'none')));
  check('Reduced motion disables transitions and animations; primary editors audited on 320px');
  assert.deepEqual(report.errors, []); assert.equal(report.violations.length, 0, 'See verification.json for accessibility findings');
  report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = String(error.stack || error); await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }); throw error; }
finally { await browser?.close(); server?.kill('SIGTERM'); await writeFile(resolve(output, 'verification.json'), JSON.stringify(report, null, 2)); await rm(temporary, { recursive: true, force: true }); }

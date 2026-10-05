// Synthetic accounts only; navigation must not change credentials or records.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { chromium, webkit, expect } from '@playwright/test';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { SabyClient } from '../server/saby-client.ts';

const root = resolve(import.meta.dirname, '..');
const rt = await integrationRuntime();
const output = resolve(root, `qa/account-editor-scroll${process.env.QA_WEBKIT === '1' ? '-webkit' : ''}`);
await mkdir(output, { recursive: true });
const report = { checks: [], errors: [], writes: [] };
let server, browser;
try {
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: new SabyClient(integrationConfig(), async () => { throw new Error('External provider forbidden'); }), sabyWorkflowMonitoringEnabled: false, bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false' } });
  server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'web'), cacheDir: resolve(rt.directory, 'vite'), plugins: [react(), { name: 'fixture-api', configureServer(vite) { vite.middlewares.use(middleware); } }], server: { host: '127.0.0.1', port: 0 } });
  await server.listen();
  const base = `http://127.0.0.1:${server.httpServer.address().port}`;
  const owner = { name: 'QA Директор', login: 'scroll.qa.owner', password: randomUUID(), managerId: 'manager' };
  assert.equal((await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(owner) })).status, 200);
  await rt.store.mutate(rt.source, data => {
    const template = data.accounts.users[0];
    for (let i = 0; i < 16; i++) {
      const id = `scroll-employee-${i}`;
      data.directories.managers.push({ id, name: `QA Сотрудник ${i}` });
      data.accounts.users.push({ ...template, id, name: `QA Сотрудник ${i}`, login: `scroll.employee.${i}`, role: 'employee', managerId: id, sections: ['work'] });
    }
    data.accounts.users.push({ ...template, id: 'scroll-driver', name: 'QA Водитель', login: 'scroll.driver', role: 'driver', managerId: null, driverId: 'driver', sections: [] });
    return { changed: true, result: null };
  });

  browser = process.env.QA_WEBKIT === '1' ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ serviceWorkers: 'block' });
  assert.equal((await context.request.post(base + '/api/auth/login', { data: { login: owner.login, password: owner.password } })).status(), 200);
  const before = JSON.stringify((await rt.store.read(rt.source)).accounts);
  await context.route('**/*', route => {
    const request = route.request();
    if (new URL(request.url()).origin !== base) return route.abort();
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) { report.writes.push(request.method()); return route.abort(); }
    return route.continue();
  });
  const page = await context.newPage();
  page.on('pageerror', error => report.errors.push(error.message));
  for (const reducedMotion of ['reduce', 'no-preference']) {
    await page.emulateMedia({ reducedMotion });
    for (const width of [320, 390, 988, 1440]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto(base + '/#accounts');
      await expect(page.locator('.account-row')).toHaveCount(18);
      for (const name of ['QA Водитель', 'QA Водитель', 'QA Сотрудник 15']) {
        const button = page.locator('.account-row').filter({ has: page.locator('strong', { hasText: name }) }).getByRole('button', { name: 'Изменить', exact: true });
        await button.scrollIntoViewIfNeeded();
        assert.ok(await page.evaluate(() => scrollY > 500));
        await page.evaluate(() => {
          window.scrollPositions = [];
          window.recordScroll = () => window.scrollPositions.push(window.scrollY);
          window.addEventListener('scroll', window.recordScroll);
        });
        await button.click();
        const editor = page.getByRole('region', { name: 'Настройки учётной записи', exact: true });
        await expect(editor).toBeFocused();
        await expect.poll(async () => Math.round((await editor.boundingBox()).y)).toBeGreaterThanOrEqual(0);
        await expect.poll(async () => Math.round((await editor.boundingBox()).y)).toBeLessThanOrEqual(30);
        const positions = await page.evaluate(() => {
          window.removeEventListener('scroll', window.recordScroll);
          return [...new Set(window.scrollPositions)];
        });
        if (reducedMotion === 'no-preference') assert.ok(positions.length > 2, 'Smooth scroll must include intermediate positions');
        if (name === 'QA Водитель') await expect(editor.getByLabel('Водитель справочника', { exact: true })).toHaveValue('driver');
        else await expect(editor.getByLabel('Имя в приложении', { exact: true })).toHaveValue(name);
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      }
      await page.screenshot({ path: resolve(output, `editor-${width}-${reducedMotion}.png`) });
      await page.getByRole('button', { name: 'Отмена', exact: true }).click();
      report.checks.push(`${width}px ${reducedMotion}: driver, repeat, employee, focus and viewport`);
    }
  }
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.writes, []);
  assert.ok(JSON.stringify((await rt.store.read(rt.source)).accounts) === before, 'Account data changed during navigation');
  console.log('PASS', report.checks.join('; '));
} finally {
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  await browser?.close(); await server?.close(); await rt.close();
}

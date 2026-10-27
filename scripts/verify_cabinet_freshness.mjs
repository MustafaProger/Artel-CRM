import assert from 'node:assert/strict';

import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';

import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), built = process.argv.includes('--built');
const output = resolve(root, '.local/cabinet-performance', built ? 'built' : 'source');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-cabinet-ui-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await mkdir(output, { recursive: true }); await writeTripsQaSnapshot(snapshotDirectory);
await loadSnapshot(snapshotDirectory); const store = new OperationsStore(operationsDirectory);
const report = { synthetic: true, passed: false, errors: [], checks: [] };
let runtime, browser;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory });
  if (built) runtime.server.middlewares.stack.unshift({ route: '', handle(req, res, next) {
    const path = new URL(req.url, runtime.base).pathname; if (path.startsWith('/api/')) return next();
    const relative = path === '/' ? 'index.html' : path.slice(1); if (relative.includes('..')) return next();
    readFile(resolve(root, 'app-dist', relative)).then(body => { res.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : relative.endsWith('.svg') ? 'image/svg+xml' : 'text/html'); res.end(body); }).catch(() => next());
  } });
  const { cookie } = await bootstrapQaAuth(runtime.base); // legacy hash only
  const before = await readFile(store.path, 'utf8');
  for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await driver.launch({ headless: true });
    for (const width of [1440, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await authenticateContext(context, runtime.base, cookie);
      await context.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
      const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message));
      let refreshed = false;
      const current = new Date().toISOString(), old = new Date(Date.now() - 3600_000).toISOString();
      const row = { id: 'cabinet-00000000-0000-0000-0000-000000000001', provider: 'glopro', label: 'QA кабинет', createdAt: current, state: 'connected', lastSuccessAt: current, accounts: [{ id: '1:2', supplier: 'QA поставщик', contract: 'QA-1', amountMinor: 12345678, currency: 'RUB' }] };
      await context.route('**/api/cabinets**', async route => {
        if (route.request().method() === 'POST') refreshed = true;
        const connection = { ...row, accounts: [{ ...row.accounts[0], sourceUpdatedAt: refreshed ? current : old }] };
        await route.fulfill({ contentType: 'application/json', body: JSON.stringify(route.request().method() === 'POST' ? { connection } : { credentialStorageReady: true, connections: [connection] }) });
      });
      await page.goto(runtime.base + '/#cabinet-balances');
      await expect(page.getByText('Данные требуют обновления', { exact: true })).toBeVisible();
      await expect(page.getByText(/^Данные GloPro на /)).toBeVisible();
      const amount = await page.locator('.cabinet-account-amount').innerText();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.getByRole('button', { name: 'Обновить', exact: true }).click();
      await expect(page.getByText('Остатки обновлены', { exact: true })).toBeVisible();
      assert.equal(await page.locator('.cabinet-account-amount').innerText(), amount);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await page.screenshot({ path: resolve(output, `${engine}-${width}.png`) });
      await context.close();
      report.checks.push({ engine, width, sourceTimeVisible: true, staleDetected: true, refreshVerified: true, amountPreserved: true, noOverflow: true });
    }
    await browser.close(); browser = null;
  }
  assert.equal(await readFile(store.path, 'utf8'), before); report.storeUnchanged = true;
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await browser?.close(); await runtime?.server.close();
  await writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify(report));

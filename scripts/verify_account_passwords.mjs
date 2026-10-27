import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { saveUser } from '../server/auth.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), built = process.argv.includes('--built');
const output = resolve(root, '.local/account-password-view', built ? 'built' : 'source');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-password-ui-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await mkdir(output, { recursive: true }); await writeTripsQaSnapshot(snapshotDirectory);
const snapshot = await loadSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
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
  process.env.ARTEL_ACCOUNT_PASSWORD_KEY = randomBytes(32).toString('hex');
  const password = 'Synthetic-Only-' + 'X'.repeat(200);
  await store.mutate(snapshot.provenance.sourceSha256, async data => {
    data.directories.managers.push({ id: 'qa-manager', name: 'QA сотрудник' });
    const user = await saveUser(data, { ...snapshot, directories: data.directories }, { name: 'QA Новый пароль', login: 'qa.password', password, role: 'employee', managerId: 'qa-manager', sections: [] });
    return { changed: true, result: user };
  });
  const before = await readFile(store.path, 'utf8');
  for (const [engine, driver] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await driver.launch({ headless: true });
    for (const width of [1440, 320]) {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
      await authenticateContext(context, runtime.base, cookie);
      await context.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
      const page = await context.newPage(); page.on('pageerror', e => report.errors.push(e.message));
      let reveals = 0; page.on('request', request => { if (/\/users\/[^/]+\/password$/.test(request.url())) reveals++; });
      await page.goto(runtime.base + '/#accounts');
      const row = page.locator('.account-row').filter({ hasText: 'QA Новый пароль' });
      await expect(row.getByRole('button', { name: 'Показать пароль', exact: true })).toBeVisible();
      await expect(page.getByText('Пароль недоступен для просмотра: задан ранее.', { exact: true })).toBeVisible();
      assert.equal(reveals, 0); assert.ok(!(await page.content()).includes(password));
      await row.getByRole('button', { name: 'Показать пароль', exact: true }).click();
      await expect(row.locator('code')).toHaveText(password);
      assert.equal(reveals, 1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await row.getByRole('button', { name: 'Скрыть пароль', exact: true }).click();
      await expect(row.locator('code')).toHaveCount(0);
      await row.getByRole('button', { name: 'Показать пароль', exact: true }).click();
      await expect(row.locator('code')).toHaveText(password);
      await page.evaluate(() => window.dispatchEvent(new Event('blur')));
      await expect(row.locator('code')).toHaveCount(0);
      await page.clock.install();
      await row.getByRole('button', { name: 'Показать пароль', exact: true }).click();
      await expect(row.locator('code')).toHaveText(password);
      await page.clock.fastForward(30_100); await expect(row.locator('code')).toHaveCount(0);
      await page.screenshot({ path: resolve(output, `${engine}-${width}.png`) });
      await context.close();
      report.checks.push({ engine, width, legacyUnavailable: true, explicitReveal: true, hiddenByDefault: true, hideOnBlur: true, autoHide: true, noOverflow: true });
    }
    await browser.close(); browser = null;
  }
  assert.equal(await readFile(store.path, 'utf8'), before); report.storeUnchanged = true;
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  delete process.env.ARTEL_ACCOUNT_PASSWORD_KEY;
  await browser?.close(); await runtime?.server.close();
  await writeFile(resolve(output, 'result.json'), JSON.stringify(report, null, 2));
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify(report));

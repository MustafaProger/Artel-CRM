// Synthetic UI states, temporary store, loopback only. Provider lifecycle is tested separately.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SabyClient } from '../server/saby-client.ts';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { authenticateContext } from './qa-auth.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';

const root = resolve(import.meta.dirname, '..');
const engine = process.env.QA_WEBKIT === '1' ? 'webkit' : 'chromium';
const mode = process.env.ARTEL_OPERATOR_QA_BUILT === '1' ? 'built' : 'source';
const output = resolve(root, 'qa', `saby-native-wait-${mode}-${engine}`);
await mkdir(output, { recursive: true });
const rt = await integrationRuntime();
const report = { passed: false, synthetic: true, workingStoreAccessed: false, realSabyRequests: 0, mode, engine, checks: [], axe: [], errors: [], externalRequests: [], screenshots: [] };
const initial = () => ({
  status: 'sent', phase: 'creating_etrn', ready: true, blockers: [], locked: true,
  updatedAt: '2026-10-29T14:00:00Z', lastError: null, carrierConfirmed: true,
  lastCheckedAt: '2026-10-29T14:00:00Z', lastCheckAttemptAt: '2026-10-29T14:00:00Z',
  monitoring: { enabled: true, intervalSeconds: 60 }, history: [],
  automation: { enabled: true, enrolled: true },
  driverFlow: { state: 'ready', processingAllowanceHours: 10 },
  driverConfirmation: { arrivedAt: '2026-10-29T13:00:00Z', confirmedAt: '2026-10-29T13:48:00Z' },
  signing: { state: 'completed', mode: 'automatic', requestedAt: '2026-10-29T12:00:00Z', sender: { state: 'confirmed' }, carrier: { state: 'confirmed' } },
  order: { id: 'synthetic-order', number: 'QA-45', date: '2026-10-29', status: 'draft', url: null, revision: 'synthetic-revision', remoteStatus: 'Выполнение завершено успешно', signatureStatus: 'reported_by_saby', exchangeStage: 'carrier_confirmed', remoteStateCode: '7' },
  deliveries: rt.trip.customers.map((row, index) => ({ shipmentId: row.id, id: null, status: index === 0 ? 'pending' : 'not_sent', lastError: null, ...(index === 0 ? { waitingForNativeDraft: true } : {}) })),
});
let state = initial(), reads = 0, posts = 0, runtime, browser, page;
try {
  runtime = await startOperatorQaServer({ root, snapshotDirectory: rt.snapshotDirectory, operationsDirectory: resolve(rt.directory, 'store'), sabyClient: new SabyClient(integrationConfig(), async () => { throw new Error('External provider calls forbidden'); }) });
  report.runtimeMode = runtime.mode; report.artifacts = runtime.artifacts;
  const { cookie } = await runtime.bootstrap();
  browser = await (engine === 'webkit' ? webkit : chromium).launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
  await context.route('**/*', async route => {
    const req = route.request(), url = new URL(req.url());
    if (url.origin !== runtime.base) { report.externalRequests.push(url.href); return route.abort(); }
    const json = value => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(value) });
    if (/\/saby-workflow$/.test(url.pathname)) { if (req.method() === 'GET') reads++; else posts++; return json(state); }
    if (/\/shipment-trips\/[^/]+\/etrn$/.test(url.pathname)) return json({ deliveries: [] });
    if (/\/shipment-trips\/[^/]+\/saby$/.test(url.pathname)) return json({ saby: { documents: [] } });
    return route.continue();
  });
  await authenticateContext(context, runtime.base, cookie);
  page = await context.newPage(); await page.clock.install();
  page.on('pageerror', error => report.errors.push(error.message));
  const main = page.getByRole('region', { name: 'Документы рейса в Saby', exact: true });
  for (const scenario of ['waiting', 'error', 'completed']) {
    state = initial();
    if (scenario === 'error') {
      state.phase = 'error'; state.status = 'error'; state.lastError = 'Синтетическая неоднозначная связь ЭТрН требует проверки.';
      state.monitoring = { enabled: false, intervalSeconds: null, reason: 'Автопроверка приостановлена после ошибки. Исправьте документ и выполните сверку.' };
      state.deliveries[0] = { ...state.deliveries[0], status: 'error', lastError: state.lastError }; delete state.deliveries[0].waitingForNativeDraft;
    } else if (scenario === 'completed') {
      state.phase = 'completed'; state.stage6CompletedAt = '2026-10-29T14:10:00Z';
      state.deliveries = state.deliveries.map((row, index) => ({ shipmentId: row.shipmentId, id: `synthetic-note-${index}`, status: 'draft', lastError: null }));
    }
    for (const width of [320, 390, 768, 1440]) {
      await page.setViewportSize({ width, height: 1100 });
      await page.goto(runtime.base + `/?qa=${scenario}-${width}#trips`); await page.locator('.trips-section-tabs').getByRole('button', { name: 'Рейсы', exact: true }).click(); await page.getByRole('button', { name: 'Saby', exact: true }).click();
      await expect(main).toBeVisible();
      const heading = main.locator('.workflow-current strong');
      await expect(heading).toHaveText(scenario === 'waiting' ? 'Ожидаем ЭТрН от Saby' : scenario === 'error' ? 'Создание ЭТрН приостановлено' : 'Все этапы рейса завершены');
      if (scenario === 'waiting') {
        await expect(main).toContainText('CRM автоматически проверяет появление связанной ЭТрН');
        await expect(main.getByRole('alert')).toHaveCount(0);
        await expect(main).not.toContainText('Автопроверка приостановлена');
      } else if (scenario === 'error') await expect(main).toContainText(state.lastError);
      else await expect(main).toContainText('Подписи и отправка ЭТрН клиентам подтверждены');
      assert.ok(await main.locator('.workflow-current').evaluate(node => node.scrollWidth <= node.clientWidth + 1), `${scenario} ${width}: status text horizontal overflow`);
      const accessibility = await new AxeBuilder({ page }).include('.trip-saby-panel').withTags(['wcag2a', 'wcag2aa']).analyze();
      const violations = accessibility.violations.map(item => item.id); assert.deepEqual(violations, []);
      report.axe.push({ scenario, width, violations }); report.checks.push(`${scenario}-${width}`);
      const shot = resolve(output, `${scenario}-${width}.png`); await main.screenshot({ path: shot }); report.screenshots.push(shot);
      if (scenario === 'waiting' && width === 1440) {
        const before = reads; await page.clock.fastForward(60_001); await expect.poll(() => reads).toBeGreaterThan(before);
        assert.equal(posts, 0); report.checks.push('waiting-polls-get-without-post');
      }
    }
  }
  assert.equal(posts, 0); assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  report.passed = true; console.log(JSON.stringify({ passed: true, mode, engine, checks: report.checks.length, axe: report.axe.length }));
} catch (error) {
  report.failure = error.message;
  await page?.screenshot({ path: resolve(output, 'failure.png') }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await runtime?.server.close(); await rt.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}

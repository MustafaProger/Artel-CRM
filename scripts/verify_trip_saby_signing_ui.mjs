// UI contract checks with synthetic HTTP signing responses and a temporary store.
// No real Saby action, signature, shipment or account is used by this script.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { SabyClient } from '../server/saby-client.ts';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { startTripsQaServer } from './qa-trips-runtime.mjs';

const root = resolve(import.meta.dirname, '..'), useWebkit = process.env.QA_WEBKIT === '1';
const output = resolve(root, 'qa', `trip-saby-signing-${useWebkit ? 'webkit' : 'chromium'}`);
await mkdir(output, { recursive: true });
const rt = await integrationRuntime();
const report = { syntheticSigningResponses: true, workingStoreAccessed: false, realSabyRequests: 0, checks: [], errors: [], externalRequests: [], screenshots: [] };
const check = value => { report.checks.push(value); console.log('PASS', value); };
const workflowPath = `/api/shipment-trips/${rt.tripId}/saby-workflow`;
const initial = () => ({
  status: 'not_sent', phase: 'awaiting_carrier', ready: true, blockers: [], locked: true,
  updatedAt: '2026-10-06T10:00:00Z', lastError: null, deliveries: [], carrierConfirmed: false,
  lastCheckedAt: '2026-10-06T10:00:00Z', lastCheckAttemptAt: null,
  monitoring: { enabled: true, intervalSeconds: 300 }, history: [], loadingFacts: null,
  order: { id: 'synthetic-order-only', number: 'QA-41', date: '2026-10-06', status: 'draft', url: null, revision: 'revision-1', remoteStatus: 'Черновик', signatureStatus: 'not_signed', exchangeStage: 'sender_action_required' },
});
const signing = state => ({ state: state === 'unknown' ? 'unknown' : 'active', requestedAt: '2026-10-06T10:00:00Z', sender: { state }, carrier: { state: 'not_started' } });
let workflow = initial(), diagnosticError = false, starts = [], diagnostics = 0, workflowReads = 0, startMode = 'success', releaseStart = () => {};
let delayWorkflowRead = false, delayedWorkflowRead = false, releaseWorkflowRead = () => {};
let reconciles = 0, advanceOnReconcile = false;
const preview = () => ({
  order: { id: workflow.order.id, number: workflow.order.number, date: workflow.order.date, revision: workflow.order.revision },
  previewToken: `synthetic-${workflow.order.revision}`, ready: true, blockers: [], checkedAt: '2026-10-06T10:00:00Z',
  sender: { organization: 'АРТЕЛЬ', signatures: [{ id: 'synthetic-sender-1', owner: 'Первый тестовый владелец', expiresAt: '2027-08-01' }, { id: 'synthetic-sender-2', owner: 'Другой тестовый владелец', expiresAt: '2027-09-01' }] },
  carrier: { organization: 'НК АРТЕЛЬ', signatures: [{ id: 'synthetic-carrier', owner: 'Тестовый владелец НК', expiresAt: '2027-08-07 21:46:48 UTC' }] },
  ...(workflow.signing ? { signing: workflow.signing } : {}),
});
let runtime, browser, page;
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory: rt.snapshotDirectory, operationsDirectory: resolve(rt.directory, 'store'), sabyClient: new SabyClient(integrationConfig(), async () => { throw new Error('Real Saby calls are forbidden by this test'); }) });
  const { base } = runtime, { cookie } = await bootstrapQaAuth(base);
  browser = useWebkit ? await webkit.launch({ headless: true }) : await chromium.launch({ headless: true, executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1050 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { report.externalRequests.push(url.href); return route.abort(); }
    const json = (value, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(value) });
    if (url.pathname === workflowPath && request.method() === 'GET') {
      workflowReads++;
      if (delayWorkflowRead) {
        delayWorkflowRead = false; delayedWorkflowRead = true;
        const saved = structuredClone(workflow);
        await new Promise(resolve => { releaseWorkflowRead = resolve; });
        return json(saved);
      }
      return json(workflow);
    }
    if (url.pathname === workflowPath && request.method() === 'POST') {
      reconciles++;
      assert.deepEqual(request.postDataJSON(), {});
      if (!workflow.signing) return json({ error: 'Unexpected reconciliation without a saved signing task' }, 409);
      if (advanceOnReconcile) { workflow.signing.sender.state = 'confirmed'; workflow.signing.carrier.state = 'waiting'; advanceOnReconcile = false; }
      return json(workflow);
    }
    if (url.pathname === `${workflowPath}/signing` && request.method() === 'GET') { diagnostics++; return diagnosticError ? json({ error: 'Синтетическая ошибка чтения Saby' }, 502) : json(preview()); }
    if (url.pathname === `${workflowPath}/signing/start` && request.method() === 'POST') {
      starts.push(request.postDataJSON());
      if (startMode === 'lost-saved') { workflow.signing = signing('unknown'); return route.abort('failed'); }
      if (startMode === 'lost-unresolved') return route.abort('failed');
      await new Promise(resolve => { releaseStart = resolve; });
      workflow.signing = signing('waiting');
      return json(workflow);
    }
    if (url.pathname === `/api/shipment-trips/${rt.tripId}/etrn`) return json({ deliveries: [] });
    if (url.pathname === `/api/shipment-trips/${rt.tripId}/saby`) return json({ saby: { documents: [] } });
    return route.continue();
  });
  await authenticateContext(context, base, cookie);
  page = await context.newPage();
  page.on('pageerror', reason => report.errors.push(reason.message));
  await page.clock.install();
  const panel = page.getByRole('region', { name: 'Подписание заявки', exact: true });
  const main = page.getByRole('region', { name: 'Документы рейса в Saby', exact: true });
  const open = async () => {
    await page.goto(base + '/#trips');
    await page.getByRole('button', { name: 'Saby', exact: true }).click();
    await expect(panel).toBeVisible();
  };
  const diagnose = async () => {
    await panel.getByRole('button', { name: /Проверить доступные подписи|Проверить подписи заново/ }).click();
    await expect(panel.getByRole('combobox', { name: 'Подпись АРТЕЛЬ', exact: true })).toBeEnabled();
    await panel.getByRole('combobox', { name: 'Подпись АРТЕЛЬ', exact: true }).selectOption('synthetic-sender-1');
    await expect(panel.getByRole('combobox', { name: 'Подпись НК АРТЕЛЬ', exact: true })).toHaveValue('synthetic-carrier');
  };
  const consent = () => panel.getByRole('checkbox', { name: /Подтверждаю подписание и отправку/ });
  const launch = () => panel.getByRole('button', { name: 'Подписать и продолжить обмен', exact: true });
  const refresh = async () => {
    const count = workflowReads;
    const documents = page.waitForResponse(response => new URL(response.url()).pathname === `/api/shipment-trips/${rt.tripId}/etrn`);
    await expect.poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      return workflowReads;
    }).toBeGreaterThan(count);
    await (await documents).finished();
    await page.clock.runFor(100);
  };
  const shot = async name => { const path = resolve(output, `${name}.png`); await panel.screenshot({ path }); report.screenshots.push(path); };

  await open();
  assert.equal(starts.length, 0); assert.equal(diagnostics, 0); assert.equal(reconciles, 0);
  await expect(panel).toContainText('Заявка № QA-41 от 06.10.2026');
  check('Opening the selected order does not inspect signatures or send a signing request');
  await diagnose();
  await expect(panel).toContainText('Тестовый владелец НК · действует до 08.08.2027');
  check('Signature expiry crosses UTC midnight into the same Moscow date shown by Saby');
  await expect(launch()).toBeDisabled(); await expect(consent()).not.toBeChecked();
  await consent().check(); await expect(launch()).toBeEnabled();
  await panel.getByRole('combobox', { name: 'Подпись АРТЕЛЬ', exact: true }).selectOption('synthetic-sender-2');
  await expect(consent()).not.toBeChecked(); await expect(launch()).toBeDisabled();
  await panel.getByRole('combobox', { name: 'Подпись АРТЕЛЬ', exact: true }).selectOption('synthetic-sender-1');
  check('Both organizations have visible signature choices; consent names the exact order and resets after a choice changes');

  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1050 });
    assert.ok(await panel.evaluate(node => node.scrollWidth <= node.clientWidth + 1), `Signing panel fits ${width}: ${JSON.stringify(await panel.evaluate(node => ({ width: node.clientWidth, scroll: node.scrollWidth, overflow: [...node.querySelectorAll('*')].filter(child => child.getBoundingClientRect().right > node.getBoundingClientRect().right + 1).map(child => ({ tag: child.tagName, className: child.className, width: child.getBoundingClientRect().width, text: child.textContent.slice(0, 80) })) })))}`);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Page fits ${width}`);
    await shot(`confirmation-${width}`);
  }
  const accessibility = await new AxeBuilder({ page }).include('.workflow-signing').withTags(['wcag2a', 'wcag2aa']).analyze();
  assert.deepEqual(accessibility.violations.map(({ id }) => id), []);
  check('Confirmation fits 320, 390, 768 and 1440 px and passes targeted accessibility checks');

  await consent().check(); workflow.order.revision = 'revision-2'; await refresh();
  await expect(panel).toContainText('Заявка изменилась после проверки');
  await expect(launch()).toBeDisabled(); await expect(consent()).not.toBeChecked();
  await diagnose(); await consent().check();
  check('A new document revision invalidates the old preview and its consent');

  delayWorkflowRead = true;
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(() => delayedWorkflowRead).toBe(true);
  await launch().evaluate(button => { button.click(); button.click(); });
  await expect.poll(() => starts.length).toBe(1); await expect(launch()).toBeDisabled();
  releaseStart();
  await expect(panel).toContainText('Запуск сохранён.');
  releaseWorkflowRead(); await page.clock.runFor(100);
  await expect(panel).toContainText('Запуск сохранён.');
  await expect(main.getByRole('button', { name: 'Заполнить водителя и машину', exact: true })).toHaveCount(0);
  assert.deepEqual(Object.keys(starts[0]).sort(), ['carrierSignatureId', 'confirmed', 'previewToken', 'requestId', 'senderSignatureId']);
  assert.equal(starts[0].confirmed, true); assert.equal(starts[0].previewToken, 'synthetic-revision-2');
  assert.equal(starts[0].senderSignatureId, 'synthetic-sender-1'); assert.equal(starts[0].carrierSignatureId, 'synthetic-carrier');
  assert.match(starts[0].requestId, /^[0-9a-f-]{36}$/);
  await expect(launch()).toHaveCount(0);
  const reads = workflowReads; await page.clock.fastForward(300_001);
  await expect.poll(() => workflowReads).toBeGreaterThan(reads); assert.equal(starts.length, 1); assert.equal(reconciles, 0);
  await expect(panel).toContainText('Может потребоваться подтверждение владельца');
  await expect(main.locator('.workflow-current strong')).toContainText('АРТЕЛЬ · ожидаем подпись');
  await shot('sender-waiting');
  check('Double click sends one idempotent launch; polling only reads and waiting is not shown as signed');
  check('A delayed pre-launch workflow GET cannot remove the saved signing task or restore competing manual filling');

  advanceOnReconcile = true;
  await panel.getByRole('button', { name: 'Сверить состояние подписания', exact: true }).click();
  await expect(main.locator('.workflow-current strong')).toContainText('НК АРТЕЛЬ · ожидаем подпись');
  assert.equal(reconciles, 1); assert.equal(starts.length, 1);
  check('Explicit reconciliation uses the existing workflow POST and displays its fresh result without launching another signing task');
  workflow.signing.state = 'completed'; workflow.signing.carrier.state = 'confirmed'; workflow.carrierConfirmed = true; workflow.phase = 'awaiting_loading';
  await refresh(); await expect(panel).toContainText('Подписание обеих сторон подтверждено.');
  await expect(main.getByRole('heading', { name: 'Фактическая погрузка' })).toBeVisible();
  check('Sender and carrier evidence are displayed separately; only completion opens the actual-loading step');

  workflow = initial(); startMode = 'lost-saved'; await page.reload(); await page.getByRole('button', { name: 'Saby', exact: true }).click();
  await diagnose(); await consent().check(); const priorDiagnostics = diagnostics; await launch().click();
  await expect(panel).toContainText('Сверяем результат подписания');
  await expect.poll(() => diagnostics).toBeGreaterThan(priorDiagnostics);
  await expect(launch()).toHaveCount(0); assert.equal(starts.length, 2); assert.equal(reconciles, 1);
  await panel.getByRole('button', { name: 'Сверить состояние подписания', exact: true }).click();
  await expect.poll(() => reconciles).toBe(2); assert.equal(starts.length, 2);
  check('A lost launch response is followed by read-back and an existing unknown task cannot be resent');

  workflow = initial(); startMode = 'lost-unresolved'; await page.reload(); await page.getByRole('button', { name: 'Saby', exact: true }).click();
  await diagnose(); await consent().check(); await launch().click();
  await expect(panel).toContainText('Результат запуска пока неизвестен.');
  await expect(launch()).toBeDisabled(); assert.equal(starts.length, 3);
  await panel.getByRole('button', { name: 'Сверить состояние подписания', exact: true }).click();
  await expect(launch()).toBeDisabled(); assert.equal(starts.length, 3); assert.equal(reconciles, 2);
  await shot('unknown-without-evidence');
  check('An unresolved lost response stays blocked even if read-back cannot find a saved launch');

  workflow = initial(); await page.reload(); await page.getByRole('button', { name: 'Saby', exact: true }).click();
  await diagnose(); await consent().check(); diagnosticError = true;
  await panel.getByRole('button', { name: 'Проверить подписи заново', exact: true }).click();
  await expect(panel).toContainText('Синтетическая ошибка чтения Saby'); await expect(launch()).toHaveCount(0);
  assert.equal(starts.length, 3); assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []);
  check('Failed diagnostics discard old approval and expose a readable error without any further signing request');
} catch (reason) {
  report.failure = reason.message;
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: false }).catch(() => {});
  throw reason;
} finally {
  releaseStart(); releaseWorkflowRead();
  await browser?.close(); await runtime?.server.close(); await rt.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}

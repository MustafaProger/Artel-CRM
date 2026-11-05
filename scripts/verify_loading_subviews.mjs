// Supplemental loading branches: actual UI controls, deterministic API/chunk gates, disposable data.
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import { instrument, advanceFrames, screenshot, feedbackRegressions } from './loading-sequence-probe.mjs';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const root = process.cwd(), output = resolve(process.env.ARTEL_SEQUENCE_OUTPUT || '../reaudit-20261105/subview-evidence');
for (const key of Object.keys(process.env)) if (/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key)) delete process.env[key];
Object.assign(process.env, { ARTEL_OPERATOR_QA_BUILT: '1', SABY_WORKFLOW_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_GEOCODER_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false' });
const report = { passed: false, cases: [], errors: [], consoleErrors: [], externalRequests: [], limitations: ['Sber connection is selected through its actual card: BankingPage has no persisted/URL-selected connection in this version.', 'Trip map is checked with synthetic empty requests and no depots; live map tiles/geocoding/provider behavior are excluded.', 'Subview observation begins after explicit tab selection; the prior requests placeholder belongs to a different user-selected view.'] };
const tmp = await mkdtemp(resolve(tmpdir(), 'artel-loading-subviews-')); await mkdir(output, { recursive: true });
const originalFetch = globalThis.fetch; globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') { report.externalRequests.push(url.origin); return Promise.reject(new Error('External forbidden')); } return originalFetch(input, init); };
const expect = baseExpect.configure({ timeout: 20000 });
const deferred = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };
const fixture = { integration: { status: 'read_only', message: 'Синтетический обработчик', checkedAt: '2026-11-05T12:00:00Z' }, invoiceProfiles: [], invoiceCreation: { mode: 'live', connections: [] }, canPrepare: false, organizations: [], buyers: [], connections: [], defaultUnitPrice: '79', settings: { defaultUnitPrice: '79', revision: 1, updatedAt: null, updatedBy: null }, product: { name: 'Учебное топливо', unit: 'л', vatRate: '22', vatMode: 'included' }, canCreate: false, canEditDefaultPrice: false, history: { status: 'ready', items: [] } };
let runtime, browser, context;
try {
  const snapshotDirectory = resolve(tmp, 'snapshot'); await writeTripsQaSnapshot(snapshotDirectory); runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory: resolve(tmp, 'store') }); report.artifacts = runtime.artifacts; const auth = await runtime.bootstrap();
  for (const engine of ['chromium', 'webkit']) {
    browser = await ({ chromium, webkit })[engine].launch();
    for (const width of [1440, 375]) for (const scenario of ['sber', 'trip-process', 'trip-trips', 'trip-map', 'invoice-settings']) {
      const name = `${engine}-${width}-${scenario}`, dir = resolve(output, name); await mkdir(dir, { recursive: true });
      context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', recordVideo: { dir, size: { width, height: 1000 } } }); await authenticateContext(context, runtime.base, auth.cookie); await context.addInitScript(instrument, { motion: 'reduce' });
      const apiGate = deferred(), chunkGate = deferred(), requests = [], screenshots = []; let armed = scenario !== 'sber';
      const page = await context.newPage(), video = page.video(); page.on('pageerror', error => report.errors.push({ name, message: error.message })); page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ name, message: message.text() }); });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url()); if (url.origin !== runtime.base) { report.externalRequests.push({ name, origin: url.origin }); return route.abort(); }
        let gate, kind;
        if (armed && request.method() === 'GET' && (scenario === 'sber' ? url.pathname === '/api/banking/sber/sber-nk-artel/statements' : scenario === 'invoice-settings' ? url.pathname === '/api/invoices' : ['/api/shipment-trips', '/api/trip-requests'].includes(url.pathname))) { gate = apiGate; kind = 'api'; }
        if (armed && scenario === 'trip-map' && url.pathname.startsWith('/assets/TripRequestsMap-') && url.pathname.endsWith('.js')) { gate = chunkGate; kind = 'chunk'; }
        if (gate) { const entry = { path: url.pathname, kind, requestedAt: Date.now() }; requests.push(entry); await gate.promise; entry.releasedAt = Date.now(); }
        if (url.pathname === '/api/invoices' && request.method() === 'GET') return route.fulfill({ json: fixture });
        return route.continue();
      });
      try {
        if (scenario === 'sber') {
          await page.goto(runtime.base + '/#payments'); const bank = page.getByRole('button', { name: 'Открыть СберБизнес — НК АРТЭЛЬ', exact: true }); await expect(bank).toBeVisible(); await expect.poll(() => page.evaluate(() => window.__loadingSequence.visibleSkeletonCount())).toBe(0); armed = true;
          await bank.click(); await expect(page.locator('.sber-statements')).toBeVisible();
        } else if (scenario.startsWith('trip-')) {
          await page.goto(runtime.base + '/#trips'); const title = { 'trip-process': 'В процессе', 'trip-trips': 'Рейсы', 'trip-map': 'Карта' }[scenario]; await page.locator('.trips-section-tabs').getByRole('button', { name: title, exact: true }).click();
        } else { await page.goto(runtime.base + '/#invoices'); await expect(page.locator('.invoice-workspace')).toBeVisible(); }
        await page.evaluate(name => window.__loadingSequence.start(name), name); await advanceFrames(page);
        let settingsDisabled;
        if (scenario === 'invoice-settings') { const settings = page.getByRole('button', { name: 'Настройки счетов', exact: true }); settingsDisabled = await settings.isDisabled(); if (!settingsDisabled) await settings.click(); }
        await advanceFrames(page); screenshots.push(await screenshot(page, resolve(dir, '01-api-held.png'), 'Subview selected; data held'));
        apiGate.release(); await advanceFrames(page, 30); screenshots.push(await screenshot(page, resolve(dir, '02-chunk-held.png'), 'Data ready; optional map chunk held'));
        chunkGate.release(); await expect.poll(() => page.evaluate(() => window.__loadingSequence.visibleSkeletonCount())).toBe(0); await advanceFrames(page, 30); screenshots.push(await screenshot(page, resolve(dir, '03-ready.png'), 'Subview ready'));
        if (scenario === 'invoice-settings') { if (settingsDisabled) await page.getByRole('button', { name: 'Настройки счетов', exact: true }).click(); await expect(page.locator('.invoice-settings-dialog[open]')).toBeVisible(); screenshots.push(await screenshot(page, resolve(dir, '04-settings-ready.png'), 'Settings available after data')); }
        const trace = await page.evaluate(() => window.__loadingSequence.stop()), nodes = new Set(trace.frames.flatMap(f => f.skeletons.map(s => s.node))), shapes = new Set(trace.frames.flatMap(f => f.skeletons.map(s => s.shapeKey))), max = Math.max(0, ...trace.frames.map(f => f.skeletons.length)), issues = [];
        const feedback = feedbackRegressions(trace.frames); if (feedback.neutralAfterSkeletonFrames.length) issues.push('neutral-loading-after-skeleton'); if (feedback.simultaneousFeedbackFrames.length) issues.push('simultaneous-neutral-and-skeleton'); if (feedback.skeletonEpisodes > 1) issues.push('skeleton-reappeared');
        if (max > 1) issues.push('simultaneous-skeletons'); if (nodes.size > 1) issues.push('skeleton-remounted'); if (shapes.size > 1) issues.push('skeleton-shape-changed'); if (trace.frames.some(f => f.documentWidth > width + 1)) issues.push('horizontal-overflow');
        await writeFile(resolve(dir, 'trace.json'), JSON.stringify(trace)); await context.close(); context = null;
        const row = { name, engine, width, scenario, feedback, frames: trace.frames.length, nodes: nodes.size, shapes: shapes.size, maxSkeletons: max, issues, settingsDisabled, requests, screenshots, video: name + '/' + (await video.path()).split('/').at(-1) }; report.cases.push(row); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ name, issues, maxSkeletons: max, nodes: nodes.size, settingsDisabled }));
      } finally { apiGate.release(); chunkGate.release(); await context?.close(); context = null; }
    }
    await browser.close(); browser = null;
  }
  report.completed = true; report.passed = report.cases.every(c => !c.issues.length) && !report.errors.length && !report.consoleErrors.length && !report.externalRequests.length; report.summary = { cases: report.cases.length, frames: report.cases.reduce((n,c) => n + c.frames,0), withIssues: report.cases.filter(c => c.issues.length).length };
} catch (error) { report.failure = { message: error.message, stack: error.stack }; throw error; }
finally { await context?.close(); await browser?.close(); await runtime?.server.close(); globalThis.fetch = originalFetch; await rm(tmp, { recursive: true, force: true }); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ passed: report.passed, summary: report.summary, failure: report.failure })); }

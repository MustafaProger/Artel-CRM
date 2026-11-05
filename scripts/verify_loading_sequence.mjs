// Frame-by-frame loading sequence QA: disposable data, isolated runtimes, blocked providers.
import { instrument, advanceFrames, screenshot as captureScreenshot, feedbackRegressions } from './loading-sequence-probe.mjs';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
const root = resolve(process.env.ARTEL_SEQUENCE_ROOT || process.cwd());
const output = resolve(process.env.ARTEL_SEQUENCE_OUTPUT || resolve(root, '../reaudit-20261105/after'));
const engines = (process.env.ARTEL_SEQUENCE_ENGINES || 'chromium,webkit').split(',');
const widths = (process.env.ARTEL_SEQUENCE_WIDTHS || '1440,375').split(',').map(Number);
const chosen = process.env.ARTEL_SEQUENCE_ROUTES?.split(',');
const motion = process.env.ARTEL_SEQUENCE_MOTION || 'reduce';
const capture = process.env.ARTEL_SEQUENCE_CAPTURE || 'full-page';
const populated = process.env.ARTEL_SEQUENCE_POPULATED === '1';
const screenshot = (page, path, stage) => captureScreenshot(page, path, stage, { fullPage: capture === 'full-page' });
const navigationModes = (process.env.ARTEL_SEQUENCE_MODES || 'cold,in-app').split(',');
const expect = baseExpect.configure({ timeout: 20000 });
for (const key of Object.keys(process.env)) if (/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key)) delete process.env[key];
Object.assign(process.env, { ARTEL_OPERATOR_QA_BUILT: '1', SABY_WORKFLOW_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_GEOCODER_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false' });
const { writeTripsQaSnapshot } = await import(pathToFileURL(resolve(root, 'scripts/qa-trips-runtime.mjs')));
const { startOperatorQaServer } = await import(pathToFileURL(resolve(root, 'scripts/qa-operator-runtime.mjs')));
const { authenticateContext } = await import(pathToFileURL(resolve(root, 'scripts/qa-auth.mjs')));
const { enabledPages } = await import(pathToFileURL(resolve(root, 'web/src/page-catalog.ts')));
const routes = enabledPages.filter(item => !chosen || chosen.includes(item.id));
const selectors = { documents: '.document-archive', overview: '.overview-page', work: '.work-page', shipments: '.shipments-workspace', trips: '.trips-page', payments: '.banking-page', 'cabinet-balances': '.cabinet-page', china: '.china-page', invoices: '.invoice-workspace', operator: '.operator-workspace', accounts: '.account-management', directories: '.directories-page' };
const chunks = { overview: 'OverviewPage-', work: 'WorkPage-', shipments: 'ShipmentsPage-', trips: 'TripsWorkspace-', payments: 'BankingPage-', 'cabinet-balances': 'CabinetBalances-', china: 'ChinaPage-', invoices: 'InvoicePage-', operator: 'OperatorPage-', accounts: 'AccountManagement-', directories: 'DirectoriesPage-', documents: 'DocumentsPage-' };
const primary = { overview: '/api/settlements', work: '/api/work', shipments: '/api/snapshot', trips: '/api/trip-requests/context', payments: '/api/snapshot', 'cabinet-balances': '/api/cabinets', china: '/api/china', invoices: '/api/invoices', operator: '/api/operator', accounts: '/api/snapshot', directories: '/api/snapshot', documents: '/api/documents' };
const secondary = { shipments: ['/api/shipments'], trips: ['/api/shipment-trips', '/api/trip-requests'], payments: ['/api/banking'], accounts: ['/api/auth/users'] };
const snapshotRoutes = new Set(['shipments', 'payments', 'accounts', 'directories']);
const invoiceFixture = { integration: { status: 'read_only', message: 'Синтетический обработчик счетов', checkedAt: '2026-11-05T12:00:00Z' }, invoiceProfiles: [], invoiceCreation: { mode: 'live', connections: [] }, canPrepare: false, organizations: [], buyers: [], connections: [], defaultUnitPrice: '79', settings: { defaultUnitPrice: '79', revision: 1, updatedAt: null, updatedBy: null }, product: { name: 'Учебное топливо', unit: 'л', vatRate: '22', vatMode: 'included' }, canCreate: false, canEditDefaultPrice: false, history: { status: 'ready', items: [] } };
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-loading-sequence-'));
await mkdir(output, { recursive: true });
const report = { passed: false, syntheticOnly: true, root, scope: { engines, widths, navigationModes, motion, capture, populated, routes: routes.map(item => item.id) }, cases: [], errors: [], consoleErrors: [], consoleErrorsRecorded: true, externalRequests: [], limitations: ['Screen recording has browser-native frame rate; DOM is sampled each requestAnimationFrame. Screenshot bounds identify the exact sampled-frame interval during capture.', 'Real provider operations and credentials are never used. Cold journeys use fresh browser contexts; in-app journeys use real sidebar navigation from a different loaded route.'] };
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') { report.externalRequests.push({ source: 'server', origin: url.origin }); return Promise.reject(new Error('External traffic forbidden')); } return originalFetch(input, init); };
let runtime, browser, context;
const deferred = () => { let release; const promise = new Promise(done => { release = done; }); return { promise, release }; };
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

try {
  const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store'); await writeTripsQaSnapshot(snapshotDirectory);
  runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory }); report.artifacts = runtime.artifacts;
  const auth = await runtime.bootstrap();
  let browserFixtures = {};
  if (populated) {
    const { seed } = await import('./loading-populated-fixtures.mjs'); const { seedExtras } = await import('./loading-populated-extras.mjs');
    const base = await seed(runtime, auth), extra = await seedExtras(runtime, auth); browserFixtures = { ...base.browserFixtures, ...extra.browserFixtures };
    report.population = { counts: { ...base.counts, ...extra.counts }, mutations: [...base.mutations, ...extra.mutations], mockedPaths: Object.keys(browserFixtures) };
  }
  for (const engine of engines) {
    browser = await ({ chromium, webkit })[engine].launch({ headless: true });
    for (const width of widths) for (const mode of navigationModes) for (const item of routes) {
      const name = `${engine}-${width}-${mode}-${item.id}`, directory = resolve(output, name); await mkdir(directory, { recursive: true });
      context = await browser.newContext({ viewport: { width, height: 1000 }, reducedMotion: motion, serviceWorkers: 'block', recordVideo: { dir: directory, size: { width, height: 1000 } } });
      await authenticateContext(context, runtime.base, auth.cookie); await context.addInitScript(instrument, { motion });
      let armed = false; const chunkGate = deferred(), primaryGate = deferred(), secondaryGate = deferred(), requests = [], screenshots = [];
      const page = await context.newPage(), video = page.video(); page.on('pageerror', error => report.errors.push({ name, message: error.message })); page.on('console', message => { if (message.type() === 'error') report.consoleErrors.push({ name, message: message.text() }); });
      await context.route('**/*', async route => {
        const request = route.request(), url = new URL(request.url());
        if (url.origin !== runtime.base) { report.externalRequests.push({ source: 'browser', name, origin: url.origin }); return route.abort(); }
        let gate = null, kind = null;
        if (armed && url.pathname.startsWith('/assets/') && url.pathname.includes(chunks[item.id]) && url.pathname.endsWith('.js')) { gate = chunkGate; kind = 'chunk'; }
        if (armed && request.method() === 'GET' && url.pathname === primary[item.id]) { gate = primaryGate; kind = 'primary'; }
        if (armed && request.method() === 'GET' && (secondary[item.id] || []).includes(url.pathname)) { gate = secondaryGate; kind = 'secondary'; }
        if (gate) { const row = { path: url.pathname, kind, requestedAt: Date.now() }; requests.push(row); await gate.promise; row.releasedAt = Date.now(); }
        if (request.method() === 'GET' && browserFixtures[url.pathname]) return route.fulfill({ json: browserFixtures[url.pathname] });
        if (url.pathname === '/api/invoices' && request.method() === 'GET') return route.fulfill({ json: invoiceFixture });
        return route.continue();
      });
      try {
        if (mode === 'in-app') {
          const start = item.id === 'overview' ? 'work' : 'overview'; await page.goto(runtime.base + '/#' + start); await expect(page.locator(selectors[start])).toBeVisible(); await expect.poll(() => page.evaluate(() => window.__loadingSequence.visibleSkeletonCount())).toBe(0);
          armed = true; await page.evaluate(name => window.__loadingSequence.start(name), name);
          if (await page.locator('.sidebar').evaluate(el => el.inert)) await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
          await page.locator('.sidebar nav').getByRole('button', { name: item.title, exact: true }).click();
        } else { armed = true; await page.goto(`${runtime.base}/?sequenceCold=${name}#${item.id}`); }
        await expect.poll(() => requests.some(row => row.kind === 'chunk' || row.kind === 'primary')).toBe(true);
        await advanceFrames(page); screenshots.push(await screenshot(page, resolve(directory, '01-dependencies-held.png'), 'initial: chunk and API held'));
        if (snapshotRoutes.has(item.id)) primaryGate.release(); else chunkGate.release();
        await advanceFrames(page, 30); screenshots.push(await screenshot(page, resolve(directory, '02-first-dependency.png'), snapshotRoutes.has(item.id) ? 'snapshot released; route chunk held' : 'route chunk released; primary API held'));
        if (snapshotRoutes.has(item.id)) chunkGate.release(); else primaryGate.release();
        await advanceFrames(page, 30); screenshots.push(await screenshot(page, resolve(directory, '03-secondary-held.png'), 'route + primary ready; secondary API held'));
        secondaryGate.release();
        await expect(page.locator(selectors[item.id])).toBeVisible(); await expect.poll(() => page.evaluate(() => window.__loadingSequence.visibleSkeletonCount())).toBe(0); await advanceFrames(page);
        screenshots.push(await screenshot(page, resolve(directory, '04-content-ready.png'), 'content ready'));
        const trace = await page.evaluate(() => window.__loadingSequence.stop());
        const activeFrames = trace.frames.filter(frame => frame.hash === '#' + item.id);
        const uniqueShapes = [...new Set(activeFrames.flatMap(frame => frame.skeletons.map(skeleton => skeleton.shapeKey)))];
        const nodes = [...new Set(activeFrames.flatMap(frame => frame.skeletons.map(skeleton => skeleton.node)))];
        const maxSkeletons = Math.max(0, ...activeFrames.map(frame => frame.skeletons.length));
        const maxViewportSkeletons = Math.max(0, ...activeFrames.map(frame => frame.skeletons.filter(item => item.inViewport).length));
        const feedback = feedbackRegressions(activeFrames);
        const issues = [];
        if (feedback.neutralAfterSkeletonFrames.length) issues.push('neutral-loading-after-skeleton');
        if (feedback.simultaneousFeedbackFrames.length) issues.push('simultaneous-neutral-and-skeleton');
        if (feedback.skeletonEpisodes > 1) issues.push('skeleton-reappeared');
        let chinaGeometry;
        if (item.id === 'china') {
          const loading = screenshots.find(shot => shot.regions.china.skeleton)?.regions.china;
          const ready = [...screenshots].reverse().find(shot => shot.regions.china.content)?.regions.china;
          chinaGeometry = { loading, ready };
          if (!loading || !ready) issues.push('china-geometry-markers-missing');
          else {
            if (Math.abs(loading.skeleton.width - ready.content.width) > 1 || Math.abs(loading.skeletonScroll.scrollWidth - ready.contentScroll.scrollWidth) > 1) issues.push('china-table-width-mismatch');
            if (ready.visibleContentColumns === 4 && loading.visibleSkeletonColumns !== 4) issues.push('china-skeleton-columns-clipped');
          }
        }
        if (!screenshots[0].skeletons?.length && !screenshots[0].statuses?.length) issues.push('initial-loading-feedback-missing');
        if (maxSkeletons > 1) issues.push('simultaneous-page-skeletons');
        if (uniqueShapes.length > 1) issues.push('skeleton-shape-changed');
        if (nodes.length > 1) issues.push('skeleton-remounted');
        if (activeFrames.some(frame => frame.documentWidth > width + 1)) issues.push('horizontal-overflow');
        const result = { name, engine, width, mode, motion, route: item.id, title: item.title, feedback, chinaGeometry, frames: trace.frames.length, transitions: trace.transitions.length, maxSkeletons, maxViewportSkeletons, skeletonNodes: nodes.length, skeletonShapes: uniqueShapes.length, issues, requests, screenshots, traceFile: name + '/trace.json', video: null };
        await writeFile(resolve(directory, 'trace.json'), JSON.stringify(trace));
        await context.close(); context = null; result.video = name + '/' + (await video.path()).split('/').at(-1); report.cases.push(result);
        await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify({ name, frames: result.frames, issues, maxSkeletons, shapes: uniqueShapes.length, nodes: nodes.length }));
      } finally { chunkGate.release(); primaryGate.release(); secondaryGate.release(); await context?.close(); context = null; }
    }
    await browser.close(); browser = null;
  }
  report.completed = true; report.passed = report.cases.every(item => item.issues.length === 0) && report.errors.length === 0 && report.consoleErrors.length === 0 && report.externalRequests.length === 0;
  report.summary = { journeys: report.cases.length, animationFrames: report.cases.reduce((sum, item) => sum + item.frames, 0), journeysWithIssues: report.cases.filter(item => item.issues.length).length, multipleSkeletonJourneys: report.cases.filter(item => item.maxSkeletons > 1).length, shapeChangeJourneys: report.cases.filter(item => item.skeletonShapes > 1).length, repeatedNodeJourneys: report.cases.filter(item => item.skeletonNodes > 1).length, maxSimultaneousSkeletons: Math.max(0, ...report.cases.map(item => item.maxSkeletons)), neutralReturnJourneys: report.cases.filter(item => item.feedback.neutralAfterSkeletonFrames.length).length, dualFeedbackJourneys: report.cases.filter(item => item.feedback.simultaneousFeedbackFrames.length).length, overflowJourneys: report.cases.filter(item => item.issues.includes('horizontal-overflow')).length, javascriptErrors: report.errors.length, consoleErrors: report.consoleErrors.length, externalRequests: report.externalRequests.length };
} catch (error) { report.failure = { message: error.message, stack: error.stack }; throw error; }
finally {
  await context?.close(); await browser?.close(); await runtime?.server.close(); globalThis.fetch = originalFetch; await rm(temporary, { recursive: true, force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  const html = `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Последовательность загрузки — покадровый аудит</title><style>body{font:15px system-ui;margin:24px;color:#17271f;background:#f4f5f4}header{margin-bottom:32px}section{background:white;padding:20px;border-radius:16px;margin-bottom:24px}h2{font-size:19px}.frames{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:12px}img{display:block;width:100%;border:1px solid #ddd}figure{margin:0}figcaption{margin-top:8px;font-size:12px}.bad{color:#a22}.good{color:#176849}summary{cursor:pointer}video{max-width:100%;max-height:650px}</style><header><h1>Последовательность загрузки</h1><p>Кадры реального браузера; отдельное покадровое DOM-наблюдение и видео каждого перехода. Вымышленные данные.</p><pre>${escapeHtml(JSON.stringify(report.summary || {}, null, 2))}</pre></header>${report.cases.map(item => `<section><h2>${escapeHtml(item.name)} — ${escapeHtml(item.title)}</h2><p class="${item.issues.length ? 'bad' : 'good'}">${escapeHtml(item.issues.join(', ') || 'Одна стабильная форма скелета, без повторного монтирования')} · кадров ${item.frames} · одновременно ${item.maxSkeletons} · форм ${item.skeletonShapes} · узлов ${item.skeletonNodes}</p><div class="frames">${item.screenshots.map(shot => `<figure><a href="${item.name}/${shot.file}"><img loading="lazy" src="${item.name}/${shot.file}"></a><figcaption>${escapeHtml(shot.stage)}<br>DOM кадры ${shot.frameBefore}–${shot.frameAfter}; ${shot.timeBefore}–${shot.timeAfter} мс</figcaption></figure>`).join('')}</div><p><a href="${item.traceFile}">Покадровой JSON</a></p><details><summary>Видео перехода</summary><video controls preload="none" src="${item.video}"></video></details></section>`).join('')}</html>`;
  await writeFile(resolve(output, 'contact-sheet.html'), html); console.log(JSON.stringify({ passed: report.passed, completed: report.completed, summary: report.summary, report: resolve(output, 'report.json') }));
}

// Synthetic CRM users, mocked invoice worker, isolated temporary store. No 1C or production writes.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect as baseExpect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const expect = baseExpect.configure({ timeout: 15000 });

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-invoices-ui-'));
const output = process.env.ARTEL_INVOICES_QA_OUTPUT || resolve(temporary, 'evidence');
await mkdir(output, { recursive: true });
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await writeTripsQaSnapshot(snapshotDirectory);
const runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
const admin = await runtime.bootstrap();
async function api(path, method = 'GET', body, cookie = admin.cookie) {
  const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: runtime.base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify({ path, status: response.status, error: result.error })); return result;
}
const manager = (await api('/api/directories', 'POST', { kind: 'managers', name: 'Учебный сотрудник счетов' })).entry;
const password = randomUUID();
await api('/api/auth/users', 'POST', { name: 'Учебный сотрудник счетов', login: 'invoices.qa', password, role: 'employee', managerId: manager.id, sections: ['invoices', 'operator', 'work'] });
const login = await fetch(runtime.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: runtime.base }, body: JSON.stringify({ login: 'invoices.qa', password }) });
assert.ok(login.ok); const cookie = login.headers.get('set-cookie').split(';')[0], user = (await login.json()).user;
const otherManager = (await api('/api/directories', 'POST', { kind: 'managers', name: 'Другой учебный сотрудник счетов' })).entry;
const otherPassword = randomUUID();
await api('/api/auth/users', 'POST', { name: 'Другой учебный сотрудник счетов', login: 'invoices.other.qa', password: otherPassword, role: 'employee', managerId: otherManager.id, sections: ['invoices'] });
const otherLogin = await fetch(runtime.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: runtime.base }, body: JSON.stringify({ login: 'invoices.other.qa', password: otherPassword }) });
assert.ok(otherLogin.ok); const otherCookie = otherLogin.headers.get('set-cookie').split(';')[0], otherUser = (await otherLogin.json()).user;
const connectionId = 'qa-connection', organizationId = 'qa-seller', buyerId = 'qa-buyer';
const profile = { revision: 'qa-v1', sourceNumber: 'QA-1', sourceDate: '2026-10-20', observedAt: '2026-10-20T08:00:00Z', organizationId, connectionId, organizationName: 'Учебный продавец', productName: 'Предоплата за дизельное топливо', unit: 'л', currency: 'RUB', vatRate: '22', vatMode: 'included', sampleUnitPrice: '79', bankLabel: 'Учебный банк', bankDiffersFromDefault: false, postedAsSample: true, qr: false, productSelectionStatus: 'ready' };
function fixture() { return { integration: { status: 'configured', message: 'Синтетические справочники', checkedAt: profile.observedAt }, invoiceProfiles: [profile], invoiceCreation: { mode: 'live', connections: [{ connectionId, ready: true, checking: false, blockers: [] }] }, canPrepare: true, organizations: [{ id: organizationId, name: profile.organizationName, connectionId }], buyers: [{ id: buyerId, name: 'Учебный покупатель', inn: '0000000000', connectionId }], connections: [{ id: connectionId, baseId: null, baseLabel: 'Учебная база', status: 'ready', checkedAt: profile.observedAt, counts: { organizations: 1, buyers: 1 } }], defaultUnitPrice: '79', settings: { defaultUnitPrice: '79', revision: 1, updatedAt: null, updatedBy: null }, product: { name: profile.productName, unit: 'л', vatRate: '22', vatMode: 'included' }, canCreate: true, canEditDefaultPrice: true, history: { status: 'ready', items: [] } }; }
function job(input, changes = {}) { return { id: randomUUID(), status: 'processing', workflowState: 'creating', amount: input.amount, unitPrice: input.unitPrice, organizationName: profile.organizationName, buyerName: 'Учебный покупатель', createdAt: profile.observedAt, fileAvailable: false, quantity: { display: '113.924', numerator: '9000', denominator: '79', exact: false }, ...changes }; }
const pendingKey = input => `artel:crm:invoice-pending:${encodeURIComponent(user.id)}:${input.idempotencyKey}`;
const input = (key = randomUUID()) => ({ organizationId, buyerId, amount: '9000', unitPrice: '79', idempotencyKey: key, connectionId, profileRevision: profile.revision });
const report = { synthetic: true, checks: [], geometry: [], axe: [], screenshots: [], errors: [] };
const check = label => { report.checks.push(label); console.log('PASS', label); };
let browser;
try {
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]].filter(([name]) => !process.env.ARTEL_INVOICES_QA_ENGINE || name === process.env.ARTEL_INVOICES_QA_ENGINE)) {
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await context.addInitScript(() => {
      const current = { endpoint: 'https://push.synthetic.test/device', options: { applicationServerKey: new Uint8Array(65).fill(1).buffer }, toJSON: () => ({ endpoint: 'https://push.synthetic.test/device', keys: { p256dh: 'synthetic-key', auth: 'synthetic-auth' } }), unsubscribe: async () => true };
      const worker = { pushManager: { getSubscription: async () => current, subscribe: async () => current } };
      if (!('PushManager' in window)) Object.defineProperty(window, 'PushManager', { value: class {} });
      if (!('Notification' in window)) Object.defineProperty(window, 'Notification', { value: { permission: 'granted', requestPermission: async () => 'granted' } });
      else Object.defineProperty(Notification, 'permission', { configurable: true, get: () => 'granted' });
      Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: async () => worker });
      Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, value: Promise.resolve(worker) });
    });
    await authenticateContext(context, runtime.base, cookie);
    let expectedOwner = user.id;
    let state = fixture(), responseMode = 'accepted', workspaceMode = 'ready', releaseGet, releasePost, posts = [], pushPosts = [], calls = [], fileReads = 0;
    const json = (route, body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    await context.route('**/*', async route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== runtime.base) return route.abort();
      if (url.pathname.startsWith('/api/push/')) {
        if (url.pathname === '/api/push/subscription' && request.method() === 'POST') {
          assert.equal(request.headers()['x-artel-account'], expectedOwner);
          const body = request.postDataJSON(); pushPosts.push(body);
          return json(route, body.explicit ? { ok: true } : { error: 'Подтвердите текущего пользователя.' }, body.explicit ? 200 : 409);
        }
        return json(route, { enabled: true, publicKey: Buffer.alloc(65, 1).toString('base64url'), lastRunAt: null, intervalSeconds: 60 });
      }
      if (!url.pathname.startsWith('/api/invoices')) return route.continue();
      assert.equal(request.headers()['x-artel-account'], expectedOwner, 'Every invoice request has stable CRM owner guard');
      calls.push([request.method(), url.pathname]);
      if (url.pathname === '/api/invoices' && request.method() === 'GET') {
        if (workspaceMode === 'hold') await new Promise(done => { releaseGet = done; });
        return workspaceMode === 'failed' ? json(route, { error: 'Синтетическая ошибка загрузки.' }, 503) : json(route, state);
      }
      if (url.pathname === '/api/invoices' && request.method() === 'POST') {
        const body = request.postDataJSON(); posts.push(body);
        if (responseMode === 'hold') await new Promise(done => { releasePost = done; });
        if (responseMode === 'unknown') return route.abort();
        if (responseMode === 'bad') return json(route, { error: 'Синтетическая проверка реквизитов не пройдена.' }, 422);
        if (responseMode === 'unauthorized') return json(route, { error: 'Сеанс завершён. Войдите заново.' }, 401);
        const current = state.history.items.find(item => item.key === body.idempotencyKey) ?? { ...job(body), key: body.idempotencyKey };
        state.history.items = [current, ...state.history.items.filter(item => item.id !== current.id)];
        return json(route, { job: current }, 202);
      }
      if (/\/jobs\/[^/]+\/file$/.test(url.pathname)) { fileReads++; return route.fulfill({ status: 200, contentType: 'application/pdf', body: '%PDF-1.4\n% synthetic fixture only\n%%EOF' }); }
      if (/\/jobs\/[^/]+\/retry$/.test(url.pathname)) return json(route, { job: state.history.items[0] }, 202);
      return json(route, { error: 'Unexpected synthetic invoice route' }, 500);
    });
    let page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message));
    if (process.env.ARTEL_INVOICES_QA_DEBUG) { page.on('console', message => console.log('BROWSER', message.type(), message.text())); page.on('requestfailed', request => console.log('FAILED', request.url(), request.failure())); page.on('response', response => { if (response.status() >= 400) console.log('HTTP', response.status(), response.url()); }); }
    const visit = async () => { await page.goto(runtime.base + '/#invoices'); await expect(page.getByRole('combobox', { name: 'Продавец', exact: true })).toBeVisible(); };
    const fill = async amount => { await page.getByRole('combobox', { name: 'Продавец', exact: true }).selectOption(organizationId); await page.getByRole('combobox', { name: 'Покупатель' }).fill('Учебный'); await page.getByRole('option', { name: /Учебный покупатель/ }).click(); await page.getByLabel('Сумма счёта', { exact: true }).fill(amount); };
    const refresh = async () => { await page.getByRole('button', { name: 'Обновить счета', exact: true }).click(); await expect(page.getByRole('button', { name: 'Обновить счета', exact: true })).toBeEnabled(); };
    await visit(); await fill('9000');
    await expect(page.getByRole('heading', { level: 1, name: 'Счета', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Проверить данные счёта', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tablist', { name: 'Раздел счетов' })).toHaveClass(/scrollable-segments/);
    await expect(page.getByRole('button', { name: 'Уведомления о счетах', exact: true })).toHaveCount(1);
    await expect(page.locator('.invoice-action-toolbar').getByText('Личные счета', { exact: true })).toBeVisible();
    await expect(page.locator('.bottom-nav,.brand-header')).toHaveCount(0);
    await page.getByRole('button', { name: 'Уведомления о счетах', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Уведомления о счетах' })).toBeVisible();
    await expect(page.getByText('Подтвердите включение уведомлений для текущего пользователя.', { exact: true })).toBeVisible();
    assert.ok(pushPosts.length > 0 && pushPosts.every(body => body.explicit === false));
    await page.getByRole('button', { name: 'Включить уведомления', exact: true }).click();
    await expect.poll(() => pushPosts.some(body => body.explicit === true)).toBe(true);
    check(`${engine}: automatic push binding requires consent and explicit enable carries user confirmation`);
    await expect(page.getByRole('dialog', { name: 'Уведомления о счетах' })).toBeHidden();
    check(`${engine}: native CRM shell, segments, common notification menu, no second login`);

    await page.evaluate(() => { location.hash = '#operator'; });
    await expect(page.getByRole('button', { name: 'Новая операция', exact: true })).toBeVisible();
    await page.evaluate(() => { location.hash = '#invoices'; });
    await expect(page.getByLabel('Сумма счёта', { exact: true })).toHaveValue('9000');
    await expect(page.getByRole('combobox', { name: 'Покупатель' })).toHaveValue('Учебный покупатель');
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'artel-open-invoices', jobId: 'synthetic-job' } })));
    await expect(page.getByRole('tab', { name: 'История', exact: true })).toHaveAttribute('aria-selected', 'true');
    await page.getByRole('tab', { name: 'Новый счёт', exact: true }).click();
    await expect(page.getByLabel('Сумма счёта', { exact: true })).toHaveValue('9000');
    check(`${engine}: draft survives CRM navigation and notification history opens without reload`);
    await page.evaluate(() => history.replaceState(null, '', `${location.pathname}#invoices`));

    const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const capture = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
    const audit = async name => {
      const axe = await new AxeBuilder({ page }).analyze();
      report.axe.push({ engine, page: name, violations: axe.violations });
      assert.equal(axe.violations.length, 0, JSON.stringify(axe.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.html) }))));
    };
    const measure = kind => page.evaluate(kind => {
      const rect = selector => {
        const element = document.querySelector(selector), box = element.getBoundingClientRect(), style = getComputedStyle(element);
        return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom, radius: style.borderRadius, padding: style.padding, fontSize: style.fontSize, fontWeight: style.fontWeight, lineHeight: style.lineHeight, shadow: style.boxShadow, display: style.display };
      };
      return {
        h1: rect('.page-heading h1'), tabs: rect(kind === 'work' ? '.work-views' : '.invoice-tabs'),
        toolbar: rect(kind === 'work' ? '.work-action-toolbar' : '.invoice-action-toolbar'),
        card: rect(kind === 'work' ? '.work-companies' : '.invoice-tab-panel:not([hidden])'),
        heading: rect(kind === 'work' ? '.work-section-heading h2' : '.invoice-tab-panel:not([hidden]) .panel-heading h2'),
        refresh: rect(kind === 'work' ? '.work-refresh' : '.invoice-toolbar > button'),
        label: rect(kind === 'work' ? '.work-refresh .mobile-action-label' : '.invoice-toolbar > button .mobile-action-label'),
        sidebar: rect('.sidebar'), scale: devicePixelRatio, overflow: document.documentElement.scrollWidth - innerWidth,
        ...(kind === 'invoices' ? { form: rect('.invoice-form'), seller: rect('.invoice-form > .field'), buyer: rect('.invoice-form > .buyer-field') } : {}),
      };
    }, kind);
    const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${engine}: ${label}: ${a} vs ${b}`);
    for (const width of [390, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(() => { location.hash = '#work'; window.scrollTo(0, 0); });
      await expect(page.locator('.work-companies')).toBeVisible(); await settle();
      const work = await measure('work'); await capture(`work-${width}`);
      await page.evaluate(() => { location.hash = '#invoices'; window.scrollTo(0, 0); });
      await expect(page.locator('.invoice-form')).toBeVisible(); await settle();
      const invoices = await measure('invoices');
      for (const key of ['h1', 'tabs', 'toolbar', 'card']) {
        near(invoices[key].x, invoices.h1.x, `${width} invoice ${key} common left edge`);
        near(invoices[key].x, work[key].x, `${width} ${key} left matches Work`);
        near(invoices[key].y, work[key].y, `${width} ${key} top matches Work`);
      }
      for (const key of ['h1', 'tabs', 'toolbar', 'refresh', 'sidebar']) near(invoices[key].height, work[key].height, `${width} ${key} height matches Work`);
      near(invoices.sidebar.width, work.sidebar.width, `${width} same sidebar`);
      assert.equal(invoices.scale, work.scale);
      assert.equal(invoices.card.radius, work.card.radius); assert.equal(invoices.card.shadow, work.card.shadow);
      for (const key of ['fontSize', 'fontWeight', 'lineHeight']) assert.equal(invoices.heading[key], work.heading[key], `${width} shared heading ${key}`);
      near(invoices.form.x - invoices.card.x, invoices.card.right - invoices.form.right, `${width} form fills card with equal insets`);
      assert.ok(invoices.form.width > invoices.card.width - 36, `${width} no unused right half of card`);
      near(invoices.label.display === 'none' ? 0 : invoices.refresh.height, work.label.display === 'none' ? 0 : work.refresh.height, `${width} same action label breakpoint`);
      if (width > 988) { assert.notEqual(invoices.label.display, 'none'); assert.ok(invoices.refresh.width > 100); }
      else { assert.equal(invoices.label.display, 'none'); near(invoices.refresh.width, 44, 'mobile action target'); }
      if (width > 650) near(invoices.seller.y, invoices.buyer.y, `${width} paired seller/buyer row`);
      else assert.ok(invoices.buyer.y > invoices.seller.bottom, 'mobile seller/buyer stack');
      assert.ok(await page.getByRole('combobox', { name: 'Покупатель' }).evaluate(element => parseFloat(getComputedStyle(element).paddingLeft) >= 38));
      assert.ok(invoices.overflow <= 1 && work.overflow <= 1, `${engine} no overflow ${width}`);
      report.geometry.push({ engine, width, work, invoices });
      await capture(`invoices-${width}`); await audit(`create-${width}`);
      state.buyers = [fixture().buyers[0], ...Array.from({ length: 55 }, (_, index) => ({ id: `qa-buyer-${index}`, name: `Контрагент ${index + 1}`, connectionId }))];
      await refresh();
      await page.getByRole('combobox', { name: 'Покупатель' }).fill('');
      await expect(page.getByRole('listbox', { name: 'Покупатели', exact: true }).getByRole('option')).toHaveCount(50);
      const lastBuyer = page.getByRole('listbox', { name: 'Покупатели', exact: true }).getByRole('option').last();
      await page.getByRole('listbox', { name: 'Покупатели', exact: true }).evaluate(list => { list.scrollTop = list.scrollHeight; });
      assert.equal(await page.locator('.create-panel').evaluate(card => card.scrollTop), 0, 'Searching must not scroll or hide the card heading');
      assert.ok(await lastBuyer.evaluate(element => {
        const box = element.getBoundingClientRect();
        return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
      }), `${engine} ${width}px all buyer options remain reachable beyond the compact card edge`);
      await capture(`buyer-search-${width}`);
      await fill('9000');
      await page.getByRole('tab', { name: 'История', exact: true }).click();
      await expect(page.getByRole('heading', { name: 'Пока нет счетов', exact: true })).toBeVisible();
      await capture(`empty-history-${width}`); await audit(`empty-history-${width}`);
      await page.getByRole('tab', { name: 'Настройки', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Сохранить цену', exact: true })).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await capture(`settings-${width}`); await audit(`settings-${width}`);
      await page.getByRole('tab', { name: 'Новый счёт', exact: true }).click();
      workspaceMode = 'hold'; await page.reload();
      await expect(page.getByRole('tabpanel', { name: 'Новый счёт', exact: true }).getByText('Загружаем данные…', { exact: true })).toBeVisible();
      await capture(`loading-${width}`); await audit(`loading-${width}`);
      workspaceMode = 'failed'; releaseGet();
      await expect(page.getByRole('tabpanel', { name: 'Новый счёт', exact: true }).getByText('Синтетическая ошибка загрузки.', { exact: true })).toBeVisible();
      await capture(`error-${width}`); await audit(`error-${width}`);
      workspaceMode = 'ready'; await page.getByRole('button', { name: 'Повторить', exact: true }).click();
      await expect(page.locator('.invoice-form')).toBeVisible();
      await fill('9000');
      check(`${engine}: Work/Invoices geometry, same sidebar/scale, shared tokens, create/empty/settings/loading/error, ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    responseMode = 'hold';
    await page.getByRole('button', { name: 'Создать счёт и PDF', exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Проверяем реквизиты…', exact: true })).toBeDisabled();
    await expect(page.getByText(/Запрос принят\./)).toHaveCount(0);
    await page.locator('.invoice-form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    assert.equal(posts.length, 1); assert.equal(calls.some(([, path]) => path.endsWith('/prepare')), false);
    responseMode = 'accepted'; releasePost();
    await expect(page.getByText(/Запрос принят\. Создаём счёт в 1С/)).toBeVisible();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), pendingKey(posts[0])), null);
    await page.getByRole('tab', { name: 'История', exact: true }).click();
    for (const [workflowState, label] of [['planned', 'Проверяем реквизиты'], ['posting', 'Проводим счёт в 1С'], ['pdf_pending', 'Получаем PDF']]) {
      state.history.items[0].workflowState = workflowState; await refresh(); await expect(page.locator('.job-status')).toHaveText(label);
    }
    state.history.items[0] = { ...state.history.items[0], status: 'failed', canRetryPdf: true };
    await refresh(); await page.getByRole('button', { name: 'Повторить получение PDF', exact: true }).click();
    await expect.poll(() => calls.filter(([, path]) => path.endsWith('/retry')).length).toBe(1);
    state.history.items[0] = { ...state.history.items[0], status: 'ready', canRetryPdf: false, fileAvailable: true };
    await refresh(); await expect(page.locator('.job-status')).toHaveText('Готов');
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Скачать PDF', exact: true }).click(); await download; assert.equal(fileReads, 1);
    check(`${engine}: one guarded POST, no prepare, factual stages, PDF retry and guarded download`);

    await page.getByRole('tab', { name: 'Новый счёт', exact: true }).click(); await page.getByRole('button', { name: 'Начать новый счёт', exact: true }).click(); await fill('8000');
    responseMode = 'bad'; await page.getByRole('button', { name: 'Создать счёт и PDF', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Синтетическая проверка реквизитов' })).toBeVisible();
    await expect(page.getByLabel('Сумма счёта', { exact: true })).toBeEnabled();
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('artel:crm:invoice-pending:')).length), 0);
    responseMode = 'unknown'; await page.getByRole('button', { name: 'Создать счёт и PDF', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Проверить прежний запрос', exact: true })).toBeEnabled();
    const unknown = posts.at(-1); assert.notEqual(unknown.idempotencyKey, posts.at(-2).idempotencyKey);
    await page.close(); page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message)); await visit();
    await expect(page.getByLabel('Сумма счёта', { exact: true })).toHaveValue('8000'); await expect(page.getByLabel('Сумма счёта', { exact: true })).toBeDisabled();
    responseMode = 'accepted'; await page.getByRole('button', { name: 'Проверить прежний запрос', exact: true }).click(); await expect(page.getByRole('button', { name: 'Начать новый счёт', exact: true })).toBeVisible();
    assert.deepEqual(posts.at(-1), unknown);
    check(`${engine}: safe validation failure unlocks, unknown survives closed tab and replays full same request`);

    const pendingOne = input('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'), pendingTwo = input('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'), otherOwner = input();
    await page.evaluate(({ one, two, other, owner }) => {
      localStorage.setItem(`artel:crm:invoice-pending:${owner}:${one.idempotencyKey}`, JSON.stringify({ input: one }));
      sessionStorage.setItem(`artel:crm:invoice-pending:${owner}`, JSON.stringify({ input: two }));
      localStorage.setItem(`artel:crm:invoice-pending:other-user:${other.idempotencyKey}`, JSON.stringify({ input: other }));
    }, { one: pendingOne, two: pendingTwo, other: otherOwner, owner: user.id });
    await page.reload(); await expect(page.getByRole('button', { name: 'Проверить прежний запрос', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Проверить прежний запрос', exact: true }).click();
    await expect(page.getByText(/Восстановлен следующий незавершённый запрос/)).toBeVisible();
    assert.deepEqual(posts.at(-1), pendingOne);
    await expect(page.getByRole('button', { name: 'Проверить прежний запрос', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Проверить прежний запрос', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Начать новый счёт', exact: true })).toBeVisible(); assert.deepEqual(posts.at(-1), pendingTwo);
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('artel:crm:invoice-pending:other-user:')).length), 1);
    check(`${engine}: multiple durable and migrated requests reconcile individually, account storage isolated`);

    await page.getByRole('button', { name: 'Начать новый счёт', exact: true }).click(); await fill('7000');
    responseMode = 'hold'; const before = posts.length; await page.getByRole('button', { name: 'Создать счёт и PDF', exact: true }).click(); await expect.poll(() => posts.length).toBe(before + 1);
    const second = await context.newPage(); await second.goto(runtime.base + '/#invoices');
    await expect(second.getByRole('button', { name: 'Проверить прежний запрос', exact: true })).toBeEnabled();
    await second.getByRole('button', { name: 'Проверить прежний запрос', exact: true }).click();
    await expect(second.getByRole('alert').filter({ hasText: 'в другой вкладке' })).toBeVisible(); assert.equal(posts.length, before + 1);
    responseMode = 'accepted'; releasePost(); await expect(page.getByRole('button', { name: 'Начать новый счёт', exact: true })).toBeVisible();
    await second.getByRole('button', { name: 'Проверить прежний запрос', exact: true }).click(); await expect(second.getByRole('button', { name: 'Начать новый счёт', exact: true })).toBeVisible(); assert.deepEqual(posts.at(-1), posts.at(-2)); await second.close();
    check(`${engine}: cross-tab owner lock prevents parallel send, stale tab safely reconciles same key`);

    await page.getByRole('button', { name: 'Начать новый счёт', exact: true }).click(); await fill('6000');
    state.canCreate = false; state.invoiceCreation.connections[0] = { connectionId, ready: false, checking: false, blockers: [{ code: 'readonly', message: 'Создание отключено на этапе проверки.' }] };
    await refresh(); await expect(page.getByRole('button', { name: 'Создать счёт и PDF', exact: true })).toBeDisabled();
    state = fixture(); await refresh();
    const beforeUnsupported = posts.length;
    await page.evaluate(() => { const locks = navigator.locks; window.__restoreQaLocks = () => Object.defineProperty(navigator, 'locks', { configurable: true, value: locks }); Object.defineProperty(navigator, 'locks', { configurable: true, value: undefined }); });
    await page.getByRole('button', { name: 'Создать счёт и PDF', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'не поддерживает защиту' })).toBeVisible(); assert.equal(posts.length, beforeUnsupported);
    await page.evaluate(() => { window.__restoreQaLocks(); delete window.__restoreQaLocks; });
    check(`${engine}: unsupported browser locks fail closed before sending`);
    responseMode = 'unauthorized'; await page.getByRole('button', { name: 'Создать счёт и PDF', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Войти', exact: true })).toBeVisible();
    assert.ok(await page.evaluate(key => localStorage.getItem(key), pendingKey(posts.at(-1))));
    check(`${engine}: read-only readiness blocks creation and revoked session returns CRM login with unresolved request retained`);
    const retained = posts.at(-1), beforeLoginPosts = posts.length;
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { origin: location.origin, data: { type: 'artel-open-invoices', jobId: 'untrusted-other-job' } })));
    assert.equal(new URL(page.url()).searchParams.get('invoiceView'), 'history');
    await page.getByLabel('Логин', { exact: true }).fill('invoices.qa'); await page.getByLabel('Пароль', { exact: true }).fill(password);
    await page.getByRole('button', { name: 'Войти', exact: true }).click();
    await expect(page.getByRole('tab', { name: 'История', exact: true })).toHaveAttribute('aria-selected', 'true');
    assert.equal(posts.length, beforeLoginPosts, 'Login does not replay unknown requests automatically');
    await page.getByRole('tab', { name: 'Новый счёт', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Проверить прежний запрос', exact: true })).toBeEnabled();
    assert.ok(await page.evaluate(key => localStorage.getItem(key), pendingKey(retained)));
    const ownJobIds = state.history.items.map(item => item.id);
    state = fixture(); expectedOwner = otherUser.id;
    await authenticateContext(context, runtime.base, otherCookie); await page.reload();
    await expect(page.getByRole('tab', { name: 'История', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(page.getByRole('heading', { name: 'Пока нет счетов', exact: true })).toBeVisible();
    for (const id of ownJobIds) assert.equal(calls.some(([, path]) => path === `/api/invoices/jobs/${id}`), false);
    await page.getByRole('tab', { name: 'Новый счёт', exact: true }).click();
    await expect(page.getByLabel('Сумма счёта', { exact: true })).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Проверить прежний запрос', exact: true })).toHaveCount(0);
    assert.ok(await page.evaluate(key => localStorage.getItem(key), pendingKey(retained)));
    const urlBeforeForeign = page.url();
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { origin: 'https://foreign.synthetic.test', data: { type: 'artel-open-invoices', jobId: 'foreign-job' } })));
    assert.equal(page.url(), urlBeforeForeign);
    check(`${engine}: notification on login returns to personal history, another account cannot recover the prior owner's job or pending request`);
    await context.close(); await browser.close(); browser = null;
  }
  assert.equal(report.errors.length, 0, report.errors.join('\n'));
  // Directors use the same full-access policy for invoices as the other CRM sections.
  browser = await chromium.launch({ headless: true }); const context = await browser.newContext(); await authenticateContext(context, runtime.base, admin.cookie); const page = await context.newPage();
  let invoiceRequests = 0; await page.route('**/api/invoices**', route => { invoiceRequests++; return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(fixture()) }); });
  await page.goto(runtime.base + '/#invoices'); await expect(page.getByRole('combobox', { name: 'Продавец', exact: true })).toBeVisible(); assert.ok(invoiceRequests > 0);
  await page.goto(runtime.base + '/#accounts'); await page.locator('.account-row').filter({ hasText: 'QA Директор' }).getByRole('button', { name: 'Изменить', exact: true }).click();
  await expect(page.getByRole('checkbox', { name: 'Счета', exact: true })).toBeChecked(); await expect(page.getByRole('checkbox', { name: 'Счета', exact: true })).toBeDisabled();
  check('chromium: director can open invoices and its section switch follows the other mandatory sections');
  await context.close(); await browser.close(); browser = null;
} finally {
  if (browser) await browser.close();
  await runtime.server.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, axe: report.axe.length, errors: report.errors.length, output }));
  if (process.env.ARTEL_INVOICES_QA_OUTPUT) await rm(temporary, { recursive: true, force: true });
}

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
import { calculateRoundedInvoice } from '../web/src/invoice-math.ts';
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
function job(input, changes = {}) { const calculation = input.calculationVersion === 2 ? calculateRoundedInvoice(input.amount, input.unitPrice) : null; return { id: randomUUID(), status: 'processing', workflowState: 'creating', amount: input.amount, unitPrice: input.unitPrice, organizationName: profile.organizationName, buyerName: 'Учебный покупатель', createdAt: profile.observedAt, fileAvailable: false, quantity: { display: '113.924', numerator: '9000', denominator: '79', exact: false }, ...(calculation ? { calculation, amount: calculation.amount, requestedAmount: input.amount, quantity: { display: calculation.quantity, numerator: calculation.quantity, denominator: '1', exact: true } } : {}), ...changes }; }
const pendingKey = input => `artel:crm:invoice-pending:${encodeURIComponent(user.id)}:${input.idempotencyKey}`;
const input = (key = randomUUID()) => ({ organizationId, buyerId, amount: '9000', unitPrice: '79', idempotencyKey: key, connectionId, profileRevision: profile.revision });
const report = { synthetic: true, frontend: runtime.mode, artifacts: runtime.artifacts, checks: [], geometry: [], axe: [], screenshots: [], errors: [] };
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
        if (responseMode === 'legacy-version') return json(route, { error: 'Расчёт счетов обновлён. Обновите страницу, проверьте целые литры и итоговую сумму и создайте новый запрос.' }, 422);
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
    const fill = async amount => { await page.getByRole('combobox', { name: 'Продавец', exact: true }).selectOption(organizationId); await page.getByRole('combobox', { name: 'Покупатель' }).fill('Учебный'); await page.getByRole('option', { name: /Учебный покупатель/ }).click(); await page.getByLabel(/^Сумма (счёта|до округления)$/).fill(amount); };
    const refresh = async () => { await page.getByRole('button', { name: 'Обновить счета', exact: true }).click(); await expect(page.getByRole('button', { name: 'Обновить счета', exact: true })).toBeEnabled(); };
    await visit(); await fill('9000');
    if (process.env.ARTEL_INVOICES_QA_LAYOUT_ONLY === '1') {
      for (const width of [375,390,440,570,768,1100,1101,1440,1920]) {
        await page.setViewportSize({width,height:1000});
        await page.evaluate(() => window.scrollTo(0,0));
        const geometry = await page.evaluate(() => {
          const box = selector => document.querySelector(selector).getBoundingClientRect();
          return {right:box('.invoice-toolbar').right, edge:box('.invoice-topbar').right, top:box('.invoice-toolbar').top, headingBottom:box('.invoice-topbar h1').bottom, overflow:document.documentElement.scrollWidth-innerWidth};
        });
        assert.ok(Math.abs(geometry.right-geometry.edge)<=1, `${engine}/${width}: actions align to the right edge`);
        assert.ok(geometry.top>=geometry.headingBottom+8, `${engine}/${width}: actions below heading`);
        assert.ok(geometry.overflow<=1, `${engine}/${width}: no horizontal overflow`);
        report.geometry.push({engine,width,...geometry});
        if ([390,1440].includes(width)) {
          const path = resolve(output, `${engine}-create-${width}.png`);
          await page.screenshot({path,fullPage:true}); report.screenshots.push(path);
        }
      }
      check(`${engine}: right aligned lower action row at nine widths, 375–1920px`);
      await context.close(); await browser.close(); browser=null; continue;
    }
    const rejectedLegacy = input('cccccccc-cccc-4ccc-8ccc-cccccccccccc');
    await page.evaluate(({key,input})=>localStorage.setItem(key,JSON.stringify({input})),{key:pendingKey(rejectedLegacy),input:rejectedLegacy});
    await page.reload(); await expect(page.getByRole('button',{name:'Проверить прежний запрос',exact:true})).toBeEnabled();
    await expect(page.locator('[data-invoice-total]')).toHaveCount(0);
    responseMode='legacy-version';
    await page.getByRole('button',{name:'Проверить прежний запрос',exact:true}).click();
    await expect(page.getByRole('alert').filter({hasText:'Расчёт счетов обновлён'})).toBeVisible();
    assert.deepEqual(posts.at(-1),rejectedLegacy); assert.equal('calculationVersion' in posts.at(-1),false);
    assert.equal(await page.evaluate(key=>localStorage.getItem(key),pendingKey(rejectedLegacy)),null);
    await expect(page.getByLabel('Сумма до округления',{exact:true})).toHaveValue('9000');
    await expect(page.locator('[data-invoice-quantity]')).toHaveText('114 л');
    await expect(page.locator('[data-invoice-total]')).toHaveText('9 006 ₽');
    const postsAfterRejection=posts.length;
    await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
    assert.equal(posts.length,postsAfterRejection,'Definite legacy rejection never resubmits automatically');
    responseMode='accepted'; await page.getByRole('button',{name:'Создать счёт и PDF',exact:true}).click();
    await expect(page.getByRole('button',{name:'Начать новый счёт',exact:true})).toBeVisible();
    assert.equal(posts.at(-1).calculationVersion,2); assert.notEqual(posts.at(-1).idempotencyKey,rejectedLegacy.idempotencyKey); assert.equal(posts.at(-1).amount,'9000');
    check(`${engine}: unaccepted legacy pending gets definite422, no automatic replay, visible v2 total and explicit new UUID after user submit`);
    if(process.env.ARTEL_INVOICES_QA_VERSION_RECOVERY_ONLY==='1') { await context.close(); await browser.close(); browser=null; continue; }
    state=fixture(); posts=[]; calls=[]; await page.getByRole('button',{name:'Начать новый счёт',exact:true}).click(); await refresh(); await fill('9000');

    await expect(page.getByRole('heading', { level: 1, name: 'Счета', exact: true })).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Проверить данные счёта', exact: true })).toHaveCount(0);
    await expect(page.getByRole('tablist', { name: 'Раздел счетов' })).toHaveCount(0);
    await expect(page.getByRole('region', { name: 'История счетов', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Уведомления о счетах', exact: true })).toHaveCount(0);
    const notifications = page.locator('.sidebar-user-controls').getByRole('button', { name: 'Уведомления', exact: true });
    await expect(notifications).toHaveCount(1);
    await expect(page.locator('.invoice-action-toolbar')).toHaveCount(0);
    await expect(page.locator('.invoice-topbar .invoice-toolbar')).toBeVisible();
    await expect(page.locator('.bottom-nav,.brand-header')).toHaveCount(0);
    await notifications.click();
    const notificationDialog = page.getByRole('dialog', { name: 'Уведомления', exact: true });
    await expect(notificationDialog).toBeVisible();
    await expect(notificationDialog).toContainText('Уведомления включаются сразу для всех доступных вам разделов: работы, счетов и операторской.');
    await expect(page.getByText('Подтвердите включение уведомлений для текущего пользователя.', { exact: true })).toBeVisible();
    assert.ok(pushPosts.length > 0 && pushPosts.every(body => body.explicit === false));
    await notificationDialog.getByRole('button', { name: 'Включить для всех разделов', exact: true }).click();
    await expect.poll(() => pushPosts.some(body => body.explicit === true)).toBe(true);
    check(`${engine}: automatic push binding requires consent and explicit enable carries user confirmation`);
    await expect(notificationDialog).toBeHidden();
    check(`${engine}: native CRM shell, single heading and toolbar, common notification menu, no second login`);

    await page.evaluate(() => { location.hash = '#operator'; });
    await expect(page.getByRole('button', { name: 'Новая операция', exact: true })).toBeVisible();
    await page.evaluate(() => { location.hash = '#invoices'; });
    await expect(page.getByLabel(/^Сумма (счёта|до округления)$/)).toHaveValue('9000');
    await expect(page.getByRole('combobox', { name: 'Покупатель' })).toHaveValue('Учебный покупатель');
    await page.evaluate(() => navigator.serviceWorker.dispatchEvent(new MessageEvent('message', { data: { type: 'artel-open-invoices', jobId: 'synthetic-job' } })));
    await expect(page.getByRole('region', { name: 'История счетов', exact: true })).toBeFocused();
    await page.evaluate(() => { document.querySelector('.invoice-settings-dialog')?.close(); document.querySelector('.invoice-form')?.scrollIntoView({block:'start'}); });
    await expect(page.getByLabel(/^Сумма (счёта|до округления)$/)).toHaveValue('9000');
    check(`${engine}: draft survives CRM navigation and notification history opens without reload`);
    await page.evaluate(() => history.replaceState(null, '', `${location.pathname}#invoices`));

    const settle = () => page.evaluate(() => new Promise(done => requestAnimationFrame(() => requestAnimationFrame(done))));
    const capture = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
    const audit = async name => {
      const axe = await new AxeBuilder({ page }).analyze();
      report.axe.push({ engine, page: name, violations: axe.violations });
      assert.equal(axe.violations.length, 0, JSON.stringify(axe.violations.map(item => ({ id: item.id, nodes: item.nodes.map(node => node.html) }))));
    };
    // Sample actual rendered frames, including new rows received during refresh.
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.getByLabel(/^Сумма (счёта|до округления)$/).fill('');
    await page.evaluate(() => {
      window.invoiceMotionSamples = [];
      window.invoiceMotionObserver = new MutationObserver(records => {
        for (const record of records) for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          const elements = [...(node.matches('.invoice-calculation,.history-item') ? [node] : []), ...node.querySelectorAll('.invoice-calculation,.history-item')];
          for (const element of elements) requestAnimationFrame(() => requestAnimationFrame(() => {
            const styles = getComputedStyle(element);
            window.invoiceMotionSamples.push({ kind: element.className, opacity: Number(styles.opacity), transform: styles.transform, animations: element.getAnimations().length });
          }));
        }
      });
      window.invoiceMotionObserver.observe(document.querySelector('.invoice-workspace'), { childList:true, subtree:true });
    });
    await fill('9000');
    await expect.poll(() => page.evaluate(() => window.invoiceMotionSamples.length)).toBeGreaterThan(0);
    state.history.items = [job(input(), { id:'motion-only-row', status:'ready', fileAvailable:true })];
    await refresh();
    await expect.poll(() => page.evaluate(() => window.invoiceMotionSamples.some(item => item.kind === 'history-item'))).toBe(true);
    const motion = await page.evaluate(() => window.invoiceMotionSamples);
    for (const kind of ['invoice-calculation','history-item']) assert.ok(motion.some(item => item.kind === kind && item.opacity > 0 && item.opacity < 1 && item.animations > 0), `${engine}: ${kind} has a rendered intermediate frame: ${JSON.stringify(motion)}`);
    await page.waitForTimeout(300);
    await refresh();
    assert.equal(await page.locator('.history-item').evaluate(element => element.getAnimations().length),0,'Refreshing an existing invoice must not replay its entrance');
    await page.getByRole('button', { name:'Настройки счетов', exact:true }).click();
    await expect(page.locator('.invoice-settings-dialog')).toHaveAttribute('data-modal-motion', 'opening');
    await page.keyboard.press('Escape');
    await expect(page.locator('.invoice-settings-dialog')).toBeHidden();
    await expect(page.getByRole('button', { name:'Настройки счетов', exact:true })).toBeFocused();
    assert.equal(await page.evaluate(() => document.body.style.overflow),'','Dialog close restores scrolling');
    await page.getByRole('button', { name:'Настройки счетов', exact:true }).click();
    await page.evaluate(() => window.dispatchEvent(new Event('artel:invoice-history')));
    await expect(page.locator('.invoice-settings-dialog')).toBeHidden();
    await expect(page.locator('.invoice-history-panel')).toBeFocused();
    await page.evaluate(() => { window.invoiceMotionObserver.disconnect(); });
    state.history.items = []; await refresh();
    await page.emulateMedia({ reducedMotion:'reduce' });
    assert.equal(await page.locator('.invoice-calculation').evaluate(element => getComputedStyle(element).transform),'none');
    report.motion = [...(report.motion ?? []), { engine, samples:motion }];
    check(`${engine}: new calculation/row intermediate frames, no replay on refresh, Escape/focus/scroll, notification closes drawer, reduced motion`);
    const near = (a, b, label) => assert.ok(Math.abs(a - b) <= 1, `${engine}: ${label}: ${a} vs ${b}`);
    for (const width of [375, 390, 440, 768, 1024, 1100, 1101, 1199, 1200, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      await fill('15000');
      await page.getByLabel('Цена за литр', { exact: true }).fill('79');
      await page.evaluate(() => window.scrollTo(0, 0)); await settle();
      const geometry = await page.evaluate(() => {
        const rect = selector => { const el = document.querySelector(selector), r = el.getBoundingClientRect(); return { x:r.x,y:r.y,width:r.width,right:r.right,bottom:r.bottom,display:getComputedStyle(el).display }; };
        return { heading:rect('.invoice-topbar h1'),toolbar:rect('.invoice-toolbar'),seller:rect('.seller-field'),buyer:rect('.buyer-field'),amount:rect('.amount-field'),price:rect('.invoice-price'),card:rect('.invoice-create-panel'),form:rect('.invoice-form'),history:rect('.invoice-history-panel'),refresh:rect('.invoice-toolbar>button'),label:rect('.invoice-toolbar>button .mobile-action-label'),overflow:document.documentElement.scrollWidth-innerWidth };
      });
      assert.ok(geometry.overflow <= 1, `${width}: no overflow`);
      const corners = await page.locator('.invoice-create-panel,.invoice-history-panel').evaluateAll(elements => elements.map(element => parseFloat(getComputedStyle(element).borderTopLeftRadius)));
      assert.ok(corners.every(radius => radius >= 26), `${width}: rounded panels: ${corners}`);
      assert.ok(geometry.toolbar.y >= geometry.heading.bottom + 8, `${width}: actions on a separate row below the heading`);
      assert.ok(geometry.card.y >= geometry.toolbar.bottom + 16, `${width}: form below action row`);
      assert.ok(geometry.history.y >= geometry.card.bottom, `${width}: history below form`);
      near(geometry.form.x - geometry.card.x, geometry.card.right - geometry.form.right, `${width}: symmetric form padding`);
      if(width >= 1200) { for(const field of ['buyer','amount','price']) near(geometry.seller.y,geometry[field].y,`${width}: four fields in one row`); }
      else if(width > 570) { near(geometry.seller.y,geometry.buyer.y,`${width}: seller/buyer row`); near(geometry.amount.y,geometry.price.y,`${width}: amount/price row`); assert.ok(geometry.amount.y>geometry.seller.y); }
      else { assert.ok(geometry.buyer.y>geometry.seller.y); near(geometry.amount.y,geometry.price.y,`${width}: paired amount and price on mobile`); }
      if(width<=1100) { assert.equal(geometry.label.display,'none'); near(geometry.refresh.width,44,`${width}: action target`); } else assert.notEqual(geometry.label.display,'none');
      report.geometry.push({engine,width,...geometry});
      await expect(page.locator('[data-invoice-quantity]')).toHaveText('190 л');
      await expect(page.locator('[data-invoice-total]')).toHaveText('15 010 ₽');
      await capture(`create-${width}`); await audit(`create-${width}`);
      await page.locator('.invoice-calculation-details summary').click();
      await expect(page.locator('.invoice-calculation-details')).toContainText('189,873417721518… → 190 л');
      await capture(`calculation-${width}`); await audit(`calculation-${width}`);
      await page.locator('.invoice-calculation-details summary').click();
      await page.getByRole('combobox', { name: 'Покупатель' }).fill('Учебный');
      await expect(page.getByRole('option', { name: /Учебный покупатель/ })).toBeVisible();
      await capture(`buyer-search-${width}`);
      await fill('9000');
      await page.locator('.invoice-history-panel').scrollIntoViewIfNeeded();
      await expect(page.getByRole('heading', { name: 'Пока нет счетов', exact: true })).toBeVisible();
      await capture(`empty-history-${width}`); await audit(`empty-history-${width}`);
      await page.getByRole('button', { name: 'Настройки счетов', exact: true }).click();
      await expect(page.getByRole('button', { name: /Сохранить (мою )?цену/ })).toHaveCount(0);
      await expect(page.getByRole('heading', { name: 'Цена по умолчанию', exact: true })).toHaveCount(0);
      await expect(page.getByLabel('Общая цена за литр', { exact: true })).toHaveCount(0);
      await expect(page.locator('.settings-form,.current-price')).toHaveCount(0);
      await expect(page.getByRole('heading', { name: '1С Fresh', exact: true })).toBeVisible();
      await expect(page.getByRole('list', { name: 'Подключённые базы', exact: true })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Реквизиты нового счёта', exact: true })).toBeVisible();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
      await capture(`settings-${width}`); await audit(`settings-${width}`);
      await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', {name:'Настройки',exact:true})).toBeHidden(); await expect(page.getByRole('button',{name:'Настройки счетов',exact:true})).toBeFocused();
      await page.evaluate(() => { document.querySelector('.invoice-settings-dialog')?.close(); document.querySelector('.invoice-form')?.scrollIntoView({block:'start'}); });
      workspaceMode = 'hold'; await page.reload();
      await expect(page.getByRole('region', { name: 'Новый счёт', exact: true }).getByText('Загружаем данные…', { exact: true })).toBeVisible();
      await capture(`loading-${width}`); await audit(`loading-${width}`);
      workspaceMode = 'failed'; releaseGet();
      await expect(page.getByRole('region', { name: 'Новый счёт', exact: true }).getByText('Синтетическая ошибка загрузки.', { exact: true })).toBeVisible();
      await capture(`error-${width}`); await audit(`error-${width}`);
      workspaceMode = 'ready'; await page.getByRole('button', { name: 'Повторить', exact: true }).click();
      await expect(page.locator('.invoice-form')).toBeVisible();
      workspaceMode = 'hold'; await page.reload();
      await page.getByRole('button', { name: 'Настройки счетов', exact: true }).click();
      const settingsPanel = page.getByRole('dialog', { name: 'Настройки', exact: true });
      await expect(settingsPanel.getByText('Загружаем данные…', { exact: true })).toBeVisible();
      await capture(`settings-loading-${width}`); await audit(`settings-loading-${width}`);
      workspaceMode = 'failed'; releaseGet();
      await expect(settingsPanel.getByText('Синтетическая ошибка загрузки.', { exact: true })).toBeVisible();
      await expect(settingsPanel.getByRole('button', { name: 'Повторить', exact: true })).toHaveCount(1);
      await capture(`settings-error-${width}`); await audit(`settings-error-${width}`);
      workspaceMode = 'ready'; await settingsPanel.getByRole('button', { name: 'Повторить', exact: true }).click();
      await expect(settingsPanel.getByRole('list', { name: 'Подключённые базы', exact: true })).toBeVisible();
      await expect(settingsPanel.getByRole('button', { name: 'Повторить', exact: true })).toHaveCount(0);
      await page.evaluate(() => { document.querySelector('.invoice-settings-dialog')?.close(); document.querySelector('.invoice-form')?.scrollIntoView({block:'start'}); });
      await fill('9000');
      check(`${engine}: four-field/adaptive geometry, preview/details, no overflow, settings/loading/error/retry, ${width}px`);
    }
    await page.setViewportSize({ width: 1440, height: 1000 });

    const price = page.getByLabel('Цена за литр', { exact: true });
    await fill('15000'); await price.fill('79');
    const submit = page.getByRole('button', {name:'Создать счёт и PDF',exact:true});
    for(const [amount,total,difference] of [['15000','15 010 ₽','На 10 ₽ больше'],['15049','15 010 ₽','На 39 ₽ меньше'],['158','158 ₽','Совпадает']]) {
      await page.getByLabel(/^Сумма (счёта|до округления)$/).fill(amount); await expect(page.locator('[data-invoice-total]')).toHaveText(total); await expect(page.locator('.invoice-difference')).toContainText(difference); await expect(submit).toBeEnabled();
    }
    for(const amount of ['0','-1','1e3','0,01','15000,001']) { await page.getByLabel(/^Сумма (счёта|до округления)$/).fill(amount); await expect(submit).toBeDisabled(); await expect(page.locator('.invoice-form .form-error')).toBeVisible(); }
    await page.getByLabel(/^Сумма (счёта|до округления)$/).fill('15000,50'); await expect(page.locator('[data-invoice-total]')).toHaveText('15 010 ₽');
    await page.getByLabel(/^Сумма (счёта|до округления)$/).fill(''); await expect(submit).toBeDisabled();
    await fill('9000'); if(await page.getByRole('button',{name:'Вернуть общую',exact:true}).count()) await page.getByRole('button',{name:'Вернуть общую',exact:true}).click();
    check(`${engine}: exact whole-litre preview, increases/decreases/comma, invalid precision and zero litres blocked before POST`);

    await expect(price).toHaveValue('79');
    state.defaultUnitPrice = '81'; state.settings = { ...state.settings, defaultUnitPrice: '81', revision: 2 };
    await refresh(); await expect(price).toHaveValue('81');
    await price.fill('88');
    state.defaultUnitPrice = '83'; state.settings = { ...state.settings, defaultUnitPrice: '83', revision: 3 };
    await refresh(); await expect(price).toHaveValue('88');
    await page.getByRole('button', { name: 'Настройки счетов', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Цена по умолчанию', exact: true })).toHaveCount(0);
    await page.evaluate(() => { document.querySelector('.invoice-settings-dialog')?.close(); document.querySelector('.invoice-form')?.scrollIntoView({block:'start'}); }); await expect(price).toHaveValue('88');
    await page.getByRole('button', { name: 'Вернуть общую', exact: true }).click(); await expect(price).toHaveValue('83');
    await price.fill('79');
    assert.equal(calls.some(([method, path]) => method !== 'GET' && path.endsWith('/settings')), false);
    check(`${engine}: settings price UI removed; default autofill, explicit price through refresh/navigation, and restore-default still work`);

    responseMode = 'hold';
    await page.getByRole('button', { name: 'Создать счёт и PDF', exact: true }).click();
    await expect.poll(() => posts.length).toBe(1);
    await expect(page.getByRole('button', { name: 'Проверяем реквизиты…', exact: true })).toBeDisabled();
    await expect(page.getByText(/Запрос принят\./)).toHaveCount(0);
    await page.locator('.invoice-form').evaluate(form => { form.requestSubmit(); form.requestSubmit(); });
    assert.equal(posts.length, 1); assert.equal(calls.some(([, path]) => path.endsWith('/prepare')), false);
    assert.equal(posts[0].calculationVersion, 2); assert.equal(posts[0].amount, '9000');
    assert.equal(posts[0].unitPrice, '79', 'Submission retains the explicit invoice price rather than the refreshed default');
    responseMode = 'accepted'; releasePost();
    await expect(page.getByText(/Запрос принят\. Создаём счёт в 1С/)).toBeVisible();
    assert.equal(await page.evaluate(key => localStorage.getItem(key), pendingKey(posts[0])), null);
    await page.locator('.invoice-history-panel').scrollIntoViewIfNeeded();
    for (const [workflowState, label] of [['planned', 'Проверяем реквизиты'], ['posting', 'Проводим счёт в 1С'], ['pdf_pending', 'Получаем PDF']]) {
      state.history.items[0].workflowState = workflowState; await refresh(); await expect(page.locator('.job-status')).toHaveText(label);
    }
    state.history.items[0] = { ...state.history.items[0], status: 'failed', canRetryPdf: true };
    await refresh(); await page.getByRole('button', { name: 'Повторить получение PDF', exact: true }).click();
    await expect.poll(() => calls.filter(([, path]) => path.endsWith('/retry')).length).toBe(1);
    state.history.items[0] = { ...state.history.items[0], status: 'ready', canRetryPdf: false, fileAvailable: true };
    await refresh(); await expect(page.locator('.job-status')).toHaveText('Готов');
    const download = page.waitForEvent('download'); await page.getByRole('button', { name: 'Скачать PDF', exact: true }).click(); await download; assert.equal(fileReads, 1);
    const historicCalculation = structuredClone(state.history.items[0].calculation);
    await page.locator('.history-item .invoice-calculation-details summary').click();
    await expect(page.locator('.history-item .invoice-calculation-details')).toContainText('9 000 ₽ · 79 ₽/л');
    assert.deepEqual(state.history.items[0].calculation, historicCalculation);
    check(`${engine}: v2 original input, persisted calculation details, one guarded POST, factual stages, PDF retry/download`);
    const oldHistory = job(input(), {id:'legacy-invoice-919',status:'ready',workflowState:'completed',number:'QA-919',amount:'15000',quantity:{display:'189.873',numerator:'189873',denominator:'1000',exact:true},fileAvailable:true});
    state.history.items.push(oldHistory); await refresh();
    const oldCard = page.locator('[data-invoice-job="legacy-invoice-919"]');
    await expect(oldCard).toContainText('189,873 л'); await expect(oldCard.locator('.invoice-history-sum')).toContainText('15 000 ₽'); await expect(oldCard.locator('details')).toHaveCount(0);
    for(const width of [390,768,1440,1920]) { await page.setViewportSize({width,height:1000}); await capture(`new-and-legacy-history-${width}`); await audit(`new-and-legacy-history-${width}`); assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1)); }
    await page.setViewportSize({width:1440,height:1000});
    check(`${engine}: old fractional quantity/amount unchanged alongside new per-record calculation details at mobile/tablet/desktop widths`);


    await page.evaluate(() => { document.querySelector('.invoice-settings-dialog')?.close(); document.querySelector('.invoice-form')?.scrollIntoView({block:'start'}); }); await page.getByRole('button', { name: 'Начать новый счёт', exact: true }).click(); await expect(price).toHaveValue('83'); await fill('8000');
    responseMode = 'bad'; await page.getByRole('button', { name: 'Создать счёт и PDF', exact: true }).click();
    await expect(page.getByRole('alert').filter({ hasText: 'Синтетическая проверка реквизитов' })).toBeVisible();
    await expect(page.getByLabel(/^Сумма (счёта|до округления)$/)).toBeEnabled();
    assert.equal(await page.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('artel:crm:invoice-pending:')).length), 0);
    responseMode = 'unknown'; await page.getByRole('button', { name: 'Создать счёт и PDF', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Проверить прежний запрос', exact: true })).toBeEnabled();
    const unknown = posts.at(-1); assert.notEqual(unknown.idempotencyKey, posts.at(-2).idempotencyKey);
    await page.close(); page = await context.newPage(); page.on('pageerror', error => report.errors.push(error.message)); await visit();
    await expect(page.getByLabel(/^Сумма (счёта|до округления)$/)).toHaveValue('8000'); await expect(page.getByLabel(/^Сумма (счёта|до округления)$/)).toBeDisabled();
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
    assert.deepEqual(posts.at(-1), pendingOne); assert.equal('calculationVersion' in posts.at(-1), false);
    await expect(page.getByRole('button', { name: 'Проверить прежний запрос', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Проверить прежний запрос', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Начать новый счёт', exact: true })).toBeVisible(); assert.deepEqual(posts.at(-1), pendingTwo); assert.equal('calculationVersion' in posts.at(-1), false);
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
    await expect(page.getByRole('region', { name: 'История счетов', exact: true })).toBeFocused();
    assert.equal(posts.length, beforeLoginPosts, 'Login does not replay unknown requests automatically');
    await page.evaluate(() => { document.querySelector('.invoice-settings-dialog')?.close(); document.querySelector('.invoice-form')?.scrollIntoView({block:'start'}); });
    await expect(page.getByRole('button', { name: 'Проверить прежний запрос', exact: true })).toBeEnabled();
    assert.ok(await page.evaluate(key => localStorage.getItem(key), pendingKey(retained)));
    const ownJobIds = state.history.items.map(item => item.id);
    state = fixture(); expectedOwner = otherUser.id;
    await authenticateContext(context, runtime.base, otherCookie); await page.reload();
    await expect(page.getByRole('region', { name: 'История счетов', exact: true })).toBeFocused();
    await expect(page.getByRole('heading', { name: 'Пока нет счетов', exact: true })).toBeVisible();
    for (const id of ownJobIds) assert.equal(calls.some(([, path]) => path === `/api/invoices/jobs/${id}`), false);
    await page.evaluate(() => { document.querySelector('.invoice-settings-dialog')?.close(); document.querySelector('.invoice-form')?.scrollIntoView({block:'start'}); });
    await expect(page.getByLabel(/^Сумма (счёта|до округления)$/)).toHaveValue('');
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

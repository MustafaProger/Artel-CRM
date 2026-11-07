// Synthetic browser PushManager + real local subscription API. No provider sends.
import assert from 'node:assert/strict';
import { createECDH, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import webPush from 'web-push';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { OperationsStore } from '../server/operations-store.ts';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'shared-push-'));
const built = process.env.ARTEL_OPERATOR_QA_BUILT === '1';
const output = resolve(root, '.local/sidebar-release', built ? 'ui-built' : 'ui-source'); await mkdir(output, { recursive: true });
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store');
const source = await writeTripsQaSnapshot(snapshotDirectory), keys = webPush.generateVAPIDKeys();
const denied = async () => { throw new Error('External provider requests forbidden'); };
const middleware = createSnapshotMiddleware(snapshotDirectory, {
  operationsDirectory, setupToken: '', checkoApiKey: '', fetcher: denied, bankRequest: denied, sberRequest: denied,
  bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false' },
  pushConfig: { ...keys, subject: 'https://synthetic.test', schedule: true }, pushSender: denied,
});
let server, base, admin, artifacts;
if (built) {
  const runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
  ({ server, base, artifacts } = runtime); admin = await runtime.bootstrap();
} else {
  server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'web'), plugins: [react(), { name: 'qa-api', configureServer(vite) { vite.middlewares.use(middleware); } }], server: { host: '127.0.0.1', port: 0, cors: false } });
  await server.listen(); base = `http://127.0.0.1:${server.httpServer.address().port}`; admin = await bootstrapQaAuth(base);
}
const store = new OperationsStore(operationsDirectory);
const ec = createECDH('prime256v1'); ec.generateKeys();
const report = { synthetic: true, artifacts, transport: built ? 'compiled production UI/API; simulated push config and subscription transport' : 'simulated PushManager; real source subscription API and persisted store', providerSends: 0, checks: [], errors: [], axe: [] };
let browser;
try {
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, serviceWorkers: 'block', reducedMotion: 'reduce' });
    await authenticateContext(context, base, admin.cookie);
    const fake = { endpoint: `https://fcm.googleapis.com/fcm/send/shared-qa-${engine}`, keys: { p256dh: ec.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    await context.addInitScript(({ fake, publicKey }) => {
      let active = sessionStorage.getItem('qa-push') === 'true';
      let permission = active ? 'granted' : 'default';
      window.qaPush = { requests: 0, subscribes: 0 };
      const current = { options: { applicationServerKey: Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer }, toJSON: () => fake, endpoint: fake.endpoint, unsubscribe: async () => { active = false; sessionStorage.removeItem('qa-push'); return true; } };
      const worker = { pushManager: { getSubscription: async () => active ? current : null, subscribe: async () => { window.qaPush.subscribes++; active = true; sessionStorage.setItem('qa-push', 'true'); return current; } } };
      Object.defineProperty(window, 'PushManager', { configurable: true, value: class {} });
      Object.defineProperty(window, 'Notification', { configurable: true, value: { get permission() { return permission; }, requestPermission: async () => { window.qaPush.requests++; permission = 'granted'; return permission; } } });
      Object.defineProperty(navigator.serviceWorker, 'register', { configurable: true, value: async () => worker });
      Object.defineProperty(navigator.serviceWorker, 'ready', { configurable: true, value: Promise.resolve(worker) });
    }, { fake, publicKey: keys.publicKey });
    let explicit = 0, deletion = 0, writes = 0;
    await context.route('**/*', async route => {
      const req = route.request(), url = new URL(req.url());
      if (url.origin !== base) return route.abort();
      if (built && url.pathname === '/api/push/config') return route.fulfill({ json: { enabled: true, publicKey: keys.publicKey, lastRunAt: Date.now(), intervalSeconds: 60 } });
      if (url.pathname === '/api/push/subscription') {
        assert.equal(req.headers()['x-artel-account'], admin.user.id);
        if (req.method() === 'POST') { writes++; if (req.postDataJSON().explicit) explicit++; }
        if (req.method() === 'DELETE') deletion++;
        if (built) return route.fulfill({ json: { ok: true } });
      }
      return route.continue();
    });
    const page = await context.newPage(); page.on('pageerror', error => report.errors.push(`${engine}: ${error.message}`));
    const openMenu = async () => {
      const bell = page.locator('.sidebar-user-controls .driver-notification-button');
      if (!await bell.isVisible() || await page.locator('#app-navigation').evaluate(el => el.inert)) await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
      return bell;
    };
    const open = async section => {
      if (await page.locator('#app-navigation.is-open').count()) { await page.keyboard.press('Escape'); await expect(page.locator('#app-navigation.is-open')).toHaveCount(0); }
      await page.evaluate(section => { location.hash = section; }, section);
      await expect(page.locator('#app-navigation .nav-item[aria-current="page"]')).toContainText({work:'Работа',operator:'Операторская',invoices:'Счета',shipments:'Отгрузки'}[section]);
      const bell = await openMenu(); await bell.click();
      const dialog = page.getByRole('dialog', { name: 'Уведомления', exact: true });
      await expect(dialog).toBeVisible(); await expect(dialog).toContainText('Достаточно включить их один раз');
      return dialog;
    };
    await page.goto(base + '/#work');
    let dialog = await open('work');
    await dialog.getByRole('button', { name: 'Включить для всех разделов', exact: true }).click();
    await expect(dialog).toBeHidden();
    for (const section of ['operator', 'invoices', 'work']) {
      dialog = await open(section);
      await expect(dialog.getByRole('button', { name: 'Выключить для всех разделов', exact: true })).toBeVisible();
      await expect(dialog.getByRole('button', { name: 'Включить для всех разделов', exact: true })).toHaveCount(0);
      const audit = await new AxeBuilder({ page }).include('.driver-notifications-dialog').analyze();
      report.axe.push({ engine, section, violations: audit.violations }); assert.deepEqual(audit.violations, []);
      await page.keyboard.press('Escape');
    }
    assert.equal(explicit, 1); assert.deepEqual(await page.evaluate(() => window.qaPush), { requests: 1, subscribes: 1 });
    let devices; if (!built) { devices = (await store.read(source)).push.devices.filter(d => d.endpoint === fake.endpoint); assert.equal(devices.length, 1); assert.equal(devices[0].userId, admin.user.id); }
    await page.reload(); dialog = await open('invoices');
    await expect(dialog.getByRole('button', { name: 'Выключить для всех разделов', exact: true })).toBeVisible(); assert.equal(explicit, 1);
    await page.screenshot({ path: resolve(output, `${engine}-shared-enabled.png`) });
    await dialog.getByRole('button', { name: 'Выключить для всех разделов', exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Включить для всех разделов', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
    for (const section of ['work', 'operator']) {
      dialog = await open(section); await expect(dialog.getByRole('button', { name: 'Включить для всех разделов', exact: true })).toBeEnabled(); await page.keyboard.press('Escape');
    }
    if (!built) { devices = (await store.read(source)).push.devices.filter(d => d.endpoint === fake.endpoint); assert.equal(devices.length, 0); } assert.equal(deletion, 1); assert.equal(explicit, 1);
    // Desktop, narrow mobile, drawer-only shipments and collapsed sidebar.
    for (const width of [320,390,600,760,761,1024,1470,1920]) {
      await page.setViewportSize({ width, height: 950 });
      for (const section of ['work','invoices','operator','shipments']) {
        dialog = await open(section);
        if (section === 'operator') {
          await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
          if (await page.locator('#app-navigation.is-open').count()) await page.keyboard.press('Escape');
          await page.getByRole('tab',{name:/^Задания/}).click();
          const statuses = page.locator('.operator-controls .operator-plan-heading .button');
          await expect(statuses).toHaveCount(2);
          const bb = await statuses.evaluateAll(items=>items.map(e=>{const r=e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}}));
          assert.ok(Math.abs(bb[0].top-bb[1].top)<1 && bb[1].left>bb[0].right, 'Statuses must share one horizontal row');
          await statuses.nth(1).click(); await expect(statuses.nth(1)).toHaveAttribute('aria-pressed','true');
          await statuses.nth(0).click();
          if ([320,390,600,1470].includes(width)) await page.screenshot({path:resolve(output,`${engine}-operator-status-${width}.png`)});
          dialog = await open(section);
        }
        await expect(page.locator('.workspace-main .driver-notification-button')).toHaveCount(0);
        await expect(page.locator('.sidebar-user-controls .driver-notification-button')).toHaveCount(1);
        await expect(page.locator('.sidebar-user-controls button[aria-label="Выйти"]')).toHaveText('');
        const geometry = await dialog.boundingBox(); assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= width + 1);
        await page.keyboard.press('Tab');
        assert.equal(await page.evaluate(() => document.querySelector('dialog[open]').contains(document.activeElement)), true);
        await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
        await expect(page.locator('.sidebar-user-controls .driver-notification-button')).toBeFocused();
        const boxes = await page.locator('.sidebar-user-controls').evaluate(el => { const r=el.getBoundingClientRect(); return [...el.querySelectorAll('button')].map(b=>{const q=b.getBoundingClientRect();return {width:q.width,height:q.height,fits:q.left>=r.left&&q.right<=r.right+1};}); });
        assert.ok(boxes.every(b=>b.width>=40&&b.height>=40&&b.fits));
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        if ([320,1470].includes(width) && section==='operator') await page.screenshot({path:resolve(output,`${engine}-sidebar-${width}.png`)});
        report.checks.push({engine,width,section,passed:true});
      }
    }
    await page.evaluate(()=>{location.hash='work'});
    await page.keyboard.press('Escape');
    await page.getByRole('button',{name:'Свернуть панель',exact:true}).click();
    dialog = await open('work'); await page.keyboard.press('Escape'); await expect(dialog).toBeHidden();
    const collapsed = await page.locator('.sidebar-user-controls button').evaluateAll(items=>items.map(e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom}}));
    assert.ok(collapsed[1].top >= collapsed[0].bottom);
    await page.screenshot({path:resolve(output,`${engine}-sidebar-collapsed.png`)});
    await page.getByRole('button',{name:'Развернуть панель',exact:true}).click();
    const auditSidebar = await new AxeBuilder({page}).include('.sidebar').analyze(); report.axe.push({engine,section:'sidebar',violations:auditSidebar.violations}); assert.deepEqual(auditSidebar.violations,[]);
    await page.route('**/api/auth/logout', route=>route.fulfill({json:{ok:true}}));
    await page.locator('.sidebar-user-controls button[aria-label="Выйти"]').click();
    await expect(page.getByRole('button',{name:'Войти',exact:true})).toBeVisible();
    report.checks.push({ engine, explicit, deletion, writes, result: 'one permission/subscribe enables all three sections; persists after reload; one disable removes shared device' });
    console.log('PASS', engine, report.checks.at(-1).result);
    await context.close(); await browser.close(); browser = null;
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await browser?.close(); await server.close(); await rm(temporary, { recursive: true, force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}

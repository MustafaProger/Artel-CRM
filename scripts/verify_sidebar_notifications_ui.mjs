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
    const settingsPage = page.locator('.personal-settings-page');
    const notifications = settingsPage.getByRole('region', { name: 'Уведомления', exact: true });
    const profileHeading = settingsPage.getByRole('heading', { name: 'Профиль', exact: true });
    const profileCard = settingsPage.getByRole('region', { name: 'Профиль', exact: true });
    const gear = page.locator('.sidebar-settings-link');
    const openMenu = async () => {
      if (!await gear.isVisible() || await page.locator('#app-navigation').evaluate(el => el.inert)) {
        await page.getByRole('button', { name: 'Открыть меню', exact: true }).click();
      }
    };
    const go = async section => {
      if (await page.locator('#app-navigation.is-open').count()) {
        await page.keyboard.press('Escape');
        await expect(page.locator('#app-navigation.is-open')).toHaveCount(0);
      }
      await page.evaluate(section => { location.hash = section; }, section);
      await expect(page.locator('#app-navigation .nav-item[aria-current="page"]')).toContainText({work:'Работа',operator:'Операторская',invoices:'Счета',shipments:'Отгрузки'}[section]);
    };
    const readySettings = async () => {
      await expect(page).toHaveURL(/#settings$/);
      await expect(page.getByRole('heading', { name: 'Настройки', level: 1 })).toBeVisible();
      await expect(profileHeading).toBeVisible();
      await expect(notifications.getByRole('switch', { name: 'Задачи', exact: true })).toBeVisible();
      await expect(page.locator('dialog[open]')).toHaveCount(0);
    };
    const open = async section => {
      await go(section);
      await openMenu();
      await gear.click();
      await readySettings();
    };
    await page.goto(base + '/#work');
    await open('work');
    const tasks = notifications.getByRole('switch', { name: 'Задачи', exact: true });
    await expect(tasks).toHaveClass('account-toggle');
    await expect(page.locator('.sidebar-user-controls .sidebar-settings-link')).toHaveCount(1);
    const settingsActions = await page.locator('.sidebar-user-controls .sidebar-account-action').evaluateAll(actions =>
      actions.map(action => ({ left: action.getBoundingClientRect().left, top: action.getBoundingClientRect().top }))
    );
    assert.equal(settingsActions.length, 2);
    assert.ok(settingsActions[1].left > settingsActions[0].left && Math.abs(settingsActions[1].top - settingsActions[0].top) < 1);
    const editProfile = settingsPage.getByRole('button', { name: 'Изменить имя и логин' });
    await editProfile.click();
    const profileSaves = await settingsPage.locator('.personal-profile-form > button[type="submit"], .personal-profile-identity button[type="submit"]').evaluateAll(buttons =>
      buttons.map(button => Math.abs(button.getBoundingClientRect().right - button.closest('form').getBoundingClientRect().right))
    );
    assert.equal(profileSaves.length, 2);
    assert.ok(profileSaves.every(gap => gap < 1));
    await settingsPage.getByRole('button', { name: 'Отменить редактирование' }).click();
    const requests = notifications.getByRole('switch', { name: 'Заявки на рейс', exact: true });
    if (!await tasks.isChecked()) { await tasks.click(); await expect(tasks).toBeChecked(); }
    await expect(tasks).toBeChecked();
    await tasks.click(); await expect(tasks).not.toBeChecked();
    await expect(requests).toBeChecked();
    assert.equal(writes, 0, 'Changing account preferences does not subscribe this device');
    await page.reload(); await readySettings();
    await expect(tasks).not.toBeChecked();
    await expect(notifications.getByRole('switch', { name: 'Работа с компаниями — (напоминания)', exact: true })).toBeChecked();
    const notificationActions = notifications.locator('.personal-notifications-results .work-push-actions');
    const connect = notificationActions.getByRole('button', { name: 'Подключить этот браузер', exact: true });
    const disconnect = notificationActions.getByRole('button', { name: 'Отключить этот браузер', exact: true });
    await connect.click();
    await expect(disconnect).toBeVisible();
    await expect(notificationActions.getByRole('button', { name: 'Проверить уведомление', exact: true })).toBeEnabled();
    await expect(page).toHaveURL(/#settings$/);
    for (const section of ['operator', 'invoices', 'work']) {
      await open(section);
      await expect(disconnect).toBeVisible();
      await expect(connect).toHaveCount(0);
      const audit = await new AxeBuilder({ page }).include('.personal-settings-page').analyze();
      report.axe.push({ engine, section, violations: audit.violations }); assert.deepEqual(audit.violations, []);
    }
    assert.equal(explicit, 1); assert.deepEqual(await page.evaluate(() => window.qaPush), { requests: 1, subscribes: 1 });
    let devices; if (!built) { devices = (await store.read(source)).push.devices.filter(d => d.endpoint === fake.endpoint); assert.equal(devices.length, 1); assert.equal(devices[0].userId, admin.user.id); }
    await page.reload(); await readySettings();
    await expect(disconnect).toBeVisible(); assert.equal(explicit, 1);
    await page.screenshot({ path: resolve(output, `${engine}-shared-enabled.png`), fullPage: true });
    await disconnect.click();
    await expect(connect).toBeVisible();
    for (const section of ['work', 'operator']) {
      await open(section); await expect(connect).toBeEnabled();
    }
    if (!built) { devices = (await store.read(source)).push.devices.filter(d => d.endpoint === fake.endpoint); assert.equal(devices.length, 0); } assert.equal(deletion, 1); assert.equal(explicit, 1);

    // Desktop, narrow mobile, drawer-only shipments and collapsed sidebar.
    for (const width of [320,390,600,760,761,1024,1470,1920]) {
      await page.setViewportSize({ width, height: 950 });
      for (const section of ['work','invoices','operator','shipments']) {
        if (section === 'operator') {
          await go(section);
          await page.getByRole('tab',{name:/^Задания/}).click();
          const statuses = page.locator('.operator-controls .operator-plan-heading .button');
          await expect(statuses).toHaveCount(2);
          const bb = await statuses.evaluateAll(items=>items.map(e=>{const r=e.getBoundingClientRect(); return {top:r.top,bottom:r.bottom,left:r.left,right:r.right}}));
          assert.ok(Math.abs(bb[0].top-bb[1].top)<1 && bb[1].left>bb[0].right, 'Statuses must share one horizontal row');
          await statuses.nth(1).click(); await expect(statuses.nth(1)).toHaveAttribute('aria-pressed','true');
          await statuses.nth(0).click();
          if ([320,390,600,1470].includes(width)) await page.screenshot({path:resolve(output,`${engine}-operator-status-${width}.png`)});
        }
        await open(section);
        await expect(page.locator('.workspace-main .driver-notification-button')).toHaveCount(0);
        await expect(gear).toHaveCount(1);
        await expect(page.locator('.sidebar-user-controls button[aria-label="Выйти"]')).toHaveText('');
        const geometry = await settingsPage.boundingBox(); assert.ok(geometry.x >= 0 && geometry.x + geometry.width <= width + 1);
        const profile = await profileCard.boundingBox(), alerts = await notifications.boundingBox();
        if (width <= 600) assert.ok(alerts.y > profile.y && Math.abs(profile.x - alerts.x) < 2, 'Cards are stacked at mobile widths');
        if (width >= 1470) assert.ok(alerts.x > profile.x && Math.abs(profile.y - alerts.y) < 2, 'Cards are side by side on desktop');
        await settingsPage.getByRole('textbox', { name: 'Имя в CRM', exact: true }).focus();
        await page.keyboard.press('Tab');
        assert.equal(await settingsPage.evaluate(el => el.contains(document.activeElement)), true);
        if (width <= 760) {
          await settingsPage.getByRole('button', { name: 'К уведомлениям', exact: true }).click();
          await expect(notifications).toBeFocused();
        }
        assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
        if ([320,1470].includes(width) && section==='operator') await page.screenshot({path:resolve(output,`${engine}-settings-${width}.png`), fullPage: true});
        await openMenu();
        const boxes = await page.locator('.sidebar-user-controls').evaluate(el => { const r=el.getBoundingClientRect(); return [...el.querySelectorAll('.sidebar-account-action')].map(b=>{const q=b.getBoundingClientRect();return {width:q.width,height:q.height,fits:q.left>=r.left&&q.right<=r.right+1};}); });
        assert.ok(boxes.every(b=>b.width>=40&&b.height>=40&&b.fits));
        report.checks.push({engine,width,section,passed:true});
      }
    }
    await go('work');
    await page.getByRole('button',{name:'Свернуть панель',exact:true}).click();
    await open('work');
    const collapsed = await page.locator('.sidebar-bottom .sidebar-settings-link, .sidebar-bottom [aria-label="Выйти"]').evaluateAll(items=>items.map(e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom}}));
    assert.equal(collapsed.length, 2);
    assert.ok(collapsed[1].top >= collapsed[0].bottom);
    await page.screenshot({path:resolve(output,`${engine}-sidebar-collapsed.png`)});
    await page.getByRole('button',{name:'Развернуть панель',exact:true}).click();
    const auditSidebar = await new AxeBuilder({page}).include('.sidebar').analyze(); report.axe.push({engine,section:'sidebar',violations:auditSidebar.violations}); assert.deepEqual(auditSidebar.violations,[]);
    await page.route('**/api/auth/logout', route=>route.fulfill({json:{ok:true}}));
    await page.locator('.sidebar-user-controls button[aria-label="Выйти"]').click();
    await expect(page.getByRole('button',{name:'Войти',exact:true})).toBeVisible();
    report.checks.push({ engine, explicit, deletion, writes, result: 'source settings persist separately from device registration; one disable removes the shared device' });
    console.log('PASS', engine, report.checks.at(-1).result);
    await context.close(); await browser.close(); browser = null;
  }
  assert.deepEqual(report.errors, []); report.passed = true;
} finally {
  await browser?.close(); await server.close(); await rm(temporary, { recursive: true, force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}

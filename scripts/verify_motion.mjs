// Actual motion frames in isolated Chromium/WebKit. Synthetic data; no provider calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { chromium, webkit, expect } from '@playwright/test';

const root = resolve(process.env.QA_ROOT || resolve(import.meta.dirname, '..'));
const [{ OperationsStore }, { SabyClient, sabyConfigFromEnv }, { startTripsQaServer, writeTripsQaSnapshot }, { authenticateContext, bootstrapQaAuth }] = await Promise.all([
  'server/operations-store.ts', 'server/saby-client.ts', 'scripts/qa-trips-runtime.mjs', 'scripts/qa-auth.mjs',
].map(file => import(pathToFileURL(resolve(root, file)).href)));
const output = resolve(root, 'qa/motion-20261007' + (process.env.QA_OUTPUT_SUFFIX || ''));
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-motion-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
const source = await writeTripsQaSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const report = { fixtureOnly: true, workingStoreAccessed: false, providerCalls: 0, checks: [], frames: [], screenshots: [], errors: [], externalRequests: [], status: 'running' };
const pass = text => { report.checks.push(text); console.log('PASS', text); };
await mkdir(output, { recursive: true });
const company = (id, name, role) => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
await store.mutate(source, data => {
  data.sourceOperationsCleared = true; data.shipments = {}; data.paymentAllocations = [];
  data.companies = [company('qa-supplier', 'QA Поставщик', 'supplier'), company('qa-customer', 'QA Клиент', 'customer')];
  data.directories = {
    fleetSeedApplied: true, managers: [{ id: 'qa-manager', name: 'QA Сотрудник' }],
    products: [{ id: 'qa-product', name: 'QA Дизель', transportProductKind: 'diesel', cargoPackaging: 'bulk' }],
    paymentForms: [{ id: 'qa-payment', name: 'б/нал' }], vehicles: [{ id: 'qa-vehicle', plate: 'Т000ЕЕ00', capacityLitres: '20000' }],
    drivers: [{ id: 'qa-driver', name: 'QA Водитель', vehicleId: 'qa-vehicle' }],
    oilDepots: [{ id: 'qa-depot', name: 'QA Нефтебаза', address: 'Синтетическая нефтебаза, 1', ownerCompanyId: 'qa-supplier', loadingActorCompanyId: 'qa-supplier', infrastructureOwnerCompanyId: 'qa-supplier' }],
    addresses: [{ id: 'qa-address', companyId: 'qa-customer', name: 'QA Выгрузка', kind: 'delivery', address: 'Синтетическая улица, 1' }],
    customerManagers: [{ companyId: 'qa-customer', managerId: 'qa-manager' }], defaults: { profit: 'template-payment-form' }, duplicates: [],
  };
  return { changed: true, result: null };
});

// Pause an actual browser animation and read computed frames; a CSS declaration alone is insufficient.
async function frames(locator, name, closing = false) {
  const result = await locator.evaluate((element, { name, closing }) => {
    const animation = element.getAnimations().find(item => item.animationName === name);
    if (!animation) return { found: false, state: element.dataset.modalMotion, css: getComputedStyle(element).animationName };
    const duration = Number(animation.effect.getTiming().duration);
    const frame = time => { animation.currentTime = time; const style = getComputedStyle(element); return { opacity: Number(style.opacity), transform: style.transform }; };
    animation.pause();
    const start = frame(0), middle = frame(duration / 2), end = frame(duration - .01);
    const open = element.open, inert = element.inert, locked = document.body.style.overflow;
    animation.finish();
    return { found: true, duration, start, middle, end, open, inert, locked, closing };
  }, { name, closing });
  assert.ok(result.found, `${name}: actual animation exists: ${JSON.stringify(result)}`);
  assert.ok(result.duration >= 100 && result.duration <= 400, `${name}: bounded duration`);
  assert.ok(result.middle.opacity > 0 && result.middle.opacity < 1, `${name}: intermediate opacity`);
  assert.ok(closing ? result.start.opacity > result.end.opacity : result.start.opacity < result.end.opacity, `${name}: expected direction`);
  if (name.startsWith('modal-')) {
    assert.equal(result.open, true, `${name}: native top layer remains open`);
    assert.equal(result.locked, 'hidden', `${name}: background scroll remains locked`);
    if (closing) assert.equal(result.inert, true, `${name}: exit cannot submit again`);
  }
  report.frames.push({ name, ...result });
  return result;
}
async function finishAnimations(page) {
  await page.evaluate(() => document.getAnimations().forEach(animation => { if (animation.effect?.getTiming().iterations !== Infinity) animation.finish(); }));
}
async function openDialog(page, trigger, selector, touch = false) {
  await trigger.focus();
  if (touch) await trigger.tap();
  else await trigger.evaluate(element => element.click());
  const dialog = page.locator(selector);
  await expect(dialog).toBeVisible();
  await frames(dialog, 'modal-enter');
  return dialog;
}
async function closeDialog(page, dialog, trigger, method = 'escape', keyboardFocus = true) {
  if (method === 'escape') await page.keyboard.press('Escape');
  else await dialog.getByRole('button', { name: method, exact: true }).evaluate(element => element.click());
  await frames(dialog, 'modal-exit', true);
  await expect(dialog).not.toBeVisible();
  if (keyboardFocus) await expect(trigger).toBeFocused();
  assert.equal(await page.evaluate(() => document.body.style.overflow), '', 'Last modal restores scroll');
}
let runtime, browser;
try {
  const client = new SabyClient(sabyConfigFromEnv({}), async () => { report.providerCalls++; throw new Error('External provider forbidden'); });
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient: client });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const call = async (path, method = 'GET', body) => {
    const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, Origin: runtime.base, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const value = await response.json(); assert.ok(response.ok, `${method} ${path}: ${value.error || response.status}`); return value;
  };
  await call('/api/shipment-trips', 'POST', { idempotencyKey: randomUUID(), fields: {
    organization_id: 'artel', date: '2026-10-07', loading_at: '2026-10-07T09:00', supplier_id: 'qa-supplier', oil_depot_id: 'qa-depot', product_id: 'qa-product',
    purchase_price_unspecified_unit: '60000', quantity_tonnes: '8', driver_id: 'qa-driver', vehicle_id: 'qa-vehicle',
  }, customers: [{ fields: { customer_id: 'qa-customer', manager_id: 'qa-manager', payment_form_id: 'qa-payment', quantity_litres: '10000', sale_price_per_litre: '75', transport_amount: '1000', invoice_not_required: 'true', unloading_address_id: 'qa-address' } }] });
  const credential = await call('/api/drivers/qa-driver/access', 'POST', { action: 'issue', version: 0 });
  const tripResponse = await call('/api/shipment-trips'), original = tripResponse.trips[0];
  const variants = ['old', 'newest', 'middle'].map((label, index) => ({ ...original, id: 'qa-' + label, createdAt: ['2026-10-05T09:00:00Z', '2026-10-07T09:00:00Z', '2026-10-06T09:00:00Z'][index], fields: { ...original.fields, date: ['2026-10-20', '2026-10-01', '2026-10-10'][index], trip_notes: 'QA-' + label } }));
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    browser = await launcher.launch({ headless: true });
    for (const width of [390, 1440]) {
      const label = `${engine} ${width}`;
      const context = await browser.newContext({ viewport: { width, height: 950 }, hasTouch: width === 390, isMobile: width === 390, reducedMotion: 'no-preference', timezoneId: 'Europe/Moscow', serviceWorkers: 'block' });
      await authenticateContext(context, runtime.base, cookie);
      await context.route('**/*', route => {
        if (new URL(route.request().url()).origin === runtime.base) return route.continue();
        report.externalRequests.push(route.request().url()); return route.abort();
      });
      const page = await context.newPage();
      page.on('pageerror', error => report.errors.push(`${label}: ${error.message}`));
      let visits = 0;
      const visit = async (route, selector) => { await page.goto(runtime.base + '/?motion=' + ++visits + '#' + route); await page.locator(selector).waitFor(); await finishAnimations(page); };

      await visit('trips', '.trips-list');
      const addTrip = page.getByRole('button', { name: 'Новый рейс', exact: true });
      let dialog = await openDialog(page, addTrip, '.shipment-trip-editor', width === 390);
      assert.ok(await dialog.evaluate(element => element.scrollWidth <= element.clientWidth + 1), `${label}: trip modal fits`);
      if (width === 390) { const path = resolve(output, `${engine}-mobile-trip-modal.png`); await page.screenshot({ path }); report.screenshots.push(path); }
      // Safari intentionally blurs buttons on touch; keyboard openings below still require focus restoration.
      await closeDialog(page, dialog, addTrip, 'escape', width !== 390);
      // A second opening must animate again after React cleanup and restore focus again.
      dialog = await openDialog(page, addTrip, '.shipment-trip-editor');
      await closeDialog(page, dialog, addTrip, 'Отмена');
      pass(`${label}: trip editor entry/exit frames, repeat open, Escape/button and focus`);

      await page.route('**/api/shipment-trips', route => route.fulfill({ json: { ...tripResponse, trips: variants } }));
      await visit('trips', '.trips-list');
      await expect(page.getByTestId('trip-card')).toHaveCount(3);
      const labels = await page.getByTestId('trip-card').allTextContents();
      assert.ok(labels[0].includes('QA-newest') && labels[1].includes('QA-middle') && labels[2].includes('QA-old'), `${label}: creation time beats scheduled date`);
      await page.getByRole('textbox', { name: 'Поиск рейса', exact: true }).fill('QA-');
      await expect(page.getByTestId('trip-card').first()).toContainText('QA-newest');
      await page.unroute('**/api/shipment-trips');
      pass(`${label}: newest-first trips survive scrambled response and search`);

      await visit('shipments', '.shipment-grid');
      await expect(page.getByTestId('shipment-row')).toHaveCount(1);
      const ledger = () => page.locator('.shipment-grid, .shipment-grid *').evaluateAll(elements => elements.map(element => {
        const r = element.getBoundingClientRect(), table = element.closest('.shipment-grid').getBoundingClientRect(), style = getComputedStyle(element);
        return { tag: element.tagName, box: [r.x - table.x, r.y - table.y, r.width, r.height].map(value => Math.round(value * 100) / 100), css: Object.fromEntries(['font', 'color', 'backgroundColor', 'border', 'borderRadius', 'padding', 'margin', 'boxShadow', 'display', 'gap', 'transition', 'animation', 'transform'].map(key => [key, style[key]])) };
      }));
      const withMotion = await ledger();
      const motionStyle = page.locator('style[data-vite-dev-id$="/motion.css"]');
      await expect(motionStyle).toHaveCount(1);
      await motionStyle.evaluate(element => { element.sheet.disabled = true; });
      const withoutMotion = await ledger();
      await motionStyle.evaluate(element => { element.sheet.disabled = false; });
      assert.deepEqual(withMotion, withoutMotion, `${label}: protected ledger identical with motion stylesheet disabled`);
      pass(`${label}: protected shipment ledger geometry and computed styles unchanged`);
      const addShipment = page.getByRole('button', { name: 'Добавить отгрузку', exact: true });
      dialog = await openDialog(page, addShipment, '.shipment-editor');
      await closeDialog(page, dialog, addShipment);
      const filter = page.getByRole('button', { name: 'Фильтр: Товар', exact: true });
      await filter.scrollIntoViewIfNeeded();
      dialog = await openDialog(page, filter, '.shipment-filter-dialog');
      await closeDialog(page, dialog, filter);
      pass(`${label}: shipment editor and portal column filter animate both ways`);

      await visit('directories', '.directory-list');
      const addDirectory = page.getByRole('button', { name: 'Добавить', exact: true });
      dialog = await openDialog(page, addDirectory, '.directory-editor');
      await closeDialog(page, dialog, addDirectory);
      const removeDirectory = page.getByRole('button', { name: 'Удалить: QA Клиент', exact: true });
      dialog = await openDialog(page, removeDirectory, '.directory-delete-dialog');
      await closeDialog(page, dialog, removeDirectory);
      const segments = page.locator('.directory-tabs');
      await segments.getByRole('button', { name: 'Поставщики', exact: true }).evaluate(element => element.click());
      const segment = await segments.locator('.scrollable-segments-selection').evaluate(element => {
        const animations = element.getAnimations();
        const animation = animations.find(item => item.transitionProperty === 'transform');
        if (!animation) return { animated: false };
        animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
        const transform = getComputedStyle(element).transform; animation.finish(); return { animated: true, transform };
      });
      assert.ok(segment.animated, `${label}: selected segment physically transitions`);
      pass(`${label}: directory dialogs and segment selection`);

      await visit('work', '.work-layout');
      const task = page.getByRole('button', { name: 'Новая задача', exact: true });
      dialog = await openDialog(page, task, '.work-editor');
      await closeDialog(page, dialog, task);
      dialog = await openDialog(page, task, '.work-editor');
      const taskTitle = `QA motion ${label}`;
      await dialog.getByRole('textbox', { name: 'Название', exact: true }).fill(taskTitle);
      await page.keyboard.press('Escape');
      await expect(dialog).toBeVisible();
      await expect(dialog.getByText('Закрыть без сохранения изменений?', { exact: true })).toBeVisible();
      assert.notEqual(await dialog.getAttribute('data-modal-motion'), 'closing', `${label}: dirty guard retains editable modal`);
      await dialog.getByRole('button', { name: 'Продолжить редактирование', exact: true }).click();
      let saves = 0;
      const countSave = request => { if (request.method() === 'POST' && new URL(request.url()).pathname === '/api/work/tasks') saves++; };
      page.on('request', countSave);
      await dialog.getByRole('button', { name: 'Сохранить', exact: true }).evaluate(element => { element.click(); element.click(); });
      await page.waitForFunction(() => document.querySelector('.work-editor')?.dataset.modalMotion === 'closing');
      await frames(dialog, 'modal-exit', true);
      await expect(dialog).not.toBeVisible(); await expect(task).toBeFocused();
      page.off('request', countSave);
      assert.equal(saves, 1, `${label}: double submit commits once`);
      await expect(page.getByText(taskTitle, { exact: true })).toBeVisible();
      pass(`${label}: dirty Escape guarded; successful double-click save exits once and preserves result`);
      const reminder = page.getByRole('button', { name: /^Напоминания/ }).first();
      dialog = await openDialog(page, reminder, '.driver-notifications-dialog');
      await closeDialog(page, dialog, reminder);
      await expect(page.locator('.driver-notifications-dialog')).toHaveCount(1);
      dialog = await openDialog(page, reminder, '.driver-notifications-dialog');
      await closeDialog(page, dialog, reminder, 'Закрыть настройки уведомлений');
      pass(`${label}: work editor and persistent reminder dialog`);

      await visit('china', '.china-table');
      const payment = page.getByRole('button', { name: 'Добавить платёж', exact: true });
      dialog = await openDialog(page, payment, '.china-editor');
      await closeDialog(page, dialog, payment);
      pass(`${label}: China editor enter/exit`);

      await page.evaluate(() => { location.hash = '#trips'; });
      await expect(page.locator('h1').first()).toHaveText('Рейсы');
      const pageFrames = await frames(page.locator('.page-content'), 'surface-appear');
      assert.equal(pageFrames.middle.transform, 'none', `${label}: page fade never captures fixed panels with transformed ancestor`);
      pass(`${label}: route changes animate actual opacity frames without ancestor transforms`);

      if (width === 390) {
        const menu = page.getByRole('button', { name: 'Открыть меню', exact: true });
        await menu.focus(); await menu.evaluate(element => element.click());
        const drawer = page.locator('#app-navigation');
        const opening = await drawer.evaluate(element => {
          const animation = element.getAnimations().find(item => item.transitionProperty === 'transform');
          if (!animation) return false;
          animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
          const x = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41; animation.finish(); return x < 0 && x > -element.clientWidth;
        });
        assert.ok(opening, `${label}: drawer intermediate opening`);
        await page.keyboard.press('Escape');
        const closing = await drawer.evaluate(element => {
          const animation = element.getAnimations().find(item => item.transitionProperty === 'transform');
          if (!animation) return false;
          animation.pause(); animation.currentTime = Number(animation.effect.getTiming().duration) / 2;
          const x = new DOMMatrixReadOnly(getComputedStyle(element).transform).m41; animation.finish(); return x < 0 && x > -element.clientWidth;
        });
        assert.ok(closing, `${label}: drawer intermediate closing`);
        await expect(menu).toBeFocused();
        pass(`${label}: mobile sidebar intermediate enter/exit and focus restoration`);
      }

      await visit('trips', '.trips-list');
      await addTrip.hover();
      const box = await addTrip.boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await page.mouse.down();
      await page.waitForTimeout(60);
      const press = await addTrip.evaluate(element => ({ transform: getComputedStyle(element).transform, scale: getComputedStyle(element).scale, active: element.matches(':active') }));
      await page.mouse.move(0, 0); await page.mouse.up();
      assert.ok(press.active && (press.transform !== 'none' || press.scale !== 'none'), `${label}: press feedback ${JSON.stringify(press)}`);
      pass(`${label}: pressed controls visibly respond on touch-capable and desktop contexts`);

      await page.emulateMedia({ reducedMotion: 'reduce' });
      await addTrip.focus(); await addTrip.evaluate(element => element.click());
      dialog = page.locator('.shipment-trip-editor'); await expect(dialog).toBeVisible();
      assert.equal(await dialog.evaluate(element => getComputedStyle(element).animationName), 'none');
      await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible(); await expect(addTrip).toBeFocused();
      assert.equal(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length), 0);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${label}: no page overflow`);
      pass(`${label}: reduced motion closes cleanly without running animations`);
      await context.close();
    }

    const driver = await browser.newContext({ viewport: { width: 390, height: 950 }, isMobile: true, hasTouch: true, reducedMotion: 'no-preference', serviceWorkers: 'block' });
    await driver.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
    assert.equal((await driver.request.post(runtime.base + '/api/auth/login', { data: { login: credential.access.login, password: credential.temporaryPassword } })).status(), 200);
    const driverOriginal = (await (await driver.request.get(runtime.base + '/api/driver/trips')).json()).trips[0];
    const driverVariants = variants.map(item => ({ ...driverOriginal, id: item.id, date: item.fields.date, createdAt: item.createdAt, loadingAddress: item.fields.trip_notes }));
    await driver.route('**/api/driver/trips', route => route.fulfill({ json: { trips: driverVariants } }));
    const drivePage = await driver.newPage(); drivePage.on('pageerror', error => report.errors.push(`${engine} driver: ${error.message}`));
    await drivePage.goto(runtime.base + '/#driver-trips');
    await expect(drivePage.locator('.driver-trip-card')).toHaveCount(3);
    const driverLabels = await drivePage.locator('.driver-trip-card').allTextContents();
    assert.ok(driverLabels[0].includes('QA-newest') && driverLabels[1].includes('QA-middle') && driverLabels[2].includes('QA-old'), `${engine}: driver newest-first`);
    await finishAnimations(drivePage);
    const screenshot = resolve(output, `${engine}-mobile-driver-list.png`); await drivePage.screenshot({ path: screenshot, fullPage: true }); report.screenshots.push(screenshot);
    const bell = drivePage.getByRole('button', { name: /^Настройки уведомлений/ });
    let dialog = await openDialog(drivePage, bell, '.driver-notifications-dialog');
    await closeDialog(drivePage, dialog, bell);
    dialog = await openDialog(drivePage, bell, '.driver-notifications-dialog');
    await closeDialog(drivePage, dialog, bell, 'Закрыть настройки уведомлений');
    await expect(drivePage.locator('.driver-notifications-dialog')).toHaveCount(1);
    await drivePage.locator('.driver-notifications-dialog').evaluate(element => { element.dataset.qaPersistent = 'yes'; });
    await drivePage.getByRole('button', { name: 'Архивные', exact: true }).evaluate(element => element.click());
    await frames(drivePage.locator('.driver-route-content'), 'surface-appear');
    await expect(drivePage.locator('.driver-notifications-dialog')).toHaveAttribute('data-qa-persistent', 'yes');
    pass(`${engine}: driver newest-first and persistent notification modal motion on mobile`);
    await driver.close(); await browser.close(); browser = undefined;
  }

  const modalFiles = [];
  for (const file of await readdir(resolve(root, 'web/src'))) {
    if (!file.endsWith('.tsx')) continue;
    const content = await readFile(resolve(root, 'web/src', file), 'utf8');
    if (!content.includes('<dialog')) continue;
    modalFiles.push(file); assert.ok(content.includes('useDialogMotion'), `${file}: all native modal owners use the shared lifecycle`);
    assert.ok(!content.includes('.showModal(') && !content.includes('.close()'), `${file}: no direct native lifecycle bypass`);
  }
  assert.ok(modalFiles.length >= 15); report.modalOwners = modalFiles;
  pass(`All ${modalFiles.length} native dialog owners use the shared motion lifecycle`);
  assert.deepEqual(report.errors, []); assert.deepEqual(report.externalRequests, []); assert.equal(report.providerCalls, 0);
  report.status = 'passed';
} finally {
  await browser?.close(); await runtime?.server.close();
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  await rm(temporary, { recursive: true, force: true });
}

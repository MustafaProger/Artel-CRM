import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { SabyClient } from '../server/saby-client.ts';
import { startTripsQaServer } from './qa-trips-runtime.mjs';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), built = process.argv.includes('--built');
const output = resolve(root, '.local/trip-copy-ui-revision3', built ? 'built' : 'source'); await mkdir(output, { recursive: true });
const rt = await integrationRuntime();
const report = { syntheticOnly: true, workingStoreAccessed: false, providerCalls: 0, checks: [], screenshots: [], browserErrors: [], axe: [] };
let runtime, browser;
const check = text => { report.checks.push(text); console.log('PASS', text); };
try {
  const client = new SabyClient(integrationConfig(), async () => { report.providerCalls++; throw new Error('Provider forbidden'); });
  runtime = await startTripsQaServer({ root, snapshotDirectory: rt.snapshotDirectory, operationsDirectory: resolve(rt.directory, 'store'), sabyClient: client });
  if (built) runtime.server.middlewares.stack.unshift({ route: '', handle(req, res, next) {
    const path = new URL(req.url, runtime.base).pathname; if (path.startsWith('/api/')) return next();
    const relative = path === '/' ? 'index.html' : path.slice(1); if (relative.includes('..')) return next();
    readFile(resolve(root, 'app-dist', relative)).then(body => { res.setHeader('Content-Type', relative.endsWith('.js') ? 'text/javascript' : relative.endsWith('.css') ? 'text/css' : 'text/html'); res.end(body); }).catch(() => next());
  } });
  const { cookie } = await bootstrapQaAuth(runtime.base);
  const call = async (path, method='GET', body) => {
    const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json(); assert.ok(response.ok, `${path} ${response.status}: ${result.error}`); return result;
  };
  const credentials = await call('/api/drivers/driver/access', 'POST', { action: 'issue', version: 0 });
  await rt.store.mutate(rt.source, data => { data.directories.vehicles.push({ id: 'idle-vehicle', plate: 'СВОБОДНАЯ777' }); return { result: null, changed: true }; });
  for (const [engine, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
    const fields = Object.fromEntries(['organization_id','supplier_id','carrier_id','oil_depot_id','product_id','purchase_price_unspecified_unit','driver_id','vehicle_id','additional_costs'].map(k => [k,rt.trip.fields[k]]));
    Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2026-10-27T12:30', trip_notes: `Синтетическая проверка процесса ${engine}` });
    const customers = rt.trip.customers.map(row => ({ fields: { ...Object.fromEntries(['customer_id','manager_id','payment_form_id','quantity_litres','sale_price_per_litre','transport_amount','unloading_address_id'].map(k => [k,row.fields[k]])), etrn_not_required: 'true', invoice_not_required: 'true' } }));
    const created = await call('/api/shipment-trips', 'POST', { fields, customers, idempotencyKey: randomUUID() });
    const id = created.trip.id;
    browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'America/Los_Angeles' }); await authenticateContext(context, runtime.base, cookie);
    const page = await context.newPage(); page.on('pageerror', e => report.browserErrors.push(e.message));
    await page.goto(runtime.base + '/#trips'); await page.getByRole('button', { name: 'В процессе', exact: true }).click();
    const panel = page.getByRole('region', { name: 'Процесс рейсов' });
    const card = panel.getByTestId('execution-trip').filter({ hasText: `Рейс №${created.trip.number}` });
    await expect(card).toContainText('Ждёт погрузки'); await expect(panel).not.toContainText('СВОБОДНАЯ777');
    const entry = card.locator('..'), copy = entry.locator('.execution-copy-summary');
    const expectedText = '27.10\nСинтетический поставщик 50000\nДТ\n8000 л ИП ПолучательТестовый Тест 60,00\n6000 л ИП ПолучательТестовый Тест 60,00\nТест 1000+1000';
    const beforeCopy = await rt.store.read(rt.source);
    if (engine === 'chromium') await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    else await page.evaluate(() => Object.defineProperty(navigator, 'clipboard', { configurable:true, value:{ writeText:async text => { window.copiedTripText=text; } } }));
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:1000});
      await copy.click();
      await expect(copy).toHaveAttribute('aria-label', /скопировано$/);
      await expect(card).not.toHaveAttribute('open');
      const text = await page.evaluate(engine => engine === 'chromium' ? navigator.clipboard.readText() : window.copiedTripText, engine);
      assert.equal(text, expectedText);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
      const copyBox=await copy.boundingBox(); assert.ok(copyBox.width>=44 && copyBox.height>=44);
    }
    await copy.focus(); await page.keyboard.press('Enter'); await expect(copy).toHaveAttribute('aria-label', /скопировано$/);
    await page.keyboard.press('Space'); await expect(card).not.toHaveAttribute('open');
    assert.deepEqual(await rt.store.read(rt.source), beforeCopy, 'copy does not change any store data');
    check(`${engine}: exact text, native Chromium clipboard, four widths, Enter/Space, closed card and unchanged store`);
    await page.evaluate(() => { window.savedClipboard=navigator.clipboard; Object.defineProperty(navigator,'clipboard',{ configurable:true,value:{writeText:async()=>{throw new Error('denied');}} }); });
    await copy.click(); await expect(entry.getByRole('alert')).toContainText('Не удалось скопировать');
    const fallback=entry.getByRole('textbox'); await expect(fallback).toHaveValue(expectedText); await fallback.focus();
    assert.equal(await fallback.evaluate(el=>el.selectionEnd-el.selectionStart),expectedText.length);
    await expect(card).not.toHaveAttribute('open');
    const failureAxe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
    assert.deepEqual(failureAxe.violations,[]); report.axe.push({engine,label:'copy failure',violations:failureAxe.violations});
    await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.savedClipboard}));
    await copy.click(); await expect(entry.getByRole('alert')).toHaveCount(0); await expect(copy).toHaveAttribute('aria-label', /скопировано$/);
    check(`${engine}: clipboard rejection, selectable fallback, recovery and axe`);
    const driverCopy = entry.locator('.execution-copy-driver');
    await expect(copy).toHaveText(''); await expect(driverCopy).toHaveText('');
    const expectedDriverText = 'Погрузка на Синтетическая нефтебаза от Синтетический поставщик\n\nИП ПолучательТестовый Тест 8000 л\nСинтетическая доставка\nЯндекс (поиск адреса): https://yandex.ru/maps/?text=%D0%A1%D0%B8%D0%BD%D1%82%D0%B5%D1%82%D0%B8%D1%87%D0%B5%D1%81%D0%BA%D0%B0%D1%8F+%D0%B4%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D0%BA%D0%B0\nПриёмщикТестовый Тест +70000000009\n\nИП ПолучательТестовый Тест 6000 л\nСинтетическая доставка\nЯндекс (поиск адреса): https://yandex.ru/maps/?text=%D0%A1%D0%B8%D0%BD%D1%82%D0%B5%D1%82%D0%B8%D1%87%D0%B5%D1%81%D0%BA%D0%B0%D1%8F+%D0%B4%D0%BE%D1%81%D1%82%D0%B0%D0%B2%D0%BA%D0%B0\nПриёмщикТестовый Тест +70000000009';
    for (const width of [320,390,768,1440]) {
      await page.setViewportSize({width,height:1000});
      await driverCopy.click(); await expect(driverCopy).toHaveAttribute('aria-label', /скопировано$/);
      assert.equal(await page.evaluate(engine => engine === 'chromium' ? navigator.clipboard.readText() : window.copiedTripText, engine), expectedDriverText);
      await expect(card).not.toHaveAttribute('open');
      const a=await copy.boundingBox(),b=await driverCopy.boundingBox(); assert.ok(a.x+a.width<=b.x && Math.abs(a.y-b.y)<1);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1));
      await page.screenshot({path:resolve(output,`${engine}-two-copy-buttons-${width}.png`),fullPage:true});
    }
    await driverCopy.focus(); await page.keyboard.press('Enter'); await expect(driverCopy).toHaveAttribute('aria-label', /скопировано$/);
    await page.keyboard.press('Space'); await expect(card).not.toHaveAttribute('open');
    assert.deepEqual(await rt.store.read(rt.source),beforeCopy);
    await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async()=>{throw new Error('denied');}}}));
    await driverCopy.click(); await expect(entry.locator('.execution-copy-fallback-driver textarea')).toHaveValue(expectedDriverText);
    await page.evaluate(() => Object.defineProperty(navigator,'clipboard',{configurable:true,value:window.savedClipboard}));
    await driverCopy.click(); await expect(entry.locator('.execution-copy-fallback-driver')).toHaveCount(0);
    check(`${engine}: driver text, two distinct labelled icons, adjacent buttons, four widths, keyboard, denied clipboard and unchanged data`);
    await card.locator('summary').first().click();
    await expect(card.getByRole('button', { name: 'Рейс выполнен', exact: true })).toHaveCount(0);
    check(`${engine}: fourth tab, grouping, idle vehicle, planned trip and completion gate`);
    await expect(panel.getByRole('button', { name: 'Прибыл на место доставки', exact: true })).toHaveCount(0);
    await expect(card.getByRole('button', {name:'Завершить доставку',exact:true}).first()).toBeDisabled();
    const controlStyles = await page.evaluate(() => {
      const style = selector => { const el = document.querySelector(selector), s = getComputedStyle(el); return { radius:s.borderRadius, background:s.backgroundColor, font:s.fontSize, height:el.getBoundingClientRect().height }; };
      return { top:style('.trips-section-tabs'), filter:style('.execution-filters'), topButton:style('.trips-section-tabs button'), filterButton:style('.execution-filters button') };
    });
    assert.deepEqual(controlStyles.filter, controlStyles.top);
    assert.deepEqual(controlStyles.filterButton, controlStyles.topButton);
    await card.locator('summary').first().click();
    assert.equal(await card.getAttribute('open'), null, 'reduced motion closes immediately');
    assert.equal(await card.evaluate(el => el.getAnimations().length), 0);
    await page.emulateMedia({ reducedMotion:'no-preference' });
    await card.locator('summary').first().click();
    const opening = await card.evaluate(el => {
      const a=el.getAnimations().find(a => a.effect.getKeyframes().some(k => k.height));
      if(!a) return null;
      a.pause(); a.currentTime=55; const early=el.getBoundingClientRect().height;
      a.currentTime=220; const late=el.getBoundingClientRect().height;
      a.play(); return {early,late};
    });
    assert.ok(opening && opening.late>opening.early+5, 'height grows through intermediate frames');
    await expect.poll(() => card.evaluate(el => el.getAnimations().length)).toBe(0);
    await card.locator('summary').first().click();
    const closing = await card.evaluate(el => {
      const a=el.getAnimations().find(a => a.effect.getKeyframes().some(k => k.height));
      if(!a) return null;
      a.pause(); a.currentTime=55; const early=el.getBoundingClientRect().height;
      a.currentTime=220; const late=el.getBoundingClientRect().height;
      const open=el.open, inert=el.querySelector('.animated-details-content').inert;
      a.play(); return {early,late,open,inert};
    });
    assert.ok(closing && closing.early>closing.late+5 && closing.open && closing.inert, 'closing animates and removes hidden controls from focus');
    await expect(card).not.toHaveAttribute('open');
    // Rapid reversal starts from the currently rendered height, without a jump or stuck open state.
    await card.locator('summary').first().click();
    await card.locator('summary').first().click({ force:true });
    await expect(card).not.toHaveAttribute('open');
    await card.locator('summary').first().focus(); await page.keyboard.press('Space');
    await expect(card.locator('summary').first()).toHaveAttribute('aria-expanded','true');
    await expect.poll(() => card.evaluate(el => el.getAnimations().length)).toBe(0);
    await page.emulateMedia({ reducedMotion:'reduce' });
    check(`${engine}: shared filter geometry, staff delivery UI, opening/closing frames, rapid reversal, keyboard and reduced motion`);

    const driver = await browser.newContext({ viewport: { width: 390, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'America/Los_Angeles' });
    const login = await driver.request.post(runtime.base + '/api/auth/login', { data: { login: credentials.access.login, password: credentials.temporaryPassword } }); assert.equal(login.status(),200);
    const dp = await driver.newPage(); await dp.clock.install(); dp.on('pageerror', e => report.browserErrors.push(e.message)); await dp.goto(runtime.base + `/#driver-trip/${id}`);
    const loading = dp.getByRole('region', { name: 'Действия на погрузке', exact: true });
    await expect(dp.getByRole('button', { name: 'Прибыл на место доставки', exact: true }).first()).toBeDisabled();
    await loading.getByRole('button', { name: 'Прибыл', exact: true }).click();
    await expect(loading).toContainText('Прибытие сохранено');
    await panel.getByRole('button', { name: 'Обновить', exact: true }).click(); await expect(card).toContainText('На погрузке');
    for (let i=0;i<customers.length;i++) await loading.getByLabel(`Масса нетто доставки ${i+1}, т`, { exact:true }).fill('1,234');
    await loading.getByRole('button', { name:'Убыл',exact:true }).click(); await expect(loading).toContainText('Убытие и все массы сохранены в CRM');
    await panel.getByRole('button', { name:'Обновить',exact:true }).click(); await expect(card.locator('.execution-stage')).toHaveText('В пути');
    const before = await rt.store.read(rt.source);
    const first = dp.locator('.driver-stop').nth(2);
    await first.getByRole('button', { name:'Прибыл на место доставки',exact:true }).click();
    await expect(first.getByRole('button',{name:'Подтвердить',exact:true})).toHaveCount(0);
    await expect(dp.locator('.execution-record')).toHaveCount(1);
    await dp.clock.fastForward(120_000); await expect(dp.locator('.execution-record')).toContainText('Прибыл 2 минуты назад');
    await expect(dp.locator('.execution-record')).not.toContainText('Водитель:');
    await panel.getByRole('button', { name:'Обновить',exact:true }).click(); await expect(card).toContainText('Доставлено 1 из 2');
    await expect(card.getByRole('button',{name:'Рейс выполнен',exact:true})).toHaveCount(0);
    await expect(card.locator('.execution-stage')).toHaveText('Доставляет');
    check(`${engine}: real UI arrival/departure, single-click driver first delivery and independent remaining customer`);
    for (const width of [320,390,768,1440]) {
      for (const [target,label] of [[page,'logistics'],[dp,'driver']]) {
        await target.setViewportSize({width,height:1000});
        assert.ok(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth+1), `${engine} ${label} fits ${width}`);
        const path=resolve(output,`${engine}-${label}-${width}.png`); await target.screenshot({path,fullPage:true}); report.screenshots.push(path);
      }
      check(`${engine}: both workspaces fit ${width}px`);
    }
    for (const [target,label] of [[page,'logistics'],[dp,'driver']]) {
      const results = await new AxeBuilder({page:target}).withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();
      report.axe.push({engine,label,violations:results.violations}); assert.deepEqual(results.violations,[],`${engine} ${label} axe`);
    }
    // The driver closes the last stop; neither UI sends a separate complete call.
    const second = card.getByRole('button',{name:'Завершить доставку',exact:true}); await second.click();
    await dp.reload(); await expect(dp.locator('.driver-execution-footer')).toContainText('Рейс завершён');
    await expect(card).toHaveCount(0);
    await panel.getByRole('button',{name:/^Завершённые/}).click(); await expect(card).toContainText('Завершён'); await copy.click(); await expect(copy).toHaveAttribute('aria-label', /скопировано$/);
    await page.reload(); await page.getByRole('button',{name:'В процессе',exact:true}).click(); await panel.getByRole('button',{name:/^Завершённые/}).click();
    await card.locator('summary').first().click(); await expect(card).not.toContainText('Водитель:'); await expect(card).toContainText('Прибыл');
    await dp.goto(runtime.base+'/#driver-trips'); await dp.getByRole('button',{name:'Обновить мои рейсы',exact:true}).click(); await dp.getByRole('button',{name:'Архивные',exact:true}).click(); await expect(dp.locator(`a[href="#driver-trip/${id}"]`)).toBeVisible();
    const after = await rt.store.read(rt.source); const {revision:_a,tripExecutions:_b,accounts:_c,...stableAfter}=after; const {revision:_d,tripExecutions:_e,accounts:_f,...stableBefore}=before; assert.deepEqual(stableAfter,stableBefore);
    assert.equal(after.tripExecutions[id].version,2); assert.equal(after.tripExecutions[id].completed.role,'logistics'); assert.equal(after.tripExecutions[id].completed.kind,undefined);
    check(`${engine}: staff final delivery, automatic closure, archive, reload, durable facts and all unrelated data exact`);
    await browser.close(); browser=null;
  }
  assert.equal(report.providerCalls,0); assert.deepEqual(report.browserErrors,[]); report.passed=true;
} catch(e) { report.error=String(e.stack||e); throw e; }
finally { await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)); if(browser) await browser.close(); if(runtime) await runtime.server.close(); await rt.close(); }

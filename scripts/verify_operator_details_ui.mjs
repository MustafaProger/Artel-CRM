// Compact operator UI acceptance. Temporary synthetic store, no browser business writes or external traffic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { OperationsStore } from '../server/operations-store.ts';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'operator-case-tables-'));
const output = resolve(process.env.ARTEL_OPERATOR_QA_OUTPUT || resolve(root, '.local/operator-details-ui', process.env.ARTEL_OPERATOR_QA_BUILT === '1' ? 'built' : 'source'));
await mkdir(output, { recursive: true });
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store'), source = await writeTripsQaSnapshot(snapshotDirectory);
const runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
const { cookie } = await runtime.bootstrap(), store = new OperationsStore(operationsDirectory);
const api = async (path, method = 'GET', body) => {
  const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify({ path, status: response.status, result })); return result;
};
const read = () => api('/api/operator');
const calendar = offset => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86400000));
const recipientId = randomUUID();
const plan = await api('/api/operator/plans', 'POST', { clientName: 'Синтетические таблицы', recipients: [{ id: recipientId, name: 'Учебный получатель', bank: 'Учебный банк', card: '0000', phone: '', details: '', limit: '10000000' }], idempotencyKey: randomUUID() });
const operation = async (name, carryovers) => {
  const work = await read(), current = work.plans.find(item => item.id === plan.id), service = work.services.find(item => item.name === 'ННК'), amount = carryovers ? '61200.00' : '64800.00';
  const saved = await api('/api/operator/refuellings', 'POST', { schemaVersion: 3, planId: current.id, planVersion: current.version, name, date: '2026-10-21', serviceId: service.id, serviceVersion: service.version ?? 0, discountPercent: service.discountPercent, litres: '900', pricePerLitre: '80', amount, amountMode: 'auto', comment: '', allocations: [{ kind: 'recipient', recipientId, amount }], ...(carryovers ? { carryovers } : {}), idempotencyKey: randomUUID() });
  if (!carryovers) await api(`/api/operator/refuellings/${saved.id}/payment`, 'PATCH', { version: 1, paid: true, idempotencyKey: randomUUID() });
  return (await read()).refuellings.find(item => item.id === saved.id);
};
const createCase = async (driver, kind, litres = '50') => {
  const row = await operation(driver), result = await api('/api/operator/cases', 'POST', { operationId: row.id, operationVersion: row.version, kind, ...(kind === 'return' ? { litres } : {}), idempotencyKey: randomUUID() });
  return (await read()).cases.find(item => item.id === result.id);
};
const task = async (entry, offset) => {
  await api(`/api/operator/cases/${entry.id}/task`, 'PATCH', { version: entry.version, dueDate: calendar(offset), comment: `Проверить остаток и связаться с водителем ${entry.source.driverName}.`, idempotencyKey: randomUUID() });
  return (await read()).cases.find(item => item.id === entry.id);
};
const settle = async (entry, method, litres) => {
  await api(`/api/operator/cases/${entry.id}/settle`, 'PATCH', { version: entry.version, method, ...(litres ? { litres } : {}), idempotencyKey: randomUUID() });
  return (await read()).cases.find(item => item.id === entry.id);
};
let returning = await createCase('Учебный возврат частично', 'return', '100'); returning = await task(returning, 1); returning = await task(returning, 0); returning = await settle(returning, 'fuel', '10');
let overdue = await createCase('Учебный возврат просрочен', 'return'); overdue = await task(overdue, -1);
await createCase('Учебный возврат без задания', 'return');
let money = await createCase('Учебный возврат деньгами', 'return'); money = await settle(money, 'money');
const credited = await createCase('Учебный возврат зачтён', 'return'); await operation(credited.source.driverName, [{ caseId: credited.id, version: credited.version, litres: '50' }]);
let deferred = await createCase('Учебная частичная заправка', 'deferred'); deferred = await task(deferred, 1); deferred = await settle(deferred, 'fuel', '800');
await createCase('Учебная заправка без задания', 'deferred');
let completed = await createCase('Учебная завершённая заправка', 'deferred'); completed = await task(completed, 0); await settle(completed, 'fuel', '900');
const usedPlan = (await read()).plans.find(item => item.id === plan.id);
await api(`/api/operator/plans/${plan.id}`, 'PATCH', { version: usedPlan.version, clientName: usedPlan.clientName, recipients: usedPlan.recipients.map(({ id, name, bank, card, phone, details, used }) => ({ id, name, bank, card, phone, details, limit: used })), idempotencyKey: randomUUID() });
await api('/api/operator/plans', 'POST', { clientName: 'Учебный клиент · приём оплаты', recipients: [{ id: randomUUID(), name: 'Учебный получатель первый', bank: 'Учебный банк', card: '0000', phone: '', details: '', limit: '120000' }, { id: randomUUID(), name: 'Учебный получатель второй', bank: 'Учебный банк', card: '0000', phone: '', details: '', limit: '130000' }], idempotencyKey: randomUUID() });
const fixture = await read(), operatorBefore = JSON.stringify((await store.read(source)).operator);
const report = { synthetic: true, mode: runtime.mode, artifacts: runtime.artifacts, checks: [], axe: [], screenshots: [], geometry: [], errors: [], browserMutations: [], externalRequests: [] };
let browser, page, engine;
const shot = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, fullPage: await page.locator('dialog[open]').count() === 0 }); report.screenshots.push(path); };
const check = label => { report.checks.push(`${engine}: ${label}`); console.log('PASS', engine, label); };
const choose = async (kind, status = 'open') => {
  await page.getByRole('tab', { name: new RegExp(kind === 'plans' ? '^Задания ·' : kind === 'return' ? '^Возвраты' : kind === 'deferred' ? '^Ожидают заправки' : '^Операции$') }).click();
  if (kind === 'plans') await page.getByRole('group', { name: 'Статус заданий', exact: true }).getByRole('button', { name: new RegExp(status === 'open' ? '^Активные ·' : '^Выполненные ·') }).click();
  else if (kind !== 'operations') await page.getByRole('group', { name: 'Состояние записей', exact: true }).getByRole('button', { name: new RegExp(status === 'open' ? '^Открытые ·' : '^Выполненные ·') }).click();
};
const audit = async label => { const r = await new AxeBuilder({page}).include('.operator-workspace').analyze(); report.axe.push({engine,label,violations:r.violations}); assert.deepEqual(r.violations,[]); };
const closeForm = async () => { const dialog=page.getByRole('dialog'); await dialog.getByRole('button',{name:'Закрыть',exact:true}).click(); await expect(dialog).toHaveCount(0); };
const drawer = () => page.locator('dialog.operator-details-drawer');
const closeDetails = async () => { await drawer().getByRole('button',{name:'Закрыть подробности'}).click(); await expect(drawer()).toHaveCount(0); };
try {
  for (const [name, launcher] of [['chromium',chromium],['webkit',webkit]].filter(([name])=>!process.env.ARTEL_OPERATOR_QA_ENGINE || name===process.env.ARTEL_OPERATOR_QA_ENGINE)) {
    engine=name; browser=await launcher.launch({headless:true});
    const context=await browser.newContext({viewport:{width:1440,height:900}, reducedMotion:'reduce',serviceWorkers:'block'});await authenticateContext(context,runtime.base,cookie);
    await context.route('**/*',route=> {const request=route.request(),url=new URL(request.url());if(url.origin!==runtime.base){report.externalRequests.push(url.origin);return route.abort();}if(url.pathname.startsWith('/api/operator')&&!['GET','HEAD'].includes(request.method())){report.browserMutations.push(url.pathname);return route.abort();}return route.continue();});
    page=await context.newPage();page.setDefaultTimeout(12000);page.on('pageerror',e=>report.errors.push(String(e)));await page.goto(runtime.base+'/#operator');
    for (const kind of ['plans','return','deferred']) for(const status of ['open','completed']) {
      await choose(kind,status);
      for(const width of [320,360,375,390,480,600,601,767,768,1024,1440,1920]) {
        await page.setViewportSize({width,height:900}); await page.evaluate(()=>scrollTo(0,0));
        const geometry=await page.evaluate(()=>{
          const box=s=>{const e=document.querySelector(s);if(!e)return null;const r=e.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right};};
          return {heading:box('.page-heading'),tabs:box('.operator-tabs'),toolbar:box('.operator-toolbar'),filter:box('.operator-plan-heading,.operator-case-filters'),sectionHeading:box('.operator-task-section > h2,.operator-cases-heading'),cards:box('.operator-card-grid'),overflow:document.documentElement.scrollWidth>innerWidth+1};
        });
        report.geometry.push({engine,kind,status,width,...geometry});assert.equal(geometry.overflow,false);
        assert.ok(geometry.toolbar.top>=geometry.tabs.bottom+15,'Room between tabs and toolbar');
        if(width<=600) { assert.ok(geometry.filter.top>=geometry.tabs.bottom+15,'Mobile status below tabs'); assert.ok(geometry.toolbar.left>=geometry.filter.right+9,'Mobile filters beside toolbar'); }
        else assert.ok(geometry.filter.top>=geometry.toolbar.bottom,'Desktop status below toolbar');
        const precedingBottom=Math.max(geometry.toolbar.bottom,geometry.filter.bottom);
        assert.ok(geometry.sectionHeading.top>=precedingBottom+15 && geometry.sectionHeading.top<=precedingBottom+23,'Compact consistent gap before section heading');
        assert.ok(geometry.cards.top>=geometry.filter.bottom,'Cards below status');
        await expect(page.locator('.operator-card > .operator-plan-details,.operator-card > .operator-case-origin,.operator-card > .operator-case-history,.operator-card > .operator-case-task')).toHaveCount(0);
        await expect(page.locator('.operator-plan-card > footer')).toHaveCount(await page.locator('.operator-plan-card').count());
        await expect(page.locator('.operator-card .operator-case-task-button')).toHaveCount(0);
        const statusSize=await page.locator('.operator-plan-heading button').first().boundingBox();assert.ok(statusSize.height >= (width<=600?40:46));
        const colours=await page.locator('.operator-card-actions button').evaluateAll(buttons=>buttons.map(button=>({kind:button.className,bg:getComputedStyle(button).backgroundColor})));for(const colour of colours){if(colour.kind.includes('operator-fuel-action'))assert.equal(colour.bg,'rgb(232, 241, 251)');if(colour.kind.includes('operator-edit-action')||colour.kind.includes('operator-return-action'))assert.equal(colour.bg,'rgb(255, 243, 223)');if(colour.kind.includes('operator-operations-action'))assert.equal(colour.bg,'rgb(228, 243, 233)');}
        const totalsFit=await page.locator('.operator-plan-card .operator-plan-totals').evaluateAll(totals=>totals.every(total=>[...total.querySelectorAll('span,strong')].every(el=>el.scrollWidth<=el.clientWidth+1)));assert.ok(totalsFit,'Full labels and money fit their columns');
        const headerFits=await page.locator('.operator-card').evaluateAll(cards=>cards.every(card=>{const button=card.querySelector('.operator-details-button').getBoundingClientRect(),header=card.querySelector('header').getBoundingClientRect();return button.width>=44&&button.height>=44&&button.right<=header.right+1;}));assert.ok(headerFits); const actions=await page.locator('.operator-card > .operator-card-actions').evaluateAll(rows=>rows.map(row=>({row:row.getBoundingClientRect().width,buttons:[...row.querySelectorAll('button')].map(b=>({w:b.getBoundingClientRect().width,h:b.getBoundingClientRect().height,color:getComputedStyle(b).backgroundColor}))})));for(const a of actions){assert.ok(a.buttons.every(b=>b.h>=38 && b.h<=40));assert.ok(Math.abs(a.buttons.reduce((n,b)=>n+b.w,0)+(a.buttons.length-1)*5-a.row)<2);if(a.buttons.length===2){assert.ok(Math.abs(a.buttons[0].w-a.buttons[1].w)<1);assert.notEqual(a.buttons[0].color,a.buttons[1].color);}}
        if([320,375,768,1440].includes(width)) await audit(`${kind}/${status}/${width}`);
        if([320,390,1440].includes(width))await shot(`${kind}-${status}-${width}`);
        check(`${kind}/${status}/${width}: order, compact content, touch target, no overflow`);
      }
    }
    for(const width of [320,375,768,1440]) {
      await page.setViewportSize({width,height:800});await choose('plans');
      const payment=page.locator('.operator-plan-card').first();
      await payment.getByRole('button',{name:/^Редактировать задание/}).click();await expect(page.getByRole('dialog',{name:'Редактирование задания'})).toBeVisible();assert.ok(await page.getByRole('dialog').evaluate(e=>e.getBoundingClientRect().right<=innerWidth&&e.getBoundingClientRect().left>=0));await closeForm();
      await payment.getByRole('button',{name:'Операции',exact:true}).click();await expect(page.getByRole('tab',{name:'Операции',exact:true})).toHaveAttribute('aria-selected','true');await choose('plans');
      const info=payment.getByRole('button',{name:/^Подробности задания/});await info.click();await expect(drawer()).toBeVisible();
      await expect(drawer()).toContainText('Реквизиты и лимиты');await expect(drawer()).toContainText('Учебный получатель первый');await expect(drawer()).toContainText('Кем оформлено');
      await audit(`payment drawer ${width}`);await shot(`payment-details-${width}`);
      const pos=await drawer().boundingBox();assert.ok(Math.abs(pos.x+pos.width-width)<2);assert.ok(pos.y<1&&pos.height>=799);
      assert.equal(await drawer().evaluate(e=>e.scrollWidth<=e.clientWidth),true);assert.equal(await page.evaluate(()=>document.body.style.overflow),'hidden');
      await page.keyboard.press('Escape');await expect(drawer()).toHaveCount(0);await expect(info).toBeFocused();
      await info.click();await drawer().getByRole('button',{name:/^Редактировать задание/}).click();await expect(page.getByRole('dialog',{name:'Редактирование задания'})).toBeVisible();await expect(drawer()).toHaveCount(0);await closeForm();await expect(info).toBeFocused();
      await info.click();await drawer().getByRole('button',{name:'Операции',exact:true}).click();await expect(page.getByRole('tab',{name:'Операции',exact:true})).toHaveAttribute('aria-selected','true');await expect(drawer()).toHaveCount(0);
      await choose('return');await page.locator(`tr[data-case-id="${returning.id}"]`).getByRole('button',{name:/^Открыть карточку/}).click();await expect(page.locator(`#operator-case-${returning.id}`)).toBeFocused();const card=page.locator(`#operator-case-${returning.id}`),caseInfo=card.getByRole('button',{name:/^Подробности:/});
      await expect(card).toContainText('90 л');await expect(card).toContainText('6 480,00 ₽');await expect(card).toContainText('ННК');await expect(card).toContainText('10%');
      await caseInfo.click();await expect(drawer()).toContainText(returning.task.comment);await expect(drawer()).toContainText('Создал возврат');await expect(drawer()).toContainText('История исполнения');await expect(drawer().getByText('Заправка выполнена',{exact:true})).toBeVisible();await expect(drawer().locator('details[open]')).toHaveCount(2);await drawer().getByText('История исполнения',{exact:false}).click();await expect(drawer().getByText('Заправка выполнена',{exact:true})).not.toBeVisible();await drawer().getByText('История исполнения',{exact:false}).click();await audit(`case drawer ${width}`);await shot(`case-details-${width}`);
      // Native modal focus cannot escape into the underlying workspace.
      await drawer().getByRole('button',{name:'Изменить задание',exact:true}).focus();await page.keyboard.press(engine==='webkit'?'Alt+Tab':'Tab');assert.ok(await drawer().evaluate(e=>e.contains(document.activeElement)));
      await closeDetails();await expect(caseInfo).toBeFocused();
      for (const [action,title] of [['Изменить задание','Задание на возврат'],['Исходная операция','Операция']]) {
        await caseInfo.click();await drawer().getByRole('button',{name:action,exact:true}).click();await expect(page.getByRole('dialog',{name:title,exact:true})).toBeVisible();await expect(drawer()).toHaveCount(0);await closeForm();await expect(caseInfo).toBeFocused();
      }
      for (const [action,title] of [['Вернуть деньги','Отметить выполненный перевод'],['Отметить заправку','Отметить заправку']]) {
        await card.getByRole('button',{name:action,exact:true}).click();await expect(page.getByRole('dialog',{name:title,exact:true})).toBeVisible();await closeForm();await expect(card.getByRole('button',{name:action,exact:true})).toBeFocused();
      }
      await choose('return','completed');await page.locator('.operator-case-card').first().getByRole('button',{name:/^Подробности:/}).click();await expect(drawer().getByRole('button',{name:'Изменить задание'})).toHaveCount(0);await closeDetails();
      await choose('deferred');const unplanned=page.locator('.operator-case-card').filter({hasText:'Учебная заправка без задания'});await unplanned.getByRole('button',{name:/^Подробности:/}).click();await drawer().getByRole('button',{name:'Поставить задание',exact:true}).click();await expect(page.getByRole('dialog',{name:'Задание на заправку',exact:true})).toBeVisible();await closeForm();
      check(`${width}: details, history, edit/source/operations navigation, settlement forms, completed/unplanned, focus, keyboard, axe`);
    }
    await choose('operations');
    for (const width of [320,390,600,601,768,1024,1100,1101,1440,1920]) {
      await page.setViewportSize({width,height:900});
      const filters=page.locator('.operator-filters');
      const payment=await filters.getByRole('combobox',{name:/^Оплата/}).boundingBox(), taskFilter=await filters.getByRole('combobox',{name:'Фильтр по заданию'}).boundingBox();
      assert.ok(Math.abs(payment.y-taskFilter.y)<1 && taskFilter.x>=payment.x+payment.width+9,'Task filter is to the right of payment at '+width);
      assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1),false);
      await filters.getByRole('combobox',{name:'Фильтр по заданию'}).selectOption(plan.id);
      await expect(page.locator('.operator-selection')).toContainText(usedPlan.clientName);
      await filters.getByRole('combobox',{name:'Фильтр по заданию'}).selectOption('');
      if([320,390,1440].includes(width)){await audit(`journal filters ${width}`);await shot(`journal-filters-${width}`);}
      check(`${width}: payment and task filters share row, filter works, no overflow`);
    }
    await page.setViewportSize({width:1440,height:800});await page.emulateMedia({reducedMotion:'no-preference'});await choose('plans');
    await page.locator('.operator-plan-card').first().getByRole('button',{name:/^Подробности/}).click();await expect(drawer()).toHaveAttribute('data-modal-motion','open');assert.equal(await drawer().evaluate(e=>getComputedStyle(e).getPropertyValue('--modal-x').trim()),'100%');
    await page.mouse.click(30,400);await expect(drawer()).toHaveCount(0);assert.equal(await page.evaluate(()=>document.body.style.overflow),'');
    await page.locator('.operator-plan-card').first().getByRole('button',{name:/^Подробности/}).click();await expect(drawer()).toHaveAttribute('data-modal-motion','open');await page.emulateMedia({reducedMotion:'reduce'});assert.equal(await drawer().evaluate(e=>getComputedStyle(e).animationName),'none');await closeDetails();
    check('animated drawer, backdrop close, reduced motion, scroll restored');
    assert.equal(JSON.stringify((await store.read(source)).operator),operatorBefore);await context.close();await browser.close();browser=null;
  }
  assert.deepEqual(report.browserMutations,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;
} catch(error){report.failure=String(error.stack||error);if(page&&!page.isClosed())await shot('failure').catch(()=>{});throw error;}
finally{await browser?.close();await runtime.server.close();await rm(temporary,{recursive:true,force:true});await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));}
console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,axe:report.axe.length,screenshots:report.screenshots.length,report:resolve(output,'report.json')}));

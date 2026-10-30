import {chromium,webkit,expect as baseExpect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {authenticateContext} from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'), access=JSON.parse(await readFile(resolve(root,'../preview/access.json'),'utf8'));
const base=process.env.ARTEL_REVIEW_BASE||access.base, cookie=process.env.ARTEL_REVIEW_COOKIE||access.cookie;
const output=resolve(root,'../revision4/ui',process.env.ARTEL_REVIEW_BUILT?'built':'source');await mkdir(output,{recursive:true});
const expect=baseExpect.configure({timeout:20000});
const report={checks:[],axe:[],errors:[],synthetic:true};let browser,page;
const pass=name=>{report.checks.push(name);console.log('PASS',name)};
try{
for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
 browser=await launcher.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});await authenticateContext(context,base,cookie);
 await context.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));await page.goto(base+'/#operator');
 await expect(page.getByRole('button',{name:'Новая операция',exact:true})).toBeEnabled();
 let reads=0;await page.route('**/api/operator',async route=>{reads++;await new Promise(done=>setTimeout(done,4000));await route.continue()});
 const begin=Date.now();await page.getByRole('button',{name:'Новая операция',exact:true}).click();const dialog=page.getByRole('dialog');await expect(dialog).toBeVisible({timeout:1000});assert.ok(Date.now()-begin<1200);assert.equal(reads,0);await page.unroute('**/api/operator');
 await expect(dialog.getByRole('button',{name:'Обновить задания и справочники'})).toHaveCount(0);await dialog.getByLabel('Сервис',{exact:true}).selectOption('operator-service-rosneft');
 assert.equal(await dialog.getByLabel('Сервис',{exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(48, 54, 61)');
 await dialog.getByRole('button',{name:'Закрыть форму',exact:true}).click();await expect(dialog).toContainText('Закрыть форму без сохранения?');assert.ok((await dialog.boundingBox()).width<=480);
 await page.screenshot({path:resolve(output,`${engine}-discard.png`)});await dialog.getByRole('button',{name:'Продолжить ввод'}).click();await expect(dialog.getByLabel('Сервис',{exact:true})).toHaveValue('operator-service-rosneft');await dialog.getByRole('button',{name:'Закрыть форму',exact:true}).click();await dialog.getByRole('button',{name:'Не сохранять'}).click();await expect(dialog).toHaveCount(0);pass(`${engine}: immediate form, service color and compact discard`);
 for(const kind of ['Возвраты','Ожидают заправки']){
  await page.getByRole('tab',{name:new RegExp('^'+kind)}).click();await expect(page.getByText('Цена за литр:',{exact:false}).first()).toBeVisible();await page.getByRole('button',{name:/^Подробности:/}).first().click();await expect(page.getByRole('dialog')).toContainText('Получатели и реквизиты');await expect(page.getByRole('dialog')).toContainText('Позвонить перед заправкой');await page.getByRole('dialog').getByRole('button',{name:/Закрыть/}).first().click();
 }
 pass(`${engine}: return and deferred full operation details`);
 await page.getByRole('tab',{name:'Сверки',exact:true}).click();
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date());
 const filters=page.getByRole('group',{name:'Сервисы сверки'}), table=page.locator('.operator-reconciliation-table');
 assert.equal(await page.getByRole('tab').last().textContent(),'Сверки');
 await filters.getByRole('button',{name:'Роснефть',exact:true}).click();
 await expect(table.locator(`tr[data-date="${today}"]`)).toContainText('34 650,00');
 await expect(table.locator(`tr[data-date="${today}"] .is-matched`)).toHaveCount(2);
 assert.equal(await filters.getByRole('button',{name:'Роснефть',exact:true}).evaluate(el=>getComputedStyle(el).backgroundColor),'rgb(48, 54, 61)');
 assert.equal(await filters.evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
 await filters.getByRole('button',{name:'Лукойл',exact:true}).click();await expect(table.locator(`tr[data-date="${today}"] .is-different`)).toHaveCount(2);
 await expect(table.locator(`tr[data-date="${today}"]`)).toContainText('150,00');
 await filters.getByRole('button',{name:'ННК',exact:true}).click();await expect(table.locator(`tr[data-date="${today}"] .is-empty`)).toHaveCount(2);
 assert.equal(await table.locator(`tr[data-date="${today}"] .is-empty`).first().evaluate(el=>getComputedStyle(el).backgroundColor),'rgba(0, 0, 0, 0)');
 await filters.getByRole('button',{name:'ГПН',exact:true}).click();
 const day=table.locator(`tr[data-date="${today}"]`), card=page.locator('.operator-reconciliation-card');
 assert.equal(await day.locator('th small').count(),0);
 assert.ok((await day.boundingBox()).height<=44,'compact desktop row');
 assert.equal(await table.locator('thead tr').first().locator('th').nth(1).evaluate(el=>getComputedStyle(el).borderRightColor),'rgb(205, 217, 209)');
 await day.getByRole('button',{name:new RegExp(`отчёт ГПН за ${today}$`)}).click();
 await expect(page.getByRole('dialog')).toHaveCount(0);
 const litres=day.getByLabel('Литры из кабинета ГПН',{exact:true}), amount=day.getByLabel('Сумма из кабинета ГПН',{exact:true});
 await expect(litres).toBeFocused();await litres.fill('499');await amount.fill('34600');
 await page.getByRole('tab',{name:'Операции',exact:true}).click();await page.getByRole('tab',{name:'Сверки',exact:true}).click();await expect(litres).toHaveValue('499');
 await day.getByRole('button',{name:'Сохранить отчёт',exact:true}).click();await expect(day.locator('input')).toHaveCount(0);await expect(day.locator('.is-different')).toHaveCount(2);await expect(day).toContainText('50,00');
 await day.getByRole('button',{name:`История отчёта ГПН за ${today}`,exact:true}).click();await card.getByText(/История отчёта/).click();await expect(card.locator('li').first()).toContainText('499');
 await page.getByRole('button',{name:'Закрыть сверку'}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.reload();await page.getByRole('tab',{name:'Сверки',exact:true}).click();await filters.getByRole('button',{name:'ГПН',exact:true}).click();await expect(day).toContainText('50,00');pass(`${engine}: compact rows, neutral separators, one-click inline save and persistence`);
 // Clicking a value focuses its own field; Escape or one cancel returns directly to the row.
 let writes=0;const countWrites=request=>{if(request.url().includes('/api/operator/reconciliations')&&['POST','PATCH'].includes(request.method()))writes++};page.on('request',countWrites);
 await day.getByRole('button',{name:`Ввести сумму ГПН за ${today}`,exact:true}).click();await expect(amount).toBeFocused();await amount.fill('123');await page.keyboard.press('Escape');await expect(day.locator('input')).toHaveCount(0);
 await day.getByRole('button',{name:`Ввести литры ГПН за ${today}`,exact:true}).click();await litres.fill('123');await day.getByRole('button',{name:'Отменить ввод'}).click();await expect(day.locator('input')).toHaveCount(0);assert.equal(writes,0);page.off('request',countWrites);pass(`${engine}: direct cell editing and one-action cancellation without writes`);
 // The server saves, but the browser loses the response. Retry the identical request exactly once.
 const before=(await (await context.request.get(base+'/api/operator')).json()).reconciliations.find(r=>r.date===today&&r.serviceId==='operator-service-gpn');
 const bodies=[];let lose=true;
 await page.route('**/api/operator/reconciliations/**',async route=>{
  if(route.request().method()!=='PATCH')return route.continue();
  bodies.push(route.request().postData());
  if(lose){lose=false;await route.fetch();await route.abort('failed')}else await route.continue();
 });
 await day.getByRole('button',{name:`Ввести литры ГПН за ${today}`,exact:true}).click();await litres.fill('499');await amount.fill('34600');
 await day.getByRole('button',{name:'Сохранить отчёт',exact:true}).click();await expect(day.getByRole('button',{name:'Проверить сохранение',exact:true})).toBeVisible();await expect(litres).toBeDisabled();await expect(day.getByRole('button',{name:'Отменить ввод'})).toBeDisabled();
 await day.getByRole('button',{name:'Проверить сохранение',exact:true}).click();await expect(day.locator('input')).toHaveCount(0);assert.equal(bodies.length,2);assert.equal(bodies[0],bodies[1]);await page.unroute('**/api/operator/reconciliations/**');
 const after=(await (await context.request.get(base+'/api/operator')).json()).reconciliations.find(r=>r.id===before.id);assert.equal(after.version,before.version+1);pass(`${engine}: lost response retries identical request without duplicate history`);
 // Enter from conflicting filters; date navigation must select only the day's service.
 await page.getByRole('tab',{name:'Операции',exact:true}).click();await page.getByLabel('Поиск операций').fill('нет совпадений');await page.getByLabel('Оплата операций',{exact:true}).selectOption('unpaid');await page.getByLabel('Фильтр по заданию').selectOption({index:1});
 await page.getByRole('tab',{name:'Сверки',exact:true}).click();await table.getByRole('button',{name:`Операции ГПН за ${today}`,exact:true}).click();
 await expect(page.getByRole('tab',{name:'Операции',exact:true})).toHaveAttribute('aria-selected','true');await expect(page.getByRole('dialog')).toHaveCount(0);
 await expect(page.getByLabel('С даты',{exact:true})).toHaveValue(today);await expect(page.getByLabel('По дату',{exact:true})).toHaveValue(today);await expect(page.getByLabel('Сервис операций')).toHaveValue('operator-service-gpn');await expect(page.getByLabel('Поиск операций')).toHaveValue('');await expect(page.getByLabel('Оплата операций',{exact:true})).toHaveValue('all');await expect(page.getByLabel('Фильтр по заданию')).toHaveValue('');
 const journal=page.locator('.operator-desktop-journal');await expect(journal.locator('[data-operation-id]')).toHaveCount(1);await expect(journal).toContainText('Учебный водитель Роман');await expect(journal).not.toContainText('Учебный водитель Сергей');await journal.getByRole('button',{name:'Учебный водитель Роман',exact:true}).click();await expect(page.getByRole('dialog').getByLabel('Имя водителя',{exact:true})).toHaveValue('Учебный водитель Роман');await page.getByRole('button',{name:'Закрыть форму',exact:true}).click();
 await page.getByRole('tab',{name:'Сверки',exact:true}).click();pass(`${engine}: date opens operations tab with exact service/day and resets unrelated filters`);
 await page.getByLabel('Месяц сверки').fill('2026-02');await expect(table.locator('tbody tr')).toHaveCount(28);await expect(table.locator('.is-empty')).toHaveCount(56);await page.getByLabel('Месяц сверки').fill('2024-02');await expect(table.locator('tbody tr')).toHaveCount(29);await page.getByLabel('Месяц сверки').fill(today.slice(0,7));pass(`${engine}: calendar month, leap year and missing values`);
 // An empty day supports a real zero report, validation and a single history entry.
 const emptyDate=await table.locator('tr.is-empty-day').first().getAttribute('data-date'), emptyDay=table.locator(`tr[data-date="${emptyDate}"]`);
 await emptyDay.getByRole('button',{name:new RegExp(`Внести отчёт ГПН за ${emptyDate}$`)}).click();
 const emptyLitres=emptyDay.getByLabel('Литры из кабинета ГПН',{exact:true}), emptyAmount=emptyDay.getByLabel('Сумма из кабинета ГПН',{exact:true});
 writes=0;page.on('request',countWrites);await emptyDay.getByRole('button',{name:'Сохранить отчёт',exact:true}).click();assert.equal(writes,0);page.off('request',countWrites);
 await emptyLitres.fill('-1');await emptyAmount.fill('0');await emptyDay.getByRole('button',{name:'Сохранить отчёт',exact:true}).click();await expect(emptyDay.getByRole('alert')).toBeVisible();await expect(emptyLitres).toBeEnabled();
 await page.setViewportSize({width:390,height:1000});await expect(emptyLitres).toHaveValue('-1');await emptyLitres.fill('0');await emptyAmount.press('Enter');
 const savedEmpty=table.locator(`tr[data-date="${emptyDate}"]`);await expect(savedEmpty.locator('input')).toHaveCount(0);await expect(savedEmpty.locator('.is-matched')).toHaveCount(2);
 const zero=(await (await context.request.get(base+'/api/operator')).json()).reconciliations.find(r=>r.date===emptyDate&&r.serviceId==='operator-service-gpn');assert.equal(zero.litres,'0');assert.equal(zero.amount,'0');assert.equal(zero.history.length,1);pass(`${engine}: new empty-day report, required fields, negative rejection, zero and resize preserve input`);
 for(const width of [320,390,768,1440]){
  await page.setViewportSize({width,height:1000});await expect(table).toBeVisible();
  const refresh=page.getByRole('button',{name:'Обновить сверки',exact:true}), month=page.getByLabel('Месяц сверки');
  const rb=await refresh.boundingBox(),mb=await month.boundingBox();assert.ok(rb.x+rb.width<=mb.x);assert.ok(Math.abs(rb.y+rb.height/2-mb.y-mb.height/2)<2);if(width<=768)await expect(refresh.locator('.reconciliation-refresh-label')).toBeHidden();else {await expect(refresh.locator('.reconciliation-refresh-label')).toBeVisible();const hb=await page.locator('.operator-reconciliation-heading').boundingBox();assert.ok(Math.abs(mb.x+mb.width-hb.x-hb.width)<2);}await expect(page.locator('.operator-reconciliation h2')).toHaveCount(0);await expect(page.getByText('Как считаются итоги',{exact:true})).toHaveCount(0);
  if(width<=768){await expect(day.locator('.reconciliation-mobile-columns')).toBeVisible();for(const pair of [[1,2],[3,4],[5,6]]){const a=await day.locator('td').nth(pair[0]-1).boundingBox(),b=await day.locator('td').nth(pair[1]-1).boundingBox();assert.ok(Math.abs(a.y-b.y)<1);assert.ok(a.x+a.width<=b.x+1)}assert.equal(await day.locator('[data-source="CRM"]').evaluate(el=>getComputedStyle(el,'::before').content), '"CRM"');}
  assert.equal(await day.evaluate(el=>getComputedStyle(el).display),width<=768?'grid':'table-row');
  assert.ok(await table.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'table/cards have no horizontal overflow');
  await day.scrollIntoViewIfNeeded();await day.getByRole('button',{name:`Ввести литры ГПН за ${today}`,exact:true}).click();await litres.fill('499');await amount.fill('34600');
  assert.ok(await day.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'inline inputs fit card');
  const editAxe=await new AxeBuilder({page}).include('.operator-reconciliation').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();assert.deepEqual(editAxe.violations.map(v=>v.id),[]);report.axe.push({engine,width,state:'editing',violations:[]});
  await page.screenshot({path:resolve(output,`${engine}-inline-${width}.png`)});
  await amount.press('Enter');await expect(day.locator('input')).toHaveCount(0);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${engine} overflow ${width}`);
  const axe=await new AxeBuilder({page}).include('.operator-reconciliation').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();report.axe.push({engine,width,violations:axe.violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.target)}))});assert.deepEqual(axe.violations.map(v=>v.id),[]);
  await page.screenshot({path:resolve(output,`${engine}-reconciliation-${width}.png`)});pass(`${engine}: reconciliation ${width}px and axe`);
 }
 for(const width of [320,390,600,768,1440]){
  await page.setViewportSize({width,height:1000});
  for(const tab of ['Задания','Возвраты','Ожидают заправки','Операции']){
   await page.getByRole('tab',{name:new RegExp('^'+tab)}).click();
   const geometry=await page.locator('.operator-workspace').evaluate(el=>{const box=s=>el.querySelector(s).getBoundingClientRect();const toolbar=box('.operator-toolbar'),tabs=box('.operator-tabs'),content=box('#operator-content'),heading=el.querySelector('.operator-plan-heading')?.getBoundingClientRect();const preceding=heading&&heading.bottom<=toolbar.top?heading:tabs;return {above:toolbar.top-preceding.bottom,below:(heading&&heading.top>=toolbar.bottom?heading.top:content.top)-toolbar.bottom,contentTop:el.querySelector('.operator-task-section')?.getBoundingClientRect().top,panelTop:content.top}});
   if(geometry.above>0)assert.ok(Math.abs(geometry.above-geometry.below)<=1,JSON.stringify({width,tab,geometry}));if(tab==='Задания')assert.ok(Math.abs(geometry.contentTop-geometry.panelTop)<=1);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  }
  await page.getByRole('tab',{name:/^Задания/}).click();await page.screenshot({path:resolve(output,`${engine}-actions-${width}.png`)});pass(`${engine}: balanced action spacing on all operator tabs ${width}px`);
 }
 const fixture=await (await context.request.get(base+'/api/operator')).json(), original=fixture.refuellings.find(r=>r.serviceId==='operator-service-gpn'), historicalDate='2026-10-01';
 const legacy={...original,id:'qa-legacy-known',schemaVersion:undefined,service:' гпн ',date:historicalDate,name:'Историческая операция',recipient:{name:'Получатель',bank:'',card:'',phone:'',details:''}};
 fixture.refuellings=[...fixture.refuellings,{...original,id:'qa-day-target',date:historicalDate}, {...original,id:'qa-other-date',date:'2026-10-02'}, {...original,id:'qa-other-service',serviceId:'operator-service-rosneft',service:'Роснефть',date:historicalDate}, {...original,id:'qa-deleted',date:historicalDate,deletedAt:'2026-10-03T00:00:00Z'},legacy,{...legacy,id:'qa-legacy-unknown',service:'Архивный сервис'}];
 await page.route('**/api/operator',route=>route.fulfill({json:fixture}));await page.reload();await page.getByRole('tab',{name:'Сверки',exact:true}).click();await page.getByLabel('Месяц сверки').fill('2026-10');
 for(const [service,ids] of [['ГПН',['qa-day-target','qa-legacy-known']],['Архивный сервис',['qa-legacy-unknown']]]){
  await page.getByRole('group',{name:'Сервисы сверки'}).getByRole('button',{name:service,exact:true}).click();await table.getByRole('button',{name:`Операции ${service} за ${historicalDate}`,exact:true}).click();
  const actual=await page.locator('.operator-desktop-journal [data-operation-id]').evaluateAll(els=>els.map(el=>el.dataset.operationId));assert.deepEqual(actual.sort(),ids.sort());await page.getByRole('tab',{name:'Сверки',exact:true}).click();
 }
 await page.unroute('**/api/operator');await page.reload();pass(`${engine}: historical date/service excludes other days, same-name other services and deleted rows; legacy formats match`);
 for(const route of ['work','trips','directories','invoices']){
  await page.goto(base+'/#'+route);await expect(page.locator('.app-shell')).toBeVisible();
  for(const width of [320,390,1440]){
   await page.setViewportSize({width,height:1000});const toolbar=page.locator('.search-add-toolbar,.work-toolbar-actions,.invoice-toolbar').first();await expect(toolbar).toBeVisible();
   const boxes=await toolbar.locator(':scope > .button').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {center:r.y+r.height/2,height:r.height}}));if(boxes.length>1)assert.ok(Math.max(...boxes.map(b=>b.center))-Math.min(...boxes.map(b=>b.center))<2);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1),`${route} ${width} overflow`);await page.screenshot({path:resolve(output,`${engine}-${route}-${width}.png`)});
  }pass(`${engine}: shared page actions ${route}`);
 }
 await context.close();await browser.close();browser=null;
}
browser=await chromium.launch({headless:true});const operator=await browser.newContext({viewport:{width:390,height:844}});const login=await operator.request.post(base+'/api/auth/login',{headers:{Origin:base},data:{login:'operator.review',password:'LocalOperator2026!'}});assert.equal(login.status(),200);page=await operator.newPage();await page.goto(base+'/#directories');await expect(page.getByRole('button',{name:'Сервисы операторской',exact:true})).toBeVisible();for(const title of ['Клиенты','Сотрудники','Места погрузки и доставки','Поставщики'])await expect(page.locator('.directory-tabs').getByRole('button',{name:title,exact:true})).toHaveCount(0);await page.screenshot({path:resolve(output,'operator-services-only.png'),fullPage:true});pass('operator grants show only services on mobile');await operator.close();await browser.close();browser=null;
assert.deepEqual(report.errors,[]);report.passed=true;
}catch(error){report.failure=String(error.stack||error);if(page&&!page.isClosed())await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});throw error}
finally{await browser?.close();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2))}

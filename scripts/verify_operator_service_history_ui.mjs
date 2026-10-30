import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'),temp=await mkdtemp(resolve(tmpdir(),'operator-catalog-'));
const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
const yesterday=new Date(Date.parse(today)-86400000).toISOString().slice(0,10);
const mode=process.env.ARTEL_OPERATOR_QA_BUILT==='1'?'built':'source',output=resolve(root,'.local/service-history/ui-'+mode);await mkdir(output,{recursive:true});
await writeTripsQaSnapshot(resolve(temp,'snapshot'));
const runtime=await startOperatorQaServer({root,snapshotDirectory:resolve(temp,'snapshot'),operationsDirectory:resolve(temp,'operations')});
const {cookie}=await runtime.bootstrap();const report={synthetic:true,mode,artifacts:runtime.artifacts,checks:[],axe:[],errors:[]};let browser;
const api=async(path,method='GET',body)=>{const r=await fetch(runtime.base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',Origin:runtime.base},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.ok(r.ok,JSON.stringify({path,status:r.status,data}));return data;};
const read=()=>api('/api/operator');
try {for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
 const recipients=[1,2,3].map(n=>({id:randomUUID(),name:(n===1?'Длинное имя получателя '.repeat(9):'Получатель ')+n,bank:'Банк '+n,card:'0000 0000 0000 000'+n,phone:'',details:'Сохранённые реквизиты',limit:'100000'}));
 const plan=await api('/api/operator/plans','POST',{clientName:'Клиент '+engine,recipients,idempotencyKey:randomUUID()});
 let service=(await read()).services.find(s=>s.id==='operator-service-lukoil');
 const old=await api('/api/operator/refuellings','POST',{schemaVersion:3,planId:plan.id,planVersion:1,date:today,name:'Старый '+engine,serviceId:service.id,serviceVersion:service.version??0,discountPercent:service.discountPercent,litres:'10',pricePerLitre:'10',amount:'90',amountMode:'manual',comment:'',allocations:recipients.map(r=>({kind:'recipient',recipientId:r.id,amount:'30'})),idempotencyKey:randomUUID()});
 const historical=(await read()).refuellings.find(r=>r.id===old.id);
 browser=await launcher.launch();const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});await authenticateContext(context,runtime.base,cookie);const page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
 await page.goto(runtime.base+'/#operator');const add=page.getByRole('button',{name:'Новая операция',exact:true});await expect(add).toBeEnabled();
 // Another tab edits the directory while the operator workspace remains open.
 const catalogPage=await context.newPage();await catalogPage.goto(runtime.base+'/#directories');await expect(catalogPage.getByRole('button',{name:'Группы операторской',exact:true})).toHaveCount(0);
 await catalogPage.getByRole('button',{name:'Сервисы операторской',exact:true}).click();await catalogPage.getByRole('button',{name:'Редактировать: '+service.name,exact:true}).click();
 let d=catalogPage.getByRole('dialog');await expect(d.getByLabel('Название сервиса',{exact:true})).toBeEnabled();
 for(const width of [320,390,1470]) {await catalogPage.setViewportSize({width,height:1000});assert.ok(await catalogPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const a=await new AxeBuilder({page:catalogPage}).include('dialog').analyze();assert.deepEqual(a.violations,[]);report.axe.push({engine,width,screen:'service-editor',violations:a.violations});await catalogPage.screenshot({path:resolve(output,engine+'-color-'+width+'.png'),fullPage:true});}
await d.getByLabel('Название сервиса',{exact:true}).fill('ЛК '+engine);await d.getByLabel('Скидка, %',{exact:true}).fill('15');await d.getByRole('button',{name:'Жёлтый',exact:true}).click();await d.getByLabel('Свой цвет фона',{exact:true}).fill('#145678');await d.getByRole('button',{name:/Сохранить/}).click();await expect(d).toHaveCount(0);
 service=(await read()).services.find(s=>s.id===service.id);assert.equal(service.name,'ЛК '+engine);assert.equal(service.discountPercent,'15');assert.equal(service.backgroundColor,'#145678');
 await add.click();d=page.getByRole('dialog');await d.getByLabel('Задание',{exact:true}).selectOption(plan.id);await d.getByLabel('Сервис',{exact:true}).selectOption(service.id);await expect(d.getByLabel('Скидка, %',{exact:true})).toHaveValue('15');await expect(d.getByLabel('Сервис',{exact:true}).locator('option:checked')).toHaveText(service.name);
 await d.getByLabel('Имя водителя',{exact:true}).fill('Новый '+engine);await d.getByLabel('Литры',{exact:true}).fill('10');await d.getByLabel('Цена за литр, ₽',{exact:true}).fill('10');await expect(d.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('85.00');
 await d.getByLabel('Дата заправки',{exact:true}).fill(yesterday);await expect(d.getByLabel('Скидка, %',{exact:true})).toHaveValue('10');await expect(d.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('90.00');
 await d.getByLabel('Дата заправки',{exact:true}).fill(today);await expect(d.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('85.00');
 // Explicit refresh of an already-open draft keeps user input and updates its rate.
 await api('/api/directories/operatorServices/'+service.id,'PATCH',{version:service.version,name:'ЛК свежий '+engine,discountPercent:'20'});
 await d.getByRole('button',{name:'Обновить задания и справочники',exact:true}).click();await expect(d.getByLabel('Скидка, %',{exact:true})).toHaveValue('20');await expect(d.getByLabel('Имя водителя',{exact:true})).toHaveValue('Новый '+engine);await expect(d.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('80.00');
 await d.getByRole('button',{name:'Добавить получателя',exact:true}).click();await d.getByLabel('Получатель 1',{exact:true}).selectOption(recipients[0].id);await d.getByLabel('Сумма получателю 1, ₽',{exact:true}).fill('80');await d.getByRole('button',{name:'Сохранить операцию',exact:true}).click();await expect(d).toHaveCount(0);
 let state=await read();const created=state.refuellings.find(r=>r.name==='Новый '+engine);assert.equal(created.service,'ЛК свежий '+engine);assert.equal(created.discountPercent,'20');assert.equal(created.amount,'80.00');assert.deepEqual(state.refuellings.find(r=>r.id===old.id),historical);
 await page.reload();await expect(add).toBeEnabled();await page.locator('.operator-desktop-journal').getByRole('button',{name:historical.name,exact:true}).click();d=page.getByRole('dialog');await expect(d.getByLabel('Скидка, %',{exact:true})).toHaveValue(historical.discountPercent);await expect(d.getByLabel('Сервис',{exact:true}).locator('option:checked')).toHaveText('ЛК свежий '+engine);await d.getByRole('button',{name:'Закрыть форму',exact:true}).click();await expect(d).toHaveCount(0);
 for(const width of [320,390,600,1100,1470,1920]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));if(width>700){const group=page.locator('.operator-desktop-journal').locator(`[data-operation-id="${old.id}"]`);const heights=await group.locator('tr').evaluateAll(rows=>rows.map(r=>r.getBoundingClientRect().height));assert.ok(heights.every(h=>h<=65),JSON.stringify({heights,css:await group.locator('td,th').evaluateAll(es=>es.map(e=>({cls:e.className,p:getComputedStyle(e).padding,h:e.getBoundingClientRect().height,line:getComputedStyle(e).lineHeight})))}));const padding=await group.locator('.operator-recipient-row').first().evaluate(e=>getComputedStyle(e).paddingTop);assert.equal(padding,'8px');const cell=group.locator('.operator-recipient-row').first();assert.ok(Math.abs(await cell.evaluate(e=>e.getBoundingClientRect().width)-500)<2);assert.equal(await cell.evaluate(e=>getComputedStyle(e).borderRightWidth),'1px');
 const scroll=group.locator('.operator-recipient-scroll').first();assert.ok(await scroll.evaluate(e=>e.scrollWidth>e.clientWidth));await scroll.evaluate(e=>{e.scrollLeft=e.scrollWidth});assert.ok(await scroll.evaluate(e=>e.scrollLeft>0));
 await expect(group.locator('.operator-service-badge').first()).toHaveText('ЛК свежий '+engine);assert.equal(await group.locator('.operator-service-badge').first().evaluate(e=>getComputedStyle(e).backgroundColor),'rgb(20, 86, 120)');
 report.checks.push({engine,width,heights,padding,recipientWidth:500,rightBorder:true,scrollWorks:true,oldRowCurrentNameAndColor:true});}if([390,1470].includes(width)){await page.screenshot({path:resolve(output,engine+'-'+width+'.png'),fullPage:true});const a=await new AxeBuilder({page}).include('.operator-workspace').analyze();assert.deepEqual(a.violations,[]);report.axe.push({engine,width,violations:a.violations});}}
 // A failed refresh cannot open a new operation against a stale catalog.
 await page.route('**/api/operator',route=>route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Сервисы временно недоступны'})}));await add.click();await expect(page.getByRole('alert')).toContainText('Сервисы временно недоступны');await expect(page.getByRole('dialog')).toHaveCount(0);await page.unroute('**/api/operator');await add.click();d=page.getByRole('dialog');await expect(d).toBeVisible();await d.getByRole('button',{name:'Закрыть форму',exact:true}).click();await expect(d).toHaveCount(0);
 report.checks.push({engine,directoryEditFromOtherTab:true,newOperationFresh:true,draftRefreshPreservesInput:true,persistedNewTerms:true,oldOperationExact:true,datedDiscountPreview:true,customColorPersisted:true,groupsRemoved:true,refreshErrorDoesNotUseStaleCatalog:true});
 await browser.close();browser=null;
}
assert.deepEqual(report.errors,[]);report.passed=true;console.log(JSON.stringify(report));
}finally{await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();await runtime.server.close();await rm(temp,{recursive:true,force:true});}

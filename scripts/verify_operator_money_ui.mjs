import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'),temp=await mkdtemp(resolve(tmpdir(),'operator-money-'));
const mode=process.env.ARTEL_OPERATOR_QA_BUILT==='1'?'built':'source',output=resolve(root,'.local/money-release/ui-'+mode);await mkdir(output,{recursive:true});
await writeTripsQaSnapshot(resolve(temp,'snapshot'));
const runtime=await startOperatorQaServer({root,snapshotDirectory:resolve(temp,'snapshot'),operationsDirectory:resolve(temp,'operations')});
const {cookie}=await runtime.bootstrap();const report={synthetic:true,mode,artifacts:runtime.artifacts,checks:[],axe:[],errors:[]};let browser;
const api=async(path,method='GET',body)=>{const r=await fetch(runtime.base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',Origin:runtime.base},...(body?{body:JSON.stringify(body)}:{})});const data=await r.json();assert.ok(r.ok,JSON.stringify({path,status:r.status,data}));return data;};
const read=()=>api('/api/operator');
const plan=async(clientName,limit)=>{const recipients=[{id:randomUUID(),name:'Получатель '+clientName,bank:'Альфа-Банк',card:'0000 0000 0000 0001',phone:'',details:'',limit}];const p=await api('/api/operator/plans','POST',{clientName,recipients,idempotencyKey:randomUUID()});return {...p,recipients};};
const north=await plan('Северный маршрут','250000'),volga=await plan('Волга Транс','50000');
const service=(await read()).services.find(s=>s.name==='Лукойл');
const source=await api('/api/operator/refuellings','POST',{schemaVersion:3,planId:north.id,planVersion:1,date:'2026-10-21',name:'Водитель остатка',serviceId:service.id,serviceVersion:service.version??0,discountPercent:service.discountPercent,litres:'900',pricePerLitre:'80',amount:'64800',amountMode:'auto',comment:'',allocations:[{kind:'recipient',recipientId:north.recipients[0].id,amount:'64800'}],idempotencyKey:randomUUID()});
await api(`/api/operator/refuellings/${source.id}/payment`,'PATCH',{version:1,paid:true,idempotencyKey:randomUUID()});
const credit=await api('/api/operator/cases','POST',{operationId:source.id,operationVersion:2,kind:'return',litres:'100',idempotencyKey:randomUUID()});
try {for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
 browser=await launcher.launch();const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});await authenticateContext(context,runtime.base,cookie);const page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
 await page.goto(runtime.base+'/#operator');await expect(page.getByRole('button',{name:'Новая операция',exact:true})).toBeEnabled();
 await page.getByRole('button',{name:'Новая операция',exact:true}).click();let d=page.getByRole('dialog');
 await d.getByLabel('Задание',{exact:true}).selectOption(north.id);
 await d.getByLabel('Сервис',{exact:true}).selectOption(service.id);await d.getByLabel('Литры',{exact:true}).fill('900');await d.getByLabel('Цена за литр, ₽',{exact:true}).fill('90');
 if(engine==='chromium'){await d.getByLabel('Остаток водителя',{exact:true}).selectOption(credit.id);await expect(d.getByLabel('Сумма из остатка, ₽',{exact:true})).toHaveValue('7200.00');await expect(d.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('65700.00');report.checks.push(engine+': old 100 litres credits 7200 at new price 90');}
 else await d.getByLabel('Имя водителя',{exact:true}).fill('Водитель WebKit');
 await d.getByRole('button',{name:'Добавить получателя',exact:true}).click();await d.getByLabel('Получатель 1',{exact:true}).selectOption(north.recipients[0].id);await d.getByLabel('Сумма получателю 1, ₽',{exact:true}).fill('20000');
 await d.getByRole('button',{name:'Добавить получателя',exact:true}).click();await d.getByLabel('Задание получателя 2',{exact:true}).selectOption(volga.id);await d.getByLabel('Получатель 2',{exact:true}).selectOption(volga.recipients[0].id);await d.getByLabel('Сумма получателю 2, ₽',{exact:true}).fill('10000');
 await d.getByRole('button',{name:'Перевести менеджеру',exact:true}).click();await d.getByLabel('Менеджер для остатка',{exact:true}).selectOption('aidar');await expect(d.getByLabel('Сумма менеджеру, ₽',{exact:true})).toHaveValue(engine==='chromium'?'35700.00':'42900.00');
 for(const width of [320,390,600,1100,1470]) {await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const box=await d.boundingBox();assert.ok(box.x>=0&&box.x+box.width<=width+1);report.checks.push({engine,width,form:true});}
 const axe=await new AxeBuilder({page}).include('dialog').analyze();report.axe.push({engine,screen:'form',violations:axe.violations});assert.deepEqual(axe.violations,[]);
 await d.getByRole('button',{name:'Сохранить операцию',exact:true}).click();await expect(d).toHaveCount(0,{timeout:15000});
 const created=(await read()).refuellings.find(r=>r.name===(engine==='chromium'?'Водитель остатка':'Водитель WebKit')&&r.id!==source.id);assert.equal(created.allocations.length,3);assert.equal(created.allocations[1].planId,volga.id);report.checks.push(engine+': real synthetic save across two tasks plus early manager');
 for(const width of [320,390,600,1100,1470,1920]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const journal=page.locator(width<=700?'.operator-mobile-journal':'.operator-desktop-journal');await expect(journal.locator(`[data-operation-id="${created.id}"]`)).toBeVisible();await expect(journal.locator('.operator-journal-case')).toHaveCount(0);if(width>700){assert.deepEqual(await journal.locator('thead th').allTextContents(),['Дата','Водитель','Сервис / скидка','Литры','Цена, ₽/л','Итого операции, ₽','Оплата','Получатель','Действие']);const row=journal.locator(`[data-operation-id="${created.id}"]`);await expect(row.locator('.operator-recipient-client')).toHaveText(['Северный маршрут','Волга Транс','Северный маршрут']);assert.equal(await row.locator('.operator-price').evaluate(e=>getComputedStyle(e).color),'rgb(36, 101, 178)');assert.equal(await row.locator('.operator-litres').evaluate(e=>getComputedStyle(e).color),'rgb(17, 17, 17)');}report.checks.push({engine,width,journal:true});if([390,1470].includes(width))await page.screenshot({path:resolve(output,`${engine}-${width}.png`),fullPage:true});}
 await page.setViewportSize({width:1470,height:1000});const payment=page.locator('.operator-desktop-journal').locator(`[data-operation-id="${created.id}"]`).getByLabel(`Оплата ${created.name}`,{exact:true});await payment.selectOption('paid');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(payment).toHaveValue('paid');await payment.selectOption('unpaid');await expect(page.getByRole('dialog')).toHaveCount(0);await expect(payment).toHaveValue('unpaid');report.checks.push(engine+': payment both directions');
 for(const label of ['Возвраты','Ожидают заправки']){await page.getByRole('tab',{name:new RegExp('^'+label)}).click();await expect(page.locator('.operator-cases table')).toHaveCount(0);report.checks.push(engine+': no case table '+label);}
 const audit=await new AxeBuilder({page}).include('.operator-workspace').analyze();report.axe.push({engine,screen:'cases',violations:audit.violations});assert.deepEqual(audit.violations,[]);
 await browser.close();browser=null;
}
assert.deepEqual(report.errors,[]);report.passed=true;report.stateSha256=createHash('sha256').update(JSON.stringify(await read())).digest('hex');console.log(JSON.stringify(report));
}finally{await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();await runtime.server.close();await rm(temp,{recursive:true,force:true});}

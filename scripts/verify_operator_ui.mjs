import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium,webkit,expect} from '@playwright/test';
import {startTripsQaServer,writeTripsQaSnapshot} from './qa-trips-runtime.mjs';
import {authenticateContext,bootstrapQaAuth} from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'),temporary=await mkdtemp(resolve(tmpdir(),'artel-operator-'));
const output=resolve(root,'qa/operator');await mkdir(output,{recursive:true});
const snapshotDirectory=resolve(temporary,'snapshot'),operationsDirectory=resolve(temporary,'operations');await writeTripsQaSnapshot(snapshotDirectory);
const runtime=await startTripsQaServer({root,snapshotDirectory,operationsDirectory});
const {cookie}=await bootstrapQaAuth(runtime.base);
const report={synthetic:true,checks:[],screenshots:[],errors:[]};let browser;
const check=label=>{report.checks.push(label);console.log('PASS',label)};
try{
 for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
  browser=await launcher.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});await authenticateContext(context,runtime.base,cookie);
  await context.route('**/*',route=>new URL(route.request().url()).origin===runtime.base?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  await page.goto(runtime.base+'/#operator');await expect(page.getByRole('button',{name:'Новая заправка',exact:true})).toBeEnabled();
  await page.getByRole('tab',{name:'Реквизиты',exact:true}).click();await page.getByRole('button',{name:'Добавить реквизиты'}).click();
  let dialog=page.getByRole('dialog');await dialog.getByLabel('Наименование получателя',{exact:true}).fill(`Учебный получатель ${engine}`);await dialog.getByLabel('Банк получателя',{exact:true}).fill('Учебный банк');await dialog.getByLabel('Телефон',{exact:true}).fill('+70000000000');await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog).toHaveCount(0);check(`${engine}: recipient persisted and separately read`);
  await page.getByRole('tab',{name:'Заправки',exact:true}).click();await page.getByRole('button',{name:'Новая заправка',exact:true}).click();dialog=page.getByRole('dialog');
  await dialog.getByLabel('Имя водителя',{exact:true}).fill(`Учебный водитель ${engine}`);await dialog.getByLabel('Сервис',{exact:true}).fill('Газпромнефть');await dialog.getByLabel('Скидка, %',{exact:true}).fill('5');await dialog.getByLabel('Литры',{exact:true}).fill('100,5');await dialog.getByLabel('Цена за литр, ₽',{exact:true}).fill('65');await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('6200,25');await dialog.getByLabel('Получатель',{exact:true}).selectOption({label:`Учебный получатель ${engine} · Учебный банк`});
  // Lose the response AFTER the real API persists. The retry must retain its exact key/body.
  let dropped=false;
  await page.route('**/api/operator/refuellings',async route=>{if(route.request().method()==='POST'&&!dropped){dropped=true;await route.fetch();await route.abort()}else await route.continue()});
  await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog.getByRole('button',{name:'Проверить сохранение'})).toBeEnabled();await expect(dialog.getByLabel('Имя водителя',{exact:true})).toBeDisabled();await dialog.getByRole('button',{name:'Проверить сохранение'}).click();await expect(dialog).toHaveCount(0);
  const row=page.getByRole('row').filter({hasText:`Учебный водитель ${engine}`});await expect(row).toHaveCount(1);await expect(row).toContainText('Не оплачено');check(`${engine}: lost response retry creates exactly one unpaid refuelling`);
  await row.getByRole('button',{name:'Подтвердить оплату',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Подтвердить',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(row).toContainText('Оплачено');await page.reload();await expect(row).toContainText('Оплачено');
  await row.getByRole('button',{name:`Учебный водитель ${engine}`,exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toBeDisabled();await expect(dialog).toContainText('История оплаты');await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();check(`${engine}: payment persists after reload; audit and protected paid fields visible`);
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));await page.screenshot({path:resolve(output,`${engine}-${width}-diagnostic.png`),fullPage:true});await expect(row).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   for(const tab of ['Аналитика','Реквизиты','Заправки']){await page.getByRole('tab',{name:tab,exact:true}).click();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));}
   const screenshot=resolve(output,`${engine}-${width}.png`);await page.screenshot({path:screenshot,fullPage:true});report.screenshots.push(screenshot);
   await page.getByRole('button',{name:'Новая заправка',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Имя водителя',{exact:true})).toBeVisible();assert.ok(await dialog.evaluate(d=>d.scrollWidth<=d.clientWidth+1));await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();check(`${engine}: tabs and form ${width}px`);
  }
  await page.getByRole('tab',{name:'Аналитика',exact:true}).click();await expect(page.getByText('Оплачено, ₽',{exact:true})).toBeVisible();await page.getByLabel('Поиск заправок',{exact:true}).fill(engine);await expect(page.getByText('6 200,25',{exact:true})).toBeVisible();check(`${engine}: analytics uses entered amount and selected filter`);
  await context.close();await browser.close();browser=null;
 }
 runtime.replaceMiddleware();const r=await fetch(runtime.base+'/api/operator',{headers:{Cookie:cookie}});const data=await r.json();assert.equal(data.refuellings.length,2);assert.ok(data.refuellings.every(r=>r.paid&&r.amount==='6200.25'&&r.paymentHistory.length===1));check('new middleware/store reads both saved records');assert.deepEqual(report.errors,[]);
 report.passed=true;
}finally{await browser?.close();await runtime.server.close();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await rm(temporary,{recursive:true,force:true})}

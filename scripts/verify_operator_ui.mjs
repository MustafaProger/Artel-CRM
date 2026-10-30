import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium,webkit,expect} from '@playwright/test';
import {writeTripsQaSnapshot} from './qa-trips-runtime.mjs';
import {startOperatorQaServer} from './qa-operator-runtime.mjs';
import {authenticateContext} from './qa-auth.mjs';

const root=resolve(import.meta.dirname,'..'),temporary=await mkdtemp(resolve(tmpdir(),'artel-operator-form-'));
const output=resolve(process.env.ARTEL_OPERATOR_QA_OUTPUT||process.env.ARTEL_QA_OUTPUT||resolve(root,'qa/operator'));await mkdir(output,{recursive:true});
const snapshotDirectory=resolve(temporary,'snapshot'),operationsDirectory=resolve(temporary,'operations');await writeTripsQaSnapshot(snapshotDirectory);
const runtime=await startOperatorQaServer({root,snapshotDirectory,operationsDirectory});
const {cookie:admin}=await runtime.bootstrap();
const api=async(path,method='GET',body,cookie=admin)=>{
 const response=await fetch(runtime.base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',Origin:runtime.base},...(body===undefined?{}:{body:JSON.stringify(body)})});
 const result=await response.json();assert.ok(response.ok,JSON.stringify({path,status:response.status,error:result.error}));return result;
};
const manager=(await api('/api/directories','POST',{kind:'managers',name:'Учебный оператор'})).entry;
const password=randomUUID();
await api('/api/auth/users','POST',{name:'Учебный оператор',login:'operator.qa',password,role:'employee',managerId:manager.id,sections:['operator','directories']});
const login=await fetch(runtime.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:runtime.base},body:JSON.stringify({login:'operator.qa',password})});
assert.ok(login.ok);const cookie=login.headers.get('set-cookie').split(';')[0];
const report={synthetic:true,frontend:runtime.mode,artifacts:runtime.artifacts,checks:[],screenshots:[],errors:[]};let browser;
const check=label=>{report.checks.push(label);console.log('PASS',label)};
const save=async dialog=>{await dialog.getByRole('button',{name:/^Сохранить( операцию)?$/}).click();await expect(dialog).toHaveCount(0)};
try{
 for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
  // Reset only the synthetic fixture rate; retain prior records to check historical values.
  let workspace=await api('/api/operator','GET',undefined,cookie),service=workspace.services.find(s=>s.name==='ГПН');
  if(service.discountPercent!=='10')await api(`/api/directories/operatorServices/${service.id}`,'PATCH',{name:service.name,discountPercent:'10',version:service.version??0},cookie);
  browser=await launcher.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});await authenticateContext(context,runtime.base,cookie);
  await context.route('**/*',route=>new URL(route.request().url()).origin===runtime.base?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  await page.goto(runtime.base+'/#directories');await page.getByRole('button',{name:'Группы операторской',exact:true}).click();
  await page.getByRole('button',{name:'Добавить',exact:true}).click();let dialog=page.getByRole('dialog');
  await dialog.getByLabel('Название группы',{exact:true}).fill(`Учебная группа ${engine}`);await save(dialog);
  await expect(page.getByRole('button',{name:`Редактировать: Учебная группа ${engine}`,exact:true})).toBeVisible();
  await page.getByRole('button',{name:'Сотрудники',exact:true}).click();await expect(page.getByRole('button',{name:'Добавить',exact:true})).toBeVisible();
  await expect(page.getByText('Не удалось загрузить полномочия.',{exact:false})).toHaveCount(0);
  check(`${engine}: employee edits directory and personnel page does not request account access`);

  workspace=await api('/api/operator','GET',undefined,cookie);service=workspace.services.find(item=>item.name==='ГПН');
  const group=workspace.groups.find(item=>item.name===`Учебная группа ${engine}`);
  await api('/api/operator/plans','POST',{clientName:`Учебное задание ${engine}`,recipients:[{id:randomUUID(),name:'Учебный получатель',bank:'Учебный банк',card:'0000',phone:'',details:'',limit:'50000'}],idempotencyKey:randomUUID()},cookie);
  const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
  await api('/api/operator/refuellings','POST',{schemaVersion:2,date:today,name:`Учебный водитель ${engine}`,groupId:group.id,serviceId:service.id,serviceVersion:service.version??0,discountPercent:service.discountPercent,litres:'1',pricePerLitre:'1',amount:'0.90',amountMode:'auto',recipientText:'Прежние свободные реквизиты',comment:'',idempotencyKey:randomUUID()},cookie);
  await page.goto(runtime.base+'/#operator');await expect(page.getByRole('button',{name:'Новая операция',exact:true})).toBeEnabled();
  await expect(page.getByRole('tab',{name:'Аналитика',exact:true})).toHaveCount(0);await expect(page.getByRole('tab',{name:'Реквизиты',exact:true})).toHaveCount(0);
  await page.getByRole('button',{name:`Учебный водитель ${engine}`,exact:true}).click();dialog=page.getByRole('dialog');
  await expect(dialog.getByLabel('Дата заправки',{exact:true})).toHaveValue(today);
  await dialog.getByLabel('Имя водителя',{exact:true}).fill(`Учебный водитель ${engine}`);
  await dialog.getByLabel('Группа',{exact:true}).selectOption({label:`Учебная группа ${engine}`});
  await dialog.getByLabel('Сервис',{exact:true}).selectOption({label:'ГПН'});await expect(dialog.getByLabel('Скидка, %',{exact:true})).toHaveValue('10');
  assert.equal(await dialog.getByLabel('Скидка, %',{exact:true}).getAttribute('readonly'),'');
  await dialog.getByLabel('Литры',{exact:true}).fill('100');await dialog.getByLabel('Цена за литр, ₽',{exact:true}).fill('78,45');
  await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('7060.50');
  const recipient=`Учебный получатель ${engine}\nУчебный банк\nТелефон: +70000000000`;
  await dialog.getByLabel('Имя получателя и реквизиты',{exact:true}).fill(recipient);
  await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('7000,25');
  await dialog.getByLabel('Комментарий',{exact:true}).fill('Учебная ручная корректировка');await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('7000,25');
  await dialog.getByLabel('Литры',{exact:true}).fill('100,25');await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('7078.15');
  await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('7000,25');
  await dialog.getByLabel('Цена за литр, ₽',{exact:true}).fill('80');await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('7218.00');
  await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('7000,25');
  await dialog.getByLabel('Сервис',{exact:true}).selectOption({label:'Яндекс'});await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('7218.00');
  await dialog.getByLabel('Сервис',{exact:true}).selectOption({label:'ГПН'});
  await dialog.getByLabel('Литры',{exact:true}).fill('100');await dialog.getByLabel('Цена за литр, ₽',{exact:true}).fill('78,45');
  await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('7060.50');
  const formScreenshot=resolve(output,`${engine}-form-1440.png`);await page.screenshot({path:formScreenshot,fullPage:true});report.screenshots.push(formScreenshot);
  check(`${engine}: automatic final rounding, decimal input and all three recalculation triggers`);

  let dropped=false;
  await page.route('**/api/operator/refuellings/*',async route=>{if(route.request().method()==='PATCH'&&!dropped){dropped=true;await route.fetch();await route.abort()}else await route.continue()});
  await dialog.getByRole('button',{name:/^Сохранить( операцию)?$/}).click();await expect(dialog.getByRole('button',{name:'Проверить сохранение'})).toBeEnabled();
  await expect(dialog.getByLabel('Имя водителя',{exact:true})).toBeDisabled();await dialog.getByRole('button',{name:'Проверить сохранение'}).click();await expect(dialog).toHaveCount(0);
  let row=page.getByRole('row').filter({hasText:`Учебный водитель ${engine}`});await expect(row).toHaveCount(1);await expect(row).toContainText('7 060,50');await expect(row).toContainText('Не оплачено');
  workspace=await api('/api/operator','GET',undefined,cookie);assert.equal(workspace.recipients.length,0);assert.equal(workspace.refuellings.find(r=>r.name===`Учебный водитель ${engine}`).recipientText,recipient);
  check(`${engine}: lost edit response retry preserves one legacy record and free text`);

  await page.goto(runtime.base+'/#directories');await page.getByRole('button',{name:'Сервисы операторской',exact:true}).click();
  await page.getByRole('button',{name:'Редактировать: ГПН',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Скидка, %',{exact:true}).fill('8');await save(dialog);
  await page.goto(runtime.base+'/#operator');row=page.getByRole('row').filter({hasText:`Учебный водитель ${engine}`});await expect(row).toContainText('7 060,50');
  await row.getByRole('button',{name:`Учебный водитель ${engine}`,exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Скидка, %',{exact:true})).toHaveValue('10');
  await dialog.getByLabel('Комментарий',{exact:true}).fill('Историческая ставка сохранена');await save(dialog);
  await page.getByRole('button',{name:'Новая операция',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Задание',{exact:true})).toHaveValue('');
  await dialog.getByLabel('Сервис',{exact:true}).selectOption({label:'ГПН'});await expect(dialog.getByLabel('Скидка, %',{exact:true})).toHaveValue('8');
  await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();await dialog.getByRole('button',{name:'Не сохранять',exact:true}).click();await expect(dialog).toHaveCount(0);
  check(`${engine}: directory discount change affects new records, historical amount and discount preserved`);

  await row.getByRole('button',{name:`Учебный водитель ${engine}`,exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('7000,25');await save(dialog);
  await page.reload();await expect(row).toContainText('7 000,25');
  await row.getByRole('button',{name:'Подтвердить оплату',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByRole('button',{name:'Подтвердить',exact:true}).click();await expect(dialog).toHaveCount(0);await expect(row).toContainText('Оплачено');
  await page.reload();await row.getByRole('button',{name:`Учебный водитель ${engine}`,exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toBeDisabled();await expect(dialog).toContainText('История оплаты');await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();
  check(`${engine}: manual amount, payment, history and paid edit protection survive reload`);

  for(const width of [375,390,768,1440]){
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
   await expect(row).toBeVisible();assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   const screenshot=resolve(output,`${engine}-${width}.png`);await page.screenshot({path:screenshot,fullPage:true});report.screenshots.push(screenshot);
   await page.getByRole('button',{name:'Новая операция',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Имя водителя',{exact:true})).toBeVisible();assert.ok(await dialog.evaluate(element=>element.scrollWidth<=element.clientWidth+1));
   await dialog.getByLabel('Имя водителя',{exact:true}).fill('Учебный ввод');await page.keyboard.press('Escape');await expect(dialog).toContainText('Закрыть форму без сохранения?');await dialog.getByRole('button',{name:'Не сохранять',exact:true}).click();await expect(dialog).toHaveCount(0);
   check(`${engine}: journal, form and discard guard ${width}px`);
  }
  await context.close();await browser.close();browser=null;
 }
 await runtime.replaceMiddleware();const data=await api('/api/operator','GET',undefined,cookie);
 assert.equal(data.refuellings.length,2);assert.ok(data.refuellings.every(row=>row.schemaVersion===2&&row.paid&&row.amount==='7000.25'&&row.discountPercent==='10'&&row.paymentHistory.length===1));assert.equal(data.recipients.length,0);
 check('new middleware/store reads both saved records with historical prices');
 // A previous-format record keeps its financial terms while adopting the new required group.
 const recipient=await api('/api/operator/recipients','POST',{name:'Учебный старый получатель',bank:'Учебный банк',card:'',phone:'+70000000000',details:'',idempotencyKey:randomUUID()},cookie);
 await api('/api/operator/refuellings','POST',{date:'2026-10-19',name:'Учебная старая запись',service:'ГПН',discountPercent:'5',litres:'100.123456',pricePerLitre:'65.123456',amount:'700.25',comment:'',recipientId:recipient.id,recipientVersion:1,idempotencyKey:randomUUID()},cookie);
 browser=await chromium.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});await authenticateContext(context,runtime.base,cookie);
 await context.route('**/*',route=>new URL(route.request().url()).origin===runtime.base?route.continue():route.abort());
 const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));await page.goto(runtime.base+'/#operator');await page.getByRole('button',{name:'Учебная старая запись',exact:true}).click();
 let dialog=page.getByRole('dialog');await dialog.getByLabel('Группа',{exact:true}).selectOption({label:'Учебная группа chromium'});
 const current=await api('/api/operator','GET',undefined,cookie),service=current.services.find(item=>item.name==='ГПН');
 await api(`/api/directories/operatorServices/${service.id}`,'PATCH',{name:service.name,discountPercent:'7',version:service.version??0},cookie);
 await dialog.getByRole('button',{name:/^Сохранить( операцию)?$/}).click();await expect(dialog.getByRole('button',{name:'Обновить справочники',exact:true})).toBeVisible();
 await dialog.getByRole('button',{name:'Обновить справочники',exact:true}).click();await expect(dialog.getByLabel('Скидка, %',{exact:true})).toHaveValue('5');await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('700.25');await save(dialog);
 const converted=(await api('/api/operator','GET',undefined,cookie)).refuellings.find(item=>item.name==='Учебная старая запись');assert.equal(converted.schemaVersion,2);assert.equal(converted.discountPercent,'5');assert.equal(converted.amount,'700.25');assert.equal(converted.litres,'100.123456');assert.equal(converted.pricePerLitre,'65.123456');
 check('legacy edit refreshes changed catalog version without changing historical precision, discount or manual amount');
 await page.getByRole('button',{name:'Учебная старая запись',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Литры',{exact:true}).fill('100');await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('6186.73');await save(dialog);
 check('legacy precision is retained only for unchanged fields during recalculation');
 await context.close();await browser.close();browser=null;assert.deepEqual(report.errors,[]);report.passed=true;
}finally{
 await browser?.close();await runtime.server.close();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await rm(temporary,{recursive:true,force:true});
}

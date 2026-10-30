import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'), temporary=await mkdtemp(resolve(tmpdir(),'artel-operator-plans-'));
const output=resolve(process.env.ARTEL_OPERATOR_QA_OUTPUT||process.env.ARTEL_QA_OUTPUT||resolve(root,'qa/operator-plans')); await mkdir(output,{recursive:true});
const snapshotDirectory=resolve(temporary,'snapshot'), operationsDirectory=resolve(temporary,'operations'); await writeTripsQaSnapshot(snapshotDirectory);
const runtime=await startOperatorQaServer({root,snapshotDirectory,operationsDirectory});
const {cookie:admin}=await runtime.bootstrap();
const api=async(path,method='GET',body,cookie=admin)=>{const response=await fetch(runtime.base+path,{method,headers:{Cookie:cookie,'Content-Type':'application/json',Origin:runtime.base},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();assert.ok(response.ok,JSON.stringify({path,status:response.status,error:result.error}));return result};
const account=async(name,loginName)=>{
 const manager=(await api('/api/directories','POST',{kind:'managers',name})).entry;
 const password=randomUUID();await api('/api/auth/users','POST',{name,login:loginName,password,role:'employee',managerId:manager.id,sections:['operator','directories']});
 const login=await fetch(runtime.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json',Origin:runtime.base},body:JSON.stringify({login:loginName,password})});assert.ok(login.ok);
 return {cookie:login.headers.get('set-cookie').split(';')[0],actor:(await login.json()).user};
};
const identities=[await account('Айдар QA','plans.aidar.qa'),await account('Эльдар QA','plans.eldar.qa')];
const cookie=identities[0].cookie;
const group=(await api('/api/directories','POST',{kind:'operatorGroups',name:'Учебная группа'},cookie)).entry;
const report={synthetic:true,frontend:runtime.mode,artifacts:runtime.artifacts,checks:[],screenshots:[],errors:[]}; let browser;
const check=label=>{report.checks.push(label);console.log('PASS',label)};
const save=async(dialog,label='Сохранить операцию')=>{await dialog.getByRole('button',{name:label,exact:true}).click();await expect(dialog).toHaveCount(0)};
const shot=async(page,name)=>{await page.evaluate(()=>document.activeElement?.blur());const path=resolve(output,name+'.png');await page.screenshot({path,fullPage:true});report.screenshots.push(path)};
const verifyToolbar=async(page,createName)=>{
 const controls=[page.getByRole('tab',{name:'Задания',exact:true}),page.getByRole('tab',{name:'Операции',exact:true}),page.getByRole('button',{name:'Обновить',exact:true}),page.getByRole('button',{name:createName,exact:true})];
 const boxes=await Promise.all(controls.map(control=>control.boundingBox()));assert.ok(boxes.every(Boolean));const centers=boxes.map(box=>box.y+box.height/2);assert.ok(Math.max(...centers)-Math.min(...centers)<3,JSON.stringify(boxes));
 assert.ok(boxes[1].x+boxes[1].width<=boxes[2].x+1,JSON.stringify(boxes));assert.ok(boxes[2].x+boxes[2].width<=boxes[3].x+1,JSON.stringify(boxes));
 for(const control of controls.slice(2)){const box=await control.boundingBox();assert.ok(box.height>=44,JSON.stringify(box));const label=control.locator('.mobile-action-label');if(page.viewportSize().width<=1100){await expect(label).toBeHidden();assert.ok(box.width>=44&&box.width<=46,JSON.stringify(box))}else{await expect(label).toBeVisible();assert.ok((await label.innerText()).trim().length>0);assert.ok(box.width>90,JSON.stringify(box))}}
};
try {
 for (const [engine, launcher,identity] of [['chromium',chromium,identities[0]],['webkit',webkit,identities[1]]]) {
  const {cookie,actor}=identity;
  browser=await launcher.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});await authenticateContext(context,runtime.base,cookie);
  await context.route('**/*',route=>new URL(route.request().url()).origin===runtime.base?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));await page.goto(runtime.base+'/#operator');
  await expect(page.getByRole('tab',{name:'Операции',exact:true})).toHaveAttribute('aria-selected','true');
  assert.deepEqual(await page.getByRole('tab').allTextContents(),['Задания','Операции']);
  const createPlan=async(client,limits,drop=false)=>{
   await page.getByRole('tab',{name:'Задания',exact:true}).click();await page.getByRole('button',{name:'Новое задание',exact:true}).click();const dialog=page.getByRole('dialog');
   await dialog.getByLabel('Клиент',{exact:true}).fill(client);await expect(dialog.getByLabel('Менеджер задания',{exact:true})).toHaveCount(0);await expect(dialog).toContainText(actor.name);
   for(let i=0;i<limits.length;i++){if(i)await dialog.getByRole('button',{name:'Добавить реквизиты',exact:true}).click();await dialog.getByLabel(`Имя получателя ${i+1}`,{exact:true}).fill(`Получатель ${i+1}`);await dialog.getByLabel(`Банк ${i+1}`,{exact:true}).fill(`Учебный банк ${i+1}`);await dialog.getByLabel(`Номер карты / счёта ${i+1}`,{exact:true}).fill(`0000 0000 0000 000${i+1}`);await dialog.getByLabel(`Телефон ${i+1}`,{exact:true}).fill(`+7000000000${i+1}`);await dialog.getByLabel(`Лимит, ₽ ${i+1}`,{exact:true}).fill(limits[i])}
   if(drop){let attempts=0;const keys=[];await page.route('**/api/operator/plans',async route=>{if(route.request().method()==='POST'){keys.push(route.request().postDataJSON().idempotencyKey);attempts++;if(attempts===1){await route.fetch();await route.abort()}else if(attempts===2)await route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({error:'Retry later'})});else await route.continue()}else await route.continue()});await dialog.getByRole('button',{name:'Сохранить задание',exact:true}).click();await expect(dialog.getByRole('button',{name:'Проверить сохранение',exact:true})).toBeEnabled();await expect(dialog.getByLabel('Клиент',{exact:true})).toBeDisabled();await dialog.getByRole('button',{name:'Проверить сохранение',exact:true}).click();await expect(dialog).toContainText('Retry later');await expect(dialog.getByLabel('Клиент',{exact:true})).toBeDisabled();await save(dialog,'Проверить сохранение');assert.equal(keys.length,3);assert.equal(new Set(keys).size,1);await page.unroute('**/api/operator/plans')}
   else await save(dialog,'Сохранить задание');
   const work=await api('/api/operator','GET',undefined,cookie),plans=work.plans.filter(p=>p.clientName===client);assert.equal(plans.length,1);assert.equal(plans[0].createdBy,actor.id);assert.equal(plans[0].createdByName,actor.name);assert.equal(plans[0].managerId,undefined);return plans[0];
  };
  let first=await createPlan(`ООО Метр ${engine}`,['10000','30000'],true);
  const last=await createPlan(`ООО Последняя карта ${engine}`,['10000']);
  const automatic=await createPlan(`ООО Автораспределение ${engine}`,['15000']);
  const removable=await createPlan(`ООО Удаление реквизитов ${engine}`,['1000','2000']);
  let removalCard=page.locator('.operator-plan-card').filter({hasText:removable.clientName});
  await removalCard.getByRole('button',{name:`Редактировать задание ${removable.clientName}`,exact:true}).click();
  let removalDialog=page.getByRole('dialog');await removalDialog.getByRole('button',{name:'Удалить получателя 2',exact:true}).click();await save(removalDialog,'Сохранить задание');
  const removedRecipientPlan=(await api('/api/operator','GET',undefined,cookie)).plans.find(item=>item.id===removable.id);
  assert.equal(removedRecipientPlan.recipients.length,1);assert.equal(removedRecipientPlan.recipients[0].id,removable.recipients[0].id);assert.equal(removedRecipientPlan.remaining,'1000.00');
  check(`${engine}: edit removes an unused recipient and persists the revised limit without deleting the plan`);
  await expect(page.locator('.operator-table')).toHaveCount(0);
  await expect(page.getByRole('button',{name:/^Удалить задание/})).toHaveCount(0);
  let card=page.locator('.operator-plan-card').filter({hasText:first.clientName});
  await expect(card).toContainText(actor.name);await card.locator('summary').click();
  for(const detail of ['Учебный банк 1','0000 0000 0000 0001','+70000000001','10 000,00','30 000,00'])await expect(card).toContainText(detail);
  await shot(page,`${engine}-task-details`);
  const initialCreator={createdBy:first.createdBy,createdByName:first.createdByName,createdAt:first.createdAt};
  await card.getByRole('button',{name:`Редактировать задание ${first.clientName}`,exact:true}).click();
  let edit=page.getByRole('dialog');await expect(edit).toContainText('Редактирование задания');
  await expect(edit.getByLabel('Менеджер задания',{exact:true})).toHaveCount(0);
  await edit.getByLabel('Клиент',{exact:true}).fill(first.clientName+' уточнённое');
  await edit.getByLabel('Телефон 1',{exact:true}).fill('+70000000011');
  let editAttempts=0;const editBodies=[];
  await page.route('**/api/operator/plans/*',async route=>{if(route.request().method()==='PATCH'){editBodies.push(route.request().postData());editAttempts++;if(editAttempts===1){await route.fetch();await route.abort()}else if(editAttempts===2)await route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({error:'Retry edit later'})});else await route.continue()}else await route.continue()});
  await edit.getByRole('button',{name:'Сохранить задание',exact:true}).click();
  await expect(edit.getByRole('button',{name:'Проверить сохранение',exact:true})).toBeEnabled();await expect(edit.getByLabel('Клиент',{exact:true})).toBeDisabled();
  await edit.getByRole('button',{name:'Проверить сохранение',exact:true}).click();await expect(edit).toContainText('Retry edit later');await expect(edit.getByLabel('Клиент',{exact:true})).toBeDisabled();
  await save(edit,'Проверить сохранение');assert.equal(editBodies.length,3);assert.equal(new Set(editBodies).size,1);await page.unroute('**/api/operator/plans/*');
  const originalVersion=first.version;first=(await api('/api/operator','GET',undefined,cookie)).plans.find(item=>item.id===first.id);
  assert.equal(first.version,originalVersion+1);assert.equal(first.clientName,`ООО Метр ${engine} уточнённое`);assert.equal(first.recipients[0].phone,'+70000000011');
  for(const [key,value] of Object.entries(initialCreator))assert.equal(first[key],value);
  check(`${engine}: tasks show creator, recipient bank, number, phone and limits, no task deletion, edit lost response plus 429 replays identical request once and preserves creator`);
  check(`${engine}: two tabs, default operations, multiple plans and lost plan reply plus temporary 429 use same key and create one plan`);
  const openOperation=async(plan,name)=>{
   await page.getByRole('tab',{name:'Операции',exact:true}).click();await page.getByRole('button',{name:'Новая операция',exact:true}).click();const dialog=page.getByRole('dialog');
   await dialog.getByLabel('Задание',{exact:true}).selectOption(plan.id);await dialog.getByLabel('Имя водителя',{exact:true}).fill(name);await dialog.getByLabel('Группа',{exact:true}).selectOption(group.id);await dialog.getByLabel('Сервис',{exact:true}).selectOption({label:'ГПН'});await dialog.getByLabel('Литры',{exact:true}).fill('500');await dialog.getByLabel('Цена за литр, ₽',{exact:true}).fill('70');await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('35000');return dialog;
  };
  let dialog=await openOperation(removedRecipientPlan,`Удалена параллельно ${engine}`);
  await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('300');await dialog.getByRole('button',{name:'Добавить получателя',exact:true}).click();await dialog.getByLabel('Получатель 1',{exact:true}).selectOption(removedRecipientPlan.recipients[0].id);
  let raceAttempts=0;const raceBodies=[];
  await page.route('**/api/operator/refuellings',async route=>{
   if(route.request().method()!=='POST')return route.continue();raceBodies.push(route.request().postData());raceAttempts++;
   if(raceAttempts!==1)return route.continue();
   const response=await route.fetch(),result=await response.json();assert.ok(response.ok());
   const current=(await api('/api/operator','GET',undefined,cookie)).refuellings.find(item=>item.id===result.id);
   await api(`/api/operator/refuellings/${current.id}/delete`,'PATCH',{version:current.version,idempotencyKey:randomUUID()},cookie);await route.abort();
  });
  await dialog.getByRole('button',{name:'Сохранить операцию',exact:true}).click();await expect(dialog.getByRole('button',{name:'Проверить сохранение',exact:true})).toBeEnabled();await save(dialog,'Проверить сохранение');
  assert.equal(raceBodies.length,2);assert.equal(new Set(raceBodies).size,1);await page.unroute('**/api/operator/refuellings');
  await expect(page.getByRole('status').filter({hasText:'Операция уже была удалена. Повторный запрос не восстановил её.'})).toBeVisible();await expect(page.getByRole('row').filter({hasText:`Удалена параллельно ${engine}`})).toHaveCount(0);
  assert.equal((await api('/api/operator','GET',undefined,cookie)).plans.find(item=>item.id===removedRecipientPlan.id).remaining,'1000.00');
  check(`${engine}: saved operation deleted by another user before retry resolves absent row with notice and does not resurrect or debit`);
  dialog=await openOperation(automatic,`Автораспределение ${engine}`);
  await expect(page.locator('.operator-plan-card')).toHaveCount(0);
  await dialog.getByRole('button',{name:'Добавить получателя',exact:true}).click();await dialog.getByLabel('Получатель 1',{exact:true}).selectOption(automatic.recipients[0].id);
  await expect(dialog.getByLabel('Сумма получателю 1, ₽',{exact:true})).toHaveValue('15000.00');
  await dialog.getByLabel('Литры',{exact:true}).fill('100');await dialog.getByLabel('Цена за литр, ₽',{exact:true}).fill('72');
  await expect(dialog.getByLabel('Сумма к оплате, ₽',{exact:true})).toHaveValue('6480.00');await expect(dialog.getByLabel('Сумма получателю 1, ₽',{exact:true})).toHaveValue('6480.00');
  await expect(dialog.getByRole('button',{name:'Сохранить операцию',exact:true})).toBeEnabled();
  await dialog.getByLabel('Цена за литр, ₽',{exact:true}).fill('80');await expect(dialog.getByLabel('Сумма получателю 1, ₽',{exact:true})).toHaveValue('7200.00');
  await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('6480');await expect(dialog.getByLabel('Сумма получателю 1, ₽',{exact:true})).toHaveValue('6480.00');
  await shot(page,`${engine}-auto-allocation-6480`);
  await dialog.getByLabel('Сумма получателю 1, ₽',{exact:true}).fill('15000');await expect(dialog.getByRole('button',{name:'Сохранить операцию',exact:true})).toBeDisabled();
  await expect(dialog).toContainText(/превышает сумму операции/i);
  await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('7000');await expect(dialog.getByLabel('Сумма получателю 1, ₽',{exact:true})).toHaveValue('15000');
  await shot(page,`${engine}-manual-overallocation`);
  await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('6480');await dialog.getByLabel('Сумма получателю 1, ₽',{exact:true}).fill('6480');
  const createdRequest=page.waitForRequest(request=>request.url()===runtime.base+'/api/operator/refuellings'&&request.method()==='POST');await save(dialog);const autoCreateBody=(await createdRequest).postDataJSON();
  const autoPlan=(await api('/api/operator','GET',undefined,cookie)).plans.find(item=>item.id===automatic.id);assert.equal(autoPlan.remaining,'8520.00');assert.equal(autoPlan.status,'active');
  check(`${engine}: auto suggestion follows total 15000 to 6480, manual value stays fixed with explicit total-overallocation error, saving debits only 6480`);
  let deleteRow=page.getByRole('row').filter({hasText:`Автораспределение ${engine}`});
  await deleteRow.getByRole('button',{name:`Удалить операцию Автораспределение ${engine}`,exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog).toContainText('Удаление операции');
  let deleteAttempts=0;const deleteBodies=[];
  await page.route('**/api/operator/refuellings/*/delete',async route=>{deleteBodies.push(route.request().postData());deleteAttempts++;if(deleteAttempts===1){await route.fetch();await route.abort()}else if(deleteAttempts===2)await route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({error:'Retry delete later'})});else await route.continue()});
  await dialog.getByRole('button',{name:'Удалить операцию',exact:true}).click();await expect(dialog.getByRole('button',{name:'Проверить сохранение',exact:true})).toBeEnabled();
  await page.keyboard.press('Escape');await expect(dialog).toHaveCount(1);
  await dialog.getByRole('button',{name:'Проверить сохранение',exact:true}).click();await expect(dialog).toContainText('Retry delete later');await save(dialog,'Проверить сохранение');
  assert.equal(deleteBodies.length,3);assert.equal(new Set(deleteBodies).size,1);await page.unroute('**/api/operator/refuellings/*/delete');await page.reload();await expect(deleteRow).toHaveCount(0);
  let afterDeletion=await api('/api/operator','GET',undefined,cookie);assert.equal(afterDeletion.plans.find(item=>item.id===automatic.id).remaining,'15000.00');assert.ok(!afterDeletion.refuellings.some(item=>item.name===`Автораспределение ${engine}`));
  await api('/api/operator/refuellings','POST',autoCreateBody,cookie);afterDeletion=await api('/api/operator','GET',undefined,cookie);assert.equal(afterDeletion.plans.find(item=>item.id===automatic.id).remaining,'15000.00');assert.ok(!afterDeletion.refuellings.some(item=>item.name===`Автораспределение ${engine}`));
  check(`${engine}: operation delete lost reply plus 429 retries identical request, returns limit once, old create replay cannot resurrect row`);
  dialog=await openOperation(first,`Две карты ${engine}`);
  await dialog.getByRole('button',{name:'Добавить получателя',exact:true}).click();await dialog.getByLabel('Получатель 1',{exact:true}).selectOption(first.recipients[0].id);await expect(dialog.getByLabel('Сумма получателю 1, ₽',{exact:true})).toHaveValue('10000.00');
  await expect(dialog.getByRole('button',{name:'Передать остаток менеджеру',exact:true})).toBeDisabled();
  await dialog.getByRole('button',{name:'Добавить получателя',exact:true}).click();await dialog.getByLabel('Получатель 2',{exact:true}).selectOption(first.recipients[1].id);await expect(dialog.getByLabel('Сумма получателю 2, ₽',{exact:true})).toHaveValue('25000.00');
  await dialog.getByLabel('Сумма получателю 2, ₽',{exact:true}).fill('24000');await expect(dialog.getByRole('button',{name:'Сохранить операцию',exact:true})).toBeDisabled();await dialog.getByLabel('Сумма получателю 2, ₽',{exact:true}).fill('25000');
  await shot(page,`${engine}-two-cards`);
  let attempts=0;const requestKeys=[];await page.route('**/api/operator/refuellings',async route=>{if(route.request().method()==='POST'){requestKeys.push(route.request().postDataJSON().idempotencyKey);attempts++;if(attempts===1){await route.fetch();await route.abort()}else if(attempts===2)await route.fulfill({status:429,contentType:'application/json',body:JSON.stringify({error:'Retry later'})});else await route.continue()}else await route.continue()});
  await dialog.getByRole('button',{name:'Сохранить операцию',exact:true}).click();await expect(dialog.getByRole('button',{name:'Проверить сохранение',exact:true})).toBeEnabled();await expect(dialog.getByLabel('Имя водителя',{exact:true})).toBeDisabled();await dialog.getByRole('button',{name:'Проверить сохранение',exact:true}).click();await expect(dialog).toContainText('Retry later');await expect(dialog.getByLabel('Имя водителя',{exact:true})).toBeDisabled();await save(dialog,'Проверить сохранение');assert.equal(requestKeys.length,3);assert.equal(new Set(requestKeys).size,1);await page.unroute('**/api/operator/refuellings');
  let work=await api('/api/operator','GET',undefined,cookie),plan=work.plans.find(p=>p.id===first.id),row=work.refuellings.find(r=>r.name===`Две карты ${engine}`);
  assert.equal(work.refuellings.filter(r=>r.name===row.name).length,1);assert.equal(plan.remaining,'5000.00');assert.equal(plan.recipients[0].remaining,'0.00');assert.equal(plan.recipients[1].remaining,'5000.00');assert.equal(plan.status,'active');assert.deepEqual(row.allocations.map(a=>a.amount),['10000.00','25000.00']);
  check(`${engine}: 35000 distributes 10000 + 25000, exact sum required, first card exhausted, single debit after lost reply plus temporary 429 and same-key retry`);
  dialog=await openOperation(last,`Остаток менеджеру ${engine}`);await dialog.getByRole('button',{name:'Добавить получателя',exact:true}).click();await dialog.getByLabel('Получатель 1',{exact:true}).selectOption(last.recipients[0].id);await dialog.getByRole('button',{name:'Передать остаток менеджеру',exact:true}).click();await expect(dialog.getByLabel('Сумма менеджеру, ₽',{exact:true})).toHaveValue('25000.00');await expect(dialog.getByLabel('Менеджер для остатка',{exact:true})).toHaveValue('');await expect(dialog.getByRole('button',{name:'Сохранить операцию',exact:true})).toBeDisabled();await dialog.getByLabel('Менеджер для остатка',{exact:true}).selectOption('eldar');await shot(page,`${engine}-manager-overflow`);await save(dialog);
  await page.reload();work=await api('/api/operator','GET',undefined,cookie);plan=work.plans.find(p=>p.id===last.id);row=work.refuellings.find(r=>r.name===`Остаток менеджеру ${engine}`);assert.equal(plan.status,'completed');assert.equal(plan.remaining,'0.00');assert.equal(row.allocations[1].managerId,'eldar');assert.equal(row.allocations[1].amount,'25000.00');
  let tableRow=page.getByRole('row').filter({hasText:`Остаток менеджеру ${engine}`});await expect(tableRow).toContainText('Менеджер Эльдар');await expect(tableRow).toContainText('25 000,00');await expect(tableRow).toContainText(last.clientName);await page.getByRole('tab',{name:'Задания',exact:true}).click();await page.getByRole('button',{name:/^Выполненные ·/}).click();await expect(page.locator('.operator-plan-card').filter({hasText:last.clientName})).toContainText('Выполнено');await expect(page.locator('.operator-table')).toHaveCount(0);await page.getByRole('tab',{name:'Операции',exact:true}).click();await expect(page.locator('.operator-plan-card')).toHaveCount(0);await expect(page.getByLabel('Фильтр по заданию',{exact:true})).toBeVisible();
  await tableRow.getByRole('button',{name:'Подтвердить оплату',exact:true}).click();dialog=page.getByRole('dialog');await save(dialog,'Подтвердить');await expect(tableRow.getByRole('button',{name:`Удалить операцию Остаток менеджеру ${engine}`,exact:true})).toBeDisabled();await tableRow.getByRole('button',{name:`Остаток менеджеру ${engine}`,exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog).toContainText('История оплаты');await expect(dialog.getByLabel('Сумма менеджеру, ₽',{exact:true})).toBeDisabled();await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();
  assert.equal((await api('/api/operator','GET',undefined,cookie)).plans.find(p=>p.id===last.id).remaining,'0.00');
  check(`${engine}: last card 10000 + explicit Eldar 25000 closes plan, row allocations and payment history persist; paid status does not debit again`);
  // A plan changes while the operator fills a form; rejected save preserves input and refreshes balances.
  dialog=await openOperation(first,`Устаревший план ${engine}`);await dialog.getByLabel('Сумма к оплате, ₽',{exact:true}).fill('1000');await dialog.getByRole('button',{name:'Добавить получателя',exact:true}).click();await dialog.getByLabel('Получатель 1',{exact:true}).selectOption(first.recipients[1].id);
  work=await api('/api/operator','GET',undefined,cookie);plan=work.plans.find(p=>p.id===first.id);const service=work.services.find(s=>s.name==='ГПН');
  await api('/api/operator/refuellings','POST',{schemaVersion:3,planId:plan.id,planVersion:plan.version,date:'2026-10-19',name:`Параллельный оператор ${engine}`,groupId:group.id,serviceId:service.id,serviceVersion:service.version??0,discountPercent:service.discountPercent,litres:'1',pricePerLitre:'100',amount:'100',amountMode:'manual',comment:'',allocations:[{kind:'recipient',recipientId:first.recipients[1].id,amount:'100'}],idempotencyKey:randomUUID()},cookie);
  await dialog.getByRole('button',{name:'Сохранить операцию',exact:true}).click();await expect(dialog.getByRole('button',{name:'Обновить задания и справочники',exact:true})).toBeVisible();await dialog.getByRole('button',{name:'Обновить задания и справочники',exact:true}).click();await expect(dialog.getByLabel('Имя водителя',{exact:true})).toHaveValue(`Устаревший план ${engine}`);await expect(dialog.getByLabel('Сумма получателю 1, ₽',{exact:true})).toHaveValue('1000.00');await expect(dialog).toContainText('4 900,00');await save(dialog);
  check(`${engine}: concurrent plan change rejects stale save, refresh preserves input and shows fresh limit`);
  // Editing an existing distribution returns its own old amounts to the available limit.
  tableRow=page.getByRole('row').filter({hasText:`Две карты ${engine}`});await tableRow.getByRole('button',{name:`Две карты ${engine}`,exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Задание',{exact:true})).toBeDisabled();await dialog.getByLabel('Комментарий',{exact:true}).fill('Проверено без повторного списания');await save(dialog);assert.equal((await api('/api/operator','GET',undefined,cookie)).plans.find(p=>p.id===first.id).remaining,'3900.00');
  check(`${engine}: edit retains fixed plan and restores own allocation capacity without double debit`);
  await page.getByRole('tab',{name:'Задания',exact:true}).click();await page.getByRole('button',{name:/^Активные ·/}).click();
  card=page.locator('.operator-plan-card').filter({hasText:first.clientName});await card.getByRole('button',{name:`Редактировать задание ${first.clientName}`,exact:true}).click();dialog=page.getByRole('dialog');
  await expect(dialog.getByLabel('Клиент',{exact:true})).not.toBeEditable();await expect(dialog.getByLabel('Имя получателя 1',{exact:true})).not.toBeEditable();await expect(dialog.getByRole('button',{name:'Удалить получателя 1',exact:true})).toHaveCount(0);
  await dialog.getByRole('button',{name:'Закрыть',exact:true}).click();await expect(dialog).toHaveCount(0);await page.getByRole('tab',{name:'Операции',exact:true}).click();
  check(`${engine}: used recipient identity and client stay protected in plan edit`);
  for(const width of [375,390,768,1024,1099,1100,1101,1440,1920]){
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await verifyToolbar(page,'Новая операция');await shot(page,`${engine}-operations-${width}`);
   await page.getByRole('button',{name:'Новая операция',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Задание',{exact:true}).selectOption(first.id);await dialog.getByRole('button',{name:'Добавить получателя',exact:true}).click();await dialog.getByLabel('Получатель 1',{exact:true}).selectOption(first.recipients[1].id);assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));await shot(page,`${engine}-operation-form-${width}`);await page.keyboard.press('Escape');await expect(dialog).toContainText('Закрыть форму без сохранения?');await dialog.getByRole('button',{name:'Не сохранять',exact:true}).click();
   await page.getByRole('tab',{name:'Задания',exact:true}).click();await page.getByRole('button',{name:/^Активные ·/}).click();await verifyToolbar(page,'Новое задание');await expect(page.locator('.operator-table')).toHaveCount(0);card=page.locator('.operator-plan-card').filter({hasText:first.clientName});await card.locator('summary').click();await expect(card).toContainText('3 900,00');await shot(page,`${engine}-tasks-${width}`);await page.getByRole('button',{name:'Новое задание',exact:true}).click();dialog=page.getByRole('dialog');await dialog.getByLabel('Клиент',{exact:true}).fill('Учебный несохранённый клиент');await dialog.getByRole('button',{name:'Добавить реквизиты',exact:true}).click();assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1));await shot(page,`${engine}-plan-form-${width}`);await page.keyboard.press('Escape');await dialog.getByRole('button',{name:'Не сохранять',exact:true}).click();await page.getByRole('tab',{name:'Операции',exact:true}).click();
   check(`${engine}: cards/journal and both forms fit ${width}px; unsaved edits require discard`);
  }
  for(const width of [320,201,149]){
   await page.setViewportSize({width,height:1000});await page.evaluate(()=>new Promise(done=>requestAnimationFrame(()=>requestAnimationFrame(done))));
   const geometry=await page.evaluate(()=>({document:document.documentElement.scrollWidth,viewport:innerWidth,workspace:document.querySelector('.operator-workspace').getBoundingClientRect().width}));
   assert.ok(geometry.document>=375,JSON.stringify(geometry));assert.ok(geometry.workspace>=343,JSON.stringify(geometry));await verifyToolbar(page,'Новая операция');await shot(page,`${engine}-minimum-width-${width}`);
   check(`${engine}: ${width}px viewport keeps at least 375px layout and toolbar row`);
  }
  await context.close();await browser.close();browser=null;
 }
 const before=await api('/api/operator','GET',undefined,cookie);await runtime.replaceMiddleware();const after=await api('/api/operator','GET',undefined,cookie);assert.deepEqual(after.plans,before.plans);assert.deepEqual(after.refuellings,before.refuellings);check('store reconstruction preserves all plans, allocations, closure and payment history');assert.deepEqual(report.errors,[]);report.passed=true;
} finally {await browser?.close();await runtime.server.close();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await rm(temporary,{recursive:true,force:true})}

import {chromium,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {writeTripsQaSnapshot} from './qa-trips-runtime.mjs';
import {startOperatorQaServer} from './qa-operator-runtime.mjs';
import {authenticateContext} from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'),directory=await mkdtemp(resolve(tmpdir(),'artel-receivers-'));
const snapshotDirectory=resolve(directory,'snapshot'),operationsDirectory=resolve(directory,'store');await writeTripsQaSnapshot(snapshotDirectory);
const rt=await startOperatorQaServer({root,snapshotDirectory,operationsDirectory}),auth=await rt.bootstrap();
const out=resolve(root,'../ui',process.env.ARTEL_OPERATOR_QA_BUILT==='1'?'built':'source');await mkdir(out,{recursive:true});
const report={passed:false,synthetic:true,checks:[],axe:[],errors:[],external:[]};
const api=async(path,method='GET',body)=>{const response=await fetch(rt.base+path,{method,headers:{cookie:auth.cookie,Origin:rt.base,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return {status:response.status,body:await response.json()}};
try{
 for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
  const name=`Клиент ${engine}`;
  const created=await api('/api/directories','POST',{kind:'companies',name,roles:['customer'],addresses:[{name:'Первая площадка',kind:'delivery',receiverName:'Первый',receiverPhone:'+7 900 000-00-01'},{name:'Вторая площадка',kind:'delivery',receiverName:'Другой адрес',receiverPhone:'+7 900 000-00-09'}]});assert.equal(created.status,201,JSON.stringify(created.body));const id=created.body.entry.id;
  const state=async()=>{const {body:s}=await api('/api/directories');return {company:s.companies.find(c=>c.id===id),addresses:s.directories.addresses.filter(a=>a.companyId===id)}};
  const browser=await launcher.launch();try{
   const context=await browser.newContext({viewport:{width:1440,height:1100},serviceWorkers:'block',reducedMotion:'reduce'});await authenticateContext(context,rt.base,auth.cookie);
   await context.route('**/*',route=>{const url=new URL(route.request().url());if(url.origin!==rt.base){report.external.push(url.origin);return route.abort()}return route.continue()});
   const page=await context.newPage();page.setDefaultTimeout(15000);page.on('pageerror',e=>report.errors.push(e.message));
   await page.goto(rt.base+'/#directories');
   const edit=async()=>{await page.getByLabel('Поиск в справочнике',{exact:true}).fill(name);await page.getByRole('button',{name:`Редактировать: ${name}`,exact:true}).click();return page.getByRole('dialog')};
   let dialog=await edit();let contacts=dialog.getByRole('region',{name:'Приёмщики: адрес 1',exact:true});
   await expect(contacts.getByLabel('Имя приёмщика 1: адрес 1',{exact:true})).toHaveValue('Первый');
   for(const i of [2,3]){await contacts.getByRole('button',{name:'Добавить приёмщика',exact:true}).click();await contacts.getByLabel(`Имя приёмщика ${i}: адрес 1`,{exact:true}).fill(`Приёмщик ${i}`);await contacts.getByLabel(`Телефон приёмщика ${i}: адрес 1`,{exact:true}).fill(`+7 900 000-00-0${i}`)}
   for(const width of [320,375,390,768,1024,1440]){
    await page.setViewportSize({width,height:1100});await contacts.scrollIntoViewIfNeeded();
    assert.ok(await dialog.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'dialog overflow');
    assert.ok(await contacts.evaluate(el=>el.scrollWidth<=el.clientWidth+1),'contacts overflow');
    const a=await new AxeBuilder({page}).include('.directory-editor').withTags(['wcag2a','wcag2aa','wcag21a','wcag21aa']).analyze();report.axe.push({engine,width,violations:a.violations});assert.equal(a.violations.length,0,JSON.stringify(a.violations));
    await contacts.screenshot({path:resolve(out,`${engine}-${width}.png`)});report.checks.push({engine,width});
   }
   await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog).toHaveCount(0);console.log('saved, restarting');await rt.replaceMiddleware();console.log('restarted');
   dialog=await edit();contacts=dialog.getByRole('region',{name:'Приёмщики: адрес 1',exact:true});await expect(contacts.getByLabel('Имя приёмщика 3: адрес 1',{exact:true})).toHaveValue('Приёмщик 3');
   await expect(dialog.getByLabel('Имя приёмщика 1: адрес 2',{exact:true})).toHaveValue('Другой адрес');
   // Delete primary: next contact becomes primary and persists.
   await contacts.getByRole('button',{name:'Удалить приёмщика 1: адрес 1',exact:true}).click();await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog).toHaveCount(0);
   console.log('deleted primary');let current=await state();assert.equal(current.addresses[0].receiverName,'Приёмщик 2');assert.equal(current.addresses[0].additionalReceivers[0].name,'Приёмщик 3');report.checks.push({engine,case:'save/restart/reopen, two addresses isolated, delete primary'});
   dialog=await edit();contacts=dialog.getByRole('region',{name:'Приёмщики: адрес 1',exact:true});await contacts.getByLabel('Имя приёмщика 2: адрес 1',{exact:true}).fill('Моё изменение');
   current=await state();const a=current.addresses[0];const updated=await api(`/api/directories/addresses/${a.id}`,'PATCH',{version:a.version??0,name:a.name,companyId:id,addressKind:a.kind,additionalReceivers:[{name:'Чужое изменение',phone:'+7 900 000-00-03'}]});assert.equal(updated.status,200);
   await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog.getByRole('region',{name:'Сверка изменений'})).toBeVisible();assert.equal((await state()).addresses[0].additionalReceivers[0].name,'Чужое изменение');
   // Close without changing the remotely saved value.
   await dialog.getByRole('button',{name:'Отмена',exact:true}).click();await dialog.getByRole('button',{name:'Не сохранять',exact:true}).click();await expect(dialog).toHaveCount(0);report.checks.push({engine,case:'concurrent contact conflict preserves remote and cancel discards local'});
   // Direct address endpoint validates every contact atomically.
   current=await state();const old=current.addresses[0];const bad=await api(`/api/directories/addresses/${old.id}`,'PATCH',{version:old.version,name:old.name,companyId:id,addressKind:old.kind,additionalReceivers:[{name:'Некорректный',phone:'не телефон'}]});assert.equal(bad.status,400);assert.deepEqual((await state()).addresses,current.addresses);report.checks.push({engine,case:'invalid phone rejected without writes'});
   await page.reload();await page.getByRole('group',{name:'Справочники',exact:true}).getByRole('button',{name:'Места погрузки и доставки',exact:true}).click();await page.getByLabel('Поиск в справочнике',{exact:true}).fill(name);
   await page.getByRole('button',{name:'Редактировать: Первая площадка',exact:true}).click();dialog=page.getByRole('dialog');contacts=dialog.getByRole('region',{name:'Приёмщики: адрес',exact:true});
   await expect(contacts.getByLabel('Имя приёмщика 2: адрес',{exact:true})).toHaveValue('Чужое изменение');
   await contacts.getByRole('button',{name:'Добавить приёмщика',exact:true}).click();await contacts.getByLabel('Имя приёмщика 3: адрес',{exact:true}).fill('Прямой редактор');await contacts.getByLabel('Телефон приёмщика 3: адрес',{exact:true}).fill('+7 900 000-00-04');
   await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog).toHaveCount(0);assert.equal((await state()).addresses[0].additionalReceivers[1].name,'Прямой редактор');
   await page.getByRole('button',{name:'Редактировать: Первая площадка',exact:true}).click();dialog=page.getByRole('dialog');contacts=dialog.getByRole('region',{name:'Приёмщики: адрес',exact:true});
   for(let i=0;i<3;i++)await contacts.getByRole('button',{name:'Удалить приёмщика 1: адрес',exact:true}).click();
   await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog).toHaveCount(0);const cleared=(await state()).addresses[0];assert.equal(cleared.receiverName,undefined);assert.equal(cleared.receiverPhone,undefined);assert.equal(cleared.additionalReceivers,undefined);report.checks.push({engine,case:'standalone editor persists extras and supports explicit removal of all contacts'});

  }finally{await browser.close()}
 }
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.external,[]);report.passed=true;
}finally{await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));await rt.server.close();await rm(directory,{recursive:true,force:true,maxRetries:5})}
console.log(JSON.stringify(report));

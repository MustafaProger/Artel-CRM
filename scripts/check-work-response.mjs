import {OperationsStore} from '../server/operations-store.ts';
import {migrateWorkStorage} from '../server/work-partition.ts';
import {chromium,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeTripsQaSnapshot} from './qa-trips-runtime.mjs';
import {startOperatorQaServer} from './qa-operator-runtime.mjs';
import {authenticateContext} from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'),out=resolve(root,'../ui',process.env.ARTEL_OPERATOR_QA_BUILT==='1'?'built':'source');
const temporary=await mkdtemp(resolve(tmpdir(),'artel-work-response-')),snapshotDirectory=resolve(temporary,'snapshot'),operationsDirectory=resolve(temporary,'store');
await mkdir(out,{recursive:true});const fixtureSource=await writeTripsQaSnapshot(snapshotDirectory);
if(process.env.ARTEL_TEST_WORK_PARTITION==='1'){await new OperationsStore(operationsDirectory).mutate(fixtureSource,()=>({result:null,changed:true}));await migrateWorkStorage(operationsDirectory,fixtureSource);}
const report={passed:false,synthetic:true,checks:[],axe:[],errors:[],externalRequests:[],timings:[]};
const check=n=>{report.checks.push(n);console.log('PASS',n)};
let runtime;
try{
 runtime=await startOperatorQaServer({root,snapshotDirectory,operationsDirectory});const {cookie}=await runtime.bootstrap();
 const api=async(path,method='GET',body)=>{const res=await fetch(runtime.base+path,{method,headers:{Cookie:cookie,Origin:runtime.base,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await res.json();assert.ok(res.ok,JSON.stringify(result));return result};
 const task=(await api('/api/work/tasks','POST',{requestId:randomUUID(),title:'Проверить документы',description:'Сверить объём поставки и подтвердить комплект документов.'})).entry;
 await api('/api/work/tasks','POST',{requestId:randomUUID(),title:'Согласовать время доставки с получателем на объекте',status:'doing',comment:'Уточнить контакт получателя'});
 await api('/api/work/tasks','POST',{requestId:randomUUID(),title:'Отправить документы поставщику',status:'done'});
 await api('/api/work/notes','POST',{requestId:randomUUID(),title:'На эту неделю',content:'Подготовить документы для следующей поставки.'});
 for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
 const browser=await launcher.launch();try{
 const ctx=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});await authenticateContext(ctx,runtime.base,cookie);
 await ctx.route('**/*',route=>{if(new URL(route.request().url()).origin!==runtime.base){report.externalRequests.push(route.request().url());return route.abort()}return route.continue()});
 const page=await ctx.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.goto(runtime.base+'/#work');
 const box=page.getByRole('checkbox',{name:'Выполнена: Проверить документы',exact:true}),row=page.locator('.work-task-row').filter({has:box});await expect(box).not.toBeChecked();
 // Hold both an older list read and the PATCH: the feedback must not wait on either.
 let releaseRead,readStarted;const readGate=new Promise(r=>releaseRead=r),started=new Promise(r=>readStarted=r);const stale=await api('/api/work');let gets=0;
 await page.route('**/api/work',async route=>{if(route.request().method()==='GET'){gets++;readStarted();await readGate;await route.fulfill({json:stale}).catch(()=>{});}else await route.continue()});
 await page.getByRole('button',{name:'Обновить работу',exact:true}).click();await started;
 let releasePatch;const patchGate=new Promise(r=>releasePatch=r);let patches=0;
 await page.route('**/api/work/tasks/*',async route=>{patches++;await patchGate;await route.continue()});
 const beforeOrder=await page.locator('.work-task-open strong').allTextContents();const began=performance.now();await box.focus();await box.press('Space');await expect(box).toBeChecked({timeout:250});await expect(row.getByRole('status')).toHaveText('Сохраняем…');
 report.timings.push({engine,feedbackMs:performance.now()-began,patchHeld:true});await expect(box).toBeDisabled();
 assert.equal((await api('/api/work')).work.tasks.find(r=>r.id===task.id).status,'todo');
 releaseRead();await page.waitForTimeout(250);await expect(box).toBeChecked();await expect(row.getByRole('status')).toHaveText('Сохраняем…');
 releasePatch();await expect(box).toBeEnabled();await expect(row.getByRole('status')).toHaveText('Готово');assert.equal((await api('/api/work')).work.tasks.find(r=>r.id===task.id).status,'done');
 await page.waitForTimeout(250);assert.equal(gets,1,'No extra full Work read after saving');assert.equal(patches,1);assert.deepEqual(await page.locator('.work-task-open strong').allTextContents(),beforeOrder);
 await page.unroute('**/api/work');await page.unroute('**/api/work/tasks/*');check(engine+': immediate pending feedback, stale read ignored, no follow-up GET, stable order, one PATCH');
 await box.click();await expect(box).not.toBeChecked();await expect(box).toBeEnabled();assert.equal((await api('/api/work')).work.tasks.find(r=>r.id===task.id).status,'todo');check(engine+': uncheck persists and unlocks directly from PATCH');
 await page.route('**/api/work/tasks/*',route=>route.fulfill({status:409,json:{error:'Задача изменена другим сотрудником.'}}));await box.click();await expect(row.getByRole('alert')).toContainText('Задача изменена');await expect(box).not.toBeChecked();await expect(box).toBeEnabled();await page.unroute('**/api/work/tasks/*');check(engine+': version conflict rolls back optimism and shows inline error');
 await row.getByRole('button',{name:'Обновить',exact:true}).click();await expect(row.getByRole('alert')).toHaveCount(0);
 await page.route('**/api/work/tasks/*',route=>route.abort('failed'));await box.click();await expect(row.getByRole('alert')).toContainText('Не удалось подтвердить');await expect(box).not.toBeChecked();await page.unroute('**/api/work/tasks/*');await row.getByRole('button',{name:'Обновить',exact:true}).click();await expect(row.getByRole('alert')).toHaveCount(0);check(engine+': network failure shows reconciliation message without false completion');
 for(const width of [320,390,768,1440]){
 await page.setViewportSize({width,height:1000});await box.focus();const g=await row.evaluate(el=>{const box=el.querySelector('.work-task-check-box').getBoundingClientRect(),title=el.querySelector('strong').getBoundingClientRect();return{centerDelta:Math.abs((box.top+box.bottom-title.top-title.bottom)/2),scroll:document.documentElement.scrollWidth,viewport:innerWidth}});assert.ok(g.centerDelta<=2,JSON.stringify(g));assert.ok(g.scroll<=width+1);
 const a=await new AxeBuilder({page}).include('.work-page').analyze();report.axe.push({engine,width,violations:a.violations});assert.equal(a.violations.length,0);await page.screenshot({path:resolve(out,`${engine}-${width}.png`)});check(`${engine}: ${width} alignment/focus/layout/axe`);
 }
 await page.getByRole('button',{name:'Задача: Проверить документы',exact:true}).click();await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByLabel('Срок задачи',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Отмена',exact:true}).click();check(engine+': editor still works separately');

 let editorGets=0;await page.route('**/api/work',async route=>{editorGets++;await route.continue()});
 await page.getByRole('button',{name:'Новая задача',exact:true}).click();await page.getByLabel('Название',{exact:true}).fill('Проверка отдельного хранилища');
 let releaseCreate,createStarted;const createGate=new Promise(r=>releaseCreate=r),createSeen=new Promise(r=>createStarted=r);
 await page.route('**/api/work/tasks',async route=>{createStarted();await createGate;await route.continue()});
 await page.getByRole('button',{name:'Сохранить',exact:true}).click();await createSeen;await expect(page.getByRole('button',{name:'Сохранение…',exact:true})).toBeDisabled();
 releaseCreate();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Задача: Проверка отдельного хранилища',exact:true})).toBeVisible();
 assert.equal(editorGets,0,'Editor must apply POST response without another GET');await page.unroute('**/api/work/tasks');
 await page.getByRole('button',{name:'Задача: Проверка отдельного хранилища',exact:true}).click();await page.getByLabel('Название',{exact:true}).fill('Исправленная задача');await page.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Задача: Исправленная задача',exact:true}).click();await page.getByRole('button',{name:'В архив задач',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Задача: Исправленная задача',exact:true})).toHaveCount(0);
 await page.getByRole('button',{name:'Архив задач',exact:true}).click();await page.getByRole('button',{name:'Задача: Исправленная задача',exact:true}).click();await page.getByRole('button',{name:'Вернуть в работу',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
 await page.getByRole('button',{name:'Задачи',exact:true}).click();await page.getByRole('button',{name:'Задача: Исправленная задача',exact:true}).click();await page.getByRole('button',{name:'Удалить',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.getByRole('button',{name:'Задача: Исправленная задача',exact:true})).toHaveCount(0);
 assert.equal(editorGets,0);await page.unroute('**/api/work');check(engine+': editor create/edit/archive/restore/delete from response without follow-up GET');
 await ctx.close();
 }finally{await browser.close()}}
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.passed=true;
}finally{await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));await runtime?.server.close();await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100})}

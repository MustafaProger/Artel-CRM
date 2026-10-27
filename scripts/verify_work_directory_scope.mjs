import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), built = process.argv.includes('--built');
const output = resolve(root, '.local/work-directory-scope', built ? 'built' : 'source');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-work-scope-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await mkdir(output, { recursive: true }); await writeTripsQaSnapshot(snapshotDirectory);
const snapshot = await loadSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const companies = [
 ['client', 'QA Клиент', ['customer'], false], ['supplier', 'QA Поставщик', ['supplier'], false],
 ['both', 'QA Обе роли', ['customer','supplier'], false], ['bank', 'QA Бигуняк', ['payment_counterparty'], false],
 ['carrier', 'QA Перевозчик', ['carrier'], false], ['archived', 'QA Архив', ['customer'], true],
].map(([id,name,roles,directoryArchived]) => ({id,name,roles,directoryArchived,managerLabels:[],shipmentIds:[],paymentIds:[],flags:[]}));
await store.mutate(snapshot.provenance.sourceSha256, data => {
 data.sourceOperationsCleared = true; data.companies = companies;
 data.directories = { fleetSeedApplied:true,managers:[],products:[],paymentForms:[],drivers:[],vehicles:[],oilDepots:[],addresses:[],customerManagers:[],defaults:{profit:'template-payment-form'},duplicates:[],deletedEntries:{companies:snapshot.companies.map(c=>c.id)} };
 return {changed:true,result:null};
});
const report = {synthetic:true,passed:false,errors:[],checks:[]};let runtime,browser;
try {
 runtime = await startTripsQaServer({root,snapshotDirectory,operationsDirectory});
 if(built) runtime.server.middlewares.stack.unshift({route:'',handle(req,res,next){
  const path=new URL(req.url,runtime.base).pathname;if(path.startsWith('/api/'))return next();
  const relative=path==='/'?'index.html':path.slice(1);if(relative.includes('..'))return next();
  readFile(resolve(root,'app-dist',relative)).then(body=>{res.setHeader('Content-Type',relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':relative.endsWith('.svg')?'image/svg+xml':'text/html');res.end(body);}).catch(()=>next());
 }});
 const {cookie}=await bootstrapQaAuth(runtime.base);
 const api=async(path)=>{const r=await fetch(runtime.base+path,{headers:{Cookie:cookie}});assert.ok(r.ok);return r.json();};
 const actor=(await api('/api/work')).currentUser;
 await store.mutate(snapshot.provenance.sourceSha256,data=>{
  const now=new Date().toISOString();data.work={notes:[],companyRecords:[],tasks:[{id:'legacy-task',version:1,title:'Историческая задача QA',description:'',status:'todo',companyId:'bank',assigneeId:actor.id,createdBy:actor.id,updatedBy:actor.id,createdAt:now,updatedAt:now,dueDate:null,reminderAt:null}]};return {changed:true,result:null};
 });
 const response=await api('/api/work');assert.deepEqual(response.companies.map(c=>c.id).sort(),['bank','both','client','supplier']);
 const before=await readFile(store.path,'utf8');
 for(const [engine,driver]of [['chromium',chromium],['webkit',webkit]]){
  browser=await driver.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
  await authenticateContext(context,runtime.base,cookie);
  await context.route('**/*',route=>new URL(route.request().url()).origin===runtime.base?route.continue():route.abort());
  const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));
  for(const width of [1440,390]){
   await page.setViewportSize({width,height:1000});await page.goto(runtime.base+'/#work');
   await page.getByRole('button',{name:'Новая задача',exact:true}).click();const dialog=page.getByRole('dialog');const combo=dialog.getByRole('combobox',{name:/^Компания/});
   await combo.click();const options=dialog.getByRole('listbox',{name:'Компания',exact:true}).getByRole('option');
   await expect(options).toHaveCount(3);assert.deepEqual((await options.allTextContents()).sort(),['QA Клиент','QA Обе роли','QA Поставщик']);
   await combo.fill('Бигуняк');await expect(options).toHaveCount(0);
   await combo.fill('');await dialog.getByRole('button',{name:'Отмена',exact:true}).click();
   await page.getByRole('button',{name:'Задача: Историческая задача QA',exact:true}).click();await expect(combo).toHaveValue('QA Бигуняк');
   await dialog.getByRole('button',{name:'Отмена',exact:true}).click();
   await page.getByRole('button',{name:'Новая задача',exact:true}).click();await combo.click();await expect(options).toHaveCount(3);
   await page.screenshot({path:resolve(output,engine+'-'+width+'.png')});await dialog.getByRole('button',{name:'Отмена',exact:true}).click();
   report.checks.push({engine,width,clientsSuppliersOnly:true,dualRoleOnce:true,bankExcluded:true,historyPreserved:true});
  }
  await browser.close();browser=null;
 }
 assert.equal(await readFile(store.path,'utf8'),before);report.storeUnchanged=true;assert.deepEqual(report.errors,[]);report.passed=true;
}finally{await browser?.close();await runtime?.server.close();await writeFile(resolve(output,'result.json'),JSON.stringify(report,null,2));await rm(temporary,{recursive:true,force:true});}
console.log(JSON.stringify(report));

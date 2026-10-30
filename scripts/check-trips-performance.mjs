// Real source/built CRM and API, synthetic data, loopback only. Tiles are a local visual fixture.
import assert from 'node:assert/strict';
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {dirname,resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {chromium,webkit,expect} from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import {integrationRuntime} from '../tests/helpers/trip-saby-integration.ts';
import {startOperatorQaServer} from './qa-operator-runtime.mjs';
import {authenticateContext} from './qa-auth.mjs';
import {migrateWorkStorage,WorkPartition} from '../server/work-partition.ts';
import {normalizeTbank} from '../server/banking/adapters.ts';
import {emptyBanking} from '../server/banking/domain.ts';
import {fixtureConfig,fixtureDay,accountNumber,tbankRow} from '../tests/banking-fixtures.ts';
const root=resolve(import.meta.dirname,'..'),baseline=process.argv.includes('--baseline'),review=process.argv.includes('--review');
const output=resolve(process.env.TRIPS_QA_OUTPUT??'../trips-ui',process.env.ARTEL_OPERATOR_QA_BUILT==='1'?'built':'source');await mkdir(output,{recursive:true});
const report={synthetic:true,baseline,passed:false,checks:[],measurements:[],axe:[],external:[],errors:[],tilesStubbed:true};
const check=name=>{report.checks.push(name);console.log('PASS',name)};
const f=await integrationRuntime();let runtime;
try {
 await f.store.mutate(f.source,d=>{
  d.banking=emptyBanking();const c=fixtureConfig();d.banking.operations=Array.from({length:3500},(_,i)=>normalizeTbank(c,{number:accountNumber,currency:'RUB'},fixtureDay,tbankRow(`perf-${i}`)));
  for(const a of d.directories.addresses){a.latitude='55.7';a.longitude='37.6';}for(const a of d.directories.oilDepots){a.latitude='55.71';a.longitude='37.61';}
  return{changed:true,result:null};
 });
 await migrateWorkStorage(dirname(f.store.path),f.source);
 runtime=await startOperatorQaServer({root,snapshotDirectory:f.snapshotDirectory,operationsDirectory:dirname(f.store.path),port:review?5194:0});const {cookie}=await runtime.bootstrap();
 const api=async(path,method='GET',body)=>{const r=await fetch(runtime.base+path,{method,headers:{Cookie:cookie,Origin:runtime.base,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const v=await r.json();assert.ok(r.ok,JSON.stringify(v));return v};
 const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
 const input=()=>({companyId:'customer',addressId:'delivery',quantityLitres:'1000',salePricePerLitre:'61.25',executionDate:date,comment:'Синтетическая заявка',idempotencyKey:randomUUID()});
 await api('/api/trip-requests','POST',input());
 if(review){
  assert.equal(runtime.mode,'source');runtime.server.middlewares.stack.unshift({route:'',handle(req,res,next){
   if(req.url==='/__preview'){res.writeHead(302,{'Set-Cookie':`${cookie}; HttpOnly; SameSite=Strict; Path=/`,Location:'/#trips'});res.end();return;}
   if(req.url?.startsWith('/api/maps/yandex/tiles?')){res.writeHead(200,{'Content-Type':'image/svg+xml'});res.end('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eaf0e5"/><text x="40" y="140" fill="#68796a">Локальная карта QA</text></svg>');return;}
   next();
  }});console.log('REVIEW '+runtime.base+'/__preview');await new Promise(done=>{process.once('SIGTERM',done);process.once('SIGINT',done)});
 }else{
 const original=await f.store.read(f.source);const part=new WorkPartition(f.store.path),workBefore=await readFile(part.workPath,'utf8');
 for(const [engine,launcher] of (baseline?[['chromium',chromium]]:[['chromium',chromium],['webkit',webkit]])){
  const browser=await launcher.launch();try{
   const context=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});await authenticateContext(context,runtime.base,cookie);
   await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==runtime.base){report.external.push(u.origin);return route.abort();}if(u.pathname==='/api/maps/yandex/tiles')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#eaf0e5"/></svg>'});return route.continue()});
   const page=await context.newPage(),calls=[];page.on('pageerror',e=>report.errors.push(e.message));page.on('request',r=>{if(new URL(r.url()).pathname.startsWith('/api/'))calls.push({path:new URL(r.url()).pathname,method:r.method()})});
   let t=performance.now();await page.goto(runtime.base+'/#trips');await expect(page.locator('.trip-request-card')).toHaveCount(1);report.measurements.push({engine,phase:'cold',action:'ready',uiMs:performance.now()-t});
   if(!baseline){assert.equal(calls.filter(c=>c.path==='/api/shipment-trips').length,0);assert.equal(calls.filter(c=>c.path==='/api/snapshot').length,0);check(engine+': initial requests avoid financial snapshot and trip list');}
   t=performance.now();await page.reload();await expect(page.locator('.trip-request-card')).toHaveCount(1);report.measurements.push({engine,phase:'reload',action:'ready',uiMs:performance.now()-t});
   const tabs=page.locator('.trips-section-tabs'),choose=async(label,name)=>{const box=page.getByRole('dialog').getByRole('combobox',{name:new RegExp('^'+label)});await box.fill(name);await page.getByRole('listbox').getByRole('option').first().click()};
   const create=async(phase)=>{
    const before=(await api('/api/trip-requests')).requests.length;await page.getByRole('button',{name:'Новая заявка',exact:true}).click();await choose('Компания','ПолучательТестовый');await choose('Место доставки','Доставка');await page.getByLabel('Количество литров, л',{exact:false}).fill('1234');
    const mark=calls.length;let ack;
    const response=page.waitForResponse(r=>new URL(r.url()).pathname==='/api/trip-requests'&&r.request().method()==='POST').then(async r=>{const v=await r.json();assert.equal(r.status(),201);ack=performance.now();return v.request});
    const start=performance.now();await page.getByRole('button',{name:'Сохранить заявку',exact:true}).click();const saved=await response;await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.trip-request-card')).toHaveCount(before+1);
    report.measurements.push({engine,phase,action:'create',ackMs:ack-start,uiMs:performance.now()-start,followupGets:calls.slice(mark).filter(c=>c.method==='GET').map(c=>c.path)});
    if(!baseline)assert.equal(calls.slice(mark).filter(c=>c.method==='GET').length,0);
    return saved;
   };
   const remove=async(saved,phase)=>{
    const count=await page.locator('.trip-request-card').count();const card=page.locator('.trip-request-card').filter({hasText:'1 234'.replace(' ','\u00a0')});await card.getByRole('button',{name:/Удалить заявку:/}).click();let ack;
    const mark=calls.length,response=page.waitForResponse(r=>r.request().method()==='DELETE'&&r.url().includes(saved.id)).then(async r=>{await r.json();assert.equal(r.status(),200);ack=performance.now()});
    const start=performance.now();await page.getByRole('dialog').getByRole('button',{name:'Удалить заявку',exact:true}).click();await response;await expect(page.getByRole('dialog')).toHaveCount(0);await expect(page.locator('.trip-request-card')).toHaveCount(count-1);
    report.measurements.push({engine,phase,action:'delete',ackMs:ack-start,uiMs:performance.now()-start,followupGets:calls.slice(mark).filter(c=>c.method==='GET').map(c=>c.path)});if(!baseline)assert.equal(calls.slice(mark).filter(c=>c.method==='GET').length,0);
   };
   const map=async(phase)=>{const mark=calls.length,start=performance.now();await tabs.getByRole('button',{name:'Карта',exact:true}).click();await expect(page.locator('.trip-map-marker')).toHaveCount(1);await expect(page.locator('.trip-map-canvas canvas').first()).toBeVisible();await expect(page.getByText('Загружаем карту…',{exact:true})).toHaveCount(0);report.measurements.push({engine,phase,action:'map-markers-and-canvas',uiMs:performance.now()-start,requests:calls.slice(mark)});if(!baseline)assert.equal(calls.slice(mark).filter(c=>c.path==='/api/shipment-trips').length,0);await tabs.getByRole('button',{name:'Заявки',exact:true}).click();await expect(page.locator('.trip-request-card')).toHaveCount(1)};
   let saved=await create('cold');await remove(saved,'cold');await map('cold');
   if(engine==='chromium' && process.env.QA_SKIP_WARM!=='1'){console.log('Waiting one minute on requests for warm measurements');await new Promise(done=>setTimeout(done,60000));saved=await create('after-60s');await remove(saved,'after-60s');await map('after-60s');}
   check(engine+': real persisted create/delete and map, cold/warm metrics');
   if(!baseline){
    let releaseAck,ackStarted,ackSettled;const ackGate=new Promise(done=>releaseAck=done),ackSeen=new Promise(done=>ackStarted=done),ackComplete=new Promise(done=>ackSettled=done);
    await page.route('**/api/trip-requests',async route=>{if(route.request().method()==='POST'){const response=await route.fetch();ackStarted();await ackGate;await route.fulfill({response});ackSettled();return;}return route.continue()});
    const pendingCreate=create('held-ack');await ackSeen;await expect(page.locator('.trip-request-card')).toHaveCount(1);await expect(page.getByRole('dialog')).toBeVisible();await expect(page.getByRole('button',{name:'Сохранить заявку',exact:true})).toBeDisabled();releaseAck();saved=await pendingCreate;await ackComplete;await page.unroute('**/api/trip-requests');await remove(saved,'held-ack');check(engine+': no success before acknowledged server response');
    // A saved response must remain visible when an older list finishes later.
    let release,seen,settled;const completed=new Promise(done=>settled=done);const gate=new Promise(done=>release=done),started=new Promise(done=>seen=done);let hold=true;
    await page.route('**/api/trip-requests',async route=>{if(route.request().method()==='GET'&&hold){hold=false;const response=await route.fetch();seen();await gate;await route.fulfill({response});settled();return;}return route.continue()});
    await page.getByRole('button',{name:'Новая заявка',exact:true}).click();await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();await started;
    saved=await create('stale-get');release();await completed;await page.unroute('**/api/trip-requests');await expect(page.locator('.trip-request-card')).toHaveCount(2);await remove(saved,'stale-get');check(engine+': delayed older GET cannot undo acknowledged create');
    // Keep the record until DELETE is acknowledged; fail visibly and preserve the dialog.
    await page.locator('.trip-request-card').getByRole('button',{name:/Удалить заявку:/}).click();
    await page.route('**/api/trip-requests/*',route=>route.request().method()==='DELETE'?route.fulfill({status:409,json:{error:'QA: заявка уже изменилась'}}):route.continue());await page.getByRole('dialog').getByRole('button',{name:'Удалить заявку',exact:true}).click();await expect(page.getByRole('alert')).toContainText('QA: заявка уже изменилась');await expect(page.locator('.trip-request-card')).toHaveCount(1);await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();await page.unroute('**/api/trip-requests/*');check(engine+': conflicting DELETE preserves record and shows failure');
    for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});await expect(page.locator('.trip-request-card')).toHaveCount(1);assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const axe=await new AxeBuilder({page}).include('.trips-page').analyze();assert.equal(axe.violations.length,0,JSON.stringify(axe.violations));report.axe.push({engine,width,violations:0});await page.screenshot({path:resolve(output,`${engine}-${width}.png`)});}
    await tabs.getByRole('button',{name:'Рейсы',exact:true}).click();await expect(page.locator('.trip-card')).toHaveCount(1);await tabs.getByRole('button',{name:'Заявки',exact:true}).click();await expect(page.locator('.trip-request-card')).toHaveCount(1);check(engine+': lazy trip list and responsive/axe pass');
   }
   await context.close();
  }finally{await browser.close()}
 }
 const after=await f.store.read(f.source);for(const key of ['banking','shipments','directories','accounts','tripExecutions','tripNumbers','saby'])assert.deepEqual(after[key],original[key]);assert.equal(await readFile(part.workPath,'utf8'),workBefore);
 await runtime.replaceMiddleware();assert.equal((await api('/api/trip-requests')).requests.length,1);check('restart, banking/directories/previous trips/Work exact');assert.deepEqual(report.external,[]);assert.deepEqual(report.errors,[]);report.passed=true;
 }
}finally{await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await runtime?.server.close();await f.close();}

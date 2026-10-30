// Browser-clock auth readiness with real loopback middleware, synthetic split storage and real scrypt.
// SOURCE_ROOT=/path/to/source MODE=built|source ROUNDS=3 node --import tsx scripts/profile-auth-ui.mjs report.json
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {createHash} from 'node:crypto';
import {readFile,writeFile,mkdir,stat} from 'node:fs/promises';
import {resolve,dirname,relative,extname,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {chromium,webkit,expect as baseExpect} from '@playwright/test';
import {createServer as createViteServer} from 'vite';
import react from '@vitejs/plugin-react';
const root=resolve(process.env.SOURCE_ROOT??resolve(dirname(fileURLToPath(import.meta.url)),'..')),mode=process.env.MODE??'built',engine=process.env.ENGINE??'chromium',rounds=Number(process.env.ROUNDS??3);
const output=resolve(process.argv[2]??'auth-ui.json'),expect=baseExpect.configure({timeout:20000});
assert.ok(['built','source'].includes(mode)&&['chromium','webkit'].includes(engine)&&Number.isSafeInteger(rounds)&&rounds>0);
for(const key of Object.keys(process.env))if(/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key))delete process.env[key];
const moduleAt=path=>import(pathToFileURL(resolve(root,path)).href);
const [{integrationRuntime},{createSnapshotMiddleware},{OperationsStore},{migrateWorkStorage},{normalizeTbank},{emptyBanking},fixtures,{passwordFields}]=await Promise.all([
 moduleAt('tests/helpers/trip-saby-integration.ts'),moduleAt('server/local-api.ts'),moduleAt('server/operations-store.ts'),moduleAt('server/work-partition.ts'),moduleAt('server/banking/adapters.ts'),moduleAt('server/banking/domain.ts'),moduleAt('tests/banking-fixtures.ts'),moduleAt('server/auth.ts'),
]);
const harnessSha256=createHash('sha256').update(await readFile(fileURLToPath(import.meta.url))).digest('hex');
const f=await integrationRuntime(),password='Synthetic-auth-performance-password-only',loginName='qa.auth.perf';
const report={syntheticOnly:true,sourceRoot:root,harnessSha256,mode,engine,rounds,externalCalls:0,externalBrowserRequests:[],errors:[],samples:[],api:[],notes:['MODE=built means compiled frontend assets with source middleware; actual production backend bundle is verified by separate safety QA.', 'Browser elapsed is document Performance API from click/navigation to DOM readiness; excludes Playwright click dispatch overhead.','Server time is incoming request to response finish and excludes browser assets/React rendering.','Six concurrent metadata writes model shared-store queue pressure; no real bank/Saby provider latency.','Cold browser context has no cookies/cache. Initial server fixture is synthetic and filesystem caches are not forcibly evicted.','Push provider disabled; no push subscription/native browser delay included in these timings.']};
let phase='setup',server,vite,browser;
const originalFetch=globalThis.fetch;
globalThis.fetch=(input,init)=>{const url=new URL(typeof input==='string'||input instanceof URL?input:input.url);if(url.protocol!=='http:'||url.hostname!=='127.0.0.1'){report.externalCalls++;throw Error('No provider access');}return originalFetch(input,init);};
const deny=async()=>{report.externalCalls++;throw Error('No provider access');};
const save=async()=>{await mkdir(dirname(output),{recursive:true});await writeFile(output,JSON.stringify(report,null,2));};
try{
 const credentials=await passwordFields(password),now='2026-10-29T10:00:00.000Z',userId='synthetic-auth-user';
 await f.store.mutate(f.source,d=>{
  d.accounts={users:[{id:userId,name:'Synthetic auth user',login:loginName,role:'director',managerId:null,active:true,version:1,...credentials}],sessions:[],attempts:{}};
  d.banking=emptyBanking();const c=fixtures.fixtureConfig();d.banking.operations=Array.from({length:3500},(_,i)=>normalizeTbank(c,{number:fixtures.accountNumber,currency:'RUB'},fixtures.fixtureDay,fixtures.tbankRow(`auth-perf-${i}`)));
  const rows=Object.values(d.shipments);for(let i=0;i<89;i++)for(const [j,r] of rows.entries())d.shipments[`shipment-local-auth-${i}-${j}`]={...structuredClone(r),fields:{...r.fields,trip_id:`shipment-trip-abcdef-${i}`}};
  d.work={tasks:[{id:'synthetic-auth-task',version:1,title:'Синтетическая задача проверки входа',description:'Только локальные тестовые данные',status:'todo',companyId:null,dueDate:null,reminderAt:null,assigneeId:userId,createdBy:userId,updatedBy:userId,createdAt:now,updatedAt:now}],companyRecords:[],notes:[]};
  return{changed:true,result:null};
 });
 await migrateWorkStorage(dirname(f.store.path),f.source);report.coreBytes=(await stat(resolve(dirname(f.store.path),'work-storage/core/operations.json'))).size;
 const store=new OperationsStore(dirname(f.store.path));
 const api=createSnapshotMiddleware(f.snapshotDirectory,{operationsStore:store,operationsDirectory:dirname(f.store.path),sabyWorkflowMonitoringEnabled:false,cabinetEnvironment:{},geocoderEnvironment:{},bankEnvironment:{ARTEL_BANK_REQUESTS_ENABLED:'false',ARTEL_BANK_SYNC_ENABLED:'false'},bankRequest:deny,sberRequest:deny,fetcher:deny,pushSender:deny,tripRequestGeocoder:deny,pushConfig:{publicKey:'',privateKey:'',subject:'',schedule:false}});
 const middleware=(req,res,next)=>{if(req.url?.startsWith('/api/')){const row={phase,path:req.url.split('?')[0],method:req.method},start=performance.now();res.on('finish',()=>{row.serverMs=performance.now()-start;row.status=res.statusCode;report.api.push(row);});}return api(req,res,next);};
 const publicRoot=resolve(root,'app-dist'),types={'.js':'text/javascript','.css':'text/css','.html':'text/html','.png':'image/png','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'};
 if(mode==='source'){
  vite=await createViteServer({configFile:false,envDir:false,cacheDir:resolve(f.directory,'vite-cache'),root:resolve(root,'web'),plugins:[react(),{name:'auth-synthetic-api',configureServer(instance){instance.middlewares.use(middleware);}}],server:{host:'127.0.0.1',port:0,cors:false,fs:{strict:true,allow:[resolve(root,'web'),resolve(root,'node_modules'),resolve(f.directory,'vite-cache')]}}});await vite.listen();
 }else{
  server=createServer((req,res)=>middleware(req,res,async()=>{try{const path=new URL(req.url,'http://localhost').pathname,file=resolve(publicRoot,`.${path==='/'?'/index.html':path}`),rel=relative(publicRoot,file);if(rel==='..'||rel.startsWith(`..${sep}`))throw Error('Outside public root');const data=await readFile(file);res.writeHead(200,{'Content-Type':types[extname(file)]??'application/octet-stream','Cache-Control':'no-cache'});res.end(data);}catch{res.writeHead(404);res.end();}}));await new Promise(done=>server.listen(0,'127.0.0.1',done));
 }
 const origin=`http://127.0.0.1:${(vite?.httpServer??server).address().port}`;
 browser=await (engine==='webkit'?webkit:chromium).launch({headless:true});
 const protectedBefore=JSON.stringify((await store.read(f.source)).banking.operations.map(({updatedAt,...business})=>business));
 for(let round=0;round<rounds;round++){
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
  await context.route('**/*',route=>{if(new URL(route.request().url()).origin===origin)return route.continue();report.externalBrowserRequests.push(route.request().url());return route.abort();});
  await context.addInitScript(()=>{
   window.__authTiming={actions:[],formReady:null,workReady:null};
   const visible=element=>!!element&&element.getClientRects().length>0;
   const scan=()=>{const data=window.__authTiming,form=document.querySelector('.auth-submit'),work=document.querySelector('.work-task-row');
    const formReady=visible(form)&&!form.disabled,workReady=visible(work);
    if(formReady&&data.formReady===null)data.formReady=performance.now();if(workReady&&data.workReady===null)data.workReady=performance.now();
    const action=data.actions.at(-1);if(action&&!action.end&&((action.kind==='login'&&workReady)||(action.kind==='logout'&&formReady))){action.end=performance.now();action.ms=action.end-action.start;}
   };
   document.addEventListener('click',event=>{if(event.target.closest('.auth-submit'))window.__authTiming.actions.push({kind:'login',start:performance.now()});else if(event.target.closest('button[aria-label="Выйти"]'))window.__authTiming.actions.push({kind:'logout',start:performance.now()});},true);
   new MutationObserver(scan).observe(document,{childList:true,subtree:true,attributes:true});document.addEventListener('DOMContentLoaded',scan);
  });
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push({round,message:error.message}));
  const collect=async(name,load,navigation=false)=>{
   const browserData=await page.evaluate(()=>({timing:window.__authTiming,resources:performance.getEntriesByType('resource').filter(r=>new URL(r.name).pathname.startsWith('/api/')).map(r=>({path:new URL(r.name).pathname,start:r.startTime,durationMs:r.duration,requestStart:r.requestStart,responseStart:r.responseStart,responseEnd:r.responseEnd}))}));
   const action=browserData.timing.actions.at(-1),ms=navigation?(name==='cold-form'?browserData.timing.formReady:browserData.timing.workReady):action?.ms;
   assert.ok(Number.isFinite(ms)&&ms>=0,JSON.stringify({name,browserData}));
   report.samples.push({round,name,load,browserMs:ms,...browserData,serverRequests:report.api.filter(r=>r.phase===phase)});await save();
  };
  phase=`${round}-cold-form`;await page.goto(origin+'/#work');await expect(page.getByRole('button',{name:'Войти',exact:true})).toBeEnabled();await collect('cold-form','idle',true);
  const login=async(load,name)=>{
   await page.getByLabel('Логин',{exact:true}).fill(loginName);await page.getByLabel('Пароль',{exact:true}).fill(password);phase=`${round}-${load}-${name}`;
   const jobs=load==='idle'?[]:Array.from({length:6},(_,j)=>store.mutate(f.source,d=>{d.banking.operations[0].updatedAt=new Date(Date.now()+j).toISOString();return{changed:true,result:null};}));
   await page.getByRole('button',{name:'Войти',exact:true}).click();await expect(page.locator('.work-task-row')).toBeVisible();await expect(page.getByRole('button',{name:'Новая задача',exact:true})).toBeEnabled();await collect(name,load);await Promise.all(jobs);
  };
  const logout=async(load,name)=>{
   phase=`${round}-${load}-${name}`;const jobs=load==='idle'?[]:Array.from({length:6},(_,j)=>store.mutate(f.source,d=>{d.banking.operations[0].updatedAt=new Date(Date.now()+j).toISOString();return{changed:true,result:null};}));
   const oldCookies=await context.cookies();await page.getByRole('button',{name:'Выйти',exact:true}).click();await expect(page.getByRole('button',{name:'Войти',exact:true})).toBeEnabled();await collect(name,load);await Promise.all(jobs);
   const old=oldCookies.find(c=>c.name==='artel_session');assert.ok(old);const denied=await fetch(origin+'/api/work',{headers:{cookie:`${old.name}=${old.value}`}});assert.equal(denied.status,401);
  };
  await login('idle','cold-login');
  phase=`${round}-reload`;await page.reload();await expect(page.locator('.work-task-row')).toBeVisible();await expect(page.getByRole('button',{name:'Новая задача',exact:true})).toBeEnabled();await collect('reload','idle',true);
  await logout('idle','warm-logout');await login('idle','warm-login');
  await logout('six-background-writes','loaded-logout');await login('six-background-writes','loaded-login');
  await context.close();
 }
 assert.equal(JSON.stringify((await store.read(f.source)).banking.operations.map(({updatedAt,...business})=>business)),protectedBefore);assert.equal(report.externalCalls,0);assert.deepEqual(report.externalBrowserRequests,[]);assert.deepEqual(report.errors,[]);
 const percentile=(a,p)=>[...a].sort((a,b)=>a-b)[Math.ceil(a.length*p)-1];report.summary=[];
 for(const name of [...new Set(report.samples.map(s=>s.name))]){const rows=report.samples.filter(s=>s.name===name);report.summary.push({name,count:rows.length,medianBrowserMs:percentile(rows.map(s=>s.browserMs),.5),minBrowserMs:Math.min(...rows.map(s=>s.browserMs)),maxBrowserMs:Math.max(...rows.map(s=>s.browserMs)),authRequests:rows.map(s=>s.serverRequests.filter(r=>r.path.startsWith('/api/auth/')).map(({path,serverMs,status})=>({path,serverMs,status})))});}
 report.passed=true;await save();console.log(JSON.stringify({summary:report.summary,apiCount:report.api.length,externalCalls:report.externalCalls,errors:report.errors},null,2));
}finally{await browser?.close();await vite?.close();if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}await f.close();globalThis.fetch=originalFetch;await save();}

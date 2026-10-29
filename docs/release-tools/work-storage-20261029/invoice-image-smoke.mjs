import assert from 'node:assert/strict';
import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { spawnSync } from 'node:child_process';
import { createProductionRuntime } from '/app/server-render/production.mjs';
const root = await mkdtemp(resolve(tmpdir(), 'artel-invoice-image-'));
const snapshot = resolve(root, 'snapshot'), store = resolve(root, 'operations');
await mkdir(snapshot); await mkdir(store);
const hash = x => createHash('sha256').update(x).digest('hex');
const source = 'a'.repeat(64), key = randomBytes(32), token = randomBytes(32).toString('hex'), other = randomBytes(32).toString('hex');
const meta = {source_file:'synthetic.xlsx',source_sha256:source,created_at_utc:'2026-10-20T00:00:00Z',source_kind:'test',google_verified:false,formula_policy:'',ownership_policy:''};
const validation={status:'ok',registry_verified:false,issue_counts:{},cell_issues:[],record_flag_counts:{},duplicate_record_candidates:[],legal_form_alias_candidate_groups:[],multiple_manager_companies:[],limitations:[]};
const files={};
for (const name of ['companies','shipments','payments','stock_summaries','manager_labels','validation_report']) {
 const raw=JSON.stringify({meta,data:name==='validation_report'?validation:[]}); await writeFile(resolve(snapshot,name+'.json'),raw); files[name+'.json']={sha256:hash(raw),bytes:Buffer.byteLength(raw)};
}
await writeFile(resolve(snapshot,'manifest.json'),JSON.stringify({meta,counts:{},files}));
const user=(id,role)=>({id,name:'Synthetic '+id,login:id,role,active:true,managerId:null,version:1,sections:[],salt:'a'.repeat(32),passwordHash:'b'.repeat(128)});
const data={schemaVersion:2,sourceSha256:source,revision:0,shipments:{},companies:[],paymentAllocations:[],directories:{managers:[],products:[],paymentForms:[],vehicles:[],drivers:[],addresses:[],defaults:{profit:'template-payment-form'},duplicates:[],customerManagers:[],fleetSeedApplied:true},accounts:{users:[user('invoice-owner','director'),user('invoice-other','employee')],sessions:[{userId:'invoice-owner',hash:hash(token),expiresAt:Date.now()+3600000},{userId:'invoice-other',hash:hash(other),expiresAt:Date.now()+3600000}],attempts:{}}};
const storeFile=resolve(store,'operations.json');
await writeFile(storeFile,JSON.stringify({sha256:hash(JSON.stringify(data)),data}));
await writeFile(resolve(root,'bridge.key'),key.toString('hex'));
await writeFile(resolve(root,'owners.json'),JSON.stringify({version:1,users:data.accounts.users.map(u=>({crmUserId:u.id,invoiceOwnerId:randomUUID()}))}));
let userCalls=0, serviceCalls=0, refreshCalls=0; const originalFetch=globalThis.fetch;
globalThis.fetch=async(url,options)=>{
 assert.equal(new URL(url).origin,'http://invoices:4318'); assert.equal(options.redirect,'error');
 const headers=new Headers(options.headers), encoded=headers.get('x-artel-bridge-context'), c=JSON.parse(Buffer.from(encoded,'base64url').toString());
 assert.equal(headers.get('x-artel-bridge-signature'),createHmac('sha256',key).update('artel-invoices-v1\n'+encoded).digest('base64url'));
 assert.equal(c.path,new URL(url).pathname);assert.equal(c.bodySha256,hash(Buffer.from(options.body??[])));assert.ok(!headers.has('cookie'));assert.ok(!headers.has('x-artel-account'));
 if(c.kind==='service'){serviceCalls++;return new Response(JSON.stringify(c.path.endsWith('/events')?{events:[],hasMore:false}:{revoked:true}),{headers:{'content-type':'application/json'}});}
 userCalls++;if(headers.get('x-artel-catalog-refresh')==='1')refreshCalls++;assert.equal(c.crmUserId,'invoice-owner');assert.equal(c.displayName,'Synthetic invoice-owner');assert.equal(c.sessionHash,hash(token));
 return new Response(JSON.stringify({history:[],settings:{revision:2},test:'synthetic-private'}),{headers:{'content-type':'application/json'}});
};
const origin='https://synthetic.example.test';
const env={ARTEL_GEOCODER_ENABLED:'false',ARTEL_CABINET_SYNC_ENABLED:'false',ARTEL_BANK_REQUESTS_ENABLED:'false',ARTEL_BANK_SYNC_ENABLED:'false',ARTEL_PUBLIC_ORIGIN:origin,ARTEL_SNAPSHOT_DIR:snapshot,ARTEL_STORE_DIR:store,ARTEL_INVOICES_URL:'http://invoices:4318',ARTEL_INVOICES_BRIDGE_KEY_FILE:resolve(root,'bridge.key'),PORT:'0'};
let runtime=await createProductionRuntime(env);await runtime.start();
const request=(path,{account='invoice-owner',session=token,method='GET',body,refresh=false}={})=>new Promise((done,reject)=>{
 const raw=body===undefined?undefined:JSON.stringify(body);
 const req=httpRequest({hostname:'127.0.0.1',port:runtime.server.address().port,path,method,headers:{host:'synthetic.example.test',origin,cookie:'artel_session='+session,'X-Artel-Account':account,...(refresh?{'X-Artel-Catalog-Refresh':'1'}:{}),...(raw?{'content-type':'application/json','content-length':Buffer.byteLength(raw)}:{})}},res=>{const chunks=[];res.on('data',x=>chunks.push(x));res.on('end',()=>done(new Response(Buffer.concat(chunks),{status:res.statusCode,headers:res.headers})));res.on('error',reject);});req.on('error',reject);req.end(raw);
});
try {
 assert.equal((await request('/healthz')).status,200);
 assert.equal((await request('/api/invoices')).status,200);assert.equal(userCalls,1);
 assert.equal((await request('/api/invoices',{account:'invoice-other',session:other})).status,403);userCalls=0;
 await runtime.stop();
 const before=await readFile(storeFile);
 const result=spawnSync('node',['/app/server-render/grant-invoice-access.mjs','--execute','--mapping',resolve(root,'owners.json'),'--expected-sha256',hash(before)],{env:{...process.env,ARTEL_STORE_DIR:store,ARTEL_INVOICES_MAINTENANCE:'true'},encoding:'utf8'});
 assert.equal(result.status,0,result.stderr);assert.equal(JSON.parse(result.stdout).sessionsPasswordsAndOtherDataPreserved,true);
 const granted=JSON.parse(await readFile(storeFile,'utf8')).data;assert.deepEqual(granted.accounts.sessions,data.accounts.sessions);
 runtime=await createProductionRuntime(env);await runtime.start();
 assert.equal((await request('/api/auth/session')).status,200);
 assert.equal((await request('/api/invoices',{account:'invoice-other'})).status,401);
 assert.equal((await request('/api/invoices')).status,200);assert.equal(userCalls,1);
 assert.equal((await request('/api/invoices',{refresh:true})).status,200);assert.equal(refreshCalls,1);
 assert.equal((await request('/api/invoices/internal/admin')).status,404);assert.equal(userCalls,2);
 assert.equal((await request('/api/auth/logout',{method:'POST',body:{}})).status,200);
 assert.equal((await request('/api/invoices')).status,401);
 const loggedOut=JSON.parse(await readFile(storeFile,'utf8')).data;
 assert.ok(loggedOut.push.invoiceRevocations[hash(token)]);assert.ok(!loggedOut.accounts.sessions.some(s=>s.hash===hash(token)));
 await runtime.stop();runtime=await createProductionRuntime(env);await runtime.start();
 assert.equal((await request('/api/invoices')).status,401);
 console.log(JSON.stringify({passed:true,synthetic:true,productionMountsUsed:false,externalNetwork:false,userCalls,serviceCalls,checks:['directorImplicitAccessAndEmployeeGrant','grantBundleExactSessionsPreserved','grantRestartValidation','sessionStillAuthenticated','ownerMismatchDenied','signedGatewayExactBody','explicitCatalogRefresh','routeAllowlist','durableLogoutRevocation','logoutRestartDenied']}));
} finally {await runtime.stop();globalThis.fetch=originalFetch;await rm(root,{recursive:true,force:true});}

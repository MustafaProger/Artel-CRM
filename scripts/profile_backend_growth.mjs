// Reproducible related-record growth. Synthetic only; no source data, timers or providers.
import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createServer } from 'node:http';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
const args = Object.fromEntries(Array.from({ length: Math.ceil((process.argv.length - 2) / 2) }, (_, i) => [process.argv[i * 2 + 2]?.replace(/^--/, ''), process.argv[i * 2 + 3]]));
for (const key of ['adapter', 'output']) assert.ok(args[key], `--${key} required`);
const iterations = Number(args.iterations ?? 3), factors = (args.factors ?? '1,5,10').split(',').map(Number), concurrencies = (args.concurrency ?? '1,4').split(',').map(Number);
assert.ok(iterations >= 2 && iterations <= 30 && factors.every(n => [1,5,10].includes(n)) && concurrencies.every(n => [1,4].includes(n)));
for (const key of Object.keys(process.env)) if (/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key)) delete process.env[key];
const { createSnapshotMiddleware, loadSnapshot, OperationsStore, emptyDirectories, currentSnapshot, SHIPMENT_FIELDS } = await import(pathToFileURL(resolve(args.adapter)));
const digest = value => createHash('sha256').update(value).digest('hex');
const date = '2026-10-28T00:00:00.000Z', source = digest('synthetic-linked-growth-v1'), salt = '0'.repeat(32), password = 'Synthetic-growth-password-only';
const passwordHash = scryptSync(password, salt, 64).toString('hex');
const users = [...Array.from({length:4}, (_,i) => ({ id:`growth-user-${i}`, name:`Synthetic User ${i}`, login:`growth-user-${i}`, role:'director', managerId:null })), {id:'growth-employee',name:'Synthetic Scoped',login:'growth-employee',role:'employee',managerId:'manager-0',sections:['work','trips','shipments','directories','overview']}].map(user=>({...user,active:true,version:1,passwordHash,salt}));
const tokens = users.map(user=>digest(`synthetic-session-${user.id}`));
const percentile = (values,p) => [...values].sort((a,b)=>a-b)[Math.min(values.length-1, Math.ceil(values.length*p)-1)];
const summary = values => ({medianMs:percentile(values,.5),p95Ms:percentile(values,.95),minMs:Math.min(...values),maxMs:Math.max(...values)});
const normalize = value => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key])=>key!=='revision').map(([key,v])=>[key,key==='updatedAt'?'<timestamp>':normalize(v)])) : value;
let externalCalls = 0;
const blocked = async () => { externalCalls++; throw new Error('External providers forbidden'); };
const report = { adapterSha256:digest(await readFile(resolve(args.adapter))),scriptSha256:digest(await readFile(import.meta.filename)), syntheticOnly:true, timersStarted:false, liveDataRead:false, providerCalls:0, iterations, model:'x1 = 40 clients + 1 supplier, 200 shipments in 100 two-delivery trips, 200 tasks, 100 notes, 40 company records; all business-record counts multiply by factor; four separate director users and a scoped employee. No padding, external documents, bank payments or scheduler contention.', runs:[] };
async function snapshot(directory) {
 await mkdir(directory,{recursive:true});
 const meta={source_file:'synthetic.xlsx',source_sha256:source,created_at_utc:date,source_kind:'test',google_verified:false,formula_policy:'',ownership_policy:''};
 const validation={status:'ok',registry_verified:false,issue_counts:{},cell_issues:[],record_flag_counts:{},duplicate_record_candidates:[],legal_form_alias_candidate_groups:[],multiple_manager_companies:[],limitations:[]};
 const files={};
 for(const name of ['companies','shipments','payments','stock_summaries','manager_labels','validation_report']) { const raw=JSON.stringify({meta,data:name==='validation_report'?validation:[]});await writeFile(resolve(directory,`${name}.json`),raw);files[`${name}.json`]={sha256:digest(raw),bytes:Buffer.byteLength(raw)}; }
 await writeFile(resolve(directory,'manifest.json'),JSON.stringify({meta,counts:{},files}));
}
function populate(data,factor) {
 const count=40*factor;
 const company=(id,name,role)=>({id,name,roles:[role],managerLabels:[],shipmentIds:[],paymentIds:[],flags:[]});
 data.sourceOperationsCleared=true;
 data.companies=[company('supplier','Synthetic Supplier','supplier'),...Array.from({length:count},(_,i)=>company(`client-${i}`,`Synthetic Client ${i}`,'customer'))];
 data.directories={...emptyDirectories(),fleetSeedApplied:true,managers:Array.from({length:4},(_,i)=>({id:`manager-${i}`,name:`Synthetic Manager ${i}`})),products:[{id:'product',name:'Synthetic diesel'}],paymentForms:[{id:'payment',name:'б/нал'}],vehicles:[{id:'vehicle',plate:'Т000ЕЕ00'}],drivers:[{id:'driver',name:'Synthetic Driver',vehicleId:'vehicle'}],addresses:Array.from({length:count},(_,i)=>({id:`address-${i}`,name:`Synthetic Address ${i}`,companyId:`client-${i}`,kind:'delivery'}))};
 data.accounts={users:structuredClone(users),sessions:users.map((user,i)=>({userId:user.id,hash:digest(tokens[i]),expiresAt:4102444800000})),attempts:{}};
 data.shipments={};data.tripNumbers={};data.tripCreateRequests={};
 for(let i=0;i<200*factor;i++) {
  const t=Math.floor(i/2),trip=`shipment-trip-${t.toString(16).padStart(8,'0')}-0000-4000-8000-000000000000`,client=i%count,manager=Math.floor(client/2)%4,day=String(t%28+1).padStart(2,'0');
  data.tripNumbers[trip]=t+1;
  data.shipments[`shipment-local-${i}`]={version:1,createdAt:date,updatedAt:date,fields:{...Object.fromEntries(SHIPMENT_FIELDS.map(field=>[field,null])),date:`2026-10-${day}`,organization_id:t%2?'artel':'nk-artel',customer_id:`client-${client}`,customer_name:`Synthetic Client ${client}`,supplier_id:'supplier',supplier_name:'Synthetic Supplier',manager_id:`manager-${manager}`,manager_label:`Synthetic Manager ${manager}`,product_id:'product',product:'Synthetic diesel',payment_form_id:'payment',payment_form:'б/нал',driver_id:'driver',vehicle_id:'vehicle',unloading_address_id:`address-${client}`,trip_id:trip,trip_delivery_order:String(i%2+1),trip_total_tonnes:'2',trip_additional_costs:'0',quantity_tonnes:'1',quantity_litres:'1200',sale_price_per_litre:'75',purchase_price_unspecified_unit:'70000',purchase_unit:'tonnes',calculation_mode:'automatic',additional_costs:'0',transport_amount:'1000',opening_paid_amount:'0'}};
 }
 const entry=(id,i)=>({id,version:1,assigneeId:users[i%4].id,createdBy:users[i%4].id,updatedBy:users[i%4].id,createdAt:date,updatedAt:date});
 data.work={tasks:Array.from({length:200*factor},(_,i)=>({...entry(`task-${i}`,i),title:`Synthetic task ${i}`,description:'Linked synthetic record',status:'todo',companyId:`client-${i%count}`,dueDate:null,reminderAt:null})),notes:Array.from({length:100*factor},(_,i)=>({...entry(`note-${i}`,i),title:`Synthetic note ${i}`,content:'Synthetic note content'})),companyRecords:Array.from({length:count},(_,i)=>({...entry(`company-record-${i}`,i),companyId:`client-${i}`,question:'Synthetic question',comments:[],reminderAt:null}))};
 delete data.push;
}
for(const factor of factors) for(const concurrency of concurrencies) {
 const temporary=await mkdtemp(resolve(tmpdir(),'artel-linked-growth-')),snapshotDir=resolve(temporary,'snapshot'),storeDir=resolve(temporary,'store');let server;
 try {
  await snapshot(snapshotDir);const base=await loadSnapshot(snapshotDir),store=new OperationsStore(storeDir);
  await store.mutate(source,data=>{populate(data,factor);return{changed:true,result:null};});
  const input=await store.read(source),assembled=currentSnapshot(base,input),inputBytes=await readFile(store.path);
  assert.equal(assembled.shipments.length,200*factor);assert.equal(assembled.companies.length,40*factor+1);
  assert.equal(new Set(assembled.shipments.map(row=>row.fields.trip_id)).size,100*factor);
  assert.ok(assembled.shipments.every(row=>row.customerId&&assembled.companies.some(c=>c.id===row.customerId)));
  let reads=0;const originalRead=store.read.bind(store);store.read=async(...a)=>{reads++;return originalRead(...a)};
  const middleware=createSnapshotMiddleware(snapshotDir,{operationsStore:store,operationsDirectory:storeDir,requireAuthentication:true,bankEnvironment:{ARTEL_BANK_REQUESTS_ENABLED:'false',ARTEL_BANK_SYNC_ENABLED:'false'},cabinetEnvironment:{},geocoderEnvironment:{},yandexTilesEnvironment:{},bankRequest:blocked,sberRequest:blocked,fetcher:blocked,tripRequestGeocoder:async()=>({status:'unavailable',reason:'provider_unavailable'}),pushConfig:{publicKey:'',privateKey:'',subject:'',schedule:false},sabyWorkflowMonitoringEnabled:false});
  server=createServer((req,res)=>middleware(req,res,()=>{res.writeHead(404);res.end()}));await new Promise(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${server.address().port}`;
  const request=async(path,index=0,method='GET',body)=>{const start=performance.now(),response=await fetch(url+path,{method,headers:{cookie:`artel_session=${tokens[index]}`,...(body?{'Content-Type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})}),bytes=Buffer.from(await response.arrayBuffer()),json=JSON.parse(bytes.toString());assert.equal(response.status,200,`${path} ${JSON.stringify(json)}`);return{ms:performance.now()-start,status:response.status,bytes:bytes.length,hash:digest(bytes),semanticHash:digest(JSON.stringify(normalize(json))),json};};
  const endpoints=[['work','/api/work'],['navigation','/api/navigation'],['directories','/api/directories'],['shipments','/api/shipments?limit=50'],['trips','/api/shipment-trips'],['settlements','/api/settlements']];
  const permissions=[];
  for(const path of ['/api/navigation','/api/shipments?limit=50','/api/shipment-trips']) {const r=await request(path,4);permissions.push({path,status:r.status,hash:r.hash});if(path==='/api/navigation')assert.ok(r.json.shipmentCount>0&&r.json.shipmentCount<200*factor);}
  const denied=await fetch(url+'/api/banking',{headers:{cookie:`artel_session=${tokens[4]}`}});assert.equal(denied.status,403);permissions.push({path:'/api/banking',status:denied.status,hash:digest(await denied.text())});
  const beforeReadHash=digest(await readFile(store.path)),loop=monitorEventLoopDelay({resolution:10});loop.enable();const cpuStart=process.cpuUsage(),runStart=performance.now(),measurements=[];
  for(const [name,path] of endpoints) {
   await Promise.all(Array.from({length:concurrency},(_,i)=>request(path,i)));
   const samples=[],batchMs=[],readCounts=[];
   for(let n=0;n<iterations;n++){reads=0;const started=performance.now(),responses=await Promise.all(Array.from({length:concurrency},(_,i)=>request(path,i)));batchMs.push(performance.now()-started);readCounts.push(reads);samples.push(...responses.map(({json,...row},user)=>({...row,user,round:n})));}
   measurements.push({name,path,method:'GET',...summary(samples.map(s=>s.ms)),batch:summary(batchMs),readCounts,samples});
  }
  assert.equal(digest(await readFile(store.path)),beforeReadHash);
  for(const kind of ['workStatus','login']) {
   const samples=[],batchMs=[];const versions=Array(concurrency).fill(1);
   for(let n=0;n<iterations;n++){const started=performance.now(),responses=await Promise.all(Array.from({length:concurrency},(_,i)=>kind==='login'?request('/api/auth/login',i,'POST',{login:users[i].login,password}):request(`/api/work/tasks/task-${i}`,i,'PATCH',{version:versions[i],status:n%2?'todo':'done'})));batchMs.push(performance.now()-started);responses.forEach((r,i)=>{if(kind==='workStatus')versions[i]=r.json.entry.version});samples.push(...responses.map(({json,...row},user)=>({...row,user,round:n})));}
   measurements.push({name:kind,method:kind==='login'?'POST':'PATCH',...summary(samples.map(s=>s.ms)),batch:summary(batchMs),samples});
  }
  loop.disable();const cpu=process.cpuUsage(cpuStart);
  report.runs.push({factor,concurrency,counts:{companies:input.companies.length,shipments:assembled.shipments.length,trips:100*factor,tasks:input.work.tasks.length,notes:input.work.notes.length,companyRecords:input.work.companyRecords.length},inputBytes:inputBytes.length,inputSha256:digest(inputBytes),getStoreBytesUnchanged:true,permissions,measurements,durationMs:performance.now()-runStart,cpuMs:{user:cpu.user/1000,system:cpu.system/1000},eventLoopMs:{mean:loop.mean/1e6,p95:loop.percentile(95)/1e6,max:loop.max/1e6},rssBytes:process.memoryUsage().rss});
  assert.equal(externalCalls,0);report.providerCalls=externalCalls;await writeFile(resolve(args.output),JSON.stringify(report,null,2),{mode:0o600});console.log(JSON.stringify({factor,concurrency,inputBytes:inputBytes.length,measurements:measurements.length}));
 }finally{if(server){server.closeAllConnections();await new Promise(done=>server.close(done));}await rm(temporary,{recursive:true,force:true});}
}

// Local review only: synthetic data, loopback, integrations disabled.
import {mkdir,writeFile,readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import {writeTripsQaSnapshot,startTripsQaServer} from './qa-trips-runtime.mjs';
const root=resolve(import.meta.dirname,'..'), folder=resolve(root,'../preview');
await mkdir(folder,{recursive:true});
const snapshotDirectory=resolve(folder,'snapshot'),operationsDirectory=resolve(folder,'store');
await writeTripsQaSnapshot(snapshotDirectory);
const runtime=await startTripsQaServer({root,snapshotDirectory,operationsDirectory,port:5191});
const state=await(await fetch(runtime.base+'/api/auth/session')).json();
const login={login:'review',password:'LocalReview2026!'};
let response=await fetch(runtime.base+(state.needsSetup?'/api/auth/setup':'/api/auth/login'),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({...login,name:'Локальный просмотр'})});
if(!response.ok)throw new Error('Local login failed');
const cookie=response.headers.get('set-cookie').split(';')[0];
const api=async(path,method='GET',body)=>{
 const res=await fetch(runtime.base+path,{method,headers:{cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await res.json();if(!res.ok)throw new Error(JSON.stringify({path,status:res.status,result}));return result;
};
if(state.needsSetup){
 const today=new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow'}).format(new Date());
 const recipientId=randomUUID();
 const plan=await api('/api/operator/plans','POST',{clientName:'Учебный клиент',recipients:[{id:recipientId,name:'Учебный получатель',bank:'Учебный банк',card:'0000',phone:'+70000000000',details:'Синтетические реквизиты',limit:'5000000'}],idempotencyKey:randomUUID()});
 let work=await api('/api/operator');
 for(const [index,service] of work.services.entries()){
  const current=(await api('/api/operator')).plans.find(row=>row.id===plan.id);
  const row=await api('/api/operator/refuellings','POST',{schemaVersion:3,planId:plan.id,planVersion:current.version,date:today,name:['Учебный водитель Алексей','Учебный водитель Сергей','Учебный водитель Роман','Учебный водитель Виктор','Учебный водитель Павел'][index],serviceId:service.id,serviceVersion:service.version??0,discountPercent:service.discountPercent,litres:'500',pricePerLitre:'70',amount:'31500',amountMode:'auto',comment:'Позвонить перед заправкой. Телефон: +7 000 000-00-00',allocations:[{kind:'recipient',recipientId,amount:'31500'}],idempotencyKey:randomUUID()});
  await api(`/api/operator/refuellings/${row.id}/payment`,'PATCH',{version:1,paid:true,idempotencyKey:randomUUID()});
  if(index===0||index===1){const entry=await api('/api/operator/cases','POST',{operationId:row.id,operationVersion:2,kind:index===0?'return':'deferred',...(index===0?{litres:'50'}:{}),idempotencyKey:randomUUID()});await api(`/api/operator/cases/${entry.id}/task`,'PATCH',{version:1,dueDate:today,comment:'Проверить остаток в конце дня',idempotencyKey:randomUUID()});}
  if(index<2)await api('/api/operator/reconciliations','POST',{date:today,serviceId:service.id,litres:index===0?'500':'495',amount:index===0?'34650':'34500',idempotencyKey:randomUUID()});
 }
 const manager=await api('/api/directories','POST',{kind:'managers',name:'Учебный оператор'});
 await api('/api/auth/users','POST',{login:'operator.review',password:'LocalOperator2026!',name:'Учебный оператор',role:'employee',managerId:manager.entry.id,sections:['work','operator','directories'],directoryGrants:['operatorServices'],active:true});
}
await writeFile(resolve(folder,'access.json'),JSON.stringify({base:runtime.base,cookie,synthetic:true}));
console.log(JSON.stringify({url:runtime.base+'/#operator',synthetic:true,integrations:false}));
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,async()=>{await runtime.server.close();process.exit(0)});

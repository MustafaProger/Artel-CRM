// Isolated local review. All business records are synthetic; providers disabled.
import {mkdtemp} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';
import {OperationsStore} from '../server/operations-store.ts';
import {writeTripsQaSnapshot} from './qa-trips-runtime.mjs';
import {startOperatorQaServer} from './qa-operator-runtime.mjs';
export const tileSvg='<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf2e8"/><path d="M0 80H256M90 0V256M0 220H256M220 0V256" stroke="#fff" stroke-width="12"/><text x="18" y="155" fill="#667761" font-size="13">Локальный стенд</text></svg>';
export async function fixture(day='2026-10-29',port=0){
 const root=resolve(import.meta.dirname,'..'),directory=await mkdtemp(resolve(tmpdir(),'artel-map-cards-'));
 const snapshotDirectory=resolve(directory,'snapshot'),operationsDirectory=resolve(directory,'store');
 const source=await writeTripsQaSnapshot(snapshotDirectory),store=new OperationsStore(operationsDirectory);
 const shift=n=>{const d=new Date(day+'T12:00:00Z');d.setUTCDate(d.getUTCDate()+n);return d.toISOString().slice(0,10)};
 const dates=[shift(-30),shift(-1),day,shift(1),shift(2),null,day];
 const names=['Прошлый месяц · тест','Вчера · тест','СТРОЙСТАНДАРТ ООО','Завтра · тест','Послезавтра · тест','Без даты · тест','Компания с очень длинным названием для проверки переноса на телефоне'];
 await store.mutate(source,data=>{
  data.sourceOperationsCleared=true;data.shipments={};data.companies=names.map((name,i)=>({id:`c${i}`,name,roles:['customer'],managerLabels:[],shipmentIds:[],paymentIds:[],flags:[]}));
  data.directories={fleetSeedApplied:true,managers:[],products:[],paymentForms:[],drivers:[],vehicles:[],customerManagers:[],defaults:{profit:'template-payment-form'},duplicates:[],oilDepots:[{id:'depot',name:'Нефтебаза · тест',address:'Условный адрес',latitude:'55.6',longitude:'37.8'}],addresses:names.map((_,i)=>({id:`a${i}`,companyId:`c${i}`,kind:'delivery',name:'Площадка',address:i===2?'Большая Косинская улица, 18с7, Москва':i===6?'Очень длинный адрес площадки, Московская область, промышленная территория, строение 123, корпус 45':'Москва, тестовая площадка '+(i+1),...(i<6?{latitude:String(55.71+i/100),longitude:String(37.61+i/100)}:{})}))};
  return {changed:true,result:null};
 });
 const runtime=await startOperatorQaServer({root,snapshotDirectory,operationsDirectory,port,tripRequestGeocoder:async()=>({status:'not_found',message:'Уточните адрес'})});
 const auth=await runtime.bootstrap();
 const api=async(path,method='GET',body)=>{const r=await fetch(runtime.base+path,{method,headers:{cookie:auth.cookie,Origin:runtime.base,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await r.json();assert.ok(r.ok,JSON.stringify(value));return value};
 for(const [i,executionDate] of dates.entries())await api('/api/trip-requests','POST',{companyId:`c${i}`,addressId:`a${i}`,quantityLitres:i===2?'10228':i===6?'12345.67':'4000',executionDate,idempotencyKey:randomUUID()});
 return {...runtime,...auth,api,directory,store,names};
}

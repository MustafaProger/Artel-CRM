import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware, loadSnapshot, type LocalApiOptions } from './test-api';
import { OperationsStore } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { clearOperations } from '../server/reset-operations';
import { allVehicleFields, driverFields } from '../web/src/directory-fields';
import type { Snapshot } from '../web/src/model';

const base = await loadSnapshot(resolve('data/local-xlsx-final'));
async function setup(options: LocalApiOptions = {}) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-directory-edit-'));
  const store = new OperationsStore(directory);
  const middleware = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { ...options, operationsDirectory: directory });
  const server = createServer((req,res)=>middleware(req,res,()=>{res.writeHead(404);res.end()}));
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async(path:string,method='GET',body?:unknown)=>{
    const response=await fetch(url+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});
    return {status:response.status,body:await response.json()};
  };
  return {directory,store,request,snapshot:async()=> (await request('/api/snapshot')).body as Snapshot,close:async()=>{await new Promise<void>((done,reject)=>server.close(error=>error?reject(error):done()));await rm(directory,{recursive:true,force:true})}};
}
const companyFields = {name:'Тестовая компания карточки',inn:'7707083893',roles:['customer','supplier'],phone:'+7 (900) 000-00-00',email:'qa@example.test',bankName:'Тестовый банк',settlementAccount:'00000000000000000000',correspondentAccount:'00000000000000000000',bik:'000000000',director:'Тестовый директор',kpp:'770701001',ogrn:'1027700132195',addresses:[{name:'Тестовая загрузка 1',kind:'loading'},{name:'Тестовая загрузка 2',kind:'loading'},{name:'Тестовая выгрузка',kind:'delivery'}]};

test('company cards save fields, manager and multiple addresses atomically, retain IDs and reject stale/invalid writes',async()=>{
  const runtime=await setup();try{
    const initial=await runtime.snapshot(),manager=initial.directories!.managers[0];
    const created=await runtime.request('/api/directories','POST',{kind:'companies',...companyFields,managerId:manager.id});
    assert.equal(created.status,201);const company=created.body.entry;
    let snapshot=await runtime.snapshot();assert.equal(snapshot.companies.length,initial.companies.length+1);
    assert.equal(snapshot.companies.find(row=>row.id===company.id)?.bankName,companyFields.bankName);
    const addresses=snapshot.directories!.addresses.filter(row=>row.companyId===company.id);
    assert.equal(addresses.length,3);assert.equal(snapshot.directories!.customerManagers!.find(row=>row.companyId===company.id)?.managerId,manager.id);
    const payload={...companyFields,version:company.version,name:'Компания после изменения',managerId:null,addresses:addresses.map(({id,name,kind})=>({id,name,kind}))};
    const edit=await runtime.request(`/api/directories/companies/${company.id}`,'PATCH',payload);assert.equal(edit.status,200);assert.equal(edit.body.entry.id,company.id);
    const raw=await readFile(runtime.store.path,'utf8');
    assert.equal((await runtime.request(`/api/directories/companies/${company.id}`,'PATCH',payload)).status,409);
    assert.equal((await runtime.request(`/api/directories/companies/${company.id}`,'PATCH',{...payload,version:2,managerId:'missing'})).status,400);
    assert.equal((await runtime.request(`/api/directories/companies/${company.id}`,'PATCH',{...payload,version:2,addresses:[{id:'foreign',name:'Чужой адрес',kind:'loading'}]})).status,400);
    assert.equal((await runtime.request('/api/directories','POST',{kind:'companies',...companyFields,managerId:null})).status,409);
    assert.equal(await readFile(runtime.store.path,'utf8'),raw);
    snapshot=currentSnapshot(base,await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256));
    assert.equal(snapshot.companies.find(row=>row.id===company.id)?.name,payload.name);
    assert.deepEqual(snapshot.directories!.addresses.filter(row=>row.companyId===company.id).map(row=>row.id),addresses.map(row=>row.id));
    assert.ok(!snapshot.directories!.customerManagers!.some(row=>row.companyId===company.id));
    const legacy=snapshot.companies.find(row=>!row.inn)!;
    assert.equal((await runtime.request(`/api/directories/companies/${legacy.id}`,'PATCH',{version:0,name:'Обновлённая фирма без ИНН',inn:'',roles:['customer'],managerId:manager.id,addresses:[]})).status,200);
    assert.equal((await runtime.snapshot()).companies.length,snapshot.companies.length);
  }finally{await runtime.close()}
});

test('renaming source directories and seeded fleet does not recreate old rows; all passport, STS and PTS fields survive restart',async()=>{
  const runtime=await setup();try{
    const snapshot=await runtime.snapshot(),catalog=snapshot.directories!;
    for(const kind of ['managers','products'] as const){
      const row=catalog[kind][0],path=`/api/directories/${kind}/${row.id}`;
      assert.equal((await runtime.request(path,'PATCH',{version:0,name:`Обновлено ${kind}`})).status,200);
      assert.equal((await runtime.request(path,'PATCH',{version:0,name:'stale'})).status,409);
      const current=(await runtime.snapshot()).directories![kind];assert.equal(current.length,catalog[kind].length);assert.equal(current.find(entry=>entry.id===row.id)?.name,`Обновлено ${kind}`);
    }
    const vehicle=catalog.vehicles[0],driver=catalog.drivers.find(row=>row.vehicleId===vehicle.id)!;
    const vehicleExtra=Object.fromEntries(allVehicleFields.map(([key])=>[key,`Тест ${key}`]));
    assert.equal((await runtime.request(`/api/directories/vehicles/${vehicle.id}`,'PATCH',{version:0,plate:'Новая машина 489',name:'Новое название машины',...vehicleExtra})).status,200);
    const driverExtra=Object.fromEntries(driverFields.map(([key])=>[key,`Тест ${key}`]));
    assert.equal((await runtime.request(`/api/directories/drivers/${driver.id}`,'PATCH',{version:0,name:'Водитель после изменения',phone:driver.phone,vehicleId:vehicle.id,...driverExtra})).status,200);
    const loaded=currentSnapshot(base,await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256)).directories!;
    assert.equal(loaded.vehicles.length,catalog.vehicles.length);assert.equal(loaded.drivers.length,catalog.drivers.length);
    const savedDriver=loaded.drivers.find(row=>row.id===driver.id)!,savedVehicle=loaded.vehicles.find(row=>row.id===vehicle.id)!;
    for(const [key,value] of Object.entries(vehicleExtra))assert.equal(savedVehicle[key as keyof typeof savedVehicle],value);
    for(const [key,value] of Object.entries(driverExtra))assert.equal(savedDriver[key as keyof typeof savedDriver],value);
    assert.equal(savedDriver.vehicleId,vehicle.id);
  }finally{await runtime.close()}
});

test('explicit reset clears all source/local operations and aggregates, preserves directories and permits new shipments after restart',async()=>{
  const runtime=await setup();try{
    const before=await runtime.snapshot(),catalog=before.directories!;
    const company=before.companies[0];
    await runtime.request('/api/directories','POST',{kind:'customerManagers',companyId:company.id,managerId:catalog.managers[0].id});
    const fields={date:'2026-09-10',customer_id:company.id,supplier_id:before.companies[1].id,manager_id:catalog.managers[0].id,product_id:catalog.products[0].id,payment_form_id:catalog.paymentForms.find(row=>row.name==='б/нал')!.id,quantity_litres:'100',quantity_tonnes:'0.08',sale_price_per_litre:'65',purchase_unit:'litres',purchase_price_unspecified_unit:'50'};
    assert.equal((await runtime.request('/api/shipments','POST',{fields})).status,201);
    const withLocal=await runtime.snapshot();
    await runtime.store.mutate(base.provenance.sourceSha256,data=>({result:clearOperations(base,data),changed:true}));
    let snapshot=await runtime.snapshot();
    assert.equal(snapshot.shipments.length,0);assert.equal(snapshot.payments.length,0);assert.equal(snapshot.stocks.length,0);assert.deepEqual(snapshot.monthly,[]);
    assert.equal(snapshot.quality.issues.length,0);assert.equal(snapshot.overview.shipmentCount,0);assert.equal(snapshot.overview.paymentCount,0);assert.equal(snapshot.overview.incoming.total,null);
    assert.equal(snapshot.companies.length,before.companies.length);assert.ok(snapshot.companies.every(row=>!row.shipmentIds.length&&!row.paymentIds.length));
    for(const key of ['managers','products','vehicles','drivers','addresses','customerManagers'] as const)assert.deepEqual(snapshot.directories![key],withLocal.directories![key]);
    const newShipment=await runtime.request('/api/shipments','POST',{fields});assert.equal(newShipment.status,201);
    const reloaded=await new OperationsStore(runtime.directory).read(base.provenance.sourceSha256);snapshot=currentSnapshot(base,reloaded);
    assert.equal(snapshot.shipments.length,1);assert.equal(snapshot.shipments[0].id,newShipment.body.shipment.id);assert.equal(snapshot.payments.length,0);
    assert.equal(snapshot.overview.revenue.total,'6500');assert.equal(snapshot.monthly.length,1);
  }finally{await runtime.close()}
});

test('Checko lookup fills requisites and director without saving a company, including cancellation and errors',async()=>{
  let failure=false;
  const fetcher:typeof fetch=async()=>new Response(JSON.stringify(failure?{meta:{status:'error'}}:{meta:{status:'ok'},data:{ИНН:'7707083893',НаимСокр:'Тест Чекко',НаимПолн:'Полное тестовое наименование',КПП:'770701001',ОГРН:'1027700132195',Руковод:[{ФИО:'Тестовый директор'}],ЮрАдрес:{АдресРФ:'Тестовый юридический адрес'}}}),{headers:{'Content-Type':'application/json'}});
  const runtime=await setup({checkoApiKey:'test-only',fetcher});try{
    const before=await runtime.store.read(base.provenance.sourceSha256);
    const result=await runtime.request('/api/companies/lookup','POST',{inn:'7707083893'});assert.equal(result.status,200);assert.equal(result.body.company.director,'Тестовый директор');assert.equal(result.body.company.kpp,'770701001');
    failure=true;assert.equal((await runtime.request('/api/companies/lookup','POST',{inn:'7707083893'})).status,502);
    assert.equal((await runtime.request('/api/companies/lookup','POST',{inn:'123'})).status,400);
    assert.deepEqual(await runtime.store.read(base.provenance.sourceSha256),before);
  }finally{await runtime.close()}
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { currentSnapshot, shipmentPage, prepareShipmentFields } from '../server/shipment-operations';
import { OperationsStore, type OperationsData } from '../server/operations-store';
import { emptyDirectories } from '../server/directory-operations';
import { calculateShipment, overdueDays } from '../web/src/shipment-calculations';
import { allocatePayment } from '../server/payment-allocations';
import type { CalculationRules, Snapshot } from '../web/src/model';
import Decimal from 'decimal.js';
import { settlementKind } from '../web/src/shipment-settlement';
const base = await loadSnapshot();
const empty = (): OperationsData => ({schemaVersion:2,sourceSha256:base.provenance.sourceSha256,revision:0,shipments:{},companies:[],directories:emptyDirectories(),paymentAllocations:[]});
const sample=(snapshot: Snapshot, overrides:Record<string,string|null>={})=>({date:'2026-09-15',customer_id:snapshot.companies[0].id,supplier_id:snapshot.companies[1].id,manager_id:snapshot.directories!.managers[0].id,product_id:snapshot.directories!.products[0].id,payment_form_id:snapshot.directories!.paymentForms[0].id,quantity_tonnes:'10',quantity_litres:'12500',sale_price_per_litre:'72',purchase_price_unspecified_unit:'65000',purchase_unit:'tonnes',transport_amount:'30000',additional_costs:'5000',...overrides});
const rules:CalculationRules={sale:'litres',purchase:'tonnes',profit:'simple',debtSign:'paid-minus-sale'};

test('exact calculations keep tonnes/litres separate and do not guess unknown rules',()=>{
  const fields=sample(currentSnapshot(base,empty()));
  const calc=calculateShipment(fields,rules,{asOf:'2026-09-20'}).fields;
  assert.equal(calc.month,'2026-09');assert.equal(calc.customer_amount,'900000');assert.equal(calc.sale_price_per_tonne,'90000');assert.equal(calc.purchase_amount,'650000');assert.equal(calc.profit_source,'215000');assert.equal(calc.paid_amount_source,'0');assert.equal(calc.debt_overpayment_source,'-900000');
  assert.equal(calculateShipment(fields,{...rules,purchase:'litres'}).fields.purchase_amount,'812500000');
  const missing=calculateShipment(fields,{...rules,profit:null,purchase:null});assert.equal(missing.fields.profit_source,null);assert.equal(missing.fields.purchase_amount,null);assert.equal(missing.warnings.length,2);
  assert.equal(calculateShipment({...fields,quantity_tonnes:'0'},rules).fields.sale_price_per_tonne,null);
  const precision=calculateShipment({...fields,quantity_litres:'0.1',sale_price_per_litre:'0.2'},rules);assert.equal(precision.fields.customer_amount,'0.02');
});

test('recognized Excel profit branches and rounding remain distinct',()=>{
  const fields={quantity_litres:'1',quantity_tonnes:'1',sale_price_per_litre:'900',purchase_price_unspecified_unit:'1000',transport_amount:'10',additional_costs:'0',kvp_source:'2'};
  assert.equal(calculateShipment(fields,{...rules,profit:'excel-rounded'}).fields.profit_source,'58');
  assert.equal(calculateShipment(fields,{...rules,profit:'excel-legacy'}).fields.profit_source,'60');
  assert.equal(calculateShipment({...fields,sale_price_per_litre:'1200.6'},{...rules,profit:'excel-rounded'}).fields.profit_source,'189');
  const old=base.shipments.find(r=>r.calculationRules?.profit==='excel-rounded'&&r.fields.customer_amount&&r.fields.purchase_amount)!;
  const snapshot=currentSnapshot(base,empty());
  const previous=snapshot.shipments.find(r=>r.id===old.id)!;
  const changed=prepareShipmentFields({payment_due_date:'2026-10-01'},previous,snapshot);
  for(const key of ['customer_amount','purchase_amount','profit_source','kvp_source','unlabelled_note','paid_amount_source','debt_overpayment_source','term_source'])assert.equal(changed[key],old.fields[key],key);
  const expenseOnly=prepareShipmentFields({additional_costs:'10'},previous,snapshot);
  assert.equal(expenseOnly.customer_amount,old.fields.customer_amount);assert.equal(expenseOnly.purchase_amount,old.fields.purchase_amount);
  const purchase = new Decimal(old.fields.purchase_amount!).times(settlementKind(old.fields.payment_form) === 'cash' ? '0.83' : '1');
  assert.equal(expenseOnly.profit_source,new Decimal(old.fields.customer_amount!).minus(purchase).minus(old.fields.transport_amount || '0').minus(10).toFixed());
  assert.equal(expenseOnly.profit_rule,'template-payment-form');
});

test('partial payments, overpayment, settlement date and overdue use linked operations only',()=>{
  const input={quantity_litres:'1',quantity_tonnes:'1',sale_price_per_litre:'100',purchase_price_unspecified_unit:'60',payment_due_date:'2026-09-10'};
  const allocation=(id:string,amount:string,date:string)=>({id,shipmentId:'s',paymentId:id,amount,date});
  const partial=calculateShipment(input,rules,{allocations:[allocation('p1','40','2026-09-11')],asOf:'2026-09-15'}).fields;
  assert.equal(partial.paid_amount_source,'40');assert.equal(partial.debt_overpayment_source,'-60');assert.equal(partial.overdue_days,'5');
  const paid=calculateShipment(input,rules,{allocations:[allocation('p1','40','2026-09-11'),allocation('p2','60','2026-09-12'),allocation('p3','10','2026-09-20')],asOf:'2026-09-25'}).fields;
  assert.equal(paid.debt_overpayment_source,'10');assert.equal(paid.overdue_days,'2');assert.equal(paid.payment_date,'2026-09-20');
  assert.equal(overdueDays(null,null,false),null);assert.equal(overdueDays('2026-09-20',null,false,'2026-09-15'),'0');assert.equal(overdueDays('2026-02-30',null,false),null);
  const legacy=calculateShipment({...input,customer_amount:'100',paid_amount_source:'20',opening_paid_amount:'20'},rules,{historical:true,allocations:[allocation('p1','30','2026-09-11')]}).fields;
  assert.equal(legacy.paid_amount_source,'50');assert.equal(calculateShipment(legacy,rules,{historical:true,allocations:[allocation('p1','30','2026-09-11')]}).fields.paid_amount_source,'50');
  assert.equal(calculateShipment({...input,customer_amount:'100',paid_amount_source:null,debt_overpayment_source:'0'},rules,{historical:true}).fields.overdue_days,null);
  const data=empty(), snapshot=currentSnapshot(base,data), payment=snapshot.payments.find(p=>p.date&&Number(p.incoming)>10)!;
  const result=allocatePayment(snapshot,data,snapshot.shipments[0].id,payment.id,'1');assert.equal(result.created,true);assert.equal(allocatePayment(snapshot,data,snapshot.shipments[0].id,payment.id,'1').created,false);
  assert.throws(()=>allocatePayment(snapshot,data,snapshot.shipments[0].id,payment.id,'2'),/другую сумму/);
  assert.throws(()=>allocatePayment(snapshot,data,snapshot.shipments[1].id,payment.id,payment.incoming!),/превышает/);
});

test('column filters, facets and exact numeric sorting operate before pagination',()=>{
  const snapshot=currentSnapshot(base,empty());
  const product=snapshot.shipments[0].product!;
  const expected=snapshot.shipments.filter(r=>r.product===product);
  const filters=JSON.stringify({product:{op:'values',values:[product]}});
  const result=shipmentPage(snapshot,new URLSearchParams({filters,limit:'1',sort:'quantity_litres',direction:'asc',facet:'product'}));
  assert.equal(result.total,expected.length);assert.equal(result.items.length,1);assert.ok(result.facetValues!.length>1);
  assert.equal(Number(result.items[0].liters),Math.min(...expected.filter(r=>r.liters!==null).map(r=>Number(r.liters))));
  const range=shipmentPage(snapshot,new URLSearchParams({filters:JSON.stringify({quantity_litres:{op:'range',value:'10000',to:'20000'},date:{op:'range',value:'2026-01-01',to:'2026-06-30'}}),limit:'100'}));
  const match=snapshot.shipments.filter(r=>r.date&&r.date>='2026-01-01'&&r.date<='2026-06-30'&&r.liters&&Number(r.liters)>=10000&&Number(r.liters)<=20000);
  assert.equal(range.total,match.length);
  assert.throws(()=>shipmentPage(snapshot,new URLSearchParams({filters:'{"unknown":{"op":"empty"}}'})),/колонки/);
  assert.throws(()=>shipmentPage(snapshot,new URLSearchParams({sort:'missing'})),/сортировка/);
});

test('v1 migration retains every stored field and persists v2 atomically',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'artel-migration-'));
  try{
    const data:OperationsData={schemaVersion:1,sourceSha256:base.provenance.sourceSha256,revision:7,companies:[],shipments:{[base.shipments[0].id]:{fields:{...base.shipments[0].fields,unlabelled_note:'Сохранить',kvp_source:'99'},version:2,createdAt:'2026-09-01',updatedAt:'2026-09-02'}}};
    const sha256=createHash('sha256').update(JSON.stringify(data)).digest('hex');const raw=JSON.stringify({sha256,data});await writeFile(resolve(directory,'operations.json'),raw);
    const store=new OperationsStore(directory), migrated=await store.read(data.sourceSha256);
    assert.equal(migrated.schemaVersion,2);assert.deepEqual(migrated.shipments,data.shipments);assert.equal(await readFile(store.path,'utf8'),raw);
    await store.mutate(data.sourceSha256,saved=>{saved.directories!.products.push({id:'qa',name:'QA'});return{changed:true,result:null}});
    const reloaded=await store.read(data.sourceSha256);assert.equal(reloaded.schemaVersion,2);assert.equal(reloaded.revision,8);assert.deepEqual(reloaded.shipments,data.shipments);
  }finally{await rm(directory,{recursive:true,force:true})}
});

test('directory creation deduplicates concurrent requests, enforces relations, and resolves vehicle without text copies',async()=>{
  const directory=await mkdtemp(resolve(tmpdir(),'artel-directories-'));
  const middleware=createSnapshotMiddleware(undefined,{operationsDirectory:directory});
  const server=createServer((req,res)=>middleware(req,res,()=>res.end()));await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const post=async(path:string,body:unknown)=>{const response=await fetch(url+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});return{status:response.status,data:await response.json()}};
  try{
    const vehicle=await post('/api/directories',{kind:'vehicles',plate:'A123BC 777'});assert.equal(vehicle.status,201);
    const duplicate=await post('/api/directories',{kind:'vehicles',plate:'а123вс777'});assert.equal(duplicate.status,200);assert.equal(duplicate.data.entry.id,vehicle.data.entry.id);
    const drivers=await Promise.all([1,2].map(()=>post('/api/directories',{kind:'drivers',name:'Тестов Иван',vehicleId:vehicle.data.entry.id})));assert.deepEqual(drivers.map(r=>r.status).sort(),[200,201]);
    assert.equal((await post('/api/directories',{kind:'drivers',name:'Неверный',vehicleId:'missing'})).status,400);
    const before=currentSnapshot(base,empty());
    const loading=await post('/api/directories',{kind:'addresses',name:'Завод 1',companyId:before.companies[1].id,addressKind:'loading'});
    const delivery=await post('/api/directories',{kind:'addresses',name:'Склад 1',companyId:before.companies[0].id,addressKind:'delivery'});
    assert.equal((await post('/api/directories',{kind:'addresses',name:'  завод  1 ',companyId:before.companies[1].id,addressKind:'loading'})).status,200);
    const created=await post('/api/shipments',{fields:sample(before,{driver_id:drivers[0].data.entry.id,loading_address_id:loading.data.entry.id,unloading_address_id:delivery.data.entry.id})});
    assert.equal(created.status,201,JSON.stringify(created.data));assert.equal(created.data.shipment.fields.vehicle_plate,'А123ВС777');assert.equal(created.data.shipment.fields.purchase_amount,'650000');
    const persisted=JSON.parse(await readFile(resolve(directory,'operations.json'),'utf8')).data.shipments[created.data.shipment.id].fields;assert.equal(persisted.vehicle_plate,undefined);assert.equal(persisted.driver_name,undefined);
    assert.equal((await post('/api/shipments',{fields:sample(before,{loading_address_id:delivery.data.entry.id})})).status,400);
    for(const key of ['customer_amount','profit_source','vehicle_plate','paid_amount_source','document_number','customer_inn'])assert.equal((await post('/api/shipments',{fields:sample(before,{[key]:'100'})})).status,400,key);
    const response=await fetch(`${url}/api/shipments/${created.data.shipment.id}`,{method:'PATCH',headers:{'Content-Type':'application/json'},body:JSON.stringify({version:1,fields:{supplier_id:before.companies[2].id}})});assert.equal(response.status,200);assert.equal((await response.json()).shipment.fields.loading_address_id,null);
  }finally{await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true})}
});

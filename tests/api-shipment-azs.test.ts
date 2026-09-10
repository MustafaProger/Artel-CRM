import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { calculateAzsShipment, calculateShipment, AZS_PROFIT_RULE } from '../web/src/shipment-calculations';
import { azsShipmentColumns, shipmentTemplates } from '../web/src/shipment-templates';
import { createSnapshotMiddleware, loadSnapshot } from './test-api';
import { currentSnapshot, prepareShipmentFields, shipmentPage } from '../server/shipment-operations';
import { emptyDirectories } from '../server/directory-operations';
import { OperationsStore, type OperationsData } from '../server/operations-store';
import type { Shipment, Snapshot } from '../web/src/model';

const base = await loadSnapshot();
const empty = (): OperationsData => ({schemaVersion:2,sourceSha256:base.provenance.sourceSha256,revision:0,shipments:{},companies:[],directories:emptyDirectories(),paymentAllocations:[]});
const input = {shipment_type:'azs',date:'2026-09-01',quantity_litres:'1000',customer_amount:'100000',purchase_amount:'80000',payment_form:'б/нал'};
function fields(snapshot: Snapshot, overrides: Record<string,string|null> = {}) {
  const catalog = snapshot.directories!;
  return {shipment_type:'azs',date:'2026-09-01',customer_id:snapshot.companies[0].id,supplier_id:snapshot.companies[1].id,manager_id:catalog.managers[0].id,product_id:catalog.products[0].id,payment_form_id:catalog.paymentForms.find(entry=>entry.name==='б/нал')!.id,quantity_litres:'1000',customer_amount:'100000',purchase_amount:'80000',...overrides};
}

test('AZS profit uses supplier sum, applies cash coefficient only to purchase and ignores tanker rules', () => {
  for (const [payment_form, expected] of [['б/нал','20000'],['нал','33600'],['безнал','20000'],['НАЛИЧНЫЕ','33600']]) {
    const result=calculateShipment({...input,payment_form,quantity_tonnes:'20',sale_price_per_tonne:'9999',purchase_price_unspecified_unit:'9999',transport_amount:'5000',additional_costs:'6000',kvp_source:'7000'},{sale:'tonnes',purchase:'tonnes',profit:'excel-rounded',debtSign:'paid-minus-sale'});
    assert.equal(result.fields.profit_source,expected);
    assert.equal(result.fields.customer_amount,'100000');
    assert.equal(result.fields.purchase_amount,'80000');
    assert.equal(result.fields.sale_price_per_litre,null);
  }
  assert.equal(calculateAzsShipment({...input,customer_amount:'0.3',purchase_amount:'0.1',payment_form:'нал'}).fields.profit_source,'0.217');
  assert.equal(calculateAzsShipment({...input,customer_amount:'0',purchase_amount:'0'}).fields.profit_source,'0');
  assert.equal(calculateAzsShipment({...input,customer_amount:'10',purchase_amount:'100'}).fields.profit_source,'-90');
  const result=calculateAzsShipment(input);
  assert.equal(result.fields.kvp_source,null);
  assert.ok(result.warnings.some(message=>message.includes('цены продажи за литр')));
  assert.ok(result.warnings.some(message=>message.includes('КВП')));
});

test('AZS missing and malformed values are explicit, zero litres never divide and F2 has no formula', () => {
  for (const purchase_amount of [null,'','NaN','Infinity','text','-1']) assert.equal(calculateAzsShipment({...input,purchase_amount}).fields.profit_source,null);
  for (const quantity_litres of [null,'','0','oops']) {
    const result=calculateAzsShipment({...input,quantity_litres});
    assert.equal(result.fields.sale_price_per_litre,null);
    assert.ok(result.warnings.some(message=>message.includes('литров')));
  }
  for (const payment_form of ['F2','ф2',null,'неизвестно']) assert.equal(calculateAzsShipment({...input,payment_form}).fields.profit_source,null);
});

test('AZS uses existing allocation, debt sign and days logic, preserving payment date and KVP data', () => {
  const allocation=(amount:string)=>({id:'allocation',shipmentId:'shipment',paymentId:'payment',amount,date:'2026-09-03'});
  for (const [amount,debt,days] of [['40000','-60000','9'],['100000','0',null],['100001','1',null]]) {
    const result=calculateAzsShipment({...input,payment_date:'2026-09-02',kvp_source:'25'},{allocations:[allocation(amount!)],asOf:'2026-09-10'}).fields;
    assert.equal(result.paid_amount_source,amount);assert.equal(result.debt_overpayment_source,debt);assert.equal(result.days_since_shipment,days);
    assert.equal(result.payment_date,'2026-09-03');assert.equal(result.kvp_source,'25');assert.equal(result.profit_source,'20000');
  }
  assert.equal(calculateAzsShipment({...input,payment_date:'2026-09-02'}).fields.payment_date,'2026-09-02');
});

test('AZS schema has exact requested columns and tanker expanded starts UPD, month, date', () => {
  assert.deepEqual(shipmentTemplates.expanded.columns.slice(0,3).map(column=>column.key),['document_number','month','date']);
  assert.ok(!shipmentTemplates.expanded.columns.some(column=>column.key==='purchase_unit'));
  assert.deepEqual(azsShipmentColumns.map(column=>column.key),['date','customer_name','document_number','month','customer_inn','manager_label','payment_form','product','quantity_litres','customer_amount','purchase_amount','sale_price_per_litre','supplier_name','supplier_inn','kvp_source','profit_source','paid_amount_source','debt_overpayment_source','days_since_shipment']);
  assert.equal(azsShipmentColumns.find(column=>column.key==='purchase_amount')!.title,'Сумма поставщика');
});

test('AZS server rejects tanker fields, automatic overrides, wrong types, F2 and nonpositive litres', () => {
  const snapshot=currentSnapshot(base,empty());
  for (const key of ['quantity_tonnes','sale_price_per_tonne','sale_price_per_litre','purchase_price_unspecified_unit','purchase_unit','driver_id','vehicle_id','carrier_id','transport_amount','additional_costs','unloading_address_id','loading_address_id','unlabelled_note','profit_source','kvp_source','payment_date','paid_amount_source','trip_id']) assert.throws(()=>prepareShipmentFields(fields(snapshot,{[key]:'1'}),undefined,snapshot),/недоступно/,key);
  for (const quantity_litres of ['0','-1',null,'', 'NaN']) assert.throws(()=>prepareShipmentFields(fields(snapshot,{quantity_litres}),undefined,snapshot));
  for (const key of ['customer_amount','purchase_amount']) for (const value of [null,'','bad','-0.01','1e999']) assert.throws(()=>prepareShipmentFields(fields(snapshot,{[key]:value}),undefined,snapshot));
  assert.equal(prepareShipmentFields(fields(snapshot,{customer_amount:'0',purchase_amount:'0'}),undefined,snapshot).profit_source,'0');
  assert.equal(prepareShipmentFields(fields(snapshot,{customer_amount:'100 000,05',purchase_amount:'80 000,01'}),undefined,snapshot).profit_source,'20000.04');
  assert.throws(()=>prepareShipmentFields(fields(snapshot,{payment_form_id:snapshot.directories!.paymentForms.find(entry=>entry.name==='ф2')!.id}),undefined,snapshot),/Ф2/);
  assert.throws(()=>prepareShipmentFields({shipment_type:'azs'},snapshot.shipments[0],snapshot),/тип существующей/);
  assert.throws(()=>prepareShipmentFields(fields(snapshot,{shipment_type:'unknown'}),undefined,snapshot),/тип отгрузки/);
});

test('AZS read and filtering isolate new sums from all legacy tanker data without rewriting store', () => {
  const data=empty(), snapshot=currentSnapshot(base,data), prepared=prepareShipmentFields(fields(snapshot),undefined,snapshot);
  data.shipments['shipment-local-azs']={fields:prepared,version:1,createdAt:'2026-09-01',updatedAt:'2026-09-01'};
  const before=structuredClone(data), updated=currentSnapshot(base,data);
  assert.deepEqual(data,before);
  assert.equal(updated.shipments.find(row=>row.id==='shipment-local-azs')!.fields.profit_source,'20000');
  const azs=shipmentPage(updated,new URLSearchParams({type:'azs',facet:'product'}));
  assert.equal(azs.total,1);assert.equal(azs.summary.revenue.total,'100000');assert.equal(azs.summary.cost.total,'80000');
  const tankers=shipmentPage(updated,new URLSearchParams({type:'tanker'}));
  assert.equal(tankers.total,snapshot.shipments.length);
  assert.equal(shipmentPage(updated,new URLSearchParams()).total,snapshot.shipments.length+1);
  assert.throws(()=>shipmentPage(updated,new URLSearchParams({type:'invalid'})),/тип отгрузки/);
  assert.deepEqual(updated.shipments.filter(row=>row.sourceRow).map(row=>row.fields.customer_amount),snapshot.shipments.map(row=>row.fields.customer_amount));
});

test('AZS HTTP creation, edit, restart and deletion persist with version checks and isolation', async () => {
  const directory=await mkdtemp(resolve(tmpdir(),'artel-azs-'));
  const middleware=createSnapshotMiddleware(undefined,{operationsDirectory:directory});
  const server=createServer((request,response)=>middleware(request,response,()=>{response.writeHead(404);response.end()}));
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=async(method:string,path:string,body?:unknown)=>{const response=await fetch(url+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});return{status:response.status,body:await response.json()}};
  try {
    const snapshot:Snapshot=(await request('GET','/api/snapshot?shipments=omit')).body;
    const created=await request('POST','/api/shipments',{fields:fields(snapshot,{document_number:'AZS-2026/001'})});
    assert.equal(created.status,201,JSON.stringify(created.body));
    let row:Shipment=created.body.shipment;
    assert.equal(row.fields.profit_source,'20000');assert.equal(row.fields.document_number,'AZS-2026/001');assert.equal(row.fields.paid_amount_source,'0');
    const bad=await request('PATCH',`/api/shipments/${row.id}`,{version:row.version,fields:{payment_form_id:snapshot.directories!.paymentForms.find(entry=>entry.name==='ф2')!.id}});
    assert.equal(bad.status,400);
    const edited=await request('PATCH',`/api/shipments/${row.id}`,{version:row.version,fields:{payment_form_id:snapshot.directories!.paymentForms.find(entry=>entry.name==='нал')!.id}});
    assert.equal(edited.status,200,JSON.stringify(edited.body));row=edited.body.shipment;assert.equal(row.fields.profit_source,'33600');
    assert.equal((await request('PATCH',`/api/shipments/${row.id}`,{version:1,fields:{purchase_amount:'1'}})).status,409);
    assert.equal((await request('PATCH',`/api/shipments/${row.id}`,{version:row.version,fields:{shipment_type:'tanker'}})).status,400);
    assert.equal((await request('GET','/api/shipments?type=azs')).body.total,1);
    assert.equal((await request('GET',`/api/shipments?type=tanker&query=${row.id}`)).body.total,0);
    const restarted=currentSnapshot(base,await new OperationsStore(directory).read(base.provenance.sourceSha256));
    assert.equal(restarted.shipments.find(item=>item.id===row.id)!.fields.profit_source,'33600');
    assert.equal(restarted.shipments.find(item=>item.id===row.id)!.fields.profit_rule,AZS_PROFIT_RULE);
    assert.equal((await request('DELETE',`/api/shipments/${row.id}`,{version:row.version})).status,200);
    assert.equal((await request('GET','/api/shipments?type=azs')).body.total,0);
    assert.ok(!currentSnapshot(base,await new OperationsStore(directory).read(base.provenance.sourceSha256)).shipments.some(item=>item.id===row.id));
  } finally {
    await new Promise<void>(done=>server.close(()=>done()));await rm(directory,{recursive:true,force:true});
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { locationDetails } from '../server/location-details';
import { emptyDirectories } from '../server/directory-operations';
import { saveCompany, updateDirectoryEntry } from '../server/directory-editing';
import { directoryDraft, directoryPayload } from '../web/src/directory-editor-data';
import type { Snapshot, ShipmentAddress } from '../web/src/model';
import type { OperationsData } from '../server/operations-store';

const contact={name:'Второй',phone:'+7 900 000-00-02'};
function fixture(){
 const address:ShipmentAddress={id:'a',companyId:'c',name:'Площадка',kind:'delivery',receiverName:'Первый',receiverPhone:'+7 900 000-00-01',latitude:'55',longitude:'37',oilDepotDistancesKm:{d:'10'}};
 const data={companies:[{id:'c',name:'Клиент',roles:['customer'],managerLabels:[],shipmentIds:[],paymentIds:[],flags:[]}],directories:{...emptyDirectories(),addresses:[address]},shipments:{},tripRequests:{}} as unknown as OperationsData;
 const snapshot=()=>({...data,shipments:[],directories:structuredClone(data.directories)}) as unknown as Snapshot;
 return {data,snapshot};
}
test('receiver list validates shape, length, unknown fields and every phone',()=>{
 for(const value of [null,'name',{},[null],[{name:4,phone:''}],[{name:'x',phone:'bad'}],[{name:'x',phone:'',rights:true}],Array(50).fill(contact)])assert.throws(()=>locationDetails({additionalReceivers:value}),{status:400});
 assert.deepEqual(locationDetails({additionalReceivers:[{name:'  Второй ',phone:' +7 900 000-00-02 '},{name:'',phone:''}]}).additionalReceivers,[contact]);
});
test('company edits preserve legacy primary, coordinates and distances, increment versions only on actual contact change',()=>{
 const {data,snapshot}=fixture();
 const payload=()=>({version:data.companies[0].version??0,name:'Клиент',roles:['customer'],addresses:data.directories!.addresses.map(({companyId:_companyId,...a})=>({...a,version:a.version??0,additionalReceivers:[contact]}))});
 saveCompany(payload(),snapshot(),data,'c');
 const saved=structuredClone(data.directories!.addresses[0]);assert.equal(saved.receiverName,'Первый');assert.equal(saved.latitude,'55');assert.deepEqual(saved.oilDepotDistancesKm,{d:'10'});assert.deepEqual(saved.additionalReceivers,[contact]);assert.equal(saved.version,1);
 saveCompany(payload(),snapshot(),data,'c');assert.deepEqual(data.directories!.addresses[0],saved);
 const {companyId:_companyId,...stale}=saved;assert.throws(()=>saveCompany({...payload(),addresses:[{...stale,version:0}]},snapshot(),data,'c'),{status:409});
});
test('legacy address edits preserve extras, explicit clearing removes extras, stale versions reject',()=>{
 const {data,snapshot}=fixture();data.directories!.addresses[0].additionalReceivers=[contact];
 const fields={name:'Площадка',companyId:'c',addressKind:'delivery'};
 updateDirectoryEntry('addresses','a',{...fields,version:0,receiverName:'Исправлен'},snapshot(),data);
 assert.deepEqual(data.directories!.addresses[0].additionalReceivers,[contact]);
 assert.throws(()=>updateDirectoryEntry('addresses','a',{...fields,version:0,additionalReceivers:[]},snapshot(),data),{status:409});
 updateDirectoryEntry('addresses','a',{...fields,version:1,additionalReceivers:[]},snapshot(),data);assert.equal(data.directories!.addresses[0].additionalReceivers,undefined);assert.equal(data.directories!.addresses[0].receiverName,'Исправлен');
});
test('both directory drafts preserve all contacts for merge and save',()=>{
 const {data,snapshot}=fixture();data.directories!.addresses[0].additionalReceivers=[contact];
 const direct=directoryPayload('addresses',directoryDraft(snapshot(),'addresses','a'));assert.deepEqual(direct.additionalReceivers,[contact]);
 const company=directoryPayload('customers',directoryDraft(snapshot(),'customers','c'));assert.deepEqual((company.addresses as ShipmentAddress[])[0].additionalReceivers,[contact]);
});

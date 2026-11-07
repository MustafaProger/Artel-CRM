import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { ApiError } from '../server/api-error';
import { enrollNkDirectAutostart, continueApprovedNkDirect27, nkDirectExistingExpectation, NK_DIRECT_EXISTING_TRIP } from '../server/nk-direct-autostart';
import { OperationsStore } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { saveShipmentTrip } from '../server/shipment-trips';
import { recordDriverTripAction, readDriverTrips } from '../server/driver-trips';
import { authorizeNkDirectEtrn, getNkDirectEtrnWorkflow, nkDirectEtrnCompleted, runNkDirectEtrn, startNkDirectEtrn } from '../server/nk-direct-etrn';
import { SabyClient, type SabyObject } from '../server/saby-client';
import { exchangePreparedEtrn } from '../server/etrn-service';
import { dispatchTripSaby } from '../server/trip-saby-scheduler';
import { parseXml } from '../server/saby-order-evidence';
import { CONSIGNMENT_CARRIER_ACCEPTANCE } from '../server/saby-consignment-evidence';
import { integrationRuntime, integrationConfig, integrationSettings, integrationApi, type IntegrationRpc } from './helpers/trip-saby-integration';
import type { AccountUser } from '../web/src/auth-model';

const fp = 'cd'.repeat(20);
async function fixture(skips = [false, false], oldPolicy = false, automatic = false) {
  const rt = await integrationRuntime(), config = integrationConfig();
  config.login = 'synthetic-login'; config.password = 'synthetic-password'; config.accountNumber = 'artel-account'; config.carrierAccountNumber = 'nk-account';
  config.nkConsignmentSigner = { surname: 'НКПодписант', name: 'Тест', patronymic: '', position: 'Директор' }; config.nkRegulatoryInstructions = 'Синтетические подтверждённые указания НК';
  config.automaticSigning = { id: 'synthetic-direct-policy', enabled: true, approvedAt: '2026-01-01T00:00:00Z', mode: 'deferred', sender: { ...config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...config.carrier, thumbprint: fp } };
  const driver: AccountUser = { id: 'driver-user', login: 'driver-user', name: 'Синтетический водитель', role: 'driver', driverId: 'driver', managerId: null, active: true, version: 1 };
  const created = await rt.store.mutate(rt.source, data => {
    data.accounts = { users: [ { id: 'actor', login: 'actor', name: 'Директор', role: 'director', managerId: null, active: true, version: 1, passwordHash: 'a'.repeat(128), salt: 'a'.repeat(32) }, { ...driver, sections: [], passwordHash: 'a'.repeat(128), salt: 'a'.repeat(32) } ], sessions: [], attempts: {} };
    const fields = Object.fromEntries(['supplier_id','carrier_id','oil_depot_id','product_id','purchase_price_unspecified_unit','driver_id','vehicle_id','additional_costs'].map(key => [key,rt.trip.fields[key]]));
    Object.assign(fields, { organization_id: 'nk-artel', trip_flow_version: 'driver-v1', loading_at: '2026-10-07T09:15' });
    const customers = rt.trip.customers.map((row,index) => ({ fields: { ...Object.fromEntries(['customer_id','manager_id','payment_form_id','sale_price_per_litre','transport_amount','unloading_address_id'].map(key => [key,row.fields[key]])), quantity_litres: index ? '9500' : '8000', etrn_not_required: String(skips[index]), invoice_not_required: String(!skips[index]) } }));
    const result = saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }, undefined, 'actor');
    if (!automatic) for (const row of result.trip.customers) data.shipments[row.id].fields.trip_document_policy = oldPolicy ? 'supply-delivery-v1' : 'nk-direct-etrn-v1';
    if (automatic) enrollNkDirectAutostart({base:rt.base,data,tripId:result.trip.id,config,actorId:'actor'});
    return { result, changed: true };
  });
  const previous = process.env.SABY_AUTOFILL_PROFILE_JSON; process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
  for (const action of ['arrive','depart'] as const) await rt.store.mutate(rt.source, data => {
    const trip = readDriverTrips(currentSnapshot(rt.base,data), driver, created.trip.id,'',data).trip!;
    return recordDriverTripAction(rt.base,data,driver,created.trip.id,action,{ versions: trip.versions, ...(action === 'depart' ? { masses: trip.deliveries.map((row,index)=>({deliveryId:row.id,netTonnes:index?'7.985':'6.745'})) } : {}) }, config);
  });
  const options = { base:rt.base,tripId:created.trip.id,config,actorId:'actor' };
  const preview = async () => getNkDirectEtrnWorkflow({...options,data:await rt.store.read(rt.source)});
  const start = async (token?:string) => { const p = await preview(); assert.equal(p.blockers.length,0,p.blockers.join(' ')); return rt.store.mutate(rt.source,data=>{ startNkDirectEtrn({...options,data,previewToken:token??p.start?.previewToken??'a'.repeat(64),mode:'sign_and_send'});return {changed:true,result:undefined}; }); };
  return {...rt,tripId:created.trip.id,trip:created.trip,config,driver,options,preview,start,close:async()=>{if(previous===undefined)delete process.env.SABY_AUTOFILL_PROFILE_JSON;else process.env.SABY_AUTOFILL_PROFILE_JSON=previous;await rt.close();}};
}
function directApi() {
  const api=integrationApi(),calls:IntegrationRpc[]=[], t1=new Map<string,Buffer>(),t2=new Map<string,Buffer>();
  const signed=new Map<string,{sender:boolean;carrier:boolean}>();let loss:'reserve'|'upload'|'execute'|null=null, recipient=true, fastAcceptance=false;
  const t3=new Map<string,Buffer>();
  const party=(inn:string,kpp:string)=>({СвЮЛ:{ИНН:inn,КПП:kpp}});
  const stage=(side:'sender'|'carrier')=>({Идентификатор:`stage-${side}`,Название:side==='sender'?'Отправка':'Получение груза',Действие:[{Название:side==='sender'?'Погружен':'Принят',ТребуетПодписания:'Да',Сертификат:{Отпечаток:fp,Ключ:{Тип:'Отложенный',Активирован:'Да'}}}]});
  const document=(id:string):SabyObject=>{
    const doc=structuredClone(api.docs.get(id)!);const status=signed.get(id)??{sender:false,carrier:false};delete doc.Код;doc.Направление='Исходящий';doc.Состояние={Код:status.carrier?'7':status.sender?'4':'0'};
    const receipt={Идентификатор:'recipient-stage',Название:'Приемка груза',Исполнитель:[{Контрагент:recipient?doc.Грузополучатель:party('9999999999','999999999')}]};
    const active=status.carrier?receipt:stage(status.sender?'carrier':'sender');doc.Этап=[active];doc.ТекущиеЭтапы=[{Идентификатор:active.Идентификатор}];
    for(const file of doc.Вложение as SabyObject[]){file.Направление='Исходящий';if(status.sender)file.Подпись=[{Сертификат:{Отпечаток:fp,ИНН:(doc.НашаОрганизация as SabyObject).СвЮЛ.ИНН},Файл:{Ссылка:`https://disk.saby.ru/${id}.sgn`}}];}
    if(t2.has(id))(doc.Вложение as SabyObject[]).push({Идентификатор:`${id}-carrier`,Подтип:'1110340',ВерсияФормата:'5.01',Направление:'Исходящий',Файл:{Имя:`${id}-carrier.xml`,Ссылка:`https://disk.saby.ru/${id}-carrier.xml`},...(status.carrier?{Подпись:[{Сертификат:{Отпечаток:fp,ИНН:(doc.НашаОрганизация as SabyObject).СвЮЛ.ИНН},Файл:{Ссылка:`https://disk.saby.ru/${id}.sgn`}}]}:{})});
    if(status.carrier && fastAcceptance) {
      const root=parseXml(t2.get(id)!);
      const body=root.children.find(row=>typeof row!=='string' && row.name==='Документ')!;
      if(typeof body==='string')throw Error();
      const cargo=body.children.find(row=>typeof row!=='string' && row.name==='СодИнфПрвПрием')!;
      if(typeof cargo==='string')throw Error();
      t3.set(id,Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Файл ИдФайл="T3-${id}" ВерсФорм="5.01"><Документ КНД="1110341"><ИдИнфПрвПрием ИдФайлИнфПрвПрием="${root.attributes.ИдФайл}" ДатФайлПрвПрием="${body.attributes.ДатИнфПрвПрием}" ВрФайлПрвПрием="${body.attributes.ВрИнфПрвПрием}" ЭП="c3ludGhldGlj"/><СодИнфГП УИД_ТрН="${cargo.attributes.УИД_ТрН}" СодОпПр="Груз принят"><ПриемГрузГП/></СодИнфГП><Подписант/></Документ></Файл>`));
      doc.Этап=[{...receipt,Завершен:'Да',Вложение:[{Идентификатор:`${id}-recipient`}]},{Идентификатор:'stage-four',Название:'Выдача груза'}];
      doc.ТекущиеЭтапы=[{Идентификатор:'stage-four'}];
      const target=doc.Грузополучатель as SabyObject, legal=(target.СвЮЛ??target.СвФЛ) as SabyObject;
      (doc.Вложение as SabyObject[]).push({Идентификатор:`${id}-recipient`,Подтип:'1110341',ВерсияФормата:'5.01',Направление:'Входящий',Файл:{Имя:`${id}-recipient.xml`,Ссылка:`https://disk.saby.ru/${id}-recipient.xml`},Подпись:[{Сертификат:{Отпечаток:'ef'.repeat(20),ИНН:legal.ИНН},Файл:{Ссылка:`https://disk.saby.ru/${id}-recipient.sgn`}}]});
    }
    return doc;
  };
  const send:typeof fetch=async(url,init)=>{
    if(init?.method==='GET'){
      if(String(url).endsWith('.sgn'))return new Response(Buffer.from('synthetic'));
      const recipientId=String(url).split('/').at(-1)!.replace(/-recipient\.xml$/,'');
      if(t3.has(recipientId)&&String(url).endsWith('-recipient.xml'))return new Response(t3.get(recipientId));
      const id=String(url).split('/').at(-1)!.replace(/-carrier\.xml$/,'');if(t2.has(id)&&String(url).endsWith('-carrier.xml'))return new Response(t2.get(id));
      return api.send(url,init);
    }
    const req=JSON.parse(String(init?.body)) as IntegrationRpc;calls.push(req);const json=(result:unknown)=>new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,result}));
    if(req.method==='СБИС.Аутентифицировать')return json('synthetic-nk-session');
    assert.equal(new Headers(init?.headers).get('X-SBISSessionID'),'synthetic-nk-session');
    if(req.method.startsWith('sabyCertificate.')){
      const org=integrationConfig().carrier;const certificate={Certificate:{Type:'Client',CertificateInfo:{Thumbprint:fp,IsValid:true,IsQualified:true,NotBefore:'2020-01-01T00:00:00Z',NotAfter:'2099-01-01T00:00:00Z',SubjectName:{'1.2.643.100.4':org.inn,'2.5.4.4':'НКПодписант','2.5.4.42':'Тест'}}},OurCompany:{Inn:org.inn,Kpp:org.kpp}};
      return json(req.method.endsWith('.List')?[certificate]:certificate);
    }
    if(req.method==='СБИС.ЗаписатьДокумент'){
      const response=await api.send(url,init);const body=await response.clone().json();const id=String(body.result.Идентификатор);
      assert.equal(req.params.Документ.Тип,'ConsignmentNote');
      if(req.params.Документ.Вложение){const file=(req.params.Документ.Вложение as SabyObject[])[0].Файл;t1.set(id,Buffer.from(String(file.ДвоичныеДанные),'base64'));}
      if(loss===(req.params.Документ.Вложение?'upload':'reserve')){loss=null;throw new Error('synthetic accepted response loss');}return response;
    }
    if(req.method==='СБИС.ПрочитатьДокумент')return json(document(String(req.params.Документ.Идентификатор)));
    if(req.method==='СБИС.ПодготовитьДействие'||req.method==='СБИС.ВыполнитьДействие'){
      const id=String(req.params.Документ.Идентификатор ?? String((req.params.Документ.Редакция as SabyObject).Идентификатор).replace(/-revision$/,'')),action=req.params.Документ.Этап as SabyObject;const side=action.Название==='Отправка'?'sender':'carrier';
      if(side==='carrier'&&!t2.has(id)){
        const parsed=parseXml(t1.get(id)!);const content=parsed.children.find(row=>typeof row!=='string'&&row.name==='Документ')!;assert.notEqual(typeof content,'string');if(typeof content==='string')throw Error();
        const info=content.children.find(row=>typeof row!=='string'&&row.name==='СодИнфГО')!;if(typeof info==='string')throw Error();
        t2.set(id,Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Файл ИдФайл="ON_TRNACLPPRIN_SYNTHETIC_${id}" ВерсПрог="Saby" ВерсФорм="5.01"><Документ КНД="1110340" ПоФактХЖ="Транспортная накладная, информация перевозчика о приеме груза" ДатИнфПрвПрием="07.10.2026" ВрИнфПрвПрием="11:12:13"><ИдИнфГО ИдФайлИнфГО="${parsed.attributes.ИдФайл}" ДатФайлИнфГО="${content.attributes.ДатИнфГО}" ВрФайлИнфГО="${content.attributes.ВрИнфГО}" ЭП="c3ludGhldGlj"/><СодИнфПрвПрием УИД_ТрН="${info.attributes.УИД_ТрН}" СодОпер="${CONSIGNMENT_CARRIER_ACCEPTANCE}"/><Подписант СтатПодп="1"><ФИО Фамилия="НКПодписант" Имя="Тест"/></Подписант></Документ></Файл>`));
      }
      if(req.method==='СБИС.ВыполнитьДействие'){const status=signed.get(id)??{sender:false,carrier:false};status[side]=true;signed.set(id,status);if(loss==='execute'){loss=null;throw Error('synthetic accepted Execute loss');}}
      const result=document(id);if(req.method==='СБИС.ПодготовитьДействие')(result.Этап as SabyObject[])[0].Вложение=(result.Вложение as SabyObject[]).filter(row=>row.Подтип===(side==='sender'?'1110339':'1110340')).map(row=>({...row,ТребуемоеДействие:'Подписать'}));
      return json(result);
    }
    if(req.method==='СБИС.ЗаписатьВложение'){const revision=(req.params.Документ.Редакция as SabyObject).Идентификатор;const id=String(revision).replace(/-revision$/,'');const file=(req.params.Документ.Вложение as SabyObject[])[0].Файл;t2.set(id,Buffer.from(String(file.ДвоичныеДанные),'base64'));return json(document(id));}
    return api.send(url,init);
  };
  return {send,calls,docs:api.docs,setLoss:(value:typeof loss)=>{loss=value;},setRecipient:(value:boolean)=>{recipient=value;},setFastAcceptance:()=>{fastAcceptance=true;},reserves:()=>api.reserves('ConsignmentNote'),executes:()=>calls.filter(row=>row.method==='СБИС.ВыполнитьДействие')};
}

for(const skips of [[false,false],[false,true],[true,false]])test(`direct NK lifecycle preserves each mass and filters only etrn flag ${skips}`,async()=>{
  const f=await fixture(skips),api=directApi();try{
    const before=await f.store.read(f.source);await f.start();const saved=await f.store.read(f.source);
    assert.deepEqual(saved.shipments,before.shipments);assert.deepEqual(saved.driverTripProgress,before.driverTripProgress);assert.deepEqual(saved.etrn!.trips[f.tripId].loadingFacts,before.etrn!.trips[f.tripId].loadingFacts);
    assert.equal(saved.tripSaby?.trips[f.tripId],undefined);assert.deepEqual(saved.etrn!.trips[f.tripId].direct!.authorization.grantedRoles,['sender','carrier']);
    const run=()=>runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)});await run();
    const final=await f.store.read(f.source),projection=await f.preview();assert.ok(nkDirectEtrnCompleted(final,f.tripId),JSON.stringify(projection));
    assert.equal(api.reserves().length,skips.filter(v=>!v).length);assert.equal(api.executes().length,2*skips.filter(v=>!v).length);
    const rows=final.etrn!.trips[f.tripId].direct!.deliveries;assert.deepEqual(rows.map(row=>row.snapshot.profile.loading.grossMassTonnes),['6.745','7.985'].filter((_,i)=>!skips[i]));
    assert.ok(rows.every(row=>row.snapshot.customerOrganization.inn===f.config.carrier.inn&&row.snapshot.carrierOrganization.inn===f.config.carrier.inn));
    const writes=api.executes().length;await run();assert.equal(api.executes().length,writes);assert.equal((await f.preview()).order,null);
  }finally{await f.close();}
});

test('all excluded deliveries create no direct intent despite independent invoice flags',async()=>{const f=await fixture([true,true]);try{const p=await f.preview();assert.equal(p.notRequired,true);assert.equal(p.start,undefined);await assert.rejects(f.start(),ApiError);assert.equal((await f.store.read(f.source)).etrn!.trips[f.tripId].direct,undefined);}finally{await f.close();}});

test('existing supply-delivery facts become eligible only after fresh explicit direct authorization',async()=>{const f=await fixture([false,false],true);try{const p=await f.preview();assert.ok(p.start,p.blockers.join(' '));const api=directApi();assert.deepEqual(await dispatchTripSaby({...f,enabled:true,send:api.send}),{continued:0,refreshed:0,denied:0,failed:0});assert.equal(api.calls.length,0);await f.start();await assert.rejects(f.start(),ApiError);assert.ok((await f.store.read(f.source)).etrn!.trips[f.tripId].direct);}finally{await f.close();}});

for(const mutation of ['policy','mass','version','actor'] as const)test(`direct authority rejects changed ${mutation} before provider calls`,async()=>{const f=await fixture();try{await f.start();if(mutation==='policy')f.config.automaticSigning!.carrier.thumbprint='ef'.repeat(20);else await f.store.mutate(f.source,data=>{if(mutation==='actor'){ data.accounts!.users.push({ ...data.accounts!.users[0], id: 'other-actor', login: 'other-actor' }); data.accounts!.users.find(row=>row.id==='actor')!.active=false; }else if(mutation==='mass')data.etrn!.trips[f.tripId].loadingFacts!.deliveries[f.trip.customers[0].id].grossMassTonnes='8';else data.shipments[f.trip.customers[0].id].version++;return {result:null,changed:true};});const api=directApi();await assert.rejects(runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)}),ApiError);assert.equal(api.calls.length,0);}finally{await f.close();}});

for(const loss of ['reserve','upload','execute'] as const)test(`restart reconciles uncertain direct ${loss} without duplicate writes`,async()=>{const f=await fixture([false,true]),api=directApi();try{await f.start();api.setLoss(loss);await runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)});const store=new OperationsStore(f.directory+'/store');await runNkDirectEtrn({...f,store,client:new SabyClient(f.config,api.send)});const data=await store.read(f.source);assert.ok(nkDirectEtrnCompleted(data,f.tripId),JSON.stringify(data.etrn!.trips[f.tripId].direct));assert.equal(api.reserves().length,1);assert.equal(api.executes().length,2);}finally{await f.close();}});

test('client dispatch is distinct from signatures; a different recipient cannot complete the driver task',async()=>{const f=await fixture([false,true]),api=directApi();try{await f.start();api.setRecipient(false);await runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)});assert.equal(nkDirectEtrnCompleted(await f.store.read(f.source),f.tripId),false);assert.equal(api.executes().length,2);api.setRecipient(true);await runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)});assert.equal(nkDirectEtrnCompleted(await f.store.read(f.source),f.tripId),true);assert.equal(api.executes().length,2);}finally{await f.close();}});

test('direct input cannot bypass selected delivery snapshots or explicit authorization',async()=>{const f=await fixture([false,true]),api=directApi();try{await f.start();const data=await f.store.read(f.source),row=data.etrn!.trips[f.tripId].direct!.deliveries[0];row.snapshot.profile.loading.grossMassTonnes='8';await assert.rejects(exchangePreparedEtrn({...f,client:new SabyClient(f.config,api.send).forNkDirectEtrn()},{documentMode:'nk-direct-v1',...row}),ApiError);assert.equal(api.calls.length,0);authorizeNkDirectEtrn(f.base,await f.store.read(f.source),f.tripId,f.config);}finally{await f.close();}});

test('fast signed T3 proves recipient handoff without automatic T4',async()=>{const f=await fixture([false,true]),api=directApi();try{await f.start();api.setFastAcceptance();await runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)});const data=await f.store.read(f.source);assert.ok(nkDirectEtrnCompleted(data,f.tripId),JSON.stringify((await f.preview()).deliveries));assert.ok(Object.values(data.etrn!.trips[f.tripId].deliveries)[0].document!.dispatch!.recipientAcceptedAt);assert.equal(api.executes().length,2);}finally{await f.close();}});

test('stale preview cannot grant direct roles after a changed policy',async()=>{const f=await fixture();try{const token=(await f.preview()).start!.previewToken;f.config.automaticSigning!.approvedAt='2026-01-02T00:00:00Z';await assert.rejects(f.start(token),ApiError);assert.equal((await f.store.read(f.source)).etrn!.trips[f.tripId].direct,undefined);}finally{await f.close();}});

test('unresolved lost reservation without a provider document never repeats creation',async()=>{const f=await fixture([false,true]),api=directApi();let attempted=0;try{await f.start();const send:typeof fetch=async(url,init)=>{if(init?.method!=='GET'){const req=JSON.parse(String(init?.body)) as IntegrationRpc;if(req.method==='СБИС.ЗаписатьДокумент'&&!req.params.Документ.Идентификатор){attempted++;throw Error('synthetic unknown reservation');}}return api.send(url,init);};await runNkDirectEtrn({...f,client:new SabyClient(f.config,send)});await runNkDirectEtrn({...f,store:new OperationsStore(f.directory+'/store'),client:new SabyClient(f.config,send)});assert.equal(attempted,1);assert.equal(api.docs.size,0);assert.equal((await f.preview()).phase,'unknown');}finally{await f.close();}});

test('revoked rights between reservation and upload stop the next external request',async()=>{const f=await fixture([false,true]),api=directApi();try{await f.start();let revoked=false;const send:typeof fetch=async(url,init)=>{const result=await api.send(url,init);if(init?.method!=='GET'){const req=JSON.parse(String(init?.body)) as IntegrationRpc;if(!revoked&&req.method==='СБИС.ЗаписатьДокумент'){revoked=true;await f.store.mutate(f.source,data=>{data.accounts!.users.push({...data.accounts!.users[0],id:'other-owner',login:'other-owner'});data.accounts!.users.find(row=>row.id==='actor')!.active=false;return {changed:true,result:undefined};});}}return result;};await assert.rejects(runNkDirectEtrn({...f,client:new SabyClient(f.config,send)}),ApiError);assert.equal(api.calls.filter(row=>row.method==='СБИС.ЗаписатьДокумент').length,1);assert.equal(api.executes().length,0);}finally{await f.close();}});

for (const skips of [[false, false], [false, true], [true, false], [true, true]]) test(`automatic NK departure grants only selected deliveries ${skips}`, async () => {
  const f = await fixture(skips, false, true), api = directApi();
  try {
    const before = await f.store.read(f.source), saved = before.etrn!.trips[f.tripId];
    assert.equal(saved.directAutostart!.state, skips.every(Boolean) ? 'not_required' : 'queued');
    assert.equal((await f.preview()).start, undefined);
    assert.equal((await f.preview()).automation?.mode, 'after_driver_departure');
    if (skips.every(Boolean)) {
      assert.equal(saved.direct, undefined);
      assert.deepEqual(await dispatchTripSaby({ ...f, enabled: true, send: api.send }), { continued: 0, refreshed: 0, denied: 0, failed: 0 });
    } else {
      assert.equal(saved.direct!.authorization.actorId, 'actor');
      assert.equal(saved.directAutostart!.event!.actorId, f.driver.id);
      assert.equal(saved.direct!.authorization.automatic!.source, 'driver_departure');
      // The process stops immediately after commit, before any scheduling hint can be delivered.
      const store = new OperationsStore(f.directory + '/store');
      await dispatchTripSaby({ ...f, store, enabled: true, send: api.send });
      assert.ok(nkDirectEtrnCompleted(await store.read(f.source), f.tripId));
      assert.equal(api.reserves().length, skips.filter(value => !value).length);
      assert.equal(api.executes().length, 2 * skips.filter(value => !value).length);
      assert.ok(api.calls.filter(row => row.method === 'СБИС.ЗаписатьДокумент').every(row => row.params.Документ.Тип === 'ConsignmentNote'));
    }
    const after = await f.store.read(f.source);
    assert.deepEqual(after.shipments, before.shipments);
    assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
  } finally { await f.close(); }
});

for (const loss of ['reserve', 'upload', 'execute'] as const) test(`automatic intent survives concurrent workers and unknown ${loss} without repeated writes`, async () => {
  const f = await fixture([false, true], false, true), api = directApi();
  try {
    api.setLoss(loss);
    const run = (store = f.store) => runNkDirectEtrn({ ...f, store, client: new SabyClient(f.config, api.send) });
    const concurrent = await Promise.allSettled([run(), run(new OperationsStore(f.directory + '/store'))]);
    assert.ok(concurrent.some(result => result.status === 'fulfilled'));
    for (const result of concurrent) if (result.status === 'rejected') assert.ok(result.reason instanceof ApiError && result.reason.status === 409);
    await run(new OperationsStore(f.directory + '/store'));
    assert.ok(nkDirectEtrnCompleted(await f.store.read(f.source), f.tripId));
    assert.equal(api.reserves().length, 1); assert.equal(api.executes().length, 2);
  } finally { await f.close(); }
});

for (const mutation of ['creator', 'policy', 'certificate', 'event', 'enrollment', 'delivery'] as const) test(`automatic authority rejects changed ${mutation} before network`, async () => {
  const f = await fixture([false, true], false, true), api = directApi();
  try {
    if (mutation === 'policy') f.config.automaticSigning!.approvedAt = '2026-10-20T00:00:00Z';
    else if (mutation === 'certificate') f.config.automaticSigning!.carrier.thumbprint = 'ef'.repeat(20);
    else await f.store.mutate(f.source, data => {
      if (mutation === 'creator') {
        data.accounts!.users.push({ ...data.accounts!.users[0], id: 'other-director', login: 'other-director' });
        data.accounts!.users.find(row => row.id === 'actor')!.active = false;
      } else if (mutation === 'event') data.driverTripProgress![f.tripId].departedBy = 'different-driver-user';
      else if (mutation === 'enrollment') data.etrn!.trips[f.tripId].directAutostart!.sourceHash = 'f'.repeat(64);
      else data.shipments[f.trip.customers[1].id].fields.etrn_not_required = 'false';
      return { changed: true, result: undefined };
    });
    await assert.rejects(runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) }), ApiError);
    assert.equal(api.calls.length, 0);
  } finally { await f.close(); }
});

test('scoped continuation adopts only exact approved #27, is idempotent, preserves #26 and never edits facts', async () => {
  const f = await fixture(), protectedTrip = 'shipment-trip-789ee9fb-f017-4ca9-bc3e-9849d3b75ef1';
  try {
    const targetIds = ['shipment-local-d4593cc1-1c92-406d-8229-e8c085ae3dfd', 'shipment-local-d0d5959a-ef66-4e54-bf67-a6e896194b94'];
    await f.store.mutate(f.source, data => {
      // Rename synthetic fixture identities into the exact maintenance allow-list. No live records are used.
      let encoded = JSON.stringify(data).replaceAll(f.tripId, NK_DIRECT_EXISTING_TRIP);
      f.trip.customers.forEach((row, index) => { encoded = encoded.replaceAll(row.id, targetIds[index]); });
      const cloned = JSON.parse(encoded);
      Object.assign(data, cloned);
      const progress = data.driverTripProgress![NK_DIRECT_EXISTING_TRIP];
      progress.arrivedAt = '2026-10-20T08:28:20.231Z'; progress.departedAt = '2026-10-20T08:28:37.830Z'; progress.continuationRequestedAt = progress.departedAt;
      const facts = data.etrn!.trips[NK_DIRECT_EXISTING_TRIP].loadingFacts!;
      facts.arrivedAt = '2026-10-20T11:28:20'; facts.departedAt = '2026-10-20T11:28:37'; facts.recordedAt = progress.departedAt;
      targetIds.forEach(id => { data.shipments[id].fields.loading_actual_at = facts.arrivedAt; });
      // compositionHash includes IDs; recalculate exactly the confirmed driver's composition.
      const rows = currentSnapshot(f.base, data, false).shipments.filter(row => row.fields.trip_id === NK_DIRECT_EXISTING_TRIP);
      progress.compositionHash = createHash('sha256').update(JSON.stringify([...rows].sort((a,b) => a.id.localeCompare(b.id)).map(row => [row.id, ...['trip_flow_version', 'driver_id', 'vehicle_id', 'customer_id', 'unloading_address_id', 'unloading_address', 'product_id', 'quantity_litres', 'oil_depot_id', 'loading_address', 'loading_planned_at'].map(key => row.fields[key] ?? null)]))).digest('hex');
      data.driverTripProgress![protectedTrip] = { ...structuredClone(progress), compositionHash: 'f'.repeat(64) };
      return { changed: true, result: undefined };
    });
    const before = await f.store.read(f.source), options = { base: f.base, tripId: NK_DIRECT_EXISTING_TRIP, config: f.config, actorId: 'actor' };
    const expected = nkDirectExistingExpectation({ ...options, data: before });
    await assert.rejects(f.store.mutate(f.source, data => ({ changed: true, result: continueApprovedNkDirect27({ ...options, tripId: protectedTrip, data, expected }) })), ApiError);
    await assert.rejects(f.store.mutate(f.source, data => ({ changed: true, result: continueApprovedNkDirect27({ ...options, data, expected: { ...expected, sourceHash: '0'.repeat(64) } }) })), ApiError);
    const originalPolicy = f.config.automaticSigning!.approvedAt;
    f.config.automaticSigning!.approvedAt = '2026-01-03T00:00:00Z';
    await assert.rejects(f.store.mutate(f.source, data => ({ changed: true, result: continueApprovedNkDirect27({ ...options, data, expected }) })), ApiError);
    f.config.automaticSigning!.approvedAt = originalPolicy;
    const adopted = await f.store.mutate(f.source, data => ({ changed: true, result: continueApprovedNkDirect27({ ...options, data, expected }) }));
    assert.equal(adopted.enqueued, true);
    const after = await f.store.read(f.source), attempt = after.etrn!.trips[NK_DIRECT_EXISTING_TRIP].direct!.attemptId;
    const replay = await f.store.mutate(f.source, data => { const result = continueApprovedNkDirect27({ ...options, data, expected: { policyHash: expected.policyHash, factsHash: expected.factsHash, sourceHash: expected.sourceHash } }); return { changed: result.enqueued, result }; });
    assert.equal(replay.enqueued, false); assert.equal((await f.store.read(f.source)).etrn!.trips[NK_DIRECT_EXISTING_TRIP].direct!.attemptId, attempt);
    assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
    assert.deepEqual(after.etrn!.trips[NK_DIRECT_EXISTING_TRIP].loadingFacts, before.etrn!.trips[NK_DIRECT_EXISTING_TRIP].loadingFacts);
    const api = directApi();
    await runNkDirectEtrn({ ...f, tripId: NK_DIRECT_EXISTING_TRIP, client: new SabyClient(f.config, api.send) });
    assert.ok(nkDirectEtrnCompleted(await f.store.read(f.source), NK_DIRECT_EXISTING_TRIP));
  } finally { await f.close(); }
});

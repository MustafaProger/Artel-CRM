import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { ApiError } from '../server/api-error';
import { enrollNkDirectAutostart, continueApprovedNkDirect27, nkDirectExistingExpectation, NK_DIRECT_EXISTING_TRIP } from '../server/nk-direct-autostart';
import { OperationsStore, type OperationsStorage } from '../server/operations-store';
import { createSnapshotMiddleware } from '../server/local-api';
import { currentSnapshot } from '../server/shipment-operations';
import { getShipmentTrip, saveShipmentTrip } from '../server/shipment-trips';
import { recordDriverTripAction, readDriverTrips } from '../server/driver-trips';
import { authorizeNkDirectEtrn, getNkDirectEtrnWorkflow, nkDirectEtrnCompleted, runNkDirectEtrn, startNkDirectEtrn } from '../server/nk-direct-etrn';
import { SabyClient, type SabyObject } from '../server/saby-client';
import { validateNativeSenderAmendment, exchangePreparedEtrn, type EtrnDocument } from '../server/etrn-service';
import { buildSabyConsignmentDocument } from '../server/saby-consignment-note';
import { encodeWindows1251 } from '../server/saby-transport-order';
import { createTripSabyScheduler, dispatchTripSaby } from '../server/trip-saby-scheduler';
import { parseXml } from '../server/saby-order-evidence';
import { CONSIGNMENT_CARRIER_ACCEPTANCE } from '../server/saby-consignment-evidence';
import { integrationRuntime, integrationConfig, integrationSettings, integrationApi, type IntegrationRpc } from './helpers/trip-saby-integration';
import type { AccountUser } from '../web/src/auth-model';
import { syntheticLoadingDetails } from './helpers/loading-details-fixture';
import { getNkLoadingDetails, saveNkLoadingDetails } from '../server/nk-loading-details';

const fp = 'cd'.repeat(20);
const syntheticUuid = (label:string) => { const digest=createHash('sha256').update(label).digest('hex'); return `${digest.slice(0,8)}-${digest.slice(8,12)}-4${digest.slice(13,16)}-8${digest.slice(17,20)}-${digest.slice(20,32)}`; };
async function fixture(skips = [false, false], oldPolicy = false, automatic = false, redirectionMethod = integrationSettings.instructions!.redirectionMethod, includeLoadingDetails = true, changeSourceBeforeDeparture = false, newSenderDefault = false) {
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
    // Existing scenarios exercise pre-change saved depot-loader workflows.
    if (!newSenderDefault) delete data.etrn!.trips[result.trip.id].loadingActorMode;
    if (includeLoadingDetails) {
      data.etrn ??= { trips: {} };
      (data.etrn.trips[result.trip.id] ??= { deliveries: {}, updatedAt: new Date().toISOString() }).loadingDetails = syntheticLoadingDetails();
    }
    if (!automatic) for (const row of result.trip.customers) data.shipments[row.id].fields.trip_document_policy = oldPolicy ? 'supply-delivery-v1' : 'nk-direct-etrn-v1';
    if (automatic) enrollNkDirectAutostart({base:rt.base,data,tripId:result.trip.id,config,actorId:'actor'});
    return { result, changed: true };
  });
  const previous = process.env.SABY_AUTOFILL_PROFILE_JSON; process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify({ ...integrationSettings, instructions: { ...integrationSettings.instructions, redirectionMethod } });
  if (changeSourceBeforeDeparture) await rt.store.mutate(rt.source, data => {
    for (const row of created.trip.customers) { data.shipments[row.id].fields.trip_notes = 'Синтетическое изменение после настройки очереди'; data.shipments[row.id].version++; }
    return { result: undefined, changed: true };
  });
  for (const action of ['arrive','depart'] as const) await rt.store.mutate(rt.source, data => {
    const trip = readDriverTrips(currentSnapshot(rt.base,data), driver, created.trip.id,'',data).trip!;
    return recordDriverTripAction(rt.base,data,driver,created.trip.id,action,{ versions: trip.versions, ...(action === 'depart' ? { masses: trip.deliveries.map((row,index)=>({deliveryId:row.id,netTonnes:index?'7.985':'6.745'})) } : {}) }, config);
  });
  const options = { base:rt.base,tripId:created.trip.id,config,actorId:'actor' };
  const preview = async () => getNkDirectEtrnWorkflow({...options,data:await rt.store.read(rt.source)});
  const start = async (token?:string) => { const p = await preview(); assert.equal(p.blockers.length,0,p.blockers.join(' ')); return rt.store.mutate(rt.source,data=>{ startNkDirectEtrn({...options,data,previewToken:token??p.start?.previewToken??'a'.repeat(64),mode:'sign_and_send'});return {changed:true,result:undefined}; }); };
  return {...rt,tripId:created.trip.id,trip:created.trip,config,driver,options,preview,start,close:async()=>{if(previous===undefined)delete process.env.SABY_AUTOFILL_PROFILE_JSON;else process.env.SABY_AUTOFILL_PROFILE_JSON=previous;await rt.close();}};
}

async function saveLoadingDetails(f: Awaited<ReturnType<typeof fixture>>, actorId = 'actor') {
  return f.store.mutate(f.source, data => {
    const current = getNkLoadingDetails(f.base, data, f.tripId, f.config);
    return saveNkLoadingDetails(f.base, data, f.tripId, actorId, { version: current.version, details: syntheticLoadingDetails() }, f.config);
  });
}

test('direct authority builds one full snapshot per fresh transaction and preserves rejection decisions', async () => {
  const f = await fixture([false, true]);
  try {
    await f.start();
    const original = await f.store.read(f.source);
    for (const change of ['none', 'actor', 'policy', 'mass', 'version', 'loading-role', 'outer-authority'] as const) {
      const data = structuredClone(original), config = structuredClone(f.config);
      if (change === 'actor') data.accounts!.users.find(row => row.id === 'actor')!.active = false;
      if (change === 'policy') config.automaticSigning!.carrier.thumbprint = 'ef'.repeat(20);
      if (change === 'mass') data.etrn!.trips[f.tripId].loadingFacts!.deliveries[f.trip.customers[0].id].grossMassTonnes = '8';
      if (change === 'version') data.shipments[f.trip.customers[0].id].version++;
      if (change === 'loading-role') data.etrn!.trips[f.tripId].loadingActorMode = 'sender';
      const authorize = () => { if (change === 'outer-authority') throw new ApiError(401, 'Synthetic outer authority revoked'); };
      let expectedError: unknown;
      try { authorize(); authorizeNkDirectEtrn(f.base, data, f.tripId, config); } catch (error) { expectedError = error; }
      if (change === 'none') assert.equal(expectedError, undefined);
      else assert.ok(expectedError instanceof ApiError, change);
      let shipmentReads = 0;
      const trackedBase = new Proxy(f.base, { get(target, property, receiver) {
        if (property === 'shipments') shipmentReads++;
        return Reflect.get(target, property, receiver);
      } });
      currentSnapshot(trackedBase, data);
      const oneAssemblyReads = shipmentReads;
      assert.ok(oneAssemblyReads > 0);
      shipmentReads = 0;
      const stop = new Error('Stop after isolated successful claim');
      let claims = 0, sends = 0;
      const store: OperationsStorage = {
        read: async () => structuredClone(data),
        mutate: async (_source, update) => {
          claims++;
          const copy = structuredClone(data);
          try { await update(copy); }
          finally { assert.equal(shipmentReads, oneAssemblyReads, `${change}: one full assembly inside authority`); }
          throw stop;
        },
      };
      await assert.rejects(runNkDirectEtrn({ ...f, base: trackedBase, store, authorize, client: new SabyClient(config, async () => { sends++; throw new Error('Provider must not run'); }) }), error => expectedError instanceof ApiError
        ? error instanceof ApiError && error.status === expectedError.status && error.message === expectedError.message
        : error === stop);
      assert.equal(claims, 1); assert.equal(sends, 0);
    }
    assert.deepEqual(await f.store.read(f.source), original, 'The isolated authorization checks do not persist claims or alter frozen facts');
  } finally { await f.close(); }
});

test('direct authority CPU comparison uses the same full financial snapshot and frozen synthetic grant', async () => {
  const f = await fixture([false, true]);
  try {
    await f.start();
    const original = await f.store.read(f.source);
    const template = currentSnapshot(f.base, original).shipments[0];
    const base = { ...f.base, shipments: Array.from({ length: 2000 }, (_, index) => ({
      ...template, id: `performance-source-${index}`, fields: Object.fromEntries(Object.entries(template.fields).map(([key, value]) => [key, key.startsWith('trip_') ? null : value])),
    })) };
    const expected = authorizeNkDirectEtrn(base, original, f.tripId, f.config);
    const stop = new Error('Isolated comparison stops before persistence and provider calls');
    let currentMs = 0;
    const store: OperationsStorage = {
      read: async () => structuredClone(original),
      mutate: async (_source, update) => {
        const copy = structuredClone(original), started = performance.now();
        const result = update(copy);
        currentMs = performance.now() - started;
        await result;
        throw stop;
      },
    };
    const oldTimes: number[] = [], newTimes: number[] = [];
    for (let index = 0; index < 15; index++) {
      const oldData = structuredClone(original), started = performance.now();
      currentSnapshot(base, oldData); f.authorize();
      const oldResult = authorizeNkDirectEtrn(base, oldData, f.tripId, f.config);
      const oldMs = performance.now() - started;
      assert.deepEqual(oldResult, expected);
      await assert.rejects(runNkDirectEtrn({ ...f, base, store, client: new SabyClient(f.config, async () => { throw new Error('Provider must not run'); }) }), error => error === stop);
      if (index >= 3) { oldTimes.push(oldMs); newTimes.push(currentMs); }
    }
    const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { medianMs: sorted[Math.floor(sorted.length / 2)], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] }; };
    console.log('NK_DIRECT_AUTHORITY_BENCH', JSON.stringify({ old: stats(oldTimes), current: stats(newTimes), samples: oldTimes.length, syntheticShipments: 2000, isolated: true, providerCalls: 0 }));
    assert.deepEqual(await f.store.read(f.source), original);
  } finally { await f.close(); }
});

test('loading recovery queues one unchanged authenticated departure after required details are saved', async () => {
  const f = await fixture([false, true], false, true, undefined, false);
  try {
    const before = await f.store.read(f.source), enrollment = before.etrn!.trips[f.tripId].directAutostart!;
    assert.equal(enrollment.state, 'blocked');
    assert.match(enrollment.lastError!, /погруз/i);
    assert.ok(enrollment.event?.sourceHash);
    assert.equal(before.etrn!.trips[f.tripId].direct, undefined);
    assert.equal(getNkLoadingDetails(f.base, before, f.tripId, f.config).autoContinuation, true);
    const result = await saveLoadingDetails(f);
    assert.equal(result.editable, false);
    assert.equal(result.autoContinuation, false, 'A queued grant is no longer a resumable loading draft');
    const after = await new OperationsStore(f.directory + '/store').read(f.source);
    const saved = after.etrn!.trips[f.tripId], direct = saved.direct!;
    assert.equal(saved.directAutostart!.state, 'queued');
    assert.deepEqual(saved.directAutostart!.event, enrollment.event);
    assert.equal(direct.authorization.actorId, enrollment.actorId);
    assert.equal(direct.authorization.automatic!.eventHash, enrollment.event!.factsHash);
    assert.equal(direct.deliveries.length, 1);
    assert.deepEqual(direct.deliveries[0].snapshot.profile.loadingActor.worker, syntheticLoadingDetails().worker);
    assert.deepEqual(after.shipments, before.shipments);
    assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
    assert.deepEqual(saved.loadingFacts, before.etrn!.trips[f.tripId].loadingFacts);
    assert.deepEqual(saved.deliveries, {});
    assert.equal(authorizeNkDirectEtrn(f.base, after, f.tripId, f.config).attemptId, direct.attemptId);
    await assert.rejects(saveLoadingDetails(f), error => error instanceof ApiError && error.status === 409);
    assert.deepEqual(await f.store.read(f.source), after, 'Replaying the form cannot replace a grant or duplicate a document');
  } finally { await f.close(); }
});

for (const change of ['old_event', 'source', 'loading_role', 'facts', 'policy', 'creator'] as const) test(`loading recovery rejects changed ${change} without changing confirmed driver facts or creating a grant`, async () => {
  const f = await fixture([false, true], false, true, undefined, false);
  try {
    let savingActor = 'actor';
    if (change === 'policy') f.config.automaticSigning!.approvedAt = '2026-10-19T00:00:00Z';
    else await f.store.mutate(f.source, data => {
      const saved = data.etrn!.trips[f.tripId];
      if (change === 'old_event') delete saved.directAutostart!.event!.sourceHash;
      if (change === 'loading_role') saved.loadingActorMode = 'sender';
      if (change === 'source') for (const row of f.trip.customers) { data.shipments[row.id].fields.trip_notes = 'Синтетическое изменение после убытия'; data.shipments[row.id].version++; }
      if (change === 'facts') saved.loadingFacts!.recordedAt = '2026-10-19T00:00:00Z';
      if (change === 'creator') {
        const actor = data.accounts!.users.find(row => row.id === 'actor')!;
        data.accounts!.users.push({ ...actor, id: 'replacement-director', login: 'replacement-director' });
        actor.active = false; savingActor = 'replacement-director';
      }
      return { result: undefined, changed: true };
    });
    const before = await f.store.read(f.source);
    assert.equal(getNkLoadingDetails(f.base, before, f.tripId, f.config).autoContinuation, false, 'The form must not promise continuation for an ineligible event');
    const result = await saveLoadingDetails(f, savingActor);
    assert.equal(result.editable, true, 'Incomplete authorization must stay a local editable draft');
    const after = await f.store.read(f.source), saved = after.etrn!.trips[f.tripId];
    assert.equal(saved.directAutostart!.state, 'blocked');
    assert.equal(saved.direct, undefined);
    assert.deepEqual(saved.deliveries, {});
    assert.deepEqual(saved.directAutostart!.event, before.etrn!.trips[f.tripId].directAutostart!.event);
    assert.deepEqual(saved.loadingFacts, before.etrn!.trips[f.tripId].loadingFacts);
    assert.deepEqual(after.shipments, before.shipments);
    assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
  } finally { await f.close(); }
});

test('direct grant pins sender loading role and transportation contact and rejects later role changes', async () => {
  const f = await fixture([false, true]);
  try {
    f.config.carrierResponsible = { surname: 'ПеревозчикТестовый', name: 'Тест', patronymic: 'Тестович', phone: '+70000000077' };
    await f.store.mutate(f.source, data => { data.etrn!.trips[f.tripId].loadingActorMode = 'sender'; return { result: undefined, changed: true }; });
    await f.start();
    const data = await f.store.read(f.source), direct = data.etrn!.trips[f.tripId].direct!;
    assert.equal(direct.deliveries[0].snapshot.loadingActorMode, 'sender');
    assert.deepEqual(direct.deliveries[0].snapshot.profile.carrierResponsible, f.config.carrierResponsible);
    f.config.carrierResponsible.name = 'ИзменённыйТест';
    assert.equal(authorizeNkDirectEtrn(f.base, data, f.tripId, f.config).attemptId, direct.attemptId);
    delete data.etrn!.trips[f.tripId].loadingActorMode;
    assert.throws(() => authorizeNkDirectEtrn(f.base, data, f.tripId, f.config), error => error instanceof ApiError && error.status === 409);
    assert.equal(direct.deliveries[0].snapshot.profile.carrierResponsible!.name, 'Тест');
  } finally { await f.close(); }
});

test('loading recovery cannot revive an enrollment rejected because trip inputs changed before departure', async () => {
  const f = await fixture([false, true], false, true, undefined, false, true);
  try {
    const before = await f.store.read(f.source), enrollment = before.etrn!.trips[f.tripId].directAutostart!;
    assert.equal(enrollment.state, 'blocked');
    assert.equal(enrollment.event!.sourceHash, undefined, 'A rejected enrollment must not freeze the changed source as retry authorization');
    assert.equal(getNkLoadingDetails(f.base, before, f.tripId, f.config).autoContinuation, false);
    await saveLoadingDetails(f);
    const after = await f.store.read(f.source), saved = after.etrn!.trips[f.tripId];
    assert.equal(saved.direct, undefined);
    assert.deepEqual(saved.directAutostart, enrollment);
    assert.deepEqual(saved.deliveries, {});
    assert.deepEqual(after.shipments, before.shipments);
    assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
  } finally { await f.close(); }
});

test('loading continuation projection is read-only and excludes a trip held after rebuilding its exchange', async () => {
  const f = await fixture([false, true], false, true, undefined, false);
  try {
    const data = await f.store.read(f.source);
    const before = structuredClone(data);
    assert.equal(getNkLoadingDetails(f.base, data, f.tripId, f.config).autoContinuation, true);
    assert.deepEqual(data, before, 'Projecting eligibility must not update enrollment or saved facts');
    // Only exercise the read-only predicate; the full rebuild schema and archive
    // integrity are covered by nk-direct-rebuild.test.ts.
    data.etrn!.trips[f.tripId].rebuild = { id: randomUUID(), at: new Date().toISOString(), actorId: 'actor', archivedSha256: 'a'.repeat(64), sourceFingerprint: 'b'.repeat(64), externalRestartBlocked: true };
    const held = structuredClone(data);
    assert.equal(getNkLoadingDetails(f.base, data, f.tripId, f.config).autoContinuation, false);
    assert.deepEqual(data, held);
  } finally { await f.close(); }
});

function directApi(canonicalParties = false, nativePreparedEdits = false, autoUuid = false, processingAfterSender = false) {
  const api=integrationApi(),calls:IntegrationRpc[]=[], t1=new Map<string,Buffer>(),t2=new Map<string,Buffer>();
  const signed=new Map<string,{sender:boolean;carrier:boolean}>();let loss:'upload'|'http500'|'execute'|null=null, recipient=true, fastAcceptance=false, delayedCarrierTitle=false;
  const t3=new Map<string,Buffer>(), operatorUids=new Map<string,string>();
  const party=(inn:string,kpp:string)=>({СвЮЛ:{ИНН:inn,КПП:kpp}});
  const cabinetUrl = (id:string) => `https://tms.saby.ru/opendoc.html?guid=11111111-1111-4111-8111-111111111111&org=222&f3=1&client=333&file=${syntheticUuid(id+'-title')}&ver=1`;
  const stage=(side:'sender'|'carrier')=>({Идентификатор:`stage-${side}`,Название:side==='sender'?'Отправка':'Получение груза',Действие:[{Название:side==='sender'?'Погружен':'Принят',ТребуетПодписания:'Да',Сертификат:{Отпечаток:fp,Ключ:{Тип:'Отложенный',Активирован:'Да'}}}]});
  const document=(id:string):SabyObject=>{
    const doc=structuredClone(api.docs.get(id)!);const status=signed.get(id)??{sender:false,carrier:false};delete doc.Код;doc.Направление='Исходящий';doc.Состояние={Код:status.carrier?'7':status.sender?(processingAfterSender?'10':'4'):'0'};
    const receipt={Идентификатор:'recipient-stage',Название:'Приемка груза',Исполнитель:[{Контрагент:recipient?doc.Грузополучатель:party('9999999999','999999999')}]};
    const active=status.carrier?receipt:stage(status.sender?'carrier':'sender');doc.Этап=[active];doc.ТекущиеЭтапы=[{Идентификатор:active.Идентификатор}];
    for(const file of doc.Вложение as SabyObject[]){if(nativePreparedEdits){file.СсылкаВКабинет=cabinetUrl(id);file.Редакция={Номер:'1'};}file.Направление='Исходящий';if(status.sender)file.Подпись=[{Сертификат:{Отпечаток:fp,ИНН:(doc.НашаОрганизация as SabyObject).СвЮЛ.ИНН},Файл:{Ссылка:`https://disk.saby.ru/${id}.sgn`}}];}
    if(t2.has(id))(doc.Вложение as SabyObject[]).push({Идентификатор:`${id}-carrier`,Подтип:'1110340',ВерсияФормата:'5.01',Направление:'Исходящий',Файл:{Имя:`${id}-carrier.xml`,Ссылка:`https://disk.saby.ru/${id}-carrier.xml`},...(status.carrier?{Подпись:[{Сертификат:{Отпечаток:fp,ИНН:(doc.НашаОрганизация as SabyObject).СвЮЛ.ИНН},Файл:{Ссылка:`https://disk.saby.ru/${id}.sgn`}}]}:{})});
    if(delayedCarrierTitle) for(const file of doc.Вложение as SabyObject[]) if(file.Подтип==='1110340') file.ВерсияФормата='';
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
    if(canonicalParties){doc.Стороны={Отправитель:doc.Грузоотправитель,Перевозчик:doc.ТранспортнаяКомпания,Получатель:doc.Грузополучатель};delete doc.Грузоотправитель;delete doc.ТранспортнаяКомпания;delete doc.Грузополучатель;}
    return doc;
  };
  const send:typeof fetch=async(url,init)=>{
    if(init?.method==='GET'){
      if(String(url).endsWith('.sgn'))return new Response(Buffer.from('synthetic'));
      const recipientId=String(url).split('/').at(-1)!.replace(/-recipient\.xml$/,'');
      if(t3.has(recipientId)&&String(url).endsWith('-recipient.xml'))return new Response(t3.get(recipientId));
      const id=String(url).split('/').at(-1)!.replace(/-carrier\.xml$/,'');if(t2.has(id)&&String(url).endsWith('-carrier.xml'))return new Response(t2.get(id));
      const senderId=String(url).split('/').at(-1)!.replace(/\.xml$/,'');if(t1.has(senderId))return new Response(t1.get(senderId));
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
      if(req.params.Документ.Идентификатор) assert.ok(api.docs.has(String(req.params.Документ.Идентификатор)), 'Existing native document must be confirmed before upload');
      else assert.equal(req.params.Документ.Номер, undefined, 'Only Saby assigns the new number');
      assert.ok(Array.isArray(req.params.Документ.Вложение) && req.params.Документ.Вложение.length === 1, 'Direct write requires exactly one complete T1');
      const response=await api.send(url,init);const body=await response.clone().json();let id=String(body.result.Идентификатор);
      if(autoUuid && !req.params.Документ.Идентификатор){const old=id;id=syntheticUuid(old);const created=api.docs.get(old)!;api.docs.delete(old);created.Идентификатор=id;api.docs.set(id,created);}
      assert.equal(req.params.Документ.Тип,'ConsignmentNote');
      if(nativePreparedEdits){const stored=api.docs.get(id)!;stored.Редакция=[{Идентификатор:syntheticUuid(id+'-revision'),Актуален:'Да'}];(stored.Вложение as SabyObject[])[0].Идентификатор=syntheticUuid(id+'-title');}
      if(req.params.Документ.Вложение){const file=(req.params.Документ.Вложение as SabyObject[])[0].Файл;t1.set(id,Buffer.from(String(file.ДвоичныеДанные),'base64'));}
      if(loss==='upload'){loss=null;throw new Error('synthetic accepted upload response loss');}
      if(loss==='http500'){loss=null;return new Response(JSON.stringify({jsonrpc:'2.0',id:req.id,error:{code:-32000,message:'Синтетическая ошибка после записи'}}),{status:500});}
      return json(document(id));
    }
    if(req.method==='СБИС.ПрочитатьДокумент')return json(document(String(req.params.Документ.Идентификатор)));
    if(req.method==='СБИС.ПодготовитьДействие'||req.method==='СБИС.ВыполнитьДействие'){
      const id=String(req.params.Документ.Идентификатор ?? [...api.docs].find(([,doc])=>(doc.Редакция as SabyObject[]).some(row=>row.Идентификатор===(req.params.Документ.Редакция as SabyObject).Идентификатор))?.[0]),action=req.params.Документ.Этап as SabyObject;const side=action.Название==='Отправка'?'sender':'carrier';
      if(side==='sender' && req.method==='СБИС.ПодготовитьДействие'){
        const bytes=t1.get(id)!;let xml=new TextDecoder('windows-1251').decode(bytes);
        if(!/УИД_ТрН=/.test(xml)){const uid=randomUUID();operatorUids.set(id,uid);xml=xml.replace('<СодИнфГО ',`<СодИнфГО УИД_ТрН="${uid}" `);}
        if(nativePreparedEdits){
          xml=xml.replace('СпосПерУкПА="По телефону"','СпосПерУкПА="Электронное уведомление перевозчика о переадресовке"');
          const date=/ДатИнфГО="(\d{2})\.(\d{2})\.(\d{4})"/.exec(xml)!, time=/ВрИнфГО="([\d:]+)"/.exec(xml)!;
          const url=`${cabinetUrl(id)}&date=${date[3]}${date[2]}${date[1]}${time[1].replaceAll(':','')}`.replaceAll('&','&amp;');
          xml=xml.replace('</СодИнфГО>',`<ИнфПол ИдФайлИнфПол="33333333-3333-4333-8333-333333333333"><ТекстИнф Идентиф="Документ.СсылкаНаВложение" Значение="${url}"/></ИнфПол></СодИнфГО>`);
        }
        t1.set(id,encodeWindows1251(xml));
      }
      if(side==='carrier'&&!t2.has(id)){
        const parsed=parseXml(t1.get(id)!);const content=parsed.children.find(row=>typeof row!=='string'&&row.name==='Документ')!;assert.notEqual(typeof content,'string');if(typeof content==='string')throw Error();
        const info=content.children.find(row=>typeof row!=='string'&&row.name==='СодИнфГО')!;if(typeof info==='string')throw Error();
        t2.set(id,Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Файл ИдФайл="ON_TRNACLPPRIN_SYNTHETIC_${id}" ВерсПрог="Saby" ВерсФорм="5.01"><Документ КНД="1110340" ПоФактХЖ="Транспортная накладная, информация перевозчика о приеме груза" ДатИнфПрвПрием="07.10.2026" ВрИнфПрвПрием="11:12:13"><ИдИнфГО ИдФайлИнфГО="${parsed.attributes.ИдФайл}" ДатФайлИнфГО="${content.attributes.ДатИнфГО}" ВрФайлИнфГО="${content.attributes.ВрИнфГО}" ЭП="c3ludGhldGlj"/><СодИнфПрвПрием УИД_ТрН="${info.attributes.УИД_ТрН}" СодОпер="${CONSIGNMENT_CARRIER_ACCEPTANCE}"/><Подписант СтатПодп="1"><ФИО Фамилия="НКПодписант" Имя="Тест"/></Подписант></Документ></Файл>`));
      }
      if(req.method==='СБИС.ВыполнитьДействие'){const status=signed.get(id)??{sender:false,carrier:false};status[side]=true;signed.set(id,status);if(loss==='execute'){loss=null;throw Error('synthetic accepted Execute loss');}}
      const result=document(id);if(req.method==='СБИС.ПодготовитьДействие')(result.Этап as SabyObject[])[0].Вложение=(result.Вложение as SabyObject[]).filter(row=>row.Подтип===(side==='sender'?'1110339':'1110340')).map(row=>({...row,ТребуемоеДействие:'Подписать'}));
      return json(result);
    }
    if(req.method==='СБИС.ЗаписатьВложение'){const revision=(req.params.Документ.Редакция as SabyObject).Идентификатор;const id=[...api.docs].find(([,doc])=>(doc.Редакция as SabyObject[]).some(row=>row.Идентификатор===revision))![0];const file=(req.params.Документ.Вложение as SabyObject[])[0].Файл;t2.set(id,Buffer.from(String(file.ДвоичныеДанные),'base64'));return json(document(id));}
    return api.send(url,init);
  };
  return {send,calls,docs:api.docs,t1,operatorUids,setDelayedCarrierTitle:(value:boolean)=>{delayedCarrierTitle=value;},uploads:()=>calls.filter(row=>row.method==='СБИС.ЗаписатьДокумент'),setLoss:(value:typeof loss)=>{loss=value;},setRecipient:(value:boolean)=>{recipient=value;},setFastAcceptance:()=>{fastAcceptance=true;},reserves:()=>api.reserves('ConsignmentNote'),executes:()=>calls.filter(row=>row.method==='СБИС.ВыполнитьДействие')};
}

/** Synthetic independent provider evidence, not a simulated successful empty-create RPC.
 * Each fixed number below belongs to a native document that existed before CRM resumed it.
 */
async function seedExistingNativeDocuments(f: Awaited<ReturnType<typeof fixture>>, api: ReturnType<typeof directApi>, options: { unknownId?: boolean; providerMissing?: boolean; firstOnly?: boolean; nativeIds?: string[] } = {}) {
  const before = await f.store.read(f.source), rows = before.etrn!.trips[f.tripId].direct!.deliveries;
  await f.store.mutate(f.source, data => {
    const saved = data.etrn!.trips[f.tripId];
    for (const [index, row] of rows.entries()) {
      if (options.firstOnly && index) continue;
      const id = options.nativeIds?.[index] ?? `native-existing-${index + 1}`, number = ['NATIVE-701', 'NATIVE-845'][index];
      const snapshot = structuredClone(row.snapshot), attemptId = randomUUID(), now = new Date().toISOString(), marker = `ARTEL-CRM:ETRN:synthetic-native-${index + 1}`;
      const payloadHash = createHash('sha256').update(JSON.stringify(snapshot)).digest('hex');
      const document: EtrnDocument = { id: options.unknownId ? null : id, number, revision: null, status: 'unknown', url: null, remoteStatus: null, lastError: null,
        updatedAt: now, createdAt: now, marker, attemptId, payloadHash, snapshot, artifacts: [], signatureStatus: 'unknown', gisStatus: null, availableActions: [], leaseId: null, leaseUntil: null, reservationAttempted: true, uploadAttempted: false };
      saved.deliveries[row.shipmentId] = { profile: snapshot.profile, snapshot, preparedHash: payloadHash, document, updatedAt: now };
      const full = buildSabyConsignmentDocument(snapshot, marker, attemptId, now, number, { senderTitleVersion: 2 });
      const { Вложение: _title, ...metadata } = full; void _title;
      if (!options.providerMissing) api.docs.set(id, { ...metadata, Идентификатор: id, Редакция: [{ Идентификатор: `${id}-revision`, Актуален: 'Да' }], Вложение: [], Состояние: { Код: '0' } });
    }
    return { changed: true, result: undefined };
  });
}

const directDigest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
for (const tamper of ['none', 'none-summary', 'mass', 'acceptance', 'extra-file', 'service-signable', 'service-error'] as const) test(`new direct regenerated T2 read reconciliation preserves intent and rejects ${tamper}`, async () => {
  const f = await fixture([false, true], false, false, undefined, false, false, true), api = directApi(true, true, true, true);
  let prepares = 0, replaced = false, damage = false;
  const replacement = randomUUID();
  const send: typeof fetch = async (url, init) => {
    const response = await api.send(url, init);
    if (init?.method === 'GET') {
      if (damage && tamper === 'acceptance' && String(url).endsWith('-carrier.xml')) return new Response((await response.text()).replace(CONSIGNMENT_CARRIER_ACCEPTANCE, 'Отказ от приема'));
      return response;
    }
    const req = JSON.parse(String(init?.body)) as IntegrationRpc;
    if (req.method === 'СБИС.ПодготовитьДействие' && (req.params.Документ.Этап as SabyObject).Название === 'Получение груза') { prepares++; if (prepares === 2) replaced = true; }
    if (replaced && ['СБИС.ПрочитатьДокумент','СБИС.ПодготовитьДействие','СБИС.ВыполнитьДействие'].includes(req.method)) {
      const result = await response.json();
      for (const row of (result.result.Вложение ?? []) as SabyObject[]) if (row.Подтип === '1110340') row.Идентификатор = replacement;
      result.result.Вложение.push({ Идентификатор: 'gis-service-receipt', Подтип: '', Служебный: 'Да', КоличествоОшибок: damage && tamper === 'service-error' ? '1' : '0', Файл: { Имя: damage && tamper === 'extra-file' ? 'another-document.xml' : 'Ответ от ГИС ЭПД.xml' }, ...(damage && tamper === 'service-signable' ? { ТребуемоеДействие: 'Подписать' } : {}) });
      for (const stage of (result.result.Этап ?? []) as SabyObject[]) for (const row of (stage.Вложение ?? []) as SabyObject[]) if (row.Подтип === '1110340') row.Идентификатор = replacement;
      if (tamper === 'none-summary' && result.result.Состояние.Код === '7') {
        result.result.Этап = []; result.result.ТекущиеЭтапы = [{ Идентификатор: 'recipient-stage', Наименование: 'Приемка груза' }];
        result.result.Контрагент = result.result.Стороны.Получатель;
      }
      return new Response(JSON.stringify(result));
    }
    return response;
  };
  try {
    await f.start(); await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, send) });
    const before = await f.store.read(f.source), trip = before.etrn!.trips[f.tripId], sid = f.trip.customers[0].id;
    const old = trip.deliveries[sid].document!, binding = structuredClone(old.dispatch!.carrier.binding);
    assert.ok(binding); assert.equal(old.dispatch!.sender.state, 'confirmed');
    assert.equal(old.dispatch!.carrier.prepared, undefined); assert.equal(old.dispatch!.carrier.executeAttempted, undefined); assert.equal(prepares, 2);
    const writes = () => api.calls.filter(x => ['СБИС.ПодготовитьДействие','СБИС.ВыполнитьДействие','СБИС.ЗаписатьДокумент','СБИС.ЗаписатьВложение'].includes(x.method)).length;
    const previousWrites = writes(); damage = true;
    if (tamper === 'mass') api.t1.set(old.id!, encodeWindows1251(new TextDecoder('windows-1251').decode(api.t1.get(old.id!)!).replace('МасБрутОтгр="6745"','МасБрутОтгр="6746"')));
    await runNkDirectEtrn({ ...f, store: new OperationsStore(f.directory + '/store'), client: new SabyClient(f.config, send) });
    const after = await f.store.read(f.source), current = after.etrn!.trips[f.tripId].deliveries[sid].document!;
    assert.deepEqual(current.snapshot, old.snapshot); assert.deepEqual(after.etrn!.trips[f.tripId].direct!.authorization, trip.direct!.authorization);
    assert.deepEqual(current.dispatch!.sender.prepared, old.dispatch!.sender.prepared); assert.equal(prepares, 2);
    if (tamper === 'none' || tamper === 'none-summary') {
      assert.ok(nkDirectEtrnCompleted(after,f.tripId), JSON.stringify(current.dispatch));
      assert.deepEqual(current.dispatch!.carrierReconciliation!.previousBinding, binding);
      assert.equal(current.dispatch!.carrier.binding!.attachmentId, replacement);
      assert.equal(api.executes().length, 2);
      await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, send) });
      assert.equal(api.executes().length, 2); assert.equal(prepares, 2);
    } else {
      assert.equal(current.dispatch!.carrier.prepared, undefined); assert.equal(current.dispatch!.carrier.executeAttempted, undefined);
      assert.deepEqual(current.dispatch!.carrier.binding, binding); assert.equal(writes(),previousWrites);
    }
  } finally { await f.close(); }
});
async function nativeAmendmentFixture() {
  const f = await fixture([false, false], false, false, 'По телефону'), api = directApi(true, true);
  await f.start(); await seedExistingNativeDocuments(f, api, {nativeIds:[syntheticUuid('independent-native-2'),syntheticUuid('independent-native-3')]});
  for (const row of (await f.store.read(f.source)).etrn!.trips[f.tripId].direct!.deliveries) {
    const result = await exchangePreparedEtrn({ ...f, client: new SabyClient(f.config, api.send).forNkDirectEtrn() }, { documentMode: 'nk-direct-v1', ...row });
    assert.equal(result.status, 'draft');
  }
  await f.store.mutate(f.source, data => {
    const trip = data.etrn!.trips[f.tripId];
    for (const row of trip.direct!.deliveries) {
      const doc = trip.deliveries[row.shipmentId].document!, at = new Date().toISOString();
      const xmlSha256 = createHash('sha256').update(api.t1.get(doc.id!)!).digest('hex');
      doc.nativeAdoptionEvidence = {
        version: 'native-ui-adoption-v1', origin: 'independently_created_native_ui', nativeDocumentId: doc.id!, nativeNumber: doc.number!, nativeRevision: doc.revision!, nativeAttachmentId: syntheticUuid(doc.id+'-title'),
        nativeXmlSha256: xmlSha256, nativeReadSha256: directDigest(api.docs.get(doc.id!)), uiEvidenceSha256: directDigest('synthetic independent UI evidence'), planSha256: directDigest('synthetic reviewed native adoption plan'), sourceSnapshotSha256: doc.payloadHash,
        originalAttemptId: doc.attemptId, originalMarker: doc.marker, originalDocumentSha256: directDigest(doc), originalReservationAttempted: true, originalReservationOutcome: 'unknown', originalWriteAttemptsCount: doc.writeAttempts!.length, originalWriteAttemptsSha256: directDigest(doc.writeAttempts),
        actorId: 'actor', adoptedAt: at, stage: 'verified', holdForReview: false,
        verified: { at, revision: doc.revision!, attachmentId: syntheticUuid(doc.id+'-title'), xmlSha256, remoteSha256: directDigest(api.docs.get(doc.id!)) },
      };
    }
    return { changed: true, result: undefined };
  });
  await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
  const failed = await f.store.read(f.source), first = failed.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
  assert.equal(first.dispatch!.sender.state, 'blocked'); assert.ok(first.dispatch!.sender.prepared); assert.equal(first.dispatch!.sender.verified, undefined); assert.equal(first.dispatch!.sender.executeAttempted, undefined);
  assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 1); assert.equal(api.executes().length, 0);
  return { f, api, failed };
}
async function approveNativeSenderMethods(f: Awaited<ReturnType<typeof fixture>>) {
  await f.store.mutate(f.source, data => {
    const trip = data.etrn!.trips[f.tripId], direct = trip.direct!;
    for (const row of direct.deliveries) {
      const doc = trip.deliveries[row.shipmentId].document!, prepared = doc.dispatch?.sender.prepared;
      const sourceFile = prepared?.attachments.find(file => file.subtype === '1110339');
      doc.nativeSenderAmendment = {
        version: 'native-redirection-approval-v1', tripId: f.tripId, documentId: doc.id!, documentNumber: doc.number!, documentRevision: doc.revision!, attachmentId: syntheticUuid(doc.id+'-title'), payloadHash: doc.payloadHash,
        directAttemptId: direct.attemptId, authorizationSha256: directDigest(direct.authorization), originalPreparedHash: prepared?.preparedHash ?? null,
        sourceXmlSha256: sourceFile?.sha256 ?? doc.nativeAdoptionEvidence!.verified!.xmlSha256, beforeMethod: 'По телефону', afterMethod: 'Электронное уведомление перевозчика о переадресовке',
        source: 'explicit_user_instruction', answerText: 'Принять электронное уведомление Saby', approvalReference: 'synthetic-explicit-user-answer-reference', recordedAt: new Date().toISOString(), approvalTextSha256: createHash('sha256').update('Принять электронное уведомление Saby').digest('hex'),
      };
    }
    return { changed: true, result: undefined };
  });
}

test('explicit native amendment revalidates the exact existing manifest without Prepare and preserves both grants and histories', async () => {
  const { f, api, failed } = await nativeAmendmentFixture();
  try {
    const firstId = f.trip.customers[0].id, original = failed.etrn!.trips[f.tripId], manifest = original.deliveries[firstId].document!.dispatch!.sender.prepared!;
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 1); assert.equal(api.executes().length, 0);
    await approveNativeSenderMethods(f);
    const approved = await f.store.read(f.source), store = new OperationsStore(f.directory + '/store');
    await runNkDirectEtrn({ ...f, store, client: new SabyClient(f.config, api.send) });
    const after = await store.read(f.source), trip = after.etrn!.trips[f.tripId];
    assert.ok(nkDirectEtrnCompleted(after, f.tripId), JSON.stringify(trip.direct));
    assert.deepEqual(trip.direct!.authorization, original.direct!.authorization); assert.deepEqual(trip.direct!.deliveries, original.direct!.deliveries); assert.equal(trip.direct!.attemptId, original.direct!.attemptId);
    assert.deepEqual(trip.deliveries[firstId].document!.dispatch!.sender.prepared, manifest);
    for (const row of trip.direct!.deliveries) {
      const doc = trip.deliveries[row.shipmentId].document!, old = original.deliveries[row.shipmentId].document!;
      assert.deepEqual(doc.snapshot, old.snapshot); assert.equal(doc.attemptId, old.attemptId); assert.equal(doc.marker, old.marker); assert.deepEqual(doc.writeAttempts, old.writeAttempts); assert.deepEqual(doc.nativeAdoptionEvidence, old.nativeAdoptionEvidence);
      assert.deepEqual(doc.nativeSenderAmendment, approved.etrn!.trips[f.tripId].deliveries[row.shipmentId].document!.nativeSenderAmendment);
      assert.equal(doc.dispatch!.operatorUid, api.operatorUids.get(doc.id!)); assert.equal(doc.dispatch!.sender.verified, true);
    }
    assert.equal(api.reserves().length, 0); assert.equal(api.uploads().length, 2); assert.equal(api.executes().length, 4);
    const prepares = api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие'); assert.equal(prepares.length, 6);
    assert.equal(prepares.filter(row => (row.params.Документ.Этап as SabyObject).Название === 'Отправка').length, 2);
    await runNkDirectEtrn({ ...f, store, client: new SabyClient(f.config, api.send) });
    assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 6); assert.equal(api.executes().length, 4);
  } finally { await f.close(); }
});

test('lost Execute response after approved native manifest recovery never repeats Prepare or the attempted Execute', async () => {
  const { f, api, failed } = await nativeAmendmentFixture();
  try {
    await approveNativeSenderMethods(f); api.setLoss('execute');
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    const firstId = f.trip.customers[0].id, interrupted = (await f.store.read(f.source)).etrn!.trips[f.tripId].deliveries[firstId].document!;
    assert.equal(api.executes().length, 1); assert.equal(interrupted.dispatch!.sender.executeAttempted, true); assert.equal(interrupted.dispatch!.sender.dispatchState, 'attempted');
    assert.deepEqual(interrupted.dispatch!.sender.prepared, failed.etrn!.trips[f.tripId].deliveries[firstId].document!.dispatch!.sender.prepared);
    const store = new OperationsStore(f.directory + '/store');
    await runNkDirectEtrn({ ...f, store, client: new SabyClient(f.config, api.send) });
    assert.ok(nkDirectEtrnCompleted(await store.read(f.source), f.tripId)); assert.equal(api.executes().length, 4);
    const revision = interrupted.dispatch!.sender.binding!.revision;
    assert.equal(api.executes().filter(row => (row.params.Документ.Редакция as SabyObject).Идентификатор === revision && (row.params.Документ.Этап as SabyObject).Название === 'Отправка').length, 1);
    assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 6); assert.equal(api.uploads().length, 2); assert.equal(api.reserves().length, 0);
  } finally { await f.close(); }
});

for (const failure of ['file', 'stage', 'certificate', 'actor', 'facts', 'approval-race', 'execute-attempted'] as const) test(`native prepared recovery refuses ${failure} without new Prepare or Execute`, async () => {
  const { f, api } = await nativeAmendmentFixture();
  try {
    await approveNativeSenderMethods(f);
    const before = await f.store.read(f.source), firstId = f.trip.customers[0].id, original = before.etrn!.trips[f.tripId].deliveries[firstId].document!;
    if (failure === 'file') api.t1.set(original.id!, encodeWindows1251(new TextDecoder('windows-1251').decode(api.t1.get(original.id!)!).replace('МасБрутОтгр="6745"', 'МасБрутОтгр="6746"')));
    if (failure === 'actor' || failure === 'facts' || failure === 'execute-attempted') await f.store.mutate(f.source, data => {
      if (failure === 'actor') { data.accounts!.users.push({ ...data.accounts!.users[0], id: 'other-owner', login: 'other-owner' }); data.accounts!.users.find(row => row.id === 'actor')!.active = false; }
      if (failure === 'facts') data.etrn!.trips[f.tripId].loadingFacts!.deliveries[firstId].grossMassTonnes = '6.746';
      if (failure === 'execute-attempted') {
        const dispatch = data.etrn!.trips[f.tripId].deliveries[firstId].document!.dispatch!;
        dispatch.operatorUid = api.operatorUids.get(original.id!)!;
        Object.assign(dispatch.sender, { state: 'unknown', verified: true, executeAttempted: true, dispatchState: 'attempted' });
      }
      return { changed: true, result: undefined };
    });
    let raced = false;
    const send: typeof fetch = async (url, init) => {
      const response = await api.send(url, init);
      if (init?.method === 'GET') return response;
      const req = JSON.parse(String(init?.body)) as IntegrationRpc;
      if (failure === 'certificate' && req.method === 'sabyCertificate.List') return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: [] }));
      if (failure === 'stage' && req.method === 'СБИС.ПрочитатьДокумент') { const body = await response.json(); body.result.Состояние = { Код: '23' }; return new Response(JSON.stringify(body)); }
      if (failure === 'approval-race' && !raced && req.method === 'sabyCertificate.Read') {
        raced = true; await f.store.mutate(f.source, data => { data.etrn!.trips[f.tripId].deliveries[firstId].document!.nativeSenderAmendment!.approvalReference = 'synthetic-different-instruction-reference'; return { changed: true, result: undefined }; });
      }
      return response;
    };
    if (failure === 'actor' || failure === 'facts') await assert.rejects(runNkDirectEtrn({ ...f, client: new SabyClient(f.config, send) }), ApiError);
    else await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, send) });
    const after = await f.store.read(f.source), doc = after.etrn!.trips[f.tripId].deliveries[firstId].document!;
    assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 1); assert.equal(api.executes().length, 0); assert.equal(api.uploads().length, 2);
    assert.deepEqual(doc.dispatch!.sender.prepared, original.dispatch!.sender.prepared); assert.deepEqual(doc.writeAttempts, original.writeAttempts);
    assert.equal(doc.dispatch!.sender.executeAttempted, failure === 'execute-attempted' ? true : undefined);
    assert.equal(after.etrn!.trips[f.tripId].deliveries[f.trip.customers[1].id].document!.dispatch, undefined);
    if (failure === 'approval-race') assert.equal(raced, true);
  } finally { await f.close(); }
});

for(const skips of [[false,false],[false,true],[true,false]])test(`existing native NK documents preserve each mass and filters only etrn flag ${skips}`,async()=>{
  const f=await fixture(skips),api=directApi();try{
    const before=await f.store.read(f.source);await f.start();const saved=await f.store.read(f.source);
    assert.deepEqual(saved.shipments,before.shipments);assert.deepEqual(saved.driverTripProgress,before.driverTripProgress);assert.deepEqual(saved.etrn!.trips[f.tripId].loadingFacts,before.etrn!.trips[f.tripId].loadingFacts);
    assert.equal(saved.tripSaby?.trips[f.tripId],undefined);assert.deepEqual(saved.etrn!.trips[f.tripId].direct!.authorization.grantedRoles,['sender','carrier']);
    await seedExistingNativeDocuments(f,api);const run=()=>runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)});await run();
    const final=await f.store.read(f.source),projection=await f.preview();assert.ok(nkDirectEtrnCompleted(final,f.tripId),JSON.stringify(projection));
    assert.equal(api.reserves().length,0);assert.equal(api.uploads().length,skips.filter(v=>!v).length);assert.equal(api.executes().length,2*skips.filter(v=>!v).length);
    const rows=final.etrn!.trips[f.tripId].direct!.deliveries;assert.deepEqual(rows.map(row=>row.snapshot.profile.loading.grossMassTonnes),['6.745','7.985'].filter((_,i)=>!skips[i]));
    assert.ok(rows.every(row=>row.snapshot.customerOrganization.inn===f.config.carrier.inn&&row.snapshot.carrierOrganization.inn===f.config.carrier.inn));
    for (const row of rows) {
      const doc = final.etrn!.trips[f.tripId].deliveries[row.shipmentId].document!;
      const request = api.uploads().find(call => call.params.Документ.Идентификатор === doc.id)!;
      const file = (request.params.Документ.Вложение as SabyObject[])[0].Файл as SabyObject;
      const xml = new TextDecoder('windows-1251').decode(Buffer.from(String(file.ДвоичныеДанные), 'base64'));
      const second = row.snapshot.fields.quantity_litres === '9500';
      assert.match(xml, new RegExp(`МасБрутОтгр="${second ? '7985' : '6745'}"`));
      assert.match(xml, new RegExp(`Объем="${second ? '9.5' : '8'}"`));
      assert.doesNotMatch(xml, /УИД_ТрН=/); assert.match(xml, new RegExp(`НомерТрН="${doc.number}"`));
      assert.deepEqual(request.params.Документ.Адресация, { Идентификатор: doc.id, Редакция: { Идентификатор: `${doc.id}-revision` } });
      assert.equal(doc.senderTitleVersion, 2); assert.equal(doc.dispatch!.operatorUid, api.operatorUids.get(doc.id!));
      assert.equal(doc.writeAttempts!.length, 1); assert.equal(doc.writeAttempts![0].outcome, 'received');
      assert.equal(doc.writeAttempts![0].request.bodySha256, createHash('sha256').update(JSON.stringify(request)).digest('hex'));
      assert.equal(doc.writeAttempts![0].result!.id, doc.id);
    }

    const writes=api.executes().length;await run();assert.equal(api.executes().length,writes);assert.equal((await f.preview()).order,null);
  }finally{await f.close();}
});

test('all excluded deliveries create no direct intent despite independent invoice flags',async()=>{const f=await fixture([true,true]);try{const p=await f.preview();assert.equal(p.notRequired,true);assert.equal(p.start,undefined);await assert.rejects(f.start(),ApiError);assert.equal((await f.store.read(f.source)).etrn!.trips[f.tripId].direct,undefined);}finally{await f.close();}});

test('existing supply-delivery facts become eligible only after fresh explicit direct authorization',async()=>{const f=await fixture([false,false],true);try{const p=await f.preview();assert.ok(p.start,p.blockers.join(' '));const api=directApi();assert.deepEqual(await dispatchTripSaby({...f,enabled:true,send:api.send}),{continued:0,refreshed:0,denied:0,failed:0});assert.equal(api.calls.length,0);await f.start();await assert.rejects(f.start(),ApiError);assert.ok((await f.store.read(f.source)).etrn!.trips[f.tripId].direct);}finally{await f.close();}});

for(const mutation of ['policy','mass','version','actor'] as const)test(`direct authority rejects changed ${mutation} before provider calls`,async()=>{const f=await fixture();try{await f.start();if(mutation==='policy')f.config.automaticSigning!.carrier.thumbprint='ef'.repeat(20);else await f.store.mutate(f.source,data=>{if(mutation==='actor'){ data.accounts!.users.push({ ...data.accounts!.users[0], id: 'other-actor', login: 'other-actor' }); data.accounts!.users.find(row=>row.id==='actor')!.active=false; }else if(mutation==='mass')data.etrn!.trips[f.tripId].loadingFacts!.deliveries[f.trip.customers[0].id].grossMassTonnes='8';else data.shipments[f.trip.customers[0].id].version++;return {result:null,changed:true};});const api=directApi();await assert.rejects(runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)}),ApiError);assert.equal(api.calls.length,0);}finally{await f.close();}});

test('canonical native parties resume a saved pre-Prepare blocker through normal polling without replacing the grant or history', async () => {
  const f = await fixture(), api = directApi(true);
  try {
    await f.start(); await seedExistingNativeDocuments(f, api);
    const initial = await f.store.read(f.source), selected = initial.etrn!.trips[f.tripId].direct!.deliveries[0];
    const uploaded = await exchangePreparedEtrn({ ...f, client: new SabyClient(f.config, api.send).forNkDirectEtrn() }, { documentMode: 'nk-direct-v1', ...selected });
    assert.equal(uploaded.status, 'draft');
    // Reproduce the persisted pre-fix state: no signing intent was ever saved.
    // All subsequent transitions use normal runNkDirectEtrn; no recovery mutation.
    await f.store.mutate(f.source, data => {
      const record = data.etrn!.trips[f.tripId];
      record.direct!.phase = 'sending_etrn';
      record.deliveries[selected.shipmentId].document!.dispatch = { version: 1, sender: { state: 'blocked' }, carrier: { state: 'not_started' }, lastError: 'Заявка, её редакция или участники изменились. Подписание остановлено.' };
      return { changed: true, result: undefined };
    });
    const before = await f.store.read(f.source), original = before.etrn!.trips[f.tripId];
    const originalDocument = original.deliveries[selected.shipmentId].document!;
    assert.deepEqual(originalDocument.dispatch!.sender, { state: 'blocked' });
    assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 0);
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    const reconciled = await f.store.read(f.source);
    assert.deepEqual(reconciled.etrn!.trips[f.tripId].deliveries[selected.shipmentId].document!.dispatch!.sender, { state: 'unknown' });
    assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 0);
    assert.equal(api.executes().length, 0);
    assert.equal(api.uploads().length, 1);
    const store = new OperationsStore(f.directory + '/store');
    await runNkDirectEtrn({ ...f, store, client: new SabyClient(f.config, api.send) });
    const after = await store.read(f.source), final = after.etrn!.trips[f.tripId];
    assert.ok(nkDirectEtrnCompleted(after, f.tripId), JSON.stringify(final.direct));
    assert.deepEqual(final.direct!.authorization, original.direct!.authorization);
    assert.equal(final.direct!.attemptId, original.direct!.attemptId);
    assert.deepEqual(final.direct!.deliveries, original.direct!.deliveries);
    assert.deepEqual(after.shipments, before.shipments);
    assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
    assert.deepEqual(final.loadingFacts, original.loadingFacts);
    assert.equal(after.tripSaby?.trips[f.tripId], undefined);
    assert.equal(api.reserves().length, 0);
    assert.equal(api.uploads().length, 2);
    assert.equal(api.executes().length, 4);
    for (const row of final.direct!.deliveries) {
      const doc = final.deliveries[row.shipmentId].document!, old = original.deliveries[row.shipmentId].document!;
      assert.equal(doc.id, old.id); assert.equal(doc.attemptId, old.attemptId); assert.equal(doc.marker, old.marker);
      assert.deepEqual(doc.writeAttempts?.slice(0, old.writeAttempts?.length ?? 0) ?? [], old.writeAttempts ?? []);
      assert.equal(doc.dispatch!.sender.state, 'confirmed'); assert.equal(doc.dispatch!.carrier.state, 'confirmed');
      assert.equal(doc.dispatch!.sender.binding!.documentType, 'ConsignmentNote');
    }
    const prepares = api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие');
    // One T1 Prepare and one T2 generation + final T2 Prepare per delivery.
    assert.equal(prepares.length, 6);
    await runNkDirectEtrn({ ...f, store, client: new SabyClient(f.config, api.send) });
    assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 6);
    assert.equal(api.executes().length, 4); assert.equal(api.uploads().length, 2);
  } finally { await f.close(); }
});

for (const loss of ['upload', 'http500', 'execute'] as const) test(`restart reconciles uncertain direct ${loss} without duplicate writes`, async () => {
  const f = await fixture([false, true]), api = directApi();
  try {
    await f.start(); await seedExistingNativeDocuments(f, api); api.setLoss(loss);
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    const attempted = (await f.store.read(f.source)).etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
    assert.equal(attempted.uploadAttempted, true); assert.equal(attempted.writeAttempts!.length, 1);
    const audit = attempted.writeAttempts![0];
    assert.equal(audit.outcome, loss === 'execute' ? 'received' : 'uncertain');
    if (loss === 'http500') { assert.equal(audit.response!.httpStatus, 500); assert.equal(audit.response!.rpcCode, -32000); assert.equal(audit.response!.rpcIdMatches, true); assert.equal(audit.response!.message, 'Синтетическая ошибка после записи'); }
    if (loss === 'upload') assert.equal(audit.response, undefined);
    const store = new OperationsStore(f.directory + '/store');
    await runNkDirectEtrn({ ...f, store, client: new SabyClient(f.config, api.send) });
    const data = await store.read(f.source);
    assert.ok(nkDirectEtrnCompleted(data, f.tripId), JSON.stringify(data.etrn!.trips[f.tripId].direct));
    assert.equal(api.reserves().length, 0); assert.equal(api.uploads().length, 1); assert.equal(api.executes().length, 2);
    assert.deepEqual(data.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!.writeAttempts![0], audit);
  } finally { await f.close(); }
});

async function persistPreRoundingGrant(f: Awaited<ReturnType<typeof fixture>>) {
  // Reproduce the pre-rounding snapshot and source-hash format, then persist it.
  // Neither the grant nor its snapshots may be migrated during reconciliation.
  await f.store.mutate(f.source, data => {
      const record = data.etrn!.trips[f.tripId].direct!;
      for (const row of record.deliveries) delete row.snapshot.volumeRoundingVersion;
      const trip = getShipmentTrip(currentSnapshot(f.base, data), f.tripId);
      record.authorization.sourceHash = createHash('sha256').update(JSON.stringify([
        f.base.provenance.sourceSha256, trip.id, trip.fields,
        trip.customers.map(row => [row.id, row.version, row.fields]), record.deliveries,
      ])).digest('hex');
      return { changed: true, result: undefined };
  });
}

for (const automatic of [false, true]) test(`persisted pre-rounding direct grant survives restart and unknown reserve (${automatic ? 'automatic' : 'explicit'})`, async () => {
  const f = await fixture([false, true], false, automatic), api = directApi();
  try {
    if (!automatic) await f.start();
    await persistPreRoundingGrant(f);
    const before = (await f.store.read(f.source)).etrn!.trips[f.tripId].direct!;
    const store = new OperationsStore(f.directory + '/store');
    const persisted = await store.read(f.source);
    assert.deepEqual(authorizeNkDirectEtrn(f.base, persisted, f.tripId, f.config), before);
    const changed = structuredClone(persisted);
    changed.shipments[f.trip.customers[0].id].fields.quantity_litres = '8001';
    assert.throws(() => authorizeNkDirectEtrn(f.base, changed, f.tripId, f.config), ApiError);
    await seedExistingNativeDocuments(f, api, { unknownId: true });
    await runNkDirectEtrn({ ...f, store, client: new SabyClient(f.config, api.send) });
    await runNkDirectEtrn({ ...f, store: new OperationsStore(f.directory + '/store'), client: new SabyClient(f.config, api.send) });
    const after = await store.read(f.source), record = after.etrn!.trips[f.tripId].direct!;
    assert.ok(nkDirectEtrnCompleted(after, f.tripId), record.lastError ?? '');
    assert.equal(api.reserves().length, 0); assert.equal(api.uploads().length, 1);
    assert.deepEqual(record.authorization, before.authorization);
    assert.deepEqual(record.deliveries, before.deliveries);
    assert.equal(after.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!.snapshot.volumeRoundingVersion, undefined);
  } finally { await f.close(); }
});

test('client dispatch is distinct from signatures; a different recipient cannot complete the driver task',async()=>{const f=await fixture([false,true]),api=directApi();try{await f.start();await seedExistingNativeDocuments(f,api);api.setRecipient(false);await runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)});assert.equal(nkDirectEtrnCompleted(await f.store.read(f.source),f.tripId),false);assert.equal(api.executes().length,2);api.setRecipient(true);await runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)});assert.equal(nkDirectEtrnCompleted(await f.store.read(f.source),f.tripId),true);assert.equal(api.executes().length,2);}finally{await f.close();}});

test('direct input cannot bypass selected delivery snapshots or explicit authorization',async()=>{const f=await fixture([false,true]),api=directApi();try{await f.start();const data=await f.store.read(f.source),row=data.etrn!.trips[f.tripId].direct!.deliveries[0];row.snapshot.profile.loading.grossMassTonnes='8';await assert.rejects(exchangePreparedEtrn({...f,client:new SabyClient(f.config,api.send).forNkDirectEtrn()},{documentMode:'nk-direct-v1',...row}),ApiError);assert.equal(api.calls.length,0);authorizeNkDirectEtrn(f.base,await f.store.read(f.source),f.tripId,f.config);}finally{await f.close();}});

test('fast signed T3 proves recipient handoff without automatic T4',async()=>{const f=await fixture([false,true]),api=directApi();try{await f.start();await seedExistingNativeDocuments(f,api);api.setFastAcceptance();await runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)});const data=await f.store.read(f.source);assert.ok(nkDirectEtrnCompleted(data,f.tripId),JSON.stringify((await f.preview()).deliveries));assert.ok(Object.values(data.etrn!.trips[f.tripId].deliveries)[0].document!.dispatch!.recipientAcceptedAt);assert.equal(api.executes().length,2);}finally{await f.close();}});

test('stale preview cannot grant direct roles after a changed policy',async()=>{const f=await fixture();try{const token=(await f.preview()).start!.previewToken;f.config.automaticSigning!.approvedAt='2026-01-02T00:00:00Z';await assert.rejects(f.start(token),ApiError);assert.equal((await f.store.read(f.source)).etrn!.trips[f.tripId].direct,undefined);}finally{await f.close();}});

test('persisted pre-rounding unresolved reservation without a provider document never repeats creation', async () => {
  const f = await fixture([false, true], false, true), api = directApi();
  let attempted = 0;
  try {
    await persistPreRoundingGrant(f);
    await seedExistingNativeDocuments(f, api, { unknownId: true, providerMissing: true, firstOnly: true });
    const before = (await f.store.read(f.source)).etrn!.trips[f.tripId].direct!;
    const send: typeof fetch = async (url, init) => {
      if (init?.method !== 'GET') {
        const req = JSON.parse(String(init?.body)) as IntegrationRpc;
        if (req.method === 'СБИС.ЗаписатьДокумент' && !req.params.Документ.Идентификатор) {
          attempted++; throw Error('synthetic unknown reservation');
        }
      }
      return api.send(url, init);
    };
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, send) });
    const first = (await f.store.read(f.source)).etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
    await runNkDirectEtrn({ ...f, store: new OperationsStore(f.directory + '/store'), client: new SabyClient(f.config, send) });
    const after = (await f.store.read(f.source)).etrn!.trips[f.tripId], doc = after.deliveries[f.trip.customers[0].id].document!;
    assert.equal(attempted, 0); assert.equal(api.docs.size, 0); assert.equal(api.executes().length, 0);
    assert.equal((await f.preview()).phase, 'unknown');
    assert.equal(doc.status, 'unknown'); assert.equal(doc.id, null);
    assert.equal(doc.reservationAttempted, true); assert.equal(doc.uploadAttempted, false);
    assert.deepEqual(after.direct!.authorization, before.authorization);
    assert.deepEqual(after.direct!.deliveries, before.deliveries);
    assert.equal(after.direct!.attemptId, before.attemptId);
    assert.equal(doc.attemptId, first.attemptId); assert.equal(doc.marker, first.marker);
    assert.equal(doc.payloadHash, first.payloadHash); assert.deepEqual(doc.snapshot, first.snapshot);
    assert.equal(doc.snapshot.volumeRoundingVersion, undefined);
  } finally { await f.close(); }
});

test('revoked rights after existing-document upload preserve its receipt and stop further requests',async()=>{const f=await fixture([false,true]),api=directApi();try{await f.start();await seedExistingNativeDocuments(f,api);let revoked=false;const send:typeof fetch=async(url,init)=>{const result=await api.send(url,init);if(init?.method!=='GET'){const req=JSON.parse(String(init?.body)) as IntegrationRpc;if(!revoked&&req.method==='СБИС.ЗаписатьДокумент'){revoked=true;await f.store.mutate(f.source,data=>{data.accounts!.users.push({...data.accounts!.users[0],id:'other-owner',login:'other-owner'});data.accounts!.users.find(row=>row.id==='actor')!.active=false;return {changed:true,result:undefined};});}}return result;};await assert.rejects(runNkDirectEtrn({...f,client:new SabyClient(f.config,send)}),ApiError);assert.equal(api.calls.filter(row=>row.method==='СБИС.ЗаписатьДокумент').length,1);assert.equal(api.executes().length,0);const doc=(await f.store.read(f.source)).etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;assert.equal(doc.writeAttempts?.[0].outcome,'received');assert.equal(doc.writeAttempts?.[0].result?.id,'native-existing-1');assert.equal(doc.uploadAttempted,true);assert.equal(doc.status,'unknown');}finally{await f.close();}});

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
      await seedExistingNativeDocuments(f, api);
      const store = new OperationsStore(f.directory + '/store');
      await dispatchTripSaby({ ...f, store, enabled: true, send: api.send });
      assert.ok(nkDirectEtrnCompleted(await store.read(f.source), f.tripId));
      assert.equal(api.reserves().length, 0); assert.equal(api.uploads().length, skips.filter(value => !value).length);
      assert.equal(api.executes().length, 2 * skips.filter(value => !value).length);
      assert.ok(api.calls.filter(row => row.method === 'СБИС.ЗаписатьДокумент').every(row => row.params.Документ.Тип === 'ConsignmentNote'));
    }
    const after = await f.store.read(f.source);
    assert.deepEqual(after.shipments, before.shipments);
    assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
  } finally { await f.close(); }
});

for (const loss of ['upload', 'http500', 'execute'] as const) test(`automatic intent survives concurrent workers and unknown ${loss} without repeated writes`, async () => {
  const f = await fixture([false, true], false, true), api = directApi();
  try {
    await seedExistingNativeDocuments(f, api);
    api.setLoss(loss);
    const run = (store = f.store) => runNkDirectEtrn({ ...f, store, client: new SabyClient(f.config, api.send) });
    const concurrent = await Promise.allSettled([run(), run(new OperationsStore(f.directory + '/store'))]);
    assert.ok(concurrent.some(result => result.status === 'fulfilled'));
    for (const result of concurrent) if (result.status === 'rejected') assert.ok(result.reason instanceof ApiError && result.reason.status === 409);
    await run(new OperationsStore(f.directory + '/store'));
    assert.ok(nkDirectEtrnCompleted(await f.store.read(f.source), f.tripId));
    assert.equal(api.reserves().length, 0); assert.equal(api.uploads().length, 1); assert.equal(api.executes().length, 2);
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
    assert.equal(nkDirectEtrnCompleted(await f.store.read(f.source), NK_DIRECT_EXISTING_TRIP), true);
    assert.equal(api.reserves().length, 2);
    assert.equal((await f.store.read(f.source)).etrn!.trips[NK_DIRECT_EXISTING_TRIP].direct!.lastError, null);
  } finally { await f.close(); }
});


for (const automatic of [false, true]) test(`fresh direct intent creates full drafts and adopts provider numbers without empty reservation (${automatic})`, async () => {
  const f = await fixture([false, false], false, automatic), api = directApi();
  try {
    if (!automatic) await f.start();
    const before = await f.store.read(f.source), grant = before.etrn!.trips[f.tripId].direct!;
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    await runNkDirectEtrn({ ...f, store: new OperationsStore(f.directory + '/store'), client: new SabyClient(f.config, api.send) });
    const after = await f.store.read(f.source), saved = after.etrn!.trips[f.tripId], doc = saved.deliveries[grant.deliveries[0].shipmentId].document!;
    assert.equal(api.docs.size, 2); assert.equal(doc.lastError, null);
    assert.ok(doc.id); assert.equal(doc.reservationAttempted, true); assert.equal(doc.uploadAttempted, true);
    assert.equal(doc.directDraftCreation?.version, 'auto-number-v1');
    assert.equal(api.reserves().length, 2);
    for (const call of api.reserves()) {
      assert.equal(call.params.Документ.Номер, undefined);
      assert.equal((call.params.Документ.Вложение as SabyObject[]).length, 1);
      assert.match(String((call.params.Документ.Вложение as SabyObject[])[0].Файл.Имя), /\.xml$/);
      const xml = new TextDecoder('windows-1251').decode(Buffer.from(String((call.params.Документ.Вложение as SabyObject[])[0].Файл.ДвоичныеДанные), 'base64'));
      assert.doesNotMatch(xml, /НомерТрН=|УИД_ТрН=|CRM-/);
    }
    assert.ok(saved.deliveries[grant.deliveries[1].shipmentId]);
    assert.deepEqual(saved.direct!.authorization, grant.authorization); assert.deepEqual(saved.direct!.deliveries, grant.deliveries);
    assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.driverTripProgress, before.driverTripProgress); assert.deepEqual(saved.loadingFacts, before.etrn!.trips[f.tripId].loadingFacts);
    assert.deepEqual(saved.directAutostart, before.etrn!.trips[f.tripId].directAutostart);
  } finally { await f.close(); }
});

for (const loss of ['upload', 'http500'] as const) test(`new full-title create survives ${loss} without duplicate creation or new authorization`, async () => {
  const f = await fixture([false, true]), api = directApi();
  try {
    await f.start(); const before = await f.store.read(f.source);
    api.setLoss(loss);
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    const unknown = (await f.store.read(f.source)).etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
    assert.equal(unknown.id, null); assert.equal(unknown.reservationAttempted, true);
    assert.equal(unknown.uploadAttempted, true); assert.equal(unknown.writeAttempts!.length, 1);
    assert.equal(unknown.writeAttempts![0].outcome, 'uncertain'); assert.equal(api.reserves().length, 1);
    await runNkDirectEtrn({ ...f, store: new OperationsStore(f.directory + '/store'), client: new SabyClient(f.config, api.send) });
    assert.equal(api.reserves().length, 1); assert.equal(api.docs.size, 1);
    const after = await f.store.read(f.source);
    assert.deepEqual(after.etrn!.trips[f.tripId].direct!.authorization, before.etrn!.trips[f.tripId].direct!.authorization);
    assert.equal(after.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!.attemptId, unknown.attemptId);
    assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
  } finally { await f.close(); }
});

for (const tamper of ['number', 'mass'] as const) test(`new full-title creation refuses unconfirmed ${tamper} without signing or replacement create`, async () => {
  const f = await fixture([false, true]), api = directApi();
  try {
    await f.start();
    const send: typeof fetch = async (url, init) => {
      const response = await api.send(url, init);
      if (tamper === 'number' && init?.method === 'POST' && JSON.parse(String(init.body)).method === 'СБИС.ПрочитатьДокумент') {
        const body = await response.json(); body.result.Номер = ''; return new Response(JSON.stringify(body));
      }
      if (tamper === 'mass' && init?.method === 'GET' && String(url).endsWith('.xml')) {
        const xml = new TextDecoder('windows-1251').decode(await response.arrayBuffer());
        return new Response(encodeWindows1251(xml.replace(/МасБрутОтгр="[^"]+"/, 'МасБрутОтгр="1"')));
      }
      return response;
    };
    for (let i=0;i<2;i++) await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, send) });
    assert.equal(api.reserves().length, 1); assert.equal(api.uploads().length, 1); assert.equal(api.executes().length, 0);
    const saved = (await f.store.read(f.source)).etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
    assert.equal(saved.status, 'unknown'); assert.ok(saved.id); assert.equal(saved.dispatch, undefined);
  } finally { await f.close(); }
});

for (const search of ['empty', 'http500'] as const) test(`historical first-delivery unknown remains unchanged and never starts the second delivery after ${search} reconciliation`, async () => {
  const f = await fixture(), api = directApi();
  try {
    await f.start(); await seedExistingNativeDocuments(f, api, { unknownId: true, providerMissing: true, firstOnly: true });
    const before = await f.store.read(f.source), original = before.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
    let searches = 0;
    const send: typeof fetch = async (url, init) => {
      const req = JSON.parse(String(init?.body)) as IntegrationRpc;
      if (req.method === 'СБИС.СписокДокументов') { searches++; if (search === 'http500') return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, error: { code: -32000, message: 'Синтетический сбой чтения' } }), { status: 500 }); }
      return api.send(url, init);
    };
    for (let i = 0; i < 2; i++) await runNkDirectEtrn({ ...f, store: new OperationsStore(f.directory + '/store'), client: new SabyClient(f.config, send) });
    const after = await f.store.read(f.source), saved = after.etrn!.trips[f.tripId], doc = saved.deliveries[f.trip.customers[0].id].document!;
    assert.equal(searches, 2); assert.equal(api.uploads().length, 0); assert.equal(api.executes().length, 0); assert.equal(api.docs.size, 0);
    assert.equal(doc.id, null); assert.equal(doc.status, 'unknown'); assert.equal(doc.reservationAttempted, true); assert.equal(doc.uploadAttempted, false);
    for (const key of ['marker', 'attemptId', 'createdAt', 'payloadHash', 'snapshot'] as const) assert.deepEqual(doc[key], original[key]);
    assert.deepEqual(saved.direct!.authorization, before.etrn!.trips[f.tripId].direct!.authorization); assert.deepEqual(saved.loadingFacts, before.etrn!.trips[f.tripId].loadingFacts);
    assert.equal(saved.deliveries[f.trip.customers[1].id], undefined); assert.deepEqual(after.shipments, before.shipments);
  } finally { await f.close(); }
});

test('a completed direct document cannot retain completion after its operator UID changes', async () => {
  const f = await fixture([false, true]), api = directApi();
  try {
    await f.start(); await seedExistingNativeDocuments(f, api);
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    assert.equal(nkDirectEtrnCompleted(await f.store.read(f.source), f.tripId), true);
    const id = 'native-existing-1', xml = new TextDecoder('windows-1251').decode(api.t1.get(id)!);
    api.t1.set(id, encodeWindows1251(xml.replace(/УИД_ТрН="[^"]+"/, `УИД_ТрН="${randomUUID()}"`)));
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    const after = await f.store.read(f.source), direct = after.etrn!.trips[f.tripId].direct!;
    assert.equal(nkDirectEtrnCompleted(after, f.tripId), false); assert.equal(direct.completedAt, undefined); assert.equal(direct.phase, 'unknown');
    assert.equal(api.uploads().length, 1); assert.equal(api.executes().length, 2);
  } finally { await f.close(); }
});

for (const pendingFirst of [false, true]) test(`native adoption review hold blocks every direct entry point and preserves the original grant (${pendingFirst ? 'fresh first delivery' : 'known native ID'})`, async () => {
  const f = await fixture(), api = directApi();
  let server: ReturnType<typeof createServer> | undefined;
  try {
    await f.start(); await seedExistingNativeDocuments(f, api);
    await f.store.mutate(f.source, data => {
      const trip = data.etrn!.trips[f.tripId];
      const heldId = f.trip.customers[pendingFirst ? 1 : 0].id;
      const doc = trip.deliveries[heldId].document!;
      const original = { ...structuredClone(doc), id: null, number: undefined, revision: null };
      const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
      doc.senderTitleVersion = 2;
      doc.nativeAdoptionEvidence = {
        version: 'native-ui-adoption-v1', origin: 'independently_created_native_ui',
        nativeDocumentId: doc.id!, nativeNumber: doc.number!, nativeRevision: `${doc.id}-revision`, nativeAttachmentId: `${doc.id}-native-t1`,
        nativeXmlSha256: digest('synthetic native XML'), nativeReadSha256: digest(api.docs.get(doc.id!)), uiEvidenceSha256: digest('synthetic independent UI creation'), planSha256: digest('synthetic reviewed adoption plan'), sourceSnapshotSha256: doc.payloadHash,
        originalAttemptId: doc.attemptId, originalMarker: doc.marker, originalDocumentSha256: digest(original),
        originalReservationAttempted: true, originalReservationOutcome: 'unknown', originalWriteAttemptsCount: 0, originalWriteAttemptsSha256: digest([]),
        actorId: 'actor', adoptedAt: new Date().toISOString(), stage: 'planned', holdForReview: true,
      };
      if (pendingFirst) delete trip.deliveries[f.trip.customers[0].id];
      return { result: undefined, changed: true };
    });
    const before = await f.store.read(f.source), client = new SabyClient(f.config, api.send), restarted = new OperationsStore(f.directory + '/store');
    const denied = (error: unknown) => error instanceof ApiError && error.status === 403 && /сверку/.test(error.message);
    assert.throws(() => authorizeNkDirectEtrn(f.base, before, f.tripId, f.config), denied);
    await assert.rejects(runNkDirectEtrn({ ...f, store: restarted, client }), denied);
    await assert.rejects(exchangePreparedEtrn({ ...f, store: restarted, client: client.forNkDirectEtrn() }, { documentMode: 'nk-direct-v1', ...before.etrn!.trips[f.tripId].direct!.deliveries[0] }), denied);
    assert.deepEqual(await dispatchTripSaby({ ...f, store: restarted, enabled: true, send: api.send }), { continued: 0, refreshed: 0, denied: 1, failed: 0 });
    // HTTP GET is a read-only projection; the manual refresh POST uses the same
    // persisted actor/grant gate as the scheduler. Authentication is covered by
    // the production-bundle UI suite; this isolated handler tests the hold itself.
    const middleware = createSnapshotMiddleware(f.snapshotDirectory, { operationsStore: restarted, sabyClient: client, requireAuthentication: false });
    server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404).end(); }));
    await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`, path = `/api/shipment-trips/${f.tripId}/saby-workflow`;
    const read = await fetch(base + path); assert.equal(read.status, 200); const projection = await read.json();
    assert.equal(projection.start, undefined); assert.equal(projection.order, null); assert.equal(projection.stage6CompletedAt, null);
    const manual = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(manual.status, 403); assert.match((await manual.json()).error, /сверку/);
    assert.equal(api.calls.length, 0); assert.equal(api.uploads().length, 0); assert.equal(api.executes().length, 0);
    assert.deepEqual(await restarted.read(f.source), before, 'Read/manual/scheduler attempts must preserve the entire grant, evidence, frozen facts and documents');
  } finally {
    if (server) await new Promise<void>((done, reject) => server!.close(error => error ? reject(error) : done()));
    await f.close();
  }
});


test('new direct trips omit a separate loader for every delivery and keep the depot owner', async () => {
  const f = await fixture([false, false], false, true, undefined, false, false, true);
  try {
    const data = await f.store.read(f.source), saved = data.etrn!.trips[f.tripId];
    assert.equal(saved.loadingActorMode, 'sender');
    assert.equal(saved.directAutostart!.state, 'queued');
    assert.equal(saved.loadingDetails, undefined);
    assert.equal(data.tripSaby?.trips[f.tripId], undefined);
    const details = getNkLoadingDetails(f.base, data, f.tripId, f.config);
    assert.equal(details.mode, 'sender'); assert.equal(details.required, false);
    assert.ok(details.infrastructureOwner?.inn);
    for (const { snapshot } of saved.direct!.deliveries) {
      assert.equal(snapshot.profile.loadingActor.sameAsConsignor, true);
      assert.equal(snapshot.profile.loadingActor.party.inn, f.config.carrier.inn);
      assert.equal(snapshot.profile.loadingActor.basis, undefined);
      assert.equal(snapshot.profile.loadingActor.worker, undefined);
      assert.equal(snapshot.profile.infrastructureOwner.party.inn, details.infrastructureOwner!.inn);
    }
  } finally { await f.close(); }
});

for (const scenario of ['success', 'lost-correction', 'wrong-hash', 'wrong-message', 'wrong-rpc', 'list-failed'] as const) test(`filename rejection correction is bounded and preserves the original receipt: ${scenario}`, async () => {
  const f = await fixture([false, true]), api = directApi();
  try {
    await f.start(); await seedExistingNativeDocuments(f, api, { unknownId: true, providerMissing: true, firstOnly: true });
    await f.store.mutate(f.source, data => {
      const doc = data.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
      delete doc.number; doc.senderTitleVersion = 2; doc.directDraftCreation = { version: 'auto-number-v1' }; doc.uploadAttempted = true;
      const request = buildSabyConsignmentDocument(doc.snapshot, doc.marker, doc.attemptId, doc.createdAt, undefined, { senderTitleVersion: 2, draftWithoutNumber: true });
      delete ((request.Вложение as SabyObject[])[0].Файл as SabyObject).Имя;
      const body = JSON.stringify({ jsonrpc: '2.0', method: 'СБИС.ЗаписатьДокумент', params: { Документ: request }, id: 4 });
      doc.writeAttempts = [{ action: 'reservation', outcome: 'uncertain', request: { version: 1, method: 'СБИС.ЗаписатьДокумент', requestId: 4, requestedAt: doc.createdAt, bodySha256: scenario === 'wrong-hash' ? 'a'.repeat(64) : createHash('sha256').update(body).digest('hex'), bodyBytes: Buffer.byteLength(body) }, response: { receivedAt: doc.createdAt, httpStatus: 500, bodyState: 'complete', bodySha256: 'b'.repeat(64), bodyBytes: 513, rpcIdMatches: scenario !== 'wrong-rpc', rpcCode: -32000, message: scenario === 'wrong-message' ? 'Unknown error' : 'Не указано имя файла вложения' } }];
      return { changed: true, result: undefined };
    });
    const before = await f.store.read(f.source), original = before.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
    if (scenario === 'lost-correction') api.setLoss('http500');
    const send: typeof fetch = async (url, init) => {
      if (scenario === 'list-failed' && init?.method === 'POST' && JSON.parse(String(init.body)).method === 'СБИС.СписокДокументов') return new Response('unavailable', {status: 500});
      return api.send(url, init);
    };
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, send) });
    await runNkDirectEtrn({ ...f, store: new OperationsStore(f.directory + '/store'), client: new SabyClient(f.config, send) });
    const after = await f.store.read(f.source), doc = after.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
    assert.deepEqual(doc.writeAttempts![0], original.writeAttempts![0]);
    assert.equal(doc.attemptId, original.attemptId); assert.equal(doc.reservationAttempted, true); assert.equal(doc.uploadAttempted, true);
    assert.deepEqual(after.etrn!.trips[f.tripId].direct!.authorization, before.etrn!.trips[f.tripId].direct!.authorization);
    assert.deepEqual(after.shipments, before.shipments); assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
    const corrected = ['success', 'lost-correction'].includes(scenario);
    assert.equal(api.reserves().length, corrected ? 1 : 0); assert.equal(!!doc.directDraftCreation!.filenameCorrection, corrected);
    if (corrected) assert.ok(doc.id); else assert.equal(doc.id, null);
  } finally { await f.close(); }
});

const ARTEL_POLICY_ANSWER = 'можешь посмотреть как мы делаем это в логике с артелем, и взять такую же логику работы';
for (const failure of ['none', 'processing', 'carrier-delayed', 'execute-loss', 'mass', 'receipt', 'prepared-hash', 'grant', 'no-approval'] as const) test(`CRM-created title reuses scoped native redirection approval: ${failure}`, async () => {
  const f = await fixture([false, true], false, false, 'По телефону'), api = directApi(true, true, true, failure === 'processing');
  try {
    await f.start(); await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    const before = await f.store.read(f.source), sid = f.trip.customers[0].id, trip = before.etrn!.trips[f.tripId], doc = trip.deliveries[sid].document!;
    assert.equal(doc.dispatch?.sender.state, 'blocked'); assert.ok(doc.dispatch.sender.prepared); assert.equal(doc.nativeAdoptionEvidence, undefined);
    assert.equal(api.executes().length, 0); const writes = api.uploads().length, prepares = api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length;
    if (failure !== 'no-approval') await f.store.mutate(f.source, data => {
      const current = data.etrn!.trips[f.tripId].deliveries[sid].document!, manifest = current.dispatch!.sender.prepared!, file = manifest.attachments.find(row => row.subtype === '1110339')!;
      current.nativeSenderAmendment = {
        version: 'direct-redirection-approval-v2', tripId: f.tripId, documentId: current.id!, documentNumber: current.number!, documentRevision: current.revision!, attachmentId: file.id,
        payloadHash: current.payloadHash, directAttemptId: trip.direct!.attemptId, authorizationSha256: directDigest(trip.direct!.authorization), originalPreparedHash: manifest.preparedHash, sourceXmlSha256: file.sha256,
        beforeMethod: 'По телефону', afterMethod: 'Электронное уведомление перевозчика о переадресовке', source: 'explicit_user_instruction', answerText: ARTEL_POLICY_ANSWER,
        approvalReference: 'synthetic-current-user-instruction', recordedAt: new Date().toISOString(), approvalTextSha256: createHash('sha256').update(ARTEL_POLICY_ANSWER).digest('hex'),
      };
      return {changed: true, result: undefined};
    });
    if (failure === 'mass') api.t1.set(doc.id!, encodeWindows1251(new TextDecoder('windows-1251').decode(api.t1.get(doc.id!)!).replace('МасБрутОтгр="6745"', 'МасБрутОтгр="6746"')));
    if (['receipt', 'prepared-hash', 'grant'].includes(failure)) {
      const invalid = structuredClone((await f.store.read(f.source)).etrn!.trips[f.tripId].deliveries[sid].document!);
      if (failure === 'receipt') invalid.writeAttempts = invalid.writeAttempts?.filter(row => row.action !== 'reservation');
      if (failure === 'prepared-hash') invalid.nativeSenderAmendment!.originalPreparedHash = 'f'.repeat(64);
      if (failure === 'grant') invalid.nativeSenderAmendment!.authorizationSha256 = 'f'.repeat(64);
      assert.throws(() => validateNativeSenderAmendment(invalid, f.tripId, trip.direct));
      return;
    }
    if (failure === 'execute-loss') api.setLoss('execute');
    if (failure === 'carrier-delayed') api.setDelayedCarrierTitle(true);
    await runNkDirectEtrn({ ...f, store: new OperationsStore(f.directory + '/store'), client: new SabyClient(f.config, api.send) });
    const after = await f.store.read(f.source), current = after.etrn!.trips[f.tripId].deliveries[sid].document!;
    assert.deepEqual(current.dispatch!.sender.prepared, doc.dispatch.sender.prepared); assert.deepEqual(current.writeAttempts, doc.writeAttempts);
    assert.deepEqual(after.etrn!.trips[f.tripId].direct!.authorization, trip.direct!.authorization); assert.deepEqual(current.snapshot, doc.snapshot);
    assert.equal(api.uploads().length, writes);
    assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие' && (row.params.Документ.Этап as SabyObject).Название === 'Отправка').length, 1);
    if (failure === 'mass' || failure === 'no-approval') { assert.equal(api.executes().length, 0); assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, prepares); }
    else {
      if (failure === 'carrier-delayed') {
        assert.equal(current.dispatch!.sender.state,'confirmed'); assert.equal(current.dispatch!.carrier.state,'blocked'); assert.equal(current.dispatch!.carrierDraft!.state,'preparing'); assert.equal(current.dispatch!.carrier.executeAttempted,undefined);
        assert.equal(api.calls.filter(row=>row.method==='СБИС.ПодготовитьДействие' && (row.params.Документ.Этап as SabyObject).Название==='Получение груза').length,1);
        api.setDelayedCarrierTitle(false); await runNkDirectEtrn({...f,client:new SabyClient(f.config,api.send)});
        assert.equal(api.calls.filter(row=>row.method==='СБИС.ПодготовитьДействие' && (row.params.Документ.Этап as SabyObject).Название==='Получение груза').length,2);
      }
      if (failure === 'execute-loss') await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
      const checked = await f.store.read(f.source); assert.ok(nkDirectEtrnCompleted(checked, f.tripId), JSON.stringify(checked.etrn!.trips[f.tripId].direct) + JSON.stringify(checked.etrn!.trips[f.tripId].deliveries[sid].document!.dispatch)); assert.equal(api.executes().length, 2);
      await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) }); assert.equal(api.executes().length, 2);
    }
  } finally { await f.close(); }
});

for (const loss of [null, 'upload', 'execute'] as const) test(`new sender-mode direct deliveries use electronic terms and continue independently: ${loss ?? 'success'}`, async () => {
  const f = await fixture([false, false], false, false, undefined, false, false, true), api = directApi(true, true, true);
  try {
    await f.start();
    const before = await f.store.read(f.source), grant = before.etrn!.trips[f.tripId].direct!;
    for (const row of grant.deliveries) assert.equal(row.snapshot.profile.instructions.redirectionMethod, 'Электронное уведомление перевозчика о переадресовке');
    if (loss) api.setLoss(loss);
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    const after = await f.store.read(f.source), trip = after.etrn!.trips[f.tripId];
    const second = trip.deliveries[f.trip.customers[1].id].document!;
    assert.ok(second.dispatch?.completedAt, JSON.stringify({phase:trip.direct?.phase,error:trip.direct?.lastError,second:second.dispatch}));
    assert.deepEqual(after.shipments, before.shipments);
    assert.deepEqual(after.driverTripProgress, before.driverTripProgress);
    assert.deepEqual(trip.direct!.authorization, grant.authorization);
    if (loss) {
      assert.equal(nkDirectEtrnCompleted(after, f.tripId), false);
      assert.ok(trip.direct!.lastError, 'An unresolved first delivery retains its diagnostic');
    } else assert.ok(nkDirectEtrnCompleted(after, f.tripId));
    const creates = () => api.calls.filter(row => row.method === 'СБИС.ЗаписатьДокумент' && !row.params.Документ.Идентификатор).length;
    assert.equal(creates(), 2);
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    assert.equal(creates(), 2, 'Reconciliation must not create another document');
    const checked = await f.store.read(f.source);
    assert.ok(nkDirectEtrnCompleted(checked, f.tripId), JSON.stringify({direct:checked.etrn!.trips[f.tripId].direct,documents:Object.values(checked.etrn!.trips[f.tripId].deliveries).map(x=>({status:x.document?.status,error:x.document?.lastError,dispatch:x.document?.dispatch}))}));
    const requests = api.executes().map(row => JSON.stringify([row.params.Документ.Идентификатор, row.params.Документ.Редакция, (row.params.Документ.Этап as SabyObject).Название]));
    assert.equal(new Set(requests).size, requests.length, 'Each document action is executed once');
    assert.equal(requests.length, 4);
    const uploads = api.uploads().length;
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    assert.equal(api.uploads().length, uploads);
    assert.equal(api.executes().length, 4);
  } finally { await f.close(); }
});

test('independent direct processing rejects changed prepared mass and still completes the other delivery', async () => {
  const f = await fixture([false, false], false, false, undefined, false, false, true), api = directApi(true, true, true);
  let damagedId: string | undefined;
  const send: typeof fetch = async (url, init) => {
    const response = await api.send(url, init);
    if (init?.method !== 'GET') {
      const req = JSON.parse(String(init?.body)) as IntegrationRpc;
      if (!damagedId && req.method === 'СБИС.ПодготовитьДействие' && (req.params.Документ.Этап as SabyObject).Название === 'Отправка') {
        damagedId = String((await response.clone().json()).result.Идентификатор);
        const xml = new TextDecoder('windows-1251').decode(api.t1.get(damagedId)!);
        assert.ok(xml.includes('МасБрутОтгр="6745"'));
        api.t1.set(damagedId, encodeWindows1251(xml.replace('МасБрутОтгр="6745"', 'МасБрутОтгр="6746"')));
      }
    }
    return response;
  };
  try {
    await f.start();
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, send) });
    const data = await f.store.read(f.source), trip = data.etrn!.trips[f.tripId];
    const first = trip.deliveries[f.trip.customers[0].id].document!, second = trip.deliveries[f.trip.customers[1].id].document!;
    assert.equal(first.dispatch?.sender.state, 'blocked');
    assert.ok(!first.dispatch.sender.executeAttempted);
    assert.ok(second.dispatch?.completedAt);
    assert.equal(api.executes().length, 2);
    assert.ok(trip.direct!.lastError);
    assert.equal(nkDirectEtrnCompleted(data, f.tripId), false);
    const prepares = api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length;
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, send) });
    assert.equal(api.executes().length, 2);
    assert.equal(api.calls.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, prepares);
  } finally { await f.close(); }
});


test('direct completed due selection preserves deadline, lastCheckedAt precedence and fresh claims', async () => {
  const f = await fixture([false, true]);
  try {
    await f.start(); const original = await f.store.read(f.source), now = Date.now();
    for (const useLastChecked of [false, true]) for (const delta of [-1, 0, 1]) {
      const data = structuredClone(original), direct = data.etrn!.trips[f.tripId].direct!;
      direct.phase = 'completed'; direct.updatedAt = new Date(now - 120_000).toISOString();
      if (useLastChecked) direct.lastCheckedAt = new Date(now).toISOString();
      else { delete direct.lastCheckedAt; direct.updatedAt = new Date(now).toISOString(); }
      let reads = 0, claims = 0, sends = 0;
      const store: OperationsStorage = {
        read: async () => { reads++; return structuredClone(data); },
        mutate: async () => { claims++; throw new ApiError(409, 'Synthetic claim boundary'); },
      };
      const scheduler = createTripSabyScheduler({ ...f, store, config: f.config, enabled: true, now: now + 60_000 + delta, send: async () => { sends++; throw new Error('No provider requests'); } });
      try { await scheduler.tick(); await scheduler.drain(); }
      finally { await scheduler.stop(); }
      assert.equal(reads, delta < 0 ? 1 : 2); assert.equal(claims, delta < 0 ? 0 : 1); assert.equal(sends, 0);
    }
  } finally { await f.close(); }
});

test('completed direct observation measures durable work without new provider actions', async () => {
  const f = await fixture([false, true]), api = directApi();
  try {
    await f.start(); await seedExistingNativeDocuments(f, api);
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    assert.equal(nkDirectEtrnCompleted(await f.store.read(f.source), f.tripId), true);
    const originalRead = f.store.read.bind(f.store), originalMutate = f.store.mutate.bind(f.store);
    let reads = 0, transactions = 0, changed = 0;
    f.store.read = async source => { reads++; return originalRead(source); };
    f.store.mutate = async (source, update) => { transactions++; return originalMutate(source, async data => { const result = await update(data); if (result.changed) changed++; return result; }); };
    const start = performance.now(), cpu = process.cpuUsage(), priorCalls = api.calls.length;
    const result = await dispatchTripSaby({ ...f, config: f.config, enabled: true, send: api.send, now: Date.now() + 60_001 });
    const observation = { reads, transactions, changed, ms: performance.now() - start, cpu: process.cpuUsage(cpu), result, methods: api.calls.slice(priorCalls).map(call => call.method) };
    assert.deepEqual(result, { continued: 1, refreshed: 0, denied: 0, failed: 0 });
    assert.ok(observation.methods.every(method => !/Записать|Подготовить|Выполнить/.test(method)), 'completed observation must not create, prepare, execute or write a provider document');
    const after = await originalRead(f.source);
    assert.equal(after.etrn!.trips[f.tripId].direct!.leaseId, null);
    assert.equal(after.etrn!.trips[f.tripId].direct!.leaseUntil, null);
    assert.equal(nkDirectEtrnCompleted(after, f.tripId), true);
    console.log('SYNTHETIC_COMPLETED_DIRECT_PROFILE', JSON.stringify(observation));
  } finally { await f.close(); }
});


test('prepared direct delivery shares each fresh full snapshot while preserving authorization failures', async () => {
  const f = await fixture([false, true]);
  try {
    await f.start(); const original = await f.store.read(f.source);
    for (const change of ['none', 'actor', 'policy', 'mass', 'version', 'loading-role'] as const) {
      const data = structuredClone(original), config = structuredClone(f.config);
      if (change === 'actor') data.accounts!.users.find(row => row.id === 'actor')!.active = false;
      if (change === 'policy') config.automaticSigning!.carrier.thumbprint = 'ef'.repeat(20);
      if (change === 'mass') data.etrn!.trips[f.tripId].loadingFacts!.deliveries[f.trip.customers[0].id].grossMassTonnes = '8';
      if (change === 'version') data.shipments[f.trip.customers[0].id].version++;
      if (change === 'loading-role') data.etrn!.trips[f.tripId].loadingActorMode = 'sender';
      let expected: unknown;
      try { authorizeNkDirectEtrn(f.base, data, f.tripId, config); } catch (error) { expected = error; }
      let assemblyReads = 0, claims = 0;
      const base = new Proxy(f.base, { get(target, property, receiver) { if (property === 'shipments') assemblyReads++; return Reflect.get(target, property, receiver); } });
      currentSnapshot(base, data); const oneAssemblyReads = assemblyReads; assemblyReads = 0;
      const stop = new Error('Synthetic successful claim boundary');
      const store: OperationsStorage = {
        read: async () => structuredClone(data),
        mutate: async (_source, update) => { claims++; const before = assemblyReads; await update(structuredClone(data)); assert.equal(assemblyReads - before, oneAssemblyReads); throw stop; },
      };
      const input = data.etrn!.trips[f.tripId].direct!.deliveries[0];
      await assert.rejects(exchangePreparedEtrn({ ...f, base, store, client: new SabyClient(config, async () => { throw new Error('No external call'); }) }, { documentMode: 'nk-direct-v1', ...input }), error => expected instanceof ApiError ? error instanceof ApiError && error.status === expected.status && error.message === expected.message : error === stop);
      assert.equal(assemblyReads, oneAssemblyReads * (change === 'none' ? 2 : 1), change);
      assert.equal(claims, change === 'none' ? 1 : 0);
    }
  } finally { await f.close(); }
});

for (const failure of ['final-write', 'revoked-actor', 'competing-lease'] as const) test(`direct final metadata and lease release preserve ${failure} recovery`, async () => {
  const f = await fixture([false, true]), api = directApi();
  try {
    await f.start(); await seedExistingNativeDocuments(f, api);
    await runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    await f.store.mutate(f.source, data => { data.etrn!.trips[f.tripId].direct!.lastCheckedAt = '2000-01-01T00:00:00.000Z'; return { result: undefined, changed: true }; });
    const before = await f.store.read(f.source), originalRead = f.store.read.bind(f.store), originalMutate = f.store.mutate.bind(f.store);
    let injected = false;
    f.store.mutate = async (source, update) => {
      if (!injected) {
        // Probe a disposable copy to identify the final local transition. It
        // cannot persist or send requests; the real callback still runs below
        // against the normal freshly locked store transaction.
        const saved = await originalRead(source), probe = structuredClone(saved);
        await update(probe);
        const old = saved.etrn!.trips[f.tripId].direct!, next = probe.etrn!.trips[f.tripId].direct!;
        if (old.leaseId && next.leaseId === null && next.lastCheckedAt !== old.lastCheckedAt) {
          injected = true;
          if (failure === 'final-write') return originalMutate(source, async data => { await update(data); throw new Error('Synthetic final persistence failure'); });
          await originalMutate(source, data => {
            if (failure === 'revoked-actor') {
              const actor = data.accounts!.users.find(row => row.id === 'actor')!;
              data.accounts!.users.push({ ...actor, id: 'replacement-owner', login: 'replacement-owner' }); actor.active = false;
            } else {
              const direct = data.etrn!.trips[f.tripId].direct!;
              direct.leaseId = 'synthetic-competing-lease'; direct.leaseUntil = new Date(Date.now() + 300_000).toISOString();
            }
            return { result: undefined, changed: true };
          });
        }
      }
      return originalMutate(source, update);
    };
    const priorCalls = api.calls.length;
    const run = runNkDirectEtrn({ ...f, client: new SabyClient(f.config, api.send) });
    if (failure === 'revoked-actor') await assert.rejects(run, error => error instanceof ApiError && error.status === 403);
    else await run;
    assert.equal(injected, true);
    const after = await originalRead(f.source), direct = after.etrn!.trips[f.tripId].direct!;
    if (failure === 'competing-lease') {
      assert.equal(direct.leaseId, 'synthetic-competing-lease');
      assert.equal(direct.lastCheckedAt, '2000-01-01T00:00:00.000Z', 'failed final ownership check cannot overwrite another lease');
    } else {
      assert.equal(direct.leaseId, null); assert.equal(direct.leaseUntil, null);
      assert.equal(direct.phase, 'unknown'); assert.equal(direct.completedAt, undefined);
      assert.ok(direct.lastError);
    }
    assert.deepEqual(direct.authorization, before.etrn!.trips[f.tripId].direct!.authorization);
    const shipmentId = f.trip.customers[0].id;
    assert.deepEqual(after.etrn!.trips[f.tripId].deliveries[shipmentId].document!.dispatch, before.etrn!.trips[f.tripId].deliveries[shipmentId].document!.dispatch);
    assert.deepEqual(after.etrn!.trips[f.tripId].deliveries[shipmentId].document!.writeAttempts, before.etrn!.trips[f.tripId].deliveries[shipmentId].document!.writeAttempts);
    assert.ok(api.calls.slice(priorCalls).every(call => !/Записать|Подготовить|Выполнить/.test(call.method)));
  } finally { await f.close(); }
});

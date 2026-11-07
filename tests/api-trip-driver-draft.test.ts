import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import test from 'node:test';
import { saveUser } from '../server/auth';
import type { AccountUser } from '../web/src/auth-model';
import { currentSnapshot } from '../server/shipment-operations';
import { saveShipmentTrip } from '../server/shipment-trips';
import { recordDriverTripAction, readDriverTrips } from '../server/driver-trips';
import { OperationsStore } from '../server/operations-store';
import { SabyClient, type SabyObject } from '../server/saby-client';
import { enqueueAutomaticTripSaby, runTripSabyWorkflow, validateTripSabyData } from '../server/trip-saby-workflow';
import { createTripSabyScheduler, dispatchTripSaby } from '../server/trip-saby-scheduler';
import { integrationRuntime, integrationApi, integrationConfig, integrationPrepare, type IntegrationRpc } from './helpers/trip-saby-integration';

const neverCreate = async () => { throw new Error('No signed order in this synthetic draft test'); };
const decodeUpload = (request: IntegrationRpc) => new TextDecoder('windows-1251').decode(Buffer.from(String(((request.params.Документ.Вложение as SabyObject[])[0].Файл as SabyObject).ДвоичныеДанные), 'base64'));
const massWrites = (api: ReturnType<typeof integrationApi>) => api.calls.filter(row => row.method === 'СБИС.ЗаписатьВложение');
const gate = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
async function fixture() {
  const rt = await integrationRuntime(), api = integrationApi();
  const config = integrationConfig();
  config.automaticSigning = { id: 'synthetic-driver-policy', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z', sender: { ...config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...config.carrier, thumbprint: 'cd'.repeat(20) } };
  const created = await rt.store.mutate(rt.source, async data => {
    const owner = await saveUser(data, currentSnapshot(rt.base, data), { name: 'Синтетический руководитель', login: 'draft-owner', password: randomUUID() }, undefined, true);
    const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
    Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2027-02-03T09:15' });
    const customers = rt.trip.customers.map(row => ({ fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, row.fields[key]])) }));
    const result = saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }, undefined, owner.id);
    const queued = enqueueAutomaticTripSaby({ base: rt.base, data, tripId: result.trip.id, actorId: owner.id, config, prepare: integrationPrepare });
    assert.equal(queued.enqueued, true, JSON.stringify(queued.blockers));
    return { result: { ...result, ownerId: owner.id }, changed: true };
  });
  const actor: AccountUser = { id: 'synthetic-driver-user', name: 'Синтетический водитель', login: 'synthetic-driver', role: 'driver', driverId: 'driver', active: true, version: 1, managerId: null };
  const tripId = created.trip.id;
  const read = async () => { const data = await rt.store.read(rt.source); return readDriverTrips(currentSnapshot(rt.base, data), actor, tripId, '', data).trip!; };
  const action = async (kind: 'arrive' | 'depart') => {
    const trip = await read();
    return rt.store.mutate(rt.source, data => recordDriverTripAction(rt.base, data, actor, tripId, kind, { versions: trip.versions, ...(kind === 'depart' ? { masses: trip.deliveries.map((row, index) => ({ deliveryId: row.id, netTonnes: index ? '9.654321' : '2.123456' })) } : {}) }));
  };
  const run = (send: typeof fetch = api.send, store = rt.store) => runTripSabyWorkflow({ base: rt.base, store, tripId, authorize: () => undefined, prepare: integrationPrepare, client: new SabyClient(config, send), createDelivery: neverCreate });
  return { ...rt, legacyTripId: rt.tripId, tripId, created, config, api, actor, action, read, run };
}

test('immediate departure continuation uses the saved staff authority and enriches once across repeated signals', async () => {
  const f = await fixture();
  const scheduler = createTripSabyScheduler({ base: f.base, store: f.store, config: f.config, enabled: true, prepare: integrationPrepare, send: f.api.send });
  try {
    await f.run(); await f.action('arrive'); await f.action('depart');
    for (let i = 0; i < 8; i++) scheduler.request(f.tripId);
    await scheduler.drain();
    const record = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(record.driverFlow?.state, 'ready'); assert.equal(record.initiatorId, f.created.ownerId);
    assert.notEqual(record.initiatorId, f.actor.id);
    assert.equal(massWrites(f.api).length, 1); assert.equal(f.api.reserves('TransportOrder').length, 1);
    assert.equal((await f.read()).departedAt, (await f.store.read(f.source)).driverTripProgress![f.tripId].departedAt);
  } finally { await scheduler.stop(); await f.close(); }
});

test('graceful shutdown drains a queued reservation intent and restart never creates duplicates', async () => {
  const f = await fixture(), blocked = gate();
  let scheduler: ReturnType<typeof createTripSabyScheduler> | undefined;
  try {
    const second = await f.store.mutate(f.source, data => {
      const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, f.created.trip.fields[key]]));
      Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2027-02-03T09:15' });
      const customers = f.created.trip.customers.map(row => ({ fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, row.fields[key]])) }));
      const result = saveShipmentTrip(f.base, data, { fields, customers, idempotencyKey: randomUUID() }, undefined, f.created.ownerId);
      assert.equal(enqueueAutomaticTripSaby({ base: f.base, data, tripId: result.trip.id, actorId: f.created.ownerId, config: f.config, prepare: integrationPrepare }).enqueued, true);
      return { result: result.trip.id, changed: true };
    });
    let held = false;
    const send: typeof fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body ?? '{}'));
      if (!held && request.method === 'СБИС.ЗаписатьДокумент' && !request.params.Документ.Идентификатор) { held = true; await blocked.promise; }
      return f.api.send(input, init);
    };
    const options = { base: f.base, store: f.store, config: f.config, enabled: true, prepare: integrationPrepare, send };
    scheduler = createTripSabyScheduler(options, 1);
    await scheduler.tick();
    const deadline = Date.now() + 3_000;
    while (true) {
      const records = (await f.store.read(f.source)).tripSaby!.trips;
      if (held && records[f.tripId].reservationAttempted && records[second].reservationAttempted) break;
      if (Date.now() > deadline) throw new Error('Synthetic second reservation did not reach the capacity queue');
      await new Promise(done => setTimeout(done, 5));
    }
    let stopped = false; const stopping = scheduler.stop().then(() => { stopped = true; });
    await new Promise(done => setTimeout(done, 10)); assert.equal(stopped, false);
    blocked.release(); await stopping;
    const records = (await f.store.read(f.source)).tripSaby!.trips;
    for (const id of [f.tripId, second]) { assert.equal(records[id].phase, 'awaiting_driver'); assert.ok(records[id].order.id); assert.equal(records[id].leaseId, null); }
    assert.equal(f.api.reserves('TransportOrder').length, 2);
    scheduler = createTripSabyScheduler(options, 1); await scheduler.tick(); await scheduler.drain();
    assert.equal(f.api.reserves('TransportOrder').length, 2);
  } finally { blocked.release(); await scheduler?.stop(); await f.close(); }
});

test('saved driver trip creates one massless unsigned draft; arrival does not write or authorize stage two', async () => {
  const f = await fixture();
  try {
    const initial = await f.store.read(f.source); const legacy = structuredClone(initial.shipments[f.trip.customers[0].id]);
    assert.equal(f.api.calls.length, 0);
    const waiting = await f.run();
    assert.equal(waiting.phase, 'awaiting_driver', waiting.lastError ?? ''); assert.equal(waiting.driverFlow?.state, 'waiting_driver');
    assert.equal(f.api.docs.size, 1); assert.equal(f.api.reserves('TransportOrder').length, 1); assert.equal(f.api.writes('TransportOrder').length, 2);
    const xml = decodeUpload(f.api.writes('TransportOrder')[1]);
    assert.equal((xml.match(/<ОпГруз /g) ?? []).length, 2);
    assert.doesNotMatch(xml, /<Масса|МасБрутЗнач|МасНетто|ПредВрОпер/);
    assert.match(xml, /ПредВрПод="19:15:00\+03:00" НалКоорТочПредВрПод="1"/);
    assert.match(xml, /ВрНачПогр|09:15/);
    assert.equal(f.api.calls.some(row => /ПодготовитьДействие|ВыполнитьДействие|СписокПодписей/.test(row.method)), false);
    const count = f.api.calls.length;
    await f.action('arrive'); assert.equal(f.api.calls.length, count);
    await f.run(); assert.equal(f.api.writes('TransportOrder').length, 2);
    const before = f.api.calls.length;
    await assert.rejects(runTripSabyWorkflow({ base: f.base, store: f.store, tripId: f.tripId, authorize: () => undefined, prepare: integrationPrepare, client: new SabyClient(f.config, f.api.send), createDelivery: neverCreate, signingStart: { requestedBy: f.created.ownerId, request: { requestId: 'synthetic-request-123456', previewToken: 'e'.repeat(64), senderSignatureId: 'a'.repeat(40), carrierSignatureId: 'b'.repeat(40), confirmed: true } } }), /после масс/);
    assert.equal(f.api.calls.length, before);
    const saved = await f.store.read(f.source);
    assert.deepEqual(saved.shipments[f.trip.customers[0].id], legacy);
    assert.equal(saved.tripSaby?.trips[f.legacyTripId], undefined);
    assert.equal((await f.read()).archived, false);
  } finally { await f.close(); }
});

test('departure before first dispatch still writes incomplete draft then enriches the same ID exactly once', async () => {
  const f = await fixture();
  try {
    const queued = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(queued.snapshot.allowedPickupAt, '2027-02-03T19:15:00');
    await f.action('arrive'); await f.action('depart');
    const dispatched = await dispatchTripSaby({ base: f.base, store: f.store, config: f.config, enabled: true, prepare: integrationPrepare, send: f.api.send });
    assert.equal(dispatched.continued, 1);
    const record = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(record.driverFlow?.state, 'ready', record.lastError ?? '');
    assert.equal(f.api.docs.size, 1); assert.equal(f.api.reserves('TransportOrder').length, 1); assert.equal(f.api.writes('TransportOrder').length, 2); assert.equal(massWrites(f.api).length, 1);
    const [, first] = f.api.writes('TransportOrder'); const [updated] = massWrites(f.api);
    assert.doesNotMatch(decodeUpload(first), /МасБрутЗнач|МасНетто/);
    assert.deepEqual(Object.keys(updated.params.Документ).sort(), ['Вложение', 'Редакция']);
    assert.deepEqual(updated.params.Документ.Редакция, { Идентификатор: record.driverFlow!.draftAttachment!.revision });
    assert.equal((updated.params.Документ.Вложение as SabyObject[])[0].Идентификатор, record.driverFlow!.draftAttachment!.id);
    assert.equal(((updated.params.Документ.Вложение as SabyObject[])[0].Файл as SabyObject).Имя, record.driverFlow!.draftAttachment!.name);
    const xml = decodeUpload(updated); assert.match(xml, /МасНетЗнач="2123\.456"/); assert.match(xml, /МасНетЗнач="9654\.321"/);
    assert.equal(xml.match(/<ПунктПод\s[^>]*>/)?.[0], decodeUpload(first).match(/<ПунктПод\s[^>]*>/)?.[0]);
    assert.equal(record.snapshot.allowedPickupAt, queued.snapshot.allowedPickupAt);
    assert.equal(record.driverFlow!.draftSnapshot!.allowedPickupAt, queued.snapshot.allowedPickupAt);
    assert.equal(record.snapshot.fields.quantity_tonnes, '11.777777');
    assert.deepEqual(record.deliveries.map(row => row.snapshot.profile.loading?.grossMassTonnes), ['2.123456', '9.654321']);
    assert.ok(record.driverFlow?.draftAttachment); assert.ok(record.driverFlow?.massUpdateAttempted);
    assert.ok(f.api.calls.some(row => !['СБИС.СписокНашихОрганизаций', 'СБИС.ЗаписатьДокумент', 'СБИС.ПрочитатьДокумент', 'СБИС.СписокДокументов'].includes(row.method)), 'automatic signing should be attempted only after same-ID mass readback');
    await f.run(f.api.send, new OperationsStore(dirname(f.store.path)));
    assert.equal(f.api.writes('TransportOrder').length, 2); assert.equal(massWrites(f.api).length, 1);
    assert.equal((await f.read()).archived, false);
  } finally { await f.close(); }
});

test('lost successful mass update response recovers by readback without repeating Write or reserve', async () => {
  const f = await fixture(); let lost = false;
  try {
    await f.run(); await f.action('arrive'); await f.action('depart');
    const send: typeof fetch = async (url, init) => {
      const response = await f.api.send(url, init);
      if (init?.method !== 'GET') {
        const req = JSON.parse(String(init?.body)) as IntegrationRpc;
        if (req.method === 'СБИС.ЗаписатьВложение' && !lost) { lost = true; throw new Error('synthetic-lost-response'); }
      }
      return response;
    };
    const unknown = await f.run(send); assert.equal(unknown.phase, 'unknown'); assert.equal(lost, true);
    assert.equal(f.api.writes('TransportOrder').length, 2); assert.equal(massWrites(f.api).length, 1);
    const before = (await f.store.read(f.source)).tripSaby!.trips[f.tripId]; assert.equal(before.driverFlow?.massUpdateAttempted, true);
    await f.run(f.api.send, new OperationsStore(dirname(f.store.path)));
    const after = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(after.driverFlow?.state, 'ready', after.lastError ?? '');
    assert.equal(after.order.id, before.order.id); assert.equal(f.api.writes('TransportOrder').length, 2); assert.equal(massWrites(f.api).length, 1); assert.equal(f.api.docs.size, 1);
    assert.deepEqual(after.driverFlow?.massUpdateFailure, { method: 'СБИС.ЗаписатьВложение', phase: 'dispatch', category: 'transport' });
  } finally { await f.close(); }
});

test('uncertain mass update that did not reach Saby never retries the mutation', async () => {
  const f = await fixture(); let attempts = 0;
  try {
    await f.run(); await f.action('arrive'); await f.action('depart');
    const send: typeof fetch = async (url, init) => {
      if (init?.method !== 'GET') {
        const req = JSON.parse(String(init?.body)) as IntegrationRpc;
        if (req.method === 'СБИС.ЗаписатьВложение') { attempts++; throw new Error('synthetic-network-before-send'); }
      }
      return f.api.send(url, init);
    };
    await f.run(send); assert.equal(attempts, 1);
    await f.run(send); await f.run(f.api.send);
    assert.equal(attempts, 1); assert.equal(f.api.writes('TransportOrder').length, 2);
    const record = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(record.driverFlow?.state, 'mass_pending'); assert.equal(record.phase, 'unknown');
    assert.match(record.lastError!, /прежний черновик без масс/);
  } finally { await f.close(); }
});

test('HTTP 500 preserves first mass update diagnostic through read-only polls of the unchanged draft', async () => {
  const f = await fixture(); let attempts = 0;
  try {
    await f.run(); await f.action('arrive'); await f.action('depart');
    const send: typeof fetch = async (url, init) => {
      if (init?.method !== 'GET' && (JSON.parse(String(init?.body)) as IntegrationRpc).method === 'СБИС.ЗаписатьВложение') { attempts++; return new Response('private provider payload must never persist', { status: 500 }); }
      return f.api.send(url, init);
    };
    const failed = await f.run(send); assert.match(failed.lastError!, /HTTP 500/);
    await f.run(send, new OperationsStore(dirname(f.store.path))); await f.run(send);
    const data = await f.store.read(f.source); const record = data.tripSaby!.trips[f.tripId];
    assert.equal(attempts, 1); assert.equal(massWrites(f.api).length, 0); assert.equal(f.api.writes('TransportOrder').length, 2);
    assert.equal(record.phase, 'unknown'); assert.equal(record.driverFlow?.state, 'mass_pending');
    assert.match(record.lastError!, /прежний черновик без масс/); assert.doesNotMatch(record.lastError!, /груз|private/);
    assert.deepEqual(record.driverFlow?.massUpdateFailure, { method: 'СБИС.ЗаписатьВложение', phase: 'response', category: 'transport', httpStatus: 500 });
    assert.equal(record.signing, undefined); assert.ok(data.driverTripProgress![f.tripId].departedAt);
    assert.doesNotThrow(() => validateTripSabyData(data.tripSaby));
    const tampered = structuredClone(data.tripSaby!);
    Object.assign(tampered.trips[f.tripId].driverFlow!.massUpdateFailure!, { message: 'private provider payload' });
    assert.throws(() => validateTripSabyData(tampered), /diagnostic/);
  } finally { await f.close(); }
});

test('existing mass WriteDocument attempt remains reconciliation-only after changing the RPC', async () => {
  const f = await fixture();
  try {
    await f.run(); await f.action('arrive'); await f.action('depart');
    await f.run(async (url, init) => {
      if (init?.method !== 'GET' && (JSON.parse(String(init?.body)) as IntegrationRpc).method === 'СБИС.ЗаписатьВложение') throw new Error('synthetic-uncertain');
      return f.api.send(url, init);
    });
    await f.store.mutate(f.source, data => {
      // Model the legacy persisted intent, which had no structured mutation diagnostic.
      delete data.tripSaby!.trips[f.tripId].driverFlow!.massUpdateFailure;
      return { result: undefined, changed: true };
    });
    await f.run(); await f.run();
    const record = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(record.driverFlow?.massUpdateAttempted, true); assert.equal(record.driverFlow?.massUpdateFailure, undefined);
    assert.equal(record.driverFlow?.state, 'mass_pending'); assert.equal(record.phase, 'unknown');
    assert.equal(massWrites(f.api).length, 0); assert.equal(f.api.writes('TransportOrder').length, 2);
    assert.match(record.lastError!, /прежний черновик без масс/);
  } finally { await f.close(); }
});

test('manual Saby revision or attachment change stops mass overwrite and retains driver facts', async () => {
  for (const change of ['revision', 'attachment', 'signature', 'name', 'hash'] as const) {
    const f = await fixture();
    try {
      await f.run(); await f.action('arrive'); await f.action('depart');
      const record = (await f.store.read(f.source)).tripSaby!.trips[f.tripId]; const remote = f.api.docs.get(record.order.id!)!;
      if (change === 'revision') remote.Редакция = [{ Идентификатор: 'manual-revision', Актуален: 'Да' }];
      if (change === 'attachment') (remote.Вложение as SabyObject[]).push({ Идентификатор: 'manual-attachment', Файл: { Имя: 'manual.pdf' } });
      if (change === 'signature') (remote.Вложение as SabyObject[])[0].Подпись = [{ Сертификат: { Отпечаток: 'synthetic-manual-signature' } }];
      if (change === 'name') ((remote.Вложение as SabyObject[])[0].Файл as SabyObject).Имя = 'renamed.xml';
      const send: typeof fetch = async (url, init) => {
        const response = await f.api.send(url, init);
        return change === 'hash' && init?.method === 'GET' ? new Response(Buffer.concat([Buffer.from(await response.arrayBuffer()), Buffer.from(' ')])) : response;
      };
      const result = await f.run(send); assert.equal(result.phase, 'error', `${change}: ${result.lastError}`);
      assert.equal(f.api.writes('TransportOrder').length, 2); assert.equal(f.api.docs.size, 1);
      assert.equal(massWrites(f.api).length, 0);
      const after = await f.store.read(f.source); assert.ok(after.driverTripProgress![f.tripId].departedAt);
      assert.equal(after.tripSaby!.trips[f.tripId].driverFlow?.massUpdateAttempted, undefined);
      assert.equal(after.tripSaby!.trips[f.tripId].signing, undefined);
    } finally { await f.close(); }
  }
});

test('mass write readback must retain document, revision, single attachment identity and no signature', async () => {
  for (const change of ['document', 'revision', 'attachment-id', 'extra-attachment', 'signature', 'name', 'business'] as const) {
    const f = await fixture();
    try {
      await f.run(); await f.action('arrive'); await f.action('depart');
      let updated = false;
      const send: typeof fetch = async (url, init) => {
        const response = await f.api.send(url, init);
        if (init?.method !== 'GET' && (JSON.parse(String(init?.body)) as IntegrationRpc).method === 'СБИС.ЗаписатьВложение') {
          updated = true;
          const remote = [...f.api.docs.values()][0]; const files = remote.Вложение as SabyObject[];
          if (change === 'document') remote.Идентификатор = 'different-document';
          if (change === 'revision') remote.Редакция = [{ Идентификатор: 'different-revision', Актуален: 'Да' }];
          if (change === 'attachment-id') files[0].Идентификатор = 'different-attachment';
          if (change === 'extra-attachment') files.push({ Идентификатор: 'extra-attachment', Файл: { Имя: 'manual.pdf' } });
          if (change === 'signature') files[0].Подпись = [{ Сертификат: { Отпечаток: 'synthetic-signature' } }];
          if (change === 'name') (files[0].Файл as SabyObject).Имя = 'different-name.xml';
        }
        if (change === 'business' && updated && init?.method === 'GET') return new Response(Buffer.from(Buffer.from(await response.arrayBuffer()).toString('latin1').replace('2123.456', '3123.456'), 'latin1'));
        return response;
      };
      await f.run(send); await f.run(send);
      const record = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
      assert.equal(record.driverFlow?.state, 'mass_pending', change); assert.equal(record.signing, undefined, change);
      assert.equal(record.driverFlow?.massUpdateAttempted, true); assert.equal(massWrites(f.api).length, 1);
      assert.equal(f.api.writes('TransportOrder').length, 2); assert.equal(f.api.docs.size, 1);
    } finally { await f.close(); }
  }
});

test('a frozen provider filename inconsistent with generated file ID stops before mass write', async () => {
  const f = await fixture();
  try {
    await f.run(); await f.action('arrive'); await f.action('depart');
    const record = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    const remote = f.api.docs.get(record.order.id!)!;
    ((remote.Вложение as SabyObject[])[0].Файл as SabyObject).Имя = 'provider-renamed.xml';
    await f.store.mutate(f.source, data => {
      data.tripSaby!.trips[f.tripId].driverFlow!.draftAttachment!.name = 'provider-renamed.xml';
      return { result: undefined, changed: true };
    });
    const response = await f.run(); assert.match(response.lastError!, /идентификатором файла/);
    const after = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(after.driverFlow?.massUpdateAttempted, undefined); assert.equal(after.signing, undefined);
    assert.equal(massWrites(f.api).length, 0); assert.equal(f.api.writes('TransportOrder').length, 2);
  } finally { await f.close(); }
});

test('lost number reservation never makes a duplicate and untouched legacy trips never enroll', async () => {
  const f = await fixture(); let lost = false;
  try {
    const send: typeof fetch = async (url, init) => {
      const response = await f.api.send(url, init);
      if (init?.method !== 'GET') {
        const req = JSON.parse(String(init?.body)) as IntegrationRpc;
        if (req.method === 'СБИС.ЗаписатьДокумент' && !req.params.Документ.Идентификатор && !lost) { lost = true; throw new Error('synthetic-reservation-response'); }
      }
      return response;
    };
    assert.equal((await f.run(send)).phase, 'unknown'); assert.equal(f.api.writes().length, 1);
    const [id, doc] = [...f.api.docs][0]; f.api.docs.clear();
    assert.equal((await f.run()).phase, 'unknown'); assert.equal(f.api.writes().length, 1);
    f.api.docs.set(id, doc); assert.equal((await f.run()).phase, 'awaiting_driver');
    assert.equal(f.api.reserves().length, 1); assert.equal(f.api.writes().length, 2);
    assert.deepEqual(Object.keys((await f.store.read(f.source)).tripSaby!.trips), [f.tripId]);
  } finally { await f.close(); }
});

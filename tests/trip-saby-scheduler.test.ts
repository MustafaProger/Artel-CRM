import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createTripSabyScheduler, dispatchTripSaby, SABY_COMPLETED_REFRESH_MS, SABY_WORKFLOW_TICK_MS } from '../server/trip-saby-scheduler';
import { getTripSabyWorkflow, runTripSabyWorkflow } from '../server/trip-saby-workflow';
import { exchangePreparedEtrn, saveTripLoadingFacts } from '../server/etrn-service';
import { integrationApi, integrationConfig, integrationRuntime } from './helpers/trip-saby-integration';
import { saveShipmentTrip } from '../server/shipment-trips';

const gate = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
async function until(check: () => boolean) { const end = Date.now() + 3_000; while (!check()) { if (Date.now() > end) throw new Error('Synthetic scheduler did not make progress'); await new Promise(done => setTimeout(done, 5)); } }

async function fixture() {
  const runtime = await integrationRuntime(); const api = integrationApi();
  await runtime.store.mutate(runtime.source, data => {
    const common = { active: true, managerId: null, version: 1, passwordHash: 'a'.repeat(128), salt: 'b'.repeat(32) };
    data.accounts = { users: [{ ...common, id: 'director', name: 'Тест', login: 'director', role: 'director' }, { ...common, id: 'initiator', name: 'Тест', login: 'initiator', role: 'admin' }], sessions: [], attempts: {} };
    return { result: null, changed: true };
  });
  const context = { ...runtime, client: api.client() };
  const start = () => runTripSabyWorkflow({ ...context, initiatorId: 'initiator', createDelivery: input => exchangePreparedEtrn(context, input) });
  const tick = (extra: Partial<Parameters<typeof dispatchTripSaby>[0]> = {}) => dispatchTripSaby({ ...runtime, config: integrationConfig(), enabled: true, send: api.send, ...extra });
  return { ...runtime, api, context, start, tick };
}

async function addStartedTrip(f: Awaited<ReturnType<typeof fixture>>) {
  const created = await f.store.mutate(f.source, data => ({ result: saveShipmentTrip(f.base, data, {
    fields: { organization_id: 'artel', date: '2025-04-01', supplier_id: 'supplier', carrier_id: 'carrier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000', quantity_tonnes: '12', quantity_gross_tonnes: '12', driver_id: 'driver', vehicle_id: 'vehicle', loading_planned_at: '2025-04-01T09:00', additional_costs: '0' },
    customers: [{ fields: { customer_id: 'customer', manager_id: 'manager', payment_form_id: 'payment', quantity_litres: '8000', sale_price_per_litre: '60', transport_amount: '1000', unloading_address_id: 'delivery' } }],
  }), changed: true }));
  const context = { ...f.context, tripId: created.trip.id };
  await runTripSabyWorkflow({ ...context, initiatorId: 'initiator', createDelivery: input => exchangePreparedEtrn(context, input) });
  return created.trip.id;
}

test('independent trip passes and subsequent scans reuse only the two account sessions', async () => {
  const f = await fixture(); const auth = new Map<string, number>();
  let scheduler: ReturnType<typeof createTripSabyScheduler> | undefined;
  try {
    await f.start(); for (let i = 0; i < 3; i++) await addStartedTrip(f);
    const config = { ...integrationConfig(), sessionId: undefined, login: 'synthetic-user', password: 'synthetic-password', accountNumber: 'sender-account', carrierAccountNumber: 'carrier-account' };
    const send: typeof fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body));
      if (request.method === 'СБИС.Аутентифицировать') {
        const account = request.params.Параметр.НомерАккаунта; auth.set(account, (auth.get(account) ?? 0) + 1);
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: `${account}-session` }));
      }
      return f.api.send(input, init);
    };
    scheduler = createTripSabyScheduler({ ...f, config, enabled: true, send });
    await scheduler.tick(); await scheduler.drain(); await scheduler.tick(); await scheduler.drain();
    await scheduler.client.withRequestGuard(async () => undefined).readTransportOrder((await f.store.read(f.source)).tripSaby!.trips[f.tripId].order.id!);
    assert.deepEqual([...auth.entries()].sort(), [['carrier-account', 1], ['sender-account', 1]]);
    assert.equal(f.api.reserves('TransportOrder').length, 4);
  } finally { await scheduler?.stop(); await f.close(); }
});

test('independent scans continue existing and newly added trips while an earlier provider workflow is blocked', async () => {
  const f = await fixture(), blocked = gate();
  let scheduler: ReturnType<typeof createTripSabyScheduler> | undefined;
  try {
    await f.start(); const second = await addStartedTrip(f);
    const orderId = (await f.store.read(f.source)).tripSaby!.trips[f.tripId].order.id;
    let held = false; const observed = new Set<string>();
    const send: typeof fetch = async (input, init) => {
      const request = JSON.parse(String(init?.body));
      const id = request.params?.Документ?.Идентификатор;
      if (request.method === 'СБИС.ПрочитатьДокумент') {
        observed.add(id);
        if (id === orderId && !held) { held = true; await blocked.promise; }
      }
      return f.api.send(input, init);
    };
    scheduler = createTripSabyScheduler({ ...f, config: integrationConfig(), enabled: true, send }, 2);
    await scheduler.tick();
    const secondId = (await f.store.read(f.source)).tripSaby!.trips[second].order.id!;
    await until(() => held && observed.has(secondId));
    const third = await addStartedTrip(f);
    const thirdId = (await f.store.read(f.source)).tripSaby!.trips[third].order.id!;
    await scheduler.tick(); await until(() => observed.has(thirdId));
    assert.equal(held, true, 'new work progressed before the old response was released');
    blocked.release(); await scheduler.drain();
    assert.equal(f.api.reserves('TransportOrder').length, 3);
  } finally { blocked.release(); await scheduler?.stop(); await f.close(); }
});

test('timer ticks are coalesced; repeated immediate signals cause one fresh pass without duplicate documents', async () => {
  const f = await fixture(), blocked = gate();
  let scheduler: ReturnType<typeof createTripSabyScheduler> | undefined;
  try {
    await f.start(); let held = false, reads = 0;
    const send: typeof fetch = async (input, init) => {
      if (JSON.parse(String(init?.body)).method === 'СБИС.ПрочитатьДокумент') { reads++; if (!held) { held = true; await blocked.promise; } }
      return f.api.send(input, init);
    };
    scheduler = createTripSabyScheduler({ ...f, config: integrationConfig(), enabled: true, send });
    await scheduler.tick(); await until(() => held);
    for (let i = 0; i < 8; i++) await scheduler.tick();
    for (let i = 0; i < 8; i++) scheduler.request(f.tripId);
    blocked.release(); await scheduler.drain();
    assert.equal(reads, 2);
    assert.equal(f.api.reserves('TransportOrder').length, 1);
  } finally { blocked.release(); await scheduler?.stop(); await f.close(); }
});

test('queued network slots recheck revoked access and shutdown drains active work without starting new passes', async () => {
  for (const stop of [false, true]) {
    const f = await fixture(), blocked = gate();
    let scheduler: ReturnType<typeof createTripSabyScheduler> | undefined;
    try {
      await f.start(); await addStartedTrip(f); let calls = 0;
      const send: typeof fetch = async (input, init) => { calls++; await blocked.promise; return f.api.send(input, init); };
      scheduler = createTripSabyScheduler({ ...f, config: integrationConfig(), enabled: true, send }, 1);
      await scheduler.tick(); await until(() => calls === 1);
      let stopping: Promise<void> | undefined;
      if (stop) stopping = scheduler.stop();
      else await f.store.mutate(f.source, data => { data.accounts!.users[1].active = false; return { result: null, changed: true }; });
      blocked.release(); await (stopping ?? scheduler.drain());
      if (stop) {
        assert.ok(calls > 1, 'already-started workflow requests must settle during graceful shutdown');
        const completedCalls = calls; await scheduler.tick(); scheduler.request(f.tripId); await scheduler.drain(); assert.equal(calls, completedCalls);
      } else assert.equal(calls, 1, 'authority is rechecked after acquiring capacity');
    } finally { blocked.release(); await scheduler?.stop(); await f.close(); }
  }
});

test('scheduler never initiates a trip and disabled or missing-credential ticks perform no network', async () => {
  const f = await fixture();
  try {
    await f.tick(); assert.equal(f.api.calls.length, 0);
    await f.start(); const before = f.api.calls.length;
    await f.tick({ enabled: false });
    await f.tick({ config: { ...integrationConfig(), sessionId: undefined } });
    assert.equal(f.api.calls.length, before);
    assert.equal((await f.store.read(f.source)).tripSaby!.trips[f.tripId].initiatorId, 'initiator');
  } finally { await f.close(); }
});

test('background waits for carrier then facts and creates each delivery once without browser or actions', async () => {
  const f = await fixture();
  try {
    await f.start(); await f.tick(); assert.equal(f.api.reserves('ConsignmentNote').length, 0);
    f.api.accept(); await f.tick();
    assert.equal((await f.store.read(f.source)).tripSaby!.trips[f.tripId].phase, 'awaiting_loading');
    const before = f.api.calls.length; await f.tick(); assert.ok(f.api.calls.length > before); assert.equal(f.api.reserves('ConsignmentNote').length, 0);
    await saveTripLoadingFacts(f.context, f.facts(), 'initiator');
    await Promise.all([f.tick(), f.tick()]);
    const saved = await f.store.read(f.source); assert.equal(saved.tripSaby!.trips[f.tripId].phase, 'completed');
    assert.equal(f.api.reserves('TransportOrder').length, 1); assert.equal(f.api.reserves('ConsignmentNote').length, 2);
    assert.ok(!f.api.calls.some(call => /Подпис|ВыполнитьДействие|ПодготовитьДействие/.test(call.method)));
    const calls = f.api.calls.length; await f.tick(); assert.equal(f.api.calls.length, calls);
    const result = await f.tick({ now: Date.now() + SABY_COMPLETED_REFRESH_MS + 1_000 });
    assert.equal(result.refreshed, 2); assert.equal(f.api.reserves('ConsignmentNote').length, 2);
    assert.equal(SABY_WORKFLOW_TICK_MS, 60_000);
    assert.equal(SABY_COMPLETED_REFRESH_MS, 60_000);
    assert.ok((await f.store.read(f.source)).tripSaby!.trips[f.tripId].lastCheckedAt);
  } finally { await f.close(); }
});

test('missing initiator, inactive, deleted, section-revoked and ownership-revoked users make no requests', async () => {
  const f = await fixture();
  try {
    await f.start(); const initial = f.api.calls.length;
    const run = async (mutate: (data: Awaited<ReturnType<typeof f.store.read>>) => void) => {
      await f.store.mutate(f.source, data => { mutate(data); return { result: null, changed: true }; });
      await f.tick(); assert.equal(f.api.calls.length, initial);
    };
    await run(data => { delete data.tripSaby!.trips[f.tripId].initiatorId; });
    await run(data => { data.tripSaby!.trips[f.tripId].initiatorId = 'initiator'; data.accounts!.users[1].active = false; });
    await run(data => { data.accounts!.users[1].deletedAt = new Date().toISOString(); data.accounts!.users[1].deletedBy = 'director'; });
    await run(data => { const user = data.accounts!.users[1]; delete user.deletedAt; delete user.deletedBy; user.active = true; user.role = 'manager'; user.sections = []; });
    await run(data => { data.accounts!.users[1].sections = ['trips']; data.accounts!.users[1].managerId = 'unassigned-manager'; });
  } finally { await f.close(); }
});

test('permission revoked after one response prevents the next network request', async () => {
  const f = await fixture();
  try {
    await f.start(); let sent = 0;
    const send: typeof fetch = async (input, init) => {
      sent++; const response = await f.api.send(input, init);
      await f.store.mutate(f.source, data => { data.accounts!.users[1].active = false; return { result: null, changed: true }; });
      return response;
    };
    await f.tick({ send }); assert.equal(sent, 1);
    assert.equal(f.api.reserves('TransportOrder').length, 1); assert.equal(f.api.reserves('ConsignmentNote').length, 0);
  } finally { await f.close(); }
});

test('expired submission recovers existing reservation without another document', async () => {
  const f = await fixture();
  try {
    await f.start();
    await f.store.mutate(f.source, data => {
      const record = data.tripSaby!.trips[f.tripId]; record.phase = 'submitting'; record.leaseId = 'expired'; record.leaseUntil = '2000-01-01T00:00:00.000Z';
      return { result: null, changed: true };
    });
    await f.tick(); assert.equal(f.api.reserves('TransportOrder').length, 1);
    assert.equal((await f.store.read(f.source)).tripSaby!.trips[f.tripId].phase, 'awaiting_carrier');
  } finally { await f.close(); }
});

test('monitoring status reflects runtime switch and revoked rights; terminal failures are not polled', async () => {
  const f = await fixture();
  const response = async (monitoringEnabled: boolean) => getTripSabyWorkflow({ ...f, data: await f.store.read(f.source), config: integrationConfig(), monitoringEnabled });
  try {
    assert.equal((await response(true)).monitoring.enabled, false);
    await f.start();
    assert.equal((await response(false)).monitoring.enabled, false);
    assert.deepEqual((await response(true)).monitoring, { enabled: true, intervalSeconds: 60 });
    const doc = [...f.api.docs.values()].find(row => row.Тип === 'TransportOrder')!;
    delete doc.Код; doc.Состояние = { Код: '22', Название: 'Аннулировано' };
    await f.tick(); const stopped = await response(true);
    assert.equal(stopped.phase, 'error'); assert.equal(stopped.monitoring.enabled, false); assert.equal(stopped.order?.exchangeStage, 'cancelled');
    const calls = f.api.calls.length; await f.tick(); assert.equal(f.api.calls.length, calls);
    await f.store.mutate(f.source, data => { data.tripSaby!.trips[f.tripId].phase = 'awaiting_carrier'; data.accounts!.users[1].active = false; return { result: null, changed: true }; });
    assert.equal((await response(true)).monitoring.enabled, false); await f.tick(); assert.equal(f.api.calls.length, calls);
  } finally { await f.close(); }
});

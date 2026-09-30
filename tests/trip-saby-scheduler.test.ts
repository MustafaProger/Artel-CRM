import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dispatchTripSaby, SABY_COMPLETED_REFRESH_MS } from '../server/trip-saby-scheduler';
import { getTripSabyWorkflow, runTripSabyWorkflow } from '../server/trip-saby-workflow';
import { exchangePreparedEtrn, saveTripLoadingFacts } from '../server/etrn-service';
import { integrationApi, integrationConfig, integrationRuntime } from './helpers/trip-saby-integration';

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

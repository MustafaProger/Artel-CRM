import assert from 'node:assert/strict';
import test from 'node:test';
import { afterDriverFixture } from './helpers/after-driver-fixture';
import { dispatchTripSaby, createTripSabyScheduler } from '../server/trip-saby-scheduler';
import { integrationPrepare } from './helpers/trip-saby-integration';
import { OperationsStore } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { workflowView } from '../web/src/trip-workflow-view';

async function fixture() {
  const f = await afterDriverFixture(true);
  await f.patch(['100', '200']);
  const access = await f.raw('/api/drivers/driver/access', 'POST', { version: 0, action: 'issue' });
  assert.equal(access.status, 200, JSON.stringify(access.body));
  const login = await f.raw('/api/auth/login', 'POST', { login: access.body.access.login, password: access.body.temporaryPassword });
  assert.equal(login.status, 200);
  const driver = (action = '', method = 'GET', input?: unknown) => f.raw(`/api/driver/trips/${f.tripId}${action ? '/' + action : ''}`, method, input, login.cookie!);
  const action = async (kind: 'arrive' | 'depart', versions?: Record<string, number>) => {
    const read = await driver(); assert.equal(read.status, 200);
    return driver(kind, 'POST', { versions: versions ?? read.body.trip.versions, ...(kind === 'depart' ? { masses: read.body.trip.deliveries.map((row: { id: string }, index: number) => ({ deliveryId: row.id, netTonnes: index ? '0.17' : '0.085' })) } : {}) });
  };
  const dispatch = (store = f.store) => dispatchTripSaby({ base: f.base, store, config: f.config, enabled: true, prepare: integrationPrepare, send: f.api.send, tripId: f.tripId });
  return { ...f, driver, action, dispatch };
}

test('save, repeated reads, arrival and scheduler restart make zero Saby calls; manual early start is denied', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.preview()).start, undefined);
    assert.match(workflowView(await f.preview()).title, /Ожидаем данные водителя/);
    for (const stage of ['before', 'arrived']) {
      if (stage === 'arrived') assert.equal((await f.action('arrive')).status, 200);
      await f.dispatch(new OperationsStore(f.directory + '/store'));
      const scheduler = createTripSabyScheduler({ base: f.base, store: f.store, config: f.config, enabled: true, prepare: integrationPrepare, send: f.api.send });
      await scheduler.tick(); scheduler.request(f.tripId); await scheduler.drain(); await scheduler.stop();
      const start = await f.http(f.path + '/start', 'POST', { mode: 'draft', previewToken: 'a'.repeat(64) });
      assert.equal(start.status, 409, JSON.stringify(start.body));
      assert.equal((await f.http(f.path, 'POST', {})).status, 409);
      assert.equal((await f.store.read(f.source)).tripSaby?.trips[f.tripId], undefined);
      assert.equal(f.api.calls.length, 0);
    }
  } finally { await f.close(); }
});

test('edit after arrival archives old confirmation; stale driver cannot depart; new confirmation queues once under employee authority', async () => {
  const f = await fixture();
  try {
    assert.equal((await f.action('arrive')).status, 200);
    const old = (await f.driver()).body.trip, before = await f.store.read(f.source);
    await f.patch(['120', '240']);
    const edited = await f.store.read(f.source);
    assert.deepEqual(edited.etrn!.trips[f.tripId].arrivalHistory![0].progress, before.driverTripProgress![f.tripId]);
    assert.equal(edited.driverTripProgress?.[f.tripId], undefined);
    assert.equal((await f.action('depart', old.versions)).status, 409);
    assert.equal((await f.action('arrive')).status, 200);
    assert.equal((await f.action('depart', old.versions)).status, 409);
    const response = await f.action('depart'); assert.equal(response.status, 200, JSON.stringify(response.body));
    const queued = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(queued.initiatorId, f.actor.id); assert.equal(queued.order.id, null);
    assert.ok(queued.driverFlow!.authorizedDepartureHash);
    assert.equal(queued.snapshot.fields.quantity_litres, '360');
    const replay = await f.action('depart'); assert.equal(replay.status, 200);
    assert.deepEqual((await f.store.read(f.source)).tripSaby!.trips[f.tripId], queued);
    await f.dispatch(new OperationsStore(f.directory + '/store'));
    assert.equal(f.api.reserves('TransportOrder').length, 1);
    const saved = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(saved.driverFlow?.state, 'ready', saved.lastError ?? '');
    assert.deepEqual(saved.deliveries.map(row => row.snapshot.profile.loading?.grossMassTonnes), ['0.085', '0.17']);
    await f.dispatch(); assert.equal(f.api.reserves('TransportOrder').length, 1);
    const trip = (await f.http('/' + f.tripId)).body.trip;
    assert.equal((await f.http('/' + f.tripId, 'DELETE', { versions: Object.fromEntries(trip.customers.map((row: {id: string; version: number}) => [row.id, row.version])) })).status, 409);
  } finally { await f.close(); }
});

test('delete after arrival keeps recorded facts, prevents stale departure and sends nothing', async () => {
  const f = await fixture();
  try {
    await f.action('arrive'); const before = await f.store.read(f.source);
    const rows = currentSnapshot(f.base, before).shipments.filter(row => row.fields.trip_id === f.tripId);
    const response = await f.http('/' + f.tripId, 'DELETE', { versions: Object.fromEntries(rows.map(row => [row.id, row.version])) });
    assert.equal(response.status, 200, JSON.stringify(response.body));
    assert.equal((await f.driver('depart', 'POST', { versions: {}, masses: [] })).status, 404);
    await f.dispatch();
    const after = await f.store.read(f.source);
    assert.deepEqual(after.driverTripProgress![f.tripId], before.driverTripProgress![f.tripId]);
    assert.equal(after.tripSaby?.trips[f.tripId], undefined); assert.equal(f.api.calls.length, 0);
  } finally { await f.close(); }
});

for (const reason of ['policy', 'access'] as const) test(`${reason} change preserves authenticated departure but blocks automatic send`, async () => {
  const f = await fixture();
  try {
    await f.action('arrive');
    if (reason === 'policy') f.config.automaticSigning!.approvedAt = '2026-11-01T00:00:00.000Z';
    else await f.store.mutate(f.source, data => { const owner = data.accounts!.users.find(row => row.id === f.actor.id)!; data.accounts!.users.push({ ...owner, id: 'other-director', login: 'other-director' }); owner.active = false; return { result: null, changed: true }; });
    const departed = await f.action('depart'); assert.equal(departed.status, 200, JSON.stringify(departed.body));
    const data = await f.store.read(f.source);
    assert.ok(data.driverTripProgress![f.tripId].departedAt);
    assert.equal(data.etrn!.trips[f.tripId].sabyAutostart!.state, 'blocked');
    assert.equal(data.tripSaby?.trips[f.tripId], undefined);
    await f.dispatch(); assert.equal(f.api.calls.length, 0);
  } finally { await f.close(); }
});

for (const operation of ['edit', 'delete'] as const) test(`concurrent ${operation} and departure cannot send obsolete or deleted trip`, async () => {
  const f = await fixture();
  try {
    await f.action('arrive'); const driver = (await f.driver()).body.trip;
    const versions = driver.versions;
    const current = (await f.http('/' + f.tripId)).body.trip;
    const mutation = operation === 'delete' ? f.http('/' + f.tripId, 'DELETE', { versions })
      : f.http('/' + f.tripId, 'PATCH', { fields: f.input.fields, customers: current.customers.map((row: {id: string}, index: number) => ({ id: row.id, fields: { ...f.input.customers[index].fields, quantity_litres: '300' } })), versions });
    const [changed, departed] = await Promise.all([mutation, f.driver('depart', 'POST', { versions, masses: driver.deliveries.map((row: {id: string}) => ({ deliveryId: row.id, netTonnes: '0.085' })) })]);
    assert.ok(changed.status === 200 && [404, 409].includes(departed.status) || changed.status === 409 && departed.status === 200, JSON.stringify({ changed, departed }));
    const data = await f.store.read(f.source);
    if (changed.status === 200) { assert.equal(data.tripSaby?.trips[f.tripId], undefined); await f.dispatch(); assert.equal(f.api.calls.length, 0); }
    else assert.ok(data.tripSaby?.trips[f.tripId]?.driverFlow?.authorizedDepartureHash);
  } finally { await f.close(); }
});

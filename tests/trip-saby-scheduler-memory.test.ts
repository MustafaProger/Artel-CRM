import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ApiError } from '../server/api-error';
import type { OperationsData, OperationsStorage } from '../server/operations-store';
import { createTripSabyScheduler, SABY_WORKFLOW_CONCURRENCY } from '../server/trip-saby-scheduler';
import type { Snapshot } from '../web/src/model';
import { integrationConfig } from './helpers/trip-saby-integration';

const turn = () => new Promise<void>(done => setImmediate(done));
async function until(check: () => boolean) {
  const deadline = Date.now() + 3_000;
  while (!check()) { if (Date.now() > deadline) throw new Error('Scheduler admission did not progress'); await turn(); }
}

class ClaimProbe extends Error { constructor(readonly tripId: string) { super('Synthetic lease boundary'); } }

/** The probe stops at the first lease callback, before authorization or any
 * business write. A held callback models a slow pass retaining its full read. */
function fixture(count = 24, workflowConcurrency?: number) {
  const ids = Array.from({ length: count }, (_, index) => `trip-${index}`);
  const raw = JSON.stringify({ schemaVersion: 2, sourceSha256: 'a'.repeat(64), revision: 0, shipments: {}, companies: [],
    etrn: { trips: Object.fromEntries(ids.map(id => [id, { direct: { phase: 'unknown', updatedAt: '2020-01-01T00:00:00.000Z' } }])) },
    // Unrelated archive data is deliberately parsed anew, like the real store.
    padding: 'x'.repeat(1024 * 1024),
  });
  const paused = new Set<string>();
  const claims: { id: string; release: () => void }[] = [];
  let reads = 0, active = 0, peakActive = 0, released = false, networkCalls = 0;
  let nextRead: Promise<void> | undefined;
  const snapshot = () => ({ ...JSON.parse(raw), tripExchangeControls: Object.fromEntries([...paused].map(id => [id, { paused: true }])) }) as OperationsData;
  const store: OperationsStorage = {
    async read() { reads++; const held = nextRead; nextRead = undefined; await held; return snapshot(); },
    async mutate(_source, update) {
      let id: string | undefined;
      try {
        await update({ tripExchangeControls: new Proxy({}, { get: (_target, key) => { throw new ClaimProbe(String(key)); } }) } as OperationsData);
      } catch (error) { assert.ok(error instanceof ClaimProbe); id = error.tripId; }
      assert.ok(id, 'A pass must attempt its own lease');
      let release!: () => void;
      const held = new Promise<void>(done => { release = done; });
      claims.push({ id, release }); active++; peakActive = Math.max(peakActive, active);
      if (released) release();
      try { await held; } finally { active--; }
      throw new ApiError(409, 'Synthetic lease rejected; no data was written');
    },
  };
  const scheduler = createTripSabyScheduler({ base: { provenance: { sourceSha256: 'a'.repeat(64) } } as Snapshot,
    store, config: integrationConfig(), enabled: true,
    send: async () => { networkCalls++; throw new Error('Network is forbidden'); },
  }, 4, workflowConcurrency);
  return { scheduler, ids, claims, paused, reads: () => reads, peakActive: () => peakActive,
    holdNextRead: () => { let release!: () => void; nextRead = new Promise<void>(done => { release = done; }); return release; },
    releaseAll: () => { released = true; for (const claim of claims) claim.release(); },
    verifyNoNetwork: () => assert.equal(networkCalls, 0),
  };
}

test('default workflow admission bounds retained store copies and coalesces timer scans', async () => {
  const f = fixture();
  try {
    assert.equal(SABY_WORKFLOW_CONCURRENCY, 2);
    await f.scheduler.tick(); await until(() => f.claims.length === 2);
    for (let index = 0; index < 8; index++) await f.scheduler.tick();
    await turn();
    assert.equal(f.claims.length, 2, 'Pending trip IDs must not read the store or claim leases');
    assert.equal(f.reads(), 9 + 2, 'Only scans and admitted passes read full store snapshots');
    f.releaseAll(); await f.scheduler.drain();
    assert.deepEqual(f.claims.map(claim => claim.id), f.ids);
    assert.equal(f.peakActive(), 2); f.verifyNoNetwork();
  } finally { f.releaseAll(); await f.scheduler.stop(); }
});

test('FIFO pending work advances before a coalesced immediate rerun', async () => {
  const f = fixture(3, 1);
  try {
    for (const id of f.ids) f.scheduler.request(id);
    await until(() => f.claims.length === 1);
    for (let index = 0; index < 8; index++) { f.scheduler.request(f.ids[0]); f.scheduler.request(f.ids[1]); }
    f.claims[0].release(); await until(() => f.claims.length === 2);
    assert.equal(f.claims[1].id, f.ids[1]);
    f.claims[1].release(); await until(() => f.claims.length === 3);
    assert.equal(f.claims[2].id, f.ids[2]);
    f.claims[2].release(); await until(() => f.claims.length === 4);
    assert.equal(f.claims[3].id, f.ids[0]);
    f.releaseAll(); await f.scheduler.drain();
    assert.deepEqual(f.claims.map(claim => claim.id), [...f.ids, f.ids[0]]);
    assert.equal(f.peakActive(), 1); f.verifyNoNetwork();
  } finally { f.releaseAll(); await f.scheduler.stop(); }
});

test('queued IDs are checked against fresh paused state before acquiring any lease', async () => {
  const f = fixture(3, 1);
  try {
    await f.scheduler.tick(); await until(() => f.claims.length === 1);
    f.paused.add(f.ids[1]); f.releaseAll(); await f.scheduler.drain();
    assert.deepEqual(f.claims.map(claim => claim.id), [f.ids[0], f.ids[2]]);
    f.verifyNoNetwork();
  } finally { f.releaseAll(); await f.scheduler.stop(); }
});

test('shutdown discards unclaimed IDs and drains admitted passes without new reads', async () => {
  const f = fixture();
  try {
    await f.scheduler.tick(); await until(() => f.claims.length === 2);
    f.scheduler.request(f.ids[0]);
    let stopped = false;
    const stopping = f.scheduler.stop().then(() => { stopped = true; });
    await turn(); assert.equal(stopped, false, 'Already admitted lease work must drain');
    f.releaseAll(); await stopping;
    const reads = f.reads();
    await f.scheduler.tick(); f.scheduler.request(f.ids[2]); await f.scheduler.drain();
    assert.equal(f.claims.length, 2); assert.equal(f.reads(), reads); f.verifyNoNetwork();
  } finally { f.releaseAll(); await f.scheduler.stop(); }
});

test('invalid workflow admission limits are rejected', () => {
  for (const limit of [0, -1, 1.5, Infinity, NaN]) assert.throws(() => fixture(1, limit), /Invalid Saby workflow concurrency/);
});

test('a scan completing after shutdown cannot admit pending workflows', async () => {
  const f = fixture(); const releaseRead = f.holdNextRead();
  try {
    const scanning = f.scheduler.tick();
    await until(() => f.reads() === 1);
    let stopped = false;
    const stopping = f.scheduler.stop().then(() => { stopped = true; });
    await turn(); assert.equal(stopped, false, 'Shutdown must await a previously started scan');
    releaseRead(); await scanning; await stopping; await f.scheduler.drain();
    assert.equal(f.claims.length, 0); assert.equal(f.reads(), 1); f.verifyNoNetwork();
  } finally { releaseRead(); f.releaseAll(); await f.scheduler.stop(); }
});

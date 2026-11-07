import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocationReadPool, pollTripRequestLocation } from '../web/src/trip-request-location-poll';
import type { TripRequestLocationResult } from '../web/src/trip-request-map-coordinates';

const found: TripRequestLocationResult = { status: 'found', latitude: 55, longitude: 37, source: 'geocoder', accuracy: 'building' };

test('a pending job remains observed past forty seconds and carries its original fingerprint until found', async () => {
  const controller = new AbortController(), tokens: (string | undefined)[] = [];
  let elapsed = 0;
  const result = await pollTripRequestLocation(async fingerprint => {
    tokens.push(fingerprint);
    return elapsed < 60_000 ? { status: 'pending', message: 'В очереди', fingerprint: 'a'.repeat(64) } : found;
  }, controller.signal, async milliseconds => { elapsed += milliseconds; });
  assert.deepEqual(result, found); assert.equal(elapsed, 60_000);
  assert.equal(tokens[0], undefined); assert.ok(tokens.slice(1).every(token => token === 'a'.repeat(64)));
});

test('closing the consumer aborts pending polling and a final negative result never loops', async () => {
  const controller = new AbortController(); let calls = 0;
  await assert.rejects(pollTripRequestLocation(async () => { calls++; return { status: 'pending', message: 'В очереди' }; }, controller.signal, async () => { controller.abort(new Error('closed')); }), /closed/);
  assert.equal(calls, 1);
  const negative: TripRequestLocationResult = { status: 'not_found', message: 'Уточните адрес' };
  assert.deepEqual(await pollTripRequestLocation(async () => negative, new AbortController().signal, async () => { throw new Error('Must not poll final result'); }), negative);
});


test('removing one target stops its polling while another target remains mounted', async () => {
  const pool = createLocationReadPool<TripRequestLocationResult>();
  const owner = Symbol('map');
  let startedA!: () => void, startedB!: () => void;
  const readyA = new Promise<void>(resolve => { startedA = resolve; });
  const readyB = new Promise<void>(resolve => { startedB = resolve; });
  const signals: Record<string, AbortSignal> = {};
  const calls: Record<string, number> = { a: 0, b: 0 };
  const start = (key: string, ready: () => void) => (controller: AbortController) => {
    signals[key] = controller.signal;
    return pollTripRequestLocation(async () => { calls[key]++; ready(); return { status: 'pending', message: 'В очереди' }; }, controller.signal);
  };
  const a = pool.acquire('a', owner, start('a', startedA));
  const b = pool.acquire('b', owner, start('b', startedB));
  const aCancelled = assert.rejects(a, error => error instanceof Error && error.name === 'AbortError');
  const bCancelled = assert.rejects(b, error => error instanceof Error && error.name === 'AbortError');
  await Promise.all([readyA, readyB]);
  pool.release('a', owner); await aCancelled;
  assert.equal(signals.a.aborted, true); assert.equal(signals.b.aborted, false);
  assert.equal(calls.a, 1);
  pool.release('b', owner); await bCancelled;
});

test('shared target is cancelled only after its last subscriber is removed and may then be replaced', async () => {
  const pool = createLocationReadPool<TripRequestLocationResult>(), map = Symbol('map'), editor = Symbol('editor');
  let signal!: AbortSignal, entered!: () => void;
  const ready = new Promise<void>(resolve => { entered = resolve; });
  const first = pool.acquire('same', map, async controller => {
    signal = controller.signal; entered();
    return pollTripRequestLocation(async () => ({ status: 'pending', message: 'В очереди' }), signal);
  });
  const second = pool.acquire('same', editor, async () => { throw new Error('Duplicate polling'); });
  assert.equal(first, second);
  const cancelled = assert.rejects(first, error => error instanceof Error && error.name === 'AbortError');
  await ready; pool.release('same', map); assert.equal(signal.aborted, false);
  pool.release('same', editor); await cancelled; assert.equal(signal.aborted, true);
  assert.deepEqual(await pool.acquire('same', editor, async () => found), found);
  pool.clear();
});

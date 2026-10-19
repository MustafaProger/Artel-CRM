import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { copyFile, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTripRequestLocations } from '../server/trip-request-locations';
import type { TripRequestLocationResult } from '../web/src/trip-request-map-coordinates';

const found: TripRequestLocationResult = { status: 'found', latitude: 55, longitude: 37, source: 'geocoder', accuracy: 'building', label: 'Синтетическая улица, 1' };

test('durable address projections are network-free on read and survive reopen and transport-cache expiry', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'artel-location-projection-'));
  let now = Date.now(), calls = 0;
  const path = join(folder, 'locations.json');
  const options = { path, namespace: 'test-osm', successTtlMs: null, now: () => now, geocode: async () => { calls++; return found; } };
  try {
    const service = createTripRequestLocations(options);
    assert.equal((await service.read('Улица Пример, 1, Москва')).status, 'pending'); assert.equal(calls, 0);
    assert.deepEqual(await Promise.all([service.resolve('Улица Пример, 1, Москва'), service.resolve('  улица  пример, 1, москва  ')]), [found, found]); assert.equal(calls, 1);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    now += 365 * 86400_000;
    assert.deepEqual(await service.read('Улица Пример, 1, Москва'), found); assert.equal(calls, 1);
    const reopenedPath = join(folder, 'reloaded.json'); await copyFile(path, reopenedPath);
    const reopened = createTripRequestLocations({ ...options, path: reopenedPath });
    assert.deepEqual(await reopened.read('Улица Пример, 1, Москва'), found); assert.equal(calls, 1);
    const childCode = `import { createTripRequestLocations } from ${JSON.stringify(new URL('../server/trip-request-locations.ts', import.meta.url).href)};
      const service = createTripRequestLocations({ path: process.env.PROJECTION_TEST_PATH, namespace: 'test-osm', successTtlMs: null, geocode: async () => { throw new Error('Provider must not run'); } });
      process.stdout.write(JSON.stringify(await service.read('Улица Пример, 1, Москва')));`;
    const child = await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', childCode], { env: { ...process.env, PROJECTION_TEST_PATH: path } });
    assert.deepEqual(JSON.parse(child.stdout), found); // Fresh process: no module-global state survives.
    const entry = Object.values(JSON.parse(await readFile(path, 'utf8')).entries)[0] as Record<string, unknown>;
    assert.equal(entry.retryAfter, null); assert.ok(entry.resolvedAt); assert.equal(entry.address, 'улица пример, 1, москва');
    const changedProvider = createTripRequestLocations({ ...options, namespace: 'other-provider' });
    assert.equal((await changedProvider.read('Улица Пример, 1, Москва')).status, 'pending'); assert.equal(calls, 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('negative addresses use a bounded cooldown, changed text uses a new identity, and provider retention is explicit', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'artel-location-negative-'));
  let now = Date.now(), calls = 0;
  try {
    const service = createTripRequestLocations({ path: join(folder, 'locations.json'), namespace: 'test', successTtlMs: 10_000, now: () => now, geocode: async address => { calls++; return address === 'точный адрес' ? found : { status: 'not_found', message: 'Уточните адрес' }; } });
    await service.resolve('неполный адрес'); await service.resolve('неполный адрес'); assert.equal(calls, 1);
    assert.deepEqual(await service.resolve('точный адрес'), found); assert.equal(calls, 2);
    now += 10_001;
    assert.equal((await service.read('точный адрес')).status, 'pending'); assert.equal(calls, 2);
    await service.resolve('неполный адрес'); assert.equal(calls, 2);
    now += 86400_000; await service.resolve('неполный адрес'); assert.equal(calls, 3);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('legacy provider cache is promoted on first read without a provider call', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'artel-location-legacy-'));
  try {
    let calls = 0;
    const service = createTripRequestLocations({ path: join(folder, 'locations.json'), namespace: 'test-osm', successTtlMs: null, geocode: async () => { calls++; return found; }, peek: async () => found });
    assert.deepEqual(await service.read('Синтетический адрес'), found);
    assert.equal(calls, 0);
    assert.equal(Object.keys(JSON.parse(await readFile(join(folder, 'locations.json'), 'utf8')).entries).length, 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('interactive polling promotes a queued address ahead of directory backfill and never duplicates provider work', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'artel-location-priority-'));
  const calls: string[] = [];
  let entered!: () => void, finish!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const service = createTripRequestLocations({ path: join(folder, 'locations.json'), namespace: 'test', successTtlMs: null, geocode: async address => { calls.push(address); if (address === 'background-0') { entered(); await blocked; } return found; } });
  try {
    const first = service.resolve('background-0', 'background'); await started;
    const backfill = Array.from({ length: 30 }, (_, index) => service.resolve(`background-${index + 1}`, 'background'));
    assert.equal((await service.poll('background-30', 5)).status, 'pending');
    assert.equal((await service.poll('background-30', 5)).status, 'pending');
    finish(); await first;
    assert.deepEqual(await service.poll('background-30'), found);
    await Promise.all(backfill);
    assert.deepEqual(calls.slice(0, 2), ['background-0', 'background-30']);
    assert.equal(calls.filter(address => address === 'background-30').length, 1);
    assert.equal(calls.length, 31);
  } finally { finish(); await rm(folder, { recursive: true, force: true }); }
});

test('explicit retry clears only an unavailable projection and still delegates provider cooldown decisions', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'artel-location-retry-'));
  let calls = 0;
  try {
    const service = createTripRequestLocations({ path: join(folder, 'locations.json'), namespace: 'test', successTtlMs: null, geocode: async address => { calls++; return address === 'missing' ? { status: 'not_found', message: 'Уточните адрес' } : calls === 1 ? { status: 'unavailable', message: 'Попробуйте позже' } : found; } });
    assert.equal((await service.poll('temporary')).status, 'unavailable'); assert.equal(calls, 1);
    assert.equal((await service.poll('temporary')).status, 'unavailable'); assert.equal(calls, 1);
    assert.deepEqual(await service.poll('temporary', 5000, true), found); assert.equal(calls, 2);
    assert.equal((await service.poll('missing')).status, 'not_found'); assert.equal(calls, 3);
    assert.equal((await service.poll('missing', 5000, true)).status, 'not_found'); assert.equal(calls, 3);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

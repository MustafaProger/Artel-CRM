import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createSnapshotMiddleware, type LocalApiOptions } from '../server/local-api';
import { integrationRuntime } from './helpers/trip-saby-integration';
import type { SectionId } from '../web/src/auth-model';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=', 'base64');
const image = () => new Response(png, { headers: { 'Content-Type': 'image/png' } });
const tilePath = '/api/maps/yandex/tiles?x=3&y=2&z=4&scale=1';

async function fixture(options: Pick<LocalApiOptions, 'fetcher' | 'yandexTilesEnvironment'> = {}) {
  const rt = await integrationRuntime();
  const cookies: Record<string, string> = {};
  await rt.store.mutate(rt.source, data => {
    data.accounts = { users: [], sessions: [], attempts: {} };
    const scopes: [string, SectionId[]][] = [['admin', []], ['trips', ['trips']], ['directories', ['directories']], ['none', []], ['driver', []]];
    for (const [name, sections] of scopes) {
      const token = randomBytes(32).toString('hex'); cookies[name] = `artel_session=${token}`;
      data.accounts.users.push({ id: name, name, login: name, role: name === 'admin' ? 'director' : name === 'driver' ? 'driver' : 'employee', managerId: name === 'driver' ? null : 'manager', ...(name === 'driver' ? { driverId: 'driver' } : {}), active: true, version: 1, sections, passwordHash: 'a'.repeat(128), salt: 'b'.repeat(32) });
      data.accounts.sessions.push({ userId: name, hash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 60_000 });
    }
    return { result: null, changed: true };
  });
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, requireAuthentication: false, yandexTilesEnvironment: { YANDEX_TILES_API_KEY: 'SYNTHETIC-SERVER-ONLY-KEY' }, ...options });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path = tilePath, user = 'trips', extra: RequestInit = {}) => fetch(origin + path, { ...extra, headers: { ...(cookies[user] ? { cookie: cookies[user] } : {}), ...extra.headers } });
  return { ...rt, request, async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}

test('Tiles HTTP requires a valid session and map section even when domain test authentication is disabled', async () => {
  let calls = 0;
  const f = await fixture({ fetcher: async () => { calls++; return image(); } });
  try {
    const before = await readFile(f.store.path, 'utf8');
    assert.equal((await f.request(tilePath, 'anonymous')).status, 401);
    assert.equal((await f.request(tilePath, 'none')).status, 403);
    assert.equal((await f.request(tilePath, 'driver')).status, 403);
    assert.equal((await f.request(tilePath, 'trips', { headers: { 'sec-fetch-site': 'cross-site' } })).status, 403);
    assert.equal((await f.request(tilePath, 'trips', { headers: { Origin: 'https://other.invalid' } })).status, 403);
    assert.equal(calls, 0);
    for (const user of ['trips', 'directories', 'admin']) {
      const result = await f.request(tilePath, user);
      assert.equal(result.status, 200); assert.equal(result.headers.get('Content-Type'), 'image/png');
      assert.equal(result.headers.get('Cache-Control'), 'no-store'); assert.equal(result.headers.get('Cross-Origin-Resource-Policy'), 'same-origin');
      assert.deepEqual(Buffer.from(await result.arrayBuffer()), png);
      assert.doesNotMatch(JSON.stringify([...result.headers]), /SYNTHETIC|apikey/);
    }
    assert.equal(calls, 1); assert.equal(await readFile(f.store.path, 'utf8'), before);
  } finally { await f.close(); }
});

test('Tiles HTTP rejects unsupported methods, arbitrary queries and bad coordinates before calling Yandex', async () => {
  let calls = 0;
  const f = await fixture({ fetcher: async () => { calls++; return image(); } });
  try {
    for (const method of ['POST', 'PATCH', 'DELETE', 'HEAD']) assert.equal((await f.request(tilePath, 'trips', { method })).status, 405);
    for (const query of ['x=1&y=0&z=0&scale=1', 'x=0&y=0&z=21&scale=1', 'x=0&y=0&z=0&scale=1&url=https://internal.invalid', 'x=0&y=0&z=0&scale=1&apikey=exfiltrate', 'x=0&y=0&z=0&scale=1&x=0']) {
      assert.equal((await f.request('/api/maps/yandex/tiles?' + query)).status, 400);
    }
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('Tiles HTTP fails clearly with absent key and map metadata never reveals either provider key', async () => {
  let calls = 0;
  const f = await fixture({ yandexTilesEnvironment: {}, fetcher: async () => { calls++; return image(); } });
  try {
    const result = await f.request(); assert.equal(result.status, 503); assert.match((await result.json()).error, /не настроено/);
    const config = await f.request('/api/trip-requests/map-config');
    assert.deepEqual(await config.json(), { provider: 'yandex', configured: false, rendering: 'tiles', projection: 'web_mercator' });
    assert.equal(calls, 0);
  } finally { await f.close(); }
});

test('Tiles HTTP rechecks access after provider latency, including cached requests after revocation', async () => {
  let started!: () => void, release!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; }), wait = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture({ fetcher: async () => { started(); await wait; return image(); } });
  try {
    const pending = f.request(); await ready;
    await f.store.mutate(f.source, data => { data.accounts!.users.find(user => user.id === 'trips')!.sections = []; return { result: null, changed: true }; });
    release(); assert.equal((await pending).status, 403);
    assert.equal((await f.request()).status, 403);
    const permitted = await f.request(tilePath, 'directories'); assert.equal(permitted.status, 200); assert.deepEqual(Buffer.from(await permitted.arrayBuffer()), png);
  } finally { release(); await f.close(); }
});

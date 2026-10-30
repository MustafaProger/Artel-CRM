import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test, type TestContext } from 'node:test';
import { activeUsers, publicUser, type StoredUser } from '../server/auth';
import { scopeSnapshot } from '../server/auth-scope';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { readOperator } from '../server/operator';
import { currentSnapshot } from '../server/shipment-operations';
import { readWork, workCompanyIds } from '../server/work-operations';

const base = await loadSnapshot(resolve('data/local-xlsx-final'));
const source = base.provenance.sourceSha256;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');

class CountingStore extends OperationsStore {
  reads = 0;
  readStarted?: () => void;
  override async read(sourceSha256: string) {
    this.reads++;
    const data = await super.read(sourceSha256);
    this.readStarted?.();
    return data;
  }
}

async function fixture(t: TestContext) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-api-perf-'));
  const store = new CountingStore(directory);
  const external = new OperationsStore(directory);
  const empty = await external.read(source);
  const snapshot = currentSnapshot(base, empty);
  const managerId = snapshot.directories!.managers[0].id;
  const users: StoredUser[] = [
    { id: 'owner', role: 'director', managerId: null },
    { id: 'admin', role: 'admin', managerId: null },
    { id: 'legacy', role: 'manager', managerId },
    { id: 'employee', role: 'employee', managerId, sections: ['shipments', 'work', 'operator'] },
    { id: 'logistician', role: 'logistician', managerId, sections: ['trips'] },
    { id: 'work-only', role: 'employee', managerId, sections: ['work'] },
    { id: 'empty', role: 'employee', managerId, sections: [] },
    { id: 'driver', role: 'driver', managerId: null, driverId: empty.directories!.drivers[0].id, sections: [] },
  ].map(row => ({ name: row.id, login: row.id, active: true, version: 1, salt: '0'.repeat(32), passwordHash: '0'.repeat(128), ...row } as StoredUser));
  const tokens = new Map(users.map(user => [user.id, digest(`test-session-${user.id}`)]));
  await external.mutate(source, data => {
    data.accounts = { users, sessions: users.map(user => ({ userId: user.id, hash: digest(tokens.get(user.id)!), expiresAt: Date.now() + 600_000 })), attempts: {} };
    return { result: null, changed: true };
  });
  const middleware = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { operationsStore: store });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  t.after(async () => { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); });
  const cookie = (id = 'owner') => `artel_session=${tokens.get(id)}`;
  const get = async (path: string, id = 'owner') => {
    store.reads = 0;
    const response = await fetch(url + path, { headers: { cookie: cookie(id) } });
    return { status: response.status, body: await response.json(), reads: store.reads };
  };
  return { store, external, users, url, cookie, get };
}

test('synchronous authenticated pages use one fresh store view and keep response data equivalent', async t => {
  const f = await fixture(t);
  const data = await f.external.read(source), snapshot = currentSnapshot(base, data);
  for (const path of ['/api/auth/session', '/api/auth/users', '/api/work', '/api/operator', '/api/snapshot', '/api/shipments', '/api/directories', '/api/china', '/api/push/config']) {
    const response = await f.get(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.reads, 1, `${path} must not parse the full store repeatedly`);
    if (path === '/api/snapshot') assert.deepEqual(response.body, JSON.parse(JSON.stringify(snapshot)));
    if (path === '/api/operator') assert.deepEqual(response.body, JSON.parse(JSON.stringify(readOperator(data, publicUser(f.users[0]), snapshot.directories))));
    if (path === '/api/work') {
      const actor = publicUser(f.users[0]);
      assert.deepEqual(response.body, JSON.parse(JSON.stringify(readWork(data, scopeSnapshot(snapshot, actor, 'work', workCompanyIds(data, actor)), new URLSearchParams(), actor, activeUsers(data)))));
    }
    if (path === '/api/auth/users') assert.deepEqual(response.body.staff, {
      managers: snapshot.directories!.managers.map(({ id, name }) => ({ id, name })),
      drivers: snapshot.directories!.drivers.filter(row => !snapshot.directories!.deletedEntries?.drivers?.includes(row.id)).map(({ id, name }) => ({ id, name })),
    });
  }
});

test('navigation counts equal full financial snapshot scope across current and legacy roles without exposing records', async t => {
  const f = await fixture(t);
  for (const user of f.users.filter(row => row.role !== 'driver')) {
    const full = await f.get('/api/snapshot', user.id);
    const navigation = await f.get('/api/navigation', user.id);
    assert.equal(navigation.status, 200, user.id);
    assert.equal(navigation.reads, 1, user.id);
    assert.deepEqual(navigation.body, { shipmentCount: full.body.overview.shipmentCount }, user.id);
    if (user.id === 'employee') assert.ok(navigation.body.shipmentCount > 0 && navigation.body.shipmentCount < base.shipments.length, 'the scoped fixture contains both visible and hidden shipments');
  }
  assert.equal((await f.get('/api/navigation', 'driver')).status, 403);
  assert.equal((await f.get('/api/logistics/navigation')).status, 403, 'the separate logistics audience keeps its closed route list');
  assert.equal((await fetch(f.url + '/api/navigation')).status, 401);
  assert.equal((await fetch(f.url + '/api/navigation', { method: 'POST', headers: { cookie: f.cookie() } })).status, 405);
});

test('subsequent reads immediately observe external session revocation and changed section access', async t => {
  const f = await fixture(t);
  assert.equal((await f.get('/api/work', 'employee')).status, 200);
  await f.external.mutate(source, data => {
    data.accounts!.users.find(row => row.id === 'employee')!.sections = [];
    return { changed: true, result: null };
  });
  assert.equal((await f.get('/api/work', 'employee')).status, 403);
  assert.deepEqual((await f.get('/api/navigation', 'employee')).body, { shipmentCount: 0 });
  await f.external.mutate(source, data => {
    data.accounts!.sessions = data.accounts!.sessions.filter(row => row.userId !== 'employee');
    return { changed: true, result: null };
  });
  assert.equal((await f.get('/api/navigation', 'employee')).status, 401);
  assert.equal((await f.get('/api/auth/session', 'employee')).body.user, null);
});

test('work write rechecks the live session inside the mutation after waiting for a slow request body', async t => {
  const f = await fixture(t);
  let started!: () => void;
  const initialRead = new Promise<void>(done => { started = done; });
  f.store.readStarted = started;
  const body = JSON.stringify({ title: 'Must not be saved after revocation' });
  const response = new Promise<number>((done, reject) => {
    const request = httpRequest(f.url + '/api/work/tasks', { method: 'POST', headers: { cookie: f.cookie('employee'), 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, reply => { reply.resume(); reply.on('end', () => done(reply.statusCode!)); });
    request.on('error', reject);
    request.write(body.slice(0, 1));
    void (async () => {
      await initialRead;
      f.store.readStarted = undefined;
      await f.external.mutate(source, data => {
        data.accounts!.sessions = data.accounts!.sessions.filter(row => row.userId !== 'employee');
        return { changed: true, result: null };
      });
      request.end(body.slice(1));
    })().catch(reject);
  });
  assert.equal(await response, 401);
  assert.equal((await f.external.read(source)).work?.tasks.length ?? 0, 0);
});

test('financial output and store bytes remain unchanged after lightweight navigation and catalog reads', async t => {
  const f = await fixture(t);
  const before = await readFile(f.store.path, 'utf8');
  const financial = (await f.get('/api/snapshot')).body;
  for (const id of ['owner', 'legacy', 'employee']) {
    await f.get('/api/navigation', id);
    await f.get('/api/operator', id);
  }
  await f.get('/api/auth/users');
  assert.deepEqual((await f.get('/api/snapshot')).body, financial);
  assert.equal(await readFile(f.store.path, 'utf8'), before);
});

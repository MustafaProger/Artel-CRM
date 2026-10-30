import assert from 'node:assert/strict';
import crypto, { createHash, scryptSync } from 'node:crypto';
import { syncBuiltinESMExports } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { login } from '../server/auth';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore, type OperationsData, type OperationsStorage } from '../server/operations-store';
import { writeTripsQaSnapshot } from '../scripts/qa-trips-runtime.mjs';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const globalKey = digest('artel:auth:global-login-limit:v2');
const userKey = (login: string) => digest(`artel:auth:user:${login}`);
const password = 'synthetic-security-password';
const salt = 'a'.repeat(32);
const passwordHash = scryptSync(password, salt, 64).toString('hex');
function fixture(globalLimit = false) {
  const accounts: NonNullable<OperationsData['accounts']> = {
    users: [{ id: 'security-owner', name: 'Synthetic owner', login: 'security.owner', role: 'director', managerId: null, active: true, version: 1, salt, passwordHash }],
    sessions: [], attempts: globalLimit ? { [globalKey]: { count: 50, until: Date.now() + 900000 } } : {},
  };
  const data = { accounts } as OperationsData;
  return { data, accounts };
}

test('fifty unrelated failed logins cannot prevent a valid existing account from signing in', async () => {
  const f = fixture();
  for (let i = 0; i < 50; i++) assert.equal((await login(f.data, { login: `unknown-${i}`, password: 'wrong' })).status, 401);
  const signed = await login(f.data, { login: 'security.owner', password });
  assert.equal(signed.status, 200);
  assert.equal(f.accounts.sessions.length, 1);
  assert.equal(f.accounts.attempts[globalKey].count, 50);
});

test('exhausted global budget gives the same reply for unknown and incorrect existing credentials', async () => {
  const f = fixture(true);
  const unknown = await login(f.data, { login: 'unknown', password: 'wrong' });
  const known = await login(f.data, { login: 'security.owner', password: 'wrong' });
  assert.deepEqual(known, unknown);
  assert.equal(known.status, 429);
  assert.equal(f.accounts.attempts[userKey('security.owner')].count, 1);
  assert.equal(f.accounts.attempts[globalKey].count, 50);
  assert.equal(f.accounts.sessions.length, 0);
});

test('blocked unknown usernames allocate no additional attempt entries or persistent changes', async () => {
  const f = fixture(true), before = structuredClone(f.accounts);
  let changed = false;
  for (let i = 0; i < 8; i++) assert.equal((await login(f.data, { login: `new-unknown-${i}`, password: 'wrong' }, undefined, () => { changed = true; })).status, 429);
  assert.equal(changed, false);
  assert.deepEqual(f.accounts, before);
});

test('the existing five-attempt account limit stays in force after global exhaustion', async () => {
  const f = fixture(true);
  for (let i = 0; i < 5; i++) assert.equal((await login(f.data, { login: 'security.owner', password: 'wrong' })).status, 429);
  const before = structuredClone(f.accounts);
  let changed = false;
  assert.equal((await login(f.data, { login: 'security.owner', password }, undefined, () => { changed = true; })).status, 429);
  assert.equal(changed, false);
  assert.deepEqual(f.accounts, before);
});

test('locked known and unknown accounts use the same scrypt path after global exhaustion', async t => {
  const original = crypto.scrypt;
  let derivations = 0;
  t.mock.method(crypto, 'scrypt', (...args: unknown[]) => { derivations++; return Reflect.apply(original, crypto, args); });
  syncBuiltinESMExports();
  try {
    // Load an isolated module so promisify captures the observed implementation.
    const moduleUrl = new URL('../server/auth.ts', import.meta.url);
    moduleUrl.search = '?security-scrypt-path';
    const isolated = await import(moduleUrl.href) as typeof import('../server/auth');
    const f = fixture(true);
    f.accounts.attempts[userKey('security.owner')] = { count: 5, until: Date.now() + 900000 };
    const before = structuredClone(f.accounts);
    let changed = false;
    for (const name of ['security.owner', 'new-unknown']) {
      const start = derivations;
      assert.equal((await isolated.login(f.data, { login: name, password: 'wrong' }, undefined, () => { changed = true; })).status, 429);
      assert.equal(derivations - start, 1, `${name} must run exactly one password derivation`);
    }
    assert.equal(changed, false);
    assert.deepEqual(f.accounts, before);
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
  }
});

test('expiry cleanup, failed attempts and successful sessions signal their actual persistence needs', async () => {
  const f = fixture(true);
  f.accounts.attempts[userKey('security.owner')] = { count: 5, until: Date.now() + 900000 };
  f.accounts.attempts[digest('expired')] = { count: 2, until: Date.now() - 1 };
  let changed = false;
  assert.equal((await login(f.data, { login: 'security.owner', password }, undefined, () => { changed = true; })).status, 429);
  assert.equal(changed, true);
  assert.equal(f.accounts.attempts[digest('expired')], undefined);
  f.accounts.attempts[userKey('security.owner')].until = Date.now() - 1;
  changed = false;
  assert.equal((await login(f.data, { login: 'security.owner', password }, undefined, () => { changed = true; })).status, 200);
  assert.equal(changed, true);
  assert.equal(f.accounts.attempts[userKey('security.owner')], undefined);
  assert.equal(f.accounts.sessions.length, 1);
  const fresh = fixture();
  changed = false;
  assert.equal((await login(fresh.data, { login: 'security.owner', password: 'wrong' }, undefined, () => { changed = true; })).status, 401);
  assert.equal(changed, true);
});

test('inactive accounts and logistics permissions remain closed under the shared login limit', async () => {
  const f = fixture(true);
  f.accounts.users[0].active = false;
  assert.equal((await login(f.data, { login: 'security.owner', password })).status, 429);
  assert.equal(f.accounts.sessions.length, 0);
  f.accounts.users[0].active = true;
  f.accounts.users[0].role = 'employee';
  f.accounts.users[0].sections = [];
  assert.equal((await login(f.data, { login: 'security.owner', password }, 'logistics')).status, 403);
  assert.equal(f.accounts.sessions.length, 0);
  f.accounts.users[0].sections = ['trips'];
  assert.equal((await login(f.data, { login: 'security.owner', password }, 'logistics')).status, 200);
  assert.equal(f.accounts.sessions[0].audience, 'logistics');
});

test('legacy throttles survive key migration and a sentinel-named account cannot clear the shared limit', async () => {
  const f = fixture();
  f.accounts.users.push({ ...f.accounts.users[0], id: 'sentinel-user', login: 'artel-global-login-limit' });
  f.accounts.users.push({ ...f.accounts.users[0], id: 'unrelated-user', login: 'unrelated' });
  const until = Date.now() + 900000;
  f.accounts.attempts[digest('artel-global-login-limit')] = { count: 50, until };
  f.accounts.attempts[digest('security.owner')] = { count: 5, until };
  assert.equal((await login(f.data, { login: 'security.owner', password })).status, 429);
  assert.deepEqual(f.accounts.attempts[globalKey], { count: 50, until });
  assert.deepEqual(f.accounts.attempts[userKey('security.owner')], { count: 5, until });
  assert.deepEqual(f.accounts.attempts[userKey('artel-global-login-limit')], { count: 5, until });
  assert.equal(f.accounts.attempts[digest('artel-global-login-limit')], undefined);
  assert.equal((await login(f.data, { login: 'unrelated', password })).status, 200);
  assert.equal(f.accounts.attempts[globalKey].count, 50);

  const fresh = fixture();
  fresh.accounts.users[0].login = 'artel-global-login-limit';
  assert.equal((await login(fresh.data, { login: 'artel-global-login-limit', password: 'wrong' })).status, 401);
  assert.equal(fresh.accounts.attempts[globalKey].count, 1);
  assert.equal((await login(fresh.data, { login: 'artel-global-login-limit', password })).status, 200);
  assert.equal(fresh.accounts.attempts[globalKey].count, 1);
  assert.equal(fresh.accounts.attempts[userKey('artel-global-login-limit')], undefined);
  await login(fresh.data, { login: 'artel:auth:global-login-limit:v2', password: 'wrong' });
  assert.equal(fresh.accounts.attempts[globalKey].count, 2, 'Invalid login text cannot migrate or erase the new shared counter');
});

test('login API does not rewrite storage for unchanged throttled requests and keeps its public response', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-login-security-'));
  const snapshotDirectory = resolve(directory, 'snapshot');
  await writeTripsQaSnapshot(snapshotDirectory);
  const store = new OperationsStore(directory), base = await loadSnapshot(snapshotDirectory);
  const middleware = createSnapshotMiddleware(snapshotDirectory, { operationsStore: store });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/auth/login`;
  const call = async (name: string, candidate: string) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: name, password: candidate }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie') };
  };
  try {
    await store.mutate(base.provenance.sourceSha256, data => { data.accounts = fixture(true).accounts; return { changed: true, result: null }; });
    const before = await readFile(store.path, 'utf8');
    for (let i = 0; i < 3; i++) {
      const limited = await call(`unknown-${i}`, 'wrong');
      assert.equal(limited.status, 429);
      assert.deepEqual(Object.keys(limited.body).sort(), ['error', 'status']);
    }
    assert.equal(await readFile(store.path, 'utf8'), before);
    const signed = await call('security.owner', password);
    assert.equal(signed.status, 200);
    assert.deepEqual(Object.keys(signed.body).sort(), ['status', 'user']);
    assert.match(signed.cookie ?? '', /HttpOnly; SameSite=Strict/);
    assert.equal((await store.read(base.provenance.sourceSha256)).accounts!.sessions.length, 1);
    assert.notEqual(await readFile(store.path, 'utf8'), before);
  } finally {
    await new Promise<void>(done => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});

test('four pending logins bound the transaction queue without blocking authenticated reads; slots recover after failure', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-login-gate-'));
  const snapshotDirectory = resolve(directory, 'snapshot');
  await writeTripsQaSnapshot(snapshotDirectory);
  const store = new OperationsStore(directory), base = await loadSnapshot(snapshotDirectory);
  const token = 'c'.repeat(64);
  const accounts = fixture(true).accounts;
  accounts.sessions.push({ userId: accounts.users[0].id, hash: digest(token), expiresAt: Date.now() + 60000 });
  await store.mutate(base.provenance.sourceSha256, data => { data.accounts = accounts; return { result: null, changed: true }; });
  let release!: () => void, full!: () => void, holding = true, entries = 0, failNext = false;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const allEntered = new Promise<void>(resolve => { full = resolve; });
  const guardedStore: OperationsStorage = {
    read: source => store.read(source),
    mutate: async (source, update) => {
      entries++;
      if (entries === 4) full();
      if (holding) await hold;
      if (failNext) { failNext = false; throw new Error('synthetic storage failure'); }
      return store.mutate(source, update);
    },
  };
  const middleware = createSnapshotMiddleware(snapshotDirectory, { operationsStore: guardedStore, operationsDirectory: directory });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const call = (name: string, candidate = 'wrong') => fetch(url + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: name, password: candidate }) });
  const pending = Array.from({ length: 4 }, (_, i) => call(`pending-${i}`));
  try {
    await allEntered;
    assert.equal((await call('overflow')).status, 429);
    assert.equal(entries, 4, 'Excess login must never join the storage transaction queue');
    const session = await fetch(url + '/api/auth/session', { headers: { cookie: `artel_session=${token}` } });
    assert.equal(session.status, 200);
    assert.equal((await session.json()).user.id, accounts.users[0].id);
    holding = false; release();
    assert.deepEqual((await Promise.all(pending)).map(response => response.status), [429, 429, 429, 429]);
    failNext = true;
    assert.equal((await call('security.owner', password)).status, 500);
    assert.equal((await call('security.owner', password)).status, 200);
  } finally {
    holding = false; release();
    await Promise.allSettled(pending);
    await new Promise<void>(done => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
  }
});

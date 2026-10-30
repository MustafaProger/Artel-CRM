import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { OperationsStore, type OperationsStorage } from '../server/operations-store';
import { WorkPartition, migrateWorkStorage } from '../server/work-partition';
import { createSnapshotMiddleware } from '../server/local-api';
import { syncInvoiceEvents } from '../server/invoice-bridge';
import { InvoiceBridge } from '../server/invoice-bridge';
import { emptyWork } from '../web/src/work-model';
import { writeTripsQaSnapshot } from '../scripts/qa-trips-runtime.mjs';

const source = 'a'.repeat(64);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const delay = (ms: number) => new Promise(done => setTimeout(done, ms));

test('auth and trip admission share FIFO across instances, bypass core backlog and allow core/Work progress', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'auth-admission-'));
  const store = new OperationsStore(directory), other = new OperationsStore(directory);
  let release!: () => void;
  const pending: Promise<unknown>[] = [];
  try {
    await store.mutate(source, data => { data.work = emptyWork(); return { result: null, changed: true }; });
    await migrateWorkStorage(directory, source);
    const part = new WorkPartition(store.path), pointer = await readFile(store.path), workBefore = await readFile(part.workPath);
    const order: string[] = [];
    let started!: () => void;
    const gate = new Promise<void>(done => release = done), running = new Promise<void>(done => started = done);
    pending.push(store.mutate(source, async () => { started(); await gate; order.push('active'); return { result: null, changed: false }; }));
    await running;
    pending.push(...Array.from({ length: 8 }, (_, i) => store.mutate(source, () => { order.push(`core-${i}`); return { result: null, changed: true }; })));
    const expected = ['auth-0', 'request-1', 'auth-2', 'auth-3', 'request-4', 'auth-5'];
    pending.push(...expected.map((name, i) => (i % 2 ? other : store)[name.startsWith('auth') ? 'mutateAuth' : 'mutateTripRequests'](source, () => {
      order.push(name); return { result: name, changed: true };
    })));
    pending.push(store.mutateWork(source, () => { order.push('work'); return { result: null, changed: false }; }));
    await delay(30);
    assert.deepEqual(order, [], 'No admission may bypass the active transaction latch');
    release(); await Promise.all(pending);
    assert.equal(order[0], 'active');
    assert.deepEqual(order.filter(name => /^(auth|request)-/.test(name)), expected);
    const coresBefore = (name: string) => order.slice(0, order.indexOf(name)).filter(row => row.startsWith('core-')).length;
    assert.ok(coresBefore('auth-0') < 3, JSON.stringify(order));
    assert.ok(coresBefore('auth-5') >= 2, 'An auth burst must allow background transactions to advance');
    assert.ok(order.indexOf('work') < order.indexOf('auth-5'), 'Work retains independent admission');
    assert.deepEqual(await readFile(store.path), pointer);
    assert.deepEqual(await readFile(part.workPath), workBefore);
  } finally { release?.(); await Promise.allSettled(pending); await rm(directory, { recursive: true, force: true }); }
});

test('shared auth FIFO recovers from pointer, source and callback failures without losing later calls', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'auth-admission-errors-'));
  const store = new OperationsStore(directory), other = new OperationsStore(directory);
  try {
    await store.mutate(source, () => ({ result: null, changed: true }));
    await migrateWorkStorage(directory, source);
    const order: number[] = [];
    const pending = Array.from({ length: 12 }, (_, i) => (i % 2 ? other : store).mutateAuth(i === 3 ? 'b'.repeat(64) : source, () => {
      order.push(i);
      if (i === 7) throw new Error('synthetic callback failure');
      return { result: i, changed: false };
    }));
    const results = await Promise.allSettled(pending);
    assert.deepEqual(order, Array.from({ length: 12 }, (_, i) => i).filter(i => i !== 3));
    assert.deepEqual(results.flatMap((result, i) => result.status === 'rejected' ? [i] : []), [3, 7]);
    const pointer = await readFile(store.path);
    await writeFile(store.path, '{"format":"artel-work-partition-v1"}');
    await assert.rejects(store.mutateAuth(source, () => { throw new Error('callback must not run'); }), /Invalid Work storage pointer/);
    await writeFile(store.path, pointer);
    assert.equal(await other.mutateAuth(source, () => ({ result: 'recovered', changed: false })), 'recovered');
  } finally { await rm(directory, { recursive: true, force: true }); }
});

for (const authAdmission of [false, true]) test(`HTTP session changes preserve revocation and fallback (${authAdmission ? 'partitioned admission' : 'legacy adapter'})`, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'auth-admission-http-'));
  const snapshotDirectory = resolve(directory, 'snapshot');
  const sourceHash = await writeTripsQaSnapshot(snapshotDirectory);
  const store = new OperationsStore(resolve(directory, 'store'));
  const counts = { core: 0, auth: 0 };
  const adapter: OperationsStorage = {
    read: hash => store.read(hash),
    mutate: (hash, update) => { counts.core++; return store.mutate(hash, update); },
    ...(authAdmission ? { mutateAuth: ((hash, update) => { counts.auth++; return store.mutateAuth(hash, update); }) as OperationsStore['mutateAuth'] } : {}),
  };
  const denied = async () => { throw new Error('External providers are forbidden'); };
  const api = createSnapshotMiddleware(snapshotDirectory, { operationsStore: adapter, operationsDirectory: resolve(directory, 'store'),
    bankEnvironment: { ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false' }, cabinetEnvironment: {}, geocoderEnvironment: {},
    bankRequest: denied, sberRequest: denied, fetcher: denied, pushSender: denied,
    pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false } });
  const server = createServer((request, response) => api(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown, cookie?: string) => fetch(url + path, { method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  try {
    const credentials = { login: 'synthetic.owner', password: 'Synthetic-auth-admission-password' };
    const setup = await request('/api/auth/setup', { ...credentials, name: 'Synthetic owner' });
    assert.equal(setup.status, 200); assert.equal(counts.core, 1); assert.equal(counts.auth, 0);
    await setup.json();
    if (authAdmission) await migrateWorkStorage(resolve(directory, 'store'), sourceHash);
    const before = await store.read(sourceHash);
    const signed = await request('/api/auth/login', credentials);
    assert.equal(signed.status, 200);
    const signedBody = await signed.json(), cookie = signed.headers.get('set-cookie')!.split(';')[0];
    assert.deepEqual(Object.keys(signedBody).sort(), ['status', 'user']);
    assert.equal(counts.auth, authAdmission ? 1 : 0);
    assert.equal(counts.core, authAdmission ? 1 : 2);
    const sessionHash = digest(cookie.slice(cookie.indexOf('=') + 1));
    const responses = await Promise.all([request('/api/auth/logout', {}, cookie), request('/api/auth/logout', {}, cookie)]);
    assert.deepEqual(responses.map(response => response.status).sort(), [200, 401], 'The first logout commits; the second confirms the session is already absent');
    await Promise.all(responses.map(response => response.json()));
    assert.equal((await request('/api/work', undefined, cookie)).status, 401);
    assert.equal((await (await request('/api/auth/session', undefined, cookie)).json()).user, null);
    const after = await new OperationsStore(resolve(directory, 'store')).read(sourceHash);
    assert.deepEqual(after.accounts!.users, before.accounts!.users);
    assert.deepEqual(after.accounts!.sessions, before.accounts!.sessions);
    assert.ok(after.push?.invoiceRevocations?.[sessionHash], 'Worker revocation is durable in the same commit');
    assert.equal(counts.auth, authAdmission ? 3 : 0);
    const sent: string[] = [];
    const bridge = new InvoiceBridge('http://invoices:4318', Buffer.alloc(32, 7), async (target, options) => {
      sent.push(String(target));
      if (String(target).endsWith('/sessions/revoke')) assert.deepEqual(JSON.parse(String(options?.body instanceof Uint8Array ? Buffer.from(options.body).toString() : options?.body)), { sessionHash });
      return new Response(JSON.stringify(String(target).endsWith('/events') ? { events: [], hasMore: false } : {}), { status: 200 });
    });
    await syncInvoiceEvents(bridge, store, sourceHash);
    assert.deepEqual(sent, ['http://invoices:4318/internal/crm/sessions/revoke', 'http://invoices:4318/internal/crm/events']);
    assert.equal((await store.read(sourceHash)).push?.invoiceRevocations?.[sessionHash], undefined);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); }
});

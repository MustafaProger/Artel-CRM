import assert from 'node:assert/strict';
import { createECDH, createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { InvoiceBridge, invoiceRouteAllowed, syncInvoiceEvents } from '../server/invoice-bridge';
import { dispatchReminders, subscribe, type PushConfig } from '../server/push';
import { deleteUser, saveUser } from '../server/auth';
import { effectiveSections, hasSection } from '../web/src/auth-model';
import { grantInvoiceAccess } from '../server/invoice-permission-grant';

const hash = (s: string | Buffer) => createHash('sha256').update(s).digest('hex');
const key = randomBytes(32);
const push: PushConfig = { publicKey: 'synthetic', privateKey: 'synthetic', subject: 'https://crm.test', schedule: true };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

async function fixture(fetcher: typeof fetch) {
  const directory = await mkdtemp(resolve(tmpdir(), 'crm-invoice-'));
  const snapshot = resolve(directory, 'snapshot'); await mkdir(snapshot);
  const source = 'a'.repeat(64);
  const meta = { source_file: 'synthetic.xlsx', source_sha256: source, created_at_utc: '2026-01-01T00:00:00Z', source_kind: 'test', google_verified: false, formula_policy: '', ownership_policy: '' };
  const validation = { status: 'ok', registry_verified: false, issue_counts: {}, cell_issues: [], record_flag_counts: {}, duplicate_record_candidates: [], legal_form_alias_candidate_groups: [], multiple_manager_companies: [], limitations: [] };
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const name of ['companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report']) {
    const raw = JSON.stringify({ meta, data: name === 'validation_report' ? validation : [] });
    await writeFile(resolve(snapshot, `${name}.json`), raw);
    files[`${name}.json`] = { sha256: hash(raw), bytes: Buffer.byteLength(raw) };
  }
  await writeFile(resolve(snapshot, 'manifest.json'), JSON.stringify({ meta, counts: {}, files }));
  const base = await loadSnapshot(snapshot), store = new OperationsStore(resolve(directory, 'store'));
  const token = randomBytes(32).toString('hex'), otherToken = randomBytes(32).toString('hex');
  await store.mutate(source, data => {
    data.accounts = { users: [
      { id: 'invoice-user', name: 'QA invoices', login: 'invoice-qa', role: 'director', active: true, managerId: null, version: 1, sections: ['invoices'], salt: 'a'.repeat(32), passwordHash: 'b'.repeat(128) },
      { id: 'other-user', name: 'QA other', login: 'other-qa', role: 'employee', active: true, managerId: null, version: 1, sections: [], salt: 'c'.repeat(32), passwordHash: 'd'.repeat(128) },
    ], sessions: [{ userId: 'invoice-user', hash: hash(token), expiresAt: Date.now() + 3600000 }, { userId: 'other-user', hash: hash(otherToken), expiresAt: Date.now() + 3600000 }], attempts: {} };
    return { changed: true, result: null };
  });
  const bridge = new InvoiceBridge('http://invoices:4318', key, fetcher);
  const middleware = createSnapshotMiddleware(snapshot, { operationsStore: store, invoiceBridge: bridge, pushConfig: push });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, { method = 'GET', body, account = 'invoice-user', session = token, headers = {} }: { method?: string; body?: unknown; account?: string; session?: string; headers?: Record<string, string> } = {}) => fetch(url + path, {
    method, headers: { cookie: `artel_session=${session}`, 'X-Artel-Account': account, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { store, source, base, bridge, token, otherToken, request, close: async () => { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); } };
}

test('invoice proxy binds exact bytes to the current CRM account and ignores forged bridge/owner headers', async () => {
  const calls: { path: string; context: Record<string, unknown>; raw: string }[] = [];
  const f = await fixture(async (url, options) => {
    const headers = new Headers(options?.headers), encoded = headers.get('x-artel-bridge-context')!;
    const context = JSON.parse(Buffer.from(encoded, 'base64url').toString());
    const raw = Buffer.from(options?.body as Uint8Array).toString();
    assert.equal(headers.get('x-artel-bridge-signature'), createHmac('sha256', key).update(`artel-invoices-v1\n${encoded}`).digest('base64url'));
    assert.equal(context.bodySha256, hash(raw)); assert.equal(context.crmUserId, 'invoice-user');
    assert.equal(headers.has('cookie'), false); assert.equal(headers.has('x-artel-account'), false);
    calls.push({ path: String(url), context, raw }); return response({ job: { id: randomUUID() } }, 202);
  });
  try {
    const body = { idempotencyKey: randomUUID(), organizationId: 'synthetic' };
    const result = await f.request('/api/invoices', { method: 'POST', body, headers: { 'x-artel-bridge-context': 'forged', 'x-owner-id': 'other-owner' } });
    assert.equal(result.status, 202); assert.equal(calls[0].raw, JSON.stringify(body));
    assert.equal(calls[0].context.sessionHash, hash(f.token));
    assert.equal(calls[0].context.displayName, 'QA invoices');
    assert.equal(calls[0].path, 'http://invoices:4318/api/invoices');
    for (const input of [{ account: 'other-user' }, { account: 'other-user', session: f.otherToken }]) assert.ok([401, 403].includes((await f.request('/api/invoices', input)).status));
    assert.equal(calls.length, 1);
    assert.equal((await f.request('/api/invoices/internal/admin')).status, 404);
  } finally { await f.close(); }
});

test('slow invoice response is hidden after logout and logout durably queues worker revocation', async () => {
  let release!: () => void, arrived!: () => void;
  const wait = new Promise<void>(done => { release = done; });
  const started = new Promise<void>(done => { arrived = done; });
  const f = await fixture(async () => { arrived(); await wait; return response({ history: ['private'] }); });
  try {
    const pending = f.request('/api/invoices');
    await started;
    assert.equal((await f.request('/api/auth/logout', { method: 'POST', body: {} })).status, 200);
    release();
    const reply = await pending;
    assert.equal(reply.status, 401); assert.equal((await reply.text()).includes('private'), false);
    const data = await f.store.read(f.source);
    assert.ok(data.push?.invoiceRevocations?.[hash(f.token)]);
  } finally { release(); await f.close(); }
});

test('catalog refresh forwards only the explicit GET workspace refresh flag', async () => {
  const calls: Headers[] = [];
  const f = await fixture(async (_url, options) => { calls.push(new Headers(options?.headers)); return response({}); });
  try {
    await f.request('/api/invoices', { headers: { 'X-Artel-Catalog-Refresh': '1', 'X-Private-Forged': 'ignored' } });
    await f.request('/api/invoices', { headers: { 'X-Artel-Catalog-Refresh': 'true' } });
    await f.request('/api/invoices', { method: 'POST', body: {}, headers: { 'X-Artel-Catalog-Refresh': '1' } });
    await f.request('/api/invoices/jobs/' + randomUUID(), { headers: { 'X-Artel-Catalog-Refresh': '1' } });
    assert.deepEqual(calls.map(headers => headers.get('x-artel-catalog-refresh')), ['1', null, null, null]);
    for (const headers of calls) { assert.equal(headers.has('cookie'), false); assert.equal(headers.has('x-private-forged'), false); }
  } finally { await f.close(); }
});

test('directors and admins have invoices with every section even without a stored grant', async () => {
  const f = await fixture(async () => response({}));
  try {
    for (const role of ['director', 'admin'] as const) {
      await f.store.mutate(f.source, data => {
        data.accounts!.users[1].role = role;
        data.accounts!.users[1].sections = [];
        return { result: null, changed: true };
      });
      assert.equal((await f.request('/api/invoices', { account: 'other-user', session: f.otherToken })).status, 200);
    }
    await f.store.mutate(f.source, async data => {
      let user = data.accounts!.users[0];
      const edit = (sections?: string[]) => ({ name: user.name, login: user.login, role: user.role, managerId: user.managerId, active: true, version: user.version, ...(sections === undefined ? {} : { sections }) });
      await saveUser(data, f.base, edit(), user.id); user = data.accounts!.users[0];
      assert.ok(effectiveSections(user).includes('invoices'));
      await saveUser(data, f.base, edit([]), user.id); user = data.accounts!.users[0];
      assert.equal(effectiveSections(user).includes('invoices'), true);
      assert.ok(effectiveSections(user).includes('accounts'));
      assert.ok(data.push?.invoiceRevocations?.[hash(f.token)]);
      assert.equal(data.accounts!.sessions.some(session => session.userId === user.id), false);
      return { result: null, changed: true };
    });
  } finally { await f.close(); }
});

test('scoped CRM users require a current grant; revoked, disabled and deleted accounts cannot reach the worker', async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return response({ jobs: [] }); });
  const request = () => f.request('/api/invoices', { account: 'other-user', session: f.otherToken });
  const update = (change: (user: NonNullable<Awaited<ReturnType<OperationsStore['read']>>['accounts']>['users'][number]) => void) => f.store.mutate(f.source, data => { change(data.accounts!.users[1]); return { result: null, changed: true }; });
  try {
    for (const role of ['manager', 'employee', 'logistician'] as const) {
      await update(user => { user.role = role; user.sections = []; });
      assert.equal((await request()).status, 403);
      await update(user => { user.sections = ['invoices']; });
      assert.equal((await request()).status, 200);
      await update(user => { user.sections = []; });
      assert.equal((await request()).status, 403);
    }
    assert.equal(calls, 3);
    await update(user => { user.role = 'admin'; user.sections = []; user.active = false; });
    assert.equal((await request()).status, 401);
    await update(user => { user.deletedAt = new Date().toISOString(); user.deletedBy = 'invoice-user'; });
    assert.equal((await request()).status, 401);
    assert.equal(calls, 3);
  } finally { await f.close(); }
});

test('deleting an administrator without a stored invoice grant still queues revocation', async () => {
  const f = await fixture(async () => response({}));
  try {
    await f.store.mutate(f.source, data => {
      const user = data.accounts!.users[1];
      user.role = 'admin'; user.sections = [];
      assert.equal(hasSection(user, 'invoices'), true);
      deleteUser(data, data.accounts!.users[0], user.id, { version: user.version, confirmationName: user.name });
      assert.ok(data.push?.invoiceRevocations?.[hash(f.otherToken)]);
      assert.equal(hasSection(user, 'invoices'), false);
      return { result: null, changed: true };
    });
  } finally { await f.close(); }
});

test('demoting an administrator without explicit sections does not retain privileged access', async () => {
  const f = await fixture(async () => response({}));
  try {
    const snapshot = structuredClone(f.base);
    snapshot.directories = { managers: [{ id: 'staff-qa', name: 'QA' }], products: [], paymentForms: [], vehicles: [], drivers: [], addresses: [], defaults: { profit: null }, duplicates: [] };
    await f.store.mutate(f.source, async data => {
      const user = data.accounts!.users[1];
      user.role = 'admin';
      await saveUser(data, snapshot, { name: user.name, login: user.login, role: 'manager', managerId: 'staff-qa', version: user.version, active: true }, user.id);
      const saved = data.accounts!.users[1];
      assert.deepEqual(effectiveSections(saved), []);
      assert.ok(data.push?.invoiceRevocations?.[hash(f.otherToken)]);
      return { result: null, changed: true };
    });
  } finally { await f.close(); }
});

test('slow invoice response is hidden after a scoped account loses its grant', async () => {
  let release!: () => void, arrived!: () => void;
  const waiting = new Promise<void>(done => { release = done; });
  const started = new Promise<void>(done => { arrived = done; });
  const f = await fixture(async () => { arrived(); await waiting; return response({ history: ['private'] }); });
  try {
    await f.store.mutate(f.source, data => { data.accounts!.users[1].sections = ['invoices']; return { result: null, changed: true }; });
    const pending = f.request('/api/invoices', { account: 'other-user', session: f.otherToken });
    await started;
    await f.store.mutate(f.source, data => { data.accounts!.users[1].sections = []; return { result: null, changed: true }; });
    release();
    const result = await pending;
    assert.equal(result.status, 403);
    assert.equal((await result.text()).includes('private'), false);
  } finally { release(); await f.close(); }
});

test('events survive lost acknowledgements, deduplicate across restart and notify only current owner subscriptions', async () => {
  const jobId = randomUUID(), occurredAt = Date.now();
  const event = { id: `invoice-ready:${jobId}`, type: 'invoice.ready', crmUserId: 'invoice-user', jobId, occurredAt: new Date(occurredAt).toISOString() };
  let acks = 0;
  const f = await fixture(async url => {
    if (String(url).endsWith('/ack')) { if (++acks === 1) throw new Error('synthetic lost ack'); return response({ ok: true }); }
    return response({ events: [event], hasMore: false });
  });
  try {
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const subscription = (suffix: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${suffix}`, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } });
    await f.store.mutate(f.source, data => {
      subscribe(data, subscription('own'), 'invoice-user', hash(f.token));
      subscribe(data, subscription('late'), 'invoice-user', hash(f.token));
      subscribe(data, subscription('foreign'), 'other-user', hash(f.otherToken));
      data.push!.devices[0].createdAt = occurredAt - 1;
      data.push!.devices[1].createdAt = occurredAt + 1;
      data.push!.devices[2].createdAt = occurredAt - 1;
      return { changed: true, result: null };
    });
    await assert.rejects(syncInvoiceEvents(f.bridge, f.store, f.source));
    assert.equal(Object.keys((await f.store.read(f.source)).push!.invoiceEvents!).length, 1);
    const restarted = new OperationsStore(resolve(f.store.path, '..'));
    await syncInvoiceEvents(f.bridge, restarted, f.source);
    let sent = 0;
    const sender = async (device: { userId: string; endpoint: string }, payload: string) => {
      sent++; assert.equal(device.userId, 'invoice-user'); assert.ok(device.endpoint.endsWith('/own'));
      const value = JSON.parse(payload); assert.ok(value.url.endsWith('#invoices')); assert.ok(value.url.includes('invoiceView=history')); assert.equal(value.body.includes(jobId), false);
    };
    await dispatchReminders(restarted, f.source, push, sender);
    await dispatchReminders(restarted, f.source, push, sender);
    assert.equal(sent, 1);
    await f.store.mutate(f.source, data => { data.accounts!.users[1].role = 'director'; data.accounts!.users[0].active = false; data.push!.deliveries = {}; return { result: null, changed: true }; });
    await dispatchReminders(restarted, f.source, push, sender);
    assert.equal(sent, 1);
  } finally { await f.close(); }
});

test('invoice allowlist and bridge configuration reject alternate destinations, traversal and redirects', async () => {
  for (const path of ['/api/invoices/../auth/users', '//evil.test/api/invoices', '/api/invoices/jobs/invalid/file', '/internal/crm/events', '/api/invoices?x=1#fragment']) assert.equal(invoiceRouteAllowed(path, 'GET'), false, path);
  assert.throws(() => new InvoiceBridge('http://169.254.169.254', key));
  assert.throws(() => new InvoiceBridge('http://invoices:4318/path', key));
  const bridge = new InvoiceBridge('http://invoices:4318', key, async () => new Response(null, { status: 302, headers: { location: 'https://evil.test' } }));
  await assert.rejects(bridge.request('/api/invoices'), /Связь/);
});

test('one-time permission grant changes only two account grants/versions and is idempotent', async () => {
  const f = await fixture(async () => response({}));
  try {
    const data = await f.store.read(f.source), before = structuredClone(data);
    const mapping = { version: 1, users: [{ crmUserId: 'invoice-user', invoiceOwnerId: randomUUID() }, { crmUserId: 'other-user', invoiceOwnerId: randomUUID() }] };
    assert.deepEqual(grantInvoiceAccess(data, mapping), { mapped: 2, granted: 1, changed: true });
    before.accounts!.users[1].sections = ['invoices']; before.accounts!.users[1].version++;
    assert.deepEqual(data, before);
    assert.deepEqual(grantInvoiceAccess(data, mapping), { mapped: 2, granted: 0, changed: false });
    const invalid = structuredClone(mapping); invalid.users[1].crmUserId = invalid.users[0].crmUserId;
    assert.throws(() => grantInvoiceAccess(data, invalid));
    await f.store.mutate(f.source, current => {
      const result = grantInvoiceAccess(current, mapping);
      return { result, changed: result.changed };
    });
    const session = await f.request('/api/auth/session', { account: 'other-user', session: f.otherToken });
    assert.equal(session.status, 200);
    const sessionData = await session.json();
    assert.equal(sessionData.user.id, 'other-user'); assert.ok(sessionData.user.sections.includes('invoices'));
    assert.equal((await f.request('/api/invoices', { account: 'other-user', session: f.otherToken })).status, 200);
  } finally { await f.close(); }
});

test('revocation service has a reserved slot while all user requests wait', async () => {
  let release!: () => void;
  const pending = new Promise<void>(done => { release = done; });
  let serviceCalls = 0;
  const bridge = new InvoiceBridge('http://invoices:4318', key, async url => {
    if (String(url).includes('/internal/')) { serviceCalls++; return response({ revoked: true }); }
    await pending; return response({});
  });
  const calls = Array.from({ length: 4 }, () => bridge.request('/api/invoices', 'GET', Buffer.alloc(0), { crmUserId: 'invoice-user', sessionHash: 'a'.repeat(64) }));
  try {
    assert.deepEqual(await bridge.service('/internal/crm/sessions/revoke', { sessionHash: 'a'.repeat(64) }), { revoked: true });
    assert.equal(serviceCalls, 1);
  } finally { release(); await Promise.all(calls); }
});

test('automatic push synchronization cannot create or transfer an endpoint without explicit enable', async () => {
  const f = await fixture(async () => response({}));
  try {
    await f.store.mutate(f.source, data => { data.accounts!.users[1].sections = ['work']; return { result: null, changed: true }; });
    const ecdh = createECDH('prime256v1'); ecdh.generateKeys();
    const subscription = { endpoint: 'https://fcm.googleapis.com/fcm/send/explicit', keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    assert.equal((await f.request('/api/push/subscription', { method: 'POST', body: { subscription, explicit: false } })).status, 409);
    assert.equal((await f.request('/api/push/subscription', { method: 'POST', body: { subscription, explicit: true } })).status, 200);
    assert.equal((await f.request('/api/push/subscription', { method: 'POST', body: { subscription, explicit: false } })).status, 200);
    assert.equal((await f.request('/api/push/subscription', { method: 'POST', account: 'other-user', session: f.otherToken, body: { subscription, explicit: false } })).status, 409);
    assert.equal((await f.store.read(f.source)).push!.devices[0].userId, 'invoice-user');
    assert.equal((await f.request('/api/push/subscription', { method: 'POST', account: 'other-user', session: f.otherToken, body: { subscription, explicit: true } })).status, 200);
    assert.equal((await f.store.read(f.source)).push!.devices[0].userId, 'other-user');
  } finally { await f.close(); }
});

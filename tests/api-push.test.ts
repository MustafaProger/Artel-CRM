import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { generateKeyPair, SignJWT } from 'jose';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore, decodeOperations, encodeOperations } from '../server/operations-store';
import { ApiError } from '../server/api-error';
import { dispatchReminders, parseSubscription, subscribe, validPushEndpoint, type PushConfig, type PushSender } from '../server/push';
import { validPushWorkflow } from '../server/push-cron-auth';

const base = await loadSnapshot();
const config: PushConfig = { publicKey: 'test-public', privateKey: 'test-private', subject: 'https://artel-crm.vercel.app', schedule: true };
const now = Date.now();
function subscription(name = randomUUID()) {
  const key = createECDH('prime256v1'); key.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${name}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
async function fixture(sender: PushSender = async () => {}) {
  const folder = await mkdtemp(resolve(tmpdir(), 'artel-push-'));
  const store = new OperationsStore(folder);
  const cronSecret = randomBytes(32).toString('hex');
  const middleware = createSnapshotMiddleware(undefined, { operationsStore: store, pushConfig: config, pushSender: sender, cronSecret });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function client() {
    let cookie = '';
    return async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
      const r = await fetch(url + path, { method, headers: { ...headers, Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (r.headers.has('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
      return { status: r.status, body: await r.json() };
    };
  }
  const director = client(), manager = client(), anon = client();
  const password = randomUUID();
  const first = await director('/api/auth/setup', 'POST', { login: 'push-director', name: 'QA', password });
  assert.equal(first.status, 200);
  const second = await director('/api/auth/users', 'POST', { login: 'push-manager', name: 'Manager QA', role: 'manager', managerId: null, password });
  assert.equal(second.status, 201);
  assert.equal((await manager('/api/auth/login', 'POST', { login: 'push-manager', password })).status, 200);
  return { store, director, manager, anon, cronSecret, users: [first.body.user, second.body.user], client,
    close: async () => { await new Promise<void>(done => server.close(() => done())); await rm(folder, { recursive: true, force: true }); } };
}

test('push endpoints enforce ownership, subscription validation, logout, rate limit and cron authorization', async () => {
  const sent: string[] = [];
  const f = await fixture(async device => { sent.push(device.userId); });
  try {
    const sub = subscription();
    assert.equal((await f.anon('/api/push/config')).status, 401);
    assert.equal((await f.director('/api/push/dispatch')).status, 403);
    assert.equal((await f.director('/api/push/config')).body.enabled, true);
    assert.equal((await f.manager('/api/push/subscription', 'POST', { subscription: sub, userId: f.users[0].id })).status, 200);
    assert.equal((await f.store.read(base.provenance.sourceSha256)).push!.devices[0].userId, f.users[1].id);
    assert.equal((await f.director('/api/push/test', 'POST', { endpoint: sub.endpoint })).status, 404);
    assert.equal((await f.director('/api/push/subscription', 'DELETE', { endpoint: sub.endpoint })).status, 200);
    assert.equal((await f.store.read(base.provenance.sourceSha256)).push!.devices.length, 1);
    assert.equal((await f.manager('/api/push/test', 'POST', { endpoint: sub.endpoint })).status, 200);
    assert.equal((await f.manager('/api/push/test', 'POST', { endpoint: sub.endpoint })).status, 429);
    assert.deepEqual(sent, [f.users[1].id]);
    const cron = await f.anon('/api/push/dispatch', 'GET', undefined, { Authorization: `Bearer ${f.cronSecret}` });
    assert.equal(cron.status, 200);
    assert.equal(cron.body.sent, 0);
    assert.equal((await f.manager('/api/push/subscription', 'POST', { subscription: { ...sub, endpoint: 'https://127.0.0.1/private' } })).status, 400);
    assert.equal((await f.manager('/api/auth/logout', 'POST', {})).status, 200);
    assert.equal((await f.store.read(base.provenance.sourceSha256)).push!.devices.length, 0);
  } finally { await f.close(); }
});

test('push dispatch persists deliveries, routes to the current assignee, skips done/archive/future/inactive, and excludes duplicate concurrent sends', async () => {
  const f = await fixture();
  try {
    const a = subscription(), b = subscription();
    await f.director('/api/push/subscription', 'POST', { subscription: a });
    await f.manager('/api/push/subscription', 'POST', { subscription: b });
    const tasks = [];
    for (const [name, fields] of [
      ['due', { assigneeId: f.users[1].id }], ['done', { status: 'done' }], ['archive', { archived: true }], ['future', { reminderAt: new Date(now + 3600000).toISOString() }],
    ] as const) {
      const result = await f.director('/api/work/tasks', 'POST', { title: name, reminderAt: new Date(now - 10000).toISOString(), ...fields });
      assert.equal(result.status, 201); tasks.push(result.body.entry);
    }
    const sent: { user: string; payload: string }[] = [];
    const sender: PushSender = async (device, payload) => { sent.push({ user: device.userId, payload }); await new Promise(done => setTimeout(done, 30)); };
    await Promise.all([dispatchReminders(f.store, base.provenance.sourceSha256, config, sender, now), dispatchReminders(f.store, base.provenance.sourceSha256, config, sender, now)]);
    assert.equal(sent.length, 1); assert.equal(sent[0].user, f.users[1].id);
    assert.match(JSON.parse(sent[0].payload).url, new RegExp(tasks[0].id));
    assert.equal(JSON.parse(sent[0].payload).body.includes('due'), false);
    const persisted = decodeOperations(encodeOperations(await f.store.read(base.provenance.sourceSha256)), base.provenance.sourceSha256);
    assert.equal(Object.values(persisted.push!.deliveries).filter(row => row.sent).length, 1);
    await dispatchReminders(new OperationsStore(resolve(f.store.path, '..')), base.provenance.sourceSha256, config, sender, now + 60000);
    assert.equal(sent.length, 1);
    const reassign = await f.director(`/api/work/tasks/${tasks[0].id}`, 'PATCH', { version: tasks[0].version, assigneeId: f.users[0].id });
    assert.equal(reassign.status, 200);
    await dispatchReminders(f.store, base.provenance.sourceSha256, config, sender, now + 60000);
    assert.equal(sent.length, 2); assert.equal(sent[1].user, f.users[0].id);
    const reschedule = await f.director(`/api/work/tasks/${tasks[0].id}`, 'PATCH', { version: reassign.body.entry.version, reminderAt: new Date(now + 120000).toISOString() });
    assert.equal(reschedule.status, 200);
    await dispatchReminders(f.store, base.provenance.sourceSha256, config, sender, now + 120001);
    assert.equal(sent.length, 3);
  } finally { await f.close(); }
});

test('temporary failures retry, expired endpoints are removed, and company reminders are delivered', async () => {
  const f = await fixture();
  try {
    const a = subscription(), b = subscription();
    await f.manager('/api/push/subscription', 'POST', { subscription: a });
    await f.manager('/api/push/subscription', 'POST', { subscription: b });
    const companyId = (await f.director('/api/snapshot')).body.companies[0].id;
    const record = await f.director('/api/work/companies', 'POST', { companyId, question: 'Company QA', assigneeId: f.users[1].id, reminderAt: new Date(now - 1000).toISOString() });
    assert.equal(record.status, 201);
    let attempts = 0;
    const failing: PushSender = async device => { attempts++; throw Object.assign(new Error('Provider failure'), { statusCode: device.endpoint === a.endpoint ? 503 : 410 }); };
    const first = await dispatchReminders(f.store, base.provenance.sourceSha256, config, failing, now);
    assert.deepEqual(first, { checked: 2, sent: 0, failed: 1, expired: 1 });
    assert.equal((await f.store.read(base.provenance.sourceSha256)).push!.devices.length, 1);
    await dispatchReminders(f.store, base.provenance.sourceSha256, config, failing, now + 1000);
    assert.equal(attempts, 2);
    const retry = await dispatchReminders(f.store, base.provenance.sourceSha256, config, async (_device, payload) => { assert.match(payload, /workKind=companies/); }, now + 121000);
    assert.equal(retry.sent, 1);
    await f.director(`/api/auth/users/${f.users[1].id}`, 'PATCH', { ...f.users[1], version: 1, active: false, id: undefined });
    assert.equal((await f.store.read(base.provenance.sourceSha256)).push!.devices.length, 0);
  } finally { await f.close(); }
});

test('push validation rejects unsafe endpoints and malformed keys; old stores remain compatible', async () => {
  for (const endpoint of ['http://fcm.googleapis.com/test','https://localhost/a','https://fcm.googleapis.com.evil.com/a','https://fcm.googleapis.com:8443/a','https://user@fcm.googleapis.com/a','https://10.0.0.1/a','https://example.com/a']) assert.equal(validPushEndpoint(endpoint), false);
  assert.equal(validPushEndpoint('https://web.push.apple.com/Q123'), true);
  assert.equal(validPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/a'), true);
  assert.throws(() => parseSubscription({ ...subscription(), keys: { p256dh: 'x', auth: 'y' } }), ApiError);
  const f = await fixture();
  try {
    const data = await f.store.read(base.provenance.sourceSha256);
    assert.equal(data.push, undefined);
    const sub = subscription();
    assert.equal(subscribe(data, sub, f.users[0].id, 'a'.repeat(64)), true);
    assert.equal(subscribe(data, sub, f.users[0].id, 'a'.repeat(64)), false);
    const id = data.push!.devices[0].id;
    subscribe(data, sub, f.users[0].id, 'b'.repeat(64));
    assert.equal(data.push!.devices[0].id, id);
    subscribe(data, sub, f.users[1].id, 'c'.repeat(64));
    assert.notEqual(data.push!.devices[0].id, id);
    assert.equal(data.push!.devices.length, 1);
  } finally { await f.close(); }
});

test('scheduler verifies signed GitHub identity, audience, repository, branch and exact workflow', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const claims = { repository_id: '1362863740', repository_owner_id: '74742979', repository: 'MustafaProger/Artel-CRM', ref: 'refs/heads/main', workflow_ref: 'MustafaProger/Artel-CRM/.github/workflows/reminders.yml@refs/heads/main', event_name: 'schedule' };
  async function check(overrides = {}, audience = 'https://artel-crm.vercel.app/api/push/dispatch') {
    const token = await new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: 'RS256' }).setIssuer('https://token.actions.githubusercontent.com').setAudience(audience).setSubject('repo:MustafaProger/Artel-CRM:ref:refs/heads/main').setIssuedAt().setExpirationTime('5m').sign(privateKey);
    return validPushWorkflow({ headers: { authorization: `Bearer ${token}` } } as IncomingMessage, async () => publicKey);
  }
  assert.equal(await check(), true);
  assert.equal(await check({ event_name: 'push' }), true);
  for (const override of [{ repository_id: '999' }, { ref: 'refs/heads/evil' }, { workflow_ref: 'MustafaProger/Artel-CRM/.github/workflows/other.yml@refs/heads/main' }, { event_name: 'pull_request' }, { repository_owner_id: '999' }]) assert.equal(await check(override), false);
  assert.equal(await check({}, 'https://evil.example'), false);
  assert.equal(await validPushWorkflow({ headers: { authorization: 'Bearer forged.jwt.token' } } as IncomingMessage, async () => publicKey), false);
});

test('delivery result retries storage conflicts without resending, and an interrupted lease expires safely', async () => {
  const f = await fixture();
  try {
    await f.manager('/api/push/subscription', 'POST', { subscription: subscription() });
    await f.manager('/api/work/tasks', 'POST', { title: 'Lease QA', reminderAt: new Date(now - 1000).toISOString() });
    let writes = 0, sends = 0;
    const conflicting = {
      read: f.store.read.bind(f.store),
      mutate: (async (source, update) => {
        if (++writes === 2) throw new ApiError(409, 'Injected concurrent write');
        return f.store.mutate(source, update);
      }) as OperationsStore['mutate'],
    };
    await dispatchReminders(conflicting, base.provenance.sourceSha256, config, async () => { sends++; }, now);
    assert.equal(sends, 1); assert.equal(writes, 3);
    await dispatchReminders(f.store, base.provenance.sourceSha256, config, async () => { sends++; }, now + 1000);
    assert.equal(sends, 1);
    await f.store.mutate(base.provenance.sourceSha256, data => {
      const delivery = Object.values(data.push!.deliveries)[0];
      delivery.sent = false; delivery.lease = 'interrupted'; delivery.retryAt = now + 120000;
      return { result: null, changed: true };
    });
    await dispatchReminders(f.store, base.provenance.sourceSha256, config, async () => { sends++; }, now + 110000);
    assert.equal(sends, 1);
    await dispatchReminders(f.store, base.provenance.sourceSha256, config, async () => { sends++; }, now + 120001);
    assert.equal(sends, 2);
  } finally { await f.close(); }
});

import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
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
import { createPushReceiptLimiter } from '../server/push-probe';

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
  const employee = await director('/api/directories', 'POST', { kind: 'managers', name: 'Manager QA' });
  const second = await director('/api/auth/users', 'POST', { login: 'push-manager', name: 'Manager QA', role: 'manager', managerId: employee.body.entry.id, password });
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

test('push tests distinguish provider acceptance from notification creation and accept only a scoped receipt token', async () => {
  let probe: { id: string; token: string } | undefined;
  const f = await fixture(async (_device, payload) => { probe = JSON.parse(payload).probe; });
  try {
    const sub = subscription();
    assert.equal((await f.manager('/api/push/subscription', 'POST', { subscription: sub })).status, 200);
    const result = await f.manager('/api/push/test', 'POST', { endpoint: sub.endpoint });
    assert.equal(result.status, 200);
    assert.ok(probe);
    assert.deepEqual(result.body, { ok: true, probeId: probe.id });
    const statusPath = `/api/push/test-status?probeId=${probe.id}`;
    assert.equal((await f.anon(statusPath)).status, 401);
    assert.equal((await f.director(statusPath)).status, 404);
    const accepted = await f.manager(statusPath);
    assert.equal(accepted.status, 200);
    assert.equal(accepted.body.status, 'pending');
    assert.equal(typeof accepted.body.providerAcceptedAt, 'number');
    assert.equal(accepted.body.notificationCreatedAt, null);
    assert.deepEqual(Object.keys(accepted.body).sort(), ['expiresAt', 'notificationCreatedAt', 'probeId', 'providerAcceptedAt', 'status']);
    const stored = (await f.store.read(base.provenance.sourceSha256)).push!.probes![probe.id];
    assert.equal(stored.tokenHash, createHash('sha256').update(probe.token).digest('hex'));
    assert.equal(stored.expiresAt - stored.createdAt, 300000);
    assert.equal(JSON.stringify(stored).includes(probe.token), false);
    const receipt = { probeId: probe.id, token: probe.token };
    assert.equal((await f.anon('/api/push/test-receipt', 'POST', { ...receipt, token: randomBytes(32).toString('base64url') })).status, 404);
    assert.equal((await f.anon('/api/push/test-receipt', 'POST', { ...receipt, probeId: randomUUID() })).status, 404);
    assert.equal((await f.anon('/api/push/test-receipt', 'POST', { ...receipt, userId: f.users[0].id })).status, 400);
    assert.equal((await f.anon('/api/push/test-receipt', 'POST', receipt, { Origin: 'https://evil.example' })).status, 403);
    assert.equal((await f.anon('/api/push/test-receipt', 'POST', { ...receipt, token: 'x'.repeat(2000) })).status, 413);
    assert.equal((await f.anon('/api/push/test-receipt', 'GET')).status, 405);
    assert.equal((await f.anon('/api/push/test-receipt', 'POST', receipt)).status, 200);
    const confirmed = await f.manager(statusPath);
    assert.equal(confirmed.body.status, 'confirmed');
    assert.equal(typeof confirmed.body.notificationCreatedAt, 'number');
    assert.equal(confirmed.body.providerAcceptedAt, accepted.body.providerAcceptedAt);
    const revision = (await f.store.read(base.provenance.sourceSha256)).revision;
    assert.equal((await f.anon('/api/push/test-receipt', 'POST', receipt)).status, 200);
    assert.equal((await f.store.read(base.provenance.sourceSha256)).revision, revision, 'Replaying the token has no second effect');
    assert.deepEqual((await f.manager(statusPath)).body, confirmed.body);
  } finally { await f.close(); }
});

test('a notification receipt may arrive before provider completion; concurrent receipt retries keep both results', async () => {
  let confirmedBeforeProvider: Record<string, unknown> | undefined;
  const f = await fixture(async (_device, payload) => {
    const probe = JSON.parse(payload).probe as { id: string; token: string };
    assert.ok((await f.store.read(base.provenance.sourceSha256)).push!.probes![probe.id], 'Save the token hash before network I/O');
    const receipts = await Promise.all([
      f.anon('/api/push/test-receipt', 'POST', { probeId: probe.id, token: probe.token }),
      f.anon('/api/push/test-receipt', 'POST', { probeId: probe.id, token: probe.token }),
    ]);
    assert.ok(receipts.every(result => result.status === 200));
    confirmedBeforeProvider = (await f.manager(`/api/push/test-status?probeId=${probe.id}`)).body;
  });
  try {
    const sub = subscription();
    await f.manager('/api/push/subscription', 'POST', { subscription: sub });
    const result = await f.manager('/api/push/test', 'POST', { endpoint: sub.endpoint });
    assert.equal(result.status, 200);
    assert.equal(confirmedBeforeProvider?.status, 'confirmed');
    assert.equal(confirmedBeforeProvider?.providerAcceptedAt, null);
    const status = (await f.manager(`/api/push/test-status?probeId=${result.body.probeId}`)).body;
    assert.equal(status.status, 'confirmed');
    assert.equal(status.notificationCreatedAt, confirmedBeforeProvider?.notificationCreatedAt);
    assert.ok(status.providerAcceptedAt >= status.notificationCreatedAt);
  } finally { await f.close(); }
});

test('a confirmed browser receipt remains successful when the sender times out without provider acceptance', async () => {
  const f = await fixture(async (_device, payload) => {
    const probe = JSON.parse(payload).probe as { id: string; token: string };
    assert.equal((await f.anon('/api/push/test-receipt', 'POST', { probeId: probe.id, token: probe.token })).status, 200);
    throw new Error('Sender timed out after the browser received the push');
  });
  try {
    const sub = subscription();
    await f.manager('/api/push/subscription', 'POST', { subscription: sub });
    const result = await f.manager('/api/push/test', 'POST', { endpoint: sub.endpoint });
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(typeof result.body.probeId, 'string');
    assert.deepEqual(Object.keys(result.body).sort(), ['ok', 'probeId']);
    const status = (await f.manager(`/api/push/test-status?probeId=${result.body.probeId}`)).body;
    assert.equal(status.status, 'confirmed');
    assert.equal(typeof status.notificationCreatedAt, 'number');
    assert.equal(status.providerAcceptedAt, null, 'A browser receipt must not invent provider acceptance');
    assert.deepEqual(Object.keys(status).sort(), ['expiresAt', 'notificationCreatedAt', 'probeId', 'providerAcceptedAt', 'status']);
  } finally { await f.close(); }
});

test('acceptance storage failures after sending preserve the probe id and any already confirmed browser receipt', async () => {
  for (const confirmed of [false, true]) {
    let sends = 0;
    const f = await fixture(async (_device, payload) => {
      sends++;
      const probe = JSON.parse(payload).probe as { id: string; token: string };
      if (confirmed) assert.equal((await f.anon('/api/push/test-receipt', 'POST', { probeId: probe.id, token: probe.token })).status, 200);
      // Only fail finalization: creation and an optional early browser receipt are already durable.
      f.store.mutate = async () => { throw confirmed ? new ApiError(409, 'Injected persistent conflict') : new Error('Injected write failure'); };
    });
    const mutate = f.store.mutate.bind(f.store);
    try {
      const sub = subscription();
      await f.manager('/api/push/subscription', 'POST', { subscription: sub });
      const result = await f.manager('/api/push/test', 'POST', { endpoint: sub.endpoint });
      f.store.mutate = mutate;
      assert.equal(result.status, 200);
      assert.equal(result.body.ok, true);
      assert.equal(typeof result.body.probeId, 'string');
      assert.deepEqual(Object.keys(result.body).sort(), ['ok', 'probeId']);
      assert.equal(sends, 1, 'Retrying finalization must not resend the notification');
      const status = (await f.manager(`/api/push/test-status?probeId=${result.body.probeId}`)).body;
      assert.equal(status.status, confirmed ? 'confirmed' : 'pending');
      assert.equal(status.providerAcceptedAt, null, 'An unsuccessful storage write must not fabricate persisted acceptance');
      if (confirmed) assert.equal(typeof status.notificationCreatedAt, 'number');
      else assert.equal(status.notificationCreatedAt, null);
      assert.deepEqual(Object.keys(status).sort(), ['expiresAt', 'notificationCreatedAt', 'probeId', 'providerAcceptedAt', 'status']);
    } finally { f.store.mutate = mutate; await f.close(); }
  }
});

test('provider failures never claim acceptance; expired receipt tokens are refused without changing status', async () => {
  let probe: { id: string; token: string } | undefined;
  const f = await fixture(async (_device, payload) => { probe = JSON.parse(payload).probe; throw Object.assign(new Error('Provider unavailable'), { statusCode: 503 }); });
  try {
    const sub = subscription();
    await f.manager('/api/push/subscription', 'POST', { subscription: sub });
    assert.equal((await f.manager('/api/push/test', 'POST', { endpoint: sub.endpoint })).status, 502);
    assert.ok(probe);
    const path = `/api/push/test-status?probeId=${probe.id}`;
    const failed = (await f.manager(path)).body;
    assert.equal(failed.status, 'pending');
    assert.equal(failed.providerAcceptedAt, null);
    assert.equal(failed.notificationCreatedAt, null);
    await f.store.mutate(base.provenance.sourceSha256, data => {
      const row = data.push!.probes![probe!.id];
      row.createdAt = Date.now() - 600000;
      row.expiresAt = Date.now() - 300001;
      return { result: null, changed: true };
    });
    const revision = (await f.store.read(base.provenance.sourceSha256)).revision;
    const expired = await f.anon('/api/push/test-receipt', 'POST', { probeId: probe.id, token: probe.token });
    assert.equal(expired.status, 410);
    const status = (await f.manager(path)).body;
    assert.equal(status.status, 'expired');
    assert.equal(status.providerAcceptedAt, null);
    assert.equal(status.notificationCreatedAt, null);
    assert.equal((await f.store.read(base.provenance.sourceSha256)).revision, revision);
    assert.equal((await f.store.read(base.provenance.sourceSha256)).push!.devices.length, 1, 'A temporary failure preserves the subscription');
  } finally { await f.close(); }
});

test('push probe data validates optional legacy storage and receipt traffic is rate limited', async () => {
  const limiter = createPushReceiptLimiter();
  for (let i = 0; i < 60; i++) limiter('127.0.0.1', now);
  assert.throws(() => limiter('127.0.0.1', now), error => error instanceof ApiError && error.status === 429);
  assert.doesNotThrow(() => limiter('127.0.0.1', now + 60000));
  const f = await fixture();
  try {
    const data = await f.store.read(base.provenance.sourceSha256);
    assert.equal(decodeOperations(encodeOperations(data), base.provenance.sourceSha256).push, undefined);
    const valid = { userId: f.users[1].id, deviceId: randomUUID(), tokenHash: 'a'.repeat(64), createdAt: now, expiresAt: now + 300000 };
    for (const invalid of [{ ...valid, tokenHash: 'secret' }, { ...valid, expiresAt: now + 300001 }, { ...valid, notificationCreatedAt: now - 1 }, { ...valid, providerAcceptedAt: 'now' }]) {
      assert.throws(() => encodeOperations({ ...data, push: { devices: [], deliveries: {}, probes: { [randomUUID()]: invalid } } } as typeof data));
    }
    const receipt = { probeId: randomUUID(), token: randomBytes(32).toString('base64url') };
    for (let i = 0; i < 60; i++) assert.equal((await f.anon('/api/push/test-receipt', 'POST', receipt)).status, 404);
    assert.equal((await f.anon('/api/push/test-receipt', 'POST', receipt)).status, 429);
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
    assert.equal(persisted.push!.deliveries[JSON.parse(sent[0].payload).tag].sent, true);
    assert.equal(Object.values(persisted.push!.deliveries).filter(row => row.sent).length, 2, 'Immediate assignment and due reminder have separate persisted deliveries');
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

import assert from 'node:assert/strict';
import { createECDH, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { integrationRuntime } from './helpers/trip-saby-integration';

async function fixture() {
  const rt = await integrationRuntime(), sent: { url: string; probe: { id: string }; userId: string }[] = [];
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, {
    operationsStore: rt.store, sabyWorkflowMonitoringEnabled: false,
    pushConfig: { publicKey: 'synthetic-public', privateKey: 'synthetic-private', subject: 'https://example.test', schedule: true },
    pushSender: async (device, payload) => { sent.push({ ...JSON.parse(payload), userId: device.userId }); },
  });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown, cookie?: string) => {
    const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  };
  const password = randomUUID();
  const setup = await request('/api/auth/setup', 'POST', { name: 'Синтетический директор', login: 'context-director', password });
  assert.equal(setup.status, 200);
  const admin = setup.cookie!;
  await rt.store.mutate(rt.source, state => { state.directories!.managers.push({ id: 'context-operator', name: 'Оператор' }); return { result: null, changed: true }; });
  assert.equal((await request('/api/auth/users', 'POST', { name: 'Оператор', login: 'context-operator', role: 'employee', managerId: 'context-operator', sections: ['operator'], password }, admin)).status, 201);
  const operator = (await request('/api/auth/login', 'POST', { login: 'context-operator', password })).cookie!;
  const created = await request('/api/operator/plans', 'POST', { clientName: 'Синтетическое задание', recipients: [{ id: randomUUID(), name: 'Получатель', bank: 'Банк', card: '0000', phone: '', details: '', limit: '100' }], idempotencyKey: randomUUID() }, admin);
  assert.equal(created.status, 201);
  async function subscription(cookie: string) {
    const key = createECDH('prime256v1'); key.generateKeys();
    const subscription = { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
    assert.equal((await request('/api/push/subscription', 'POST', { subscription, explicit: true }, cookie)).status, 200);
    return subscription.endpoint;
  }
  return { ...rt, request, admin, operator, planId: created.body.id as string, subscription, sent, async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}

test('push test context targets the selected operator task even when work and invoices are also accessible; legacy target stays unchanged', async () => {
  const f = await fixture();
  try {
    for (const [context, expected] of [
      [{}, '/#work'],
      [{ kind: 'operator' }, '/#operator'],
      [{ kind: 'operator', operatorPlanId: f.planId }, `/?operatorPlan=${f.planId}#operator`],
      [{ kind: 'work' }, '/#work'],
      [{ kind: 'invoices' }, '/#invoices'],
    ] as const) {
      const endpoint = await f.subscription(f.admin);
      const response = await f.request('/api/push/test', 'POST', { endpoint, ...context }, f.admin);
      assert.equal(response.status, 200, JSON.stringify(response.body));
      assert.equal(f.sent.at(-1)!.url, expected);
      assert.equal(f.sent.at(-1)!.probe.id, response.body.probeId);
    }
    const endpoint = await f.subscription(f.operator);
    assert.equal((await f.request('/api/push/test', 'POST', { endpoint, kind: 'operator', operatorPlanId: f.planId }, f.operator)).status, 200);
    assert.equal(f.sent.at(-1)!.url, `/?operatorPlan=${f.planId}#operator`);
  } finally { await f.close(); }
});

test('push test context rejects invalid, inaccessible or missing task targets before rate-limit/probe mutation', async () => {
  const f = await fixture();
  try {
    const endpoint = await f.subscription(f.operator);
    const before = structuredClone((await f.store.read(f.source)).push);
    for (const [context, expected] of [
      [{ kind: 'unknown' }, 400], [{ kind: ['operator'] }, 400],
      [{ kind: 'work' }, 403], [{ kind: 'invoices' }, 403], [{ kind: 'driver' }, 403],
      [{ operatorPlanId: f.planId }, 400], [{ kind: 'operator', operatorPlanId: 'not-a-plan' }, 400],
      [{ kind: 'operator', operatorPlanId: randomUUID() }, 404],
    ] as const) {
      assert.equal((await f.request('/api/push/test', 'POST', { endpoint, ...context }, f.operator)).status, expected);
      assert.deepEqual((await f.store.read(f.source)).push, before);
      assert.equal(f.sent.length, 0);
    }
    const adminEndpoint = await f.subscription(f.admin);
    const beforeAdmin = structuredClone((await f.store.read(f.source)).push);
    assert.equal((await f.request('/api/push/test', 'POST', { endpoint: adminEndpoint, kind: 'work', operatorPlanId: f.planId }, f.admin)).status, 400);
    assert.deepEqual((await f.store.read(f.source)).push, beforeAdmin);
    assert.equal((await f.request('/api/push/test', 'POST', { endpoint, kind: 'operator', operatorPlanId: f.planId }, f.operator)).status, 200);
  } finally { await f.close(); }
});

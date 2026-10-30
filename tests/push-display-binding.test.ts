import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { dispatchReminders, pushDisplayBinding, type PushConfig } from '../server/push';
import { migrateWorkStorage } from '../server/work-partition';
import { writeTripsQaSnapshot } from '../scripts/qa-trips-runtime.mjs';

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const config: PushConfig = { publicKey: 'synthetic', privateKey: 'synthetic', subject: 'https://crm.synthetic.test', schedule: true };
const subscription = () => {
  const key = createECDH('prime256v1'); key.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/synthetic-${randomUUID()}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
};

for (const partitioned of [false, true]) test(`push display binding follows the authenticated session, never grants access and covers scheduled/test pushes (${partitioned ? 'partitioned' : 'legacy'})`, async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'push-display-'));
  const snapshot = resolve(directory, 'snapshot'), storeDirectory = resolve(directory, 'store');
  const source = await writeTripsQaSnapshot(snapshot), store = new OperationsStore(storeDirectory);
  const payloads: { displayBinding: string; probe?: { id: string; token: string }; url: string }[] = [];
  const denied = async () => { throw new Error('External providers are forbidden'); };
  const api = createSnapshotMiddleware(snapshot, { operationsStore: store, operationsDirectory: storeDirectory,
    bankEnvironment: { ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false' }, cabinetEnvironment: {}, geocoderEnvironment: {},
    bankRequest: denied, sberRequest: denied, fetcher: denied, pushConfig: config,
    pushSender: async (_device, payload) => { payloads.push(JSON.parse(payload)); } });
  const server = createServer((request, response) => api(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = (path: string, body?: unknown, cookie?: string) => fetch(url + path, {
    method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  try {
    const credentials = { login: 'synthetic.owner', password: 'Synthetic-push-display-password' };
    const setup = await request('/api/auth/setup', { ...credentials, name: 'Synthetic owner' });
    assert.equal(setup.status, 200);
    const owner = (await setup.json()).user, cookie = setup.headers.get('set-cookie')!.split(';')[0];
    if (partitioned) await migrateWorkStorage(storeDirectory, source);
    const sessionToken = cookie.slice(cookie.indexOf('=') + 1), sessionHash = hash(sessionToken);
    const first = await request('/api/push/config', undefined, cookie), firstConfig = await first.json();
    assert.equal(first.status, 200); assert.equal(first.headers.get('cache-control'), 'no-store');
    assert.equal(firstConfig.displayBinding, pushDisplayBinding(sessionHash));
    assert.match(firstConfig.displayBinding, /^[a-f0-9]{64}$/);
    assert.notEqual(firstConfig.displayBinding, sessionHash);
    assert.equal(JSON.stringify(firstConfig).includes(sessionToken), false);
    assert.equal(JSON.stringify(firstConfig).includes(sessionHash), false);
    assert.equal((await request('/api/push/config')).status, 401);
    assert.equal((await request('/api/push/config', undefined, `artel_session=${firstConfig.displayBinding}`)).status, 401, 'Display binding is never an authentication token');
    const sub = subscription();
    assert.equal((await request('/api/push/subscription', { subscription: sub, explicit: true }, cookie)).status, 200);
    assert.equal((await request('/api/push/test', { endpoint: sub.endpoint }, cookie)).status, 200);
    assert.equal(payloads.length, 1); assert.equal(payloads[0].displayBinding, firstConfig.displayBinding);
    const probe = payloads[0].probe!;
    assert.equal((await request('/api/push/test-receipt', { probeId: probe.id, token: probe.token })).status, 200);
    assert.equal((await (await request(`/api/push/test-status?probeId=${probe.id}`, undefined, cookie)).json()).status, 'confirmed');
    const jobId = randomUUID();
    await store.mutate(source, data => {
      data.push!.invoiceEvents = { [`invoice-ready:${jobId}`]: { userId: owner.id, jobId, occurredAt: Date.now() } };
      return { result: null, changed: true };
    });
    const delivered = await dispatchReminders(store, source, config, async (_device, payload) => { payloads.push(JSON.parse(payload)); });
    assert.equal(delivered.sent, 1); assert.equal(payloads[1].displayBinding, firstConfig.displayBinding); assert.match(payloads[1].url, /#invoices$/);
    const logout = await request('/api/auth/logout', {}, cookie); assert.equal(logout.status, 200); await logout.json();
    assert.equal((await request('/api/push/config', undefined, cookie)).status, 401);
    assert.equal((await store.read(source)).push!.devices.length, 0);
    const login = await request('/api/auth/login', credentials); assert.equal(login.status, 200); await login.json();
    const newCookie = login.headers.get('set-cookie')!.split(';')[0];
    const next = await (await request('/api/push/config', undefined, newCookie)).json();
    assert.notEqual(next.displayBinding, firstConfig.displayBinding, 'Queued payload from the same user’s previous login cannot pass display check');
    assert.equal((await request('/api/push/subscription', { subscription: sub, explicit: false }, newCookie)).status, 409, 'Retained browser transport cannot silently re-enable a removed server device');
    await store.mutate(source, data => {
      const user = data.accounts!.users.find(row => row.id === owner.id)!;
      data.accounts!.users.push({ ...user, id: 'synthetic-other-director', login: 'synthetic.other' });
      user.active = false;
      return { result: null, changed: true };
    });
    assert.equal((await request('/api/push/config', undefined, newCookie)).status, 401);
  } finally { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); }
});

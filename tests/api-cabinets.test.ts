import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { randomBytes, randomUUID } from 'node:crypto';
import { OperationsStore } from '../server/operations-store';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { decryptCabinetCredentials, encryptCabinetCredentials, validateCabinets } from '../server/cabinet-connections';

const env = { ARTEL_CABINET_ENCRYPTION_KEY: randomBytes(32).toString('hex') };
const input = { provider: 'glopro', label: 'Тестовый кабинет', login: 'fixture-provider-login', password: ' fixture-provider-password ' };
async function fixture(environment: Record<string, string | undefined> = env) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-cabinets-test-')), store = new OperationsStore(directory);
  const base = await loadSnapshot();
  const middleware = createSnapshotMiddleware(undefined, { operationsStore: store, cabinetEnvironment: environment });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = () => {
    let cookie = '';
    return async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
      const response = await fetch(origin + path, { method, headers: { cookie, 'Content-Type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
      return { status: response.status, body: await response.json(), headers: response.headers };
    };
  };
  const director = client(), password = randomUUID();
  const setup = await director('/api/auth/setup', 'POST', { name: 'Cabinet QA', login: 'cabinet-qa', password });
  if (setup.status !== 200) {
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done()));
    await rm(directory, { recursive: true, force: true });
    assert.fail(`Fixture setup failed: ${setup.status}`);
  }
  return { store, source: base.provenance.sourceSha256, client, director, password,
    close: async () => { await new Promise<void>(done => { server.close(() => done()); server.closeAllConnections(); }); await rm(directory, { recursive: true, force: true }); } };
}

test('cabinet credentials are encrypted, bound to provider and connection, and failures never disclose secrets', () => {
  const secret = { login: input.login, password: input.password };
  const encoded = encryptCabinetCredentials('one', 'glopro', secret, env);
  assert.ok(!encoded.includes(input.login)); assert.ok(!encoded.includes(input.password));
  assert.deepEqual(decryptCabinetCredentials('one', 'glopro', encoded, env), secret);
  for (const [id, provider, key] of [['two', 'glopro', env], ['one', 'rosneft', env], ['one', 'glopro', { ARTEL_CABINET_ENCRYPTION_KEY: '0'.repeat(64) }]] as const) {
    assert.throws(() => decryptCabinetCredentials(id, provider, encoded, key), /Не удалось прочитать/);
  }
  assert.throws(() => encryptCabinetCredentials('one', 'glopro', secret, {}), /не настроено/);
});

test('saving access does not claim login or balance success; public API and disk contain no plaintext credentials', async () => {
  const f = await fixture();
  try {
    const before = await f.store.read(f.source);
    const saved = await f.director('/api/cabinets', 'POST', input);
    assert.equal(saved.status, 201); assert.equal(saved.body.connection.state, 'awaiting_setup');
    const publicData = await f.director('/api/cabinets');
    assert.equal(publicData.status, 200); assert.equal(publicData.headers.get('cache-control'), 'no-store');
    assert.equal(publicData.body.connections.length, 1); assert.equal(publicData.body.credentialStorageReady, true);
    const publicText = JSON.stringify([saved.body, publicData.body]);
    for (const value of [input.login, input.password, 'encryptedCredentials', 'balance']) assert.ok(!publicText.includes(value));
    const after = await f.store.read(f.source), connection = Object.values(after.cabinets!.connections)[0];
    assert.deepEqual(decryptCabinetCredentials(connection.id, connection.provider, connection.encryptedCredentials, env), { login: input.login, password: input.password });
    const disk = await readFile(f.store.path, 'utf8');
    assert.ok(!disk.includes(input.login)); assert.ok(!disk.includes(input.password));
    assert.deepEqual({ ...after, revision: before.revision, cabinets: undefined }, { ...before, cabinets: undefined });
    const restarted = new OperationsStore(resolve(f.store.path, '..'));
    assert.deepEqual((await restarted.read(f.source)).cabinets, after.cabinets);
    assert.equal((await f.director('/api/cabinets', 'POST', input)).status, 409);
    const corrupt = structuredClone(after.cabinets!); Object.values(corrupt.connections)[0].encryptedCredentials = 'plaintext';
    assert.throws(() => validateCabinets(corrupt));
  } finally { await f.close(); }
});

test('cabinet routes enforce authentication, admin roles, origin, bounded input and configured encryption', async () => {
  const f = await fixture();
  try {
    const anonymous = f.client();
    assert.equal((await anonymous('/api/cabinets')).status, 401);
    assert.equal((await anonymous('/api/cabinets', 'POST', input)).status, 401);
    const manager = await f.director('/api/directories', 'POST', { kind: 'managers', name: 'Cabinet Employee QA' });
    const created = await f.director('/api/auth/users', 'POST', { name: 'Employee QA', login: 'employee-qa', password: f.password, role: 'employee', managerId: manager.body.entry.id, sections: ['payments'] });
    assert.equal(created.status, 201, JSON.stringify(created.body));
    const employee = f.client(); await employee('/api/auth/login', 'POST', { login: 'employee-qa', password: f.password });
    assert.equal((await employee('/api/cabinets')).status, 403);
    assert.equal((await employee('/api/cabinets', 'POST', input)).status, 403);
    assert.equal((await f.director('/api/cabinets', 'POST', input, { origin: 'https://other.test' })).status, 403);
    for (const body of [{ ...input, provider: 'unknown' }, { ...input, url: 'http://127.0.0.1' }, { ...input, password: '' }, { ...input, password: 'x'.repeat(17000) }]) assert.ok([400, 413].includes((await f.director('/api/cabinets', 'POST', body)).status));
    assert.equal((await f.director('/api/cabinets/unknown')).status, 404);
    assert.equal((await f.director('/api/cabinets', 'DELETE')).status, 405);
    assert.equal((await f.director('/api/cabinets')).body.connections.length, 0);
  } finally { await f.close(); }
  const unconfigured = await fixture({});
  try {
    assert.equal((await unconfigured.director('/api/cabinets')).body.credentialStorageReady, false);
    assert.equal((await unconfigured.director('/api/cabinets', 'POST', input)).status, 409);
    assert.equal((await unconfigured.director('/api/cabinets')).body.connections.length, 0);
  } finally { await unconfigured.close(); }
});


test('natcar requires an explicit organization scope and returns it without credentials', async () => {
  const f = await fixture();
  try {
    for (const organizationNames of [undefined, [], ['Тест', 'ООО ТЕСТ'], [''], ['x'.repeat(301)]]) {
      assert.equal((await f.director('/api/cabinets', 'POST', { ...input, provider: 'natcar', organizationNames })).status, 400);
    }
    const names = ['Первая компания', 'Вторая компания'];
    const saved = await f.director('/api/cabinets', 'POST', { ...input, provider: 'natcar', organizationNames: names });
    assert.equal(saved.status, 201); assert.deepEqual(saved.body.connection.organizationNames, names);
    assert.equal(saved.body.connection.accounts, undefined);
    assert.equal((await f.director('/api/cabinets', 'POST', { ...input, organizationNames: names })).status, 400);
  } finally { await f.close(); }
});

test('natcar scope update preserves the existing connection, credentials and old snapshot, rejects stale edits and foreign origins', async () => {
  const f = await fixture();
  try {
    const names = ['Первая компания', 'Вторая компания'];
    const saved = await f.director('/api/cabinets', 'POST', { ...input, provider: 'natcar', organizationNames: names });
    const id = saved.body.connection.id, path = `/api/cabinets/${id}/organizations`;
    const before = await f.store.read(f.source), original = before.cabinets!.connections[id];
    const body = { organizationNames: [...names, 'Третья компания'], expectedOrganizationNames: names };
    assert.equal((await f.client()(path, 'PATCH', body)).status, 401);
    assert.equal((await f.director(path, 'PATCH', body, { origin: 'https://other.test' })).status, 403);
    for (const invalid of [{ ...body, login: 'overwrite' }, { ...body, organizationNames: [] }, { ...body, organizationNames: ['Тест', 'ООО ТЕСТ'] }]) assert.equal((await f.director(path, 'PATCH', invalid)).status, 400);
    const result = await f.director(path, 'PATCH', body);
    assert.equal(result.status, 200); assert.deepEqual(result.body.connection.organizationNames, body.organizationNames);
    assert.ok(!JSON.stringify(result.body).includes('encryptedCredentials'));
    assert.equal((await f.director(path, 'PATCH', body)).status, 409);
    const after = await f.store.read(f.source), changed = after.cabinets!.connections[id];
    assert.equal(Object.keys(after.cabinets!.connections).length, 1);
    assert.deepEqual({ ...changed, organizationNames: original.organizationNames, state: original.state, error: undefined }, { ...original, error: undefined });
    assert.deepEqual({ ...after, revision: before.revision, cabinets: before.cabinets }, before);
    validateCabinets(after.cabinets);
    const same = await f.director(path, 'PATCH', { ...body, expectedOrganizationNames: body.organizationNames });
    assert.equal(same.status, 200); assert.equal((await f.store.read(f.source)).revision, after.revision);
  } finally { await f.close(); }
});

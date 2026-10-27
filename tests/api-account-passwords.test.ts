import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { decryptAccountPassword, encryptAccountPassword } from '../server/account-passwords';
import { passwordFields, saveUser } from '../server/auth';

test('password encryption authenticates the hash and rejects tampering and missing/wrong keys', async () => {
  const key = randomBytes(32).toString('hex'), password = ' Тестовый пароль 🔐 ';
  const record = await passwordFields(password, key);
  assert.equal(decryptAccountPassword(record, key), password);
  assert.notEqual(encryptAccountPassword(password, record, key), record.passwordCiphertext);
  assert.throws(() => decryptAccountPassword(record, undefined), /недоступно/);
  assert.throws(() => decryptAccountPassword(record, randomBytes(32).toString('hex')), /прочитать/);
  assert.throws(() => decryptAccountPassword({ ...record, passwordHash: '0'.repeat(128) }, key), /прочитать/);
  assert.throws(() => decryptAccountPassword({ ...record, passwordCiphertext: record.passwordCiphertext!.slice(0, -2) + (record.passwordCiphertext!.endsWith('ff') ? '00' : 'ff') }, key), /прочитать/);
  await assert.rejects(passwordFields(password, 'invalid'), /недоступно/);
});

test('password API covers create, reset, drivers, legacy preservation, session permissions and stale requests', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-password-'));
  const key = randomBytes(32).toString('hex'), base = await loadSnapshot(), store = new OperationsStore(directory);
  const middleware = createSnapshotMiddleware(undefined, { operationsStore: store, accountPasswordKey: key });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let cookie = '';
  const call = async (path: string, method = 'GET', body?: unknown, auth = cookie, origin?: string) => {
    const response = await fetch(url + path, { method, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(auth ? { cookie: auth } : {}), ...(origin ? { origin } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, body: await response.json(), headers: response.headers };
  };
  try {
    // A legacy account is created before the feature, with only a hash.
    await store.mutate(base.provenance.sourceSha256, async data => ({ changed: true, result: await saveUser(data, base, { name: 'Legacy', login: 'legacy', password: 'legacy-password-test' }, undefined, true) }));
    const before = (await store.read(base.provenance.sourceSha256)).accounts!.users[0];
    const signed = await call('/api/auth/login', 'POST', { login: 'legacy', password: 'legacy-password-test' });
    cookie = signed.headers.get('set-cookie')!.split(';')[0];
    assert.deepEqual((await store.read(base.provenance.sourceSha256)).accounts!.users[0], before);
    const legacyPath = `/api/auth/users/${before.id}/password`;
    assert.equal((await call(legacyPath, 'POST', { version: 1 })).status, 409);
    assert.equal((await call('/api/auth/users')).body.users[0].passwordAvailable, false);
    const employee = (await call('/api/auth/employees', 'POST', { name: 'QA viewer' })).body.entry;
    const password = randomBytes(24).toString('hex');
    const created = await call('/api/auth/users', 'POST', { name: 'QA employee', login: 'qa.employee', role: 'employee', managerId: employee.id, password, sections: [] });
    assert.equal(created.status, 201);
    const user = created.body.user, path = `/api/auth/users/${user.id}/password`;
    const raw = await readFile(store.path, 'utf8');
    assert.ok(!raw.includes(password)); assert.ok(raw.includes('passwordCiphertext'));
    for (const result of [created, await call('/api/auth/users'), await call('/api/auth/session'), await call('/api/snapshot')]) {
      assert.ok(!JSON.stringify(result.body).includes(password)); assert.ok(!JSON.stringify(result.body).includes('passwordCiphertext'));
    }
    const readBefore = await readFile(store.path, 'utf8');
    const shown = await call(path, 'POST', { version: 1 });
    assert.equal(shown.status, 200); assert.equal(shown.body.password, password); assert.equal(shown.headers.get('cache-control'), 'no-store');
    assert.equal(await readFile(store.path, 'utf8'), readBefore);
    assert.equal((await call(path, 'GET')).status, 405);
    assert.equal((await call(path, 'POST', { version: 1 }, '')).status, 401);
    assert.equal((await call(path, 'POST', { version: 1 }, cookie, 'https://foreign.example')).status, 403);
    assert.equal((await call(path, 'POST', { version: 2 })).status, 409);
    assert.equal((await call(path, 'POST', { version: 1, unexpected: true })).status, 400);
    const employeeLogin = await call('/api/auth/login', 'POST', { login: user.login, password });
    const employeeCookie = employeeLogin.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await call(path, 'POST', { version: 1 }, employeeCookie)).status, 403);
    const password2 = randomBytes(24).toString('hex');
    const edit = { name: user.name, login: user.login, role: user.role, managerId: user.managerId, sections: ['accounts'], version: 1, password: password2 };
    assert.equal((await call(`/api/auth/users/${user.id}`, 'PATCH', edit)).status, 200);
    assert.equal((await call(path, 'POST', { version: 1 })).status, 409);
    assert.equal((await call(path, 'POST', { version: 2 })).body.password, password2);
    assert.equal((await call('/api/auth/session', 'GET', undefined, employeeCookie)).body.user, null);
    assert.equal((await call('/api/auth/login', 'POST', { login: user.login, password })).status, 401);
    const delegated = await call('/api/auth/login', 'POST', { login: user.login, password: password2 });
    assert.equal(delegated.status, 200);
    const delegatedCookie = delegated.headers.get('set-cookie')!.split(';')[0];
    assert.equal((await call(path, 'POST', { version: 2 }, delegatedCookie)).status, 200);
    assert.equal((await call(`/api/auth/users/${user.id}`, 'PATCH', { ...edit, version: 2, password: '', sections: [] })).status, 200);
    assert.equal((await call(path, 'POST', { version: 3 })).body.password, password2);
    assert.equal((await call(path, 'POST', { version: 3 }, delegatedCookie)).status, 401);
    const driverId = 'password-test-driver';
    await store.mutate(base.provenance.sourceSha256, data => { data.directories!.vehicles.push({ id: 'password-vehicle', plate: 'Т001ТТ777' }); data.directories!.drivers.push({ id: driverId, name: 'QA driver', vehicleId: 'password-vehicle' }); return { changed: true, result: null }; });
    const issued = await call(`/api/drivers/${driverId}/access`, 'POST', { version: 0, action: 'issue' });
    assert.equal(issued.status, 200);
    const driverPath = `/api/auth/users/${issued.body.access.userId}/password`;
    assert.equal((await call(driverPath, 'POST', { version: 1 })).body.password, issued.body.temporaryPassword);
    const driverLogin = await call('/api/auth/login', 'POST', { login: issued.body.access.login, password: issued.body.temporaryPassword });
    assert.equal((await call(driverPath, 'POST', { version: 1 }, driverLogin.headers.get('set-cookie')!.split(';')[0])).status, 403);
    const reset = await call(`/api/drivers/${driverId}/access`, 'POST', { version: 1, action: 'reset', password: 'new-driver-password' });
    assert.equal(reset.status, 200);
    assert.equal((await call(driverPath, 'POST', { version: 2 })).body.password, 'new-driver-password');
    assert.deepEqual((await store.read(base.provenance.sourceSha256)).accounts!.users[0], before);
    assert.equal((await call(`/api/auth/users/${user.id}`, 'DELETE', { version: 3, confirmationName: user.name })).status, 200);
    assert.equal((await call(path, 'POST', { version: 4 })).status, 404);
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); }
});

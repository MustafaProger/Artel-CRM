import assert from 'node:assert/strict';
import { createECDH, createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { decode, encode } from 'jpeg-js';
import { dirname } from 'node:path';
import { OperationsStore } from '../server/operations-store';
import { avatarPresetIds, avatarPresetUrl } from '../web/src/avatar-model';
import { createSnapshotMiddleware } from '../server/local-api';
import { integrationRuntime } from './helpers/trip-saby-integration';

const profile = '/api/auth/profile';
const pushConfig = { publicKey: 'synthetic-public', privateKey: 'synthetic-private', subject: 'https://crm.test', schedule: true };
const sessionHash = (cookie: string) => createHash('sha256').update(cookie.slice(cookie.indexOf('=') + 1)).digest('hex');
const randomPassword = () => randomBytes(24).toString('base64url');
function subscription() {
  const key = createECDH('prime256v1');
  key.generateKeys();
  return { endpoint: `https://fcm.googleapis.com/fcm/send/${randomUUID()}`, keys: { p256dh: key.getPublicKey().toString('base64url'), auth: randomBytes(16).toString('base64url') } };
}
async function fixture() {
  const rt = await integrationRuntime();
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, {
    operationsStore: rt.store, sabyWorkflowMonitoringEnabled: false, accountPasswordKey: randomBytes(32).toString('hex'),
    pushConfig, pushSender: async () => { throw new Error('Unexpected push dispatch'); },
  });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function raw(path: string, method = 'GET', body?: unknown, cookie?: string, headers?: Record<string, string>) {
    return fetch(origin + path, {
      method,
      headers: { ...(cookie ? { cookie } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  async function call(...args: Parameters<typeof raw>) {
    const response = await raw(...args);
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  const login = (login: string, password: string, audience = '') => call(`/api${audience}/auth/login`, 'POST', { login, password });
  const admin = await call('/api/auth/setup', 'POST', { name: 'Test director', login: 'profile-director', password: randomPassword() });
  assert.equal(admin.status, 200);
  const employeePassword = randomPassword();
  const employee = await call('/api/auth/users', 'POST', {
    name: 'Test employee', login: 'profile-employee', password: employeePassword, role: 'employee',
    managerId: 'manager', sections: ['work', 'invoices', 'trips'],
  }, admin.cookie);
  assert.equal(employee.status, 201);
  return { ...rt, raw, call, login, admin, employee: employee.body.user, employeePassword,
    async close() { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}

test('a profile update edits only the current display name, keeps the directory identity, and rejects concurrent stale edits', async () => {
  const f = await fixture();
  try {
    const signed = await f.login(f.employee.login, f.employeePassword);
    const other = await f.login(f.employee.login, f.employeePassword);
    const body = { version: f.employee.version, name: ' Новое имя ' };
    assert.equal((await f.call(profile, 'PATCH', body)).status, 401);
    assert.equal((await f.call(profile, 'PATCH', body, signed.cookie, { 'X-Artel-Account': f.admin.body.user.id })).status, 401);
    assert.equal((await f.call(profile, 'PATCH', body, signed.cookie, { Origin: 'https://foreign.example' })).status, 403);
    for (const input of [{ role: 'director' }, { login: 'невалидный логин' }, { managerId: 'another' }, { sections: ['accounts'] }, { id: f.admin.body.user.id }, { name: ' ' }]) {
      assert.equal((await f.call(profile, 'PATCH', { ...body, ...input }, signed.cookie)).status, 400);
    }
    const [first, second] = await Promise.all([
      f.call(profile, 'PATCH', body, signed.cookie),
      f.call(profile, 'PATCH', { ...body, name: 'Другое имя' }, other.cookie),
    ]);
    assert.deepEqual([first.status, second.status].sort(), [200, 409]);
    const changed = (first.status === 200 ? first : second).body.user;
    assert.equal(changed.name, first.status === 200 ? 'Новое имя' : 'Другое имя');
    assert.deepEqual(changed, { ...f.employee, name: changed.name, version: f.employee.version + 1 });
    for (const auth of [signed.cookie, other.cookie]) {
      assert.deepEqual((await f.call('/api/auth/session', 'GET', undefined, auth)).body.user, changed);
    }
    const noChange = await f.call(profile, 'PATCH', { version: changed.version, name: changed.name }, signed.cookie);
    assert.deepEqual(noChange.body.user, changed);
    assert.equal((await f.call('/api/auth/users', 'GET', undefined, f.admin.cookie)).body.staff.managers[0].name, 'Тест');
  } finally { await f.close(); }
});

test('password update requires the current secret and revokes only other sessions and their push bindings', async () => {
  const f = await fixture();
  try {
    const [signed, other, logistics] = await Promise.all([
      f.login(f.employee.login, f.employeePassword),
      f.login(f.employee.login, f.employeePassword),
      f.login(f.employee.login, f.employeePassword, '/logistics'),
    ]);
    assert.ok(signed.cookie && other.cookie && logistics.cookie);
    for (const auth of [signed.cookie, other.cookie]) {
      assert.equal((await f.call('/api/push/subscription', 'POST', { subscription: subscription(), explicit: true }, auth)).status, 200);
    }
    const passwordView = `/api/auth/users/${f.employee.id}/password`;
    assert.equal((await f.call(passwordView, 'POST', { version: 1 }, f.admin.cookie)).body.password, f.employeePassword);
    const newPassword = randomPassword();
    assert.equal((await f.call(profile, 'PATCH', { version: 1, newPassword }, signed.cookie)).status, 400);
    assert.equal((await f.call(profile, 'PATCH', { version: 1, currentPassword: f.employeePassword, newPassword: 'short' }, signed.cookie)).status, 400);
    const wrong = await f.call(profile, 'PATCH', { version: 1, name: 'Must not change', currentPassword: 'wrong-password', newPassword }, signed.cookie);
    assert.equal(wrong.status, 403);
    assert.deepEqual((await f.call('/api/auth/session', 'GET', undefined, other.cookie)).body.user, f.employee);
    const changed = await f.call(profile, 'PATCH', { version: 1, name: 'Личное имя', currentPassword: f.employeePassword, newPassword }, signed.cookie);
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body, { user: { ...f.employee, name: 'Личное имя', version: 2 } });
    assert.equal((await f.call('/api/auth/session', 'GET', undefined, signed.cookie)).body.user.version, 2);
    assert.equal((await f.call('/api/auth/session', 'GET', undefined, other.cookie)).body.user, null);
    assert.equal((await f.call('/api/logistics/auth/session', 'GET', undefined, logistics.cookie)).body.user, null);
    const stored = await f.store.read(f.source);
    assert.deepEqual(stored.push?.devices.map(row => row.sessionHash), [sessionHash(signed.cookie)]);
    assert.deepEqual(Object.keys(stored.push?.invoiceRevocations ?? {}), [sessionHash(other.cookie)]);
    assert.equal(stored.accounts!.users.find(row => row.id === f.employee.id)!.passwordCiphertext, undefined);
    assert.equal(JSON.stringify(stored).includes(newPassword), false);
    assert.equal((await f.call(passwordView, 'POST', { version: 2 }, f.admin.cookie)).status, 409);
    const listing = await f.call('/api/auth/users', 'GET', undefined, f.admin.cookie);
    assert.equal(listing.body.users.find((row: { id: string }) => row.id === f.employee.id).passwordAvailable, false);
    assert.equal((await f.login(f.employee.login, f.employeePassword)).status, 401);
    assert.equal((await f.login(f.employee.login, newPassword)).status, 200);
  } finally { await f.close(); }
});

test('password attempts are limited per account across sessions without blocking other profile edits or login', async () => {
  const f = await fixture();
  try {
    const a = await f.login(f.employee.login, f.employeePassword);
    const b = await f.login(f.employee.login, f.employeePassword);
    const newPassword = randomPassword();
    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal((await f.call(profile, 'PATCH', { version: 1, currentPassword: 'incorrect', newPassword }, attempt % 2 ? a.cookie : b.cookie)).status, 403);
    }
    assert.equal((await f.call(profile, 'PATCH', { version: 1, currentPassword: f.employeePassword, newPassword }, b.cookie)).status, 429);
    assert.equal((await f.call(profile, 'PATCH', { version: 1, name: 'Employee name' }, a.cookie)).status, 200);
    assert.equal((await f.login(f.employee.login, f.employeePassword)).status, 200);
  } finally { await f.close(); }
});

test('driver can change name, login and password without changing directory identity or access scope', async () => {
  const f = await fixture();
  try {
    const password = randomPassword();
    const issued = await f.call('/api/drivers/driver/access', 'POST', { action: 'issue', version: 0, password }, f.admin.cookie);
    assert.equal(issued.status, 200);
    const login = issued.body.access.login;
    const signed = await f.login(login, password);
    const newPassword = randomPassword();
    const changed = await f.call(profile, 'PATCH', { version: 1, name: 'Позывной', login: ' New.Driver ', currentPassword: password, newPassword }, signed.cookie);
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.body.user, { ...signed.body.user, name: 'Позывной', login: 'new.driver', version: 2 });
    const store = await f.store.read(f.source);
    assert.equal(store.directories!.drivers[0].fullName, 'ВодительТестовый Тест');
    assert.equal((await f.call('/api/driver/trips', 'GET', undefined, signed.cookie)).status, 200);
    assert.equal((await f.call('/api/auth/users', 'GET', undefined, signed.cookie)).status, 403);
    assert.equal((await f.login(login, password)).status, 401);
    assert.equal((await f.login('new.driver', newPassword)).status, 200);
    const driverPhoto = await f.call(profile, 'PATCH', { version: 2, avatar: jpegAvatar() }, signed.cookie);
    assert.equal(driverPhoto.status, 200);
    assert.equal((await f.raw(driverPhoto.body.user.avatarUrl, 'GET', undefined, signed.cookie)).status, 200);
    const employee = await f.login(f.employee.login, f.employeePassword);
    const employeePhoto = await f.call(profile, 'PATCH', { version: 1, avatar: jpegAvatar() }, employee.cookie);
    assert.equal(employeePhoto.status, 200);
    assert.equal((await f.raw(employeePhoto.body.user.avatarUrl, 'GET', undefined, signed.cookie)).status, 404);
  } finally { await f.close(); }
});


const jpegAvatar = (width = 32, height = width) => 'data:image/jpeg;base64,' + encode({
  width, height, data: Buffer.alloc(width * height * 4, 120), comments: ['ORIGINAL-AVATAR-METADATA'],
}, 82).data.toString('base64');

test('avatars allow presets or a normalized JPEG, cache only private reads, and remove obsolete versions', async () => {
  const f = await fixture();
  try {
    const { cookie } = await f.login(f.employee.login, f.employeePassword);
    for (const avatar of ['preset-31', 'https://outside.example/photo', 'data:image/svg+xml;base64,PHN2Zy8+', 'data:image/jpeg;base64,/9j/2Q==', jpegAvatar(257, 1), 'data:image/jpeg;base64,' + Buffer.alloc(65 * 1024).toString('base64')]) {
      assert.equal((await f.call(profile, 'PATCH', { version: 1, avatar }, cookie)).status, 400);
    }
    const avatar = jpegAvatar(256);
    const uploaded = await f.call(profile, 'PATCH', { version: 1, avatar }, cookie);
    assert.equal(uploaded.status, 200);
    const { user } = uploaded.body;
    assert.equal(user.version, 2);
    assert.equal(user.avatarPreset, undefined);
    assert.match(user.avatarUrl, /^\/api\/auth\/avatars\//);
    assert.equal(JSON.stringify(uploaded.body).includes('base64'), false);
    const stored = await new OperationsStore(dirname(f.store.path)).read(f.source);
    assert.ok(stored.accounts!.users.find(row => row.id === user.id)!.avatar);
    const url = user.avatarUrl as string;
    assert.equal((await f.raw(url)).status, 401);
    const response = await f.raw(url, 'GET', undefined, cookie);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/jpeg');
    assert.equal(response.headers.get('cache-control'), 'private, no-cache');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    const etag = response.headers.get('etag');
    assert.ok(etag);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.includes('ORIGINAL-AVATAR-METADATA'), false);
    const image = decode(bytes);
    assert.deepEqual([image.width, image.height], [256, 256]);
    assert.ok(bytes.length <= 32 * 1024);
    assert.equal((await f.raw(url, 'GET', undefined, cookie, { 'If-None-Match': etag })).status, 304);
    assert.deepEqual((await f.call(profile, 'PATCH', { version: 2, avatar }, cookie)).body.user, user);

    const activeUsers = (await f.call('/api/work', 'GET', undefined, f.admin.cookie)).body.users;
    assert.equal(activeUsers.find((row: { id: string }) => row.id === user.id).avatarUrl, url);
    assert.equal(JSON.stringify(activeUsers).includes('base64'), false);
    assert.equal((await f.call(profile, 'PATCH', { version: 1, avatar: 'preset-01' }, cookie)).status, 409);
    let version = 2;
    for (const preset of avatarPresetIds) {
      const result = await f.call(profile, 'PATCH', { version, avatar: preset }, cookie);
      assert.equal(result.status, 200);
      assert.equal(result.body.user.avatarUrl, avatarPresetUrl(preset));
      assert.equal(result.body.user.avatarPreset, preset);
      assert.equal(result.body.user.version, ++version);
    }
    assert.equal((await f.raw(url, 'GET', undefined, cookie, { 'If-None-Match': etag })).status, 404);
    const removed = await f.call(profile, 'PATCH', { version, avatar: null }, cookie);
    assert.deepEqual(removed.body.user, { ...f.employee, version: version + 1 });
  } finally { await f.close(); }
});

test('uploaded photos follow Work and account visibility, including a referenced former employee', async () => {
  const f = await fixture();
  try {
    const employee = await f.login(f.employee.login, f.employeePassword);
    const uploaded = await f.call(profile, 'PATCH', { version: 1, avatar: jpegAvatar() }, employee.cookie);
    assert.equal(uploaded.status, 200);
    const url = uploaded.body.user.avatarUrl;
    const staff = async (login: string, sections: string[]) => {
      const password = randomPassword();
      const record = await f.call('/api/auth/employees', 'POST', { name: login }, f.admin.cookie);
      assert.equal(record.status, 201);
      const added = await f.call('/api/auth/users', 'POST', { name: login, login, password, role: 'employee', managerId: record.body.entry.id, sections }, f.admin.cookie);
      assert.equal(added.status, 201);
      return { ...await f.login(login, password), user: added.body.user };
    };
    const reader = await staff('profile-reader', ['work']);
    const unrelated = await staff('profile-unrelated', ['work']);
    const noWork = await staff('profile-no-work', ['trips']);
    assert.equal((await f.raw(url, 'GET', undefined, reader.cookie)).status, 200);
    assert.equal((await f.raw(url, 'GET', undefined, noWork.cookie)).status, 404);
    const task = await f.call('/api/work/tasks', 'POST', { title: 'Фото автора в работе', assigneeId: reader.user.id }, employee.cookie);
    assert.equal(task.status, 201);
    const { name, login, role, managerId, sections } = uploaded.body.user;
    const disabled = await f.call(`/api/auth/users/${f.employee.id}`, 'PATCH', { name, login, role, managerId, sections, version: 2, active: false }, f.admin.cookie);
    assert.equal(disabled.status, 200);
    assert.equal(disabled.body.user.avatarUrl, url);
    const linkedWork = await f.call('/api/work', 'GET', undefined, reader.cookie);
    assert.deepEqual(linkedWork.body.historicalUsers.find((row: { id: string }) => row.id === f.employee.id), { id: f.employee.id, name, avatarUrl: url });
    assert.equal((await f.raw(url, 'GET', undefined, reader.cookie)).status, 200);
    assert.equal((await f.raw(url, 'GET', undefined, unrelated.cookie)).status, 404);
    assert.equal((await f.raw(url, 'GET', undefined, f.admin.cookie)).status, 200);
    const deleted = await f.call(`/api/auth/users/${f.employee.id}`, 'DELETE', { version: 3, confirmationName: name }, f.admin.cookie);
    assert.equal(deleted.status, 200);
    assert.equal((await f.raw(url, 'GET', undefined, reader.cookie)).status, 404);
    const deletedAuthorWork = await f.call('/api/work', 'GET', undefined, reader.cookie);
    assert.deepEqual(deletedAuthorWork.body.historicalUsers.find((row: { id: string }) => row.id === f.employee.id), { id: f.employee.id, name });
  } finally { await f.close(); }
});


test('self login edits share the account rules and preserve the current identity, sessions and push bindings', async () => {
  const f = await fixture();
  try {
    const a = await f.login(f.employee.login, f.employeePassword);
    const b = await f.login(f.employee.login, f.employeePassword);
    const logistics = await f.login(f.employee.login, f.employeePassword, '/logistics');
    assert.ok(a.cookie && b.cookie && logistics.cookie);
    assert.equal((await f.call('/api/push/subscription', 'POST', { subscription: subscription(), explicit: true }, a.cookie)).status, 200);
    const task = await f.call('/api/work/tasks', 'POST', { title: 'Same assignment after login change', assigneeId: f.employee.id }, a.cookie);
    assert.equal(task.status, 201);
    for (const login of ['ab', 'a'.repeat(65), 'русский', 'with space', '', 12, null]) {
      assert.equal((await f.call(profile, 'PATCH', { version: 1, login }, a.cookie)).status, 400);
    }
    const duplicate = await f.call(profile, 'PATCH', { version: 1, name: 'Should not change', login: ' PROFILE-DIRECTOR ' }, a.cookie);
    assert.deepEqual(duplicate.body, { error: 'Этот логин уже используется.' });
    assert.equal(duplicate.status, 409);
    const before = (await f.store.read(f.source)).accounts!.users.find(row => row.id === f.employee.id)!;
    const change = await f.call(profile, 'PATCH', { version: 1, name: ' Новое имя ', login: ' Staff.New_12 ' }, a.cookie);
    assert.equal(change.status, 200);
    const expected = { ...f.employee, name: 'Новое имя', login: 'staff.new_12', version: 2 };
    assert.deepEqual(change.body, { user: expected });
    for (const cookie of [a.cookie, b.cookie]) assert.deepEqual((await f.call('/api/auth/session', 'GET', undefined, cookie)).body.user, expected);
    assert.deepEqual((await f.call('/api/logistics/auth/session', 'GET', undefined, logistics.cookie)).body.user, expected);
    const work = (await f.call('/api/work', 'GET', undefined, a.cookie)).body.work;
    assert.equal(work.tasks.find((row: { id: string }) => row.id === task.body.entry.id).assigneeId, f.employee.id);
    const after = await f.store.read(f.source);
    const stored = after.accounts!.users.find(row => row.id === f.employee.id)!;
    assert.equal(stored.salt, before.salt);
    assert.equal(stored.passwordHash, before.passwordHash);
    assert.equal(stored.passwordCiphertext, before.passwordCiphertext);
    assert.deepEqual(after.push!.devices.map(row => row.sessionHash), [sessionHash(a.cookie)]);
    assert.deepEqual((await f.call(profile, 'PATCH', { version: 2, login: ' STAFF.NEW_12 ' }, a.cookie)).body, { user: expected });
    assert.equal((await f.call(profile, 'PATCH', { version: 1, login: 'stale-login' }, a.cookie)).status, 409);
    assert.equal((await f.login(f.employee.login, f.employeePassword)).status, 401);
    assert.equal((await f.login(' STAFF.NEW_12 ', f.employeePassword)).status, 200);
  } finally { await f.close(); }
});

test('concurrent self edits cannot claim the same login', async () => {
  const f = await fixture();
  try {
    const signed = await f.login(f.employee.login, f.employeePassword);
    const replies = await Promise.all([
      f.call(profile, 'PATCH', { version: 1, login: 'common-login' }, signed.cookie),
      f.call(profile, 'PATCH', { version: 1, login: ' COMMON-LOGIN ' }, f.admin.cookie),
    ]);
    assert.deepEqual(replies.map(reply => reply.status).sort(), [200, 409]);
    assert.equal((await f.store.read(f.source)).accounts!.users.filter(row => row.login === 'common-login').length, 1);
  } finally { await f.close(); }
});

test('renaming a login does not reset its existing sign-in throttle', async () => {
  const f = await fixture();
  try {
    const signed = await f.login(f.employee.login, f.employeePassword);
    for (let i = 0; i < 5; i++) assert.equal((await f.login(f.employee.login, 'incorrect')).status, 401);
    assert.equal((await f.login(f.employee.login, f.employeePassword)).status, 429);
    const changed = await f.call(profile, 'PATCH', { version: 1, login: 'renamed-login' }, signed.cookie);
    assert.equal(changed.status, 200);
    assert.equal((await f.login('renamed-login', f.employeePassword)).status, 429);
  } finally { await f.close(); }
});

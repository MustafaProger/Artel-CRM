import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { AddressInfo } from 'node:net';
import { test } from 'node:test';
import { createProductionRuntime, productionBankTransports, productionConfiguration, productionRequestAllowed } from '../server/production';
import { encodeOperations } from '../server/operations-store';
import type { BankConfig } from '../server/banking/transport';

const publicOrigin = 'https://crm.example.test:8443';
const publicHost = 'crm.example.test:8443';

async function fixture() {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-production-'));
  const snapshot = resolve(directory, 'snapshot'), store = resolve(directory, 'store'), app = resolve(directory, 'app-dist');
  await Promise.all([mkdir(snapshot), mkdir(store), mkdir(app)]);
  const source = 'a'.repeat(64);
  const meta = { source_file: 'synthetic.xlsx', source_sha256: source, created_at_utc: '2026-01-01T00:00:00Z', source_kind: 'test', google_verified: false, formula_policy: '', ownership_policy: '' };
  const validation = { status: 'ok', registry_verified: false, issue_counts: {}, cell_issues: [], record_flag_counts: {}, duplicate_record_candidates: [], legal_form_alias_candidate_groups: [], multiple_manager_companies: [], limitations: [] };
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const name of ['companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report']) {
    const raw = JSON.stringify({ meta, data: name === 'validation_report' ? validation : [] });
    await writeFile(resolve(snapshot, `${name}.json`), raw);
    files[`${name}.json`] = { sha256: createHash('sha256').update(raw).digest('hex'), bytes: Buffer.byteLength(raw) };
  }
  await writeFile(resolve(snapshot, 'manifest.json'), JSON.stringify({ meta, counts: {}, files }));
  await writeFile(resolve(store, 'operations.json'), encodeOperations({ schemaVersion: 1, sourceSha256: source, revision: 0, shipments: {}, companies: [] }));
  await writeFile(resolve(app, 'index.html'), '<!doctype html><title>Artel synthetic test</title>');
  await writeFile(resolve(app, 'sw.js'), '/* test service worker */');
  await writeFile(resolve(directory, 'secret.txt'), 'private-test-only');
  await symlink(resolve(directory, 'secret.txt'), resolve(app, 'escape.js'));
  const env = { ARTEL_PUBLIC_ORIGIN: publicOrigin, ARTEL_SNAPSHOT_DIR: snapshot, ARTEL_STORE_DIR: store, ARTEL_SETUP_TOKEN: 'synthetic-setup-token', ARTEL_BANK_SYNC_ENABLED: 'true', PORT: '0' };
  async function runtime(environment = env) {
    const cwd = process.cwd();
    let result: Awaited<ReturnType<typeof createProductionRuntime>>;
    try { process.chdir(directory); result = await createProductionRuntime(environment); }
    finally { process.chdir(cwd); }
    await result.start();
    const port = (result.server.address() as AddressInfo).port;
    const request = (path: string, options: { method?: string; body?: unknown; cookie?: string; host?: string; origin?: string | null; headers?: Record<string, string> } = {}) => new Promise<{ status: number; text: string; headers: import('node:http').IncomingHttpHeaders }>((done, reject) => {
      const body = options.body === undefined ? undefined : JSON.stringify(options.body);
      const req = httpRequest({ hostname: '127.0.0.1', port, path, method: options.method ?? 'GET', headers: {
        host: options.host ?? publicHost,
        ...(options.origin === null ? {} : { origin: options.origin ?? publicOrigin }),
        ...(options.cookie ? { cookie: options.cookie } : {}),
        ...(body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {}),
        ...options.headers,
      } }, response => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => done({ status: response.statusCode!, text: Buffer.concat(chunks).toString(), headers: response.headers }));
        response.on('error', reject);
      });
      req.on('error', reject); req.end(body);
    });
    return { ...result, request };
  }
  return { directory, app, snapshot, store, env, runtime, close: () => rm(directory, { recursive: true, force: true }) };
}

test('production configuration fails closed; forwarded headers cannot bypass the configured origin', () => {
  assert.throws(() => productionConfiguration({}), /ARTEL_PUBLIC_ORIGIN/);
  assert.throws(() => productionConfiguration({ ARTEL_PUBLIC_ORIGIN: 'http://crm.example' }), /HTTPS/);
  assert.throws(() => productionConfiguration({ ARTEL_PUBLIC_ORIGIN: 'https://crm.example/path' }), /HTTPS/);
  const valid = { method: 'GET', headers: { host: publicHost } };
  assert.equal(productionRequestAllowed(valid, publicOrigin), true);
  assert.equal(productionRequestAllowed({ ...valid, method: 'POST' }, publicOrigin), false);
  assert.equal(productionRequestAllowed({ method: 'POST', headers: { host: publicHost, origin: publicOrigin } }, publicOrigin), true);
  for (const headers of [
    { host: 'evil.example', origin: publicOrigin, 'x-forwarded-host': publicHost },
    { host: publicHost, origin: 'https://evil.example' },
    { host: publicHost, origin: `${publicOrigin}/` },
    { host: publicHost, origin: publicOrigin, 'sec-fetch-site': 'cross-site' },
  ]) assert.equal(productionRequestAllowed({ method: 'GET', headers }, publicOrigin), false);
});

test('both bank transports are blocked by default, independently of the scheduler flag', async () => {
  let requests = 0;
  const fake = async () => { requests++; return {}; };
  for (const env of [{}, { ARTEL_BANK_SYNC_ENABLED: 'true' }, { ARTEL_BANK_REQUESTS_ENABLED: 'false' }]) {
    const guarded = productionBankTransports(env, { bankRequest: fake, sberRequest: fake });
    await assert.rejects(guarded.bankRequest({} as BankConfig, '/openapi/api/test', 'synthetic'), /выключено/);
    await assert.rejects(guarded.sberRequest({}, { path: '/ic/sso/api/v2/oauth/token', form: { grant_type: 'refresh_token' } }), /выключено/);
  }
  assert.equal(requests, 0);
  const enabled = productionBankTransports({ ARTEL_BANK_REQUESTS_ENABLED: 'true' }, { bankRequest: fake, sberRequest: fake });
  await enabled.bankRequest({} as BankConfig, '/openapi/api/test', 'synthetic');
  await enabled.sberRequest({}, { path: '/synthetic' });
  assert.equal(requests, 2);
});

test('production serves the compiled app only and validates host, origin, traversal and symlinks', async () => {
  const f = await fixture(); const runtime = await f.runtime();
  try {
    const health = await runtime.request('/healthz', { origin: null });
    assert.equal(health.status, 200); assert.deepEqual(JSON.parse(health.text), { status: 'ok' });
    assert.equal((await runtime.request('/healthz', { host: 'evil.example' })).status, 403);
    assert.equal((await runtime.request('/', { origin: 'https://evil.example' })).status, 403);
    assert.match((await runtime.request('/')).text, /Artel synthetic test/);
    assert.match((await runtime.request('/shipments')).text, /Artel synthetic test/);
    assert.equal((await runtime.request('/sw.js')).headers['cache-control'], 'no-cache');
    assert.equal((await runtime.request('/', { method: 'HEAD' })).text, '');
    assert.equal((await runtime.request('/api/snapshot', { origin: null })).status, 401);
    for (const path of ['/data/operations.json', '/server/production.ts', '/.env', '/%2eenv', '/%2e%2e/secret.txt', '/a/../secret.txt', '/%252e%252e/secret.txt', '/escape.js', '/server-render/production.mjs', '/package.json', '/missing.js', '/%5csecret.txt', '/%00']) {
      const result = await runtime.request(path);
      assert.equal(result.status, 404, path); assert.ok(!result.text.includes('private-test-only'));
    }
    const before = await readFile(resolve(f.store, 'operations.json'), 'utf8');
    for (const path of ['/api/banking/connections/tbank-nk-artel/sync', '/api/banking/sber/continue', '/api/banking/sber/sync', `/api/banking/operations/${'a'.repeat(64)}/refresh`]) {
      assert.equal((await runtime.request(path, { method: 'POST', body: {} })).status, 503);
    }
    assert.equal((await runtime.request(`/api/banking/operations/${'a'.repeat(64)}/print`)).status, 503);
    assert.equal((await runtime.request('/api/banking/dispatch')).status, 503);
    assert.equal(await readFile(resolve(f.store, 'operations.json'), 'utf8'), before);
  } finally { await runtime.stop(); await f.close(); }
});

test('HTTPS sessions, saved users and data survive a production restart with authentication intact', async () => {
  const f = await fixture(); let runtime = await f.runtime();
  try {
    const password = randomBytes(20).toString('hex');
    const input = { name: 'Test Director', login: 'director', password, setupToken: f.env.ARTEL_SETUP_TOKEN };
    assert.equal((await runtime.request('/api/auth/setup', { method: 'POST', body: input, origin: null })).status, 403);
    const setup = await runtime.request('/api/auth/setup', { method: 'POST', body: input });
    assert.equal(setup.status, 200);
    const cookie = setup.headers['set-cookie']![0];
    assert.match(cookie, /; Secure/); assert.match(cookie, /; HttpOnly/); assert.match(cookie, /SameSite=Strict/);
    assert.ok(!setup.text.includes(password));
    const session = cookie.split(';')[0];
    const snapshot = await runtime.request('/api/snapshot', { cookie: session });
    assert.equal(snapshot.status, 200);
    const directory = await runtime.request('/api/directories', { method: 'POST', cookie: session, body: { kind: 'products', name: 'Persistent synthetic product' } });
    assert.equal(directory.status, 201, directory.text);
    assert.equal((await runtime.request('/api/banking', { cookie: session })).status, 200);
    assert.equal((await runtime.request('/api/banking/sber/statements', { cookie: session })).status, 200);
    const employee = await runtime.request('/api/directories', { method: 'POST', cookie: session, body: { kind: 'managers', name: 'Limited employee' } });
    assert.equal(employee.status, 201);
    const manager = await runtime.request('/api/auth/users', { method: 'POST', cookie: session, body: {
      name: 'Limited account', login: 'limited', password, role: 'manager', managerId: JSON.parse(employee.text).entry.id, sections: ['shipments'],
    } });
    assert.equal(manager.status, 201, manager.text);
    const managerLogin = await runtime.request('/api/auth/login', { method: 'POST', body: { login: 'limited', password } });
    assert.equal(managerLogin.status, 200);
    const managerCookie = managerLogin.headers['set-cookie']![0].split(';')[0];
    assert.equal((await runtime.request('/api/snapshot', { cookie: managerCookie })).status, 200);
    for (const path of ['/api/auth/users', '/api/banking', '/api/banking/sber/statements', '/api/directories', '/api/settlements']) {
      assert.equal((await runtime.request(path, { cookie: managerCookie })).status, 403, path);
    }
    await runtime.stop(); runtime = await f.runtime();
    const restored = await runtime.request('/api/snapshot', { cookie: session });
    assert.equal(restored.status, 200); assert.match(restored.text, /Persistent synthetic product/);
    assert.equal((await runtime.request('/api/snapshot')).status, 401);
    const login = await runtime.request('/api/auth/login', { method: 'POST', body: { login: 'director', password } });
    assert.equal(login.status, 200);
    const saved = await readFile(resolve(f.store, 'operations.json'), 'utf8');
    assert.ok(!saved.includes(password)); assert.ok(!saved.includes(session.split('=')[1]));
    assert.equal((await runtime.request('/api/auth/logout', { method: 'POST', cookie: session, body: {} })).status, 200);
    assert.equal((await runtime.request('/api/snapshot', { cookie: session })).status, 401);
  } finally { await runtime.stop(); await f.close(); }
});

test('production refuses missing or corrupt persistent storage and corrupt snapshot exports', async () => {
  const f = await fixture();
  try {
    const original = await readFile(resolve(f.store, 'operations.json'), 'utf8');
    await rm(resolve(f.store, 'operations.json'));
    await assert.rejects(f.runtime());
    await writeFile(resolve(f.store, 'operations.json'), '{"corrupt":true}');
    await assert.rejects(f.runtime(), /damaged/);
    await writeFile(resolve(f.store, 'operations.json'), original);
    await writeFile(resolve(f.snapshot, 'companies.json'), '{"corrupt":true}');
    await assert.rejects(f.runtime(), /integrity/);
  } finally { await f.close(); }
});

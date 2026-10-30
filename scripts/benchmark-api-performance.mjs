import assert from 'node:assert/strict';
import { createHash, scryptSync } from 'node:crypto';
import { copyFile, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

// The adapter bundle exports createSnapshotMiddleware, loadSnapshot and OperationsStore.
// No production server is started: schedulers, bridges and real providers are disabled.
const args = Object.fromEntries(Array.from({ length: Math.ceil((process.argv.length - 2) / 2) }, (_, i) => [process.argv[i * 2 + 2]?.replace(/^--/, ''), process.argv[i * 2 + 3]]));
for (const key of ['adapter', 'snapshot', 'output']) assert.ok(args[key], `--${key} is required`);
const iterations = Number(args.iterations ?? 7);
assert.ok(Number.isSafeInteger(iterations) && iterations >= 2 && iterations <= 100);
const sizes = (args.sizes ?? '0,6,30').split(',');
assert.ok(sizes.every(size => /^(?:\d+(?:\.\d+)?|\d+x)$/.test(size)));
const only = args.only ? new Set(args.only.split(',')) : null;
const supported = new Set(['session', 'work', 'operator', 'accounts', 'navigation', 'overview', 'settlements', 'shipments', 'trips', 'tripRequests', 'banking', 'china', 'directories', 'pushConfig', 'workStatus', 'login']);
assert.ok(!only || [...only].every(name => supported.has(name)), '--only contains an unknown measurement ID');
const { createSnapshotMiddleware, loadSnapshot, OperationsStore } = await import(pathToFileURL(resolve(args.adapter)).href);
const snapshotDirectory = resolve(args.snapshot);
const base = await loadSnapshot(snapshotDirectory), source = base.provenance.sourceSha256;
const digest = value => createHash('sha256').update(value).digest('hex');
const token = digest('isolated-performance-session');
const password = 'isolated-benchmark-password-only';
const salt = '0'.repeat(32);
const user = { id: 'performance-owner', name: 'Synthetic performance owner', login: 'performance-owner', role: 'director', managerId: null, active: true, version: 1, passwordHash: scryptSync(password, salt, 64).toString('hex'), salt };
const date = '2026-10-28T00:00:00.000Z';
const task = { id: 'performance-task', version: 1, assigneeId: user.id, createdAt: date, updatedAt: date, createdBy: user.id, updatedBy: user.id, title: 'Synthetic performance task', description: '', status: 'todo', companyId: null, dueDate: null, reminderAt: null };
const blocked = async () => { throw new Error('External providers are disabled in the isolated benchmark'); };
const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * p) - 1)];
const summary = values => ({ minMs: Math.min(...values), medianMs: percentile(values, 0.5), p95Ms: percentile(values, 0.95), maxMs: Math.max(...values) });
const report = { adapterSha256: digest(await readFile(resolve(args.adapter))), iterations, isolated: true, externalProviders: false, liveStoreModified: false,
  growthModel: 'Additional unknown JSON string field grows serialization size only; it does not model additional business records or external scheduler contention.', runs: [] };

for (const size of sizes) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-api-performance-'));
  let server;
  try {
    const store = new OperationsStore(directory);
    if (args.operations) await copyFile(resolve(args.operations), store.path);
    await store.mutate(source, data => {
      // Only this disposable copy receives synthetic authentication/work records.
      data.accounts = { users: [user], sessions: [{ userId: user.id, hash: digest(token), expiresAt: 4_102_444_800_000 }], attempts: {} };
      data.work = { tasks: [structuredClone(task)], companyRecords: [], notes: [] };
      delete data.push;
      return { result: null, changed: true };
    });
    const initialBytes = (await stat(store.path)).size;
    const targetBytes = size.endsWith('x') ? Number(size.slice(0, -1)) * initialBytes : Number(size) * 1024 * 1024;
    if (targetBytes > initialBytes) await store.mutate(source, data => {
      data.syntheticPerformancePadding = 'x'.repeat(Math.floor(targetBytes - initialBytes));
      return { result: null, changed: true };
    });
    const storeBytes = (await stat(store.path)).size;
    const originalRead = store.read.bind(store);
    let reads = 0, readMs = 0;
    store.read = async (...params) => {
      reads++;
      const start = performance.now();
      try { return await originalRead(...params); }
      finally { readMs += performance.now() - start; }
    };
    const middleware = createSnapshotMiddleware(snapshotDirectory, {
      operationsStore: store, operationsDirectory: directory, requireAuthentication: true,
      bankEnvironment: { ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false' },
      cabinetEnvironment: {}, geocoderEnvironment: {}, yandexTilesEnvironment: {},
      bankRequest: blocked, sberRequest: blocked, fetcher: blocked,
      tripRequestGeocoder: async () => ({ status: 'unavailable', reason: 'provider_unavailable' }),
      pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false },
      sabyWorkflowMonitoringEnabled: false,
    });
    server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
    await new Promise(done => server.listen(0, '127.0.0.1', done));
    const url = `http://127.0.0.1:${server.address().port}`;
    const request = async (path, method = 'GET', body) => {
      reads = 0; readMs = 0;
      const start = performance.now();
      const response = await fetch(url + path, { method, headers: { cookie: `artel_session=${token}`, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      const bytes = Buffer.from(await response.arrayBuffer());
      const durationMs = performance.now() - start;
      const json = JSON.parse(bytes.toString());
      return { durationMs, status: response.status, bytes: bytes.length, sha256: digest(bytes), reads, readMs, json };
    };
    const navigationProbe = !only || only.has('navigation') ? await request('/api/navigation') : null;
    const navigation = navigationProbe?.status === 200 ? '/api/navigation' : '/api/snapshot?shipments=omit';
    const endpoints = [
      ['session', '/api/auth/session'], ['work', '/api/work'], ['operator', '/api/operator'], ['accounts', '/api/auth/users'],
      ['navigation', navigation], ['overview', '/api/snapshot?shipments=omit'], ['settlements', '/api/settlements'],
      ['shipments', '/api/shipments?limit=50'], ['trips', '/api/shipment-trips'], ['tripRequests', '/api/trip-requests'],
      ['banking', '/api/banking'], ['china', '/api/china'], ['directories', '/api/directories'], ['pushConfig', '/api/push/config'],
    ].filter(([name]) => !only || only.has(name));
    const measurements = [];
    const loop = monitorEventLoopDelay({ resolution: 10 }); loop.enable();
    const cpuStart = process.cpuUsage();
    const runStart = performance.now();
    const beforeReads = digest(await readFile(store.path));
    for (const [name, path] of endpoints) {
      await request(path); // Exclude route/base-cache initialization from steady-state timing.
      const samples = [];
      for (let i = 0; i < iterations; i++) {
        const { json, ...sample } = await request(path);
        if (name === 'navigation') sample.semanticSha256 = digest(JSON.stringify({ shipmentCount: json.shipmentCount ?? json.overview?.shipmentCount }));
        samples.push(sample);
      }
      measurements.push({ name, path, method: 'GET', ...summary(samples.map(row => row.durationMs)), samples });
    }
    assert.equal(digest(await readFile(store.path)), beforeReads, 'GET benchmark must preserve store bytes');
    if (!only || only.has('workStatus')) {
      let version = 1;
      const samples = [];
      for (let i = 0; i < iterations; i++) {
        const { json, ...sample } = await request(`/api/work/tasks/${task.id}`, 'PATCH', { version, status: i % 2 ? 'todo' : 'done' });
        assert.equal(sample.status, 200, 'synthetic status save must succeed');
        version = json.entry.version;
        sample.semanticSha256 = digest(JSON.stringify({ ...json, entry: { ...json.entry, updatedAt: '<save-time>' } }));
        samples.push(sample);
      }
      measurements.push({ name: 'workStatus', method: 'PATCH', path: '/api/work/tasks/:synthetic', ...summary(samples.map(row => row.durationMs)), samples });
    }
    if (!only || only.has('login')) {
      const loginSamples = [];
      for (let i = 0; i < iterations; i++) {
        const { json: _json, ...sample } = await request('/api/auth/login', 'POST', { login: user.login, password });
        assert.equal(sample.status, 200, 'synthetic login must succeed with the original password algorithm');
        loginSamples.push(sample);
      }
      measurements.push({ name: 'login', method: 'POST', path: '/api/auth/login', ...summary(loginSamples.map(row => row.durationMs)), samples: loginSamples });
    }
    const cpu = process.cpuUsage(cpuStart);
    loop.disable();
    report.runs.push({ requestedSize: size, initialBytes, storeBytes, durationMs: performance.now() - runStart, cpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 }, eventLoopDelayMs: { mean: loop.mean / 1e6, p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 }, peakRssBytes: process.resourceUsage().maxRSS * 1024, getStoreBytesUnchanged: true, measurements });
    await writeFile(resolve(args.output), JSON.stringify(report, null, 2), { mode: 0o600 });
    console.log(JSON.stringify({ requestedSize: size, storeBytes, endpoints: measurements.length, statuses: [...new Set(measurements.flatMap(row => row.samples.map(sample => sample.status)))] }));
  } finally {
    if (server) { server.closeAllConnections(); await new Promise(done => server.close(() => done())); }
    await rm(directory, { recursive: true, force: true });
  }
}

// Run from /app inside the candidate image as its non-root runtime user:
// docker run --rm -i --network none --user 1000:1000 --workdir /app --read-only \
//   --tmpfs /tmp:size=64m,mode=1777 --cap-drop ALL --security-opt no-new-privileges:true \
//   -e ARTEL_RELEASE_NETWORK_NONE=true --entrypoint node IMAGE --input-type=module < this-file
// No production mounts, credentials, authenticated requests, or business writes.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { extname, relative, resolve } from 'node:path';

assert.equal(process.getuid?.(), 1000, 'Static smoke must use runtime uid 1000, never root');
assert.equal(process.getgid?.(), 1000, 'Static smoke must use runtime gid 1000');
assert.equal(process.cwd(), '/app', 'Production runtime resolves app-dist from /app');
assert.equal(process.env.ARTEL_RELEASE_NETWORK_NONE, 'true', 'Invoke with --network none and the release guard');
assert.ok(Object.values(networkInterfaces()).flat().every(address => address.internal), 'Only the isolated loopback network is allowed');
const publicRoot = '/app/app-dist';
const hash = value => createHash('sha256').update(value).digest('hex');
let externalRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { externalRequests++; throw new Error('External fetch forbidden in static image smoke'); };
const root = await mkdtemp('/tmp/artel-static-image-smoke-');
let runtime;
try {
  const snapshot = resolve(root, 'snapshot'), store = resolve(root, 'operations');
  await Promise.all([mkdir(snapshot), mkdir(store)]);
  const source = 'a'.repeat(64);
  const meta = { source_file: 'synthetic.xlsx', source_sha256: source, created_at_utc: '2026-10-20T00:00:00Z', source_kind: 'test', google_verified: false, formula_policy: '', ownership_policy: '' };
  const validation = { status: 'ok', registry_verified: false, issue_counts: {}, cell_issues: [], record_flag_counts: {}, duplicate_record_candidates: [], legal_form_alias_candidate_groups: [], multiple_manager_companies: [], limitations: [] };
  const files = {};
  for (const name of ['companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report']) {
    const raw = JSON.stringify({ meta, data: name === 'validation_report' ? validation : [] });
    await writeFile(resolve(snapshot, `${name}.json`), raw);
    files[`${name}.json`] = { sha256: hash(raw), bytes: Buffer.byteLength(raw) };
  }
  await writeFile(resolve(snapshot, 'manifest.json'), JSON.stringify({ meta, counts: {}, files }));
  const data = { schemaVersion: 2, sourceSha256: source, revision: 0, shipments: {}, companies: [], paymentAllocations: [], directories: { managers: [], products: [], paymentForms: [], vehicles: [], drivers: [], addresses: [], defaults: { profit: 'template-payment-form' }, duplicates: [], customerManagers: [], fleetSeedApplied: true } };
  const envelope = JSON.stringify({ sha256: hash(JSON.stringify(data)), data });
  await writeFile(resolve(store, 'operations.json'), envelope);
  const { createProductionRuntime } = await import('/app/server-render/production.mjs');
  runtime = await createProductionRuntime({
    ARTEL_PUBLIC_ORIGIN: 'https://static.synthetic.test', ARTEL_LISTEN_HOST: '127.0.0.1', PORT: '0',
    ARTEL_SNAPSHOT_DIR: snapshot, ARTEL_STORE_DIR: store,
    ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false',
    ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_GEOCODER_ENABLED: 'false',
    SABY_WORKFLOW_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false',
  });
  await runtime.start();
  const request = path => new Promise((done, reject) => {
    const req = httpRequest({ hostname: '127.0.0.1', port: runtime.server.address().port, path, method: 'GET', headers: { host: 'static.synthetic.test', 'cache-control': 'no-cache' } }, response => {
      const chunks = [];
      response.on('data', chunk => chunks.push(chunk));
      response.on('error', reject);
      response.on('end', () => done({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks) }));
    });
    req.setTimeout(10000, () => req.destroy(new Error('Static HTTP request timeout: ' + path)));
    req.on('error', reject); req.end();
  });
  assert.equal((await request('/healthz')).status, 200, 'Synthetic runtime must be healthy');
  // HTTP precedes direct file reading so the original root-owned mode-0600
  // index regression fails here as a public 404 despite healthy /healthz.
  const shell = await request('/');
  assert.equal(shell.status, 200, 'GET / must serve the shell as uid 1000 (healthy alone is insufficient)');
  assert.match(String(shell.headers['content-type']), /^text\/html\b/);
  const paths = [];
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      assert.ok(!entry.isSymbolicLink(), 'Public file inventory must not contain symlinks');
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) paths.push(path);
    }
  };
  await walk(publicRoot); paths.sort();
  assert.ok(paths.includes(resolve(publicRoot, 'index.html')));
  assert.ok(paths.some(path => path.endsWith('.js')) && paths.some(path => path.endsWith('.css')), 'Compiled JS and CSS must be present');
  const publishedFiles = {};
  for (const path of paths) {
    const name = relative(publicRoot, path);
    const urlPath = '/' + name.split('/').map(encodeURIComponent).join('/');
    const response = await request(urlPath);
    assert.equal(response.status, 200, 'Public file is not HTTP-readable by uid 1000: ' + name);
    const raw = await readFile(path), info = await stat(path);
    assert.equal(hash(response.body), hash(raw), 'HTTP bytes differ from image file: ' + name);
    assert.equal(Number(response.headers['content-length']), raw.length, 'HTTP length differs: ' + name);
    assert.equal(response.headers['x-content-type-options'], 'nosniff');
    if (extname(name) === '.js') assert.match(String(response.headers['content-type']), /javascript/);
    if (extname(name) === '.css') assert.match(String(response.headers['content-type']), /^text\/css\b/);
    publishedFiles[name] = { sha256: hash(raw), bytes: raw.length, uid: info.uid, gid: info.gid, mode: (info.mode & 0o777).toString(8) };
  }
  assert.equal(hash(shell.body), publishedFiles['index.html'].sha256, 'GET / must equal index.html');
  for (const path of ['/.env', '/server-render/production.mjs', '/data/operations/operations.json']) assert.equal((await request(path)).status, 404, path);
  assert.equal(await readFile(resolve(store, 'operations.json'), 'utf8'), envelope, 'Static HTTP checks must not mutate the synthetic store');
  assert.equal(externalRequests, 0);
  console.log(JSON.stringify({ synthetic: true, runtimeUid: process.getuid(), runtimeGid: process.getgid(), networkDisabled: true, productionMountsUsed: false, externalRequests, health: 200, shell: 200, publicFileCount: paths.length, allFilesHttpVerified: true, syntheticStoreUnchanged: true, publishedFiles }));
} finally {
  if (runtime) await runtime.stop();
  globalThis.fetch = originalFetch;
  await rm(root, { recursive: true, force: true });
}

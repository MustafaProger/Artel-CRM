// Isolated operator QA only: temporary fixture/store, loopback, external jobs off.
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createServer, request as httpRequest } from 'node:http';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { OperationsStore } from '../server/operations-store.ts';
import { startTripsQaServer } from './qa-trips-runtime.mjs';
import { bootstrapQaAuth } from './qa-auth.mjs';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export async function startOperatorQaServer(options) {
  if (process.env.ARTEL_OPERATOR_QA_BUILT !== '1') {
    const runtime = await startTripsQaServer(options);
    return { ...runtime, mode: 'source', bootstrap: () => bootstrapQaAuth(runtime.base) };
  }
  const root = resolve(options.root);
  assert.equal(resolve(process.cwd()), root, 'Built operator QA must run from the release root');
  await mkdir(options.operationsDirectory, { recursive: true, mode: 0o700 });
  const manifest = JSON.parse(await readFile(resolve(options.snapshotDirectory, 'manifest.json'), 'utf8'));
  const store = new OperationsStore(options.operationsDirectory);
  // The production runtime deliberately refuses a missing persistent volume.
  // Materialize only the empty synthetic fixture before using its compiled API.
  await store.mutate(manifest.meta.source_sha256, () => ({ result: null, changed: true }));
  const bundle = resolve(root, 'server-render/production.mjs');
  const { createProductionRuntime } = await import(pathToFileURL(bundle));
  const setupToken = randomBytes(24).toString('hex');
  const environment = {
    ARTEL_PUBLIC_ORIGIN: 'https://operator-qa.local.test', ARTEL_LISTEN_HOST: '127.0.0.1', PORT: '0',
    ARTEL_SNAPSHOT_DIR: options.snapshotDirectory, ARTEL_STORE_DIR: options.operationsDirectory,
    ARTEL_SETUP_TOKEN: setupToken, ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false',
    ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_GEOCODER_ENABLED: 'false', SABY_WORKFLOW_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false',
  };
  let production, targetPort;
  const start = async () => { production = await createProductionRuntime(environment); await production.start(); targetPort = production.server.address().port; };
  await start();
  const proxy = createServer((request, response) => {
    const headers = { ...request.headers, host: 'operator-qa.local.test' };
    if (headers.origin) headers.origin = environment.ARTEL_PUBLIC_ORIGIN;
    const upstream = httpRequest({ host: '127.0.0.1', port: targetPort, path: request.url, method: request.method, headers }, result => { response.writeHead(result.statusCode, result.headers); result.pipe(response); });
    upstream.on('error', () => { response.writeHead(502); response.end(); }); request.pipe(upstream);
  });
  await new Promise(done => proxy.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const artifacts = { serverBundleSha256: digest(await readFile(bundle)), frontend: {} };
  const walk = async directory => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) artifacts.frontend[relative(root, path)] = digest(await readFile(path));
    }
  };
  await walk(resolve(root, 'app-dist'));
  return {
    base, mode: 'compiled-production-runtime', artifacts,
    bootstrap: async () => {
      const state = await (await fetch(base + '/api/auth/session')).json();
      assert.equal(state.needsSetup, true, 'QA requires a fresh empty store');
      const response = await fetch(base + '/api/auth/setup', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: base }, body: JSON.stringify({ name: 'QA Директор', login: 'qa.director', password: randomBytes(24).toString('hex'), setupToken }) });
      assert.ok(response.ok, 'Synthetic production account setup failed');
      return { cookie: response.headers.get('set-cookie').split(';')[0], user: (await response.json()).user };
    },
    async replaceMiddleware() { await production.stop(); await start(); },
    server: { async close() { await production.stop(); await new Promise(done => proxy.close(done)); } },
  };
}

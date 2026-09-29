// Synthetic snapshots and loopback servers only. Never loads the working snapshot or store.
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { createSnapshotMiddleware } from '../server/local-api.ts';

export async function writeTripsQaSnapshot(directory) {
  await mkdir(directory, { recursive: true });
  const source = createHash('sha256').update('artel-trips-synthetic-qa').digest('hex');
  const meta = { source_file: 'synthetic.xlsx', source_sha256: source, created_at_utc: '2026-09-29T00:00:00Z', source_kind: 'test', google_verified: false, formula_policy: '', ownership_policy: '' };
  const validation = { status: 'ok', registry_verified: false, issue_counts: {}, cell_issues: [], record_flag_counts: {}, duplicate_record_candidates: [], legal_form_alias_candidate_groups: [], multiple_manager_companies: [], limitations: [] };
  const files = {};
  for (const name of ['companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report']) {
    const raw = JSON.stringify({ meta, data: name === 'validation_report' ? validation : [] });
    await writeFile(resolve(directory, `${name}.json`), raw);
    files[`${name}.json`] = { sha256: createHash('sha256').update(raw).digest('hex'), bytes: Buffer.byteLength(raw) };
  }
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ meta, counts: {}, files }));
  return source;
}

export async function startTripsQaServer({ root, snapshotDirectory, operationsDirectory, sabyClient, port = 0 }) {
  const denied = async () => { throw new Error('External provider requests are forbidden in synthetic trips QA'); };
  const middleware = client => createSnapshotMiddleware(snapshotDirectory, {
    operationsDirectory, sabyClient: client, checkoApiKey: '', setupToken: '',
    bankEnvironment: { ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false' },
    bankRequest: denied, sberRequest: denied, fetcher: denied,
    pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false }, pushSender: denied,
  });
  let api = middleware(sabyClient);
  const server = await createServer({
    configFile: false, envDir: false, root: resolve(root, 'web'),
    plugins: [react(), { name: 'synthetic-trips-api', configureServer(vite) { vite.middlewares.use((request, response, next) => api(request, response, next)); } }],
    // Vite resolves port 0 to its default; allow a free port when none was requested.
    server: { host: '127.0.0.1', port, strictPort: port !== 0, cors: false, fs: { strict: true, allow: [resolve(root, 'web'), resolve(root, 'node_modules')], deny: ['**/data/**', '**/.env*'] } },
  });
  await server.listen();
  return {
    server, base: `http://127.0.0.1:${server.httpServer.address().port}`,
    // Recreate both middleware and its OperationsStore to verify persistence without process caches.
    replaceMiddleware(client) { api = middleware(client); },
  };
}

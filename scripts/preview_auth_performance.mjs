// Local disposable review, with synthetic accounts and no service credentials.
import { resolve } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
for (const key of Object.keys(process.env)) if (/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key)) delete process.env[key];
process.env.SABY_WORKFLOW_ENABLED = 'false';
process.env.ARTEL_CABINET_SYNC_ENABLED = 'false';
process.env.ARTEL_GEOCODER_ENABLED = 'false';
process.env.ARTEL_BANK_SYNC_ENABLED = 'false';
process.env.ARTEL_BANK_REQUESTS_ENABLED = 'false';
process.env.PUSH_SCHEDULE_ENABLED = 'false';
const { writeTripsQaSnapshot, startTripsQaServer } = await import('./qa-trips-runtime.mjs');
const { OperationsStore } = await import('../server/operations-store.ts');
const { migrateWorkStorage } = await import('../server/work-partition.ts');
const root = resolve(import.meta.dirname, '..');
const directory = await mkdtemp(resolve(tmpdir(), 'artel-auth-review-'));
const snapshotDirectory = resolve(directory, 'snapshot'), operationsDirectory = resolve(directory, 'store');
const source = await writeTripsQaSnapshot(snapshotDirectory);
const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return Promise.reject(new Error('External network disabled in auth preview'));
  return nativeFetch(input, init);
};
const runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory, port: 5195 });
const credentials = { login: 'qa.auth', password: 'Local-auth-review-2026' };
const setup = await fetch(runtime.base + '/api/auth/setup', {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Учебный пользователь', ...credentials }),
});
if (!setup.ok) throw new Error('Synthetic setup failed');
const cookie = setup.headers.get('set-cookie').split(';')[0], user = (await setup.json()).user;
const created = await fetch(runtime.base + '/api/work/tasks', {
  method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
  body: JSON.stringify({ requestId: randomUUID(), title: 'Проверка входа и выхода — учебная задача', assigneeId: user.id }),
});
if (!created.ok) throw new Error('Synthetic task setup failed');
const store = new OperationsStore(operationsDirectory);
await store.mutate(source, data => { data.accounts.sessions = []; return { changed: true, result: null }; });
await migrateWorkStorage(operationsDirectory, source);
console.log(JSON.stringify({ preview: 'http://localhost:5195/#work', syntheticOnly: true, ...credentials }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, async () => {
  await runtime.server.close(); await rm(directory, { recursive: true, force: true }); process.exit(0);
});

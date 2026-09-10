import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { loadSnapshot } from '../server/local-api.ts';
import { OperationsStore } from '../server/operations-store.ts';
import { currentSnapshot } from '../server/shipment-operations.ts';

// Run: node --import tsx scripts/verify_vercel.mjs
// Credentials stay in the ignored .vercel directory and are never included in the report.
const base = 'https://artel-crm.vercel.app';
const access = JSON.parse(await readFile('.vercel/access.json', 'utf8'));
const authorization = 'Basic ' + Buffer.from(`${access.username}:${access.password}`).toString('base64');
const report = { base, checkedAt: new Date().toISOString(), checks: [] };
for (const path of ['/', '/index.html', '/api/snapshot?shipments=omit', '/api/shipments?limit=1', '/api/directories', '/.env', '/data/local-xlsx-final/shipments.json', '/server-render/index.html']) {
  const unauthenticated = await fetch(base + path);
  assert.equal(unauthenticated.status, 401, `Unauthenticated ${path}`);
  const response = await fetch(base + path, { headers: { authorization } });
  const expected = path.startsWith('/.env') || path.startsWith('/data/') || path.startsWith('/server-render/') ? 404 : 200;
  assert.equal(response.status, expected, path);
  report.checks.push({ path, unauthenticated: 401, authenticated: expected });
}
const localBase = await loadSnapshot();
const local = currentSnapshot(localBase, await new OperationsStore('data/local-operations').read(localBase.provenance.sourceSha256));
const remote = await (await fetch(base + '/api/snapshot?shipments=omit', { headers: { authorization } })).json();
const shipments = [];
for (let offset = 0; ; ) {
  const response = await fetch(`${base}/api/shipments?limit=100&offset=${offset}`, { headers: { authorization } });
  assert.equal(response.status, 200);
  const page = await response.json();
  shipments.push(...page.items);
  if (!page.hasMore) break;
  assert.ok(page.nextOffset > offset);
  offset = page.nextOffset;
}
remote.shipments = shipments.sort((a, b) => a.id.localeCompare(b.id));
local.shipments.sort((a, b) => a.id.localeCompare(b.id));
for (const key of ['shipments', 'companies', 'payments', 'stocks', 'directories', 'overview']) assert.deepEqual(remote[key], JSON.parse(JSON.stringify(local[key])), key);
const crossOrigin = await fetch(base + '/api/directories', { method: 'POST', headers: { authorization, origin: 'https://other.example', 'content-type': 'application/json' }, body: '{}' });
assert.equal(crossOrigin.status, 403);
report.checks.push({ dataMatchesLocal: true, shipments: remote.shipments.length, crossOriginRejected: true });
await mkdir('qa/vercel', { recursive: true });
await writeFile('qa/vercel/http.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

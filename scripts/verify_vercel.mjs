import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { loadSnapshot } from '../server/local-api.ts';
import { OperationsStore } from '../server/operations-store.ts';
import { currentSnapshot } from '../server/shipment-operations.ts';

// Run: node --import tsx scripts/verify_vercel.mjs
const base = 'https://artel-crm.vercel.app';
const report = { base, checkedAt: new Date().toISOString(), checks: [] };
for (const path of ['/', '/index.html', '/api/snapshot?shipments=omit', '/api/shipments?limit=1', '/api/directories', '/.env', '/data/local-xlsx-final/shipments.json', '/server-render/index.html']) {
  const response = await fetch(base + path);
  const expected = path.startsWith('/.env') || path.startsWith('/data/') || path.startsWith('/server-render/') ? 404 : 200;
  assert.equal(response.status, expected, path);
  assert.equal(response.headers.get('www-authenticate'), null);
  report.checks.push({ path, status: expected, noLoginPrompt: true });
}
const localBase = await loadSnapshot();
const local = currentSnapshot(localBase, await new OperationsStore('data/local-operations').read(localBase.provenance.sourceSha256));
const remote = await (await fetch(base + '/api/snapshot?shipments=omit')).json();
const shipments = [];
for (let offset = 0; ; ) {
  const response = await fetch(`${base}/api/shipments?limit=100&offset=${offset}`);
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
const crossOrigin = await fetch(base + '/api/directories', { method: 'POST', headers: { origin: 'https://other.example', 'content-type': 'application/json' }, body: '{}' });
assert.equal(crossOrigin.status, 403);
report.checks.push({ dataMatchesLocal: true, shipments: remote.shipments.length, crossOriginRejected: true });
await mkdir('qa/vercel', { recursive: true });
await writeFile('qa/vercel/http.json', JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));

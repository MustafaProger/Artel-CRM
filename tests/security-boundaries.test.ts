import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { parseXml } from '../server/saby-order-evidence';
import { SabyError } from '../server/saby-client';

const xml = (body: string) => Buffer.from(`<?xml version="1.0" encoding="utf-8"?>${body}`);

test('XML entity decoding preserves named and numeric references in text and attributes', () => {
  const root = parseXml(xml('<root text="&quot;&apos;&lt;&gt;&amp;&#9;&#10;&#13;&#x410;&#128512;">A&amp;B &lt; &#65;&#x41;&#x1f600;</root>'));
  assert.equal(root.attributes.text, "\"'<>&\t\n\rА😀");
  assert.deepEqual(root.children, ['A&B < AA😀']);
  assert.deepEqual(parseXml(xml('<root>&amp;lt;</root>')).children, ['&lt;']);
});

test('XML rejects malformed, nested, unknown and invalid Unicode references', () => {
  for (const value of ['&', 'text&tail', '&amp', '&bogus;', '&&amp;', '&amp&amp;', '&#;', '&#x;', '&#0;', '&#31;', '&#55296;', '&#65534;', '&#x10ffff0;', '&#-1;']) {
    assert.throws(() => parseXml(xml(`<root>${value}</root>`)), SabyError, value);
    assert.throws(() => parseXml(xml(`<root attr="${value}"/>`)), SabyError, value);
  }
});

test('malformed XML cannot monopolize the process with repeated unterminated entities', () => {
  // Isolate synchronous parsing so a regression is killed rather than blocking
  // the entire test runner. Five seconds is a watchdog, not a speed benchmark:
  // this bounded input previously required roughly 25 seconds of CPU time.
  const parser = new URL('../server/saby-order-evidence.ts', import.meta.url).href;
  const errors = new URL('../server/saby-client.ts', import.meta.url).href;
  const source = `
    import { parseXml } from ${JSON.stringify(parser)};
    import { SabyError } from ${JSON.stringify(errors)};
    for (const body of [
      '<root>' + '&'.repeat(262144) + '</root>',
      '<root attr="' + '&'.repeat(262144) + '"/>',
      '<root>' + '&'.repeat(262144) + ';</root>',
    ]) {
      try { parseXml(Buffer.from(body)); process.exit(1); }
      catch (error) { if (!(error instanceof SabyError)) process.exit(2); }
    }
  `;
  const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], { timeout: 5000, encoding: 'utf8' });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});

test('malformed request bodies and unexpected storage failures stay bounded and do not mutate data', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-security-boundaries-'));
  const source = 'a'.repeat(64);
  const meta = { source_file: 'synthetic.xlsx', source_sha256: source, created_at_utc: '2026-01-01T00:00:00Z', source_kind: 'test', google_verified: false, formula_policy: '', ownership_policy: '' };
  const validation = { status: 'ok', registry_verified: false, issue_counts: {}, cell_issues: [], record_flag_counts: {}, duplicate_record_candidates: [], legal_form_alias_candidate_groups: [], multiple_manager_companies: [], limitations: [] };
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const name of ['companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report']) {
    const raw = JSON.stringify({ meta, data: name === 'validation_report' ? validation : [] });
    await writeFile(resolve(directory, `${name}.json`), raw);
    files[`${name}.json`] = { sha256: createHash('sha256').update(raw).digest('hex'), bytes: Buffer.byteLength(raw) };
  }
  await writeFile(resolve(directory, 'manifest.json'), JSON.stringify({ meta, counts: {}, files }));
  const store = new OperationsStore(resolve(directory, 'store'));
  let failRead = true, mutations = 0;
  const middleware = createSnapshotMiddleware(directory, { operationsStore: {
    read: async checksum => { if (failRead) { failRead = false; throw new Error('synthetic-private-token /private/server/path'); } return store.read(checksum); },
    mutate: async (checksum, action) => { mutations++; return store.mutate(checksum, action); },
  } });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const failed = await fetch(`${origin}/api/auth/session`);
    assert.equal(failed.status, 500);
    assert.doesNotMatch(await failed.text(), /synthetic-private-token|\/private\/server\/path|Error:|at .*\.ts/);
    for (const body of ['{', '[]', 'null', '"text"']) {
      const reply = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      assert.equal(reply.status, 400); await reply.arrayBuffer();
    }
    const wrongType = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(wrongType.status, 415); await wrongType.arrayBuffer();
    const oversized = await fetch(`${origin}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ login: 'a'.repeat(131072) }) });
    assert.equal(oversized.status, 413); await oversized.arrayBuffer();
    const recovered = await fetch(`${origin}/api/auth/session`);
    assert.equal(recovered.status, 200); assert.equal((await recovered.json()).needsSetup, true);
    assert.equal(mutations, 0);
  } finally {
    await new Promise<void>((done, reject) => server.close(error => error ? reject(error) : done()));
    await rm(directory, { recursive: true, force: true });
  }
});

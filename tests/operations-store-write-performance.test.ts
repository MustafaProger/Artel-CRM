import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { decodeOperations, encodeOperations, OperationsStore, StoreError, type OperationsData } from '../server/operations-store';

const source = 'write-performance-synthetic';
const oldEncoding = (data: OperationsData) => JSON.stringify({
  sha256: createHash('sha256').update(JSON.stringify(data)).digest('hex'), data,
});
const initial = (): OperationsData => ({ schemaVersion: 1, sourceSha256: source, revision: 2, companies: [], shipments: {} });

test('single serialization preserves the existing envelope bytes and checksum for supported JSON values', () => {
  const data = initial();
  const fixtures = [data, decodeOperations(oldEncoding(data), source), {
    ...data,
    syntheticMetadata: {
      unicode: 'Кириллица 🛢️ العربية', escape: '"\\\n', negative: -0,
      values: [null, true, false, 1.25], ...JSON.parse('{"__proto__":{"kept":true}}'),
      nested: { constructor: 'retained' },
    },
  } as OperationsData];
  for (const fixture of fixtures) {
    const before = oldEncoding(fixture);
    assert.equal(encodeOperations(fixture), before);
    assert.deepEqual(decodeOperations(encodeOperations(fixture), source), decodeOperations(before, source));
  }
});

test('single validation retains expected-source rejection and leaves the saved store unchanged', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'artel-write-performance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OperationsStore(directory), raw = encodeOperations(initial());
  await writeFile(store.path, raw, { mode: 0o600 });
  await assert.rejects(store.mutate(source, data => {
    data.sourceSha256 = 'another-source';
    return { changed: true, result: null };
  }), StoreError);
  assert.equal(await readFile(store.path, 'utf8'), raw);
  await assert.rejects(store.mutate(source, data => {
    data.revision = Number.NaN;
    return { changed: true, result: null };
  }), StoreError);
  assert.equal(await readFile(store.path, 'utf8'), raw);
  assert.throws(() => encodeOperations(initial(), 'another-source'), StoreError);
});

test('successful transaction keeps canonical saved bytes and independent returned references', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'artel-write-performance-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const store = new OperationsStore(directory);
  await writeFile(store.path, encodeOperations(initial()), { mode: 0o600 });
  const returned = await store.mutate(source, data => {
    data.shipments.synthetic = { version: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', fields: { note: 'Сохранено 🛢️' } };
    return { changed: true, result: data.shipments.synthetic };
  });
  const saved = await readFile(store.path, 'utf8');
  assert.equal(saved, oldEncoding(JSON.parse(saved).data));
  returned.fields.note = 'caller mutation';
  assert.equal((await store.read(source)).shipments.synthetic.fields.note, 'Сохранено 🛢️');
  assert.equal((await store.read(source)).revision, 3);
});

#!/usr/bin/env node
// Compare two compiled OperationsStore modules. Supplied source data is read only;
// all transaction samples use separate private temporary copies without schedulers.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { deserialize, serialize } from 'node:v8';

const options = { samples: 9, factors: '1,5,10' };
const allowed = new Set(['baseline', 'candidate', 'store', 'output', 'samples', 'factors']);
for (let index = 2; index < process.argv.length; index += 2) {
  const key = process.argv[index].replace(/^--/, '');
  if (!allowed.has(key) || !process.argv[index + 1]) throw new Error('Use --baseline MODULE --candidate MODULE [--store FILE] [--output FILE] [--samples 5..20] [--factors 1,5,10]');
  options[key] = process.argv[index + 1];
}
if (!options.baseline || !options.candidate) throw new Error('Both compiled module paths are required');
options.samples = Number(options.samples);
if (!Number.isInteger(options.samples) || options.samples < 5 || options.samples > 20) throw new Error('Invalid sample count');
const factors = options.store ? [1] : String(options.factors).split(',').map(Number);
if (factors.some(factor => !Number.isInteger(factor) || factor < 1 || factor > 10)) throw new Error('Invalid factors');
const [before, after] = await Promise.all([options.baseline, options.candidate].map(file => import(pathToFileURL(resolve(file)).href)));
const inputRaw = options.store ? await readFile(options.store, 'utf8') : undefined;
const inputHash = inputRaw ? createHash('sha256').update(inputRaw).digest('hex') : undefined;
const timestamp = '2026-01-01T00:00:00.000Z';
function synthetic(factor) {
  const shipments = {};
  for (let index = 0; index < factor * 4000; index++) shipments[`shipment-${index}`] = {
    version: 1, createdAt: timestamp, updatedAt: timestamp,
    fields: { customer: `Synthetic customer ${index % 40}`, supplier: `Synthetic supplier ${index % 10}`, litres: String(1000 + index), note: 'Synthetic measurement Кириллица العربية 🛢️ '.repeat(10) },
  };
  return { schemaVersion: 1, sourceSha256: 'performance-synthetic', revision: 1, companies: [], shipments };
}
const rounded = value => Math.round(value * 100) / 100;
const stats = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { min: rounded(sorted[0]), median: rounded(sorted[Math.floor(sorted.length / 2)]), p95: rounded(sorted[Math.ceil(sorted.length * .95) - 1]), max: rounded(sorted.at(-1)) };
};
async function paired(left, right) {
  for (let warm = 0; warm < 2; warm++) { await left(); await right(); }
  const values = [[], []];
  for (let sample = 0; sample < options.samples; sample++) {
    for (const side of sample % 2 ? [1, 0] : [0, 1]) {
      const start = performance.now();
      await (side ? right : left)();
      values[side].push(performance.now() - start);
    }
  }
  const baseline = stats(values[0]), candidate = stats(values[1]);
  return { baseline, candidate, medianRatio: rounded(baseline.median / candidate.median) };
}
const report = { version: 1, node: process.version, samples: options.samples, source: options.store ? 'private-read-only-copy' : 'synthetic', units: 'milliseconds', results: [] };
for (const factor of factors) {
  const raw = inputRaw ?? before.encodeOperations(synthetic(factor));
  const plain = JSON.parse(raw).data, source = plain.sourceSha256;
  const data = before.decodeOperations(raw, source);
  assert.deepEqual(after.decodeOperations(raw, source), data);
  const canonical = before.encodeOperations(data);
  assert.equal(after.encodeOperations(data), canonical);
  const folder = await mkdtemp(join(tmpdir(), 'artel-store-benchmark-'));
  try {
    const stores = [];
    for (const [index, module] of [before, after].entries()) {
      const location = join(folder, String(index));
      const store = new module.OperationsStore(location);
      // A no-change mutation initializes the private folder without writing source data.
      await store.mutate(source, () => ({ changed: false, result: null }));
      await writeFile(store.path, canonical, { mode: 0o600 });
      stores.push(store);
    }
    const encode = await paired(() => before.encodeOperations(data), () => after.encodeOperations(data));
    const read = await paired(() => stores[0].read(source), () => stores[1].read(source));
    const mutate = await paired(
      () => stores[0].mutate(source, () => ({ changed: true, result: null })),
      () => stores[1].mutate(source, () => ({ changed: true, result: null })),
    );
    assert.equal(await readFile(stores[0].path, 'utf8'), await readFile(stores[1].path, 'utf8'));
    const parsed = JSON.parse(raw), serialized = serialize(parsed);
    assert.deepEqual(structuredClone(parsed), parsed);
    assert.deepEqual(deserialize(serialized), parsed);
    const structuredCloneComparison = await paired(() => JSON.parse(raw), () => structuredClone(parsed));
    const v8DeserializeComparison = await paired(() => JSON.parse(raw), () => deserialize(serialized));
    const v8CacheRebuildComparison = await paired(() => JSON.parse(raw), () => serialize(JSON.parse(raw)));
    const result = { factor, bytes: Buffer.byteLength(raw), shipments: Object.keys(data.shipments).length, exactEncoding: true, exactTransactions: true, encode, read, mutate, structuredCloneComparison, v8DeserializeComparison, v8CacheRebuildComparison, extraV8CacheBytes: serialized.byteLength };
    report.results.push(result);
    console.log(JSON.stringify(result));
  } finally { await rm(folder, { recursive: true, force: true }); }
}
if (options.store) {
  assert.equal(createHash('sha256').update(await readFile(options.store)).digest('hex'), inputHash, 'Source file changed during the benchmark');
  report.sourceUnchanged = true;
}
if (options.output) await writeFile(options.output, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600, flag: 'wx' });

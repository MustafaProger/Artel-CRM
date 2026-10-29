// Synthetic archived graphs only. No environment credentials or external transport.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createTripSabyScheduler, dispatchTripSaby } from '../server/trip-saby-scheduler';
import { runTripSabyWorkflow } from '../server/trip-saby-workflow';
import { exchangePreparedEtrn, saveTripLoadingFacts } from '../server/etrn-service';
import { OperationsStore, encodeOperations, type OperationsData } from '../server/operations-store';
import { currentShipmentAccess } from '../server/shipment-operations';
import { integrationApi, integrationConfig, integrationRuntime } from '../tests/helpers/trip-saby-integration';

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture() {
  const f = await integrationRuntime(), api = integrationApi();
  await f.store.mutate(f.source, data => {
    data.accounts = { users: [{ id: 'initiator', login: 'initiator', name: 'Synthetic director', role: 'director', active: true, managerId: null, version: 1, passwordHash: 'a'.repeat(128), salt: 'b'.repeat(32) }], sessions: [], attempts: {} };
    return { result: undefined, changed: true };
  });
  const context = { ...f, client: api.client() };
  await runTripSabyWorkflow({ ...context, initiatorId: 'initiator', createDelivery: input => exchangePreparedEtrn(context, input) });
  const tick = () => dispatchTripSaby({ ...f, config: integrationConfig(), enabled: true, send: api.send });
  return { ...f, api, context, tick };
}
function track(store: OperationsStore) {
  const counts = { reads: 0, mutations: 0, changed: 0 };
  const read = store.read.bind(store), mutate = store.mutate.bind(store);
  store.read = async source => { counts.reads++; return read(source); };
  store.mutate = async (source, update) => { counts.mutations++; return mutate(source, async data => { const result = await update(data); if (result.changed) counts.changed++; return result; }); };
  return counts;
}
function expand(original: OperationsData, tripId: string, count: number) {
  const expanded = structuredClone(original);
  expanded.shipments = {}; expanded.tripSaby = { trips: {} }; expanded.etrn = { trips: {} }; expanded.tripNumbers = {};
  const ids = Object.keys(original.shipments);
  for (let index = 0; index < count; index++) {
    const map = new Map([tripId, ...ids].map(id => [id, `${id}-${index.toString(16)}`]));
    // Remap all graph references, including keys and frozen snapshots, then
    // recompute snapshot hashes. These synthetic records are never sent.
    const remap = (value: unknown): unknown => {
      if (typeof value === 'string') return [...map].reduce((text, [from, to]) => text.replaceAll(from, to), value);
      if (Array.isArray(value)) return value.map(remap);
      if (value && typeof value === 'object') {
        const row = Object.fromEntries(Object.entries(value).map(([key, child]) => [String(remap(key)), remap(child)]));
        if ('snapshot' in row && 'payloadHash' in row) row.payloadHash = digest(row.snapshot);
        if ('snapshot' in row && 'preparedHash' in row) row.preparedHash = digest(row.snapshot);
        return row;
      }
      return value;
    };
    const clone = remap(original) as OperationsData, id = map.get(tripId)!;
    Object.assign(expanded.shipments, clone.shipments);
    expanded.tripSaby.trips[id] = clone.tripSaby!.trips[id];
    expanded.etrn.trips[id] = clone.etrn!.trips[id];
    expanded.tripNumbers[id] = index + 1;
  }
  // The normal store validator checks references and hashes before benchmarking.
  return expanded;
}
async function main() {
  const output = process.argv[process.argv.indexOf('--output') + 1];
  assert.ok(output && process.argv.includes('--output'));
  const f = await fixture();
  try {
    const counts = track(f.store), calls = f.api.calls.length;
    const began = performance.now(), cpu = process.cpuUsage(); await f.tick();
    const awaiting = { scenario: 'awaiting_carrier', ms: performance.now() - began, cpu: process.cpuUsage(cpu), ...counts, networkMethods: f.api.calls.slice(calls).map(call => call.method) };
    f.api.accept(); await f.tick(); await saveTripLoadingFacts(f.context, f.facts(), 'initiator'); await f.tick();
    const original = await f.store.read(f.source), scales = [];
    const fixedNow = Date.now();
    for (const saved of Object.values(original.etrn!.trips[f.tripId].deliveries)) saved.document!.updatedAt = new Date(fixedNow).toISOString();
    for (const multiplier of [1, 5, 10]) {
      const trips = 10 * multiplier, data = expand(original, f.tripId, trips), encoded = encodeOperations(data);
      assert.equal(currentShipmentAccess(f.base, data).shipments.length, 2 * trips);
      const dir = resolve(f.directory, `scale-${multiplier}`); await mkdir(dir); await writeFile(resolve(dir, 'operations.json'), encoded);
      const store = new OperationsStore(dir), metric = track(store);
      const scheduler = createTripSabyScheduler({ ...f, store, config: integrationConfig(), enabled: true, now: fixedNow, send: async () => { throw new Error('Idle synthetic scheduler must not send'); } });
      const before = digest(await readFile(store.path)), started = performance.now(), beforeCpu = process.cpuUsage();
      try { await scheduler.tick(); await scheduler.drain(); }
      finally { await scheduler.stop(); }
      scales.push({ multiplier, trips, shipments: 2 * trips, bytes: Buffer.byteLength(encoded), ms: performance.now() - started, cpu: process.cpuUsage(beforeCpu), ...metric, storedBytesExact: before === digest(await readFile(store.path)) });
      assert.equal(metric.changed, 0); assert.equal(metric.mutations, 0);
      // The candidate should have one read; the baseline measurement records its original count.
    }
    const dueDir = resolve(f.directory, 'due'); await mkdir(dueDir);
    for (const saved of Object.values(original.etrn!.trips[f.tripId].deliveries)) saved.document!.updatedAt = new Date(fixedNow - 60_000).toISOString();
    await writeFile(resolve(dueDir, 'operations.json'), encodeOperations(original));
    const dueStore = new OperationsStore(dueDir), dueCounts = track(dueStore), networkStart = f.api.calls.length, dueStart = performance.now(), dueCpu = process.cpuUsage();
    const result = await dispatchTripSaby({ ...f, store: dueStore, config: integrationConfig(), enabled: true, send: f.api.send, now: fixedNow });
    const due = { scenario: 'completed_due_two_deliveries', result, ms: performance.now() - dueStart, cpu: process.cpuUsage(dueCpu), ...dueCounts, networkMethods: f.api.calls.slice(networkStart).map(call => call.method) };
    const report = { method: 'Isolated synthetic validated linked records; real OperationsStore reads and durable writes; synthetic network only', awaiting, scales, due, memory: process.memoryUsage() };
    await writeFile(output, JSON.stringify(report, null, 2));
    console.log(JSON.stringify({ output, scales: scales.map(row => ({ trips: row.trips, reads: row.reads, ms: row.ms })), dueReads: dueCounts.reads, dueWrites: dueCounts.changed }));
  } finally { await f.close(); }
}
await main();

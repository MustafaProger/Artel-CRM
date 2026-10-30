import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SabyClient, type SabyObject } from '../server/saby-client';
import { integrationConfig } from './helpers/trip-saby-integration';

const gate = () => { let release!: () => void; const promise = new Promise<void>(done => { release = done; }); return { promise, release }; };
const delay = () => new Promise<void>(done => setTimeout(done, 4));
function budget(limit: number) {
  let active = 0, maximum = 0, acquisitions = 0;
  const queue: Array<() => void> = [];
  const run = async <T>(action: () => Promise<T>): Promise<T> => {
    if (active >= limit) await new Promise<void>(done => queue.push(done)); else active++;
    acquisitions++; maximum = Math.max(maximum, active);
    try { return await action(); }
    finally { const next = queue.shift(); if (next) next(); else active--; }
  };
  return { run, stats: () => ({ active, maximum, acquisitions }) };
}
function api() {
  let transports = 0, maximum = 0, writes = 0, reads = 0;
  const document = (id: string): SabyObject => ({ Идентификатор: id, Тип: 'ConsignmentNote', Редакция: [{ Идентификатор: 'revision', Актуален: 'Да' }], Вложение: [{ Идентификатор: 'title', Подтип: '1110339', Файл: { Имя: 'title.xml', Ссылка: 'https://disk.saby.ru/synthetic-budget.xml' } }] });
  const send: typeof fetch = async (_url, init) => {
    transports++; maximum = Math.max(maximum, transports);
    try {
      await delay();
      if (init?.method === 'GET') return new Response('<synthetic/>');
      const request = JSON.parse(String(init?.body));
      if (request.method === 'СБИС.ЗаписатьДокумент') writes++; else reads++;
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: document(request.params.Документ?.Идентификатор ?? 'created-note') }));
    } finally { transports--; }
  };
  return { send, stats: () => ({ transports, maximum, writes, reads }) };
}

for (const concurrency of [1, 4]) test(`pre-dispatch nested reads and downloads complete with budget ${concurrency}, while sibling calls respect its limit`, { timeout: 5_000 }, async () => {
  const slots = budget(concurrency), transport = api();
  const client = new SabyClient(integrationConfig(), transport.send).withRequestBudget(slots.run);
  let guarded = 0, beforeWrites = 0;
  const wrapped = client.withRequestGuard(async () => { guarded++; });
  await Promise.all(Array.from({ length: concurrency * 2 }, (_, index) => wrapped.writeConsignmentNote({ Тип: 'ConsignmentNote', Примечание: `synthetic-${index}` }, async () => {
    beforeWrites++;
    await Promise.all([
      wrapped.readConsignmentNote('existing-note'),
      wrapped.downloadAttachment('existing-note', 'title', 'revision'),
    ]);
  })));
  assert.equal(beforeWrites, concurrency * 2); assert.equal(transport.stats().writes, concurrency * 2);
  assert.ok(transport.stats().maximum <= concurrency, JSON.stringify(transport.stats()));
  assert.equal(slots.stats().acquisitions, concurrency * 2, 'nested calls reuse each reserved slot');
  assert.equal(slots.stats().active, 0); assert.ok(guarded >= concurrency * 8, 'every nested request retains its access guard');
});

test('an unrelated caller remains queued behind an active pre-dispatch slot and keeps FIFO budget accounting', { timeout: 5_000 }, async () => {
  const slots = budget(1), transport = api(), started = gate(), release = gate();
  const client = new SabyClient(integrationConfig(), transport.send).withRequestBudget(slots.run);
  const writing = client.writeConsignmentNote({ Тип: 'ConsignmentNote' }, async () => {
    started.release(); await release.promise;
    await client.readConsignmentNote('preflight-note');
  });
  await started.promise;
  const reading = client.readConsignmentNote('independent-note');
  await delay(); assert.equal(transport.stats().reads, 0); assert.equal(slots.stats().acquisitions, 1);
  release.release(); await Promise.all([writing, reading]);
  assert.equal(slots.stats().acquisitions, 2); assert.equal(transport.stats().maximum, 1);
});

test('nested calls under a different runtime budget still acquire their own budget', { timeout: 5_000 }, async () => {
  const a = budget(1), b = budget(1), transport = api();
  const first = new SabyClient(integrationConfig(), transport.send).withRequestBudget(a.run);
  const second = new SabyClient(integrationConfig(), transport.send).withRequestBudget(b.run);
  await first.writeConsignmentNote({ Тип: 'ConsignmentNote' }, async () => { await second.readConsignmentNote('separate-budget'); });
  assert.equal(a.stats().acquisitions, 1); assert.equal(b.stats().acquisitions, 1);
});

test('escaped asynchronous pre-dispatch context cannot borrow a released slot', { timeout: 5_000 }, async () => {
  const slots = budget(1), transport = api(), later = gate();
  const client = new SabyClient(integrationConfig(), transport.send).withRequestBudget(slots.run);
  let escaped!: Promise<unknown>;
  await client.writeConsignmentNote({ Тип: 'ConsignmentNote' }, async () => {
    escaped = later.promise.then(() => client.readConsignmentNote('later-note'));
    await client.readConsignmentNote('preflight-note');
  });
  later.release(); await escaped;
  assert.equal(slots.stats().acquisitions, 2); assert.equal(slots.stats().active, 0);
});

test('a failed access guard in a nested read prevents the outer mutation and releases its slot', { timeout: 5_000 }, async () => {
  const slots = budget(1), transport = api(); let revoked = false;
  const client = new SabyClient(integrationConfig(), transport.send).withRequestBudget(slots.run).withRequestGuard(async () => { if (revoked) throw new Error('Synthetic revoked'); });
  await assert.rejects(client.writeConsignmentNote({ Тип: 'ConsignmentNote' }, async () => {
    revoked = true; await client.readConsignmentNote('denied-read');
  }), /Synthetic revoked/);
  assert.equal(transport.stats().writes, 0); assert.equal(transport.stats().reads, 0); assert.equal(slots.stats().active, 0);
});

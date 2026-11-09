import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { JsonSnapshot } from '../server/json-snapshot';
const seal = (value: unknown) => { const raw = JSON.stringify(value); return `{"sha256":"${createHash('sha256').update(raw).digest('hex')}","data":${raw}}`; };

test('cached codec equals native JSON bytes including omission, arrays, ordering and Unicode', () => {
  const values = [
    { a: undefined, b: [undefined, ...Array(1), NaN, Infinity, -0], c: null },
    JSON.parse('{"__proto__":{"polluted":true},"constructor":2,"10":"ten","2":"two","x":"\\ud800"}'),
    { z: { b: 'quote"\\\n', a: 'Арабский العربية 🌍' }, a: Array.from({ length: 50 }, (_, i) => ({ i })) },
    { a: { toJSON: (key: string) => key }, b: [{ toJSON: (key: string) => key }], omitted: { toJSON: () => undefined } },
    { date: new Date('2026-11-09T00:00:00Z'), custom: { toJSON: () => ({ value: 7 }) } },
  ];
  for (const value of values) {
    const first = new JsonSnapshot(value);
    assert.equal(first.raw, seal(value));
    assert.deepEqual(first.clone(), JSON.parse(JSON.stringify(value)));
    const next = new JsonSnapshot(value, first);
    assert.equal(next.raw, seal(value));
    assert.equal(first.matches(value), true);
  }
  const first = new JsonSnapshot({ a: { x: 1, y: 2 }, b: 'large immutable value' });
  const reordered = { b: 'large immutable value', a: { y: 2, x: 1 } };
  assert.equal(first.matches(reordered), false);
  assert.equal(new JsonSnapshot(reordered, first).raw, seal(reordered));
});

test('private baseline and nested graph remain isolated from all caller references', () => {
  const input = { a: [{ name: 'original', nested: { ok: true } }], big: 'x'.repeat(1_000_000) };
  const first = new JsonSnapshot(input);
  input.a[0].nested.ok = false;
  const view = first.clone() as typeof input;
  view.a[0].name = 'mutated'; view.a.push(view.a[0]);
  const fresh = first.clone() as typeof input;
  assert.equal(fresh.a.length, 1); assert.equal(fresh.a[0].name, 'original'); assert.equal(fresh.a[0].nested.ok, true);
  const next = new JsonSnapshot({ ...fresh, version: 2 }, first);
  fresh.a[0].nested.ok = false;
  assert.equal((next.clone() as typeof input).a[0].nested.ok, true);
  assert.throws(() => new JsonSnapshot({ value: 1n }));
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  assert.throws(() => new JsonSnapshot(cycle));
});

test('verified private graph reuses verification encoding and lazily creates exact unchanged fragments', () => {
  const owned = JSON.parse('{"a":{"nested":[1,2]},"large":"immutable","revision":1}');
  const before = JsonSnapshot.fromVerified(owned, seal(owned));
  const view = before.clone() as typeof owned;
  view.a.nested.push(3);
  assert.equal(before.matches({ a: { nested: [1, 2] }, large: 'immutable', revision: 1 }), true);
  const next = { a: { nested: [1, 2] }, large: 'immutable', revision: 2 };
  assert.equal(new JsonSnapshot(next, before).raw, seal(next));
});

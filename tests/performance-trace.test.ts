import assert from 'node:assert/strict';
import test from 'node:test';
import { performanceSpan, withPerformanceTrace, type PerformanceTrace } from '../server/performance-trace';

test('disabled diagnostics preserve sync values, promise identity and errors', async () => {
  const promise = Promise.resolve(7);
  assert.equal(performanceSpan('test', () => promise), promise);
  assert.equal(performanceSpan('test', () => 9), 9);
  const error = new Error('private failure');
  assert.throws(() => performanceSpan('test', () => { throw error; }), candidate => candidate === error);
  assert.equal(await withPerformanceTrace('disabled', async () => 11), 11);
});

test('concurrent traces isolate stages and never expose action values or failures', async () => {
  const traces: PerformanceTrace[] = [];
  let release!: () => void;
  const barrier = new Promise<void>(resolve => { release = resolve; });
  const first = withPerformanceTrace('first', async () => {
    await performanceSpan('first.wait', () => barrier);
    return performanceSpan('first.sync', () => 'private value');
  }, trace => traces.push(trace));
  const secretError = new Error('private failure');
  await assert.rejects(withPerformanceTrace('second', async () => {
    performanceSpan('second.sync', () => 13);
    release();
    throw secretError;
  }, trace => traces.push(trace)), error => error === secretError);
  assert.equal(await first, 'private value');
  assert.equal(traces.length, 2);
  for (const trace of traces) {
    assert.ok(trace.id);
    assert.ok(trace.totalMs >= 0);
    assert.ok(trace.spans.every(span => span.name.startsWith(trace.label)));
    assert.equal(trace.failed, trace.label === 'second');
    assert.ok(trace.spans.every(span => span.startMs >= 0 && span.durationMs >= 0));
    assert.equal(JSON.stringify(trace).includes('private'), false);
  }
  assert.equal(await withPerformanceTrace('throwing-sink', async () => 17, () => { throw Error('sink'); }), 17);
});

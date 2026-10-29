import { test } from 'node:test';
import assert from 'node:assert/strict';
import { watchVisibleRefresh } from '../web/src/visible-refresh';

test('background refresh skips hidden ticks, coalesces return events and cancels pending work on cleanup', t => {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const windowTarget = new EventTarget(), documentTarget = Object.assign(new EventTarget(), { visibilityState: 'visible' });
  const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window'), priorDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'window', { configurable: true, value: windowTarget });
  Object.defineProperty(globalThis, 'document', { configurable: true, value: documentTarget });
  t.after(() => {
    if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow); else Reflect.deleteProperty(globalThis, 'window');
    if (priorDocument) Object.defineProperty(globalThis, 'document', priorDocument); else Reflect.deleteProperty(globalThis, 'document');
  });
  let reads = 0;
  const stop = watchVisibleRefresh(() => { reads++; }, 1000);
  assert.equal(reads, 0, 'initial/manual refresh belongs to caller');
  t.mock.timers.tick(1000); t.mock.timers.tick(50);
  assert.equal(reads, 1);
  documentTarget.visibilityState = 'hidden'; documentTarget.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(10_000); windowTarget.dispatchEvent(new Event('focus')); t.mock.timers.tick(50);
  assert.equal(reads, 1);
  documentTarget.visibilityState = 'visible'; documentTarget.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(20); windowTarget.dispatchEvent(new Event('focus')); t.mock.timers.tick(50);
  assert.equal(reads, 2, 'one request for a visibility/focus pair');
  windowTarget.dispatchEvent(new Event('focus')); documentTarget.visibilityState = 'hidden'; documentTarget.dispatchEvent(new Event('visibilitychange'));
  t.mock.timers.tick(50); assert.equal(reads, 2, 'pending return read is cancelled when hidden again');
  documentTarget.visibilityState = 'visible'; documentTarget.dispatchEvent(new Event('visibilitychange')); stop();
  t.mock.timers.tick(10_000); windowTarget.dispatchEvent(new Event('focus')); t.mock.timers.tick(100);
  assert.equal(reads, 2, 'unmounted page has no interval/listener/pending read');
});

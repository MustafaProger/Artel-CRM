import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';

const source = await readFile(new URL('../web/public/sw.js', import.meta.url), 'utf8');
const binding = 'a'.repeat(64);
const payload = { title: 'Учебное событие', body: 'Учебный текст', url: '/#driver-trip/synthetic-trip', tag: 'synthetic-record', displayBinding: binding, probe: { id: 'synthetic-probe', token: 'b'.repeat(40) } };
async function push(value: unknown, mode = 'authorized') {
  const listeners: Record<string, (event: unknown) => void> = {};
  const notifications: { title: string; options: { body: string; tag: string; data: { url: string } } }[] = [];
  const requests: { url: string; init: RequestInit }[] = [], messages: unknown[] = [];
  let pending: Promise<void> | undefined;
  const context = {
    self: { location: { origin: 'https://synthetic.invalid' }, addEventListener: (type: string, listener: (event: unknown) => void) => { listeners[type] = listener; }, registration: { showNotification: async (title: string, options: typeof notifications[number]['options']) => { notifications.push({ title, options }); } }, clients: { matchAll: async () => [{ postMessage: (message: unknown) => messages.push(message) }] } },
    URL, AbortController,
    setTimeout: (callback: () => void) => { if (mode === 'timeout') queueMicrotask(callback); return 1; }, clearTimeout: () => undefined,
    fetch: async (url: string, init: RequestInit) => {
      requests.push({ url, init });
      if (url.endsWith('/test-receipt')) return { ok: true };
      if (mode === 'network') throw new Error('Synthetic offline');
      if (mode === 'timeout') return new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('Synthetic timeout'))));
      if (mode === 'revoked') return { ok: false, status: 401 };
      return { ok: true, json: async () => mode === 'malformed' ? null : { displayBinding: mode === 'other-account' ? 'c'.repeat(64) : binding } };
    },
  };
  vm.runInNewContext(source, context);
  listeners.push({ data: { json: () => value }, waitUntil: (promise: Promise<void>) => { pending = promise; } });
  await pending;
  return { notifications, requests, messages };
}
test('current bound session may display event and link, notify driver UI and acknowledge probe', async () => {
  const result = await push(payload);
  assert.equal(result.notifications[0].title, payload.title);
  assert.equal(result.notifications[0].options.body, payload.body);
  assert.equal(result.notifications[0].options.data.url, payload.url);
  assert.equal(result.messages.length, 1);
  assert.equal(result.requests.length, 2);
  assert.equal(result.requests[0].init.credentials, 'same-origin');
  assert.equal(result.requests[0].init.cache, 'no-store');
  assert.equal(result.requests[0].init.redirect, 'error');
  assert.equal(result.requests[1].init.credentials, 'omit');
});
for (const mode of ['revoked', 'other-account', 'network', 'timeout', 'malformed']) test(`queued push under ${mode} hides event/link and never reports private delivery`, async () => {
  const result = await push(payload, mode);
  assert.equal(result.notifications.length, 1);
  assert.equal(result.notifications[0].title, 'Артэль CRM');
  assert.equal(result.notifications[0].options.data.url, '/#work');
  assert.equal(result.notifications[0].options.tag, 'artel-reminder');
  assert.ok(!result.notifications[0].options.body.includes(payload.body));
  assert.deepEqual(result.messages, []);
  assert.equal(result.requests.length, 1);
});
for (const value of [{ ...payload, displayBinding: undefined }, { ...payload, displayBinding: 'bad' }, null]) test(`legacy/malformed push ${JSON.stringify(value?.displayBinding)} is generic without a network lookup`, async () => {
  const result = await push(value);
  assert.equal(result.notifications[0].title, 'Артэль CRM');
  assert.equal(result.notifications[0].options.data.url, '/#work');
  assert.deepEqual(result.requests, []);
  assert.deepEqual(result.messages, []);
});

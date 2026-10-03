import assert from 'node:assert/strict';
import test from 'node:test';
import { apiFetch, apiUrl, fetchDirectoryData, logisticsSessionExpiredEvent } from '../web/src/workspace-api';

test('logistics components read only their context and namespace document download and auth requests', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    Object.defineProperty(globalThis, 'window', { value: { location: { pathname: '/logistics/' } }, configurable: true });
    globalThis.fetch = async input => {
      calls.push(String(input));
      return new Response(JSON.stringify({ companies: [], directories: {} }), { headers: { 'Content-Type': 'application/json' } });
    };
    await fetchDirectoryData();
    await apiFetch('/api/auth/session');
    await apiFetch('/api/shipment-trips/trip-synthetic');
    assert.deepEqual(calls, ['/api/logistics/context', '/api/logistics/auth/session', '/api/logistics/shipment-trips/trip-synthetic']);
    assert.equal(apiUrl('/api/shipment-trips/trip-synthetic/etrn/files/row/file'), '/api/logistics/shipment-trips/trip-synthetic/etrn/files/row/file');
    assert.equal(apiUrl('/api/logistics/auth/logout'), '/api/logistics/auth/logout');
    assert.equal(apiUrl('https://saby.ru/example'), 'https://saby.ru/example');
    assert.equal(calls.some(url => url.includes('snapshot')), false);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

test('main CRM retains its API and fresh-directory snapshot outside the logistics entry', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  const calls: string[] = [];
  try {
    Object.defineProperty(globalThis, 'window', { value: { location: { pathname: '/' } }, configurable: true });
    globalThis.fetch = async input => { calls.push(String(input)); return new Response(JSON.stringify({ companies: [], directories: {} })); };
    await fetchDirectoryData();
    await apiFetch('/api/auth/session');
    assert.deepEqual(calls, ['/api/snapshot?shipments=omit', '/api/auth/session']);
    assert.equal(apiUrl('/api/shipment-trips/trip-synthetic'), '/api/shipment-trips/trip-synthetic');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});


test('revoked operational sessions notify logistics immediately without auth or main-CRM loops', async () => {
  const originalWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
  const originalFetch = globalThis.fetch;
  const events = new EventTarget();
  const location = { pathname: '/logistics/' };
  let expired = 0;
  events.addEventListener(logisticsSessionExpiredEvent, () => { expired++; });
  try {
    Object.defineProperty(globalThis, 'window', { value: { location, dispatchEvent: events.dispatchEvent.bind(events) }, configurable: true });
    globalThis.fetch = async () => new Response('{}', { status: 401 });
    await apiFetch('/api/shipment-trips');
    assert.equal(expired, 1);
    await apiFetch('/api/auth/session');
    await apiFetch('/api/auth/login');
    await apiFetch('https://example.test/status');
    assert.equal(expired, 1, 'login/session errors and unrelated requests must not dispatch more auth work');
    location.pathname = '/';
    await apiFetch('/api/shipment-trips');
    assert.equal(expired, 1, 'main CRM session behavior remains unchanged');
  } finally {
    globalThis.fetch = originalFetch;
    if (originalWindow) Object.defineProperty(globalThis, 'window', originalWindow);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as pause } from 'node:timers/promises';
import { ApiError } from '../server/api-error';
import { createYandexTiles, parseYandexTileCoordinates, yandexTileSignature, YandexTileQueue } from '../server/yandex-tiles';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lN8AAAAASUVORK5CYII=', 'base64');
const response = () => new Response(png, { headers: { 'Content-Type': 'image/png' } });
const point = { x: 1, y: 2, z: 4, scale: 2 as const };
const signal = () => new AbortController().signal;
const status = (code: number) => (error: unknown) => error instanceof ApiError && error.status === code;

test('Tiles accepts only bounded canonical coordinates and exactly four known parameters', () => {
  assert.deepEqual(parseYandexTileCoordinates(new URLSearchParams('x=0&y=0&z=0&scale=1')), { x: 0, y: 0, z: 0, scale: 1 });
  assert.deepEqual(parseYandexTileCoordinates(new URLSearchParams('x=1048575&y=1048575&z=20&scale=2')), { x: 1048575, y: 1048575, z: 20, scale: 2 });
  for (const query of ['x=1&y=0&z=0&scale=1', 'x=-1&y=0&z=1&scale=1', 'x=01&y=0&z=1&scale=1', 'x=1.0&y=0&z=1&scale=1', 'x=1e0&y=0&z=1&scale=1', 'x=%201&y=0&z=1&scale=1', 'x=1&y=0&z=21&scale=1', 'x=1&y=0&z=1&scale=3', 'x=1&y=2&z=1&scale=1', 'x=1&y=0&z=1', 'x=1&y=0&z=1&scale=1&x=1', 'x=1&y=0&z=1&scale=1&url=https://host.invalid', 'x=1&y=0&z=1&scale=1&apikey=browser-key', 'x=1&y=0&z=1&scale=1&projection=wgs84_mercator']) {
    assert.throws(() => parseYandexTileCoordinates(new URLSearchParams(query)), status(400), query);
  }
});

test('Tiles fixes official origin, projection/style, Referer and hides key; dedup/cache expire without persisting', async () => {
  let clock = 1000, calls = 0;
  const tiles = createYandexTiles({ environment: { YANDEX_TILES_API_KEY: 'SYNTHETIC-PRIVATE-KEY' }, now: () => clock, queue: new YandexTileQueue(), fetcher: async (input, init) => {
    calls++;
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://tiles.api-maps.yandex.ru'); assert.equal(url.pathname, '/v1/tiles/');
    assert.equal(url.searchParams.get('apikey'), 'SYNTHETIC-PRIVATE-KEY');
    assert.deepEqual(Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'apikey')), { lang: 'ru_RU', x: String(point.x), y: String(point.y), z: String(point.z), l: 'map', scale: '2', projection: 'web_mercator', maptype: 'future_map' });
    assert.equal(new Headers(init!.headers).get('Referer'), 'https://artel-crm.online/'); assert.equal(init!.redirect, 'error');
    await pause(5); return response();
  } });
  const [one, two] = await Promise.all([tiles.get(point, signal()), tiles.get(point, signal())]);
  assert.equal(calls, 1); assert.deepEqual(one, two); assert.deepEqual(one.bytes, png); assert.doesNotMatch(JSON.stringify(one), /SYNTHETIC-PRIVATE-KEY/);
  await tiles.get(point, signal()); assert.equal(calls, 1);
  clock += 300_001; await tiles.get(point, signal()); assert.equal(calls, 2);
});

test('Tiles missing configuration makes no outbound request', async () => {
  let calls = 0;
  const tiles = createYandexTiles({ environment: {}, fetcher: async () => { calls++; return response(); } });
  await assert.rejects(tiles.get(point, signal()), status(503)); assert.equal(calls, 0);
});

test('one shared gate spaces starts below 30 rps across separate tile adapters', async () => {
  const starts: number[] = [], queue = new YandexTileQueue();
  let active = 0, maxActive = 0;
  const fetcher: typeof fetch = async () => { starts.push(performance.now()); active++; maxActive = Math.max(maxActive, active); await pause(300); active--; return response(); };
  const options = { queue, environment: { YANDEX_TILES_API_KEY: 'synthetic' }, fetcher };
  const one = createYandexTiles(options), two = createYandexTiles(options);
  await Promise.all(Array.from({ length: 28 }, (_, x) => (x % 2 ? one : two).get({ ...point, z: 6, x }, signal())));
  assert.equal(starts.length, 28); assert.ok(maxActive <= 6);
  for (let i = 1; i < starts.length; i++) assert.ok(starts[i] - starts[i - 1] >= 38, `unexpected burst: ${starts[i] - starts[i - 1]} ms`);
  for (const start of starts) assert.ok(starts.filter(value => value >= start && value < start + 1000).length <= 25);
});

test('deduplicated consumers cancel independently; all cancelled requests abort the provider', async () => {
  let calls = 0, aborted = 0;
  const tiles = createYandexTiles({ queue: new YandexTileQueue(), environment: { YANDEX_TILES_API_KEY: 'synthetic' }, fetcher: async (_url, init) => {
    calls++;
    try { await pause(100, undefined, { signal: init!.signal! }); } catch { aborted++; throw new Error('PRIVATE-PROVIDER-URL'); }
    return response();
  } });
  const first = new AbortController(), second = new AbortController();
  const pendingOne = tiles.get(point, first.signal), pendingTwo = tiles.get(point, second.signal);
  await pause(5); first.abort(); await assert.rejects(pendingOne, status(499));
  assert.deepEqual((await pendingTwo).bytes, png); assert.equal(calls, 1); assert.equal(aborted, 0);
  const last = new AbortController(), pendingLast = tiles.get({ ...point, x: 2 }, last.signal);
  await pause(45); last.abort(); await assert.rejects(pendingLast, status(499)); await pause(5); assert.equal(aborted, 1);
  assert.deepEqual((await tiles.get({ ...point, x: 2 }, signal())).bytes, png); assert.equal(calls, 3);
});

test('cancelled queued tiles never reach provider, queue is bounded and failed work does not block later work', async () => {
  const queue = new YandexTileQueue(2);
  let calls = 0;
  const tiles = createYandexTiles({ queue, environment: { YANDEX_TILES_API_KEY: 'synthetic' }, fetcher: async () => { calls++; return response(); } });
  const controllers = Array.from({ length: 4 }, () => new AbortController());
  const requests = controllers.map((controller, x) => tiles.get({ ...point, x }, controller.signal));
  const checks = requests.map(promise => promise.then(() => 'ok', error => (error as ApiError).status));
  controllers[1].abort(); controllers[2].abort();
  assert.deepEqual(await Promise.all(checks), ['ok', 499, 499, 503]); assert.equal(calls, 1);
  await tiles.get({ ...point, x: 4 }, signal()); assert.equal(calls, 2);
});

test('provider failures, redirects, unsafe bodies and overlarge images produce safe bounded errors and a cooldown', async () => {
  const invalid: (() => Response | Promise<Response>)[] = [
    () => new Response('PRIVATE-KEY', { status: 403 }),
    () => new Response('PRIVATE-KEY', { status: 429 }),
    () => new Response('PRIVATE-KEY', { status: 500 }),
    () => new Response('PRIVATE-KEY', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response('PRIVATE-KEY', { headers: { 'Content-Type': 'image/png' } }),
    () => new Response('<svg>PRIVATE-KEY</svg>', { headers: { 'Content-Type': 'image/svg+xml' } }),
    () => new Response(png, { headers: { 'Content-Type': 'image/png', 'Content-Length': String(3 * 1024 * 1024) } }),
    () => new Response(Buffer.alloc(2 * 1024 * 1024 + 1), { headers: { 'Content-Type': 'image/png' } }),
    () => { throw new Error('https://provider.invalid?apikey=PRIVATE-KEY'); },
  ];
  for (const bad of invalid) {
    let calls = 0;
    const tiles = createYandexTiles({ environment: { YANDEX_TILES_API_KEY: 'PRIVATE-KEY' }, queue: new YandexTileQueue(), fetcher: async () => { calls++; return bad(); } });
    await assert.rejects(tiles.get(point, signal()), error => { assert.ok(status(503)(error)); assert.doesNotMatch(String(error), /PRIVATE|https:|provider/); return true; });
    await assert.rejects(tiles.get({ ...point, x: 3 }, signal()), status(503)); assert.equal(calls, 1);
  }
});

test('successful image cache is byte bounded and evicts old tiles', async () => {
  let calls = 0;
  const largePng = Buffer.concat([png, Buffer.alloc(2 * 1024 * 1024 - png.length)]);
  const tiles = createYandexTiles({ environment: { YANDEX_TILES_API_KEY: 'synthetic' }, queue: new YandexTileQueue(), fetcher: async () => { calls++; return new Response(largePng, { headers: { 'Content-Type': 'image/png' } }); } });
  for (let x = 0; x < 17; x++) await tiles.get({ ...point, x, z: 6 }, signal());
  assert.equal(calls, 17);
  await tiles.get({ ...point, x: 16, z: 6 }, signal()); assert.equal(calls, 17);
  await tiles.get({ ...point, x: 0, z: 6 }, signal()); assert.equal(calls, 18);
});


test('Yandex WithTTL signature matches an independent HMAC vector and changes at the UTC hour boundary', async () => {
  const url = new URL('https://tiles.api-maps.yandex.ru/v1/tiles/?apikey=synthetic-api-key&lang=ru_RU&x=1&y=2&z=4&l=map&scale=2&projection=web_mercator&maptype=future_map');
  const secret = 'MDEyMzQ1Njc4OWFiY2RlZg'; // Synthetic bytes: 0123456789abcdef.
  // Expected vector independently generated by Python hashlib/hmac, not by the code under test.
  const expected = '7CTGEDOQY0fu-L-v4bb8D42ljukMAQCjJwaEkyhQSr0';
  assert.equal(yandexTileSignature(url, secret, Date.parse('2026-10-12T22:00:00Z')), expected);
  assert.equal(yandexTileSignature(url, secret + '==', Date.parse('2026-10-12T22:59:59.999Z')), expected);
  assert.equal(yandexTileSignature(url, secret, Date.parse('2026-10-13T01:15:00+03:00')), expected);
  assert.notEqual(yandexTileSignature(url, secret, Date.parse('2026-10-12T23:00:00Z')), expected);
  assert.equal(yandexTileSignature(new URL(url.pathname + url.search, 'https://irrelevant.example'), secret, Date.parse('2026-10-12T22:15:00Z')), expected);
  for (const bad of ['', '%%%PRIVATE%%%', 'secret with spaces', 'a']) assert.throws(() => yandexTileSignature(url, bad, Date.now()), status(503));
  const tiles = createYandexTiles({ environment: { YANDEX_TILES_API_KEY: 'synthetic-api-key', YANDEX_TILES_SIGNING_SECRET: secret }, now: () => Date.parse('2026-10-12T22:15:00Z'), queue: new YandexTileQueue(), fetcher: async input => {
    const actual = new URL(String(input));
    assert.equal(actual.searchParams.get('signature'), expected);
    assert.equal([...actual.searchParams.keys()].at(-1), 'signature');
    assert.doesNotMatch(actual.href, /MDEyMzQ1Njc4OWFiY2RlZg/);
    return response();
  } });
  assert.deepEqual((await tiles.get(point, signal())).bytes, png);
});

test('invalid configured signing secret fails closed before provider access', async () => {
  let calls = 0;
  const tiles = createYandexTiles({ environment: { YANDEX_TILES_API_KEY: 'synthetic-api-key', YANDEX_TILES_SIGNING_SECRET: 'INVALID PRIVATE SECRET' }, queue: new YandexTileQueue(), fetcher: async () => { calls++; return response(); } });
  await assert.rejects(tiles.get(point, signal()), error => { assert.ok(status(503)(error)); assert.doesNotMatch(String(error), /PRIVATE|SECRET/); return true; });
  assert.equal(calls, 0);
});

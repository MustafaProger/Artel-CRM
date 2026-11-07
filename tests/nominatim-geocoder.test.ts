import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile, copyFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { addressQueries, createNominatimGeocoder, NominatimQueue, nominatimLocation } from '../server/nominatim-geocoder';

const address = 'улица Бианки, 2к1, Московский, Филимонковский район, Новомосковский административный округ, Москва';
const building = { lat: '55.6032093', lon: '37.3583189', osm_type: 'way', osm_id: 295051803, category: 'building', addresstype: 'building', display_name: '2 к1, улица Бианки, Московский, Москва', address: { house_number: '2 к1', road: 'улица Бианки', town: 'Московский', state: 'Москва' }, boundingbox: ['55.6030', '55.6035', '37.3580', '37.3586'] };
const found = nominatimLocation(address, [building]);

async function runtime(fetcher: typeof fetch) {
  const folder = await mkdtemp(join(tmpdir(), 'artel-geocoder-test-'));
  const clock = { value: 1800000000000, now() { return this.value; }, async wait(ms: number) { this.value += ms; } };
  const queue = new NominatimQueue({ now: () => clock.now(), wait: ms => clock.wait(ms) });
  const cachePath = join(folder, 'trip-request-geocoding-cache.json');
  const options = { cachePath, fetcher, environment: {}, queue, now: () => clock.now() };
  return { folder, clock, queue, cachePath, options, geocode: createNominatimGeocoder(options), async close() { await rm(folder, { recursive: true, force: true }); } };
}

test('address fallback removes only district/okrug segments; exact house, street, city and region must match', () => {
  assert.deepEqual(addressQueries(address), [address, 'улица Бианки, 2к1, Московский, Москва']);
  assert.deepEqual(addressQueries('улица Лесная, 5, городской округ, г. Химки, Московская область'), ['улица Лесная, 5, городской округ, г. Химки, Московская область', 'улица Лесная, 5, г. Химки, Московская область']);
  assert.equal(found.status, 'found');
  for (const fields of [{ house_number: '2 к2' }, { road: 'улица Лесная' }, { town: 'Другой город' }, { state: 'Другая область' }]) assert.equal(nominatimLocation(address, [{ ...building, address: { ...building.address, ...fields } }]).status, 'ambiguous');
  for (const [requested, returned] of [['2/1', '21'], ['12-14', '1214'], ['2.1', '21']]) assert.equal(nominatimLocation(`улица Бианки, ${requested}, Московский, Москва`, [{ ...building, address: { ...building.address, house_number: returned } }]).status, 'ambiguous');
  assert.equal(nominatimLocation(address, [{ ...building, address: { ...building.address, road: 'проспект Бианки' } }]).status, 'ambiguous');
  assert.equal(nominatimLocation(address, [{ ...building, lat: 'NaN' }]).status, 'ambiguous');
  assert.equal(nominatimLocation(address, []).status, 'not_found');
  assert.equal(nominatimLocation(address, { error: 'provider internals' }).status, 'unavailable');
});

test('numeric street names and locality abbreviations are not misread as house numbers', () => {
  for (const road of ['улица 8 Марта', 'улица 1905 года']) {
    const candidate = { ...building, address: { house_number: '5', road, city: 'Москва' } };
    assert.equal(nominatimLocation(`${road}, 5, г.Москва`, [candidate]).status, 'found');
    assert.equal(nominatimLocation(`${road} 5, Москва`, [candidate]).status, 'found');
  }
  assert.equal(nominatimLocation('ул.Бианки, 2 корпус 1, Московский, г.Москва', [building]).status, 'found');
  const street = nominatimLocation('улица Бианки, Московский, Москва', [{ ...building, category: 'highway', addresstype: 'road', address: { road: 'улица Бианки', town: 'Московский', state: 'Москва' } }]);
  assert.equal(street.status, 'found'); if (street.status === 'found') assert.equal(street.accuracy, 'street');
  assert.equal(nominatimLocation('Москва', [building]).status, 'ambiguous');
});

test('a building and its internal POI use the building centroid; distinct houses stay ambiguous', () => {
  const terminal = { ...building, lat: '55.6033', lon: '37.3584', category: 'amenity', addresstype: 'amenity', osm_type: 'node', osm_id: 1 };
  assert.deepEqual(nominatimLocation(address, [terminal, building]), found);
  assert.equal(nominatimLocation(address, [building, { ...terminal, lat: '55.6040' }]).status, 'ambiguous');
  assert.equal(nominatimLocation(address, [building, { ...building, osm_id: 2, lat: '55.609' }]).status, 'ambiguous');
});

test('server query sends only the address, identifies the app, throttles fallback and caches exact results on disk', async () => {
  const calls: { url: URL; init?: RequestInit; time: number }[] = [];
  const f: Awaited<ReturnType<typeof runtime>> = await runtime(async (url, init) => { calls.push({ url: new URL(String(url)), init, time: f.clock.value }); return Response.json(calls.length === 1 ? [] : [building]); });
  try {
    const results = await Promise.all([f.geocode(address), f.geocode(address)]);
    assert.deepEqual(results, [found, found]); assert.equal(calls.length, 2);
    assert.ok(calls[1].time - calls[0].time >= 1000);
    assert.equal(calls[0].url.searchParams.get('q'), address);
    assert.equal(calls[1].url.searchParams.get('q'), addressQueries(address)[1]);
    assert.deepEqual([...calls[1].url.searchParams.keys()].sort(), ['accept-language', 'addressdetails', 'format', 'layer', 'limit', 'q']);
    assert.equal(calls[1].url.searchParams.get('limit'), '5'); assert.equal(calls[1].url.searchParams.get('layer'), 'address');
    assert.match(new Headers(calls[1].init?.headers).get('user-agent')!, /ArtelCRM.*https:\/\/artel-crm.online/);
    assert.equal(calls[1].init?.redirect, 'error'); assert.ok(calls[1].init?.signal);
    assert.deepEqual(await f.geocode(` ${address} `), found); assert.equal(calls.length, 2);
    assert.equal((await stat(f.cachePath)).mode & 0o777, 0o600);
    const persisted = JSON.parse(await readFile(f.cachePath, 'utf8')); assert.equal(Object.keys(persisted.entries).length, 1);
    const reloadedPath = join(f.folder, 'fresh-process-cache.json'); await copyFile(f.cachePath, reloadedPath);
    assert.deepEqual(await createNominatimGeocoder({ ...f.options, cachePath: reloadedPath })(address), found); assert.equal(calls.length, 2);
    f.clock.value += 31 * 86400_000; assert.deepEqual(await f.geocode(address), found); assert.equal(calls.length, 3);
  } finally { await f.close(); }
});

test('negative results are cached, isolated by provider, expire, and disabled service never fetches', async () => {
  let calls = 0;
  const f = await runtime(async () => { calls++; return Response.json([]); });
  try {
    const short = addressQueries(address)[1];
    assert.equal((await f.geocode(short)).status, 'not_found'); assert.equal((await f.geocode(short)).status, 'not_found'); assert.equal(calls, 1);
    const other = createNominatimGeocoder({ ...f.options, environment: { ARTEL_GEOCODER_URL: 'https://geo.example.test/search' } });
    await other(short); assert.equal(calls, 2);
    f.clock.value += 86400_001; await f.geocode(short); assert.equal(calls, 3);
    for (const environment of [{ ARTEL_GEOCODER_ENABLED: 'false' }, { ARTEL_GEOCODER_URL: 'http://127.0.0.1/internal' }, { ARTEL_GEOCODER_USER_AGENT: 'x\r\nInjected: true' }]) assert.equal((await createNominatimGeocoder({ ...f.options, environment })(short)).status, 'unavailable');
    assert.equal(calls, 3);
  } finally { await f.close(); }
});

test('all clients of the shared queue are sequential and separated by at least one second', async () => {
  let time = 1000, active = 0, maxActive = 0; const starts: number[] = [];
  const queue = new NominatimQueue({ now: () => time, wait: async ms => { time += ms; } });
  const values = await Promise.all([1, 2, 3].map(value => queue.run(async () => { starts.push(time); active++; maxActive = Math.max(maxActive, active); await Promise.resolve(); active--; return value; })));
  assert.deepEqual(values, [1, 2, 3]); assert.equal(maxActive, 1); assert.ok(starts.slice(1).every((value, index) => value - starts[index] >= 1000));
});

test('rate-limit backoff respects both seconds and HTTP dates, without retry storms or provider error leakage', async () => {
  for (const format of ['seconds', 'date']) {
    let calls = 0;
    const f: Awaited<ReturnType<typeof runtime>> = await runtime(async () => { calls++; return new Response('PRIVATE provider error', { status: 429, headers: { 'Retry-After': format === 'seconds' ? '3600' : new Date(f.clock.value + 3600_000).toUTCString() } }); });
    try {
      const result = await f.geocode(address); assert.equal(result.status, 'unavailable'); assert.doesNotMatch(JSON.stringify(result), /PRIVATE|429/);
      f.clock.value += 61_000; await f.geocode('улица Новая, 5, Москва'); assert.equal(calls, 1);
      f.clock.value += 3600_000; await f.geocode('улица Другая, 5, Москва'); assert.equal(calls, 2);
      assert.equal(Object.keys(JSON.parse(await readFile(f.cachePath, 'utf8')).entries).length, 0);
    } finally { await f.close(); }
  }
});

test('broken and oversized provider replies are unavailable, and cache size remains bounded', async () => {
  let calls = 0;
  const f = await runtime(async () => { calls++; return calls === 1 ? new Response('{broken') : new Response('too big', { headers: { 'content-length': '999999' } }); });
  try {
    assert.equal((await f.geocode(address)).status, 'unavailable');
    assert.equal((await f.geocode('улица Другая, 5, Москва')).status, 'unavailable');
    const boundedPath = join(f.folder, 'bounded-cache.json');
    await writeFile(boundedPath, JSON.stringify({ schemaVersion: 1, entries: Object.fromEntries(Array.from({ length: 1000 }, (_, index) => [index.toString(16).padStart(64, '0'), { expiresAt: f.clock.value + 86400_000, location: found }])) }));
    const lookup = createNominatimGeocoder({ ...f.options, cachePath: boundedPath, fetcher: async () => Response.json([building]) });
    assert.deepEqual(await lookup(address), found);
    assert.equal(Object.keys(JSON.parse(await readFile(boundedPath, 'utf8')).entries).length, 1000);
  } finally { await f.close(); }
});


test('standalone structure numbers retain identity and named territories require an exact house and locality', () => {
  const structured = { ...building, address: { road: 'улица Промзона Пример', house_number: 'с9', town: 'Примерск', state: 'Московская область' } };
  for (const house of ['с9', 'стр. 9', 'строение 9']) {
    const requested = `улица Промзона Пример, ${house}, Примерск, Московская область`;
    assert.equal(nominatimLocation(requested, [structured]).status, 'found');
    for (const changed of [{ house_number: '9/1' }, { house_number: '9' }, { town: 'Другой город' }, { road: 'проектируемый проезд №1' }]) assert.equal(nominatimLocation(requested, [{ ...structured, address: { ...structured.address, ...changed } }]).status, 'ambiguous');
  }
  const place = { ...building, address: { quarter: 'микрорайон Пример', house_number: 'с9', city: 'Примерск', state: 'Московская область' } };
  const requested = 'микрорайон Пример, строение 9, Примерск, Московская область';
  assert.equal(nominatimLocation(requested, [place]).status, 'found');
  for (const changed of [{ house_number: undefined }, { house_number: '9/1' }, { quarter: 'Другая территория' }, { city: 'Другой город' }]) assert.equal(nominatimLocation(requested, [{ ...place, address: { ...place.address, ...changed } }]).status, 'ambiguous');
  assert.equal(nominatimLocation('микрорайон Пример, Примерск, Московская область', [place]).status, 'ambiguous');
});

test('manual retry can recover after a transport failure but cannot bypass provider Retry-After', async () => {
  let calls = 0;
  const f = await runtime(async () => { calls++; if (calls === 1) throw new Error('Synthetic transport timeout'); return Response.json([building]); });
  try {
    assert.equal((await f.geocode(address)).status, 'unavailable'); assert.equal(calls, 1);
    assert.equal((await f.geocode(address)).status, 'unavailable'); assert.equal(calls, 1);
    assert.deepEqual(await f.geocode(address, true), found); assert.equal(calls, 2);
  } finally { await f.close(); }
  let throttledCalls = 0;
  const limited = await runtime(async () => { throttledCalls++; return new Response('', { status: 429, headers: { 'Retry-After': '3600' } }); });
  try {
    assert.equal((await limited.geocode(address)).status, 'unavailable');
    assert.equal((await limited.geocode(address, true)).status, 'unavailable'); assert.equal(throttledCalls, 1);
    limited.clock.value += 3600_001;
    assert.equal((await limited.geocode(address, true)).status, 'unavailable'); assert.equal(throttledCalls, 2);
  } finally { await limited.close(); }
});

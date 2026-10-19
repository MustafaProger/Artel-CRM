import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { TripRequestLocationResult } from '../web/src/trip-request-map-coordinates';

type Location = TripRequestLocationResult;
type Cached = { expiresAt: number; location: Location };
type Clock = { now: () => number; wait: (milliseconds: number) => Promise<void> };
const realClock: Clock = { now: Date.now, wait: milliseconds => new Promise(done => setTimeout(done, milliseconds)) };
const unavailable = (): Location => ({ status: 'unavailable', message: 'Поиск адреса временно недоступен. Повторите позже или уточните точку на карте.' });
const notFound = (): Location => ({ status: 'not_found', message: 'Не удалось найти этот адрес. Уточните адрес доставки.' });
const ambiguous = (): Location => ({ status: 'ambiguous', message: 'Не удалось однозначно определить место доставки. Уточните адрес доставки.' });
const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const normalize = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');
const comparable = (value: string) => normalize(value).toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/[^\p{L}\p{N}]/gu, '');

/** One queue for the server, including different middleware instances and fallback queries. */
export class NominatimQueue {
  private tail: Promise<unknown> = Promise.resolve();
  private pending = 0;
  private lastStart = -Infinity;
  private blockedUntil = 0;
  constructor(private clock: Clock = realClock) {}
  backoff(seconds: number) { this.blockedUntil = Math.max(this.blockedUntil, this.clock.now() + Math.min(86400, Math.max(1, seconds)) * 1000); }
  async run<T>(operation: () => Promise<T>): Promise<T> {
    if (this.pending >= 12 || this.clock.now() < this.blockedUntil) throw new Error('Geocoder busy');
    const enqueuedAt = this.clock.now();
    this.pending++;
    const result = this.tail.catch(() => undefined).then(async () => {
      if (this.clock.now() - enqueuedAt > 15_000 || this.clock.now() < this.blockedUntil) throw new Error('Geocoder busy');
      await this.clock.wait(Math.max(0, this.lastStart + 1100 - this.clock.now()));
      this.lastStart = this.clock.now();
      return operation();
    });
    this.tail = result;
    try { return await result; } finally { this.pending--; }
  }
}
const globalQueue = new NominatimQueue();
const pendingLookups = new Map<string, Promise<Location>>();
const cacheStates = new Map<string, Promise<Map<string, Cached>>>();
const cacheWrites = new Map<string, Promise<void>>();
const MAX_CACHE = 1000;

function validLocation(value: unknown): value is Location {
  const row = record(value);
  if (!row) return false;
  if (row.status === 'found') return row.source === 'geocoder' && typeof row.latitude === 'number' && Number.isFinite(row.latitude) && Math.abs(row.latitude) <= 90 && typeof row.longitude === 'number' && Number.isFinite(row.longitude) && Math.abs(row.longitude) <= 180 && typeof row.label === 'string' && row.label.length <= 500 && ['building', 'street'].includes(String(row.accuracy));
  return ['not_found', 'ambiguous'].includes(String(row.status)) && typeof row.message === 'string' && row.message.length <= 500;
}
async function readCache(path: string) {
  let state = cacheStates.get(path);
  if (!state) {
    state = (async () => {
      const entries = new Map<string, Cached>();
      try {
        const file = await open(path, 'r');
        let data: unknown;
        try { if ((await file.stat()).size > 1024 * 1024) return entries; data = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
        const root = record(data), rows = record(root?.entries);
        if (root?.schemaVersion !== 1 || !rows) return entries;
        for (const [key, value] of Object.entries(rows).slice(-MAX_CACHE)) {
          const row = record(value);
          if (/^[a-f0-9]{64}$/.test(key) && typeof row?.expiresAt === 'number' && Number.isFinite(row.expiresAt) && validLocation(row.location)) entries.set(key, row as Cached);
        }
      } catch { /* Cache is disposable; never read or change operations.json here. */ }
      return entries;
    })();
    cacheStates.set(path, state);
  }
  return state;
}
async function persistCache(path: string, entries: Map<string, Cached>) {
  const previous = cacheWrites.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ schemaVersion: 1, entries: Object.fromEntries(entries) })); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => undefined); }
  });
  cacheWrites.set(path, pending);
  try { await pending; } finally { if (cacheWrites.get(path) === pending) cacheWrites.delete(path); }
}

const roadWords = /(?:^|\s)(?:(?:улица|ул|проспект|пр-т|переулок|пер|шоссе|бульвар|б-р|набережная|наб|проезд|площадь|пл|тупик|аллея)(?=\s|$)|(?:ул|пер|наб|пл)\.)/giu;
const roadName = (value: string) => {
  const word = comparable(value.match(roadWords)?.[0] ?? '');
  const type = [['улица', 'ул'], ['проспект', 'прт'], ['переулок', 'пер'], ['бульвар', 'бр'], ['набережная', 'наб'], ['площадь', 'пл']].find(words => words.includes(word))?.[0] ?? word;
  return `${type}:${comparable(value.replace(roadWords, ' '))}`;
};
const houseNumber = (value: string) => normalize(value).toLocaleLowerCase('ru').replace(/ё/g, 'е').replace(/^(?:дом|д\.)\s*/u, '').replace(/корпус|корп\.?/gu, 'к').replace(/строение|стр\.?/gu, 'с').replace(/[–—]/g, '-').replace(/[^\p{L}\p{N}/.-]/gu, '');
const localityName = (value: string) => comparable(value.replace(/^(?:(?:город|пос[её]лок|пгт|село|деревня)\s+|(?:г\.|пос\.|с\.|дер\.)\s*)/iu, ''));
const housePattern = '(?:(?:строение|стр\\.?|с)\\s*)?(?:дом\\s*|д\\.?\\s*)?\\d+[а-яa-z]?(?:\\s*(?:корпус|корп\\.?|к|строение|стр\\.?|с)\\s*\\d+[а-яa-z]?)*(?:\\s*[/.-]\\s*\\d+[а-яa-z]?)?';
const territoryWords = /^(?:промзона|промышленная зона|микрорайон|мкр\.?)(?:\s+|(?=\d))/iu;
const territoryName = (value: string) => comparable(value.replace(territoryWords, ''));
const isAdministrativeSegment = (value: string) => /(?:^|\s)(?:район|округ)$/iu.test(value.trim());
export function addressQueries(address: string): string[] {
  const full = normalize(address);
  const shortened = full.split(',').map(value => value.trim()).filter(value => value && !isAdministrativeSegment(value)).join(', ');
  return shortened && shortened !== full ? [full, shortened] : [full];
}
function addressIntent(address: string) {
  const parts = addressQueries(address).at(-1)!.split(',').map(value => value.trim()).filter(Boolean);
  let house = '', road = '', place = '';
  const localities: string[] = [];
  for (const part of parts) {
    roadWords.lastIndex = 0;
    if (roadWords.test(part)) {
      const combined = part.match(new RegExp(`^(.*\\S)\\s+(${housePattern})$`, 'iu'));
      road = roadName(combined?.[1] ?? part);
      if (combined) house = houseNumber(combined[2]);
    } else if (territoryWords.test(part)) {
      const combined = part.match(new RegExp(`^(.*\\S)\\s+(${housePattern})$`, 'iu'));
      place = territoryName(combined?.[1] ?? part);
      if (combined) house = houseNumber(combined[2]);
    } else if (new RegExp(`^${housePattern}$`, 'iu').test(part) && !/^\d{6}$/.test(part)) house = houseNumber(part);
    else if (!/^\d{6}$/.test(part) && !/^(?:россия|российская федерация)$/iu.test(part)) localities.push(localityName(part));
  }
  return { house, road, place, localities };
}
type Candidate = { latitude: number; longitude: number; label: string; building: boolean; identity: string; box: number[] | null };
/** Reject a nearby street/other house and group a building with POIs inside that same building. */
export function nominatimLocation(address: string, payload: unknown): Location {
  if (!Array.isArray(payload)) return unavailable();
  const intent = addressIntent(address);
  if ((!intent.road && (!intent.place || !intent.house)) || intent.road.endsWith(':') || !intent.localities.length) return ambiguous();
  const matches: Candidate[] = [];
  for (const value of payload.slice(0, 5)) {
    const row = record(value), details = record(row?.address);
    if (!row || !details || typeof row.lat !== 'string' || typeof row.lon !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(row.lat) || !/^[+-]?\d+(?:\.\d+)?$/.test(row.lon)) continue;
    const latitude = Number(row.lat), longitude = Number(row.lon);
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) continue;
    const road = ['road', 'pedestrian', 'residential', 'footway'].map(key => details[key]).find(value => typeof value === 'string');
    if (intent.road && (typeof road !== 'string' || roadName(road) !== intent.road)) continue;
    if (intent.place && !['place', 'quarter', 'neighbourhood', 'suburb', 'residential', 'allotments'].some(key => typeof details[key] === 'string' && territoryName(details[key] as string) === intent.place)) continue;
    if (intent.house && (typeof details.house_number !== 'string' || houseNumber(details.house_number) !== intent.house)) continue;
    if (!intent.house && !['road', 'street'].includes(String(row.addresstype))) continue;
    const localities = ['city', 'town', 'village', 'hamlet', 'municipality', 'state', 'county', 'region', 'suburb', 'city_district', 'neighbourhood'].map(key => details[key]).filter((value): value is string => typeof value === 'string').map(localityName);
    if (intent.localities.some(value => !localities.includes(value))) continue;
    const candidate: Candidate = { latitude, longitude, label: typeof row.display_name === 'string' ? row.display_name.slice(0, 500) : address.slice(0, 500), building: row.class === 'building' || row.category === 'building' || row.addresstype === 'building', identity: `${row.osm_type ?? ''}:${row.osm_id ?? ''}`, box: Array.isArray(row.boundingbox) && row.boundingbox.length === 4 ? row.boundingbox.map(Number) : null };
    if (!matches.some(existing => existing.latitude === latitude && existing.longitude === longitude || candidate.identity !== ':' && candidate.identity === existing.identity)) matches.push(candidate);
  }
  if (!matches.length) return payload.length ? ambiguous() : notFound();
  const buildings = matches.filter(value => value.building);
  const preferred = buildings.length === 1 ? buildings[0] : matches[0];
  if (matches.length > 1) {
    const box = preferred.box;
    if (!preferred.building || !box || box.some(value => !Number.isFinite(value)) || box[0] > box[1] || box[2] > box[3] || matches.some(value => value.latitude < box[0] || value.latitude > box[1] || value.longitude < box[2] || value.longitude > box[3])) return ambiguous();
  }
  return { status: 'found', latitude: preferred.latitude, longitude: preferred.longitude, source: 'geocoder', label: preferred.label, accuracy: intent.house ? 'building' : 'street' };
}

export function createNominatimGeocoder(options: { cachePath: string; environment?: Record<string, string | undefined>; fetcher?: typeof fetch; queue?: NominatimQueue; now?: () => number }) {
  const environment = options.environment ?? process.env, fetcher = options.fetcher ?? fetch, queue = options.queue ?? globalQueue, now = options.now ?? Date.now;
  const cachePath = resolve(options.cachePath);
  return async (input: string, retryUnavailable = false): Promise<Location> => {
    const address = normalize(input);
    if (!address || address.length > 2000) return notFound();
    if (environment.ARTEL_GEOCODER_ENABLED === 'false') return unavailable();
    let endpoint: URL;
    try { endpoint = new URL(environment.ARTEL_GEOCODER_URL?.trim() || 'https://nominatim.openstreetmap.org/search'); if (endpoint.protocol !== 'https:' || endpoint.username || endpoint.password || endpoint.hash) return unavailable(); } catch { return unavailable(); }
    const userAgent = environment.ARTEL_GEOCODER_USER_AGENT?.trim() || 'ArtelCRM/1.0 (+https://artel-crm.online)';
    if (userAgent.length < 10 || userAgent.length > 300 || /[\r\n]/.test(userAgent)) return unavailable();
    const key = createHash('sha256').update(JSON.stringify(['nominatim-v1', endpoint.href, address])).digest('hex'), pendingKey = `${cachePath}:${key}`;
    const entries = await readCache(cachePath), cached = entries.get(key);
    if (cached && cached.expiresAt > now() && !(retryUnavailable && cached.location.status === 'unavailable')) return structuredClone(cached.location);
    const existing = pendingLookups.get(pendingKey);
    if (existing) return structuredClone(await existing);
    const lookup = (async () => {
      let location: Location = notFound();
      for (const query of addressQueries(address)) {
        try {
          location = await queue.run(async () => {
            const url = new URL(endpoint);
            for (const [key, value] of Object.entries({ q: query, format: 'jsonv2', limit: '5', addressdetails: '1', 'accept-language': 'ru', layer: 'address' })) url.searchParams.set(key, value);
            const response = await fetcher(url, { headers: { Accept: 'application/json', 'User-Agent': userAgent }, signal: AbortSignal.timeout(6000), redirect: 'error' });
            if (!response.ok) {
              if ([403, 429, 503].includes(response.status)) { const header = response.headers.get('retry-after'), seconds = header ? Number(header) : NaN, retry = Number.isFinite(seconds) ? seconds : header ? (Date.parse(header) - now()) / 1000 : NaN; queue.backoff(Number.isFinite(retry) && retry > 0 ? retry : 60); }
              return unavailable();
            }
            if (Number(response.headers.get('content-length')) > 256 * 1024) return unavailable();
            const reader = response.body?.getReader();
            if (!reader) return unavailable();
            const parts: Uint8Array[] = []; let size = 0;
            while (true) { const { value, done } = await reader.read(); if (done) break; size += value.byteLength; if (size > 256 * 1024) { await reader.cancel(); return unavailable(); } parts.push(value); }
            return nominatimLocation(address, JSON.parse(Buffer.concat(parts).toString('utf8')));
          });
        } catch { location = unavailable(); }
        if (location.status === 'found' || location.status === 'unavailable') break;
      }
      for (const [storedKey, value] of entries) if (value.expiresAt <= now()) entries.delete(storedKey);
      entries.delete(key);
      entries.set(key, { expiresAt: now() + (location.status === 'found' ? 30 * 86400_000 : location.status === 'unavailable' ? 60_000 : 86400_000), location });
      while (entries.size > MAX_CACHE) entries.delete(entries.keys().next().value!);
      // Persist positive and negative matches; short outage cooldowns are process-local.
      try { await persistCache(cachePath, new Map([...entries].filter(([, value]) => value.location.status !== 'unavailable'))); } catch { /* A cache write failure never changes business data or fabricates a point. */ }
      return location;
    })();
    pendingLookups.set(pendingKey, lookup);
    try { return structuredClone(await lookup); } finally { pendingLookups.delete(pendingKey); }
  };
}

/** Reads only the existing provider cache; never starts network work. */
export async function readNominatimCachedLocation(input: string, options: { cachePath: string; environment?: Record<string, string | undefined>; now?: () => number }): Promise<TripRequestLocationResult | null> {
  const address = normalize(input), environment = options.environment ?? process.env;
  let endpoint: URL;
  try { endpoint = new URL(environment.ARTEL_GEOCODER_URL?.trim() || 'https://nominatim.openstreetmap.org/search'); } catch { return null; }
  const key = createHash('sha256').update(JSON.stringify(['nominatim-v1', endpoint.href, address])).digest('hex');
  const entry = (await readCache(resolve(options.cachePath))).get(key);
  return entry && entry.expiresAt > (options.now ?? Date.now)() ? structuredClone(entry.location) : null;
}

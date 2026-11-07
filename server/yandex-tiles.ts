import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { ApiError } from './api-error';

const upstreamOrigin = 'https://tiles.api-maps.yandex.ru/v1/tiles/';
const providerReferer = 'https://artel-crm.online/';
const tileLifetimeMs = 5 * 60_000;
const maxTileBytes = 2 * 1024 * 1024;
const maxCacheBytes = 32 * 1024 * 1024;
const maxCacheEntries = 256;
const unavailable = () => new ApiError(503, 'Карта Яндекса временно недоступна. Попробуйте обновить карту позже.');
const cancelled = () => new ApiError(499, 'Загрузка карты отменена.');

export interface YandexTileCoordinates { x: number; y: number; z: number; scale: 1 | 2 }
export interface YandexTile { bytes: Buffer; contentType: string }

/** No host, style, key, language or projection can be supplied by a browser. */
export function parseYandexTileCoordinates(params: URLSearchParams): YandexTileCoordinates {
  const names = ['x', 'y', 'z', 'scale'];
  if ([...params.keys()].some(key => !names.includes(key)) || names.some(key => params.getAll(key).length !== 1)) throw new ApiError(400, 'Некорректные параметры карты.');
  const integer = (key: string) => {
    const value = params.get(key)!;
    if (!/^(?:0|[1-9]\d{0,6})$/.test(value)) throw new ApiError(400, 'Некорректные координаты карты.');
    return Number(value);
  };
  const x = integer('x'), y = integer('y'), z = integer('z'), scale = integer('scale');
  if (z > 20 || x >= 2 ** z || y >= 2 ** z || (scale !== 1 && scale !== 2)) throw new ApiError(400, 'Некорректные координаты карты.');
  return { x, y, z, scale };
}

/** Yandex WithTTL: sign the UTC hour, then the exact path/query; no host or signature parameter.
 * https://yandex.ru/maps-api/docs/common/security/signature_usage.html
 */
export function yandexTileSignature(url: URL, encodedSecret: string, timestamp: number): string {
  const value = encodedSecret.trim();
  if (!/^[A-Za-z0-9_-]{2,684}={0,2}$/.test(value) || url.searchParams.has('signature')) throw unavailable();
  const secret = Buffer.from(value, 'base64url');
  if (!secret.length || secret.toString('base64url') !== value.replace(/=+$/, '')) throw unavailable();
  const utcHour = new Date(timestamp).toISOString().slice(0, 13) + ':00:00Z';
  const temporalKey = createHmac('sha256', secret).update(utcHour).digest();
  return createHmac('sha256', temporalKey).update(url.pathname + url.search).digest('base64url');
}

interface QueueEntry { start: () => void; signal: AbortSignal; abort: () => void }
/** One shared process-wide gate: at most 25 starts/second, six concurrent requests. */
export class YandexTileQueue {
  private entries: QueueEntry[] = [];
  private active = 0;
  private nextStart = 0;
  private timer: ReturnType<typeof setTimeout> | undefined;
  constructor(private readonly capacity = 128) {}
  defer(milliseconds: number) { this.nextStart = Math.max(this.nextStart, performance.now() + milliseconds); }
  run<T>(work: () => Promise<T>, signal: AbortSignal): Promise<T> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (this.entries.length >= this.capacity) return Promise.reject(unavailable());
    return new Promise<T>((resolve, reject) => {
      const entry: QueueEntry = {
        signal,
        abort: () => {
          const index = this.entries.indexOf(entry);
          if (index !== -1) { this.entries.splice(index, 1); reject(cancelled()); this.pump(); }
        },
        start: () => {
          signal.removeEventListener('abort', entry.abort);
          this.active++;
          // A late timer does not allow catch-up bursts.
          this.nextStart = performance.now() + 40;
          void Promise.resolve().then(() => { if (signal.aborted) throw cancelled(); return work(); }).then(resolve, reject).finally(() => { this.active--; this.pump(); });
        },
      };
      signal.addEventListener('abort', entry.abort, { once: true });
      this.entries.push(entry);
      this.pump();
    });
  }
  private pump() {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (!this.entries.length || this.active >= 6) return;
    const delay = this.nextStart - performance.now();
    if (delay > 0) { this.timer = setTimeout(() => { this.timer = undefined; this.pump(); }, Math.ceil(delay)); return; }
    this.entries.shift()!.start();
    this.pump();
  }
}
const sharedQueue = new YandexTileQueue();

interface YandexTilesOptions {
  environment?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  /** Isolated tests only; runtime instances share the module-level provider gate. */
  queue?: YandexTileQueue;
  now?: () => number;
}
interface Flight { controller: AbortController; promise: Promise<YandexTile>; consumers: number }

function matchesImage(bytes: Buffer, type: string) {
  if (type === 'image/png') return bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (type === 'image/jpeg') return bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  return type === 'image/webp' && bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP';
}
async function readTile(response: Response): Promise<YandexTile> {
  const contentType = response.headers.get('content-type')?.split(';')[0].trim().toLowerCase() ?? '';
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(contentType) || Number(response.headers.get('content-length') ?? 0) > maxTileBytes || !response.body) {
    await response.body?.cancel(); throw unavailable();
  }
  const reader = response.body.getReader(), chunks: Buffer[] = [];
  let length = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      length += part.value.byteLength;
      if (length > maxTileBytes) { await reader.cancel(); throw unavailable(); }
      chunks.push(Buffer.from(part.value));
    }
  } finally { reader.releaseLock(); }
  const bytes = Buffer.concat(chunks, length);
  if (!matchesImage(bytes, contentType)) throw unavailable();
  return { bytes, contentType };
}

export function createYandexTiles(options: YandexTilesOptions = {}) {
  const environment = options.environment ?? process.env;
  const apiKey = environment.YANDEX_TILES_API_KEY?.trim();
  const signingSecret = environment.YANDEX_TILES_SIGNING_SECRET?.trim();
  const fetcher = options.fetcher ?? fetch, queue = options.queue ?? sharedQueue, now = options.now ?? Date.now;
  const cache = new Map<string, { tile: YandexTile; expires: number }>();
  const flights = new Map<string, Flight>();
  let cacheBytes = 0, retryAfter = 0;
  function removeCached(key: string) { const value = cache.get(key); if (value) cacheBytes -= value.tile.bytes.length; cache.delete(key); }
  function remember(key: string, tile: YandexTile) {
    for (const [id, value] of cache) if (value.expires <= now()) removeCached(id);
    removeCached(key);
    while (cache.size >= maxCacheEntries || cacheBytes + tile.bytes.length > maxCacheBytes) removeCached(cache.keys().next().value!);
    cache.set(key, { tile, expires: now() + tileLifetimeMs }); cacheBytes += tile.bytes.length;
  }
  async function fetchTile(point: YandexTileCoordinates, signal: AbortSignal): Promise<YandexTile> {
    if (now() < retryAfter) throw unavailable();
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, 10_000);
    try {
      if (signal.aborted) throw cancelled();
      const url = new URL(upstreamOrigin);
      url.search = new URLSearchParams({ apikey: apiKey!, lang: 'ru_RU', x: String(point.x), y: String(point.y), z: String(point.z), l: 'map', scale: String(point.scale), projection: 'web_mercator', maptype: 'future_map' }).toString();
      if (signingSecret) url.searchParams.append('signature', yandexTileSignature(url, signingSecret, now()));
      const response = await fetcher(url, { signal: controller.signal, redirect: 'error', headers: { Referer: providerReferer, Accept: 'image/png,image/webp,image/jpeg' } });
      if (!response.ok) {
        await response.body?.cancel();
        // Quota or activation errors must not make every queued tile retry the provider.
        const delay = response.status === 401 || response.status === 403 ? 30_000 : response.status === 429 ? 10_000 : 3000;
        retryAfter = now() + delay;
        if (response.status === 429) queue.defer(delay);
        throw unavailable();
      }
      return await readTile(response);
    } catch {
      // Never return provider URLs, bodies, headers or fetch errors (which can contain the key).
      if (signal.aborted) throw cancelled();
      retryAfter = Math.max(retryAfter, now() + 3000);
      throw unavailable();
    } finally { clearTimeout(timeout); signal.removeEventListener('abort', abort); }
  }
  function get(point: YandexTileCoordinates, signal: AbortSignal): Promise<YandexTile> {
    if (signal.aborted) return Promise.reject(cancelled());
    if (!apiKey) return Promise.reject(new ApiError(503, 'Подключение карты Яндекса ещё не настроено.'));
    const key = `${point.z}/${point.x}/${point.y}/${point.scale}`;
    const cached = cache.get(key);
    if (cached && cached.expires > now()) { cache.delete(key); cache.set(key, cached); return Promise.resolve(cached.tile); }
    if (cached) removeCached(key);
    if (now() < retryAfter) return Promise.reject(unavailable());
    let flight = flights.get(key);
    if (!flight) {
      if (flights.size >= 192) return Promise.reject(unavailable());
      const controller = new AbortController();
      const created: Flight = { controller, consumers: 0, promise: queue.run(() => fetchTile(point, controller.signal), controller.signal) };
      created.promise = created.promise.then(tile => { if (!controller.signal.aborted) remember(key, tile); return tile; }).finally(() => { if (flights.get(key) === created) flights.delete(key); });
      flights.set(key, created); flight = created;
    }
    const subscribed = flight;
    subscribed.consumers++;
    return new Promise<YandexTile>((resolve, reject) => {
      let finished = false;
      const detach = () => {
        if (finished) return false;
        finished = true; signal.removeEventListener('abort', abort);
        if (--subscribed.consumers === 0) { if (flights.get(key) === subscribed) flights.delete(key); subscribed.controller.abort(); }
        return true;
      };
      const abort = () => { if (detach()) reject(cancelled()); };
      signal.addEventListener('abort', abort, { once: true });
      subscribed.promise.then(tile => { if (detach()) resolve(tile); }, error => { if (detach()) reject(error); });
      if (signal.aborted) abort();
    });
  }
  return { get };
}

export async function serveYandexTile(request: IncomingMessage, response: ServerResponse, params: URLSearchParams, tiles: ReturnType<typeof createYandexTiles>, authorize: () => Promise<void>) {
  await authorize();
  if (request.method !== 'GET') throw new ApiError(405, 'Метод не поддерживается.');
  const point = parseYandexTileCoordinates(params);
  const controller = new AbortController();
  const abort = () => controller.abort();
  response.once('close', abort);
  try {
    if (response.destroyed || request.aborted) controller.abort();
    const tile = await tiles.get(point, controller.signal);
    if (controller.signal.aborted) return;
    await authorize();
    if (controller.signal.aborted) return;
    response.writeHead(200, { 'Content-Type': tile.contentType, 'Content-Length': tile.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin' });
    response.end(tile.bytes);
  } catch (error) {
    if (!controller.signal.aborted) throw error;
  } finally { response.removeListener('close', abort); }
}

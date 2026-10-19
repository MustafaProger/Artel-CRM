import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { TripRequestLocationResult } from '../web/src/trip-request-map-coordinates';

type Location = TripRequestLocationResult;
type Entry = { provider: string; address: string; resolvedAt: string; retryAfter: number | null; location: Exclude<Location, { status: 'pending' }> };
type Job = { key: string; priority: 'interactive' | 'background'; run: () => Promise<void> };
type State = { entries: Map<string, Entry>; pending: Map<string, Promise<Location>>; jobs: Job[]; running: boolean; writing: Promise<void> };
const states = new Map<string, Promise<State>>();
const normalize = (address: string) => address.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
const waiting = (): Location => ({ status: 'pending', message: 'Определяем место доставки по адресу…' });
const unavailable = (): Location => ({ status: 'unavailable', message: 'Поиск адреса временно недоступен. Повторите позже.' });
const valid = (value: unknown): value is Entry => {
  if (!value || typeof value !== 'object') return false;
  const row = value as Entry, location = row.location;
  if (typeof row.provider !== 'string' || row.provider.length > 1000 || typeof row.address !== 'string' || row.address.length > 2000 || typeof row.resolvedAt !== 'string' || !Number.isFinite(Date.parse(row.resolvedAt)) || row.retryAfter !== null && !Number.isFinite(row.retryAfter) || !location) return false;
  return location.status === 'found'
    ? location.source === 'geocoder' && Number.isFinite(location.latitude) && Math.abs(location.latitude) <= 90 && Number.isFinite(location.longitude) && Math.abs(location.longitude) <= 180 && ['building', 'street'].includes(String(location.accuracy))
    : ['not_found', 'ambiguous', 'unavailable'].includes(location.status) && typeof location.message === 'string' && location.message.length <= 500;
};

async function stateFor(path: string): Promise<State> {
  let pending = states.get(path);
  if (!pending) {
    pending = (async () => {
      const state: State = { entries: new Map(), pending: new Map(), jobs: [], running: false, writing: Promise.resolve() };
      try {
        const file = await open(path, 'r');
        let root;
        try { if ((await file.stat()).size > 32 * 1024 * 1024) return state; root = JSON.parse(await file.readFile('utf8')); } finally { await file.close(); }
        if (root.schemaVersion === 1 && root.entries && typeof root.entries === 'object') for (const [key, entry] of Object.entries(root.entries)) if (/^[a-f0-9]{64}$/.test(key) && valid(entry)) state.entries.set(key, entry);
      } catch { /* An absent/unreadable technical projection never changes operations.json. */ }
      return state;
    })();
    states.set(path, pending);
  }
  return pending;
}

async function persist(path: string, state: State) {
  const writing = state.writing.catch(() => undefined).then(async () => {
    const temporary = `${path}.${randomUUID()}.tmp`;
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    try {
      const file = await open(temporary, 'wx', 0o600);
      try { await file.writeFile(JSON.stringify({ schemaVersion: 1, entries: Object.fromEntries(state.entries) })); await file.sync(); } finally { await file.close(); }
      await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => undefined); }
  });
  state.writing = writing;
  await writing;
}

/** Durable address results, separate from business records and the provider's transport cache.
 * OSM-derived successful locations are retained; changed addresses have different identities.
 * No timer scans all records. Saved addresses and bounded active-list backfills request work.
 */
export function createTripRequestLocations(options: { path: string; namespace: string; successTtlMs: number | null; geocode: (address: string, retryUnavailable?: boolean) => Promise<Location>; peek?: (address: string) => Promise<Location | null>; now?: () => number }) {
  const path = resolve(options.path), now = options.now ?? Date.now;
  const keyFor = (address: string) => createHash('sha256').update(JSON.stringify([options.namespace, normalize(address)])).digest('hex');
  const known = (state: State, key: string) => {
    const entry = state.entries.get(key);
    return entry && (entry.retryAfter === null || entry.retryAfter > now()) ? structuredClone(entry.location) : null;
  };
  const remember = async (state: State, key: string, address: string, location: Location) => {
    if (location.status === 'pending') return;
    const entry: Entry = { provider: options.namespace, address: normalize(address), resolvedAt: new Date(now()).toISOString(), retryAfter: location.status === 'found' ? options.successTtlMs === null ? null : now() + options.successTtlMs : now() + (location.status === 'unavailable' ? 60_000 : 86400_000), location };
    if (!valid(entry)) return;
    state.entries.set(key, entry);
    // Successful delivery points are durable. Expired negative observations can be discarded.
    for (const [storedKey, row] of state.entries) if (storedKey !== key && row.retryAfter !== null && row.retryAfter <= now()) state.entries.delete(storedKey);
    try { await persist(path, state); } catch { /* Safe process-local fallback; never report a business save failure. */ }
  };
  const read = async (address: string): Promise<Location> => {
    const state = await stateFor(path), key = keyFor(address), saved = known(state, key);
    if (saved) return saved;
    // Reuse already persisted results from the previous release without contacting a provider.
    const cached = await options.peek?.(address);
    if (cached?.status === 'found') { await remember(state, key, address, cached); return structuredClone(cached); }
    return waiting();
  };
  const pump = (state: State) => {
    if (state.running) return;
    state.running = true;
    void (async () => {
      try {
        while (state.jobs.length) {
          const interactive = state.jobs.findIndex(job => job.priority === 'interactive');
          const job = state.jobs.splice(interactive < 0 ? 0 : interactive, 1)[0];
          await job.run();
        }
      } finally { state.running = false; }
    })();
  };
  const lookup = async (address: string, priority: 'interactive' | 'background' = 'interactive', retryUnavailable = false): Promise<Location> => {
    const saved = await read(address);
    if (saved.status !== 'pending') return saved;
    const state = await stateFor(path), key = keyFor(address), existing = state.pending.get(key);
    if (existing) {
      if (priority === 'interactive') {
        const queued = state.jobs.find(job => job.key === key);
        if (queued) queued.priority = 'interactive';
      }
      return structuredClone(await existing);
    }
    if (state.pending.size >= (priority === 'interactive' ? 512 : 500)) return unavailable();
    let complete!: (result: Location) => void;
    const promise = new Promise<Location>(resolve => { complete = resolve; });
    state.pending.set(key, promise);
    state.jobs.push({ key, priority, run: async () => {
      try {
        const current = known(state, key);
        if (current) { complete(current); return; }
        let location: Location;
        try { location = await options.geocode(address, retryUnavailable); } catch { location = unavailable(); }
        await remember(state, key, address, location);
        complete(location);
      } catch { complete(unavailable()); }
      finally { state.pending.delete(key); }
    } });
    pump(state);
    return structuredClone(await promise);
  };
  const poll = async (address: string, waitMs = 5000, retryUnavailable = false): Promise<Location> => {
    if (retryUnavailable) {
      const state = await stateFor(path), key = keyFor(address);
      if (state.entries.get(key)?.location.status === 'unavailable') state.entries.delete(key);
    }
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([lookup(address, 'interactive', retryUnavailable), new Promise<Location>(resolve => { timeout = setTimeout(() => resolve(waiting()), waitMs); })]);
    } finally { if (timeout) clearTimeout(timeout); }
  };
  return { read, resolve: lookup, poll };
}

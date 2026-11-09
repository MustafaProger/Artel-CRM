import { createHash } from 'node:crypto';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { LegacyOperationsStore, StoreError, encodeOperations, validate, type OperationsData } from './operations-store';
import { WorkPartition, isWorkPartition, atomicFile, partitionLock, type Update } from './work-partition';
import { validateWorkData } from './work-operations';

const format = 'artel-auth-partition-v1';
const json = JSON.stringify;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const maxBytes = 64 * 1024 * 1024;
type AuthState = Pick<OperationsData, 'schemaVersion' | 'sourceSha256' | 'revision' | 'accounts' | 'directories' | 'push'>;
type WorkState = Pick<OperationsData, 'sourceSha256' | 'revision' | 'work'>;
const seal = (value: unknown) => { const raw = json(value); return `{"sha256":"${hash(raw)}","data":${raw}}`; };
function unseal(raw: string): unknown {
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.sha256 !== hash(json(value.data))) throw new StoreError('Auth partition checksum mismatch');
  return value.data;
}
async function boundedRead(path: string, maximum = maxBytes) {
  const file = await open(path, 'r');
  try { if ((await file.stat()).size > maximum) throw new StoreError('Auth partition too large'); return await file.readFile(); }
  finally { await file.close(); }
}
function identity(value: unknown, source: string): asserts value is Record<string, unknown> & { sourceSha256: string; revision: number } {
  if (!object(value) || value.sourceSha256 !== source || !Number.isSafeInteger(value.revision) || Number(value.revision) < 0) throw new StoreError('Invalid auth partition identity');
}
function authView(auth: AuthState): OperationsData {
  return { ...auth, shipments: {}, companies: [], paymentAllocations: [] };
}
function checkAuth(value: unknown, source: string): asserts value is AuthState {
  identity(value, source);
  if (Object.keys(value).some(key => !['schemaVersion','sourceSha256','revision','accounts','directories','push'].includes(key))) throw new StoreError('Unknown auth partition field');
  validate(authView(value as unknown as AuthState), source);
}
function checkWork(value: unknown, source: string): asserts value is WorkState {
  identity(value, source);
  if (Object.keys(value).some(key => !['sourceSha256','revision','work'].includes(key))) throw new StoreError('Unknown Work partition field');
  validateWorkData(value.work);
}
function extractAuth(data: OperationsData, revision: number): AuthState {
  return { schemaVersion: data.schemaVersion, sourceSha256: data.sourceSha256, revision,
    ...(data.accounts === undefined ? {} : { accounts: data.accounts }),
    ...(data.directories === undefined ? {} : { directories: data.directories }),
    ...(data.push === undefined ? {} : { push: data.push }) };
}
function extractWork(data: OperationsData, revision: number): WorkState {
  return { sourceSha256: data.sourceSha256, revision, ...(data.work === undefined ? {} : { work: data.work }) };
}
function workAuthority(auth: AuthState) {
  const push = auth.push && { ...auth.push };
  if (push) delete push.taskAssignments;
  const emptyPush = push && Object.keys(push).length === 2 && push.devices.length === 0 && Object.keys(push.deliveries).length === 0;
  return json({ ...auth, push: emptyPush ? undefined : push });
}
function extractCore(data: OperationsData, revision: number): OperationsData {
  const core = { ...data, revision };
  delete core.accounts; delete core.directories; delete core.push; delete core.work;
  return core;
}
function compose(core: OperationsData, auth: AuthState, work: WorkState): OperationsData {
  if (core.schemaVersion !== auth.schemaVersion || ['accounts','directories','push','work'].some(key => key in core)) throw new StoreError('Duplicate auth partition domain');
  return { ...core, ...auth, ...work, revision: core.revision + auth.revision + work.revision };
}
/** Exact bytes are checked on EVERY read; no timestamps, shared mutable graphs,
 * or rights cache. As in the legacy store, only validation is reused. */
class PartReader {
  private cache?: { bytes: Buffer; raw: string };
  remember(raw: string) { this.cache = { bytes: Buffer.from(raw), raw }; }
  async read(path: string) {
    const bytes = await boundedRead(path);
    if (this.cache?.bytes.equals(bytes)) return { value: (JSON.parse(this.cache.raw) as {data: unknown}).data, raw: this.cache.raw };
    const raw = bytes.toString('utf8');
    const value = unseal(raw);
    this.cache = { bytes, raw };
    return { value, raw };
  }
}
export async function isAuthPartition(path: string, source: string) {
  let file;
  try { file = await open(path, 'r'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new StoreError('Cannot inspect operations store'); }
  try {
    const buffer = Buffer.alloc(512), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, bytesRead).toString('utf8');
    if (!raw.startsWith('{"format":"artel-auth-partition')) return false;
    const pointer: unknown = JSON.parse(raw);
    if (!object(pointer) || pointer.format !== format || pointer.sourceSha256 !== source || pointer.partition !== 'auth-storage' || (await file.stat()).size !== bytesRead) throw new StoreError('Invalid auth storage pointer');
    return true;
  } finally { await file.close(); }
}

/** The same latch covers all domains and redo recovery. Interactive auth skips
 * the large core read/write, but does not bypass an in-flight business commit. */
export class AuthPartition {
  readonly directory: string;
  readonly corePath: string;
  readonly authPath: string;
  readonly workPath: string;
  readonly journalPath: string;
  readonly latch: string;
  private readers = { core: new PartReader(), auth: new PartReader(), work: new PartReader() };
  private validated?: { core: string; auth: string; work: string };
  constructor(readonly rootPath: string) {
    this.directory = resolve(dirname(rootPath), 'auth-storage');
    this.corePath = resolve(this.directory, 'core.json'); this.authPath = resolve(this.directory, 'auth.json'); this.workPath = resolve(this.directory, 'work.json');
    this.journalPath = resolve(this.directory, 'commit.json'); this.latch = resolve(this.directory, 'transaction.lock');
  }
  private async recover(source: string) {
    let bytes;
    try { bytes = await boundedRead(this.journalPath, 256 * 1024 * 1024); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const journal = unseal(bytes.toString('utf8'));
    if (!object(journal) || journal.sourceSha256 !== source || typeof journal.core !== 'string' || typeof journal.auth !== 'string' || typeof journal.work !== 'string') throw new StoreError('Invalid auth redo journal');
    const core = unseal(journal.core), auth = unseal(journal.auth), work = unseal(journal.work);
    identity(core, source); checkAuth(auth, source); checkWork(work, source);
    validate(compose(core as unknown as OperationsData, auth, work), source);
    await atomicFile(this.corePath, journal.core); await atomicFile(this.authPath, journal.auth); await atomicFile(this.workPath, journal.work);
    await unlink(this.journalPath);
    const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    this.readers.core.remember(journal.core); this.readers.auth.remember(journal.auth); this.readers.work.remember(journal.work);
    this.validated = { core: journal.core, auth: journal.auth, work: journal.work };
  }
  private async auth(source: string) {
    const row = await this.readers.auth.read(this.authPath); checkAuth(row.value, source);
    return { value: row.value, raw: row.raw };
  }
  private async load(source: string) {
    await this.recover(source);
    const c = await this.readers.core.read(this.corePath), a = await this.auth(source), w = await this.readers.work.read(this.workPath);
    identity(c.value, source); checkWork(w.value, source);
    const core = c.value as unknown as OperationsData, auth = a.value, work = w.value;
    const data = compose(core, auth, work);
    const raw = { core: c.raw, auth: a.raw, work: w.raw };
    if (this.validated?.core !== c.raw || this.validated?.auth !== a.raw || this.validated?.work !== w.raw) { validate(data, source); this.validated = raw; }
    return { core, auth, work, data, raw: { core: c.raw, auth: a.raw, work: w.raw } };
  }
  read(source: string) { return partitionLock(this.latch, async () => (await this.load(source)).data); }
  readAuth(source: string) { return partitionLock(this.latch, async () => { await this.recover(source); return authView((await this.auth(source)).value); }); }
  private async bound(raw: {core: string; auth: string; work: string}) {
    if (Buffer.byteLength(raw.core) + Buffer.byteLength(raw.auth) + Buffer.byteLength(raw.work) + 4096 > maxBytes) throw new StoreError('Combined storage is too large for a safe flat backup');
  }
  mutateAuth<T>(source: string, update: Update<T>): Promise<T> {
    return partitionLock(resolve(this.directory, 'interactive-queue.lock'), () => partitionLock(this.latch, async () => {
      await this.recover(source);
      const before = await this.auth(source), data = authView(before.value);
      const guard = json({ ...data, accounts: undefined, push: undefined });
      const assignments = json(data.push?.taskAssignments);
      const { result, changed } = await update(data);
      if (!changed) return result;
      if (json({ ...data, accounts: undefined, push: undefined }) !== guard || json(data.push?.taskAssignments) !== assignments) throw new StoreError('Auth transaction tried to change another domain');
      const auth = extractAuth(data, before.value.revision + 1); checkAuth(auth, source);
      const raw = seal(auth);
      const [core, work] = await Promise.all([stat(this.corePath), stat(this.workPath)]);
      if (!core.isFile() || !work.isFile()) throw new StoreError('Missing business partition');
      if (core.size + work.size + Buffer.byteLength(raw) + 4096 > maxBytes) throw new StoreError('Combined storage is too large for a safe flat backup');
      await atomicFile(this.authPath, raw);
      this.readers.auth.remember(raw);
      // All changed auth domains were validated above, and business/Work data
      // were inaccessible to this callback. Future full reads still compare
      // exact core/Work bytes before reusing their previous validation.
      if (this.validated?.auth === before.raw) this.validated = { ...this.validated, auth: raw };
      return result;
    }));
  }
  mutate<T>(source: string, update: Update<T>, workOnly = false, interactive = false): Promise<T> {
    return partitionLock(resolve(this.directory, workOnly ? 'work-queue.lock' : interactive ? 'interactive-queue.lock' : 'core-queue.lock'), () => partitionLock(this.latch, async () => {
      const before = await this.load(source), { data } = before;
      const authGuard = workAuthority(before.auth);
      const { result, changed } = await update(data);
      if (!changed) return result;
      validate(data, source);
      const core = extractCore(data, before.core.revision), auth = extractAuth(data, before.auth.revision), work = extractWork(data, before.work.revision);
      const next = { core: seal(core), auth: seal(auth), work: seal(work) };
      const coreChanged = next.core !== before.raw.core || !workOnly && next.auth === before.raw.auth && next.work === before.raw.work, authChanged = next.auth !== before.raw.auth, workChanged = next.work !== before.raw.work;
      if (workOnly && (coreChanged || workAuthority(auth) !== authGuard)) throw new StoreError('Work transaction tried to change another domain');
      if (coreChanged) { core.revision++; next.core = seal(core); }
      if (authChanged) { auth.revision++; next.auth = seal(auth); }
      if (workChanged) { work.revision++; next.work = seal(work); }
      await this.bound(next);
      const changedCount = Number(coreChanged) + Number(authChanged) + Number(workChanged);
      if (changedCount > 1) { await atomicFile(this.journalPath, seal({ sourceSha256: source, ...next })); await this.recover(source); }
      else if (coreChanged) await atomicFile(this.corePath, next.core);
      else if (authChanged) await atomicFile(this.authPath, next.auth);
      else if (workChanged) await atomicFile(this.workPath, next.work);
      this.readers.core.remember(next.core); this.readers.auth.remember(next.auth); this.readers.work.remember(next.work);
      this.validated = next;
      return result;
    }));
  }
}

/** Explicit offline migration only. Pointer installation is last; old binaries
 * fail closed. The old directory remains as evidence, never as a rollback DB. */
export async function migrateAuthStorage(directory: string, source: string) {
  const legacy = new LegacyOperationsStore(directory);
  if (await isAuthPartition(legacy.path, source)) { await new AuthPartition(legacy.path).read(source); return { changed: false, mode: 'auth-partitioned' }; }
  return partitionLock(`${legacy.path}.lock`, async () => {
    if (!(await stat(legacy.path)).isFile()) throw new StoreError('Missing source store');
    const data = await isWorkPartition(legacy.path, source) ? await new WorkPartition(legacy.path).read(source) : await legacy.read(source);
    const partition = new AuthPartition(legacy.path);
    await mkdir(partition.directory, { mode: 0o700 });
    const backup = await legacy.backup(data);
    await atomicFile(partition.corePath, seal(extractCore(data, data.revision)));
    await atomicFile(partition.authPath, seal(extractAuth(data, 0)));
    await atomicFile(partition.workPath, seal(extractWork(data, 0)));
    const assembled = await partition.read(source);
    // Key order is intentionally irrelevant; exact domain values must survive.
    for (const key of new Set([...Object.keys(data), ...Object.keys(assembled)])) if (json(data[key as keyof OperationsData]) !== json(assembled[key as keyof OperationsData])) throw new StoreError('Auth migration verification failed');
    if (Buffer.byteLength(encodeOperations(assembled, source)) > maxBytes - 4096) throw new StoreError('Insufficient flat backup headroom');
    await atomicFile(legacy.path, json({ format, sourceSha256: source, partition: 'auth-storage' }));
    return { changed: true, mode: 'auth-partitioned', backup };
  });
}
export async function mergeAuthStorage(directory: string, source: string) {
  const legacy = new LegacyOperationsStore(directory);
  if (!await isAuthPartition(legacy.path, source)) return { changed: false, mode: 'not-auth-partitioned' };
  return partitionLock(`${legacy.path}.lock`, async () => {
    const data = await new AuthPartition(legacy.path).read(source), backup = await legacy.backup(data);
    await atomicFile(legacy.path, encodeOperations(data, source));
    return { changed: true, mode: 'legacy', backup };
  });
}

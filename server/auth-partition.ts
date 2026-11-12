import { JsonSnapshot } from './json-snapshot';
import { performanceSpan } from './performance-trace';
import { createHash } from 'node:crypto';
import { mkdir, open, stat, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { LegacyOperationsStore, StoreError, encodeOperations, validate, type OperationsData } from './operations-store';
import { WorkPartition, isWorkPartition, atomicFile, partitionLock, type Update } from './work-partition';
import { validateWorkData } from './work-operations';

const format = 'artel-auth-partition-v1';
const archiveFormat = 'artel-auth-partition-v2';
type Part = 'core' | 'auth' | 'work' | 'archive';
type RawParts = { core: string; auth: string; work: string; archive?: string };
const json = JSON.stringify;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
// 64 MiB of binary documents use about 86 MiB after base64 encoding.
// Keep room for the other partitions and a complete flat backup.
const maxBytes = 128 * 1024 * 1024;
type AuthState = Pick<OperationsData, 'schemaVersion' | 'sourceSha256' | 'revision' | 'accounts' | 'directories' | 'push'>;
type WorkState = Pick<OperationsData, 'sourceSha256' | 'revision' | 'work'>;
type ArchiveState = Pick<OperationsData, 'sourceSha256' | 'revision' | 'documentArchive'>;
const seal = (value: unknown) => performanceSpan('partition.seal', () => { const raw = json(value); return `{"sha256":"${hash(raw)}","data":${raw}}`; });
function unsealVerified(raw: string) {
  const envelope: unknown = JSON.parse(raw);
  if (!object(envelope)) throw new StoreError('Auth partition checksum mismatch');
  const data = json(envelope.data), digest = hash(data);
  if (envelope.sha256 !== digest) throw new StoreError('Auth partition checksum mismatch');
  return { value: envelope.data, canonicalRaw: `{"sha256":"${digest}","data":${data}}` };
}
function unseal(raw: string): unknown { return unsealVerified(raw).value; }
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
  if (push) {
    delete push.taskAssignments;
    delete push.taskCompletions;
  }
  const emptyPush = push && Object.keys(push).length === 2 && push.devices.length === 0 && Object.keys(push.deliveries).length === 0;
  return json({ ...auth, push: emptyPush ? undefined : push });
}
function extractArchive(data: OperationsData, revision: number): ArchiveState {
  return { sourceSha256: data.sourceSha256, revision, ...(data.documentArchive === undefined ? {} : { documentArchive: data.documentArchive }) };
}
function checkArchive(value: unknown, source: string): asserts value is ArchiveState {
  identity(value, source);
  if (Object.keys(value).some(key => !['sourceSha256', 'revision', 'documentArchive'].includes(key))) throw new StoreError('Unknown archive partition field');
}
function extractCore(data: OperationsData, revision: number, archive = false): OperationsData {
  const core = { ...data, revision };
  delete core.accounts; delete core.directories; delete core.push; delete core.work;
  if (archive) delete core.documentArchive;
  return core;
}
function compose(core: OperationsData, auth: AuthState, work: WorkState, archive?: ArchiveState): OperationsData {
  if (core.schemaVersion !== auth.schemaVersion || ['accounts','directories','push','work'].some(key => key in core)) throw new StoreError('Duplicate auth partition domain');
  if (archive && 'documentArchive' in core) throw new StoreError('Duplicate archive partition domain');
  return { ...core, ...auth, ...work, ...archive, revision: core.revision + auth.revision + work.revision + (archive?.revision ?? 0) };
}
/** Exact bytes are checked on EVERY read. The private canonical snapshot never
 * escapes: readers receive fresh mutable nodes and reuse only immutable strings. */
class PartReader {
  private cache?: { bytes: Buffer; raw: string; snapshot: JsonSnapshot };
  remember(raw: string, snapshot?: JsonSnapshot) {
    if (this.cache?.raw === raw) return;
    this.cache = { bytes: Buffer.from(raw), raw, snapshot: snapshot ?? new JsonSnapshot((JSON.parse(raw) as { data: unknown }).data) };
  }
  matches(value: unknown) { return !!this.cache && this.cache.raw === this.cache.snapshot.raw && this.cache.snapshot.matches(value); }
  encode(value: unknown) { return new JsonSnapshot(value, this.cache?.snapshot); }
  byteLength(raw: string) { return this.cache?.raw === raw ? this.cache.bytes.length : Buffer.byteLength(raw); }
  async read(path: string) {
    const bytes = await performanceSpan('partition.read-bytes', () => boundedRead(path));
    if (this.cache?.bytes.equals(bytes)) return { value: performanceSpan('partition.clone-cached', () => this.cache!.snapshot.clone()), raw: this.cache.raw };
    const raw = bytes.toString('utf8');
    const verified = performanceSpan('partition.unseal', () => unsealVerified(raw));
    const snapshot = JsonSnapshot.fromVerified(verified.value, verified.canonicalRaw);
    this.cache = { bytes, raw, snapshot };
    return { value: snapshot.clone(), raw };
  }
}
export async function authPartitionVersion(path: string, source: string): Promise<1 | 2 | null> {
  let file;
  try { file = await open(path, 'r'); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw new StoreError('Cannot inspect operations store'); }
  try {
    const buffer = Buffer.alloc(512), { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const raw = buffer.subarray(0, bytesRead).toString('utf8');
    if (!raw.startsWith('{"format":"artel-auth-partition')) return null;
    const pointer: unknown = JSON.parse(raw);
    if (!object(pointer) || ![format, archiveFormat].includes(String(pointer.format)) || pointer.sourceSha256 !== source || pointer.partition !== (pointer.format === format ? 'auth-storage' : 'auth-storage-v2') || (await file.stat()).size !== bytesRead) throw new StoreError('Invalid auth storage pointer');
    return pointer.format === format ? 1 : 2;
  } finally { await file.close(); }
}

export async function isAuthPartition(path: string, source: string) { return (await authPartitionVersion(path, source)) !== null; }

/** The same latch covers all domains and redo recovery. Interactive auth skips
 * the large core read/write, but does not bypass an in-flight business commit. */
export class AuthPartition {
  readonly directory: string;
  readonly corePath: string;
  readonly authPath: string;
  readonly workPath: string;
  readonly journalPath: string;
  readonly archivePath: string;
  readonly latch: string;
  private readers = { core: new PartReader(), auth: new PartReader(), work: new PartReader(), archive: new PartReader() };
  private validated?: RawParts;
  constructor(readonly rootPath: string, readonly version: 1 | 2 = 1) {
    this.directory = resolve(dirname(rootPath), version === 1 ? 'auth-storage' : 'auth-storage-v2');
    this.corePath = resolve(this.directory, 'core.json'); this.authPath = resolve(this.directory, 'auth.json'); this.workPath = resolve(this.directory, 'work.json');
    this.archivePath = resolve(this.directory, 'archive.json');
    this.journalPath = resolve(this.directory, 'commit.json'); this.latch = resolve(this.directory, 'transaction.lock');
  }
  private partPath(part: Part) { return part === 'core' ? this.corePath : part === 'auth' ? this.authPath : part === 'work' ? this.workPath : this.archivePath; }
  private async recoverV2(journal: unknown, source: string) {
    if (!object(journal) || journal.format !== 'artel-auth-redo-v2' || journal.sourceSha256 !== source || !object(journal.parts) || Object.keys(journal).some(key => !['format','sourceSha256','parts'].includes(key))) throw new StoreError('Invalid archive redo journal');
    const changed = Object.keys(journal.parts);
    if (changed.length < 2 || changed.some(key => !['core','auth','work','archive'].includes(key) || typeof (journal.parts as Record<string, unknown>)[key] !== 'string')) throw new StoreError('Invalid archive redo parts');
    const raw = {} as RawParts;
    const values: Partial<Record<Part, unknown>> = {};
    for (const part of ['core','auth','work','archive'] as const) {
      const pending = journal.parts[part];
      if (typeof pending === 'string') { raw[part] = pending; values[part] = unseal(pending); }
      else { const current = await this.readers[part].read(this.partPath(part)); raw[part] = current.raw; values[part] = current.value; }
    }
    identity(values.core, source); checkAuth(values.auth, source); checkWork(values.work, source); checkArchive(values.archive, source);
    validate(compose(values.core as unknown as OperationsData, values.auth, values.work, values.archive), source);
    await this.bound(raw);
    for (const part of changed as Part[]) await atomicFile(this.partPath(part), raw[part]!);
    await unlink(this.journalPath);
    const directory = await open(this.directory, 'r'); try { await directory.sync(); } finally { await directory.close(); }
    for (const part of changed as Part[]) this.readers[part].remember(raw[part]!);
    this.validated = raw;
  }
  private async recover(source: string) {
    let bytes;
    try { bytes = await boundedRead(this.journalPath, 256 * 1024 * 1024); } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
    const journal = unseal(bytes.toString('utf8'));
    if (this.version === 2) return this.recoverV2(journal, source);
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
    const row = await this.readers.auth.read(this.authPath);
    const value = performanceSpan('partition.validate-auth', () => { checkAuth(row.value, source); return row.value; });
    return { value, raw: row.raw };
  }
  private async load(source: string) {
    await performanceSpan('partition.recover', () => this.recover(source));
    const c = await performanceSpan('partition.read-core', () => this.readers.core.read(this.corePath)), a = await performanceSpan('partition.read-auth', () => this.auth(source)), w = await performanceSpan('partition.read-work', () => this.readers.work.read(this.workPath));
    identity(c.value, source); checkWork(w.value, source);
    const core = c.value as unknown as OperationsData, auth = a.value, work = w.value;
    const archiveRow = this.version === 2 ? await performanceSpan('partition.read-archive', () => this.readers.archive.read(this.archivePath)) : undefined;
    if (archiveRow) checkArchive(archiveRow.value, source);
    const archive = archiveRow?.value as ArchiveState | undefined;
    const data = compose(core, auth, work, archive);
    const raw: RawParts = { core: c.raw, auth: a.raw, work: w.raw, ...(archiveRow ? { archive: archiveRow.raw } : {}) };
    if (this.validated?.core !== c.raw || this.validated?.auth !== a.raw || this.validated?.work !== w.raw || this.validated?.archive !== archiveRow?.raw) { performanceSpan('partition.validate-full', () => validate(data, source)); this.validated = raw; }
    return { core, auth, work, archive, data, raw };
  }
  read(source: string) { return partitionLock(this.latch, async () => (await this.load(source)).data); }
  readAuth(source: string) { return partitionLock(this.latch, async () => { await performanceSpan('partition.recover', () => this.recover(source)); return authView((await this.auth(source)).value); }, 'interactive'); }
  private async bound(raw: RawParts) {
    if (Object.entries(raw).reduce((size, [part, value]) => size + this.readers[part as Part].byteLength(value), 0) + 4096 > maxBytes) throw new StoreError('Combined storage is too large for a safe flat backup');
  }
  mutateAuth<T>(source: string, update: Update<T>): Promise<T> {
    return partitionLock(resolve(this.directory, 'interactive-queue.lock'), () => partitionLock(this.latch, async () => {
      await performanceSpan('partition.recover', () => this.recover(source));
      const before = await this.auth(source), data = authView(before.value);
      const guard = json({ ...data, accounts: undefined, push: undefined });
      const taskNotifications = () => json([data.push?.taskAssignments, data.push?.taskCompletions]);
      const outbox = taskNotifications();
      const { result, changed } = await performanceSpan('partition.update', () => update(data));
      if (!changed) return result;
      if (json({ ...data, accounts: undefined, push: undefined }) !== guard || taskNotifications() !== outbox) throw new StoreError('Auth transaction tried to change another domain');
      const auth = extractAuth(data, before.value.revision + 1); checkAuth(auth, source);
      const raw = seal(auth);
      const business = await Promise.all([this.corePath, this.workPath, ...(this.version === 2 ? [this.archivePath] : [])].map(path => stat(path)));
      if (business.some(part => !part.isFile())) throw new StoreError('Missing business partition');
      if (business.reduce((size, part) => size + part.size, 0) + Buffer.byteLength(raw) + 4096 > maxBytes) throw new StoreError('Combined storage is too large for a safe flat backup');
      await atomicFile(this.authPath, raw);
      this.readers.auth.remember(raw);
      // All changed auth domains were validated above, and business/Work data
      // were inaccessible to this callback. Future full reads still compare
      // exact core/Work bytes before reusing their previous validation.
      if (this.validated?.auth === before.raw) this.validated = { ...this.validated, auth: raw };
      return result;
    }, 'interactive'));
  }
  mutate<T>(source: string, update: Update<T>, workOnly = false, interactive = false): Promise<T> {
    return partitionLock(resolve(this.directory, workOnly ? 'work-queue.lock' : interactive ? 'interactive-queue.lock' : 'core-queue.lock'), () => partitionLock(this.latch, async () => {
      const before = await performanceSpan('partition.load-full', () => this.load(source)), { data } = before;
      const authGuard = workAuthority(before.auth);
      const { result, changed } = await performanceSpan('partition.update', () => update(data));
      if (!changed) return result;
      performanceSpan('partition.validate-full', () => validate(data, source));
      const core = extractCore(data, before.core.revision, this.version === 2), auth = extractAuth(data, before.auth.revision), work = extractWork(data, before.work.revision);
      const archive = this.version === 2 ? extractArchive(data, before.archive!.revision) : undefined;
      const archiveChanged = !!archive && !performanceSpan('partition.matches-archive', () => this.readers.archive.matches(archive));
      const authChanged = !performanceSpan('partition.matches-auth', () => this.readers.auth.matches(auth)), workChanged = !performanceSpan('partition.matches-work', () => this.readers.work.matches(work));
      const coreChanged = !performanceSpan('partition.matches-core', () => this.readers.core.matches(core)) || !workOnly && !authChanged && !workChanged && !archiveChanged;
      if (workOnly && (coreChanged || archiveChanged || workAuthority(auth) !== authGuard)) throw new StoreError('Work transaction tried to change another domain');
      if (coreChanged) core.revision++;
      if (authChanged) auth.revision++;
      if (workChanged) work.revision++;
      if (archiveChanged) archive!.revision++;
      const encoded = {
        core: coreChanged ? performanceSpan('partition.seal-core', () => this.readers.core.encode(core)) : undefined,
        auth: authChanged ? performanceSpan('partition.seal-auth', () => this.readers.auth.encode(auth)) : undefined,
        work: workChanged ? performanceSpan('partition.seal-work', () => this.readers.work.encode(work)) : undefined,
        archive: archiveChanged ? performanceSpan('partition.seal-archive', () => this.readers.archive.encode(archive)) : undefined,
      };
      const next: RawParts = { core: encoded.core?.raw ?? before.raw.core, auth: encoded.auth?.raw ?? before.raw.auth, work: encoded.work?.raw ?? before.raw.work, ...(this.version === 2 ? { archive: encoded.archive?.raw ?? before.raw.archive! } : {}) };
      await this.bound(next);
      const changedCount = Number(coreChanged) + Number(authChanged) + Number(workChanged) + Number(archiveChanged);
      if (changedCount > 1) {
        const journal = this.version === 1 ? { sourceSha256: source, ...next } : { format: 'artel-auth-redo-v2', sourceSha256: source, parts: Object.fromEntries(Object.entries(encoded).filter(([, value]) => value !== undefined).map(([part, value]) => [part, value!.raw])) };
        await atomicFile(this.journalPath, seal(journal)); await performanceSpan('partition.recover', () => this.recover(source)); }
      else if (coreChanged) await atomicFile(this.corePath, next.core);
      else if (authChanged) await atomicFile(this.authPath, next.auth);
      else if (workChanged) await atomicFile(this.workPath, next.work);
      else if (archiveChanged) await atomicFile(this.archivePath, next.archive!);
      this.readers.core.remember(next.core, encoded.core); this.readers.auth.remember(next.auth, encoded.auth); this.readers.work.remember(next.work, encoded.work);
      if (next.archive) this.readers.archive.remember(next.archive, encoded.archive);
      this.validated = next;
      return result;
    }));
  }
}

/** Explicit offline migration only. Pointer installation is last; old binaries
 * fail closed. The old directory remains as evidence, never as a rollback DB. */
export async function migrateAuthStorage(directory: string, source: string) {
  const legacy = new LegacyOperationsStore(directory);
  const version = await authPartitionVersion(legacy.path, source);
  if (version) { await new AuthPartition(legacy.path, version).read(source); return { changed: false, mode: 'auth-partitioned' }; }
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
  const version = await authPartitionVersion(legacy.path, source);
  if (!version) return { changed: false, mode: 'not-auth-partitioned' };
  return partitionLock(`${legacy.path}.lock`, async () => {
    const data = await new AuthPartition(legacy.path, version).read(source), backup = await legacy.backup(data);
    await atomicFile(legacy.path, encodeOperations(data, source));
    return { changed: true, mode: 'legacy', backup };
  });
}

/** OFFLINE ONLY: install archive-separated parts, verify the complete logical
 * current state, then atomically publish the v2 pointer. Never restore old data. */
export async function migrateArchiveStorage(directory: string, source: string) {
  const legacy = new LegacyOperationsStore(directory);
  return partitionLock(`${legacy.path}.lock`, async () => {
    const version = await authPartitionVersion(legacy.path, source);
    if (version === 2) { await new AuthPartition(legacy.path, 2).read(source); return { changed: false, mode: 'auth-archive-partitioned' }; }
    if (version !== 1) throw new StoreError('Archive split requires current auth-partition-v1 storage');
    const data = await new AuthPartition(legacy.path, 1).read(source);
    const backup = await legacy.backup(data), partition = new AuthPartition(legacy.path, 2);
    await mkdir(partition.directory, { mode: 0o700 });
    await atomicFile(partition.corePath, seal(extractCore(data, data.revision, true)));
    await atomicFile(partition.authPath, seal(extractAuth(data, 0)));
    await atomicFile(partition.workPath, seal(extractWork(data, 0)));
    await atomicFile(partition.archivePath, seal(extractArchive(data, 0)));
    const assembled = await partition.read(source);
    for (const key of new Set([...Object.keys(data), ...Object.keys(assembled)])) if (json(data[key as keyof OperationsData]) !== json(assembled[key as keyof OperationsData])) throw new StoreError('Archive migration verification failed');
    if (Buffer.byteLength(encodeOperations(assembled, source)) > maxBytes - 4096) throw new StoreError('Insufficient flat backup headroom');
    await atomicFile(legacy.path, json({ format: archiveFormat, sourceSha256: source, partition: 'auth-storage-v2' }));
    return { changed: true, mode: 'auth-archive-partitioned', backup };
  });
}

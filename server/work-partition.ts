import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink, stat } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { LegacyOperationsStore, StoreError, decodeOperations, encodeOperations, type OperationsData } from './operations-store';
import { validateWorkData } from './work-operations';
import { validatePush, type PushData } from './push';

const format = 'artel-work-partition-v1';
const queues = new Map<string, Promise<unknown>>();
const hash = (s: string) => createHash('sha256').update(s).digest('hex');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const json = (v: unknown) => JSON.stringify(v);
export type Update<T> = (data: OperationsData) => { result: T; changed: boolean } | Promise<{ result: T; changed: boolean }>;
interface WorkState { format: typeof format; sourceSha256: string; revision: number; work?: OperationsData['work']; taskAssignments?: PushData['taskAssignments']; pushPresent?: true }

/** Separate FIFO admission queues, with one consistency latch for reads/commits.
 * Lock files are deliberately not stolen after a timeout. Recovery after SIGKILL
 * requires stopped writers and explicit operator removal of abandoned locks. */
export async function partitionLock<T>(path: string, action: () => Promise<T>): Promise<T> {
  const previous = queues.get(path) ?? Promise.resolve();
  const pending = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let file;
    for (let n = 0; n < 500; n++) {
      try { file = await open(path, 'wx', 0o600); break; }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; await new Promise(r => setTimeout(r, 10)); }
    }
    if (!file) throw new StoreError('Work storage busy; check stopped-writer recovery');
    try { await file.writeFile(json({ pid: process.pid })); return await action(); }
    finally { await file.close(); await unlink(path); }
  });
  queues.set(path, pending);
  try { return await pending; } finally { if (queues.get(path) === pending) queues.delete(path); }
}
export async function atomicFile(path: string, bytes: string) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    await rename(temporary, path); await syncDirectory(dirname(path));
  }
  finally { await unlink(temporary).catch(e => { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }); }
}
async function syncDirectory(path: string) { const d = await open(path, 'r'); try { await d.sync(); } finally { await d.close(); } }
function envelope(data: unknown) { const raw = json(data); return json({ sha256: hash(raw), data }); }
function encodeWork(data: WorkState) { const raw = envelope(data); if (Buffer.byteLength(raw) > 64 * 1024 * 1024) throw new StoreError('Work storage too large'); return raw; }
function unseal(raw: string): unknown {
  const e: unknown = JSON.parse(raw);
  if (!object(e) || e.sha256 !== hash(json(e.data))) throw new StoreError('Work storage checksum mismatch');
  return e.data;
}
async function boundedRead(path: string, limit = 64 * 1024 * 1024) {
  const file = await open(path, 'r');
  try { if ((await file.stat()).size > limit) throw new StoreError('Work storage too large'); return await file.readFile('utf8'); }
  finally { await file.close(); }
}
function validateState(v: unknown, source: string): asserts v is WorkState {
  if (!object(v) || v.format !== format || v.sourceSha256 !== source || !Number.isSafeInteger(v.revision) || Number(v.revision) < 0) throw new StoreError('Invalid Work partition');
  if (v.pushPresent !== undefined && v.pushPresent !== true) throw new StoreError('Invalid push presence');
  validateWorkData(v.work);
  validatePush({ devices: [], deliveries: {}, ...(v.taskAssignments === undefined ? {} : { taskAssignments: v.taskAssignments as PushData['taskAssignments'] }) });
}
function strip(data: OperationsData): OperationsData {
  const core = { ...data }; delete core.work;
  if (core.push) {
    core.push = { ...core.push }; delete core.push.taskAssignments;
    // Assignment creation can initialize the push shell; it is represented by
    // the outbox in work.json, not an unnecessary write to the core database.
    if (Object.keys(core.push).length === 2 && core.push.devices.length === 0 && Object.keys(core.push.deliveries).length === 0) delete core.push;
  }
  return core;
}
function extract(data: OperationsData, revision: number): WorkState {
  return { format, sourceSha256: data.sourceSha256, revision, ...(data.work === undefined ? {} : { work: data.work }), ...(data.push?.taskAssignments === undefined ? {} : { taskAssignments: data.push.taskAssignments }), ...(data.push === undefined ? {} : { pushPresent: true }) };
}
function compose(core: OperationsData, work: WorkState): OperationsData {
  return { ...core, revision: core.revision + work.revision, ...(work.work === undefined ? {} : { work: work.work }), ...(work.pushPresent || work.taskAssignments !== undefined ? { push: { ...(core.push ?? { devices: [], deliveries: {} }), ...(work.taskAssignments === undefined ? {} : { taskAssignments: work.taskAssignments }) } } : {}) };
}

/** A tiny pointer replaces operations.json only on explicit offline migration.
 * Old binaries reject it rather than bootstrapping an empty Work workspace. */
export async function isWorkPartition(path: string, source: string): Promise<boolean> {
  let file;
  try { file = await open(path, 'r'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw new StoreError('Cannot inspect operations store'); }
  try {
    const bytes = Buffer.alloc(512); const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    const prefix = bytes.subarray(0, bytesRead).toString('utf8');
    if (!prefix.startsWith('{"format":"artel-work-partition')) return false;
    const value: unknown = JSON.parse(prefix);
    if (!object(value) || value.format !== format || value.sourceSha256 !== source || value.partition !== 'work-storage' || (await file.stat()).size !== bytesRead) throw new StoreError('Invalid Work storage pointer');
    return true;
  } finally { await file.close(); }
}

export class WorkPartition {
  readonly directory: string;
  readonly core: LegacyOperationsStore;
  readonly workPath: string;
  readonly journalPath: string;
  readonly latch: string;
  constructor(readonly rootPath: string) {
    this.directory = resolve(dirname(rootPath), 'work-storage');
    this.core = new LegacyOperationsStore(resolve(this.directory, 'core'));
    this.workPath = resolve(this.directory, 'work.json');
    this.journalPath = resolve(this.directory, 'commit.json');
    this.latch = resolve(this.directory, 'transaction.lock');
  }
  private async recover(source: string) {
    let raw;
    try { raw = await boundedRead(this.journalPath, 256 * 1024 * 1024); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    const journal = unseal(raw);
    if (!object(journal) || journal.sourceSha256 !== source || typeof journal.core !== 'string' || typeof journal.work !== 'string') throw new StoreError('Invalid partition commit journal');
    const core = decodeOperations(journal.core, source); const work = unseal(journal.work); validateState(work, source);
    if (core.work !== undefined || core.push?.taskAssignments !== undefined) throw new StoreError('Duplicate Work in core journal');
    await atomicFile(this.core.path, journal.core); await atomicFile(this.workPath, journal.work);
    this.core.rememberCommittedEncoding(journal.core, source);
    await unlink(this.journalPath); await syncDirectory(this.directory);
  }
  private async load(source: string) {
    await this.recover(source);
    // The legacy store's missing-file bootstrap must never apply to a partition.
    const coreStat = await stat(this.core.path);
    if (!coreStat.isFile()) throw new StoreError('Missing partition core');
    const core = await this.core.read(source); const workRaw = await boundedRead(this.workPath);
    const work = unseal(workRaw); validateState(work, source);
    if (core.work !== undefined || core.push?.taskAssignments !== undefined) throw new StoreError('Work has more than one source');
    return { core, work, data: compose(core, work), coreSize: coreStat.size, workSize: Buffer.byteLength(workRaw) };
  }
  read(source: string) { return partitionLock(this.latch, async () => (await this.load(source)).data); }
  mutate<T>(source: string, update: Update<T>, workOnly = false): Promise<T> {
    const admission = resolve(this.directory, workOnly ? 'work-queue.lock' : 'core-queue.lock');
    return partitionLock(admission, () => partitionLock(this.latch, async () => {
      const before = await this.load(source);
      // Only the restricted Work route needs a full-domain fingerprint guard.
      // Ordinary CRM transactions retain the legacy changed=true write contract;
      // serializing the core twice here would slow every other writer.
      const coreBefore = workOnly ? json(strip(before.core)) : undefined;
      const workBefore = json(before.work);
      const { result, changed } = await update(before.data);
      if (!changed) return result;
      if (before.data.sourceSha256 !== source) throw new StoreError('Wrong source in partition update');
      const core = strip(before.data); core.revision = before.core.revision;
      const work = extract(before.data, before.work.revision);
      const coreChanged = !workOnly || json(core) !== coreBefore;
      const workChanged = json(work) !== workBefore;
      if (workOnly && coreChanged) throw new StoreError('Work transaction tried to change another domain');
      validateState(work, source);
      if (coreChanged) core.revision++;
      if (workChanged) work.revision++;
      const coreBytes = coreChanged ? encodeOperations(core, source) : undefined;
      const workBytes = workChanged ? encodeWork(work) : undefined;
      // Keep a flat backup/rollback export within the existing 64 MiB limit.
      // Separate envelopes overestimate the composed payload; reserve extra
      // headroom for framing/revision growth instead of serializing core again.
      if ((coreBytes ? Buffer.byteLength(coreBytes) : before.coreSize) + (workBytes ? Buffer.byteLength(workBytes) : before.workSize) + 4096 > 64 * 1024 * 1024) throw new StoreError('Combined storage is too large for a safe backup/rollback');
      if (coreBytes && workBytes) {
        // WAL contains complete validated redo images. Readers replay it under
        // the same latch; a failed HTTP response can mean committed/unknown.
        await atomicFile(this.journalPath, envelope({ sourceSha256: source, core: coreBytes, work: workBytes }));
        await this.recover(source);
      } else if (coreBytes) {
        await atomicFile(this.core.path, coreBytes);
        this.core.rememberCommittedEncoding(coreBytes, source);
      }
      else if (workBytes) await atomicFile(this.workPath, workBytes);
      return result;
    }));
  }
}

/** Offline only. The caller must stop every writer, including maintenance jobs.
 * Pointer installation is last; failures before it leave the legacy source live.
 * Existing orphan directories are refused instead of overwriting evidence. */
export async function migrateWorkStorage(directory: string, source: string) {
  const legacy = new LegacyOperationsStore(directory);
  if (await isWorkPartition(legacy.path, source)) { await new WorkPartition(legacy.path).read(source); return { changed: false, mode: 'partitioned' }; }
  return partitionLock(`${legacy.path}.lock`, async () => {
    if (!(await stat(legacy.path)).isFile()) throw new StoreError('Missing legacy source');
    const data = await legacy.read(source);
    const partition = new WorkPartition(legacy.path);
    await mkdir(partition.directory, { mode: 0o700 });
    await mkdir(dirname(partition.core.path), { mode: 0o700 });
    const backup = await legacy.backup(data);
    await atomicFile(partition.core.path, encodeOperations(strip(data), source));
    await atomicFile(partition.workPath, encodeWork(extract(data, 0)));
    const assembled = await partition.read(source);
    // Compare the logical snapshot, including historical Work/outbox content.
    if (json(strip(assembled)) !== json(strip(data)) || json(extract(assembled, 0)) !== json(extract(data, 0))) throw new StoreError('Migration verification failed');
    await atomicFile(legacy.path, json({ format, sourceSha256: source, partition: 'work-storage' }));
    return { changed: true, mode: 'partitioned', backup };
  });
}
/** Rollback exports the CURRENT combined state; never restores the old backup. */
export async function mergeWorkStorage(directory: string, source: string) {
  const legacy = new LegacyOperationsStore(directory);
  if (!await isWorkPartition(legacy.path, source)) return { changed: false, mode: 'legacy' };
  const partition = new WorkPartition(legacy.path);
  return partitionLock(`${legacy.path}.lock`, async () => {
    const data = await partition.read(source);
    const backup = await legacy.backup(data);
    await atomicFile(legacy.path, encodeOperations(data, source));
    return { changed: true, mode: 'legacy', backup };
  });
}

import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Company, Directories, PaymentAllocation } from '../web/src/model';
import { migrateShipmentDirectories } from './migrations/002-shipment-directories';
import { validPhone, validVehicleMetadata, withFleetDirectories } from './fleet-directory';

export interface ShipmentOverride {
  fields: Record<string, string | null>;
  version: number;
  deleted?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface OperationsData {
  schemaVersion: 1 | 2;
  sourceSha256: string;
  revision: number;
  shipments: Record<string, ShipmentOverride>;
  companies: Company[];
  directories?: Directories;
  paymentAllocations?: PaymentAllocation[];
}

export class StoreError extends Error {}
const queues = new Map<string, Promise<unknown>>();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Check both JSON syntax and structure: a broken store is never replaced with an empty one. */
export function validate(data: unknown, sourceSha256: string): asserts data is OperationsData {
  if (!object(data) || (data.schemaVersion !== 1 && data.schemaVersion !== 2) || data.sourceSha256 !== sourceSha256 || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0 || !object(data.shipments) || !Array.isArray(data.companies)) throw new StoreError('Invalid operations store');
  if (data.schemaVersion === 2) {
    const directories = data.directories;
    if (!object(directories) || !object(directories.defaults) || ![null,'template-payment-form','simple','excel-rounded','excel-exact','excel-legacy'].includes(directories.defaults.profit as null) || !Array.isArray(data.paymentAllocations)) throw new StoreError('Invalid directories');
    if (directories.customerManagers !== undefined) {
      if (!Array.isArray(directories.customerManagers)) throw new StoreError('Invalid customer managers');
      const customers = new Set<string>();
      for (const row of directories.customerManagers) {
        if (!object(row) || typeof row.companyId !== 'string' || !row.companyId || typeof row.managerId !== 'string' || !row.managerId || customers.has(row.companyId)) throw new StoreError('Invalid customer manager');
        customers.add(row.companyId);
      }
    }
    for (const key of ['managers','products','paymentForms','vehicles','drivers','addresses']) {
      const rows = directories[key];
      if (!Array.isArray(rows)) throw new StoreError('Invalid directory');
      const seen = new Set<string>();
      for (const row of rows) {
        if (!object(row) || typeof row.id !== 'string' || !row.id || seen.has(row.id) || typeof row[key === 'vehicles' ? 'plate' : 'name'] !== 'string' || !(row[key === 'vehicles' ? 'plate' : 'name'] as string).trim()) throw new StoreError('Invalid directory entry');
        seen.add(row.id);
        if (key === 'vehicles' && !validVehicleMetadata(row)) throw new StoreError('Invalid vehicle metadata');
        if (key === 'drivers' && row.phone !== undefined && !validPhone(row.phone)) throw new StoreError('Invalid driver phone');
        if (key === 'drivers' && (typeof row.vehicleId !== 'string' || !(directories.vehicles as {id:string}[]).some(v => v.id === row.vehicleId))) throw new StoreError('Invalid driver vehicle');
        if (key === 'addresses' && (typeof row.companyId !== 'string' || !['loading','delivery'].includes(String(row.kind)))) throw new StoreError('Invalid address');
      }
    }
    const allocationIds = new Set<string>();
    for (const row of data.paymentAllocations) {
      if (!object(row) || typeof row.id !== 'string' || allocationIds.has(row.id) || typeof row.shipmentId !== 'string' || typeof row.paymentId !== 'string' || typeof row.amount !== 'string' || !/^\d+(?:\.\d+)?$/.test(row.amount) || typeof row.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) throw new StoreError('Invalid payment allocation');
      allocationIds.add(row.id);
    }
  }
  for (const [id, row] of Object.entries(data.shipments)) {
    if (!id || !object(row) || !object(row.fields) || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || typeof row.createdAt !== 'string' || typeof row.updatedAt !== 'string' || (row.deleted !== undefined && typeof row.deleted !== 'boolean')) throw new StoreError('Invalid shipment override');
    if (Object.values(row.fields).some(value => value !== null && typeof value !== 'string')) throw new StoreError('Invalid shipment fields');
  }
  const ids = new Set<string>();
  const inns = new Set<string>();
  for (const company of data.companies) {
    if (!object(company) || typeof company.id !== 'string' || !company.id || typeof company.name !== 'string' || !company.name || !strings(company.roles) || !strings(company.managerLabels) || !strings(company.shipmentIds) || !strings(company.paymentIds) || !strings(company.flags) || typeof company.inn !== 'string' || !/^\d{10}(?:\d{2})?$/.test(company.inn) || company.registrySource !== 'checko' || typeof company.registryCheckedAt !== 'string' || ids.has(company.id) || inns.has(company.inn)) throw new StoreError('Invalid company metadata');
    ids.add(company.id); inns.add(company.inn);
  }
}

export function decodeOperations(raw: string, sourceSha256: string): OperationsData {
  try {
    const envelope = JSON.parse(raw) as { sha256?: unknown; data?: unknown };
    if (!object(envelope) || envelope.sha256 !== hash(JSON.stringify(envelope.data))) throw new StoreError('Operations checksum mismatch');
    validate(envelope.data, sourceSha256);
    const data = migrateShipmentDirectories(envelope.data);
    return { ...data, directories: withFleetDirectories(data.directories!) };
  } catch { throw new StoreError('Operations store is damaged or belongs to another source'); }
}

export function encodeOperations(data: OperationsData): string {
  validate(data, data.sourceSha256);
  return JSON.stringify({ sha256: hash(JSON.stringify(data)), data });
}

export type OperationsStorage = Pick<OperationsStore, 'read' | 'mutate'>;

export class OperationsStore {
  readonly path: string;
  constructor(directory: string) { this.path = resolve(directory, 'operations.json'); }

  async read(sourceSha256: string): Promise<OperationsData> {
    let raw: string;
    try {
      const handle = await open(this.path, 'r');
      try {
        if ((await handle.stat()).size > 64 * 1024 * 1024) throw new StoreError('Operations store too large');
        raw = await handle.readFile('utf8');
      } finally { await handle.close(); }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        const data = migrateShipmentDirectories({ schemaVersion: 1, sourceSha256, revision: 0, shipments: {}, companies: [] });
        return { ...data, directories: withFleetDirectories(data.directories!) };
      }
      throw new StoreError('Cannot read operations store');
    }
    return decodeOperations(raw, sourceSha256);
  }

  /** In-process serialization plus an exclusive file lock also protects dev/preview overlap. */
  async mutate<T>(sourceSha256: string, update: (data: OperationsData) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean }): Promise<T> {
    const previous = queues.get(this.path) ?? Promise.resolve();
    const pending = previous.catch(() => undefined).then(async () => {
      await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
      const lockPath = `${this.path}.lock`;
      let lock;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { lock = await open(lockPath, 'wx', 0o600); break; }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new StoreError('Cannot lock operations store');
          await new Promise(resolveWait => setTimeout(resolveWait, 30));
        }
      }
      if (!lock) throw new StoreError('Operations store is busy');
      try {
        const data = await this.read(sourceSha256);
        const { result, changed } = await update(data);
        if (changed) {
          data.revision++;
          validate(data, sourceSha256);
          const encoded = JSON.stringify({ sha256: hash(JSON.stringify(data)), data });
          const temporary = `${this.path}.${randomUUID()}.tmp`;
          try {
            const file = await open(temporary, 'wx', 0o600);
            try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
            await rename(temporary, this.path);
          } finally { await unlink(temporary).catch(() => undefined); }
        }
        return result;
      } finally { await lock.close(); await unlink(lockPath); }
    });
    queues.set(this.path, pending);
    try { return await pending; } finally { if (queues.get(this.path) === pending) queues.delete(this.path); }
  }
}

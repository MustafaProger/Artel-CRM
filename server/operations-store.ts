import { validateTripExecutions, type StoredTripExecution } from './trip-execution';
import { validateDocumentArchive } from './document-archive';
import { validateOperator } from './operator';
import { validTripDocumentPolicy } from './trip-document-mode';
import { operatorDiscount } from './operator-directories';
import type { OperatorData } from '../web/src/operator-model';
import { validateDriverTripProgress, type DriverTripProgress } from './driver-trip-progress';
import { validateCabinets } from './cabinet-connections';
import { validateTripRequests } from './trip-requests';
import type { TripRequest } from '../web/src/trip-request-model';
import { oilDepotDetails } from './oil-depots';
import { migrateOilDepots } from './migrations/003-oil-depots';
import { locationDetails } from './location-details';
import { validateStoredDeliveryDistances } from './delivery-distances';
import { productTransportDetails, vehicleTransportDetails } from './directory-transport-details';
import { validateSabyData, type SabyData } from './saby-service';
import { validateEtrnData, type EtrnData } from './etrn-service';
import { validateTripSabyData, type TripSabyData } from './trip-saby-workflow';
import { companyFields, driverFields } from '../web/src/directory-fields';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, rename, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import type { Company, Directories, PaymentAllocation } from '../web/src/model';
import { migrateShipmentDirectories } from './migrations/002-shipment-directories';
import { validPhone, validVehicleMetadata, withFleetDirectories } from './fleet-directory';
import type { ChinaData } from '../web/src/china-model';
import { validateChina } from './china-operations';
import type { WorkData } from '../web/src/work-model';
import { validateWorkData } from './work-operations';
import { validateAccounts, type AccountsData } from './auth';
import { validatePush, type PushData } from './push';
import type { BankingData } from '../web/src/banking-model';
import { validateBanking } from './banking/domain';
import { sberConnections } from './banking/sber-connections';
import { validateSber, type SberData } from './banking/sber-domain';

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
  tripExecutions?: Record<string, StoredTripExecution>;
  driverTripProgress?: Record<string, DriverTripProgress>;
  tripCreateRequests?: Record<string, { tripId: string; fingerprint: string; actorId: string | null }>;
  tripRequests?: Record<string, TripRequest>;
  tripRequestCreates?: Record<string, { requestId: string; fingerprint: string; actorId: string | null }>;
  tripNumbers?: Record<string, number>;
  saby?: SabyData;
  etrn?: EtrnData;
  tripSaby?: TripSabyData;
  /** Explicit reset: source operations must never be imported again. */
  sourceOperationsCleared?: boolean;
  documentArchive?: import('../web/src/documents-model').DocumentArchive;
  work?: WorkData;
  china?: ChinaData;
  operator?: OperatorData;
  accounts?: AccountsData;
  push?: PushData;
  banking?: BankingData;
  cabinets?: import('./cabinet-connections').CabinetStorage;
  sber?: SberData;
  sberArtel?: SberData;
}

export class StoreError extends Error {}
const queues = new Map<string, Promise<unknown>>();
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

/** Check both JSON syntax and structure: a broken store is never replaced with an empty one. */
export function validate(data: unknown, sourceSha256: string): asserts data is OperationsData {
  if (!object(data) || (data.schemaVersion !== 1 && data.schemaVersion !== 2) || data.sourceSha256 !== sourceSha256 || !Number.isSafeInteger(data.revision) || Number(data.revision) < 0 || !object(data.shipments) || !Array.isArray(data.companies)) throw new StoreError('Invalid operations store');
  if (data.sourceOperationsCleared !== undefined && typeof data.sourceOperationsCleared !== 'boolean') throw new StoreError('Invalid operations reset');
  if (data.tripNumbers !== undefined) {
    if (!object(data.tripNumbers) || Object.entries(data.tripNumbers).some(([id, value]) => !id || !Number.isSafeInteger(value) || Number(value) < 1) || new Set(Object.values(data.tripNumbers)).size !== Object.keys(data.tripNumbers).length) throw new StoreError('Invalid trip numbers');
  }
  if (data.tripCreateRequests !== undefined) {
    if (!object(data.tripCreateRequests)) throw new StoreError('Invalid trip requests');
    for (const [key, value] of Object.entries(data.tripCreateRequests)) if (!/^[a-f0-9-]{36}$/.test(key) || !object(value) || typeof value.tripId !== 'string' || !/^shipment-trip-[a-f0-9-]+$/.test(value.tripId) || typeof value.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(value.fingerprint) || value.actorId !== null && typeof value.actorId !== 'string') throw new StoreError('Invalid trip request');
  }
  try { validateTripExecutions(data.tripExecutions); } catch { throw new StoreError('Invalid trip executions'); }
  try { validateDriverTripProgress(data.driverTripProgress); } catch { throw new StoreError('Invalid driver trip progress'); }
  try { validateTripRequests(data.tripRequests, data.tripRequestCreates); } catch { throw new StoreError('Invalid trip requests'); }
  try { validateSabyData(data.saby); } catch { throw new StoreError('Invalid Saby storage'); }
  try { validateEtrnData(data.etrn); } catch { throw new StoreError('Invalid ETRN storage'); }
  try { validateTripSabyData(data.tripSaby); } catch { throw new StoreError('Invalid trip Saby storage'); }
  validateChina(data.china);
  try { validateOperator(data.operator); } catch { throw new StoreError('Invalid operator storage'); }
  try { validateBanking(data.banking as BankingData | undefined); } catch { throw new StoreError('Invalid banking storage'); }
  try { validateCabinets(data.cabinets); } catch { throw new StoreError('Invalid cabinet storage'); }
  try { validateSber(data.sber as SberData | undefined); validateSber(data.sberArtel as SberData | undefined, sberConnections['sber-artel']); } catch { throw new StoreError('Invalid Sber storage'); }
  try { validatePush(data.push as PushData | undefined); } catch { throw new StoreError('Invalid push storage'); }
  if (data.documentArchive !== undefined) validateDocumentArchive(data.documentArchive);
  if (data.work !== undefined) validateWorkData(data.work);
  if (data.accounts !== undefined) { try { validateAccounts(data.accounts as AccountsData); } catch { throw new StoreError('Invalid accounts'); } }
  if (data.schemaVersion === 2) {
    const directories = data.directories;
    if (object(directories) && directories.fleetSeedApplied !== undefined && typeof directories.fleetSeedApplied !== 'boolean') throw new StoreError('Invalid fleet migration');
    if (object(directories) && directories.deletedEntries !== undefined) {
      if (!object(directories.deletedEntries)) throw new StoreError('Invalid directory deletions');
      for (const [kind, ids] of Object.entries(directories.deletedEntries)) if (!['companies','managers','products','paymentForms','vehicles','drivers','addresses','oilDepots'].includes(kind) || !strings(ids) || ids.some(id=>!id) || new Set(ids).size!==ids.length) throw new StoreError('Invalid directory deletions');
    }
    if (!object(directories) || !object(directories.defaults) || ![null,'template-payment-form','simple','excel-rounded','excel-exact','excel-legacy'].includes(directories.defaults.profit as null) || !Array.isArray(data.paymentAllocations)) throw new StoreError('Invalid directories');
    if (directories.customerManagers !== undefined) {
      if (!Array.isArray(directories.customerManagers)) throw new StoreError('Invalid customer managers');
      const customers = new Set<string>();
      for (const row of directories.customerManagers) {
        if (!object(row) || typeof row.companyId !== 'string' || !row.companyId || typeof row.managerId !== 'string' || !row.managerId || customers.has(row.companyId)) throw new StoreError('Invalid customer manager');
        customers.add(row.companyId);
      }
    }
    for (const key of ['operatorGroups', 'operatorServices']) {
      const rows = directories[key];
      if (rows === undefined) continue;
      if (!Array.isArray(rows)) throw new StoreError('Invalid operator directory');
      const seen = new Set<string>();
      for (const row of rows) {
        if (!object(row) || typeof row.id !== 'string' || !row.id || seen.has(row.id) || typeof row.name !== 'string' || !row.name.trim() || row.name.length > 500 || row.version !== undefined && (!Number.isSafeInteger(row.version) || Number(row.version) < 0)) throw new StoreError('Invalid operator directory entry');
        if (key === 'operatorServices') {
          if (typeof row.discountPercent !== 'string' || !/^\d+(?:\.\d+)?$/.test(row.discountPercent)) throw new StoreError('Invalid operator discount');
          if (row.backgroundColor !== undefined && (typeof row.backgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(row.backgroundColor))) throw new StoreError('Invalid operator background');
          if (row.discountHistory !== undefined) {
            if (!Array.isArray(row.discountHistory) || !row.discountHistory.length) throw new StoreError('Invalid operator discount history');
            let last = '';
            for (const rate of row.discountHistory) {
              if (!object(rate) || typeof rate.effectiveFrom !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(rate.effectiveFrom) || !Number.isFinite(Date.parse(rate.effectiveFrom)) || new Date(rate.effectiveFrom).toISOString().slice(0,10) !== rate.effectiveFrom || rate.effectiveFrom <= last) throw new StoreError('Invalid operator discount date');
              try { operatorDiscount(rate.discountPercent); } catch { throw new StoreError('Invalid operator discount history'); }
              last = rate.effectiveFrom;
            }
            if (row.discountHistory.at(-1)?.discountPercent !== row.discountPercent) throw new StoreError('Invalid current operator discount');
          }
          try { operatorDiscount(row.discountPercent); } catch { throw new StoreError('Invalid operator discount'); }
        }
        seen.add(row.id);
      }
    }
    if (directories.oilDepots !== undefined) {
      if (!Array.isArray(directories.oilDepots)) throw new StoreError('Invalid oil depots');
      const seen = new Set<string>();
      for (const depot of directories.oilDepots) {
        if (!object(depot) || typeof depot.id !== 'string' || !depot.id || seen.has(depot.id) || depot.version !== undefined && (!Number.isSafeInteger(depot.version) || Number(depot.version) < 0)) throw new StoreError('Invalid oil depot');
        try { oilDepotDetails(depot); } catch { throw new StoreError('Invalid oil depot details'); }
        seen.add(depot.id);
      }
    }
    for (const key of ['managers','products','paymentForms','vehicles','drivers','addresses']) {
      const rows = directories[key];
      if (!Array.isArray(rows)) throw new StoreError('Invalid directory');
      const seen = new Set<string>();
      for (const row of rows) {
        if (!object(row) || typeof row.id !== 'string' || !row.id || seen.has(row.id) || typeof row[key === 'vehicles' ? 'plate' : 'name'] !== 'string' || !(row[key === 'vehicles' ? 'plate' : 'name'] as string).trim()) throw new StoreError('Invalid directory entry');
        seen.add(row.id);
        if (['vehicles','drivers'].includes(key) && row.carrierId !== undefined && (typeof row.carrierId !== 'string' || (row.carrierId as string).length > 500)) throw new StoreError('Invalid fleet carrier');
        if (key === 'vehicles' && !validVehicleMetadata(row)) throw new StoreError('Invalid vehicle metadata');
        if (key === 'vehicles' || key === 'products') { try { (key === 'vehicles' ? vehicleTransportDetails : productTransportDetails)(row); } catch { throw new StoreError('Invalid directory transport profile'); } }
        if (key === 'drivers' && driverFields.some(([key])=>row[key] !== undefined && (typeof row[key] !== 'string' || (row[key] as string).length > 500))) throw new StoreError('Invalid driver details');
        if (key === 'drivers' && row.phone !== undefined && !validPhone(row.phone)) throw new StoreError('Invalid driver phone');
        if (key === 'drivers' && (typeof row.vehicleId !== 'string' || !(directories.vehicles as {id:string}[]).some(v => v.id === row.vehicleId))) throw new StoreError('Invalid driver vehicle');
        if (key === 'addresses') { try { locationDetails(row); validateStoredDeliveryDistances(row.oilDepotDistancesKm); } catch { throw new StoreError('Invalid location details'); } }
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
    if (row.fields.trip_document_policy != null && (!validTripDocumentPolicy(row.fields.trip_document_policy) || row.fields.trip_flow_version !== 'driver-v1' || !row.fields.trip_id)) throw new StoreError('Invalid trip document policy');
    if (row.fields.source_request_id) {
      const request = (data.tripRequests as Record<string, TripRequest> | undefined)?.[String(row.fields.source_request_id)];
      if (!request || request.status !== 'consumed' || request.shipmentId !== id || request.tripId !== row.fields.trip_id || request.companyId !== row.fields.customer_id || request.addressId !== row.fields.unloading_address_id) throw new StoreError('Invalid shipment request source');
    }
  }
  const ids = new Set<string>();
  const inns = new Set<string>();
  for (const company of data.companies) {
    if (!object(company) || (company.directoryArchived !== undefined && typeof company.directoryArchived !== 'boolean') || typeof company.id !== 'string' || !company.id || typeof company.name !== 'string' || !company.name || !strings(company.roles) || !strings(company.managerLabels) || !strings(company.shipmentIds) || !strings(company.paymentIds) || !strings(company.flags) || (company.inn !== undefined && (typeof company.inn !== 'string' || !/^\d{10}(?:\d{2})?$/.test(company.inn) || inns.has(company.inn))) || (company.registrySource !== undefined && (company.registrySource !== 'checko' || typeof company.registryCheckedAt !== 'string')) || ids.has(company.id)) throw new StoreError('Invalid company metadata');
    if (companyFields.some(([key])=>company[key] !== undefined && company[key] !== null && (typeof company[key] !== 'string' || (company[key] as string).length > 500))) throw new StoreError('Invalid company details');
    if (['defaultDriverId','defaultVehicleId'].some(key => company[key] !== undefined && (typeof company[key] !== 'string' || (company[key] as string).length > 500))) throw new StoreError('Invalid carrier defaults');
    ids.add(company.id); if (typeof company.inn === 'string') inns.add(company.inn);
  }
}

function migrateOperations(data: OperationsData): OperationsData {
  const migrated = migrateOilDepots(migrateShipmentDirectories(data));
  return { ...migrated, directories: withFleetDirectories(migrated.directories!) };
}

export function decodeOperations(raw: string, sourceSha256: string): OperationsData {
  try {
    const envelope = JSON.parse(raw) as { sha256?: unknown; data?: unknown };
    if (!object(envelope) || envelope.sha256 !== hash(JSON.stringify(envelope.data))) throw new StoreError('Operations checksum mismatch');
    validate(envelope.data, sourceSha256);
    return migrateOperations(envelope.data);
  } catch { throw new StoreError('Operations store is damaged or belongs to another source'); }
}

export function encodeOperations(data: OperationsData, sourceSha256 = data.sourceSha256): string {
  validate(data, sourceSha256);
  // The checksum covers these exact JSON bytes. Reuse them for the envelope
  // instead of serializing the complete store a second time on every write.
  const payload = JSON.stringify(data);
  const encoded = `{"sha256":"${hash(payload)}","data":${payload}}`;
  if (Buffer.byteLength(encoded) > 64 * 1024 * 1024) throw new StoreError('Operations store too large');
  return encoded;
}

export type OperationsStorage = Pick<OperationsStore, 'read' | 'mutate'> & Partial<Pick<OperationsStore, 'backup'>>;

export class OperationsStore {
  readonly path: string;
  #readCache?: { bytes: Buffer; raw: string; sourceSha256: string };
  constructor(directory: string) { this.path = resolve(directory, 'operations.json'); }

  async backup(data: OperationsData): Promise<string> {
    const folder = resolve(dirname(this.path), 'backups');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    const path = resolve(folder, `directories-${Date.now()}-${randomUUID()}.json`);
    const encoded = encodeOperations(data);
    const file = await open(path, 'wx', 0o600);
    try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
    const saved = await open(path, 'r');
    try { if (encodeOperations(decodeOperations(await saved.readFile('utf8'), data.sourceSha256)) !== encoded) throw new StoreError('Backup verification failed'); } finally { await saved.close(); }
    return path;
  }

  async read(sourceSha256: string): Promise<OperationsData> {
    let bytes: Buffer;
    try {
      const handle = await open(this.path, 'r');
      try {
        if ((await handle.stat()).size > 64 * 1024 * 1024) throw new StoreError('Operations store too large');
        bytes = await handle.readFile();
      } finally { await handle.close(); }
    } catch (error) {
      this.#readCache = undefined;
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return migrateOperations({ schemaVersion: 1, sourceSha256, revision: 0, shipments: {}, companies: [] });
      }
      throw new StoreError('Cannot read operations store');
    }
    try {
      // Always read the file: timestamps cannot prove that data or access rights
      // are unchanged. Reuse validation only for the exact bytes and source.
      if (this.#readCache?.sourceSha256 === sourceSha256 && this.#readCache.bytes.equals(bytes)) {
        // Parse the original bytes and apply the same migrations on every hit;
        // no mutable object is cached or shared with callers/mutation callbacks.
        return migrateOperations((JSON.parse(this.#readCache.raw) as { data: OperationsData }).data);
      }
      const raw = bytes.toString('utf8');
      const data = decodeOperations(raw, sourceSha256);
      this.#readCache = { bytes, raw, sourceSha256 };
      return data;
    } catch (error) {
      this.#readCache = undefined;
      throw error;
    }
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
          // Validate once against the caller's source, including after callbacks
          // that accidentally changed sourceSha256, before any file is written.
          const encoded = encodeOperations(data, sourceSha256);
          const temporary = `${this.path}.${randomUUID()}.tmp`;
          try {
            const file = await open(temporary, 'wx', 0o600);
            try { await file.writeFile(encoded); await file.sync(); } finally { await file.close(); }
            await rename(temporary, this.path);
            // encodeOperations already validated these exact bytes; keep callers isolated.
            this.#readCache = { bytes: Buffer.from(encoded), raw: encoded, sourceSha256 };
          } finally { await unlink(temporary).catch(() => undefined); }
        }
        return result;
      } finally { await lock.close(); await unlink(lockPath); }
    });
    queues.set(this.path, pending);
    try { return await pending; } finally { if (queues.get(this.path) === pending) queues.delete(this.path); }
  }
}

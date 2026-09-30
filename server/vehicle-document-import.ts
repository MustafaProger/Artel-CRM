import { allVehicleFields, vehicleTransportFields } from '../web/src/directory-fields';
import type { Company, Directories, Snapshot, Vehicle } from '../web/src/model';
import { addDirectoryEntry, normalizePlate } from './directory-operations';
import { updateDirectoryEntry } from './directory-editing';
import type { OperationsData } from './operations-store';
import Decimal from 'decimal.js';

/** This evidence file lives outside Git; scanned documents never become application fixtures. */
export interface VehicleDocumentSource { file: string; page?: number; section?: string; conversion?: string }
export interface VehicleDocumentFact { field: string; value: string | string[]; sources: VehicleDocumentSource[]; confidence: 'confirmed' | 'uncertain' }
export interface VehicleDocumentRecord {
  identity: { id?: string; plate: string; vin?: string };
  facts: VehicleDocumentFact[];
  notes?: string[];
}
export interface VehicleDocumentPayload {
  records: VehicleDocumentRecord[]; restoreVehicleIds?: string[];
  /** Separately reviewed identity correction; never inferred from the scanned value. */
  identityCorrections?: { vehicleId: string; plate: string; field: 'vin'; expected: string; value: string; sources: VehicleDocumentSource[] }[];
}
export interface VehicleImportIssue { field?: string; reason: string; existing?: unknown; proposed?: unknown; sources?: VehicleDocumentSource[] }
export interface VehicleImportRecordReport {
  identity: VehicleDocumentRecord['identity']; vehicleId?: string; action: 'unchanged' | 'updated' | 'created' | 'restored' | 'blocked';
  alreadyFilled: string[]; changes: { field: string; value: unknown; previousValue?: unknown; sources: VehicleDocumentSource[] }[];
  conflicts: VehicleImportIssue[]; missing: string[]; notes: string[];
}
export interface VehicleImportReport { records: VehicleImportRecordReport[]; changed: boolean; changedFields: number }
const fields = new Set(['plate', 'name', 'brand', 'model', 'trailer', 'capacityLitres', 'compartmentsLitres', 'carrierId', ...allVehicleFields.map(([key]) => key), ...vehicleTransportFields.map(([key]) => key)]);
// Card save requires its identifier only. These gaps concern the trip/document workflow.
const workflowFields = ['transportVehicleType', 'brand', 'payloadTonnes', 'capacityLitres', 'ownershipType', 'carrierId'] as const;
const empty = (value: unknown) => value === undefined || value === null || value === '' || Array.isArray(value) && value.length === 0;
const vinKey = (value: string) => value.normalize('NFKC').replace(/\s/g, '').toUpperCase();
const validSources = (sources: unknown): sources is VehicleDocumentSource[] => Array.isArray(sources) && sources.length > 0 && sources.every(source => source && typeof source === 'object' && typeof source.file === 'string' && source.file.trim() && (source.page === undefined || Number.isSafeInteger(source.page) && source.page > 0) && (source.section === undefined || typeof source.section === 'string' && source.section.trim()) && (source.page !== undefined || source.section !== undefined));
function same(field: string, left: unknown, right: unknown): boolean {
  if (typeof left !== 'string' || typeof right !== 'string') return JSON.stringify(left) === JSON.stringify(right);
  if (field === 'plate') return normalizePlate(left) === normalizePlate(right);
  if (field === 'vin') return vinKey(left) === vinKey(right);
  if (['payloadTonnes', 'capacityLitres'].includes(field) && [left, right].every(value => /^\d+(?:[.,]\d+)?$/.test(value))) return new Decimal(left.replace(',', '.')).eq(right.replace(',', '.'));
  if (field === 'leaseDocumentDate') {
    const date = (value: string) => /^\d{2}\.\d{2}\.\d{4}$/.test(value) ? value.split('.').reverse().join('-') : value;
    return date(left) === date(right);
  }
  return left.normalize('NFKC').trim().replace(/\s+/g, ' ') === right.normalize('NFKC').trim().replace(/\s+/g, ' ');
}
const snapshotFor = (data: OperationsData, companies: Company[]): Snapshot => ({ directories: data.directories, companies, shipments: [] }) as unknown as Snapshot;

/** Mutates only vehicle cards, through the normal directory validator. Caller owns the transaction/backup. */
export function importVehicleDocuments(data: OperationsData, companies: Company[], payload: VehicleDocumentPayload): VehicleImportReport {
  if (!data.directories || !Array.isArray(payload.records)) throw new Error('Vehicle import requires directories and an evidence record list.');
  const restoredIds = new Set(payload.restoreVehicleIds ?? []);
  if ([...restoredIds].some(id => typeof id !== 'string' || !id)) throw new Error('Invalid restore allowlist.');
  const report: VehicleImportReport = { records: [], changed: false, changedFields: 0 };
  const seen = new Set<string>();
  for (const record of payload.records) {
    if (!record.identity || typeof record.identity.plate !== 'string' || !record.identity.plate.trim() || !Array.isArray(record.facts)) throw new Error('Invalid vehicle evidence identity.');
    const result: VehicleImportRecordReport = { identity: record.identity, action: 'unchanged', alreadyFilled: [], changes: [], conflicts: [], missing: [], notes: record.notes ?? [] };
    report.records.push(result);
    const catalog = data.directories;
    const factVins = [...new Set(record.facts.filter(fact => fact && fact.field === 'vin' && fact.confidence === 'confirmed' && validSources(fact.sources) && typeof fact.value === 'string').map(fact => vinKey(fact.value as string)))];
    if (factVins.length > 1 || record.identity.vin && factVins.length && vinKey(record.identity.vin) !== factVins[0]) {
      result.action = 'blocked'; result.conflicts.push({ field: 'vin', reason: 'Документы содержат противоречивые VIN.' }); continue;
    }
    const evidenceVin = record.identity.vin ?? factVins[0];
    const matches = catalog.vehicles.filter(row => row.id === record.identity.id || normalizePlate(row.plate) === normalizePlate(record.identity.plate) || evidenceVin && row.vin && vinKey(row.vin) === vinKey(evidenceVin));
    const previous = matches[0];
    const correction = previous && payload.identityCorrections?.find(item => item && item.vehicleId === previous.id && record.identity.id === previous.id && item.field === 'vin' && typeof item.plate === 'string' && normalizePlate(item.plate) === normalizePlate(previous.plate) && normalizePlate(item.plate) === normalizePlate(record.identity.plate) && typeof item.expected === 'string' && item.expected === previous.vin && typeof item.value === 'string' && evidenceVin && vinKey(item.value) === vinKey(evidenceVin) && validSources(item.sources));
    if (matches.length > 1 || previous && record.identity.id && previous.id !== record.identity.id || previous && evidenceVin && previous.vin && vinKey(previous.vin) !== vinKey(evidenceVin) && !correction || previous && normalizePlate(previous.plate) !== normalizePlate(record.identity.plate)) {
      result.action = 'blocked'; result.conflicts.push({ reason: 'Идентификаторы VIN, госномер и ID указывают на разные сведения. Требуется ручная сверка.' }); continue;
    }
    const vehicleId = previous?.id ?? record.identity.id;
    if (vehicleId && seen.has(vehicleId) || seen.has(`plate:${normalizePlate(record.identity.plate)}`)) {
      result.action = 'blocked'; result.conflicts.push({ reason: 'Машина повторяется в одном файле импорта.' }); continue;
    }
    if (vehicleId) seen.add(vehicleId);
    seen.add(`plate:${normalizePlate(record.identity.plate)}`);
    result.vehicleId = vehicleId;
    const deleted = vehicleId && catalog.deletedEntries?.vehicles?.includes(vehicleId);
    if (deleted && !restoredIds.has(vehicleId)) {
      result.action = 'blocked'; result.conflicts.push({ reason: 'Карточка удалена. Восстановление требует явного разрешения для этого ID.' }); continue;
    }
    result.alreadyFilled = previous ? Object.keys(previous).filter(key => fields.has(key) && !empty(previous[key as keyof Vehicle])) : [];
    const proposed: Record<string, unknown> = {};
    const sources = new Map<string, VehicleDocumentSource[]>();
    const conflicted = new Set<string>();
    for (const fact of record.facts) {
      if (!fact || typeof fact !== 'object') { result.conflicts.push({ reason: 'Некорректная запись факта.' }); continue; }
      if (!fields.has(fact.field) || empty(fact.value) || typeof fact.value !== 'string' && !(fact.field === 'compartmentsLitres' && Array.isArray(fact.value) && fact.value.every(value => typeof value === 'string'))) {
        result.conflicts.push({ field: fact.field, reason: 'Неизвестное поле или некорректное значение.', proposed: fact.value }); continue;
      }
      if (fact.confidence !== 'confirmed' || !validSources(fact.sources)) {
        result.conflicts.push({ field: fact.field, reason: 'Значение требует проверки или не имеет точного источника.', proposed: fact.value, sources: fact.sources }); continue;
      }
      if (fact.field === 'plate' && !same('plate', record.identity.plate, fact.value) || fact.field === 'vin' && record.identity.vin && !same('vin', record.identity.vin, fact.value)) {
        result.conflicts.push({ field: fact.field, reason: 'Сведения не совпадают с идентификатором документа.', proposed: fact.value, sources: fact.sources }); conflicted.add(fact.field); continue;
      }
      if (Object.hasOwn(proposed, fact.field) && !same(fact.field, proposed[fact.field], fact.value)) {
        result.conflicts.push({ field: fact.field, reason: 'Документы содержат разные значения.', existing: proposed[fact.field], proposed: fact.value, sources: [...sources.get(fact.field)!, ...fact.sources] }); conflicted.add(fact.field); continue;
      }
      proposed[fact.field] = fact.value;
      sources.set(fact.field, [...(sources.get(fact.field) ?? []), ...fact.sources]);
    }
    for (const field of conflicted) delete proposed[field];
    const patch: Record<string, unknown> = {};
    for (const [field, value] of Object.entries(proposed)) {
      const existing = previous?.[field as keyof Vehicle];
      if (!empty(existing)) {
        if (!same(field, existing, value)) {
          if (field === 'vin' && correction && same('vin', correction.value, value)) { patch[field] = value; sources.set(field, [...sources.get(field)!, ...correction.sources]); }
          else result.conflicts.push({ field, reason: 'Заполненная карточка отличается от документа; существующее значение сохранено.', existing, proposed: value, sources: sources.get(field) });
        }
      } else patch[field] = value;
    }
    if (!previous && (!proposed.plate || !same('plate', proposed.plate, record.identity.plate))) {
      result.action = 'blocked'; result.conflicts.push({ field: 'plate', reason: 'Новая или восстанавливаемая карточка требует подтверждённого документом госномера.' }); continue;
    }
    let current = previous;
    if (Object.keys(patch).length || deleted) {
      // Validation is isolated; an invalid row never partially changes this or earlier records.
      const draft = structuredClone(data);
      try {
        if (previous) {
          const { id: _id, version: _version, ...oldFields } = previous;
          current = updateDirectoryEntry('vehicles', previous.id, { ...oldFields, ...patch, version: previous.version ?? 0 }, snapshotFor(draft, companies), draft).entry as Vehicle;
        } else {
          const added = addDirectoryEntry({ kind: 'vehicles', ...patch }, snapshotFor(draft, companies), draft);
          if (!added.created) throw new Error('Обнаружена существующая карточка; создание дубликата отменено.');
          current = added.entry as Vehicle;
          if (vehicleId) current.id = vehicleId;
        }
        if (deleted) draft.directories!.deletedEntries!.vehicles = draft.directories!.deletedEntries!.vehicles!.filter(id => id !== vehicleId);
        data.directories = draft.directories as Directories;
        result.vehicleId = current.id;
        result.action = deleted ? 'restored' : previous ? 'updated' : 'created';
        result.changes = Object.keys(patch).map(field => ({ field, value: current![field as keyof Vehicle], ...(previous && !empty(previous[field as keyof Vehicle]) ? { previousValue: previous[field as keyof Vehicle] } : {}), sources: sources.get(field)! }));
        report.changed = true; report.changedFields += result.changes.length;
      } catch (error) {
        result.action = 'blocked'; result.conflicts.push({ reason: `Штатная валидация отклонила карточку: ${(error as Error).message}` });
      }
    }
    result.missing = workflowFields.filter(field => empty(current?.[field as keyof Vehicle]));
  }
  return report;
}

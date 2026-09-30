import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyDirectories } from '../server/directory-operations';
import type { OperationsData } from '../server/operations-store';
import { importVehicleDocuments, type VehicleDocumentFact, type VehicleDocumentPayload } from '../server/vehicle-document-import';

const state = (): OperationsData => ({ schemaVersion: 2, sourceSha256: 'test', revision: 1, shipments: {}, companies: [], paymentAllocations: [], directories: { ...emptyDirectories(), fleetSeedApplied: true, vehicles: [{ id: 'vehicle-a', plate: 'А123АА777', vin: 'TESTVIN12345678901', brand: 'Existing brand', maxWeight: '20000', unladenWeight: '9000' }] } });
const fact = (field: string, value: string): VehicleDocumentFact => ({ field, value, confidence: 'confirmed', sources: [{ file: 'synthetic-sts.pdf', page: 1 }] });
const payload = (facts: VehicleDocumentFact[]): VehicleDocumentPayload => ({ records: [{ identity: { plate: 'A123AA777', vin: 'TESTVIN12345678901' }, facts }] });

test('fill missing through directory validator, preserve existing, and repeated import is a no-op', () => {
  const data = state();
  const input = payload([fact('bodyType', 'Цистерна'), fact('payloadTonnes', '8.50')]);
  const first = importVehicleDocuments(data, [], input);
  assert.equal(first.records[0].action, 'updated');
  assert.equal(data.directories!.vehicles[0].payloadTonnes, '8.5');
  assert.equal(data.directories!.vehicles[0].brand, 'Existing brand');
  const after = structuredClone(data);
  const repeated = importVehicleDocuments(data, [], input);
  assert.equal(repeated.changed, false);
  assert.equal(repeated.records[0].conflicts.length, 0);
  assert.deepEqual(data, after);
  assert.equal(data.directories!.vehicles.length, 1);
});

test('conflicting values are reported without replacing confirmed card fields or inferring payload', () => {
  const data = state();
  const result = importVehicleDocuments(data, [], payload([fact('brand', 'Other brand')]));
  assert.equal(result.changed, false);
  assert.equal(result.records[0].conflicts[0].field, 'brand');
  assert.ok(result.records[0].missing.includes('payloadTonnes'));
  assert.equal(data.directories!.vehicles[0].payloadTonnes, undefined);
});

test('uncertain recognition and disagreeing documents never fill fields', () => {
  const data = state();
  const result = importVehicleDocuments(data, [], payload([{ ...fact('ptsNumber', '123'), confidence: 'uncertain' }, fact('capacityLitres', '10000'), { ...fact('capacityLitres', '11000'), sources: [{ file: 'other.pdf', page: 2 }] }]));
  assert.equal(result.changed, false);
  assert.equal(result.records[0].conflicts.length, 2);
  assert.equal(data.directories!.vehicles[0].ptsNumber, undefined);
  assert.equal(data.directories!.vehicles[0].capacityLitres, undefined);
});

test('VIN and plate matching different cards blocks the row', () => {
  const data = state(); data.directories!.vehicles.push({ id: 'vehicle-b', plate: 'В456ВВ777', vin: 'OTHERVIN1234567890' });
  const result = importVehicleDocuments(data, [], { records: [{ identity: { plate: 'В456ВВ777', vin: 'TESTVIN12345678901' }, facts: [fact('bodyType', 'Цистерна')] }] });
  assert.equal(result.records[0].action, 'blocked'); assert.equal(result.changed, false);
});

test('restore allowlist restores the same vehicle ID while preserving deleted driver tombstone', () => {
  const data = state(); data.directories!.deletedEntries = { vehicles: ['old-vehicle'], drivers: ['old-driver'] };
  const input: VehicleDocumentPayload = { records: [{ identity: { id: 'old-vehicle', plate: 'В456ВВ777' }, facts: [fact('plate', 'В456ВВ777'), fact('model', 'Synthetic')] }] };
  assert.equal(importVehicleDocuments(data, [], input).records[0].action, 'blocked');
  const result = importVehicleDocuments(data, [], { ...input, restoreVehicleIds: ['old-vehicle'] });
  assert.equal(result.records[0].action, 'restored');
  assert.equal(data.directories!.vehicles.find(row => row.plate === 'В456ВВ777')?.id, 'old-vehicle');
  assert.deepEqual(data.directories!.deletedEntries.drivers, ['old-driver']);
  assert.equal(data.directories!.drivers.length, 0);
  assert.equal(importVehicleDocuments(data, [], input).changed, false);
});

test('invalid card values do not partially write and do not block independent valid records', () => {
  const data = state();
  const result = importVehicleDocuments(data, [], { records: [payload([fact('payloadTonnes', '0'), fact('bodyType', 'Цистерна')]).records[0], { identity: { plate: 'В456ВВ777' }, facts: [fact('plate', 'В456ВВ777'), fact('bodyType', 'Цистерна')] }] });
  assert.equal(result.records[0].action, 'blocked');
  assert.equal(data.directories!.vehicles[0].bodyType, undefined);
  assert.equal(result.records[1].action, 'created');
});

test('VIN in a fact participates in deduplication even without identity.vin', () => {
  const data = state();
  for (const identity of [{ plate: 'В456ВВ777' }, { id: 'new-vehicle', plate: 'В456ВВ777' }]) {
    const result = importVehicleDocuments(data, [], { records: [{ identity, facts: [fact('plate', 'В456ВВ777'), fact('vin', 'TESTVIN12345678901')] }] });
    assert.equal(result.records[0].action, 'blocked'); assert.equal(result.changed, false);
  }
  assert.equal(data.directories!.vehicles.length, 1);
});

test('identity corrections require stable ID, plate and expected old value, and are idempotent', () => {
  const data = state();
  const input: VehicleDocumentPayload = { records: [{ identity: { id: 'vehicle-a', plate: 'А123АА777', vin: 'VERIFIEDVIN0000001' }, facts: [fact('vin', 'VERIFIEDVIN0000001')] }], identityCorrections: [{ vehicleId: 'vehicle-a', plate: 'А123АА777', field: 'vin', expected: 'TESTVIN12345678901', value: 'VERIFIEDVIN0000001', sources: [{ file: 'reviewed.pdf', page: 2 }] }] };
  const stale = structuredClone(input); stale.identityCorrections![0].expected = 'stale';
  assert.equal(importVehicleDocuments(data, [], stale).records[0].action, 'blocked');
  const result = importVehicleDocuments(data, [], input);
  assert.equal(result.changed, true); assert.equal(result.records[0].changes[0].previousValue, 'TESTVIN12345678901');
  assert.equal(importVehicleDocuments(data, [], input).changed, false);
});

test('malformed sources and nonpositive page numbers are reported without writes', () => {
  const data = state();
  const bad = [null, { ...fact('bodyType', 'Цистерна'), sources: [null] }, { ...fact('bodyType', 'Цистерна'), sources: [{ file: 'scan.pdf', page: -1 }] }] as unknown as VehicleDocumentFact[];
  const result = importVehicleDocuments(data, [], payload(bad));
  assert.equal(result.changed, false); assert.equal(result.records[0].conflicts.length, 3);
});

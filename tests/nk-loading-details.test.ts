import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError } from '../server/api-error';
import { getNkLoadingDetails, saveNkLoadingDetails } from '../server/nk-loading-details';
import { readEtrnLoadingDetails, sabyLoadingDetailsBlockers } from '../server/saby-consignment-note';
import type { NkDirectEtrnRecord } from '../server/nk-direct-etrn';
import { validateEtrnData, type EtrnDocument } from '../server/etrn-service';
import { nkDirectAutostartSourceHash } from '../server/nk-direct-autostart';
import { integrationConfig, integrationRuntime } from './helpers/trip-saby-integration';
import { syntheticLoadingDetails } from './helpers/loading-details-fixture';

const createdAt = '2026-10-21T10:00:00.000Z';
const errorStatus = (expected: number) => (error: unknown) => error instanceof ApiError && error.status === expected;
async function fixture() {
  const rt = await integrationRuntime(), config = integrationConfig();
  await rt.store.mutate(rt.source, data => {
    for (const row of Object.values(data.shipments)) {
      row.fields.organization_id = 'nk-artel'; row.fields.trip_flow_version = 'driver-v1'; row.fields.trip_document_policy = 'nk-direct-etrn-v1';
      row.fields.quantity_gross_tonnes = row.fields.quantity_tonnes;
    }
    data.accounts = { users: [{ id: 'actor', login: 'actor', name: 'Синтетический директор', role: 'director', managerId: null, active: true, version: 1, passwordHash: 'a'.repeat(128), salt: 'a'.repeat(32) }], sessions: [], attempts: {} };
    return { result: undefined, changed: true };
  });
  const get = async () => getNkLoadingDetails(rt.base, await rt.store.read(rt.source), rt.tripId, config);
  const save = (version: string, details: unknown, actorId = 'actor') => rt.store.mutate(rt.source, data => saveNkLoadingDetails(rt.base, data, rt.tripId, actorId, { version, details }, config));
  return { ...rt, config, get, save };
}

test('loading details accepts an explicit incomplete draft without provider calls and persists exact normalized fields', async () => {
  const f = await fixture(), originalFetch = globalThis.fetch;
  let providerCalls = 0;
  globalThis.fetch = async () => { providerCalls++; throw new Error('No provider is allowed for loading drafts'); };
  try {
    const before = await f.get(); assert.equal(before.details, null); assert.equal(before.required, true); assert.equal(before.editable, true);
    const saved = await f.save(before.version, { basis: { name: ' Синтетическое поручение ' }, worker: { surname: ' Тестовый ' } });
    const expected = readEtrnLoadingDetails({ basis: { name: 'Синтетическое поручение' }, worker: { surname: 'Тестовый' } });
    assert.deepEqual(saved.details, expected); assert.ok(sabyLoadingDetailsBlockers(expected).length);
    assert.notEqual(saved.version, before.version); assert.equal(providerCalls, 0);
    assert.deepEqual((await f.store.read(f.source)).etrn!.trips[f.tripId].loadingDetails, expected);
    assert.deepEqual(await f.get(), saved);
    const data = await f.store.read(f.source), exact = JSON.stringify(data);
    const repeated = saveNkLoadingDetails(f.base, data, f.tripId, 'actor', { version: saved.version, details: expected }, f.config);
    assert.equal(repeated.changed, false); assert.equal(JSON.stringify(data), exact);
    assert.equal(data.etrn!.trips[f.tripId].direct, undefined); assert.deepEqual(data.etrn!.trips[f.tripId].deliveries, {});
  } finally { globalThis.fetch = originalFetch; await f.close(); }
});

test('stale loading form cannot overwrite a newer employee draft or a changed loading company', async () => {
  const f = await fixture();
  try {
    const first = await f.get(); await f.save(first.version, syntheticLoadingDetails());
    const exact = await f.store.read(f.source);
    await assert.rejects(f.save(first.version, {}), errorStatus(409));
    assert.deepEqual(await f.store.read(f.source), exact);
    const next = await f.get(), data = await f.store.read(f.source);
    data.companies.find(row => row.id === 'supplier')!.inn = '0392816475';
    assert.throws(() => saveNkLoadingDetails(f.base, data, f.tripId, 'actor', { version: next.version, details: {} }, f.config), errorStatus(409));
  } finally { await f.close(); }
});

for (const mode of ['missing', 'inactive', 'driver', 'no_trip_section', 'foreign_manager'] as const) test(`loading draft rejects ${mode} actor without changing data`, async () => {
  const f = await fixture();
  try {
    const data = await f.store.read(f.source), actor = data.accounts!.users[0];
    if (mode === 'inactive') actor.active = false;
    if (mode === 'driver') { actor.role = 'driver'; actor.driverId = 'driver'; actor.sections = []; }
    if (mode === 'no_trip_section') { actor.role = 'employee'; actor.managerId = 'manager'; actor.sections = ['shipments']; }
    if (mode === 'foreign_manager') { actor.role = 'employee'; actor.managerId = 'foreign'; actor.sections = ['trips']; data.directories!.managers.push({ id: 'foreign', name: 'Другой синтетический менеджер' }); }
    const current = getNkLoadingDetails(f.base, data, f.tripId, f.config), before = JSON.stringify(data);
    assert.throws(() => saveNkLoadingDetails(f.base, data, f.tripId, mode === 'missing' ? 'missing' : actor.id, { version: current.version, details: syntheticLoadingDetails() }, f.config), (error: unknown) => error instanceof ApiError && [403, 404].includes(error.status));
    assert.equal(JSON.stringify(data), before);
  } finally { await f.close(); }
});

for (const mode of ['direct_grant', 'uncertain_reservation'] as const) test(`loading draft cannot change a frozen ${mode}`, async () => {
  const f = await fixture();
  try {
    const current = await f.get(); await f.save(current.version, syntheticLoadingDetails());
    const data = await f.store.read(f.source), trip = data.etrn!.trips[f.tripId];
    if (mode === 'direct_grant') trip.direct = { version: 'nk-direct-v1', attemptId: 'saved-attempt' } as NkDirectEtrnRecord;
    else {
      // Classification reads only document presence; the immutable attempt remains untouched.
      const shipmentId = f.trip.customers[0].id;
      trip.deliveries[shipmentId] = { document: { id: null, status: 'unknown', reservationAttempted: true, attemptId: 'saved-attempt' } as EtrnDocument } as typeof trip.deliveries[string];
      trip.direct = { version: 'nk-direct-v1', attemptId: 'saved-direct-attempt' } as NkDirectEtrnRecord;
    }
    const frozen = getNkLoadingDetails(f.base, data, f.tripId, f.config), before = JSON.stringify(data);
    assert.equal(frozen.editable, false);
    assert.throws(() => saveNkLoadingDetails(f.base, data, f.tripId, 'actor', { version: frozen.version, details: {} }, f.config), errorStatus(409));
    assert.equal(JSON.stringify(data), before);
  } finally { await f.close(); }
});

test('loading draft remains local when automatic enrollment waits for departure', async () => {
  const f = await fixture();
  try {
    const data = await f.store.read(f.source);
    data.etrn = { trips: { [f.tripId]: { deliveries: {}, updatedAt: createdAt, directAutostart: { version: 'nk-direct-autostart-v1', actorId: 'actor', createdAt, updatedAt: createdAt, source: 'trip_save', sourceHash: 'a'.repeat(64), policyHash: 'b'.repeat(64), certificate: null, state: 'waiting_departure', lastError: null } } } };
    const enrollment = JSON.stringify(data.etrn.trips[f.tripId].directAutostart), current = getNkLoadingDetails(f.base, data, f.tripId, f.config);
    assert.equal(current.editable, true);
    const saved = saveNkLoadingDetails(f.base, data, f.tripId, 'actor', { version: current.version, details: syntheticLoadingDetails() }, f.config);
    assert.equal(saved.changed, true); assert.equal(JSON.stringify(data.etrn.trips[f.tripId].directAutostart), enrollment);
    assert.equal(data.etrn.trips[f.tripId].direct, undefined);
  } finally { await f.close(); }
});

test('ordinary order flow and malformed input cannot be used to create loading details', async () => {
  const f = await fixture();
  try {
    const data = await f.store.read(f.source), current = getNkLoadingDetails(f.base, data, f.tripId, f.config);
    for (const input of [null, {}, { version: current.version, details: null }, { version: current.version, details: {}, unexpected: true }]) {
      const before = JSON.stringify(data); assert.throws(() => saveNkLoadingDetails(f.base, data, f.tripId, 'actor', input, f.config), errorStatus(400)); assert.equal(JSON.stringify(data), before);
    }
    for (const row of Object.values(data.shipments)) row.fields.organization_id = 'artel';
    assert.throws(() => getNkLoadingDetails(f.base, data, f.tripId, f.config), errorStatus(409));
  } finally { await f.close(); }
});

test('explicit per-trip sender role reports NK and independent infrastructure, persists, and invalidates old authority', async () => {
  const f = await fixture();
  try {
    const data = await f.store.read(f.source), before = getNkLoadingDetails(f.base, data, f.tripId, f.config);
    const sourceHash = nkDirectAutostartSourceHash(f.base, data, f.tripId);
    data.etrn = { trips: { [f.tripId]: { deliveries: {}, updatedAt: createdAt, loadingActorMode: 'sender' } } };
    f.config.carrierResponsible = { surname: 'ПеревозчикТестовый', name: 'Тест', patronymic: 'Тестович', phone: '+70000000077' };
    validateEtrnData(data.etrn);
    const after = getNkLoadingDetails(f.base, data, f.tripId, f.config);
    assert.equal(after.mode, 'sender'); assert.equal(after.required, false);
    assert.deepEqual(after.loadingActor, { name: f.config.carrier.name, inn: f.config.carrier.inn });
    assert.deepEqual(after.carrierResponsible, f.config.carrierResponsible);
    assert.deepEqual(after.infrastructureOwner, before.infrastructureOwner);
    assert.notDeepEqual(after.loadingActor, after.infrastructureOwner);
    assert.notEqual(after.version, before.version); assert.notEqual(nkDirectAutostartSourceHash(f.base, data, f.tripId), sourceHash);
    assert.throws(() => saveNkLoadingDetails(f.base, data, f.tripId, 'actor', { version: before.version, details: {} }, f.config), errorStatus(409));
    assert.throws(() => validateEtrnData({ trips: { [f.tripId]: { ...data.etrn!.trips[f.tripId], loadingActorMode: 'invented' } } }), /Invalid loading actor mode/);
    await f.store.mutate(f.source, saved => { saved.etrn = structuredClone(data.etrn); return { result: undefined, changed: true }; });
    assert.equal((await f.store.read(f.source)).etrn!.trips[f.tripId].loadingActorMode, 'sender');
    delete data.etrn.trips[f.tripId].loadingActorMode;
    assert.equal(nkDirectAutostartSourceHash(f.base, data, f.tripId), sourceHash, 'Absent override retains historical source hashes');
    const saved = data.etrn.trips[f.tripId];
    saved.direct = { deliveries: [{ snapshot: { carrierResponsibleVersion: 1, profile: { carrierResponsible: { ...f.config.carrierResponsible } } } }] } as NkDirectEtrnRecord;
    f.config.carrierResponsible.name = 'ДругойТест';
    assert.equal(getNkLoadingDetails(f.base, data, f.tripId, f.config).carrierResponsible!.name, 'Тест');
    delete saved.direct.deliveries[0].snapshot.carrierResponsibleVersion;
    assert.equal(getNkLoadingDetails(f.base, data, f.tripId, f.config).carrierResponsible, null, 'Old frozen titles cannot advertise a newly configured contact');
  } finally { await f.close(); }
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { readEtrnLoadingDetails, readSabyConsignmentProfile, sabyConsignmentBlockers, sabyLoadingDetailsBlockers, serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { prepareNkDirectEtrn, prepareTripSaby } from '../server/trip-saby-preparation';
import { currentSnapshot } from '../server/shipment-operations';
import { getShipmentTrip } from '../server/shipment-trips';
import type { NkDirectEtrnRecord } from '../server/nk-direct-etrn';
import { syntheticEtrnFixture } from './helpers/etrn-fixture';
import { integrationConfig, integrationRuntime, integrationSettings } from './helpers/trip-saby-integration';
import { syntheticLoadingDetails } from './helpers/loading-details-fixture';

const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const createdAt = '2025-04-01T09:20:30.000Z';
function fixture() {
  const { snapshot } = syntheticEtrnFixture();
  snapshot.loadingDetailsVersion = 1;
  snapshot.profile.loadingActor = { sameAsConsignor: false, party: { ...snapshot.profile.recipient }, ...syntheticLoadingDetails() };
  return snapshot;
}
function xml(snapshot = fixture()) { return serializeSabyConsignmentNote(snapshot, attemptId, createdAt); }
function decoded(snapshot = fixture()) { return new TextDecoder('windows-1251').decode(xml(snapshot).xml); }
function validateXsd(snapshot = fixture()) {
  const folder = mkdtempSync(resolve(tmpdir(), 'artel-loading-flc-'));
  try {
    const file = resolve(folder, 'sender.xml'); writeFileSync(file, xml(snapshot).xml);
    execFileSync('xmllint', ['--noout', '--schema', resolve('tests/fixtures/saby/consignment-note-1110339-5.01.xsd'), file], { stdio: 'pipe' });
  } finally { rmSync(folder, { recursive: true, force: true }); }
}

test('third-party loader emits its actual basis and explicitly confirmed employee duties, and passes XSD', () => {
  assert.deepEqual(sabyConsignmentBlockers(fixture()), []);
  const text = decoded();
  assert.match(text, /<СвЛицПогрГр СовпГОП="2"><РекЛицПогрГр>/);
  assert.match(text, /<ОснПогрГр НаимДок="Синтетическое поручение погрузки" НомерДок="TEST-LOADING-1" ДатаДок="01.03.2025"><ИдРекСост><ИННЮЛ>7707083893<\/ИННЮЛ><\/ИдРекСост><\/ОснПогрГр>/);
  assert.match(text, /<РабЛицПогрГр Должность="Синтетический оператор"><ОДолжОб>Должностные обязанности<\/ОДолжОб><ФИО Фамилия="ПогрузчикТестовый" Имя="Тест"\/><\/РабЛицПогрГр>/);
  assert.doesNotMatch(text, /<ОПИное/); validateXsd();
});

test('electronic loading document and separate employee authority document are exclusive alternatives', () => {
  const snapshot = fixture(), details = snapshot.profile.loadingActor;
  details.basis = { name: '', number: '', date: '', documentId: 'SYNTHETIC-LOADING-DOCUMENT', issuerInns: ['7707083893'], additionalInfo: 'Синтетическое уточнение' };
  details.worker!.authority = 'document';
  details.worker!.authorityDocument = { name: 'Синтетическая доверенность', number: 'TEST-POWER-1', date: '2025-02-01', issuerInns: ['059381746205'] };
  const text = decoded(snapshot);
  assert.match(text, /<ОснПогрГр ИдДок="SYNTHETIC-LOADING-DOCUMENT" ДопСведДок="Синтетическое уточнение">/);
  assert.match(text, /<ОПИное НаимДок="Синтетическая доверенность" НомерДок="TEST-POWER-1" ДатаДок="01.02.2025"><ИдРекСост><ИННФЛ>059381746205<\/ИННФЛ>/);
  assert.doesNotMatch(text, /<ОДолжОб/); validateXsd(snapshot);
});

test('conditional FLC rejects absent basis and employee before serializing a new third-party title', () => {
  const snapshot = fixture(); delete snapshot.profile.loadingActor.basis; delete snapshot.profile.loadingActor.worker;
  assert.equal(sabyConsignmentBlockers(snapshot).filter(message => /основание погрузки|ФИО и должность работника/.test(message)).length, 2);
  assert.throws(() => xml(snapshot), /основание погрузки/);
  // The same incomplete fields were accepted historically; no read-time rewrite or new invented data.
  delete snapshot.loadingDetailsVersion;
  assert.doesNotThrow(() => xml(snapshot));
});

for (const [label, change] of [
  ['mixed electronic and paper identity', (s: ReturnType<typeof fixture>) => { s.profile.loadingActor.basis!.documentId = 'SYNTHETIC-ID'; }],
  ['missing issuer', (s: ReturnType<typeof fixture>) => { s.profile.loadingActor.basis!.issuerInns = []; }],
  ['invalid date', (s: ReturnType<typeof fixture>) => { s.profile.loadingActor.basis!.date = '2025-02-30'; }],
  ['missing employee name', (s: ReturnType<typeof fixture>) => { s.profile.loadingActor.worker!.name = ''; }],
  ['unconfirmed authority', (s: ReturnType<typeof fixture>) => { s.profile.loadingActor.worker!.authority = ''; }],
  ['missing authority document', (s: ReturnType<typeof fixture>) => { s.profile.loadingActor.worker!.authority = 'document'; }],
  ['two authority alternatives', (s: ReturnType<typeof fixture>) => { s.profile.loadingActor.worker!.authorityDocument = syntheticLoadingDetails().basis; }],
] as const) test(`conditional loading FLC rejects ${label}`, () => {
  const snapshot = fixture(); change(snapshot);
  assert.ok(sabyLoadingDetailsBlockers(snapshot.profile.loadingActor).length);
  assert.throws(() => xml(snapshot));
});

test('matching loader emits only sender identity and never invents an employee or loading basis', () => {
  const snapshot = fixture(); snapshot.profile.loadingActor = { sameAsConsignor: true, party: snapshot.profile.loadingActor.party };
  assert.match(decoded(snapshot), /<СвЛицПогрГр СовпГОП="1"><ИдентРекГО><ИННЮЛ>0148372956<\/ИННЮЛ><\/ИдентРекГО><\/СвЛицПогрГр>/);
  assert.doesNotMatch(decoded(snapshot), /ОснПогрГр|РабЛицПогрГр/);
  snapshot.profile.loadingActor.basis = syntheticLoadingDetails().basis;
  assert.throws(() => xml(snapshot), /не применяются/);
});

test('closed-field input preserves new loading details and leaves legacy profiles structurally unchanged', () => {
  const details = syntheticLoadingDetails();
  assert.deepEqual(readEtrnLoadingDetails({ ...details, arbitrary: 'ignored' }), details);
  assert.equal(readEtrnLoadingDetails({}).worker.authority, '');
  const { profile } = syntheticEtrnFixture(), normalized = readSabyConsignmentProfile(profile);
  assert.deepEqual(normalized, profile);
  const before = xml(syntheticEtrnFixture().snapshot);
  const legacy = syntheticEtrnFixture().snapshot; legacy.profile = normalized;
  assert.deepEqual(xml(legacy), before);
  const fresh = fixture();
  assert.deepEqual(readSabyConsignmentProfile(fresh.profile).loadingActor, fresh.profile.loadingActor);
});

test('new direct preparation requires per-trip details, while frozen legacy/current snapshots keep their exact format', async () => {
  const rt = await integrationRuntime();
  try {
    const data = await rt.store.read(rt.source), config = integrationConfig();
    for (const row of Object.values(data.shipments)) { row.fields.organization_id = 'nk-artel'; row.fields.trip_flow_version = 'driver-v1'; row.fields.quantity_gross_tonnes = row.fields.quantity_tonnes; }
    config.nkConsignmentSigner = config.consignmentSigner; config.nkRegulatoryInstructions = 'Синтетические указания НК';
    const prepare = () => { const source = currentSnapshot(rt.base, data); return prepareNkDirectEtrn(source, data, getShipmentTrip(source, rt.tripId), config, integrationSettings); };
    const missing = prepare();
    assert.equal(missing.deliveries[0].snapshot.loadingDetailsVersion, 1);
    assert.ok(missing.blockers.some(message => message.includes('основание погрузки')));
    data.etrn ??= { trips: {} };
    const saved = data.etrn.trips[rt.tripId] = { deliveries: {}, updatedAt: createdAt, loadingDetails: syntheticLoadingDetails() };
    const complete = prepare();
    assert.ok(!complete.blockers.some(message => /основание погрузки|ФИО и должность работника/.test(message)));
    assert.deepEqual(complete.deliveries[0].snapshot.profile.loadingActor.basis, saved.loadingDetails.basis);
    const grant = { deliveries: structuredClone(complete.deliveries) } as NkDirectEtrnRecord;
    data.etrn.trips[rt.tripId].direct = grant;
    saved.loadingDetails.worker.name = 'ИзменённыйТест';
    assert.deepEqual(prepare().deliveries, complete.deliveries);
    for (const row of grant.deliveries) { delete row.snapshot.loadingDetailsVersion; delete row.snapshot.profile.loadingActor.basis; delete row.snapshot.profile.loadingActor.worker; }
    assert.deepEqual(prepare().deliveries, grant.deliveries);
    delete data.etrn.trips[rt.tripId].direct;
    const loader = data.companies.find(row => row.id === 'supplier')!;
    Object.assign(loader, { inn: config.carrier.inn, kpp: config.carrier.kpp });
    delete data.etrn.trips[rt.tripId].loadingDetails;
    const same = prepare();
    assert.equal(same.deliveries[0].snapshot.profile.loadingActor.sameAsConsignor, true);
    assert.ok(!same.blockers.some(message => /основание погрузки|ФИО и должность работника/.test(message)));
  } finally { await rt.close(); }
});

test('direct transportation contact uses carrier contact fields and does not become loader or signer', () => {
  const snapshot = fixture(); snapshot.documentMode = 'nk-direct-v1'; snapshot.carrierResponsibleVersion = 1;
  snapshot.customerOrganization = { ...snapshot.carrierOrganization };
  snapshot.fields.organization_id = 'nk-artel';
  snapshot.profile.order = { number: 'Без номера', date: snapshot.fields.date! };
  const responsible = { surname: 'ПеревозчикТестовый', name: 'Тест', patronymic: 'Тестович', phone: '+70000000077' };
  snapshot.profile.carrierResponsible = responsible;
  assert.deepEqual(readSabyConsignmentProfile(snapshot.profile).carrierResponsible, responsible);
  const text = decoded(snapshot), carrier = text.match(/<СвПер>(.*?)<\/СвПер>/)?.[1];
  assert.ok(carrier); assert.ok(carrier.includes(`<Тлф>${snapshot.carrierOrganization.phone}</Тлф>`));
  assert.ok(carrier.includes('<Тлф>+70000000077</Тлф><ИнКонт>Ответственный за перевозку: ПеревозчикТестовый Тест Тестович</ИнКонт>'));
  assert.doesNotMatch(text.match(/<РабЛицПогрГр.*?<\/РабЛицПогрГр>/)?.[0] || '', /ПеревозчикТестовый/);
  assert.doesNotMatch(text.match(/<Подписант.*?<\/Подписант>/)?.[0] || '', /ПеревозчикТестовый/);
  validateXsd(snapshot);
  delete snapshot.carrierResponsibleVersion;
  const legacyWithContact = decoded(snapshot); delete snapshot.profile.carrierResponsible;
  assert.equal(decoded(snapshot), legacyWithContact, 'Unversioned titles must ignore the new contact field byte for byte');
});

test('fresh sender override preserves infrastructure owner and freezes role/contact without changing ordinary flow', async () => {
  const rt = await integrationRuntime();
  try {
    const data = await rt.store.read(rt.source), config = integrationConfig();
    for (const row of Object.values(data.shipments)) { row.fields.organization_id = 'nk-artel'; row.fields.trip_flow_version = 'driver-v1'; row.fields.quantity_gross_tonnes = row.fields.quantity_tonnes; }
    config.nkConsignmentSigner = config.consignmentSigner; config.nkRegulatoryInstructions = 'Синтетические указания НК';
    config.carrierResponsible = { surname: 'ПеревозчикТестовый', name: 'Тест', patronymic: 'Тестович', phone: '+70000000077' };
    const source = () => currentSnapshot(rt.base, data);
    const prepare = () => prepareNkDirectEtrn(source(), data, getShipmentTrip(source(), rt.tripId), config, integrationSettings);
    const ordinary = () => prepareTripSaby(source(), data, getShipmentTrip(source(), rt.tripId), config, integrationSettings);
    const ordinaryBefore = ordinary();
    data.etrn = { trips: { [rt.tripId]: { deliveries: {}, updatedAt: createdAt, loadingActorMode: 'sender', loadingDetails: syntheticLoadingDetails() } } };
    const prepared = prepare(), first = prepared.deliveries[0].snapshot;
    assert.equal(first.loadingActorMode, 'sender'); assert.equal(first.profile.loadingActor.sameAsConsignor, true);
    assert.equal(first.profile.loadingActor.party.inn, config.carrier.inn);
    assert.equal(first.profile.loadingActor.basis, undefined); assert.equal(first.profile.loadingActor.worker, undefined);
    assert.equal(first.profile.infrastructureOwner.party.inn, data.companies.find(row => row.id === 'supplier')!.inn);
    assert.equal(first.profile.infrastructureOwner.sameAsConsignor, false);
    assert.deepEqual(first.profile.carrierResponsible, config.carrierResponsible);
    assert.ok(!prepared.blockers.some(message => /основание погрузки|ФИО и должность работника/.test(message)));
    assert.deepEqual(ordinary(), ordinaryBefore);
    const saved = data.etrn.trips[rt.tripId]; saved.direct = { deliveries: structuredClone(prepared.deliveries) } as NkDirectEtrnRecord;
    config.carrierResponsible.name = 'ДругойТест'; delete saved.loadingActorMode;
    assert.deepEqual(prepare().deliveries, prepared.deliveries, 'A frozen role/contact cannot be changed by later per-trip/config edits');
    for (const row of saved.direct.deliveries) {
      delete row.snapshot.carrierResponsibleVersion; delete row.snapshot.profile.carrierResponsible;
    }
    assert.deepEqual(prepare().deliveries, saved.direct.deliveries, 'Legacy frozen snapshots do not gain contact metadata');
    delete saved.direct; config.carrierResponsible = null;
    assert.ok(prepare().blockers.some(message => message.includes('настройку ФИО и телефона ответственного')));
  } finally { await rt.close(); }
});

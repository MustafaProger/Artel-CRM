import assert from 'node:assert/strict';
import { syntheticEtrnFixture as fixture, sender, carrier } from './helpers/etrn-fixture';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { buildSabyConsignmentDocument, buildSabyConsignmentSnapshot, readSabyConsignmentProfile, sabyConsignmentBlockers, serializeSabyConsignmentNote, type SabyConsignmentSnapshot } from '../server/saby-consignment-note';

const attemptId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const createdAt = '2025-04-01T09:20:30.000Z';

function xmlOf(snapshot: SabyConsignmentSnapshot) { return new TextDecoder('windows-1251').decode(serializeSabyConsignmentNote(snapshot, attemptId, createdAt).xml); }
function validateXsd(snapshot: SabyConsignmentSnapshot) {
  const folder = mkdtempSync(resolve(tmpdir(), 'artel-etrn-synthetic-'));
  try { const file = resolve(folder, 'sender.xml'); writeFileSync(file, serializeSabyConsignmentNote(snapshot, attemptId, createdAt).xml); execFileSync('xmllint', ['--noout', '--schema', resolve('tests/fixtures/saby/consignment-note-1110339-5.01.xsd'), file], { stdio: 'pipe' }); }
  finally { rmSync(folder, { recursive: true, force: true }); }
}
test('real-trip mapper creates a sender ConsignmentNote, preserving exact delivery units and independent events', () => {
  const { snapshot } = fixture(); assert.deepEqual(sabyConsignmentBlockers(snapshot), []);
  const xml = xmlOf(snapshot);
  assert.match(xml, /КНД="1110339"/); assert.match(xml, /Объем="7.125"/); assert.match(xml, /МасБрутЗнач="5123.125"/); assert.match(xml, /МасБрутОтгр="5123.125"/);
  assert.doesNotMatch(xml, /9987\.654321|1110361|1110340|Подпись|ЭП=|NEVER-COPY|private-accounting-only/);
  assert.match(xml, /ФДатВрПриб="01\.04\.2025T08:20:30\+03:00"/); assert.match(xml, /ФДатВрУбыт="01\.04\.2025T09:25:35\+03:00"/);
  assert.match(xml, /ДатИнфГО="01\.04\.2025" ВрИнфГО="12:20:30"/);
  assert.equal(snapshot.calculatedMassTonnes, '9.987654321');
  assert.equal(serializeSabyConsignmentNote(snapshot, attemptId, createdAt).xml.equals(serializeSabyConsignmentNote(snapshot, attemptId, createdAt).xml), true);
  validateXsd(snapshot);
});
test('optional danger, cargo dimensions, explicit third-party loading and electronic authority pass XSD', () => {
  const { snapshot } = fixture(); const p = snapshot.profile;
  p.cargo.dimensions = { heightMetres: '1.23', lengthMetres: '2.34', widthMetres: '3.45' };
  p.cargo.dangerousGoods = { unNumber: '1203', shippingName: 'Синтетический опасный груз', class: '3', classificationCode: 'F1', packingGroup: 'II', hazardSign: '33', tunnelCode: 'D/E' };
  p.loadingActor = { sameAsConsignor: false, party: { ...p.recipient } }; p.infrastructureOwner = { sameAsConsignor: false, party: { ...p.recipient } };
  p.signer.status = '2'; p.signer.powerOfAttorney = { date: '2025-03-01', number: 'TEST-POA', id: 'SYNTHETIC-POA-FILE' };
  assert.deepEqual(sabyConsignmentBlockers(snapshot), []); validateXsd(snapshot);
  assert.match(xmlOf(snapshot), /<СвДовер /); assert.match(xmlOf(snapshot), /<РекЛицПогрГр>/);
});
test('forwarder includes explicitly confirmed transport customer and passes XSD', () => {
  const { snapshot } = fixture(); snapshot.profile.consignorIsForwarder = '1'; snapshot.profile.transportCustomer = { ...snapshot.profile.recipient };
  snapshot.profile.transportCustomerContract = { name: 'Синтетический договор', number: 'SYNTHETIC-CONTRACT', date: '2025-03-01', issuerInns: ['0261947385'] };
  assert.deepEqual(sabyConsignmentBlockers(snapshot), []); validateXsd(snapshot);
});
test('new draft prefills only existing directory facts, leaving mass, events and authority unconfirmed', () => {
  const { source, trip } = fixture(); const snapshot = buildSabyConsignmentSnapshot(source, trip, trip.customers[0].id, sender, carrier, null);
  assert.equal(snapshot.profile.recipient.inn, source.companies[0].inn); assert.equal(snapshot.profile.driver.surname, 'ВодительТестовый');
  assert.equal(snapshot.profile.vehicle.capacityCubicMetres, '12.34'); assert.equal(snapshot.profile.vehicle.payloadTonnes, '');
  assert.equal(snapshot.profile.confirmed, false); assert.equal(snapshot.profile.deliveryMassTonnes, ''); assert.equal(snapshot.profile.loading.arrivedAt, ''); assert.equal(snapshot.profile.loading.departedAt, ''); assert.equal(snapshot.profile.cargo.dangerousGoods, undefined);
  assert.ok(sabyConsignmentBlockers(snapshot).length > 5);
});
test('partial and hostile draft normalization is closed, detached and does not throw', () => {
  for (const raw of [null, undefined, 'not json', '[]', { driver: null, cargo: { dangerousGoods: 'maybe' } }]) {
    const profile = readSabyConsignmentProfile(raw); assert.equal(profile.confirmed, false); assert.equal(profile.signer.name, '');
  }
  const raw = { confirmed: true, driver: { name: 'Тест', password: 'do not persist' }, arbitrary: '<xml/>' }; const profile = readSabyConsignmentProfile(raw);
  raw.driver.name = 'изменён'; assert.equal(profile.driver.name, 'Тест'); assert.doesNotMatch(JSON.stringify(profile), /password|arbitrary|do not persist/);
});
test('snapshot does not leak financial fields, passport or live directory references', () => {
  const { snapshot, source, trip } = fixture(); source.companies[0].inn = '9999999999'; trip.fields.loading_address = 'changed';
  assert.equal(snapshot.customer.inn, '0261947385'); assert.equal(snapshot.fields.loading_address, 'Синтетическая площадка погрузки'); assert.doesNotMatch(JSON.stringify(snapshot), /passport|NEVER-COPY|private-accounting-only/);
});
test('explicitly cleared draft fields stay empty instead of refilling silently', () => {
  const { source, trip, profile } = fixture(); profile.recipient.name = ''; const snapshot = buildSabyConsignmentSnapshot(source, trip, trip.customers[0].id, sender, carrier, profile);
  assert.equal(snapshot.profile.recipient.name, ''); assert.ok(sabyConsignmentBlockers(snapshot).some(value => value.includes('грузополучателя')));
});
for (const [label, mutate, error] of [
  ['missing actual event', (s: SabyConsignmentSnapshot) => { s.profile.loading.departedAt = ''; }, 'фактические'],
  ['reverse actual events', (s: SabyConsignmentSnapshot) => { s.profile.loading.departedAt = '2025-04-01T07:00'; }, 'предшествовать'],
  ['impossible date', (s: SabyConsignmentSnapshot) => { s.fields.date = '2025-02-30'; }, 'дату рейса'],
  ['fractional mass precision', (s: SabyConsignmentSnapshot) => { s.profile.deliveryMassTonnes = '5.1231251'; }, 'массу именно'],
  ['unconfirmed dangerous goods', (s: SabyConsignmentSnapshot) => { delete s.profile.cargo.dangerousGoods; }, 'опасного груза'],
  ['unconfirmed role', (s: SabyConsignmentSnapshot) => { s.profile.infrastructureOwner.sameAsConsignor = null; }, 'владельца'],
  ['wrong recipient', (s: SabyConsignmentSnapshot) => { s.profile.recipient.inn = '9999999999'; }, 'отличается'],
  ['unknown authority', (s: SabyConsignmentSnapshot) => { s.profile.signer.status = '2'; }, 'доверенности'],
  ['missing lease', (s: SabyConsignmentSnapshot) => { delete s.profile.vehicle.ownershipDocument; }, 'основания владения'],
  ['no driver identification', (s: SabyConsignmentSnapshot) => { s.driver.inn = ''; s.driver.licenseNumber = ''; }, 'идентификации'],
  ['partial coordinate', (s: SabyConsignmentSnapshot) => { s.fields.loading_latitude = '55.1'; }, 'координаты'],
  ['overweight delivery', (s: SabyConsignmentSnapshot) => { s.profile.deliveryMassTonnes = '19'; }, 'Масса доставки'],
  ['overweight whole trip', (s: SabyConsignmentSnapshot) => { s.tripTotalMassTonnes = '27.9'; }, 'Общая масса'],
  ['overvolume whole trip', (s: SabyConsignmentSnapshot) => { s.tripTotalLitres = '13000'; }, 'Общий объём'],
  ['unsupported characters', (s: SabyConsignmentSnapshot) => { s.profile.cargo.name = 'Груз 🚚'; }, 'Windows-1251'],
] as const) test(`blocks ${label} before XML/write`, () => {
  const { snapshot } = fixture(); mutate(snapshot); assert.ok(sabyConsignmentBlockers(snapshot).some(value => value.includes(error)), JSON.stringify(sabyConsignmentBlockers(snapshot))); assert.throws(() => xmlOf(snapshot));
});
test('escaping preserves user text without allowing markup insertion', () => {
  const { snapshot } = fixture(); snapshot.profile.cargo.name = 'Груз "тест" & <Подпись/>';
  const xml = xmlOf(snapshot); assert.match(xml, /Груз &quot;тест&quot; &amp; &lt;Подпись\/&gt;/); assert.doesNotMatch(xml, /<Подпись\/>/); validateXsd(snapshot);
});
test('Saby write uses the ConsignmentNote roles and no uploaded signature or initial filename', () => {
  const { snapshot } = fixture(); const doc = buildSabyConsignmentDocument(snapshot, 'ARTEL-CRM:SYNTHETIC', attemptId, createdAt);
  assert.equal(doc.Тип, 'ConsignmentNote'); assert.ok(doc.Грузоотправитель && doc.Грузополучатель && doc.ТранспортнаяКомпания); assert.equal(doc.Перевозчик, undefined);
  const files = doc.Вложение as { Файл: { ДвоичныеДанные: string; Имя?: string } }[]; assert.equal(files[0].Файл.Имя, undefined); assert.equal(Buffer.from(files[0].Файл.ДвоичныеДанные, 'base64').equals(serializeSabyConsignmentNote(snapshot, attemptId, createdAt).xml), true);
});
test('foreign delivery and malformed attempt identifiers cannot produce documents', () => {
  const { source, trip, profile, snapshot } = fixture(); assert.throws(() => buildSabyConsignmentSnapshot(source, trip, 'wrong-delivery', sender, carrier, profile));
  assert.throws(() => serializeSabyConsignmentNote(snapshot, '../bad-id', createdAt)); assert.throws(() => serializeSabyConsignmentNote(snapshot, attemptId, 'bad-date'));
});

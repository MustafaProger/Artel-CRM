import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { CONSIGNMENT_CARRIER_ACCEPTANCE, fillConsignmentCarrier, verifyConsignmentCarrierBusiness, verifyConsignmentCarrierSourceSignature, verifyConsignmentSenderBusiness } from '../server/saby-consignment-evidence';
import { serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { parseXml } from '../server/saby-order-evidence';
import { serializeXml, xmlChildren } from '../server/saby-carrier-details';
import { syntheticEtrnFixture } from './helpers/etrn-fixture';

const id = '11111111-1111-4111-8111-111111111111';
const created = '2025-04-01T10:00:00.000Z';
const utf8 = (text: string) => Buffer.from('<?xml version="1.0" encoding="utf-8"?>' + text);
const setup = () => {
  const { snapshot } = syntheticEtrnFixture();
  const sender = serializeSabyConsignmentNote(snapshot, id, created, '041').xml;
  const root = parseXml(sender); const doc = xmlChildren(root, 'Документ')[0];
  const uid = xmlChildren(doc, 'СодИнфГО')[0].attributes.УИД_ТрН;
  const carrier = utf8(`<Файл ИдФайл="ON_TRNACLPPRIN_SYNTHETIC" ВерсПрог="Saby" ВерсФорм="5.01"><Документ КНД="1110340" ПоФактХЖ="Транспортная накладная, информация перевозчика о приеме груза" ДатИнфПрвПрием="01.04.2025" ВрИнфПрвПрием="13:05:00"><ИдИнфГО ИдФайлИнфГО="${root.attributes.ИдФайл}" ДатФайлИнфГО="${doc.attributes.ДатИнфГО}" ВрФайлИнфГО="${doc.attributes.ВрИнфГО}" ЭП="c3ludGhldGlj"/><СодИнфПрвПрием УИД_ТрН="${uid}" СодОпер="${CONSIGNMENT_CARRIER_ACCEPTANCE}"/><Подписант СтатПодп="1"><ФИО Фамилия="ПеревозчикТестовый" Имя="Тест"/></Подписант></Документ></Файл>`);
  return { snapshot, sender, carrier };
};
const change = (bytes: Uint8Array, from: string | RegExp, to: string) => utf8(serializeXml(parseXml(bytes)).replace(from, to));
function validateCarrierXsd(bytes: Uint8Array) {
  const directory = mkdtempSync(resolve(tmpdir(), 'artel-carrier-evidence-'));
  try {
    const path = resolve(directory, 'synthetic.xml'); writeFileSync(path, bytes);
    execFileSync('xmllint', ['--noout', '--schema', resolve('tests/fixtures/saby/consignment-note-1110340-5.01.xsd'), path], { stdio: 'pipe' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('sender evidence allows Saby service header/signatory preparation and exact decimal presentation only', () => {
  const { sender } = setup();
  let prepared = change(sender, /ИдФайл="[^"]+"/, 'ИдФайл="ON_TRNACLGROT_PREPARED"');
  prepared = change(prepared, /ДатИнфГО="[^"]+"/, 'ДатИнфГО="02.04.2025"');
  prepared = change(prepared, /УИД_ТрН="[^"]+"/, 'УИД_ТрН="provider-assigned-uid"');
  prepared = change(prepared, /МасБрутЗнач="5123.125"/, 'МасБрутЗнач="5123.1250"');
  prepared = change(prepared, /<Подписант[^>]*>[\s\S]*?<\/Подписант>/, '<Подписант СтатПодп="1"><ФИО Фамилия="ДругойТест" Имя="Тест"/></Подписант>');
  assert.deepEqual(verifyConsignmentSenderBusiness(prepared, sender), { fileId: 'ON_TRNACLGROT_PREPARED', date: '02.04.2025', time: '13:00:00' });
});

for (const [label, from, to] of [
  ['mass', 'МасБрутЗнач="5123.125"', 'МасБрутЗнач="5123.124"'],
  ['events', 'ФДатВрПриб="01.04.2025T08:20:30+03:00"', 'ФДатВрПриб="01.04.2025T08:20:31+03:00"'],
  ['recipient', 'ИННЮЛ="0261947385"', 'ИННЮЛ="0261947386"'],
  ['route', 'Синтетическая площадка получателя', 'Другая площадка доставки'],
  ['unknown business attribute', '<СодИнфГО ', '<СодИнфГО Несогласовано="Да" '],
] as const) test(`sender evidence rejects changed ${label}`, () => {
  const { sender } = setup(); const modified = change(sender, from, to);
  assert.notEqual(Buffer.from(modified).toString(), change(sender, '', '').toString(), 'synthetic mutation must affect the document');
  assert.throws(() => verifyConsignmentSenderBusiness(modified, sender));
});

test('carrier confirms exact source title and frozen facts without duplicate facts or receiving-client action', () => {
  const { snapshot, sender, carrier } = setup();
  verifyConsignmentCarrierBusiness(carrier, sender, snapshot);
  validateCarrierXsd(carrier);
  assert.deepEqual(fillConsignmentCarrier(carrier, sender, snapshot), { bytes: carrier, changed: false });
  snapshot.profile.loading.departedAt = '2025-04-01T09:26:35';
  assert.throws(() => verifyConsignmentCarrierBusiness(carrier, sender, snapshot));
});

for (const [label, from, to] of [
  ['source filename', /ИдФайлИнфГО="[^"]+"/, 'ИдФайлИнфГО="OTHER"'],
  ['source creation time', /ВрФайлИнфГО="[^"]+"/, 'ВрФайлИнфГО="13:00:01"'],
  ['source signature', 'ЭП="c3ludGhldGlj"', 'ЭП=""'],
  ['UID', /УИД_ТрН="[^"]+"/, 'УИД_ТрН="OTHER"'],
  ['rejection', CONSIGNMENT_CARRIER_ACCEPTANCE, 'Груз не принят'],
  ['remarks', '</СодИнфПрвПрием>', '<ЗамПрвПрием ЗамМасс="Иная масса"/></СодИнфПрвПрием>'],
  ['unloading', '</СодИнфПрвПрием>', '<ПриемГрузГП ФДатВрПриб="01.04.2025T10:00:00+03:00"/></СодИнфПрвПрием>'],
  ['extra recipient', '<Документ ', '<ИдПолИной>UNEXPECTED</ИдПолИной><Документ '],
] as const) test(`carrier evidence rejects ${label} without overwriting it`, () => {
  const { snapshot, sender, carrier } = setup(); const modified = change(carrier, from, to);
  assert.throws(() => verifyConsignmentCarrierBusiness(modified, sender, snapshot));
  assert.throws(() => fillConsignmentCarrier(modified, sender, snapshot));
});

test('carrier completion only fills missing standard acceptance operation and linked UID', () => {
  const { snapshot, sender, carrier } = setup();
  let missing = change(carrier, / СодОпер="[^"]+"/, ''); missing = change(missing, / УИД_ТрН="[^"]+"/, '');
  const filled = fillConsignmentCarrier(missing, sender, snapshot);
  assert.equal(filled.changed, true);
  verifyConsignmentCarrierBusiness(filled.bytes, sender, snapshot);
  validateCarrierXsd(filled.bytes);
  assert.equal(fillConsignmentCarrier(filled.bytes, sender, snapshot).changed, false);
  const before = parseXml(missing); const after = parseXml(filled.bytes);
  xmlChildren(xmlChildren(before, 'Документ')[0], 'СодИнфПрвПрием')[0].attributes = xmlChildren(xmlChildren(after, 'Документ')[0], 'СодИнфПрвПрием')[0].attributes;
  assert.deepEqual(after, before);
});

test('carrier source signature must equal the exact current detached signature bytes', () => {
  const { carrier } = setup();
  verifyConsignmentCarrierSourceSignature(carrier, Buffer.from('synthetic'));
  assert.throws(() => verifyConsignmentCarrierSourceSignature(carrier, Buffer.from('different')));
  assert.throws(() => verifyConsignmentCarrierSourceSignature(carrier, Buffer.alloc(0)));
  for (const malformed of ['', 'c3ludGhldGlj=', ' c3ludGhldGlj', 'c3ludGhldGlj!', 'c3ludGhldGl', 'Zh==']) {
    assert.throws(() => verifyConsignmentCarrierSourceSignature(change(carrier, 'ЭП="c3ludGhldGlj"', `ЭП="${malformed}"`), Buffer.from('f')));
  }
});

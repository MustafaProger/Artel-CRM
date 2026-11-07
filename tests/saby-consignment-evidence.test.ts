import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { CONSIGNMENT_CARRIER_ACCEPTANCE, NATIVE_APPROVED_REDIRECTION_METHOD, fillConsignmentCarrier, verifyConsignmentCarrierBusiness, verifyConsignmentCarrierSourceSignature, verifyConsignmentSenderBusiness, type SabyConsignmentEvidenceOptions } from '../server/saby-consignment-evidence';
import { serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { parseXml, type XmlNode } from '../server/saby-order-evidence';
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

test('explicit native amendment accepts only the approved method and exact current Saby attachment reference', () => {
  const { snapshot } = syntheticEtrnFixture(); snapshot.profile.instructions.redirectionMethod = 'По телефону';
  const source = serializeSabyConsignmentNote(snapshot, id, created, '041', { senderTitleVersion: 2 }).xml;
  const attachmentId = '22222222-2222-4222-8222-222222222222';
  const cabinetUrl = `https://tms.saby.ru/opendoc.html?guid=${id}&org=234&f3=234&client=42&file=${attachmentId}&ver=1`;
  const root = parseXml(source), doc = xmlChildren(root, 'Документ')[0], content = xmlChildren(doc, 'СодИнфГО')[0];
  content.attributes.УИД_ТрН = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  xmlChildren(xmlChildren(content, 'УказГО')[0], 'СвПА')[0].attributes.СпосПерУкПА = NATIVE_APPROVED_REDIRECTION_METHOD;
  content.children.push({ name: 'ИнфПол', attributes: { ИдФайлИнфПол: '33333333-3333-4333-8333-333333333333' }, children: [
    { name: 'ТекстИнф', attributes: { Идентиф: 'Документ.СсылкаНаВложение', Значение: `${cabinetUrl}&date=20250401130000` }, children: [] },
  ] });
  const options: SabyConsignmentEvidenceOptions = { senderTitleVersion: 2, phase: 'prepared', nativeAmendment: { beforeMethod: 'По телефону', afterMethod: NATIVE_APPROVED_REDIRECTION_METHOD,
    attachment: { documentId: id, revision: '44444444-4444-4444-8444-444444444444', attachmentId, cabinetUrl, revisionNumber: '1' } } };
  const prepared = utf8(serializeXml(root));
  assert.equal(verifyConsignmentSenderBusiness(prepared, source, undefined, options).operatorUid, content.attributes.УИД_ТрН);
  const previousSecond = change(prepared, '20250401130000', '20250401125959');
  const pinned = { ...options, nativeAmendment: { ...options.nativeAmendment!, preparedXmlSha256: createHash('sha256').update(previousSecond).digest('hex') } };
  assert.doesNotThrow(() => verifyConsignmentSenderBusiness(previousSecond, source, undefined, pinned));
  assert.throws(() => verifyConsignmentSenderBusiness(previousSecond, source, undefined, options));
  assert.throws(() => verifyConsignmentSenderBusiness(prepared, source, undefined, pinned));
  for (const timestamp of ['20250401125958', '20250401130001', '20250230130000']) {
    const changed = change(prepared, '20250401130000', timestamp);
    assert.throws(() => verifyConsignmentSenderBusiness(changed, source, undefined, { ...pinned, nativeAmendment: { ...pinned.nativeAmendment, preparedXmlSha256: createHash('sha256').update(changed).digest('hex') } }));
  }

  assert.doesNotThrow(() => verifyConsignmentSenderBusiness(source, source, undefined, { ...options, phase: 'unprepared' }));
  assert.throws(() => verifyConsignmentSenderBusiness(prepared, source, undefined, { senderTitleVersion: 2, phase: 'prepared' }));
  assert.throws(() => verifyConsignmentSenderBusiness(source, source, undefined, options));
  const locate = (tree: XmlNode) => {
    const content = xmlChildren(xmlChildren(tree, 'Документ')[0], 'СодИнфГО')[0];
    const service = xmlChildren(content, 'ИнфПол').find(node => node.attributes.ИдФайлИнфПол)!;
    return { content, service, link: xmlChildren(service, 'ТекстИнф')[0] };
  };
  const mutations: Array<(context: ReturnType<typeof locate>) => void> = [
    ({ content, service }) => { content.children = content.children.filter(child => child !== service); },
    ({ content, service }) => { content.children.push(structuredClone(service)); },
    ({ service }) => { service.attributes.НеСогласовано = 'Да'; },
    ({ service }) => { service.attributes.ИдФайлИнфПол = 'not-an-id'; },
    ({ service }) => { service.children.push({ name: 'Утверждение', attributes: {}, children: [] }); },
    ({ link }) => { link.children.push('Дополнительное деловое утверждение'); },
    ({ link }) => { link.attributes.Идентиф = 'Другое условие'; },
    ({ link }) => { link.attributes.НеСогласовано = 'Да'; },
    ({ link }) => { link.attributes.Значение += '&client=42'; },
    ({ link }) => { link.attributes.Значение += '&extra=1'; },
    ({ link }) => { link.attributes.Значение += '#fragment'; },
    ({ link }) => { link.attributes.Значение = link.attributes.Значение.replace('tms.saby.ru', 'tms.saby.ru.example'); },
    ({ link }) => { link.attributes.Значение = link.attributes.Значение.replace('https://', 'https://user@'); },
    ({ link }) => { link.attributes.Значение = link.attributes.Значение.replace('client=42', 'client=43'); },
    ({ link }) => { link.attributes.Значение = link.attributes.Значение.replace(attachmentId, id); },
    ({ link }) => { link.attributes.Значение = link.attributes.Значение.replace('ver=1', 'ver=2'); },
    ({ link }) => { link.attributes.Значение = link.attributes.Значение.replace('20250401130000', '20250401130001'); },
    ({ content }) => { xmlChildren(xmlChildren(content, 'ИнфПол')[0], 'ТекстИнф')[0].attributes.Значение = 'changed-source-trip'; },
  ];
  for (const mutate of mutations) {
    const tree = parseXml(prepared); mutate(locate(tree));
    assert.throws(() => verifyConsignmentSenderBusiness(utf8(serializeXml(tree)), source, undefined, options));
  }
});
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

test('v2 requires a provider UID after Prepare, freezes it, and preserves historical UID checks', () => {
  const { snapshot, sender } = setup();
  const unsigned = serializeSabyConsignmentNote(snapshot, id, created, '041', { senderTitleVersion: 2 }).xml;
  const uid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const prepared = change(unsigned, '<СодИнфГО ', `<СодИнфГО УИД_ТрН="${uid}" `);
  assert.doesNotThrow(() => verifyConsignmentSenderBusiness(unsigned, unsigned, undefined, { senderTitleVersion: 2, phase: 'unprepared' }));
  assert.throws(() => verifyConsignmentSenderBusiness(unsigned, unsigned, undefined, { senderTitleVersion: 2 }));
  assert.equal(verifyConsignmentSenderBusiness(prepared, unsigned, undefined, { senderTitleVersion: 2 }).operatorUid, uid);
  assert.equal(verifyConsignmentSenderBusiness(prepared, unsigned, undefined, { senderTitleVersion: 2, operatorUid: uid }).operatorUid, uid);
  assert.throws(() => verifyConsignmentSenderBusiness(prepared, unsigned, undefined, { senderTitleVersion: 2, operatorUid: id }));
  for (const invalid of ['', 'provider-assigned-uid', '00000000-0000-0000-0000-000000000000', `${uid} `]) {
    const malformed = change(prepared, uid, invalid);
    assert.throws(() => verifyConsignmentSenderBusiness(malformed, unsigned, undefined, { senderTitleVersion: 2 }));
  }
  // The old comparison deliberately permits Saby's service UID replacement.
  assert.doesNotThrow(() => verifyConsignmentSenderBusiness(change(sender, `УИД_ТрН="${id}"`, 'УИД_ТрН="historical-service-uid"'), sender));
});

test('v2 carrier must retain the exact verified operator UID and signed sender linkage', () => {
  const { snapshot, carrier } = setup();
  const uid = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const sender = serializeSabyConsignmentNote(snapshot, id, created, '041', { senderTitleVersion: 2 }).xml;
  const prepared = change(sender, '<СодИнфГО ', `<СодИнфГО УИД_ТрН="${uid}" `);
  const reply = change(carrier, `УИД_ТрН="${id}"`, `УИД_ТрН="${uid}"`);
  const options = { senderTitleVersion: 2 as const, operatorUid: uid };
  verifyConsignmentCarrierBusiness(reply, prepared, snapshot, options);
  assert.throws(() => verifyConsignmentCarrierBusiness(carrier, prepared, snapshot, options));
  assert.throws(() => verifyConsignmentCarrierBusiness(reply, prepared, snapshot, { ...options, operatorUid: id }));
  assert.throws(() => verifyConsignmentCarrierBusiness(reply, change(prepared, ` УИД_ТрН="${uid}"`, ''), snapshot, options));
  const missing = change(reply, ` УИД_ТрН="${uid}"`, '');
  assert.throws(() => verifyConsignmentCarrierBusiness(missing, prepared, snapshot, options));
  const filled = fillConsignmentCarrier(missing, prepared, snapshot, options);
  assert.equal(filled.changed, true);
  verifyConsignmentCarrierBusiness(filled.bytes, prepared, snapshot, options);
  assert.throws(() => fillConsignmentCarrier(missing, prepared, snapshot, { ...options, operatorUid: id }));
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

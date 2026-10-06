import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { carrierDetailsInput, carrierXmlHash, patchCarrierDetails } from '../server/saby-carrier-details';
import { fillCarrierDetails, newCarrierFill, verifyCarrierOrder, carrierFastPolling, validateCarrierFill } from '../server/trip-saby-carrier';
import { SabyClient, type SabyDownloadedAttachment } from '../server/saby-client';
import { runTripSabyWorkflow } from '../server/trip-saby-workflow';
import { currentSnapshot } from '../server/shipment-operations';
import { integrationApi, integrationConfig, integrationRuntime } from './helpers/trip-saby-integration';

const uid = '00000000-0000-4000-8000-000000000001';
const senderXml = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Файл ИдФайл="SYNTHETIC-SENDER"><Документ КНД="1110361" ДатИнфГО="01.04.2025" ВрИнфГО="12:00:00"><СодИнфГО УИД_Зак="${uid}"/></Документ></Файл>`);
const emptyDraft = Buffer.from(`<?xml version="1.0" encoding="utf-8"?><Файл ВерсПрог="synthetic" ВерсФорм="5.01" ИдФайл="ON_ZAKZVPR_SYNTHETIC"><Документ КНД="1110362" ДатИнфПрв="01.04.2025" ВрИнфПрв="12:01:00" НаимЭкСубСост="Синтетический перевозчик"><ИдИнфГО ИдФайлИнфГО="SYNTHETIC-SENDER" ДатФайлИнфГО="01.04.2025" ВрФайлИнфГО="12:00:00" ЭП="c3ludGhldGlj"/><СодИнфПрв УИД_Зак="${uid}" СодОпер="1"/><ПодпИнфПрв Должн="Директор" СпосПодтПолном="1"><ФИО Фамилия="Тестовый" Имя="Тест"/></ПодпИнфПрв></Документ></Файл>`);
async function fixture(paymentCalculation?: 'По договору') {
  const f = await integrationRuntime(); const api = integrationApi();
  await f.store.mutate(f.source, data => { Object.assign(data.directories!.drivers.find(d => d.id === 'driver')!, { inn: '010000000102', licenseSeries: '9900', licenseNumber: '123456', licenseIssuedAt: '2024-01-01' }); return { result: null, changed: true }; });
  await runTripSabyWorkflow({ ...f, client: api.client(), createDelivery: async () => { throw new Error('No downstream writes'); } });
  const data = await f.store.read(f.source), record = data.tripSaby!.trips[f.tripId];
  record.carrierFill = newCarrierFill(paymentCalculation);
  const snapshot = currentSnapshot(f.base, data);
  const remote = { Идентификатор: record.order.id, Тип: 'TransportOrder', Направление: 'Входящий', Номер: record.order.number, Дата: '01.04.2025', Состояние: { Код: '10' }, НашаОрганизация: { СвЮЛ: { ИНН: record.snapshot.carrierOrganization.inn, КПП: record.snapshot.carrierOrganization.kpp } }, Контрагент: { СвЮЛ: { ИНН: record.snapshot.customerOrganization.inn, КПП: record.snapshot.customerOrganization.kpp } }, Редакция: [{ Идентификатор: 'carrier-revision', Актуален: 'Да' }], Вложение: [
    { Идентификатор: 'sender', Подтип: '1110361', ВерсияФормата: '5.01', Направление: 'Входящий', Подпись: [{}] },
    { Идентификатор: 'carrier', Подтип: '1110362', ВерсияФормата: '5.01', Направление: 'Исходящий', Файл: { Имя: 'carrier.xml' } },
  ] };
  class Client extends SabyClient {
    bytes = emptyDraft; writes = 0; loseResponse = false; reads = 0;
    constructor() { super(integrationConfig()); }
    override async readCarrierOrder() { this.reads++; return structuredClone(remote); }
    override async downloadCarrierOrderAttachment(_id: string, attachmentId: string): Promise<SabyDownloadedAttachment> { return { id: attachmentId, name: `${attachmentId}.xml`, extension: 'xml', mimeType: 'application/xml', bytes: attachmentId === 'sender' ? senderXml : this.bytes }; }
    override async writeCarrierAttachment(_id: string, _revision: string, _attachmentId: string, _name: string, bytes: Uint8Array) {
      assert.equal(record.carrierFill!.intent!.verified, false, 'intent precedes network');
      this.writes++; this.bytes = Buffer.from(bytes); if (this.loseResponse) throw new Error('Lost response');
    }
  }
  const client = new Client();
  const run = (checkAccess = async () => {}) => fillCarrierDetails({ client, record, snapshot: async () => snapshot, update: async fn => { fn(record); }, checkAccess });
  return { ...f, record, snapshot, remote, client, run };
}
function validateXsd(bytes: Uint8Array) {
  const directory = mkdtempSync(resolve(tmpdir(), 'carrier-xsd-'));
  try { const path = resolve(directory, 'carrier.xml'); writeFileSync(path, bytes); execFileSync('xmllint', ['--noout', '--schema', 'tests/fixtures/saby/transport-order-1110362-5.01.xsd', path], { stdio: 'pipe' }); }
  finally { rmSync(directory, { recursive: true, force: true }); }
}
test('fills driver and vehicle in current unsigned title, validates XSD and repeats without writing', async () => {
  const f = await fixture();
  try {
    await f.run(); assert.equal(f.client.writes, 1); assert.equal(f.record.carrierFill!.state, 'saved', f.record.carrierFill!.blockers.join(' '));
    validateXsd(f.client.bytes);
    const xml = new TextDecoder('windows-1251').decode(f.client.bytes);
    assert.match(xml, /Вместим="25"/); assert.match(xml, /Грузопод="20"/); assert.match(xml, /СерВУ="9900"/);
    assert.match(xml, /ЭП="c3ludGhldGlj"/); assert.match(xml, /Должн="Директор"/); assert.doesNotMatch(xml, /РазмПлатРасчет/);
    await f.run(); assert.equal(f.client.writes, 1); assert.equal(f.record.carrierFill!.vehicleSaved, true);
  } finally { await f.close(); }
});
test('bad payload units do not prevent saving complete driver, and never become tonnes or fabricated vehicle', async () => {
  const f = await fixture();
  try {
    Object.assign(f.snapshot.directories!.vehicles.find(v => v.id === 'vehicle')!, { payloadTonnes: '27900', maxWeight: '27900' });
    await f.run(); assert.equal(f.client.writes, 1); assert.equal(f.record.carrierFill!.state, 'partial');
    assert.equal(f.record.carrierFill!.driverSaved, true); assert.equal(f.record.carrierFill!.vehicleSaved, false);
    assert.match(f.record.carrierFill!.blockers.join(' '), /Проверьте единицы/); validateXsd(f.client.bytes);
    assert.doesNotMatch(new TextDecoder('windows-1251').decode(f.client.bytes), /СвТС/);
    await f.run(); assert.equal(f.client.writes, 1);
  } finally { await f.close(); }
});
test('lost write response recovers by read-back and never writes again', async () => {
  const f = await fixture();
  try {
    f.client.loseResponse = true; await f.run(); assert.equal(f.record.carrierFill!.state, 'unknown'); assert.equal(f.client.writes, 1);
    await f.run(); assert.equal(f.record.carrierFill!.state, 'saved'); assert.equal(f.client.writes, 1);
    assert.equal(f.record.carrierFill!.intent!.verified, true);
  } finally { await f.close(); }
});
test('unknown outcome with old bytes remains unknown, including repeated attempts', async () => {
  const f = await fixture();
  try {
    f.client.loseResponse = true; await f.run(); f.client.bytes = emptyDraft;
    await f.run(); await f.run(); assert.equal(f.client.writes, 1); assert.equal(f.record.carrierFill!.state, 'unknown');
  } finally { await f.close(); }
});
test('signed, foreign and ambiguous carrier titles are never overwritten', async () => {
  const f = await fixture();
  try {
    const signed = structuredClone(f.remote); Object.assign(signed.Вложение[1], { Подпись: [{}] });
    assert.throws(() => verifyCarrierOrder(signed, f.record));
    assert.throws(() => verifyCarrierOrder({ ...f.remote, Направление: 'Исходящий' }, f.record));
    assert.throws(() => verifyCarrierOrder({ ...f.remote, Вложение: [...f.remote.Вложение, f.remote.Вложение[1]] }, f.record));
    await f.run();
    const input = carrierDetailsInput(f.snapshot, f.record); input.driver!.attributes.НомВУ = '654321';
    assert.throws(() => patchCarrierDetails(f.client.bytes, senderXml, input), /перезапись/);
    assert.throws(() => patchCarrierDetails(emptyDraft, Buffer.from(senderXml.toString().replace('SYNTHETIC-SENDER', 'OTHER')), input), /не связан/);
  } finally { await f.close(); }
});
test('draft not available waits; revoked access prevents network; XML DTD is rejected', async () => {
  const f = await fixture();
  try {
    f.remote.Вложение.pop(); await f.run(); assert.equal(f.record.carrierFill!.state, 'waiting'); assert.equal(f.client.writes, 0);
    const reads = f.client.reads; await assert.rejects(f.run(async () => { throw new Error('Permission revoked'); })); assert.equal(f.client.reads, reads);
    assert.throws(() => carrierXmlHash(Buffer.from('<!DOCTYPE x><x/>')));
    f.record.order.remoteStateCode = '4'; f.record.carrierFill = newCarrierFill();
    assert.equal(carrierFastPolling(f.record), true); assert.equal(carrierFastPolling(f.record, Date.now() + 601_000), false);
  } finally { await f.close(); }
});


test('explicitly agreed maximum in tonnes fills vehicle without deriving a payload from tare mass', async () => {
  const f = await fixture();
  try {
    Object.assign(f.snapshot.directories!.vehicles.find(v => v.id === 'vehicle')!, { payloadTonnes: '27.9', maxWeight: '27900' });
    await f.run(); assert.equal(f.record.carrierFill!.state, 'saved', f.record.carrierFill!.blockers.join(' '));
    assert.equal(f.record.carrierFill!.vehicleSaved, true);
    assert.match(new TextDecoder('windows-1251').decode(f.client.bytes), /Грузопод="27.9"/);
    validateXsd(f.client.bytes);
    await f.run(); assert.equal(f.client.writes, 1);
  } finally { await f.close(); }
});

test('configured responsible is added once with one phone; VAT and fees stay unchanged', async () => {
  const f = await fixture();
  try {
    f.client.config.carrierResponsible = { surname: 'Ответственный', name: 'Тест', patronymic: 'Тестович', phone: '+79990000000' };
    const payment = '<РазмПлатРасчет Расчет="По Договору"/>';
    f.client.bytes = Buffer.from(emptyDraft.toString().replace('/><ПодпИнфПрв', `>${payment}</СодИнфПрв><ПодпИнфПрв`));
    await f.run(); assert.equal(f.record.carrierFill!.state, 'saved', f.record.carrierFill!.blockers.join(' '));
    assert.equal(f.record.carrierFill!.responsibleSaved, true); validateXsd(f.client.bytes);
    const xml = new TextDecoder('windows-1251').decode(f.client.bytes);
    assert.match(xml, /<СвЛицОргПрвз><Тлф>\+79990000000<\/Тлф><ФИО/);
    assert.equal(xml.split('+79990000000').length - 1, 1);
    assert.match(xml, /<РазмПлатРасчет Расчет="По Договору"><\/РазмПлатРасчет>/);
    assert.doesNotMatch(xml, /НалСт|СтТовБезНДС|СтТовУчНал/);
    await f.run(); assert.equal(f.client.writes, 1);
    f.client.config.carrierResponsible.name = 'Другой';
    await f.run(); assert.equal(f.client.writes, 2); assert.equal(f.record.carrierFill!.state, 'saved');
    assert.match(new TextDecoder('windows-1251').decode(f.client.bytes), /Имя="Другой"/);
  } finally { await f.close(); }
});

test('directory correction refreshes only our verified unchanged draft, preserves VAT, and repeats without writing', async () => {
  const f = await fixture();
  try {
    await f.run();
    Object.assign(f.snapshot.directories!.vehicles.find(v => v.id === 'vehicle')!, { ownershipType: '3', leaseDocumentName: 'Договор аренды', leaseDocumentNumber: '4', leaseDocumentDate: '2024-12-01', leaseDocumentIssuerInn: '010000000102' });
    f.client.config.carrierResponsible = { surname: 'Ответственный', name: 'Тест', patronymic: 'Тестович', phone: '+79990000000' };
    await f.run(); assert.equal(f.client.writes, 2); assert.equal(f.record.carrierFill!.state, 'saved');
    assert.equal(f.record.carrierFill!.responsibleSaved, true);
    const xml = new TextDecoder('windows-1251').decode(f.client.bytes);
    assert.match(xml, /<ИННФЛ>010000000102<\/ИННФЛ>/); assert.doesNotMatch(xml, /РазмПлатРасчет/);
    validateXsd(f.client.bytes);
    await f.run(); assert.equal(f.client.writes, 2);
  } finally { await f.close(); }
});

test('manual edits or different revision cannot authorize directory overwrite from an earlier verified intent', async () => {
  for (const change of ['manual', 'revision', 'attachment']) {
    const f = await fixture();
    try {
      await f.run();
      f.snapshot.directories!.vehicles.find(v => v.id === 'vehicle')!.payloadTonnes = '19';
      if (change === 'manual') f.client.bytes = Buffer.from(new TextDecoder('windows-1251').decode(f.client.bytes).replace('encoding="windows-1251"', 'encoding="utf-8"').replace('</СодИнфПрв>', '<РазмПлатРасчет Расчет="Ручное условие"/></СодИнфПрв>'));
      if (change === 'revision') f.record.carrierFill!.intent!.revision = 'older';
      if (change === 'attachment') f.record.carrierFill!.intent!.attachmentId = 'other';
      const before = carrierXmlHash(f.client.bytes);
      await f.run(); assert.equal(f.client.writes, 1); assert.equal(f.record.carrierFill!.state, 'blocked');
      assert.equal(carrierXmlHash(f.client.bytes), before);
    } finally { await f.close(); }
  }
});

test('responsible survives lost response recovery; invalid configuration cannot report fully saved', async () => {
  const f = await fixture();
  try {
    f.client.config.carrierResponsible = { surname: 'Ответственный', name: 'Тест', patronymic: 'Тестович', phone: '+79990000000' };
    f.client.loseResponse = true; await f.run(); assert.equal(f.record.carrierFill!.state, 'unknown');
    await f.run(); assert.equal(f.record.carrierFill!.state, 'saved'); assert.equal(f.record.carrierFill!.responsibleSaved, true); assert.equal(f.client.writes, 1);
    f.client.config.carrierResponsible = null;
    await f.run(); assert.equal(f.record.carrierFill!.state, 'partial'); assert.equal(f.record.carrierFill!.responsibleSaved, false); assert.equal(f.client.writes, 1);
  } finally { await f.close(); }
});

function validatePaymentRules(bytes: Uint8Array) {
  const directory = mkdtempSync(resolve(tmpdir(), 'carrier-payment-rules-'));
  try {
    const path = resolve(directory, 'carrier.xml'); writeFileSync(path, bytes);
    const schema = readFileSync('tests/fixtures/saby/transport-order-1110362-5.01.xsd', 'utf8');
    // xmllint --schema does not execute Saby's embedded Schematron rules.
    // Evaluate the payment rules from the official fixture separately.
    const rules = [...schema.matchAll(/<sch:assert test="([^"]+)">\s*<usch:error>([^<]+)<\/usch:error>/g)];
    for (const [code, context] of [
      ['0001.006.406.020', '/Файл/Документ/СодИнфПрв'],
      ['0001.006.406.028', '/Файл/Документ/СодИнфПрв/РазмПлатРасчет'],
      ['0001.006.406.029', '/Файл/Документ/СодИнфПрв/РазмПлатРасчет'],
    ]) {
      const rule = rules.find(match => match[2] === code); assert.ok(rule, code);
      // macOS libxml2's XPath lexer rejects Cyrillic names in CLI expressions;
      // equivalent local-name selectors preserve the official rule semantics.
      const expression = `boolean(${context}[${rule[1]}])`.replace(/[А-Яа-яЁё_]+/g, name => `*[local-name()="${name}"]`);
      assert.equal(execFileSync('xmllint', ['--xpath', expression, path], { encoding: 'utf8', stdio: 'pipe' }).trim(), 'true', code);
    }
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('new workflow freezes payment policy; legacy fills stay valid and do not adopt it on resume', async () => {
  const f = await fixture();
  try {
    const initial = await f.store.read(f.source);
    assert.equal(initial.tripSaby!.trips[f.tripId].carrierFill!.paymentCalculation, 'По договору');
    validateCarrierFill(initial.tripSaby!.trips[f.tripId].carrierFill);
    await f.store.mutate(f.source, data => {
      delete data.tripSaby!.trips[f.tripId].carrierFill!.paymentCalculation;
      return { result: null, changed: true };
    });
    const api = integrationApi();
    await runTripSabyWorkflow({ ...f, client: api.client(), createDelivery: async () => { throw new Error('No downstream writes'); } });
    const resumed = (await f.store.read(f.source)).tripSaby!.trips[f.tripId];
    assert.equal(Object.hasOwn(resumed.carrierFill!, 'paymentCalculation'), false);
    validateCarrierFill(resumed.carrierFill);
    assert.throws(() => validateCarrierFill({ ...resumed.carrierFill, paymentCalculation: 'Другое условие' }), /payment calculation/);
  } finally { await f.close(); }
});

test('future carrier fill sets exact agreed payment text, satisfies payment rules and keeps cost and VAT absent', async () => {
  const f = await fixture('По договору');
  try {
    await f.run(); assert.equal(f.record.carrierFill!.state, 'saved');
    const xml = new TextDecoder('windows-1251').decode(f.client.bytes);
    assert.match(xml, /<РазмПлатРасчет Расчет="По договору"><\/РазмПлатРасчет>/);
    assert.doesNotMatch(xml, /СтТовБезНДС|СтТовУчНал|НалСт|КодОКВ|ВалНаим/);
    validateXsd(f.client.bytes); validatePaymentRules(f.client.bytes);
    assert.throws(() => validatePaymentRules(emptyDraft), /0001.006.406.020/);
    const intent = structuredClone(f.record.carrierFill!.intent);
    await f.run(); assert.equal(f.client.writes, 1);
    assert.deepEqual(f.record.carrierFill!.intent, intent);
    assert.equal(f.record.carrierFill!.paymentCalculation, 'По договору');
  } finally { await f.close(); }
});

test('payment text fills only its attribute and preserves all existing amount, currency and VAT values', async () => {
  for (const existing of ['<РазмПлатРасчет СтТовБезНДС="0.00"/>', '<РазмПлатРасчет СтТовБезНДС="100.00" СтТовУчНал="120.00" НалСт="20%" КодОКВ="643" ВалНаим="Российский рубль" Расчет=""/>']) {
    const f = await fixture('По договору');
    try {
      f.client.bytes = Buffer.from(emptyDraft.toString().replace('/><ПодпИнфПрв', `>${existing}</СодИнфПрв><ПодпИнфПрв`));
      await f.run(); assert.equal(f.record.carrierFill!.state, 'saved');
      const xml = new TextDecoder('windows-1251').decode(f.client.bytes);
      assert.match(xml, /Расчет="По договору"/);
      for (const [attribute] of existing.matchAll(/(?:СтТовБезНДС|СтТовУчНал|НалСт|КодОКВ|ВалНаим)="[^"]*"/g)) assert.ok(xml.includes(attribute), attribute);
      if (!existing.includes('НалСт')) assert.doesNotMatch(xml, /НалСт/);
      validateXsd(f.client.bytes);
      if (existing.includes('НалСт')) validatePaymentRules(f.client.bytes);
      await f.run(); assert.equal(f.client.writes, 1);
    } finally { await f.close(); }
  }
});

test('different prefilled payment condition and ambiguous payment blocks never permit any write', async () => {
  for (const existing of ['<РазмПлатРасчет Расчет="По Договору"/>', '<РазмПлатРасчет Расчет="Ручное условие"/>', '<РазмПлатРасчет/><РазмПлатРасчет/>']) {
    const f = await fixture('По договору');
    try {
      f.client.bytes = Buffer.from(emptyDraft.toString().replace('/><ПодпИнфПрв', `>${existing}</СодИнфПрв><ПодпИнфПрв`));
      const before = carrierXmlHash(f.client.bytes);
      assert.throws(() => patchCarrierDetails(f.client.bytes, senderXml, carrierDetailsInput(f.snapshot, f.record), before));
      await f.run(); assert.equal(f.record.carrierFill!.state, 'blocked'); assert.equal(f.client.writes, 0);
      assert.equal(carrierXmlHash(f.client.bytes), before);
    } finally { await f.close(); }
  }
});

test('future payment policy recovers a lost write by read-back with no duplicate write', async () => {
  const f = await fixture('По договору');
  try {
    f.client.loseResponse = true; await f.run(); assert.equal(f.record.carrierFill!.state, 'unknown');
    await f.run(); assert.equal(f.record.carrierFill!.state, 'saved'); assert.equal(f.client.writes, 1);
    assert.equal(f.record.carrierFill!.intent!.verified, true);
    assert.equal(f.record.carrierFill!.paymentCalculation, 'По договору'); validatePaymentRules(f.client.bytes);
  } finally { await f.close(); }
});

test('manual payment removal and later manual changes are blocked without reapplying the policy', async () => {
  for (const change of ['remove', 'empty', 'other', 'amount', 'revision']) {
    const f = await fixture('По договору');
    try {
      await f.run();
      let xml = new TextDecoder('windows-1251').decode(f.client.bytes).replace('encoding="windows-1251"', 'encoding="utf-8"');
      if (change === 'remove') xml = xml.replace(/<РазмПлатРасчет[^>]*><\/РазмПлатРасчет>/, '');
      if (change === 'empty') xml = xml.replace('Расчет="По договору"', 'Расчет=""');
      if (change === 'other') xml = xml.replace('Расчет="По договору"', 'Расчет="Ручное условие"');
      if (change === 'amount') xml = xml.replace('Расчет="По договору"', 'Расчет="По договору" СтТовБезНДС="55.00"');
      if (change === 'revision') f.remote.Редакция[0].Идентификатор = 'changed-revision';
      f.client.bytes = Buffer.from(xml);
      const before = carrierXmlHash(f.client.bytes), intent = structuredClone(f.record.carrierFill!.intent);
      await f.run(); assert.equal(f.record.carrierFill!.state, 'blocked'); assert.equal(f.client.writes, 1);
      assert.equal(carrierXmlHash(f.client.bytes), before); assert.deepEqual(f.record.carrierFill!.intent, intent);
    } finally { await f.close(); }
  }
});

test('an already matching response freezes verified evidence without an external write', async () => {
  const f = await fixture('По договору');
  try {
    f.client.bytes = Buffer.from(patchCarrierDetails(emptyDraft, senderXml, carrierDetailsInput(f.snapshot, f.record, f.client.config.carrierResponsible)).xml);
    await f.run(); assert.equal(f.record.carrierFill!.state, 'saved'); assert.equal(f.client.writes, 0);
    assert.equal(f.record.carrierFill!.intent!.verified, true);
    assert.equal(f.record.carrierFill!.intent!.afterHash, carrierXmlHash(f.client.bytes));
    await f.run(); assert.equal(f.client.writes, 0); validatePaymentRules(f.client.bytes);
  } finally { await f.close(); }
});

test('a concurrent edit prevents freezing no-write evidence for an already matching response', async () => {
  const f = await fixture('По договору');
  try {
    f.client.bytes = Buffer.from(patchCarrierDetails(emptyDraft, senderXml, carrierDetailsInput(f.snapshot, f.record, f.client.config.carrierResponsible)).xml);
    const read = f.client.readCarrierOrder.bind(f.client);
    f.client.readCarrierOrder = async () => {
      const remote = await read();
      if (f.client.reads === 2) f.client.bytes = emptyDraft;
      return remote;
    };
    await f.run(); assert.equal(f.record.carrierFill!.state, 'blocked'); assert.equal(f.client.writes, 0);
    assert.equal(f.record.carrierFill!.intent, undefined);
  } finally { await f.close(); }
});

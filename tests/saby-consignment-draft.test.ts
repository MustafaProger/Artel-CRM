import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { syntheticEtrnFixture } from './helpers/etrn-fixture';
import { fillConsignmentDraft, hasExactConsignmentOrderLink, verifyConsignmentDraftUpdate, verifyDraftRequestedFields } from '../server/saby-consignment-draft';
import { serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { parseXml, type XmlNode } from '../server/saby-order-evidence';
import { serializeXml } from '../server/saby-carrier-details';
import { encodeWindows1251 } from '../server/saby-transport-order';
import { type SabyObject, SabyError } from '../server/saby-client';

const children = (node: XmlNode, name: string) => node.children.filter((child): child is XmlNode => typeof child !== 'string' && child.name === name);
const child = (node: XmlNode, name: string) => { const nodes = children(node, name); assert.equal(nodes.length, 1); return nodes[0]; };
const node = (name: string, attributes: Record<string, string> = {}, values: Array<XmlNode | string> = []): XmlNode => ({ name, attributes, children: values });
const bytes = (root: XmlNode) => encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(root));
const content = (root: XmlNode) => child(child(root, 'Документ'), 'СодИнфГО');
const sha = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const rejects = (run: () => unknown) => assert.throws(run, error => error instanceof SabyError);

function fixture() {
  const { snapshot } = syntheticEtrnFixture();
  snapshot.fields.quantity_litres = '17500';
  snapshot.profile.vehicle.capacityCubicMetres = '20';
  snapshot.profile.cargo.packageCount = '1';
  snapshot.profile.deliveryMassTonnes = '14.69';
  snapshot.profile.plannedGrossMassTonnes = '14.69';
  snapshot.profile.massSource = 'driver'; snapshot.profile.plannedMassKind = 'net';
  snapshot.profile.loading.grossMassTonnes = '14.69'; snapshot.profile.loading.massMethod = '03';
  const number = '17';
  const generated = serializeSabyConsignmentNote(snapshot, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2025-04-01T09:20:30.000Z', number).xml;
  const root = parseXml(generated), info = content(root);
  root.attributes.ИдФайл = 'ON_TRNACLGROT_NATIVE_SYNTHETIC'; root.attributes.ВерсПрог = 'NativeSynthetic';
  info.attributes.УИД_ТрН = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  info.children = info.children.filter(value => typeof value === 'string' || value.name !== 'СвГП');
  const sender = child(child(info, 'СвГО'), 'РекИдентГО');
  child(sender, 'Адрес').children = [node('АдрРФ', { Индекс: '000000', КодРегион: '77', Улица: 'Синтетическая' })];
  const cargo = child(child(info, 'СвГруз'), 'ОпГруз');
  cargo.attributes.СпУпак = 'Нативное описание упаковки'; child(cargo, 'Марк').children = ['Нативная маркировка'];
  child(info, 'УказГО').attributes.УкНормПрвз = 'Сохранить нативные указания';
  child(child(child(info, 'СвТС'), 'ТС'), 'ПарТС').attributes.Марка = 'СИНТЕТИЧЕСКАЯ МАРКА';
  child(child(info, 'СвПогруз'), 'СвЛицПогрГр').attributes['НативныйПризнак'] = 'Сохранить';
  const loading = child(info, 'СвПогруз');
  for (const key of ['ФДатВрУбыт', 'НалКоорТочВрФУбыт', 'МасБрутОтгр', 'КолМестПрием']) delete loading.attributes[key];
  loading.attributes.ФДатВрПриб = '01.04.2025T08:05:00+03:00';
  loading.attributes.ФСостКуз = 'Нативное состояние кузова';
  return { snapshot, number, root, native: bytes(root), generated };
}

function omitRequested(root: XmlNode) {
  const copy = structuredClone(root), info = content(copy);
  info.children = info.children.filter(value => typeof value === 'string' || value.name !== 'СвГП');
  const loading = child(info, 'СвПогруз');
  for (const key of ['ФДатВрПриб', 'НалКоорТочВрФПогр', 'ФДатВрУбыт', 'НалКоорТочВрФУбыт', 'МасБрутОтгр', 'КолМестПрием']) delete loading.attributes[key];
  return copy;
}

test('fills the missing native recipient and driver events/count/gross while preserving every unrelated node', () => {
  const f = fixture();
  const filled = fillConsignmentDraft(f.native, f.snapshot, f.number);
  assert.equal(filled.changed, true);
  assert.equal(filled.beforeHash, sha(f.native)); assert.equal(filled.afterHash, sha(filled.bytes));
  assert.deepEqual(filled.fields, { recipientInn: f.snapshot.profile.recipient.inn, recipientKpp: f.snapshot.profile.recipient.kpp,
    deliveryAddress: f.snapshot.fields.unloading_address, arrivedAt: '01.04.2025T08:20:30+03:00', departedAt: '01.04.2025T09:25:35+03:00', grossMassKg: '14690', packageCount: '1' });
  assert.deepEqual(omitRequested(parseXml(filled.bytes)), omitRequested(f.root));
  const result = content(parseXml(filled.bytes));
  assert.equal(child(child(child(result, 'СвГП'), 'АдресДостГр'), 'АдресИнф').attributes.АдрТекст, f.snapshot.fields.unloading_address);
  assert.equal(child(result, 'СвПогруз').attributes.МетОпрМасс, '03');
  assert.equal(child(child(result, 'СвГруз'), 'ОпГруз').attributes.СпУпак, 'Нативное описание упаковки');
  verifyDraftRequestedFields(filled.bytes, f.snapshot, f.number);
  verifyConsignmentDraftUpdate(filled.bytes, filled.bytes);
  const again = fillConsignmentDraft(filled.bytes, f.snapshot, f.number);
  assert.equal(again.changed, false); assert.equal(again.bytes, filled.bytes); assert.equal(again.beforeHash, again.afterHash);
});

test('numerically equivalent anchors and filled targets do not require replacing native values', () => {
  const f = fixture(), info = content(f.root), cargo = child(child(info, 'СвГруз'), 'ОпГруз');
  cargo.attributes.Объем = '17.500'; cargo.attributes.КолМестГр = '01';
  const mass = child(cargo, 'ПлМасГруз'); mass.attributes.МасНетЗнач = '14690.000'; mass.attributes.МасБрутЗнач = '14690.0';
  const filled = fillConsignmentDraft(bytes(f.root), f.snapshot, f.number);
  const current = parseXml(filled.bytes), loading = child(content(current), 'СвПогруз');
  loading.attributes.МасБрутОтгр = '14690.000'; loading.attributes.КолМестПрием = '01';
  const equivalent = bytes(current);
  verifyDraftRequestedFields(equivalent, f.snapshot, f.number);
  verifyConsignmentDraftUpdate(equivalent, filled.bytes);
  assert.equal(fillConsignmentDraft(equivalent, f.snapshot, f.number).changed, false);
});

test('only the exact completely empty native recipient shell may be replaced', () => {
  const shell = node('СвГП', {}, [node('РекИдентГП', {}, [node('ИдСв'), node('Контакт')]), node('АдресДостГр')]);
  const f = fixture(), info = content(f.root);
  info.children.splice(info.children.indexOf(child(info, 'СвГруз')), 0, structuredClone(shell));
  const filled = fillConsignmentDraft(bytes(f.root), f.snapshot, f.number);
  verifyDraftRequestedFields(filled.bytes, f.snapshot, f.number);
  assert.deepEqual(omitRequested(parseXml(filled.bytes)), omitRequested(f.root));
  for (const mutate of [
    (r: XmlNode) => { r.attributes.Примечание = 'Заполнено'; },
    (r: XmlNode) => { r.children.push('Сохранить этот текст'); },
    (r: XmlNode) => { child(r, 'АдресДостГр').children.push(node('АдресИнф', { АдрТекст: 'Ручной адрес' })); },
    (r: XmlNode) => { child(child(r, 'РекИдентГП'), 'Контакт').children.push(node('Тлф', {}, ['Ручной контакт'])); },
    (r: XmlNode) => { child(child(r, 'РекИдентГП'), 'ИдСв').children.push(node('СвЮЛУч', { ИННЮЛ: '1234567890' })); },
    (r: XmlNode) => { r.children.push(node('НеизвестноеПоле')); },
    (r: XmlNode) => { child(r, 'РекИдентГП').children.reverse(); },
  ]) {
    const changed = structuredClone(f.root); mutate(child(content(changed), 'СвГП'));
    rejects(() => fillConsignmentDraft(bytes(changed), f.snapshot, f.number));
  }
});

test('existing recipient retains native legal address/contact details but conflicting identity or delivery site blocks', () => {
  const f = fixture(); const filled = fillConsignmentDraft(f.native, f.snapshot, f.number);
  const root = parseXml(filled.bytes), gp = child(content(root), 'СвГП');
  child(child(gp, 'РекИдентГП'), 'Адрес').children = [node('АдрРФ', { КодРегион: '77', Город: 'Синтетический' })];
  child(child(child(gp, 'РекИдентГП'), 'Контакт'), 'Тлф').children = ['Нативный контакт'];
  const nativeRecipient = bytes(root);
  assert.equal(fillConsignmentDraft(nativeRecipient, f.snapshot, f.number).bytes, nativeRecipient);
  for (const mutate of [
    (g: XmlNode) => { child(child(child(g, 'РекИдентГП'), 'ИдСв'), 'СвЮЛУч').attributes.ИННЮЛ = '1234567890'; },
    (g: XmlNode) => { child(child(child(g, 'РекИдентГП'), 'ИдСв'), 'СвЮЛУч').attributes.КПП = '123456789'; },
    (g: XmlNode) => { child(child(g, 'АдресДостГр'), 'АдресИнф').attributes.АдрТекст = 'Чужая площадка'; },
  ]) {
    const changed = structuredClone(root); mutate(child(content(changed), 'СвГП'));
    rejects(() => fillConsignmentDraft(bytes(changed), f.snapshot, f.number));
  }
});

test('every known recipient/order/cargo/driver/vehicle/loading anchor is required and conflicts stop filling', () => {
  const mutations: Array<(info: XmlNode) => void> = [
    info => { info.attributes.НомерТрН = '18'; }, info => { info.attributes.ДатаТрН = '02.04.2025'; },
    info => { info.attributes.НомЗак = 'OTHER'; }, info => { info.attributes.ДатаЗак = '01.04.2025'; },
    info => { child(child(child(child(info, 'СвГО'), 'РекИдентГО'), 'ИдСв'), 'СвЮЛУч').attributes.ИННЮЛ = '1234567890'; },
    info => { child(child(child(info, 'СвПер'), 'ИдСв'), 'СвЮЛУч').attributes.КПП = '123456789'; },
    info => { child(child(info, 'СвГруз'), 'ОпГруз').attributes.НаимГруз = 'Иной груз'; },
    info => { child(child(info, 'СвГруз'), 'ОпГруз').attributes.Объем = '17.6'; },
    info => { child(child(info, 'СвГруз'), 'ОпГруз').attributes.КолМестГр = '2'; },
    info => { child(child(child(info, 'СвГруз'), 'ОпГруз'), 'ПлМасГруз').attributes.МасБрутЗнач = '14691'; },
    info => { child(child(child(info, 'СвГруз'), 'ОпГруз'), 'ПлМасГруз').attributes.МасНетЗнач = '14691'; },
    info => { child(info, 'СвВодит').attributes.ИННФЛ = '123456789012'; },
    info => { child(info, 'СвВодит').attributes.СерВУ = '7777'; },
    info => { child(info, 'СвВодит').attributes.НомВУ = '999999'; },
    info => { child(info, 'СвВодит').attributes.ДатаВыдВУ = '02.02.2020'; },
    info => { child(child(info, 'СвТС'), 'ТС').attributes.РегНомер = 'Т111ТТ00'; },
    info => { child(child(info, 'СвТС'), 'ТС').attributes.НомерВИН = 'SYNTHETICVIN00002'; },
    info => { child(child(child(info, 'СвПогруз'), 'ФАдресПогр'), 'АдресИнф').attributes.АдрТекст = 'Другая погрузка'; },
  ];
  for (const mutate of mutations) {
    const f = fixture(); mutate(content(f.root)); rejects(() => fillConsignmentDraft(bytes(f.root), f.snapshot, f.number));
  }
});

test('multiple or malformed cargo, recipient, driver and role structures never select an arbitrary first', () => {
  for (const key of ['СвГруз', 'СвВодит', 'СвТС', 'СвГО', 'СвПер', 'СвПогруз']) {
    const f = fixture(), info = content(f.root); info.children.push(structuredClone(child(info, key)));
    rejects(() => fillConsignmentDraft(bytes(f.root), f.snapshot, f.number));
  }
  const f = fixture(), filled = fillConsignmentDraft(f.native, f.snapshot, f.number), root = parseXml(filled.bytes), info = content(root);
  info.children.push(structuredClone(child(info, 'СвГП')));
  rejects(() => fillConsignmentDraft(bytes(root), f.snapshot, f.number));
  const doubleCargo = fixture(), cargoContainer = child(content(doubleCargo.root), 'СвГруз');
  cargoContainer.children.push(structuredClone(child(cargoContainer, 'ОпГруз')));
  rejects(() => fillConsignmentDraft(bytes(doubleCargo.root), doubleCargo.snapshot, doubleCargo.number));
  rejects(() => fillConsignmentDraft(encodeWindows1251('<!DOCTYPE bad><Файл/>'), f.snapshot, f.number));
});

test('conflicting previous loading mass/count require reconciliation; actual times are replaced from driver facts', () => {
  for (const [key, value] of [['МасБрутОтгр', '1'], ['КолМестПрием', '2'], ['МасБрутОтгр', 'not-a-number']]) {
    const f = fixture(); child(content(f.root), 'СвПогруз').attributes[key] = value;
    rejects(() => fillConsignmentDraft(bytes(f.root), f.snapshot, f.number));
  }
  const f = fixture(), loading = child(content(f.root), 'СвПогруз');
  loading.attributes.ФДатВрУбыт = '01.04.2025T08:30:00+03:00';
  const filled = fillConsignmentDraft(bytes(f.root), f.snapshot, f.number);
  assert.equal(child(content(parseXml(filled.bytes)), 'СвПогруз').attributes.ФДатВрУбыт, '01.04.2025T09:25:35+03:00');
});

test('read-back compares every preserved native field, signer and UID while permitting generated headers', () => {
  const f = fixture(), filled = fillConsignmentDraft(f.native, f.snapshot, f.number), root = parseXml(filled.bytes);
  root.attributes.ИдФайл = 'ON_TRNACLGROT_NATIVE_NEW_NAME'; root.attributes.ВерсПрог = 'NativeNew';
  child(root, 'Документ').attributes.ДатИнфГО = '02.04.2025'; child(root, 'Документ').attributes.ВрИнфГО = '12:13:14';
  verifyConsignmentDraftUpdate(bytes(root), filled.bytes);
  for (const mutate of [
    (r: XmlNode) => { child(content(r), 'УказГО').attributes.УкНормПрвз = 'Изменённые указания'; },
    (r: XmlNode) => { child(child(content(r), 'СвГруз'), 'ОпГруз').attributes.СпУпак = 'Изменённая упаковка'; },
    (r: XmlNode) => { content(r).attributes.УИД_ТрН = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc'; },
    (r: XmlNode) => { child(child(r, 'Документ'), 'Подписант').attributes.Должн = 'Другой подписант'; },
    (r: XmlNode) => { child(content(r), 'СвПогруз').attributes.ФСостКуз = 'Другое состояние'; },
    (r: XmlNode) => { content(r).children.push(node('НовыеСведения', { Значение: 'Не согласовано' })); },
    (r: XmlNode) => { content(r).children.reverse(); },
  ]) { const changed = structuredClone(root); mutate(changed); rejects(() => verifyConsignmentDraftUpdate(bytes(changed), filled.bytes)); }
});

test('requested-field verification rejects missing or changed targets without treating unrelated native data as CRM equivalence', () => {
  const f = fixture(); rejects(() => verifyDraftRequestedFields(f.native, f.snapshot, f.number));
  const filled = fillConsignmentDraft(f.native, f.snapshot, f.number);
  for (const key of ['ФДатВрПриб', 'НалКоорТочВрФПогр', 'ФДатВрУбыт', 'НалКоорТочВрФУбыт', 'МасБрутОтгр', 'КолМестПрием']) {
    const root = parseXml(filled.bytes); delete child(content(root), 'СвПогруз').attributes[key];
    rejects(() => verifyDraftRequestedFields(bytes(root), f.snapshot, f.number));
  }
});

function linked() {
  const note: SabyObject = { Идентификатор: 'note-synthetic', Тип: 'ConsignmentNote', Номер: '17', Дата: '01.04.2025' };
  const order: SabyObject = { Идентификатор: 'order-synthetic', Тип: 'TransportOrder', Номер: '19', Дата: '01.04.2025' };
  note.ДокументОснование = [{ ВидСвязи: '', Документ: { ...order }, Сумма: '' }];
  order.ДокументСледствие = [{ ВидСвязи: '', Документ: { Идентификатор: note.Идентификатор, Тип: note.Тип, Номер: note.Номер, Дата: note.Дата }, Сумма: '' }];
  return { note, order };
}
test('native note identity requires exact reciprocal source links; number-only discovery and ambiguous sources fail', () => {
  const { note, order } = linked(); assert.equal(hasExactConsignmentOrderLink(note, order), true);
  (order.ДокументСледствие as SabyObject[]).push({ Документ: { Идентификатор: 'other-delivery-note', Тип: 'ConsignmentNote', Номер: '18', Дата: '01.04.2025' } });
  assert.equal(hasExactConsignmentOrderLink(note, order), true);
  for (const mutate of [
    (n: SabyObject, _o: SabyObject) => { delete n.ДокументОснование; },
    (_n: SabyObject, o: SabyObject) => { delete o.ДокументСледствие; },
    (n: SabyObject, _o: SabyObject) => { ((n.ДокументОснование as SabyObject[])[0].Документ as SabyObject).Идентификатор = 'other-order'; },
    (n: SabyObject, _o: SabyObject) => { delete ((n.ДокументОснование as SabyObject[])[0].Документ as SabyObject).Идентификатор; },
    (n: SabyObject, _o: SabyObject) => { ((n.ДокументОснование as SabyObject[])[0].Документ as SabyObject).Номер = '20'; },
    (n: SabyObject, _o: SabyObject) => { ((n.ДокументОснование as SabyObject[])[0].Документ as SabyObject).Дата = '02.04.2025'; },
    (n: SabyObject, _o: SabyObject) => { (n.ДокументОснование as SabyObject[]).push(structuredClone((n.ДокументОснование as SabyObject[])[0])); },
    (_n: SabyObject, o: SabyObject) => { (o.ДокументСледствие as SabyObject[]).push(structuredClone((o.ДокументСледствие as SabyObject[])[0])); },
    (n: SabyObject, _o: SabyObject) => { (n.ДокументОснование as SabyObject[]).push({ Документ: {} }); },
    (_n: SabyObject, o: SabyObject) => { (o.ДокументСледствие as SabyObject[]).push({}); },
    (n: SabyObject, _o: SabyObject) => { n.Удален = 'Да'; },
    (_n: SabyObject, o: SabyObject) => { o.ЧастичныеДанные = 'Да'; },
  ]) { const pair = linked(); mutate(pair.note, pair.order); assert.equal(hasExactConsignmentOrderLink(pair.note, pair.order), false); }
});

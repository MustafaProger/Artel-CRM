import assert from 'node:assert/strict';
import test from 'node:test';
import { carrierBusinessHash, verifySabyCarrierBusiness, verifySabySenderBusiness, verifySabyCarrierVehicleAddition } from '../server/saby-order-evidence';
import { encodeWindows1251 } from '../server/saby-transport-order';

// Deliberately synthetic: no real IDs, personal details, signature files or keys.
const xml = `<?xml version="1.0" encoding="utf-8"?>
<Файл ВерсФорм="5.01" ВерсПрог="Synthetic" ИдФайл="SYNTHETIC-CARRIER">
  <Документ КНД="1110362" ДатИнфПрв="01.04.2025" ВрИнфПрв="12:34:56" НаимЭкСубСост="Синтетический перевозчик">
    <ИдИнфГО ИдФайлИнфГО="SYNTHETIC-SENDER" ДатФайлИнфГО="01.04.2025" ВрФайлИнфГО="11:22:33" ЭП="synthetic-source-signature"/>
    <СодИнфПрв СодОпер="1" УИД_Зак="SYNTHETIC-ORDER">
      <СвЛицОргПрвз><Тлф>+70000000001</Тлф><ФИО Фамилия="ОтветственныйТест" Имя="Тест"/></СвЛицОргПрвз>
      <СвВодит НомВУ="123456" СерВУ="9900" ДатаВыдВУ="01.01.2024" ИННФЛ="010000000102"><ФИО Фамилия="ВодительТест" Имя="Тест"/></СвВодит>
      <СвТС><ТС РегНомер="Т001ЕЕ777" ТипВлад="1"><ПарТС Тип="Цистерна" Марка="Тест" Грузопод="27.9" Вместим="17.5"/></ТС></СвТС>
      <ИнфПол><ТекстИдентиф Идентиф="условия" Значен="Синтетические условия"/></ИнфПол>
    </СодИнфПрв>
    <ПодпИнфПрв Должн="Директор" СпосПодтПолном="1"><ФИО Фамилия="ПодписантТест" Имя="Тест"/></ПодпИнфПрв>
  </Документ>
</Файл>`;
const bytes = (value: string) => Buffer.from(value, 'utf8');

test('carrier preparation permits only generated file headers and a valid creation timestamp', () => {
  const prepared = xml.replace('ИдФайл="SYNTHETIC-CARRIER"', 'ИдФайл="SYNTHETIC-PREPARED"')
    .replace('ВерсПрог="Synthetic"', 'ВерсПрог="Saby"').replace('ДатИнфПрв="01.04.2025"', 'ДатИнфПрв="06.10.2026"')
    .replace('ВрИнфПрв="12:34:56"', 'ВрИнфПрв="18:00:01"');
  assert.doesNotThrow(() => verifySabyCarrierBusiness(bytes(prepared), bytes(xml)));
  assert.match(carrierBusinessHash(bytes(xml)), /^[a-f0-9]{64}$/);
  assert.equal(carrierBusinessHash(bytes(prepared)), carrierBusinessHash(bytes(xml)));
  const reordered = prepared.replace('КНД="1110362" ДатИнфПрв="06.10.2026"', 'ДатИнфПрв="06.10.2026" КНД="1110362"').replace(/>\s+</g, '><');
  assert.doesNotThrow(() => verifySabyCarrierBusiness(encodeWindows1251(reordered.replace('encoding="utf-8"', 'encoding="windows-1251"')), bytes(xml)));
});

test('carrier preparation preserves source title linkage, company, signatory and all transport facts', () => {
  for (const [before, after] of [
    ['SYNTHETIC-SENDER', 'OTHER-SENDER'], ['ВрФайлИнфГО="11:22:33"', 'ВрФайлИнфГО="11:22:34"'],
    ['synthetic-source-signature', 'another-source-signature'], ['SYNTHETIC-ORDER', 'OTHER-ORDER'],
    ['СодОпер="1"', 'СодОпер="2"'], ['Синтетический перевозчик', 'Другая организация'],
    ['ПодписантТест', 'ДругойПодписант'], ['СпосПодтПолном="1"', 'СпосПодтПолном="2"'], ['Должн="Директор"', 'Должн="Сотрудник"'],
    ['ОтветственныйТест', 'ДругойОтветственный'], ['+70000000001', '+70000000002'], ['НомВУ="123456"', 'НомВУ="654321"'],
    ['Т001ЕЕ777', 'Т002ЕЕ777'], ['Грузопод="27.9"', 'Грузопод="27900"'], ['Вместим="17.5"', 'Вместим="17500"'],
    ['Синтетические условия', 'Другие условия'],
  ]) assert.throws(() => verifySabyCarrierBusiness(bytes(xml.replace(before, after)), bytes(xml)), undefined, before);
});

test('carrier preparation cannot introduce VAT, payment, unknown fields or exploit nested header exemptions', () => {
  for (const added of ['<РазмПлатРасчет Сумма="1"/>', '<НДС Ставка="0"/>', '<НДС>Без НДС</НДС>', '<Неизвестное/>', '<Файл ИдФайл="NESTED"/>']) {
    assert.throws(() => verifySabyCarrierBusiness(bytes(xml.replace('</СодИнфПрв>', `${added}</СодИнфПрв>`)), bytes(xml)));
  }
  const nested = xml.replace('</СодИнфПрв>', '<Файл ИдФайл="NESTED-A"/></СодИнфПрв>');
  assert.throws(() => verifySabyCarrierBusiness(bytes(nested.replace('NESTED-A', 'NESTED-B')), bytes(nested)));
});

test('carrier preparation rejects invalid dates, absent required headers and duplicate signing nodes', () => {
  for (const corrupt of [
    xml.replace('ДатИнфПрв="01.04.2025"', 'ДатИнфПрв="31.02.2025"'),
    xml.replace('ВрИнфПрв="12:34:56"', 'ВрИнфПрв="25:00:00"'), xml.replace('ИдФайл="SYNTHETIC-CARRIER"', 'ИдФайл=""'),
    xml.replace('ВерсФорм="5.01"', 'ВерсФорм="5.02"'), xml.replace('</Документ>', '<ПодпИнфПрв/></Документ>'),
  ]) assert.throws(() => verifySabyCarrierBusiness(bytes(corrupt), bytes(xml)));
});

const vehicleIdentity = { plate: 'Т001ЕЕ777', vin: 'WDB9300321L123456', stsNumber: '9900123456' };
const addVehicleIds = (source: string, attributes = `НомерВИН="${vehicleIdentity.vin}" НомСТС="${vehicleIdentity.stsNumber}"`) => source.replace('<ТС РегНомер=', `<ТС ${attributes} РегНомер=`);
test('carrier preparation accepts only added vehicle identifiers proven by the complete frozen business hash', () => {
  for (const attributes of [`НомерВИН="${vehicleIdentity.vin}"`, `НомСТС="${vehicleIdentity.stsNumber}"`, `НомерВИН="${vehicleIdentity.vin}" НомСТС="${vehicleIdentity.stsNumber}"`]) {
    const prepared = addVehicleIds(xml, attributes);
    assert.doesNotThrow(() => verifySabyCarrierBusiness(bytes(prepared), bytes(xml), vehicleIdentity));
    assert.throws(() => verifySabyCarrierBusiness(bytes(prepared), bytes(xml)), /Saby изменил/);
    const result = verifySabyCarrierVehicleAddition(bytes(prepared), carrierBusinessHash(bytes(xml)), vehicleIdentity);
    assert.equal(result.businessHash, carrierBusinessHash(bytes(prepared)));
    assert.notEqual(result.businessHash, carrierBusinessHash(bytes(xml)));
  }
  const vinAlreadyPresent = addVehicleIds(xml, `НомерВИН="${vehicleIdentity.vin}"`);
  assert.doesNotThrow(() => verifySabyCarrierBusiness(bytes(addVehicleIds(xml)), bytes(vinAlreadyPresent), vehicleIdentity));
});
test('carrier preparation cannot use known vehicle additions to hide an existing identifier or other business changes', () => {
  const prepared = addVehicleIds(xml), baseline = carrierBusinessHash(bytes(xml));
  for (const corrupt of [
    prepared.replace(vehicleIdentity.vin, 'WDB9300321L654321'), prepared.replace(vehicleIdentity.stsNumber, '9900654321'),
    prepared.replace(vehicleIdentity.plate, 'Т002ЕЕ777'), prepared.replace('ПодписантТест', 'ДругойПодписант'),
    prepared.replace('СпосПодтПолном="1"', 'СпосПодтПолном="2"'), prepared.replace('synthetic-source-signature', 'other-source-signature'),
    prepared.replace('Грузопод="27.9"', 'Грузопод="28.9"'), prepared.replace('</СодИнфПрв>', '<НДС Ставка="0"/></СодИнфПрв>'),
    prepared.replace('</СвТС>', '<ТС РегНомер="Т001ЕЕ777"/></СвТС>'),
    xml.replace('<ПодпИнфПрв ', `<ПодпИнфПрв НомерВИН="${vehicleIdentity.vin}" `),
  ]) assert.throws(() => verifySabyCarrierVehicleAddition(bytes(corrupt), baseline, vehicleIdentity));
  for (const unknown of [{ ...vehicleIdentity, vin: '', stsNumber: '' }, { ...vehicleIdentity, plate: '' }, { ...vehicleIdentity, vin: 'OTHER', stsNumber: 'OTHER' }]) {
    assert.throws(() => verifySabyCarrierVehicleAddition(bytes(prepared), baseline, unknown));
  }
  const knownVin = addVehicleIds(xml, `НомерВИН="WDB9300321L654321"`);
  assert.throws(() => verifySabyCarrierBusiness(bytes(prepared), bytes(knownVin), vehicleIdentity));
  assert.throws(() => verifySabyCarrierBusiness(bytes(xml), bytes(prepared), vehicleIdentity));
  assert.throws(() => verifySabyCarrierVehicleAddition(bytes(xml), baseline, vehicleIdentity));
});

const sender = `<?xml version="1.0" encoding="utf-8"?><Файл ВерсФорм="5.01" ВерсПрог="Synthetic" ИдФайл="SYNTHETIC-SENDER"><Документ КНД="1110361" ДатИнфГО="01.04.2025" ВрИнфГО="11:22:33"><СодИнфГО УИД_Зак="SYNTHETIC-ORDER"><СвГО><ИдСв><СвЮЛУч ИННЮЛ="0148372956" КПП="010101001" НаимОрг="Общество с ограниченной ответственностью &quot;ТЕСТ&quot;"/></ИдСв></СвГО><СвПрв><ИдСв><СвЮЛУч ИННЮЛ="0392816475" КПП="030101001" НаимОрг="ООО «ПЕРЕВОЗЧИК ТЕСТ»"/></ИдСв></СвПрв><ПунктПод><АдрПунктПод><Адрес><АдрРФ>Синтетический адрес</АдрРФ></Адрес></АдрПунктПод></ПунктПод><ОпГруз><МасГруз МасБрутЗнач="14740" МасНетЗнач="14740"/></ОпГруз></СодИнфГО><ПодпИнфГО/></Документ></Файл>`;
test('sender comparison accepts provably equivalent legal names and decimal padding only', () => {
  const normalized = sender.replace('Общество с ограниченной ответственностью &quot;ТЕСТ&quot;', 'Тест, ООО')
    .replace('ООО «ПЕРЕВОЗЧИК ТЕСТ»', 'Перевозчик тест, ООО').replaceAll('="14740"', '="14740.000"');
  assert.doesNotThrow(() => verifySabySenderBusiness(bytes(normalized), bytes(sender)));
  for (const corrupt of [normalized.replace('Тест, ООО', 'Другой тест, ООО'), normalized.replace('0148372956', '0199999999'), normalized.replace('010101001', '010101002'), normalized.replace('14740.000', '14740.001'), normalized.replace('14740.000', '14.740')]) {
    assert.throws(() => verifySabySenderBusiness(bytes(corrupt), bytes(sender)));
  }
  assert.throws(() => verifySabySenderBusiness(bytes(normalized.replace('Тест, ООО', 'ООО:ТЕСТ')), bytes(sender)));
});
test('sender comparison accepts added Saby coordinates only at unchanged addresses by the explicit user rule', () => {
  const withCoordinates = sender.replace('<АдрПунктПод>', '<АдрПунктПод><Коорд Широта="55.75" Долгота="37.62"/>');
  assert.doesNotThrow(() => verifySabySenderBusiness(bytes(withCoordinates), bytes(sender)));
  assert.doesNotThrow(() => verifySabySenderBusiness(bytes(withCoordinates.replace('<ПодпИнфГО/>', '').replace('<СодИнфГО ', '<ПодпИнфГО/><СодИнфГО ')), bytes(sender)));
  assert.doesNotThrow(() => verifySabySenderBusiness(bytes(withCoordinates.replace('55.75', '55.75123456789012').replace('37.62', '37.62123456789012')), bytes(sender)));
  assert.throws(() => verifySabySenderBusiness(bytes(withCoordinates.replace('55.75', '55.76')), bytes(withCoordinates)), /Координаты маршрута/);
  assert.throws(() => verifySabySenderBusiness(bytes(withCoordinates.replace('Синтетический адрес', 'Другой адрес')), bytes(sender)));
  assert.throws(() => verifySabySenderBusiness(bytes(sender), bytes(withCoordinates)), /Координаты маршрута/);
  for (const corrupt of [
    withCoordinates.replace('55.75', '95.75'), withCoordinates.replace('37.62', '187.62'),
    withCoordinates.replace('55.75', '90.000000000000001'), withCoordinates.replace('37.62', '-180.000000000000001'),
    withCoordinates.replace('Широта="55.75"', 'Широта="55.75" Другое="1"'),
    withCoordinates.replace('<Коорд ', '<Коорд Широта="55.75" Долгота="37.62"/><Коорд '),
    sender.replace('<СвГО>', '<СвГО><Коорд Широта="55.75" Долгота="37.62"/>'),
  ]) assert.throws(() => verifySabySenderBusiness(bytes(corrupt), bytes(sender)));
  assert.doesNotThrow(() => verifySabySenderBusiness(bytes(withCoordinates), bytes(withCoordinates)));
  const stops = sender.replace('</СодИнфГО>', '<АдрПункт><АдресПункт><Адрес><АдрРФ>Синтетический адрес выгрузки</АдрРФ></Адрес></АдресПункт><АдресПункт><Адрес><АдрРФ>Второй синтетический адрес</АдрРФ></Адрес></АдресПункт></АдрПункт></СодИнфГО>');
  const withStops = stops.replaceAll('<АдресПункт>', '<АдресПункт><Коорд Широта="-55.75" Долгота="-37.62"/>');
  assert.doesNotThrow(() => verifySabySenderBusiness(bytes(withStops), bytes(stops)));
  assert.throws(() => verifySabySenderBusiness(bytes(withStops.replace('Второй синтетический адрес', 'Другой адрес')), bytes(stops)));
});

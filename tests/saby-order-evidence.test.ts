import assert from 'node:assert/strict';
import test from 'node:test';
import { carrierBusinessHash, verifySabyCarrierBusiness, verifySabySenderBusiness, verifySabyCarrierVehicleAddition, type SabySenderVerificationPolicy } from '../server/saby-order-evidence';
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

const deliveryInformation = '<ИнфПол><ТекстИнф Идентиф="Доставка CRM" Значение="delivery-a"/><ТекстИнф Идентиф="Получатель доставки" Значение="Получатель Тест"/><ТекстИнф Идентиф="ИНН получателя" Значение="010000000102"/><ТекстИнф Идентиф="Адрес доставки" Значение="Адрес доставки Тест"/></ИнфПол>';
const singleDeliveryCargo = `<ОпГруз Объем="1"><МасГруз МасБрутЗнач="835" МасНетЗнач="835"/><Пункт Погр="1" Выгр="2" КолГрМест="1"/>${deliveryInformation}</ОпГруз>`;
const unloadingPoint = '<АдрПункт Опер="Выгрузка" ПорНомПункт="2">';
const singleDeliverySender = sender.replace('<ОпГруз><МасГруз МасБрутЗнач="14740" МасНетЗнач="14740"/></ОпГруз>',
  `<АдрПункт Опер="Погрузка" ПорНомПункт="1"><АдресПункт><Адрес><АдрИнф КодСтр="643" АдрТекст="Адрес погрузки Тест"/></Адрес></АдресПункт></АдрПункт>${unloadingPoint}<АдресПункт><Адрес><АдрИнф КодСтр="643" АдрТекст="Адрес доставки Тест"/></Адрес></АдресПункт></АдрПункт>${singleDeliveryCargo}<ИнфПол><ТекстИнф Идентиф="Рейс CRM" Значение="trip-a"/><ТекстИнф Идентиф="Доставка CRM" Значение="trip-a"/><ТекстИнф Идентиф="Получатель доставки" Значение="Получатель Тест"/><ТекстИнф Идентиф="ИНН получателя" Значение="010000000102"/><ТекстИнф Идентиф="Доставка 1" Значение="delivery-a: Получатель Тест; 1000 л; Адрес доставки Тест"/></ИнфПол>`);
const omitDeliveryInformation = (xml: string) => xml.replace(deliveryInformation, '');

const routeCoordinates = '<Коорд Широта="55.643825" Долгота="37.85126"/>';
const fullAddressSender = singleDeliverySender.replace('<АдрРФ>Синтетический адрес</АдрРФ>', '<АдрИнф КодСтр="643" АдрТекст="Адрес подачи Тест"/>');
const withRouteCoordinates = fullAddressSender.replaceAll('<Адрес>', `${routeCoordinates}<Адрес>`);
const omitRouteCoordinates = (xml: string) => xml.replaceAll(routeCoordinates, '');

test('sender accepts omitted coordinates only at the exact full pickup and route addresses without changing input bytes', () => {
  const frozen = bytes(withRouteCoordinates); const frozenBefore = Buffer.from(frozen);
  const current = bytes(fullAddressSender); const currentBefore = Buffer.from(current);
  assert.doesNotThrow(() => verifySabySenderBusiness(current, frozen));
  assert.deepEqual(current, currentBefore); assert.deepEqual(frozen, frozenBefore);
  // A single missing unloading point is independent of the unchanged pickup/loading points.
  const unloadingCoordinates = `${unloadingPoint}<АдресПункт>${routeCoordinates}`;
  const oneMissing = withRouteCoordinates.replace(unloadingCoordinates, `${unloadingPoint}<АдресПункт>`);
  assert.notEqual(oneMissing, withRouteCoordinates);
  assert.doesNotThrow(() => verifySabySenderBusiness(bytes(oneMissing), frozen));
  assert.doesNotThrow(() => verifySabySenderBusiness(bytes(fullAddressSender.replace('КодСтр="643" АдрТекст="Адрес доставки Тест"', 'АдрТекст="Адрес доставки Тест" КодСтр="643"')), frozen));
});

test('omitted coordinates cannot hide changed addresses, routes, cargo or organization identities', () => {
  const routes = fullAddressSender.match(/<АдрПункт [\s\S]*?<\/АдрПункт>/g)!;
  for (const changed of [
    fullAddressSender.replace('АдрТекст="Адрес доставки Тест"', 'АдрТекст="Другой адрес"'),
    fullAddressSender.replace('АдрТекст="Адрес доставки Тест"', 'АдрТекст="Адрес  доставки Тест"'),
    fullAddressSender.replace('КодСтр="643"', 'КодСтр="398"'),
    fullAddressSender.replace('<Адрес><АдрИнф КодСтр="643" АдрТекст="Адрес подачи Тест"/></Адрес>', ''),
    fullAddressSender.replace('ПорНомПункт="2"', 'ПорНомПункт="3"'),
    fullAddressSender.replace(routes.join(''), [...routes].reverse().join('')),
    fullAddressSender.replace('МасНетЗнач="835"', 'МасНетЗнач="836"'),
    fullAddressSender.replace('0148372956', '0199999999'),
    fullAddressSender.replace('<АдрПунктПод>', '<АдрПунктПод><ГЛН>1234567890123</ГЛН>'),
    withRouteCoordinates.replace('Широта="55.643825"', 'Широта="55.643826"'),
  ]) assert.throws(() => verifySabySenderBusiness(bytes(changed), bytes(withRouteCoordinates)));
});

test('coordinate omission requires one valid frozen pair and one nonempty unambiguous full address', () => {
  for (const invalid of [
    routeCoordinates.replace('55.643825', '95.643825'), routeCoordinates.replace('37.85126', '180.000000000000001'),
    routeCoordinates.replace('55.643825', 'NaN'), routeCoordinates.replace(' Долгота="37.85126"', ''),
    routeCoordinates.replace('/>', ' Другое="1"/>'), routeCoordinates.replace('/>', '>не координаты</Коорд>'),
    routeCoordinates + routeCoordinates,
  ]) {
    const frozen = withRouteCoordinates.replace(routeCoordinates, invalid);
    assert.throws(() => verifySabySenderBusiness(bytes(fullAddressSender), bytes(frozen)));
  }
  const address = '<Адрес><АдрИнф КодСтр="643" АдрТекст="Адрес подачи Тест"/></Адрес>';
  for (const missingOrAmbiguous of ['', '<Адрес/>', '<Адрес><АдрИнф КодСтр="643" АдрТекст=""/></Адрес>', address + address]) {
    const frozen = withRouteCoordinates.replace(address, missingOrAmbiguous);
    assert.throws(() => verifySabySenderBusiness(bytes(omitRouteCoordinates(frozen)), bytes(frozen)));
  }
  const unrelated = fullAddressSender.replace('<СвГО>', `<СвГО>${routeCoordinates}`);
  assert.throws(() => verifySabySenderBusiness(bytes(fullAddressSender), bytes(unrelated)));
});

test('single delivery cargo information may disappear only with exact retained recipient, delivery, volume and route evidence', () => {
  for (const replacement of ['', '<ИнфПол/>', '<ИнфПол> \n </ИнфПол>']) {
    const actual = singleDeliverySender.replace(deliveryInformation, replacement);
    assert.doesNotThrow(() => verifySabySenderBusiness(bytes(actual), bytes(singleDeliverySender)));
    assert.doesNotThrow(() => verifySabySenderBusiness(bytes(actual.replace(unloadingPoint, unloadingPoint.replace('>', ' НалКоорТочВрОпер="1">'))), bytes(singleDeliverySender)));
  }
  const actual = omitDeliveryInformation(singleDeliverySender);
  for (const changed of [
    actual.replace('МасНетЗнач="835"', 'МасНетЗнач="836"'), actual.replace('Объем="1"', 'Объем="2"'),
    actual.replace('Получатель Тест', 'Другой получатель'), actual.replace('010000000102', '010000000103'),
    actual.replace('delivery-a:', 'delivery-b:'), actual.replace('1000 л;', '1001 л;'),
    actual.replace('АдрТекст="Адрес доставки Тест"', 'АдрТекст="Другой адрес"'), actual.replace('л; Адрес доставки Тест', 'л; Другой адрес'),
    actual.replace('Выгр="2"', 'Выгр="1"'), actual.replace('Погр="1"', 'Погр="2"'), actual.replace('КолГрМест="1"', 'КолГрМест="2"'),
    actual.replace(unloadingPoint, unloadingPoint.replace('>', ' ДатВрОпер="01.04.2025T14:00:00+03:00">')),
    actual.replace('</ОпГруз>', '<ИнфПол ИдФайлИнфПол="synthetic-external-file"/></ОпГруз>'),
    actual.replace('</ОпГруз>', '<ИнфПол><ТекстИнф Идентиф="Доставка CRM" Значение="delivery-a"/></ИнфПол></ОпГруз>'),
    actual.replace('</ОпГруз>', '<ИнфПол><ТекстИнф Идентиф="Другое" Значение="Не терять"/></ИнфПол></ОпГруз>'),
    actual.replace('</ОпГруз>', '<ИнфПол/><ИнфПол/></ОпГруз>'),
    actual.replace('ПорНомПункт="2"', 'ПорНомПункт="3"'), actual.replace('ПорНомПункт="2"', 'ПорНомПункт="1"'),
  ]) assert.throws(() => verifySabySenderBusiness(bytes(changed), bytes(singleDeliverySender)));
});

test('missing cargo metadata cannot hide extra fields, ambiguous duplicate keys or multiple deliveries in the frozen title', () => {
  const broken = [
    singleDeliverySender.replace(deliveryInformation, deliveryInformation.replace('</ИнфПол>', '<ТекстИнф Идентиф="Условие" Значение="Нельзя терять"/></ИнфПол>')),
    singleDeliverySender.replace(deliveryInformation, deliveryInformation.replace('</ИнфПол>', '<ТекстИнф Идентиф="Доставка CRM" Значение="delivery-a"/></ИнфПол>')),
    singleDeliverySender.replace(deliveryInformation, deliveryInformation.replace('<ИнфПол>', '<ИнфПол ИдФайлИнфПол="synthetic-linked-file">')),
    singleDeliverySender.replace('Значение="delivery-a"', 'Значение="unlinked-delivery"'),
    singleDeliverySender.replace('Объем="1"', 'Объем="2"'),
    singleDeliverySender.replace('Значение="010000000102"', 'Значение="010000000103"'),
    singleDeliverySender.replace('</СодИнфГО>', `${singleDeliveryCargo}</СодИнфГО>`),
    singleDeliverySender.replace('Идентиф="Доставка 1"', 'Идентиф="Доставка 2"'),
    singleDeliverySender.replace('Идентиф="Рейс CRM"', 'Идентиф="Неизвестный рейс"'),
    singleDeliverySender.replace('Идентиф="Доставка 1"', 'Идентиф="ИНН получателя"'),
  ];
  for (const frozen of broken) {
    const actual = frozen.replace(/(<ОпГруз[^>]*>.*?)<ИнфПол[\s\S]*?<\/ИнфПол>(<\/ОпГруз>)/g, '$1$2');
    assert.notEqual(actual, frozen);
    assert.throws(() => verifySabySenderBusiness(bytes(actual), bytes(frozen)));
  }
});

test('only an added UTC indicator 1 on an unchanged numbered unloading point with no times is inert', () => {
  const flag = (value: string) => unloadingPoint.replace('>', ` НалКоорТочВрОпер="${value}">`);
  assert.doesNotThrow(() => verifySabySenderBusiness(bytes(singleDeliverySender.replace(unloadingPoint, flag('1'))), bytes(singleDeliverySender)));
  for (const value of ['0', '2', '', 'true']) assert.throws(() => verifySabySenderBusiness(bytes(singleDeliverySender.replace(unloadingPoint, flag(value))), bytes(singleDeliverySender)));
  for (const value of ['0', '1']) {
    const frozen = singleDeliverySender.replace(unloadingPoint, flag(value));
    assert.throws(() => verifySabySenderBusiness(bytes(singleDeliverySender), bytes(frozen)));
    assert.throws(() => verifySabySenderBusiness(bytes(singleDeliverySender.replace(unloadingPoint, flag(value === '1' ? '0' : '1'))), bytes(frozen)));
  }
  for (const temporal of ['ДатВрОпер="01.04.2025T14:00:00+03:00"', 'ПредВрОпер="19:00:00+03:00"', 'НалКоорТочПредВрОпер="1"', 'ДатВрОпер=""']) {
    const frozen = singleDeliverySender.replace(unloadingPoint, unloadingPoint.replace('>', ` ${temporal}>`));
    assert.throws(() => verifySabySenderBusiness(bytes(frozen.replace(` ${temporal}>`, ` ${temporal} НалКоорТочВрОпер="1">`)), bytes(frozen)));
  }
  for (const bad of [
    singleDeliverySender.replace('Опер="Погрузка"', 'Опер="Погрузка" НалКоорТочВрОпер="1"'),
    singleDeliverySender.replace('<ОпГруз ', '<ОпГруз НалКоорТочВрОпер="1" '),
    singleDeliverySender.replace(unloadingPoint, flag('1')).replace('ПорНомПункт="2"', 'ПорНомПункт="3"'),
    singleDeliverySender.replace(unloadingPoint, flag('1')).replace('ПорНомПункт="2"', 'ПорНомПункт="1"'),
  ]) assert.throws(() => verifySabySenderBusiness(bytes(bad), bytes(singleDeliverySender)));
});

const addressPolicy: SabySenderVerificationPolicy = 'address-multidelivery-v1';
interface SyntheticDelivery { id: string; customer: string; inn: string; address: string; litres: number; massKg: number }
const syntheticDeliveries: SyntheticDelivery[] = [
  { id: 'delivery-a', customer: 'Получатель Первый Тест', inn: '010000000102', address: 'Адрес доставки Первый Тест', litres: 8000, massKg: 6745 },
  { id: 'delivery-b', customer: 'Получатель Второй Тест', inn: '020000000203', address: 'Адрес доставки Второй Тест', litres: 9500, massKg: 7985 },
  { id: 'delivery-c', customer: 'Получатель Третий Тест', inn: '030000000304', address: 'Адрес доставки Третий Тест', litres: 4000, massKg: 3340 },
];
const syntheticInfo = (values: Record<string, string>) => `<ИнфПол>${Object.entries(values).map(([key, value]) => `<ТекстИнф Идентиф="${key}" Значение="${value}"/>`).join('')}</ИнфПол>`;
function multipleDeliverySender(deliveries = syntheticDeliveries.slice(0, 2)): string {
  const routes = ['Адрес погрузки Тест', ...deliveries.map(row => row.address)].map((address, index) =>
    `<АдрПункт Опер="${index ? 'Выгрузка' : 'Погрузка'}" ПорНомПункт="${index + 1}"><АдресПункт><Адрес><АдрИнф КодСтр="643" АдрТекст="${address}"/></Адрес></АдресПункт></АдрПункт>`).join('');
  const cargos = deliveries.map((row, index) => `<ОпГруз Объем="${row.litres / 1000}"><МасГруз МасБрутЗнач="${row.massKg}" МасНетЗнач="${row.massKg}"/><Пункт Погр="1" Выгр="${index + 2}" КолГрМест="1"/>${syntheticInfo({
    'Доставка CRM': row.id, 'Получатель доставки': row.customer, 'ИНН получателя': row.inn, 'Адрес доставки': row.address,
  })}</ОпГруз>`).join('');
  const information = syntheticInfo({
    'Рейс CRM': 'trip-synthetic', 'Доставка CRM': 'trip-synthetic', 'Получатель доставки': deliveries[0].customer, 'ИНН получателя': deliveries[0].inn,
    'Владелец нефтебазы': 'Владелец Тест', 'ИНН владельца нефтебазы': '040000000405', 'Поставщик': 'Поставщик Тест',
    ...Object.fromEntries(deliveries.flatMap((row, index) => [
      [`Доставка ${index + 1}`, `${row.id}: ${row.customer}; ${row.litres} л; ${row.address}`],
      [`ИНН получателя доставки ${index + 1}`, row.inn],
    ])),
  });
  return sender.replace('<АдрРФ>Синтетический адрес</АдрРФ>', '<АдрИнф КодСтр="643" АдрТекст="Адрес подачи Тест"/>')
    .replace('<ОпГруз><МасГруз МасБрутЗнач="14740" МасНетЗнач="14740"/></ОпГруз>', routes + cargos + information);
}
const omitCargoInformation = (value: string, replacement = '') => value.replace(/(<ОпГруз(?=\s|>)[^>]*>[\s\S]*?)<ИнфПол>[\s\S]*?<\/ИнфПол>(<\/ОпГруз>)/g, `$1${replacement}$2`);
const verifyNewSender = (actual: string, frozen: string) => verifySabySenderBusiness(bytes(actual), bytes(frozen), addressPolicy);

test('new policy proves two independent recipients when Saby omits cargo information; raw bytes stay intact', () => {
  const frozen = multipleDeliverySender();
  for (const replacement of ['', '<ИнфПол/>', '<ИнфПол> \n </ИнфПол>']) {
    const actual = omitCargoInformation(frozen, replacement).replace('ИдФайл="SYNTHETIC-SENDER"', 'ИдФайл="SYNTHETIC-PREPARED"');
    const actualBytes = bytes(actual); const frozenBytes = bytes(frozen);
    const actualBefore = Buffer.from(actualBytes); const frozenBefore = Buffer.from(frozenBytes);
    assert.equal(verifySabySenderBusiness(actualBytes, frozenBytes, addressPolicy).fileId, 'SYNTHETIC-PREPARED');
    assert.deepEqual(actualBytes, actualBefore); assert.deepEqual(frozenBytes, frozenBefore);
  }
  // Keeping either delivery's metadata does not prevent proof of the other omitted block.
  const blocks = frozen.match(/<ОпГруз(?=\s|>)[\s\S]*?<\/ОпГруз>/g)!;
  for (const block of blocks) assert.doesNotThrow(() => verifyNewSender(frozen.replace(block, omitCargoInformation(block)), frozen));
  const padded = omitCargoInformation(frozen).replaceAll('="6745"', '="6745.000"').replaceAll('="7985"', '="7985.000"');
  assert.doesNotThrow(() => verifyNewSender(padded, frozen));
});

test('rounded delivery volumes remain provable only with the frozen rounding rule and unchanged original litres', () => {
  const deliveries = syntheticDeliveries.slice(0, 2).map((row, index) => ({ ...row, litres: index ? 9930 : 5118 }));
  const unrounded = multipleDeliverySender(deliveries);
  const roundedWithoutRule = unrounded.replace('Объем="5.118"', 'Объем="5.12"');
  const marker = '<ТекстИнф Идентиф="Точность объёмов CRM" Значение="fns-5.01-v1"/>';
  const frozen = roundedWithoutRule.replace('<ТекстИнф Идентиф="Рейс CRM"', marker + '<ТекстИнф Идентиф="Рейс CRM"');
  const actual = omitCargoInformation(frozen);
  assert.doesNotThrow(() => verifyNewSender(actual, frozen));
  assert.throws(() => verifyNewSender(omitCargoInformation(roundedWithoutRule), roundedWithoutRule));
  assert.throws(() => verifyNewSender(actual.replace(marker, ''), frozen));
  assert.throws(() => verifyNewSender(actual.replace('5118 л;', '5119 л;'), frozen), 'same rounded value does not authorize a source litre edit');
  assert.throws(() => verifyNewSender(actual.replace('Объем="5.12"', 'Объем="5.11"'), frozen));
  assert.throws(() => verifyNewSender(actual.replace('9930 л;', '9929 л;'), frozen));
  const zero = frozen.replace('5118 л;', '4 л;').replace('Объем="5.12"', 'Объем="0"');
  assert.throws(() => verifyNewSender(omitCargoInformation(zero), zero));
});

test('new policy keeps delivery identity across three cargos, repeated customers and repeated physical addresses', () => {
  const cases = [
    syntheticDeliveries,
    syntheticDeliveries.map(row => ({ ...row, customer: syntheticDeliveries[0].customer, inn: syntheticDeliveries[0].inn })),
    syntheticDeliveries.map(row => ({ ...row, address: syntheticDeliveries[0].address })),
    syntheticDeliveries.map(row => ({ ...row, customer: syntheticDeliveries[0].customer, inn: syntheticDeliveries[0].inn, address: syntheticDeliveries[0].address })),
  ];
  for (const deliveries of cases) {
    const frozen = multipleDeliverySender(deliveries);
    assert.doesNotThrow(() => verifyNewSender(omitCargoInformation(frozen), frozen));
    const cargos = omitCargoInformation(frozen).match(/<ОпГруз(?=\s|>)[\s\S]*?<\/ОпГруз>/g)!;
    const reordered = omitCargoInformation(frozen).replace(cargos.join(''), [cargos[1], cargos[0], cargos[2]].join(''));
    assert.throws(() => verifyNewSender(reordered, frozen));
  }
});

test('the new omission rule requires its persisted policy and per-delivery INN even for one delivery', () => {
  for (const deliveries of [syntheticDeliveries.slice(0, 2), syntheticDeliveries]) {
    const frozen = multipleDeliverySender(deliveries);
    assert.throws(() => verifySabySenderBusiness(bytes(omitCargoInformation(frozen)), bytes(frozen)));
  }
  const one = multipleDeliverySender(syntheticDeliveries.slice(0, 1));
  assert.doesNotThrow(() => verifyNewSender(omitCargoInformation(one), one));
  assert.throws(() => verifyNewSender(omitDeliveryInformation(singleDeliverySender), singleDeliverySender));
  for (const count of [1, 2]) {
    const frozen = multipleDeliverySender().replace(new RegExp(`<ТекстИнф Идентиф="ИНН получателя доставки ${count}"[^>]*\\/>`), '');
    assert.throws(() => verifyNewSender(omitCargoInformation(frozen), frozen));
  }
});

test('new omission rule cannot hide changed recipient identity, summary, cargo mass, volume or route', () => {
  const frozen = multipleDeliverySender(); const actual = omitCargoInformation(frozen);
  for (const [before, after] of [
    ['0148372956', '0199999999'], ['0392816475', '0399999999'],
    ['Владелец Тест', 'Другой владелец'], ['040000000405', '0499999999'], ['Поставщик Тест', 'Другой поставщик'],
    ['Получатель Второй Тест', 'Другой получатель'], ['020000000203', '020000000204'],
    ['delivery-b:', 'delivery-other:'], ['9500 л;', '9501 л;'], ['Объем="9.5"', 'Объем="9.6"'],
    ['МасНетЗнач="7985"', 'МасНетЗнач="7986"'], ['МасБрутЗнач="7985"', 'МасБрутЗнач="7986"'],
    ['АдрТекст="Адрес доставки Второй Тест"', 'АдрТекст="Другой адрес"'],
    ['л; Адрес доставки Второй Тест', 'л; Другой адрес'],
    ['Выгр="3"', 'Выгр="2"'], ['Погр="1"', 'Погр="2"'], ['КолГрМест="1"', 'КолГрМест="2"'],
    ['ПорНомПункт="3"', 'ПорНомПункт="2"'], ['ПорНомПункт="3"', 'ПорНомПункт="4"'],
    ['Опер="Выгрузка"', 'Опер="Погрузка"'],
    ['Идентиф="Доставка 2"', 'Идентиф="Доставка 3"'],
    ['Идентиф="ИНН получателя доставки 2"', 'Идентиф="ИНН получателя доставки 3"'],
  ]) assert.throws(() => verifyNewSender(actual.replace(before, after), frozen), undefined, before);
  const cargos = actual.match(/<ОпГруз(?=\s|>)[\s\S]*?<\/ОпГруз>/g)!;
  const routes = actual.match(/<АдрПункт(?=\s|>)[\s\S]*?<\/АдрПункт>/g)!;
  for (const changed of [
    actual.replace(cargos.join(''), [...cargos].reverse().join('')),
    actual.replace(routes.join(''), [routes[0], routes[2], routes[1]].join('')),
    actual.replace(cargos[1], ''), actual.replace(cargos[1], cargos[0]), actual.replace(cargos[1], cargos[1] + cargos[1]),
    actual.replace(routes[2], ''), actual.replace(routes[2], routes[1]), actual.replace(routes[2], routes[2] + routes[2]),
    actual.replace('<МасГруз МасБрутЗнач="7985" МасНетЗнач="7985"/>', ''),
    actual.replace('МасБрутЗнач="7985" МасНетЗнач="7985"', 'МасБрутЗнач="6745" МасНетЗнач="6745"'),
  ]) assert.throws(() => verifyNewSender(changed, frozen));
});

test('new omission proof rejects duplicate, missing, partial or malformed evidence even if retained identically on both sides', () => {
  const source = multipleDeliverySender();
  const cargoBlocks = source.match(/<ОпГруз(?=\s|>)[\s\S]*?<\/ОпГруз>/g)!;
  for (const frozen of [
    source.replaceAll('delivery-b', 'delivery-a'),
    source.replace('Идентиф="Доставка 2"', 'Идентиф="Доставка 02"'),
    source.replace('Идентиф="ИНН получателя доставки 2"', 'Идентиф="ИНН получателя доставки 02"'),
    source.replace('Идентиф="Рейс CRM"', 'Идентиф="Другое"'),
    source.replaceAll('020000000203', 'wrong-inn'),
    source.replace('Объем="9.5"', 'Объем="8"'),
    source.replaceAll('9500 л;', '0 л;').replace('Объем="9.5"', 'Объем="0"'),
    source.replace('Выгр="3"', 'Выгр="2"'),
    source.replace('ПорНомПункт="3"', 'ПорНомПункт="2"'),
    source.replace(cargoBlocks[1], cargoBlocks[1].replace('Значение="delivery-b"', 'Значение="unlinked-id"')),
    source.replace(cargoBlocks[1], cargoBlocks[1].replace('</ИнфПол>', '<ТекстИнф Идентиф="Доставка CRM" Значение="delivery-b"/></ИнфПол>')),
    source.replace(cargoBlocks[1], cargoBlocks[1].replace('</ИнфПол>', '<ТекстИнф Идентиф="Условие" Значение="Не терять"/></ИнфПол>')),
    source.replace('Идентиф="ИНН получателя доставки 2" Значение="020000000203"', 'Идентиф="ИНН получателя доставки 2" Значение="010000000102"'),
    source.replace('</СодИнфГО>', '<ИнфПол/></СодИнфГО>'),
  ]) {
    assert.notEqual(frozen, source);
    assert.throws(() => verifyNewSender(omitCargoInformation(frozen), frozen));
  }
  const omitted = omitCargoInformation(source);
  for (const information of [
    '<ИнфПол ИдФайлИнфПол="unknown-file"/>', '<ИнфПол>unknown text</ИнфПол>', '<ИнфПол/><ИнфПол/>',
    syntheticInfo({ 'Доставка CRM': 'delivery-a' }), syntheticInfo({ 'Неизвестное': 'Не терять' }),
  ]) assert.throws(() => verifyNewSender(omitted.replace('</ОпГруз>', `${information}</ОпГруз>`), source));
  const originalInformation = cargoBlocks[1].match(/<ИнфПол>[\s\S]*?<\/ИнфПол>/)![0];
  for (const malformed of [
    originalInformation.replace('<ИнфПол>', '<ИнфПол ИдФайлИнфПол="external-information">'),
    originalInformation.replace('</ИнфПол>', '<Неизвестное/></ИнфПол>'),
    originalInformation.replace('Значение="delivery-b"', 'Значение=" "'),
    originalInformation.replace('Идентиф="ИНН получателя"', 'Идентиф="Доставка CRM"'),
    originalInformation + '<ИнфПол/>',
  ]) {
    const frozen = source.replace(originalInformation, malformed);
    assert.throws(() => verifyNewSender(frozen.replace(malformed, ''), frozen));
  }
  for (const frozen of [
    source.replace('<Пункт Погр="1" Выгр="3" КолГрМест="1"/>', '<Пункт Погр="1" Выгр="3" КолГрМест="1"/><Пункт Погр="1" Выгр="3" КолГрМест="1"/>'),
    source.replace('Идентиф="ИНН получателя доставки 2" Значение="020000000203"/>', 'Идентиф="ИНН получателя доставки 2" Значение="020000000203"/><ТекстИнф Идентиф="ИНН получателя доставки 2" Значение="020000000203"/>'),
  ]) assert.throws(() => verifyNewSender(omitCargoInformation(frozen), frozen));
});

test('new policy accepts changed valid coordinates only at exact complete addresses, alongside multiple cargo omissions', () => {
  const source = multipleDeliverySender(syntheticDeliveries);
  const frozen = source.replaceAll('<Адрес>', `${routeCoordinates}<Адрес>`);
  const changed = omitCargoInformation(frozen).replaceAll('55.643825', '55.648001').replaceAll('37.85126', '37.856789');
  assert.doesNotThrow(() => verifyNewSender(changed, frozen));
  assert.throws(() => verifySabySenderBusiness(bytes(changed), bytes(frozen)));
  for (const actual of [omitCargoInformation(source), omitCargoInformation(frozen), changed]) assert.doesNotThrow(() => verifyNewSender(actual, frozen));
  assert.doesNotThrow(() => verifyNewSender(changed, source));
  // New address policy does not mutate signing bytes or their hash input.
  const preparedBytes = bytes(changed); const originalBytes = bytes(frozen);
  verifySabySenderBusiness(preparedBytes, originalBytes, addressPolicy);
  assert.equal(preparedBytes.toString(), changed); assert.equal(originalBytes.toString(), frozen);
});

test('new coordinate rule rejects invalid coordinates and any full address mismatch or ambiguity', () => {
  const frozen = multipleDeliverySender().replaceAll('<Адрес>', `${routeCoordinates}<Адрес>`);
  const changed = omitCargoInformation(frozen).replaceAll('55.643825', '55.648001');
  for (const invalid of [
    changed.replace('55.648001', '95.648001'), changed.replace('55.648001', '90.000000000000001'),
    changed.replace('37.85126', '180.000000000000001'), changed.replace('55.648001', 'NaN'),
    changed.replace(' Долгота="37.85126"', ''), changed.replace('<Коорд ', '<Коорд Лишнее="1" '),
    changed.replace('<Коорд ', `${routeCoordinates}<Коорд `),
    changed.replace('АдрТекст="Адрес подачи Тест"', 'АдрТекст="Адрес  подачи Тест"'),
    changed.replace('АдрТекст="Адрес подачи Тест"', 'АдрТекст="Другой адрес"'),
    changed.replace('АдрТекст="Адрес подачи Тест"', 'АдрТекст=""'),
    changed.replace('КодСтр="643"', 'КодСтр="398"'),
    changed.replace('<Адрес><АдрИнф КодСтр="643" АдрТекст="Адрес подачи Тест"/></Адрес>', ''),
    changed.replace('</Адрес>', '</Адрес><Адрес><АдрИнф КодСтр="643" АдрТекст="Адрес подачи Тест"/></Адрес>'),
    changed.replace('<АдрИнф ', '<АдрИнф Лишнее="1" '),
    changed.replace('<СвГО>', `<СвГО>${routeCoordinates}`),
  ]) assert.throws(() => verifyNewSender(invalid, frozen));
  for (const invalid of [
    frozen.replace('55.643825', 'NaN'), frozen.replace('<Коорд ', `${routeCoordinates}<Коорд `),
    frozen.replace('АдрТекст="Адрес подачи Тест"', 'АдрТекст=""'),
  ]) assert.throws(() => verifyNewSender(invalid, invalid));
});

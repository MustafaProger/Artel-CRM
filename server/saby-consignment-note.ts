import Decimal from 'decimal.js';
import type { ShipmentTrip, Snapshot } from '../web/src/model';
import type { EtrnDocumentBasis, EtrnLoadingParty, EtrnName, EtrnParty, SabyConsignmentProfile } from '../web/src/etrn-model';
import { SabyError, sabyObject, type SabyObject, type SabyOrganization } from './saby-client';
import { encodeWindows1251 } from './saby-transport-order';

export type { SabyConsignmentProfile } from '../web/src/etrn-model';
export interface SabyConsignmentSnapshot {
  documentType: 'ConsignmentNote'; formatVersion: '5.01';
  tripId: string; shipmentId: string; version: number;
  fields: Record<string, string | null>;
  calculatedMassTonnes: string | null;
  tripTotalMassTonnes: string | null; tripTotalLitres: string | null;
  customer: EtrnParty;
  customerOrganization: SabyOrganization; carrierOrganization: SabyOrganization;
  driver: { id: string; fullName: string; phone: string; inn: string; licenseSeries: string; licenseNumber: string; licenseIssuedAt: string };
  vehicle: { id: string; plate: string; vin: string; stsNumber: string; trailer: string };
  profile: SabyConsignmentProfile;
}
const object = (value: unknown): SabyObject => sabyObject(value) ? value : {};
const str = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
const strings = <K extends string>(value: unknown, keys: readonly K[]): Record<K, string> => Object.fromEntries(keys.map(key => [key, str(object(value)[key])])) as Record<K, string>;
const party = (value: unknown): EtrnParty => strings(value, ['name', 'inn', 'kpp', 'address', 'phone', 'edoId']);
const person = (value: unknown): EtrnName => strings(value, ['surname', 'name', 'patronymic']);
function basis(value: unknown): EtrnDocumentBasis {
  return { ...strings(value, ['name', 'number', 'date']), issuerInns: Array.isArray(object(value).issuerInns) ? (object(value).issuerInns as unknown[]).map(str) : [] };
}
function loadingParty(value: unknown): EtrnLoadingParty {
  const row = object(value);
  return { sameAsConsignor: typeof row.sameAsConsignor === 'boolean' ? row.sameAsConsignor : null, party: party(row.party) };
}
/** Closed-field normalization accepts partial drafts and never copies signatures or arbitrary XML. */
export function readSabyConsignmentProfile(raw: unknown): SabyConsignmentProfile {
  let parsed = raw;
  if (typeof raw === 'string') { try { parsed = JSON.parse(raw); } catch { parsed = {}; } }
  const value = object(parsed); const cargo = object(value.cargo); const vehicle = object(value.vehicle); const signer = object(value.signer);
  return {
    confirmed: value.confirmed === true,
    consignorPhone: str(value.consignorPhone), carrierPhone: str(value.carrierPhone),
    consignorIsForwarder: str(value.consignorIsForwarder),
    ...(sabyObject(value.transportCustomer) ? { transportCustomer: party(value.transportCustomer) } : {}),
    ...(sabyObject(value.transportCustomerContract) ? { transportCustomerContract: basis(value.transportCustomerContract) } : {}),
    order: strings(value.order, ['number', 'date']),
    signer: { ...person(signer), ...strings(signer, ['position', 'status']), ...(sabyObject(signer.powerOfAttorney) ? { powerOfAttorney: strings(signer.powerOfAttorney, ['date', 'number', 'id']) } : {}) },
    recipient: party(value.recipient),
    cargo: { ...strings(cargo, ['name', 'condition', 'packagingCode', 'packingMethod', 'packageCount', 'marking', 'massMethod']),
      ...(cargo.dangerousGoods === null ? { dangerousGoods: null } : sabyObject(cargo.dangerousGoods) ? { dangerousGoods: strings(cargo.dangerousGoods, ['unNumber', 'shippingName', 'class', 'classificationCode', 'packingGroup', 'hazardSign', 'tunnelCode']) } : {}),
      ...(sabyObject(cargo.dimensions) ? { dimensions: strings(cargo.dimensions, ['heightMetres', 'lengthMetres', 'widthMetres']) } : {}) },
    deliveryMassTonnes: str(value.deliveryMassTonnes),
    vehicle: { ...strings(vehicle, ['type', 'brand', 'payloadTonnes', 'capacityCubicMetres', 'ownershipType']), ...(sabyObject(vehicle.ownershipDocument) ? { ownershipDocument: basis(vehicle.ownershipDocument) } : {}) },
    driver: person(value.driver), loading: strings(value.loading, ['arrivedAt', 'departedAt']),
    loadingActor: loadingParty(value.loadingActor), infrastructureOwner: loadingParty(value.infrastructureOwner),
    instructions: strings(value.instructions, ['regulatory', 'redirectionParty', 'redirectionMethod', 'redirectionPhone', 'transshipmentForbidden']),
  };
}
const copyFields = ['organization_id', 'date', 'supplier_id', 'product_id', 'driver_id', 'vehicle_id', 'customer_id', 'quantity_litres', 'loading_address', 'loading_latitude', 'loading_longitude', 'loading_planned_at', 'loading_actual_at', 'unloading_address', 'unloading_latitude', 'unloading_longitude', 'unloading_planned_at', 'unloading_actual_at'] as const;
/** Capture actual trip/delivery and only the directory details needed by the sender title. */
export function buildSabyConsignmentSnapshot(source: Snapshot, trip: ShipmentTrip, shipmentId: string, customerOrganization: SabyOrganization, carrierOrganization: SabyOrganization, input: unknown): SabyConsignmentSnapshot {
  const delivery = trip.customers.find(row => row.id === shipmentId);
  if (!delivery) throw new SabyError('validation', 'Выбранная доставка не принадлежит рейсу.');
  const row = source.shipments.find(item => item.id === shipmentId);
  const customer = source.companies.find(item => item.id === delivery.fields.customer_id);
  const driver = source.directories?.drivers.find(item => item.id === trip.fields.driver_id);
  const vehicle = source.directories?.vehicles.find(item => item.id === trip.fields.vehicle_id);
  const fields = { ...trip.fields, ...delivery.fields };
  const profile = readSabyConsignmentProfile(input);
  const recipient = party({ name: customer?.fullName || customer?.name, inn: customer?.inn, kpp: customer?.kpp, address: customer?.address, phone: customer?.phone });
  // Prefill only a new draft. Explicitly cleared fields stay empty and unready.
  if (input === null || input === undefined) {
    profile.recipient = { ...recipient };
    profile.consignorPhone = customerOrganization.phone ?? ''; profile.carrierPhone = carrierOrganization.phone ?? '';
    const names = (driver?.fullName ?? '').trim().split(/\s+/);
    if (names.length === 2 || names.length === 3) profile.driver = { surname: names[0], name: names[1], patronymic: names[2] || '' };
    profile.vehicle.type = vehicle?.vehicleType ?? ''; profile.vehicle.brand = [vehicle?.brand, vehicle?.model].filter(Boolean).join(' ');
    if (validDecimal(vehicle?.capacityLitres, 17, 3, true)) profile.vehicle.capacityCubicMetres = new Decimal(vehicle!.capacityLitres!).div(1000).toFixed();
  }
  return structuredClone({
    documentType: 'ConsignmentNote', formatVersion: '5.01', tripId: trip.id, shipmentId, version: delivery.version,
    fields: Object.fromEntries(copyFields.map(key => [key, fields[key] ?? null])), calculatedMassTonnes: row?.fields.quantity_tonnes ?? null,
    tripTotalMassTonnes: trip.fields.quantity_tonnes ?? null,
    tripTotalLitres: trip.customers.every(item => validDecimal(item.fields.quantity_litres, 17, 3, true)) ? trip.customers.reduce((sum, item) => sum.plus(item.fields.quantity_litres!), new Decimal(0)).toFixed() : null,
    customer: recipient,
    customerOrganization: { ...customerOrganization, phone: profile.consignorPhone || customerOrganization.phone },
    carrierOrganization: { ...carrierOrganization, phone: profile.carrierPhone || carrierOrganization.phone },
    driver: { id: driver?.id ?? '', fullName: driver?.fullName ?? '', phone: driver?.phone ?? '', inn: driver?.inn ?? '', licenseSeries: driver?.licenseSeries ?? '', licenseNumber: driver?.licenseNumber ?? '', licenseIssuedAt: driver?.licenseIssuedAt ?? '' },
    vehicle: { id: vehicle?.id ?? '', plate: vehicle?.plate ?? '', vin: vehicle?.vin ?? '', stsNumber: [vehicle?.stsSeries, vehicle?.stsNumber].filter(Boolean).join('').replace(/[\s№]/g, ''), trailer: vehicle?.trailer ?? '' }, profile,
  });
}
function text(value: unknown, max = 1000): value is string { return typeof value === 'string' && !!value.trim() && value.length <= max && ![...value].some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0))); }
function validDecimal(value: unknown, digits: number, fractions: number, positive = false): value is string {
  if (typeof value !== 'string' || value.length > 40 || !/^\d+(?:\.\d+)?$/.test(value)) return false;
  const decimal = new Decimal(value);
  return (!positive || decimal.gt(0)) && decimal.decimalPlaces() <= fractions && decimal.toFixed().replace('.', '').replace(/^0+/, '').length <= digits;
}
const day = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^(19|20)\d{2}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`); return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
};
const ruDay = (value: string) => value.split('-').reverse().join('.');
function moscowTime(value: unknown): string | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) return null;
  const [date, time] = value.split('T'); return day(date) ? `${ruDay(date)}T${time.length === 5 ? `${time}:00` : time}+03:00` : null;
}
const amount = (value: string, factor: number) => validDecimal(value, 20, 9) ? new Decimal(value).mul(factor).toFixed() : '';
const validParty = (value: SabyOrganization | EtrnParty) => /^\d{10}$/.test(value.inn) && /^\d{9}$/.test(value.kpp) && text(value.name) && text(value.address) && text(value.phone, 255);
const validName = (value: EtrnName) => text(value.surname, 60) && text(value.name, 60) && (!value.patronymic || text(value.patronymic, 60));
const validBasis = (value?: EtrnDocumentBasis) => !!value && text(value.name, 255) && text(value.number, 255) && day(value.date) && value.issuerInns.length > 0 && value.issuerInns.every(inn => /^\d{10}(?:\d{2})?$/.test(inn));
const uuid = (value: string) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
/** Runtime format and business preconditions. A pass does not establish signing authority. */
export function sabyConsignmentBlockers(snapshot: SabyConsignmentSnapshot): string[] {
  const result: string[] = []; const p = snapshot.profile;
  if (!p.confirmed) result.push('Подтвердите сведения именно этой доставки перед формированием ЭТрН.');
  if (snapshot.fields.organization_id !== 'artel') result.push('Первый сценарий ЭТрН поддерживает рейс организации Артэль: грузоотправитель Артэль, перевозчик НК Артэль.');
  if (!day(snapshot.fields.date)) result.push('Укажите корректную дату рейса.');
  if (!validParty(snapshot.customerOrganization)) result.push('Подтвердите реквизиты и телефон грузоотправителя в настройках Saby.');
  if (!validParty(snapshot.carrierOrganization)) result.push('Подтвердите реквизиты и телефон перевозчика в настройках Saby.');
  if (!validParty(p.recipient)) result.push('Заполните ИНН, КПП, название, юридический адрес и телефон грузополучателя.');
  if (snapshot.customer.inn && p.recipient.inn !== snapshot.customer.inn) result.push('ИНН грузополучателя отличается от выбранного клиента доставки.');
  for (const org of [snapshot.customerOrganization, snapshot.carrierOrganization, p.recipient]) if (org.edoId && (!text(org.edoId, 100) || !/^[A-Za-z0-9-]+$/.test(org.edoId))) result.push('Проверьте идентификаторы участников ЭДО.');
  if (!['0', '1'].includes(p.consignorIsForwarder)) result.push('Подтвердите, выступает ли грузоотправитель экспедитором.');
  if (p.consignorIsForwarder === '1' && (!p.transportCustomer || !validParty(p.transportCustomer))) result.push('Для экспедитора укажите подтверждённого заказчика перевозки.');
  if (p.consignorIsForwarder === '1' && !validBasis(p.transportCustomerContract)) result.push('Для экспедитора укажите реквизиты договора оказания услуг по перевозке с заказчиком.');
  if (!text(p.order.number) || !day(p.order.date)) result.push('Укажите номер и дату заказа (заявки), являющегося основанием этой перевозки.');
  if (day(p.order.date) && day(snapshot.fields.date) && p.order.date > snapshot.fields.date) result.push('Дата заказа не может быть позже даты перевозки.');
  if (!text(snapshot.fields.loading_address) || !text(snapshot.fields.unloading_address)) result.push('Укажите фактические площадки погрузки и доставки в рейсе; юридические адреса их не заменяют.');
  if (!moscowTime(snapshot.fields.loading_planned_at)) result.push('Укажите плановые дату и время подачи машины в рейсе (Москва).');
  if (snapshot.fields.unloading_planned_at && !moscowTime(snapshot.fields.unloading_planned_at)) result.push('Проверьте плановые дату и время доставки.');
  if (!moscowTime(p.loading.arrivedAt) || !moscowTime(p.loading.departedAt)) result.push('Укажите отдельные фактические время прибытия и время убытия с погрузки (Москва).');
  if (moscowTime(p.loading.arrivedAt) && moscowTime(p.loading.departedAt) && p.loading.departedAt < p.loading.arrivedAt) result.push('Убытие с погрузки не может предшествовать прибытию.');
  for (const kind of ['loading', 'unloading']) {
    const lat = snapshot.fields[`${kind}_latitude`]; const lon = snapshot.fields[`${kind}_longitude`];
    if ((lat || lon) && (![lat, lon].every(value => typeof value === 'string' && /^-?\d{1,3}(?:\.\d{1,13})?$/.test(value)) || Math.abs(Number(lat)) > 90 || Math.abs(Number(lon)) > 180)) result.push('Проверьте обе координаты площадки или оставьте обе незаполненными.');
  }
  if (!snapshot.driver.id || !validName(p.driver) || !text(snapshot.driver.phone, 255)) result.push('Выберите водителя и проверьте его ФИО и телефон.');
  if (snapshot.driver.inn && !/^\d{12}$/.test(snapshot.driver.inn)) result.push('Проверьте ИНН водителя в справочнике.');
  if (!snapshot.driver.inn && !(text(snapshot.driver.licenseSeries, 20) && text(snapshot.driver.licenseNumber, 20) && day(snapshot.driver.licenseIssuedAt))) result.push('Для идентификации водителя требуется ИНН либо серия, номер и дата выдачи ВУ в справочнике.');
  if (snapshot.driver.licenseIssuedAt && !day(snapshot.driver.licenseIssuedAt)) result.push('Проверьте дату выдачи ВУ водителя в справочнике.');
  if ([snapshot.driver.licenseSeries, snapshot.driver.licenseNumber].some(value => value && !text(value, 20))) result.push('Проверьте реквизиты ВУ водителя в справочнике.');
  if (!snapshot.vehicle.id || !text(snapshot.vehicle.plate, 9) || !/^[А-ЯA-Z0-9-]+$/i.test(snapshot.vehicle.plate)) result.push('Укажите полный регистрационный номер выбранной машины в справочнике.');
  if (snapshot.vehicle.vin && !text(snapshot.vehicle.vin, 17) || snapshot.vehicle.stsNumber && !text(snapshot.vehicle.stsNumber, 10)) result.push('Проверьте VIN и номер СТС машины в справочнике.');
  if (snapshot.vehicle.trailer) result.push('В справочнике указан прицеп: требуется отдельный подтверждённый транспортный состав; первый сценарий поддерживает одиночное ТС.');
  if (!text(p.vehicle.type) || !text(p.vehicle.brand) || !validDecimal(p.vehicle.payloadTonnes, 5, 2, true) || !validDecimal(p.vehicle.capacityCubicMetres, 4, 2, true)) result.push('Подтвердите тип, марку, грузоподъёмность в т и вместимость машины в м³. Максимальная масса не заменяет грузоподъёмность.');
  if (!['1', '2', '3', '4', '5'].includes(p.vehicle.ownershipType)) result.push('Подтвердите тип владения машиной.');
  if ((['3', '4', '5'].includes(p.vehicle.ownershipType) || p.vehicle.ownershipDocument) && !validBasis(p.vehicle.ownershipDocument)) result.push('Заполните документ основания владения ТС: название, номер, дата и ИНН составителей.');
  const volume = amount(snapshot.fields.quantity_litres ?? '', 0.001); const mass = amount(p.deliveryMassTonnes, 1000);
  if (!validDecimal(volume, 17, 3, true)) result.push('Объём выбранной доставки должен быть положительным и представляться в м³ с точностью до 3 знаков.');
  if (!validDecimal(mass, 17, 3, true)) result.push('Подтвердите массу именно выбранной доставки в т (точность до 6 знаков); расчётная доля рейса не подставляется.');
  if (validDecimal(volume, 17, 3, true) && validDecimal(p.vehicle.capacityCubicMetres, 4, 2, true) && new Decimal(volume).gt(p.vehicle.capacityCubicMetres)) result.push('Объём доставки превышает подтверждённую вместимость ТС.');
  if (validDecimal(mass, 17, 3, true) && validDecimal(p.vehicle.payloadTonnes, 5, 2, true) && new Decimal(p.deliveryMassTonnes).gt(p.vehicle.payloadTonnes)) result.push('Масса доставки превышает подтверждённую грузоподъёмность ТС.');
  if (validDecimal(snapshot.tripTotalLitres, 20, 3, true) && validDecimal(p.vehicle.capacityCubicMetres, 4, 2, true) && new Decimal(snapshot.tripTotalLitres).div(1000).gt(p.vehicle.capacityCubicMetres)) result.push('Общий объём доставок рейса превышает подтверждённую вместимость ТС.');
  if (validDecimal(snapshot.tripTotalMassTonnes, 20, 9, true) && validDecimal(p.vehicle.payloadTonnes, 5, 2, true) && new Decimal(snapshot.tripTotalMassTonnes).gt(p.vehicle.payloadTonnes)) result.push('Общая масса рейса превышает подтверждённую грузоподъёмность ТС.');
  const c = p.cargo;
  if (![c.name, c.condition, c.packingMethod, c.marking].every(value => text(value)) || !/^[\wА-Яа-я]{2}$/.test(c.packagingCode) || !/^\d{1,4}$/.test(c.packageCount) || !['01', '02', '03'].includes(c.massMethod)) result.push('Заполните транспортное наименование, состояние, упаковку, код тары (2 символа), маркировку, число мест и метод определения массы.');
  if (c.dimensions && !Object.values(c.dimensions).every(value => validDecimal(value, 17, 3))) result.push('Проверьте габариты груза; неизвестные размеры не заменяются нулями.');
  if (c.dangerousGoods === undefined || c.dangerousGoods !== null && (!Object.values(c.dangerousGoods).every(value => text(value, 1000)) || !text(c.dangerousGoods.class, 3) || !['unNumber', 'classificationCode', 'packingGroup', 'hazardSign', 'tunnelCode'].every(key => text(c.dangerousGoods![key as keyof typeof c.dangerousGoods], 50)))) result.push('Подтвердите отсутствие опасного груза либо заполните классификацию по документам именно этого продукта.');
  if (!text(p.instructions.regulatory, 2000) || !['Грузоотправитель', 'Грузополучатель'].includes(p.instructions.redirectionParty) || !text(p.instructions.redirectionMethod, 255) || !text(p.instructions.redirectionPhone, 255) || !['0', '1'].includes(p.instructions.transshipmentForbidden)) result.push('Подтвердите указания отправителя, возможность перегрузки и лицо/способ связи для переадресовки.');
  for (const [label, role] of [['лицо, осуществляющее погрузку', p.loadingActor], ['владельца инфраструктуры погрузки', p.infrastructureOwner]] as const) {
    if (role.sameAsConsignor === null || role.sameAsConsignor === false && !validParty(role.party)) result.push(`Подтвердите ${label}: совпадение с отправителем или отдельные реквизиты.`);
  }
  if (!validName(p.signer) || !text(p.signer.position, 128) || !['1', '2', '3', '4', '5', '6'].includes(p.signer.status)) result.push('Заполните ФИО, должность и основание полномочий подписанта.');
  const poa = p.signer.powerOfAttorney;
  if (['2', '5'].includes(p.signer.status) && (!poa || !day(poa.date) || !text(poa.id, 255) || poa.number && !text(poa.number, 100))) result.push('Для подписи по электронной доверенности укажите дату и идентификатор файла доверенности; это не заменяет проверку полномочий в Saby.');
  if (poa && !['2', '5'].includes(p.signer.status)) result.push('Сведения электронной доверенности допустимы только для статуса подписанта 2 или 5.');
  try { encodeWindows1251(JSON.stringify(snapshot)); } catch { result.push('Данные ЭТрН содержат символы вне Windows-1251. Уберите эмодзи и неподдерживаемые символы.'); }
  return [...new Set(result)];
}
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const tag = (name: string, values: Record<string, string | null | undefined> = {}, content?: string): string => {
  const attrs = Object.entries(values).filter((entry): entry is [string, string] => typeof entry[1] === 'string' && !!entry[1]).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
  return content === undefined ? `<${name}${attrs}/>` : `<${name}${attrs}>${content}</${name}>`;
};
const address = (value: string) => tag('Адрес', {}, tag('АдрИнф', { КодСтр: '643', АдрТекст: value }));
function organization(value: SabyOrganization | EtrnParty): string { return tag('ИдСв', {}, tag('СвЮЛУч', { ИННЮЛ: value.inn, КПП: value.kpp, НаимОрг: value.name })) + address(value.address) + tag('Контакт', {}, tag('Тлф', {}, escape(value.phone!))); }
const nameXml = (value: EtrnName) => tag('ФИО', { Фамилия: value.surname, Имя: value.name, Отчество: value.patronymic });
function location(snapshot: SabyConsignmentSnapshot, kind: 'loading' | 'unloading'): string {
  const lat = snapshot.fields[`${kind}_latitude`]; const lon = snapshot.fields[`${kind}_longitude`];
  return (lat && lon ? tag('Коорд', { Широта: lat, Долгота: lon }) : '') + tag('АдресИнф', { КодСтр: '643', АдрТекст: snapshot.fields[`${kind}_address`] });
}
function documentBasis(value: EtrnDocumentBasis, element = 'ОснАрЛиз'): string {
  return tag(element, { НаимДок: value.name, НомерДок: value.number, ДатаДок: ruDay(value.date) }, value.issuerInns.map(inn => tag('ИдРекСост', {}, tag(inn.length === 12 ? 'ИННФЛ' : 'ИННЮЛ', {}, inn))).join(''));
}
function loadingRole(name: 'СвЛицПогрГр' | 'ВладИнфр', role: EtrnLoadingParty, senderInn: string): string {
  return tag(name, { [name === 'СвЛицПогрГр' ? 'СовпГОП' : 'СовпГОВ']: role.sameAsConsignor ? '1' : '2' }, role.sameAsConsignor ? tag('ИдентРекГО', {}, tag('ИННЮЛ', {}, senderInn)) : tag(name === 'СвЛицПогрГр' ? 'РекЛицПогрГр' : 'РекВладИнф', {}, organization(role.party)));
}
/** Stable unsigned sender title. Generated artifacts are never signatures or GIS receipts. */
export function serializeSabyConsignmentNote(snapshot: SabyConsignmentSnapshot, attemptId: string, createdAt: string): { xml: Buffer; name: string; number: string; uid: string } {
  const blockers = sabyConsignmentBlockers(snapshot);
  if (blockers.length) throw new SabyError('validation', blockers.join(' '));
  if (!uuid(attemptId) || !Number.isFinite(Date.parse(createdAt))) throw new SabyError('validation', 'Некорректный идентификатор или время формирования ЭТрН.');
  const p = snapshot.profile; const c = p.cargo; const v = p.vehicle;
  const timestamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'medium' }).format(new Date(createdAt));
  const [createdDate, createdTime] = timestamp.split(' '); const number = `CRM-${attemptId}`;
  // Saby fills absent participant IDs and the final filename at PrepareAction, before signing.
  const fileId = `ON_TRNACLGROT_${p.recipient.edoId || '0'}_${snapshot.carrierOrganization.edoId || '0'}_${snapshot.customerOrganization.edoId || '0'}_0_${createdDate.replaceAll('-', '')}_${attemptId}`;
  const mass = amount(p.deliveryMassTonnes, 1000);
  const cargo = tag('СвГруз', {}, tag('ОпГруз', { НаимГруз: c.name, СостГруз: c.condition, СпУпак: c.packingMethod, ВидТар: c.packagingCode, Объем: amount(snapshot.fields.quantity_litres!, 0.001), КолМестГр: c.packageCount },
    tag('Марк', {}, escape(c.marking)) + (c.dimensions ? tag('Габар', { ВысЗнач: c.dimensions.heightMetres, ДлЗнач: c.dimensions.lengthMetres, ШирЗнач: c.dimensions.widthMetres }) : '') +
    (c.dangerousGoods ? tag('СвОпГруз', { НомООН: c.dangerousGoods.unNumber, НадОтгНаим: c.dangerousGoods.shippingName, Клас: c.dangerousGoods.class, КласКод: c.dangerousGoods.classificationCode, ГрУп: c.dangerousGoods.packingGroup, ЗнОп: c.dangerousGoods.hazardSign, КодОгрЧерТун: c.dangerousGoods.tunnelCode }) : '') + tag('ПлМасГруз', { МасБрутЗнач: mass })));
  const instructions = tag('УказГО', { УкНормПрвз: p.instructions.regulatory, ЗапрПерегруз: p.instructions.transshipmentForbidden, ДатВрДостГр: moscowTime(snapshot.fields.unloading_planned_at), НалКоорТочВрДост: snapshot.fields.unloading_planned_at ? '1' : null }, tag('СвПА', { ЛицоПА: p.instructions.redirectionParty, СпосПерУкПА: p.instructions.redirectionMethod }, tag('КонтПА', {}, tag('Тлф', {}, escape(p.instructions.redirectionPhone)))));
  const driver = tag('СвВодит', { ИННФЛ: snapshot.driver.inn, СерВУ: snapshot.driver.licenseSeries, НомВУ: snapshot.driver.licenseNumber, ДатаВыдВУ: snapshot.driver.licenseIssuedAt ? ruDay(snapshot.driver.licenseIssuedAt) : null }, tag('Тлф', {}, escape(snapshot.driver.phone)) + nameXml(p.driver));
  const vehicle = tag('СвТС', {}, tag('ТС', { РегНомер: snapshot.vehicle.plate, НомерВИН: snapshot.vehicle.vin, НомСТС: snapshot.vehicle.stsNumber, ТипВлад: v.ownershipType }, tag('ПарТС', { Тип: v.type, Марка: v.brand, Грузопод: v.payloadTonnes, Вместим: v.capacityCubicMetres }) + (v.ownershipDocument ? documentBasis(v.ownershipDocument) : '')));
  const loading = tag('СвПогруз', { ЗаявПогр: moscowTime(snapshot.fields.loading_planned_at), НалКоорТочВрЗаяв: '1', ФДатВрПриб: moscowTime(p.loading.arrivedAt), НалКоорТочВрФПогр: '1', ФДатВрУбыт: moscowTime(p.loading.departedAt), НалКоорТочВрФУбыт: '1', МасБрутОтгр: mass, МетОпрМасс: c.massMethod, КолМестПрием: c.packageCount }, tag('ФАдресПогр', {}, location(snapshot, 'loading')) + loadingRole('СвЛицПогрГр', p.loadingActor, snapshot.customerOrganization.inn) + loadingRole('ВладИнфр', p.infrastructureOwner, snapshot.customerOrganization.inn));
  const content = tag('СодИнфГО', { УИД_ТрН: attemptId, СодОпер: 'Составление транспортной накладной грузоотправителем', НомерТрН: number, ДатаТрН: ruDay(snapshot.fields.date!), НомЗак: p.order.number, ДатаЗак: ruDay(p.order.date) }, tag('СвГО', { ГОЭксп: p.consignorIsForwarder }, tag('РекИдентГО', {}, organization(snapshot.customerOrganization))) +
    (p.consignorIsForwarder === '1' ? tag('СвЗак', {}, tag('РекИдентЗак', {}, organization(p.transportCustomer!)) + documentBasis(p.transportCustomerContract!, 'ДогУслПер')) : '') +
    tag('СвГП', {}, tag('РекИдентГП', {}, organization(p.recipient)) + tag('АдресДостГр', {}, location(snapshot, 'unloading'))) + cargo + instructions + tag('СвПер', {}, organization(snapshot.carrierOrganization)) + driver + vehicle + loading + tag('ИнфПол', {}, tag('ТекстИнф', { Идентиф: 'Рейс CRM', Значение: snapshot.tripId }) + tag('ТекстИнф', { Идентиф: 'Доставка CRM', Значение: snapshot.shipmentId })));
  const poa = p.signer.powerOfAttorney;
  const signer = tag('Подписант', { СтатПодп: p.signer.status, Должн: p.signer.position }, nameXml(p.signer) + (poa ? tag('СвДовер', { ДатаДовер: ruDay(poa.date), НомерДовер: poa.number, ИдентДовер: poa.id }) : ''));
  const xml = '<?xml version="1.0" encoding="windows-1251"?>' + tag('Файл', { ИдФайл: fileId, ВерсПрог: 'Artel-CRM', ВерсФорм: '5.01' }, tag('Документ', { КНД: '1110339', ПоФактХЖ: 'Транспортная накладная (информация грузоотправителя)', ДатИнфГО: ruDay(createdDate), ВрИнфГО: createdTime }, content + signer));
  return { xml: encodeWindows1251(xml), name: `${fileId}.xml`, number, uid: attemptId };
}
export function buildSabyConsignmentDocument(snapshot: SabyConsignmentSnapshot, marker: string, attemptId: string, createdAt: string): SabyObject {
  const { xml, number } = serializeSabyConsignmentNote(snapshot, attemptId, createdAt);
  const requisites = (value: SabyOrganization | EtrnParty) => ({ ...(value.edoId ? { Идентификатор: value.edoId } : {}), СвЮЛ: { ИНН: value.inn, КПП: value.kpp, Название: value.name } });
  return { Тип: 'ConsignmentNote', Регламент: { Название: 'Транспортная накладная' }, Номер: number, Дата: ruDay(snapshot.fields.date!), Примечание: marker,
    НашаОрганизация: requisites(snapshot.customerOrganization), Грузоотправитель: requisites(snapshot.customerOrganization), Грузополучатель: requisites(snapshot.profile.recipient), ТранспортнаяКомпания: requisites(snapshot.carrierOrganization),
    Вложение: [{ Файл: { ДвоичныеДанные: xml.toString('base64') } }],
  };
}

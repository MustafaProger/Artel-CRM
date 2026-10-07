import Decimal from 'decimal.js';
import { SabyError, type SabyObject, type SabyOrganization, sabyObject } from './saby-client';

/** Only confirmed data may be configured. These are not defaults for diesel or for a vehicle. */
export interface SabyCargoProfile {
  name: string; condition: string; packagingCode: string; packageCount: string;
  massMethod: '01' | '02' | '03'; distributable: '0' | '1'; divisible: '0' | '1';
  heightMetres: string; lengthMetres: string; widthMetres: string;
  dangerousGoods: null | { unNumber: string; shippingName: string; class: string; classificationCode: string; packingGroup: string; hazardSign: string; tunnelCode: string };
}
export interface SabyTransportProfile {
  function: 'Заказ' | 'Заявка';
  contract?: { name: string; number: string; date: string; issuerInns: string[] };
  regulatoryInstructions: string; foodInstructions: string;
  signatory: { surname: string; name: string; patronymic?: string; position: string; authorityMethod: '1' | '2' | '4' | '6' };
  cargoByProductId: Record<string, SabyCargoProfile>;
  vehicleById: Record<string, { type: string; payloadTonnes: string; capacityCubicMetres: string }>;
}
export interface SabyTransportSnapshot {
  tripId: string; shipmentId: string; version: number;
  fields: Record<string, string | null>;
  customer: SabyOrganization; supplier: SabyOrganization;
  driver: { name: string; phone: string }; vehicle: { plate: string; type: string };
  customerOrganization: SabyOrganization; carrierOrganization: SabyOrganization;
  profile: SabyTransportProfile | null;
  /** Present only in the trip workflow. Legacy per-delivery snapshots remain readable. */
  deliveries?: Array<{ shipmentId: string; fields: Record<string, string | null>; customer: SabyOrganization }>;
  intermediateStops?: Array<{ afterShipmentId: string; name: string; address: string }>;
  loadingInfrastructureOwner?: { name: string; inn: string };
  /** Confirmed limit in civil time representation required by 1110361, not actual operation time. */
  allowedOperationTime?: string;
  /** Requested document processing interval; no route time or cancellation is inferred. */
  processingDurationMinutes?: number;
}
export function readSabyTransportProfile(raw?: string): SabyTransportProfile | undefined {
  if (!raw) return undefined;
  try {
    const value: unknown = JSON.parse(raw); if (!sabyObject(value)) return undefined;
    // Keep a closed set of document fields; unrelated configuration never enters a saved snapshot.
    const pick = (row: unknown, keys: string[]): SabyObject => Object.fromEntries(keys.map(key => [key, sabyObject(row) && typeof row[key] === 'string' ? row[key] : '']));
    const cargoByProductId = Object.fromEntries(Object.entries(sabyObject(value.cargoByProductId) ? value.cargoByProductId : {}).map(([id, cargo]) => [id, { ...pick(cargo, ['name', 'condition', 'packagingCode', 'packageCount', 'massMethod', 'distributable', 'divisible', 'heightMetres', 'lengthMetres', 'widthMetres']), ...(sabyObject(cargo) && Object.hasOwn(cargo, 'dangerousGoods') ? { dangerousGoods: cargo.dangerousGoods === null ? null : pick(cargo.dangerousGoods, ['unNumber', 'shippingName', 'class', 'classificationCode', 'packingGroup', 'hazardSign', 'tunnelCode']) } : {}) }]));
    const vehicleById = Object.fromEntries(Object.entries(sabyObject(value.vehicleById) ? value.vehicleById : {}).map(([id, vehicle]) => [id, pick(vehicle, ['type', 'payloadTonnes', 'capacityCubicMetres'])]));
    const signatory = pick(value.signatory, ['surname', 'name', 'position', 'authorityMethod']);
    if (sabyObject(value.signatory) && value.signatory.patronymic !== undefined) signatory.patronymic = typeof value.signatory.patronymic === 'string' ? value.signatory.patronymic : '';
    const contract = sabyObject(value.contract) ? { ...pick(value.contract, ['name', 'number', 'date']), issuerInns: Array.isArray(value.contract.issuerInns) ? value.contract.issuerInns.filter(item => typeof item === 'string') : [] } : undefined;
    return { ...pick(value, ['function', 'regulatoryInstructions', 'foodInstructions']), ...(contract ? { contract } : {}), signatory, cargoByProductId, vehicleById } as unknown as SabyTransportProfile;
  } catch { return undefined; }
}
const nonempty = (value: unknown, max = 1000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && ![...value].some(char => char.charCodeAt(0) < 32 && ![9, 10, 13].includes(char.charCodeAt(0)));
function decimal(value: unknown, digits: number, fraction: number, positive = false): boolean {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return false;
  const number = new Decimal(value);
  return (!positive || number.gt(0)) && number.decimalPlaces() <= fraction && number.toFixed().replace('.', '').replace(/^0+/, '').length <= digits;
}
function quantity(value: unknown, divisor: number): string | null {
  if (typeof value !== 'string' || !/^\d+(?:\.\d+)?$/.test(value)) return null;
  return new Decimal(value).div(divisor).toFixed();
}
const dateOnly = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`); return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
};
function plannedTime(value: unknown): string | null {
  // CRM local planned times are explicitly Moscow civil time; never fill midnight or actual events.
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) return null;
  const [day, time] = value.split('T');
  if (!dateOnly(day) || !/^([01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(time)) return null;
  return `${day.split('-').reverse().join('.')}T${time.length === 5 ? `${time}:00` : time}+03:00`;
}
function profileParts(snapshot: SabyTransportSnapshot) {
  const profile = sabyObject(snapshot.profile) ? snapshot.profile : null;
  const cargo = profile && sabyObject(profile.cargoByProductId) ? profile.cargoByProductId[snapshot.fields.product_id ?? ''] : undefined;
  const vehicle = profile && sabyObject(profile.vehicleById) ? profile.vehicleById[snapshot.fields.vehicle_id ?? ''] : undefined;
  return { profile, cargo: sabyObject(cargo) ? cargo : null, vehicle: sabyObject(vehicle) ? vehicle : null };
}
function transportBlockers(snapshot: SabyTransportSnapshot, draft = false): string[] {
  const errors: string[] = [];
  const driverFlow = snapshot.fields.trip_flow_version === 'driver-v1';
  const massPending = draft && driverFlow && !snapshot.fields.quantity_tonnes;
  if (draft && !driverFlow) errors.push('Неполный черновик доступен только для нового сценария водителя.');
  if (driverFlow && !snapshot.deliveries) errors.push('Для нового сценария нужны отдельные позиции всех доставок.');
  const { profile, cargo, vehicle } = profileParts(snapshot);
  if (!dateOnly(snapshot.fields.date)) errors.push('Для Saby нужна корректная дата рейса.');
  if (!nonempty(snapshot.fields.loading_address)) errors.push('Укажите фактический адрес площадки погрузки.');
  if (!snapshot.deliveries && !nonempty(snapshot.fields.unloading_address)) errors.push('Укажите фактический адрес каждой площадки доставки.');
  if (!plannedTime(snapshot.fields.loading_planned_at)) errors.push('Для заказа Saby укажите плановые дату и время подачи машины (московское время).');
  if (snapshot.fields.unloading_planned_at && !plannedTime(snapshot.fields.unloading_planned_at)) errors.push('Проверьте плановые дату и время доставки.');
  if (!snapshot.driver.name || !snapshot.vehicle.plate) errors.push('Выберите водителя и фактическую машину рейса.');
  if (!snapshot.deliveries && !snapshot.customer.name) errors.push('Выберите клиента доставки.');
  if (!decimal(quantity(snapshot.fields.quantity_litres, 1000), 5, 2, true)) errors.push('Объём заказа Saby должен быть положительным и точно представляться в м³ с 2 знаками, без округления литров.');
  if (!massPending && !decimal(quantity(snapshot.fields.quantity_tonnes, 0.001), 17, 3, true)) errors.push('Масса груза Saby должна быть положительной и точно представляться в кг с 3 знаками.');
  for (const [name, org] of [['заказчика', snapshot.customerOrganization], ['перевозчика', snapshot.carrierOrganization]] as const) {
    if (!/^\d{10}$/.test(org.inn) || !/^\d{9}$/.test(org.kpp) || !nonempty(org.name) || !nonempty(org.address)) errors.push(`Проверьте ИНН, КПП, название и адрес ${name} для формата Saby.`);
    if (!nonempty(org.phone, 255)) errors.push(`Для формата заказа Saby требуется контактный телефон ${name}.`);
    if (!nonempty(org.edoId, 70) || !/^[A-Za-z0-9-]+$/.test(org.edoId ?? '')) errors.push(`Не подтверждён идентификатор участника ЭДО ${name} в Saby.`);
  }
  if (!profile || !['Заказ', 'Заявка'].includes(String(profile.function))) errors.push('Не настроены подтверждённые параметры формализованного заказа Saby.');
  const contract = profile && sabyObject(profile.contract) ? profile.contract : null;
  if (profile?.function === 'Заявка' && (!contract || !nonempty(contract.name, 255) || !nonempty(contract.number, 255) || !dateOnly(contract.date) || !Array.isArray(contract.issuerInns) || !contract.issuerInns.length || contract.issuerInns.some(inn => typeof inn !== 'string' || !/^\d{10}$/.test(inn)))) errors.push('Для заявки Saby укажите подтверждённые название, номер, дату и ИНН составителей договора организации перевозки.');
  if (!profile || !nonempty(profile.regulatoryInstructions, 2000) || !nonempty(profile.foodInstructions)) errors.push('Подтвердите указания о нормативных требованиях и пищевой продукции для заказа Saby.');
  const signatory = profile && sabyObject(profile.signatory) ? profile.signatory : null;
  if (!signatory || !nonempty(signatory.surname, 60) || !nonempty(signatory.name, 60) || signatory.patronymic !== undefined && !nonempty(signatory.patronymic, 60) || !nonempty(signatory.position, 255) || !['1', '2', '4', '6'].includes(String(signatory.authorityMethod))) errors.push('Для XML заказа нужны подтверждённые ФИО, должность и основание полномочий подписанта; подпись в CRM не выполняется.');
  if (!cargo || !nonempty(cargo.name, 2000) || !nonempty(cargo.condition) || (!nonempty(cargo.packagingCode, 2) || cargo.packagingCode.length !== 2) || !/^\d{1,4}$/.test(String(cargo.packageCount)) || !['01', '02', '03'].includes(String(cargo.massMethod)) || !['0', '1'].includes(String(cargo.distributable)) || !['0', '1'].includes(String(cargo.divisible))) errors.push('Для выбранного продукта не подтверждены транспортное наименование, состояние, упаковка, число мест, метод массы и признаки груза Saby.');
  if (!cargo || ![cargo.heightMetres, cargo.lengthMetres, cargo.widthMetres].every(value => decimal(value, 5, 3))) errors.push('Для выбранного продукта подтвердите габариты грузового места; неизвестные значения не заменяются нулями.');
  if (!cargo || !Object.hasOwn(cargo, 'dangerousGoods') || cargo.dangerousGoods !== null && (!sabyObject(cargo.dangerousGoods) || !['unNumber', 'shippingName', 'class', 'classificationCode', 'packingGroup', 'hazardSign', 'tunnelCode'].every(key => nonempty((cargo.dangerousGoods as SabyObject)[key], key === 'shippingName' ? 2000 : key === 'class' ? 3 : 50)))) errors.push('Подтвердите классификацию опасного груза по документам именно этого продукта (или явно отсутствие опасного груза).');
  if (!vehicle || !nonempty(vehicle.type) || !decimal(vehicle.payloadTonnes, 5, 2, true) || !decimal(vehicle.capacityCubicMetres, 5, 2, true)) errors.push('Для выбранной машины подтвердите тип, грузоподъёмность в т и вместимость в м³.');
  if (vehicle && decimal(vehicle.capacityCubicMetres, 5, 2, true) && quantity(snapshot.fields.quantity_litres, 1000) && new Decimal(snapshot.fields.quantity_litres!).div(1000).gt(String(vehicle.capacityCubicMetres))) errors.push('Объём доставки превышает подтверждённую вместимость машины.');
  if (snapshot.intermediateStops?.some(row => !nonempty(row.name) || !nonempty(row.address) || `После ${row.afterShipmentId}: ${row.name}; ${row.address}`.length > 1000 || !snapshot.deliveries?.some(delivery => delivery.shipmentId === row.afterShipmentId))) errors.push('Проверьте адреса и порядок промежуточных точек общей заявки.');
  if (snapshot.deliveries) {
    const net = quantity(snapshot.fields.quantity_tonnes, 0.001);
    const gross = quantity(snapshot.fields.quantity_gross_tonnes, 0.001);
    if (!massPending && !decimal(gross, 17, 3, true)) errors.push('Укажите корректную плановую массу груза общей заявки.');
    if (decimal(net, 17, 3, true) && decimal(gross, 17, 3, true) && new Decimal(gross!).lt(net!)) errors.push('Плановая масса брутто заявки не может быть меньше нетто.');
    if (decimal(gross, 17, 3, true) && vehicle && decimal(vehicle.payloadTonnes, 5, 2, true) && new Decimal(gross!).div(1000).gt(String(vehicle.payloadTonnes))) errors.push('Плановая масса брутто общей заявки превышает грузоподъёмность машины.');
    const ids = new Set<string>();
    if (!snapshot.deliveries.length || snapshot.deliveries.length > 100) errors.push('Для общей заявки нужны доставки рейса.');
    for (const row of snapshot.deliveries) {
      if (!row.shipmentId || ids.has(row.shipmentId)) errors.push('Каждая доставка общей заявки должна иметь отдельный идентификатор.');
      ids.add(row.shipmentId);
      if (!row.customer.name || !nonempty(row.fields.unloading_address)) errors.push('Для каждой доставки общей заявки нужны клиент и фактический адрес.');
      if ((!driverFlow || row.fields.unloading_planned_at) && !plannedTime(row.fields.unloading_planned_at)) errors.push('Проверьте плановое время каждой доставки.');
      if (!decimal(row.fields.quantity_litres, 17, 3, true)) errors.push('Для каждой доставки общей заявки нужны положительные литры.');
      if (driverFlow) {
        if (!decimal(quantity(row.fields.quantity_litres, 1000), 5, 2, true)) errors.push('Объём каждой позиции груза должен точно представляться в м³ с 2 знаками, без округления литров.');
        if (massPending && (row.fields.quantity_tonnes || row.fields.quantity_gross_tonnes || snapshot.fields.quantity_gross_tonnes)) errors.push('Черновик до водителя не должен содержать частичный набор масс.');
        if (!massPending && (!decimal(quantity(row.fields.quantity_tonnes, 0.001), 17, 3, true) || !decimal(quantity(row.fields.quantity_gross_tonnes, 0.001), 17, 3, true))) errors.push('Для каждой доставки нужна положительная масса нетто и брутто из принятого действия водителя.');
        if (!massPending && row.fields.quantity_tonnes && row.fields.quantity_gross_tonnes && decimal(row.fields.quantity_tonnes, 20, 6, true) && decimal(row.fields.quantity_gross_tonnes, 20, 6, true) && !new Decimal(row.fields.quantity_tonnes).eq(row.fields.quantity_gross_tonnes)) errors.push('Для согласованного наливного топлива брутто должно совпадать с нетто доставки.');
        if (row.fields.product_id !== snapshot.fields.product_id) errors.push('Груз доставки должен соответствовать сохранённому товару рейса.');
        if (!/^\d{10}(?:\d{2})?$/.test(row.customer.inn)) errors.push('У каждой доставки должен быть подтверждённый ИНН получателя.');
      }
    }
    if (snapshot.deliveries.every(row => decimal(row.fields.quantity_litres, 17, 3, true)) && decimal(snapshot.fields.quantity_litres, 17, 3, true) && !snapshot.deliveries.reduce((total, row) => total.plus(row.fields.quantity_litres!), new Decimal(0)).eq(snapshot.fields.quantity_litres!)) errors.push('Общий объём заявки должен совпадать с суммой доставок.');
    if (!snapshot.loadingInfrastructureOwner?.name || !/^\d{10}(?:\d{2})?$/.test(snapshot.loadingInfrastructureOwner.inn)) errors.push('Для общей заявки нужен подтверждённый владелец инфраструктуры погрузки.');
    if ((!driverFlow || snapshot.allowedOperationTime) && (!snapshot.allowedOperationTime || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d[+-]\d{2}:\d{2}$/.test(snapshot.allowedOperationTime))) errors.push('Для общей заявки нужно подтверждённое допустимое время операции.');
    if (driverFlow && snapshot.allowedOperationTime) errors.push('В новом сценарии не согласовано предельное время маршрута; интервал обработки документов не является временем суток.');
    if (driverFlow && !massPending && snapshot.deliveries.every(row => decimal(row.fields.quantity_tonnes, 20, 6, true)) && decimal(snapshot.fields.quantity_tonnes, 20, 6, true) && !snapshot.deliveries.reduce((sum, row) => sum.plus(row.fields.quantity_tonnes!), new Decimal(0)).eq(snapshot.fields.quantity_tonnes!)) errors.push('Масса общей заявки должна точно совпадать с суммой масс доставок.');
    if (driverFlow && cargo && (cargo.massMethod !== '03' || cargo.packageCount !== '1')) errors.push('Для согласованного наливного топлива нужны расчётная масса и одно грузовое место на доставку.');
  }
  return [...new Set(errors)];
}
export const sabyTransportBlockers = (snapshot: SabyTransportSnapshot): string[] => transportBlockers(snapshot);
/** Only missing driver masses are allowed; this is not a signable formal document. */
export const sabyTransportDraftBlockers = (snapshot: SabyTransportSnapshot): string[] => transportBlockers(snapshot, true);
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
const attrs = (values: Record<string, string | null | undefined>) => Object.entries(values).filter((entry): entry is [string, string] => !!entry[1]).map(([key, value]) => ` ${key}="${escape(value)}"`).join('');
const tag = (name: string, values: Record<string, string | null | undefined>, content?: string) => content === undefined ? `<${name}${attrs(values)}/>` : `<${name}${attrs(values)}>${content}</${name}>`;
const address = (text: string) => tag('Адрес', {}, tag('АдрИнф', { КодСтр: '643', АдрТекст: text }));
function organization(name: string, org: SabyOrganization) {
  return tag(name, {}, tag('ИдСв', {}, tag('СвЮЛУч', { ИННЮЛ: org.inn, КПП: org.kpp, НаимОрг: org.name })) + address(org.address) + tag('Конт', {}, tag('Тлф', {}, escape(org.phone!))));
}
function pointAddress(snapshot: SabyTransportSnapshot, kind: 'loading' | 'unloading') {
  // Coordinates are optional: no inference from legal addresses or map links.
  const lat = snapshot.fields[`${kind}_latitude`]; const lon = snapshot.fields[`${kind}_longitude`];
  const coords = lat && lon ? tag('Коорд', { Широта: lat, Долгота: lon }) : '';
  return coords + address(snapshot.fields[`${kind}_address`]!);
}
function info(values: Record<string, string | null | undefined>) {
  return tag('ИнфПол', {}, Object.entries(values).filter((entry): entry is [string, string] => !!entry[1]).map(([Идентиф, Значение]) => tag('ТекстИнф', { Идентиф, Значение })).join(''));
}
/** Encode exactly as required by the TMS order API; unsupported characters are rejected. */
export function encodeWindows1251(value: string): Buffer {
  const decoder = new TextDecoder('windows-1251');
  const codes = new Map(Array.from({ length: 256 }, (_, byte) => [decoder.decode(Uint8Array.of(byte)), byte] as const));
  return Buffer.from([...value].map(char => { const byte = codes.get(char); if (byte === undefined) throw new SabyError('validation', 'Текст заказа содержит символы, не представимые в Windows-1251. Уберите эмодзи и неподдерживаемые символы.'); return byte; }));
}
function serializeTransport(snapshot: SabyTransportSnapshot, attemptId: string, createdAt: string, explicitNumber?: string, draft = false): { xml: Buffer; name: string; number: string } {
  const errors = transportBlockers(snapshot, draft); if (errors.length) throw new SabyError('validation', errors.join(' '));
  const profile = snapshot.profile!; const cargo = profile.cargoByProductId[snapshot.fields.product_id!]; const vehicle = profile.vehicleById[snapshot.fields.vehicle_id!];
  const number = explicitNumber ?? `CRM-${attemptId}`;
  if (!nonempty(number, 255)) throw new SabyError('validation', 'Saby не подтвердил номер заявки.');
  const created = new Date(createdAt);
  const stamp = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'medium' }).format(created);
  const [createdDate, createdTime] = stamp.split(' ');
  const name = `ON_ZAKZVGO_${snapshot.carrierOrganization.edoId}_${snapshot.customerOrganization.edoId}_0_${createdDate.replaceAll('-', '')}_${attemptId}`;
  const pickup = tag('ПунктПод', { ДатВрПод: plannedTime(snapshot.fields.loading_planned_at), НалКоорТочВрПод: '1', ПредВрПод: snapshot.allowedOperationTime, НалКоорТочПредВрПод: snapshot.allowedOperationTime ? '1' : null }, tag('АдрПунктПод', {}, pointAddress(snapshot, 'loading')));
  const points = [{ kind: 'loading' as const, point: snapshot }, ...(snapshot.deliveries ? snapshot.deliveries.map(row => ({ kind: 'unloading' as const, point: { ...snapshot, fields: row.fields } })) : [{ kind: 'unloading' as const, point: snapshot }])];
  const route = points.map(({ kind, point }, index) => tag('АдрПункт', { Опер: kind === 'loading' ? 'Погрузка' : 'Выгрузка', ПорНомПункт: String(index + 1), ДатВрОпер: plannedTime(point.fields[`${kind}_planned_at`]), НалКоорТочВрОпер: plannedTime(point.fields[`${kind}_planned_at`]) ? '1' : null, ПредВрОпер: snapshot.allowedOperationTime, НалКоорТочПредВрОпер: snapshot.allowedOperationTime ? '1' : null }, tag('АдресПункт', {}, pointAddress(point, kind)) + (kind === 'loading' && snapshot.loadingInfrastructureOwner ? tag('ОргВладИнфр', { НаимВладИнфр: snapshot.loadingInfrastructureOwner.name, ИННВладИнфр: snapshot.loadingInfrastructureOwner.inn }) : ''))).join('');
  const dangerous = cargo.dangerousGoods ? tag('ИнфОпасн', { НомООН: cargo.dangerousGoods.unNumber, НадОтгНаим: cargo.dangerousGoods.shippingName, Клас: cargo.dangerousGoods.class, КласКод: cargo.dangerousGoods.classificationCode, ГрУп: cargo.dangerousGoods.packingGroup, ЗнОп: cargo.dangerousGoods.hazardSign, КодОгрЧерТун: cargo.dangerousGoods.tunnelCode }) : '';
  const driverFlow = snapshot.fields.trip_flow_version === 'driver-v1';
  const cargoRows = driverFlow ? snapshot.deliveries! : [{ shipmentId: snapshot.shipmentId, fields: snapshot.fields, customer: snapshot.customer }];
  const freight = cargoRows.map((row, index) => {
    const net = quantity(row.fields.quantity_tonnes, 0.001);
    const gross = quantity(driverFlow || snapshot.deliveries ? row.fields.quantity_gross_tonnes : row.fields.quantity_tonnes, 0.001);
    // A pre-driver upload is deliberately incomplete and cannot pass Prepare/Execute.
    // Write/readback must prove Saby retained these exact cargo positions before calling it a draft.
    const mass = draft && !net && !gross ? '' : tag('МасГруз', { МасБрутЗнач: gross, МасНетЗнач: driverFlow || snapshot.deliveries ? net : null });
    return tag('ОпГруз', { НаимГруз: cargo.name, СостГруз: cargo.condition, ВидТар: cargo.packagingCode, КолГрМест: cargo.packageCount, МетОпрМасс: cargo.massMethod, Объем: quantity(row.fields.quantity_litres, 1000), РаспрГр: cargo.distributable, ДелГр: cargo.divisible }, mass + tag('РазмерГрМест', { ВысЗнач: cargo.heightMetres, ДлЗнач: cargo.lengthMetres, ШирЗнач: cargo.widthMetres }) + dangerous + (driverFlow ? tag('Пункт', { Погр: '1', Выгр: String(index + 2), КолГрМест: '1' }) + info({ 'Доставка CRM': row.shipmentId, 'Получатель доставки': row.customer.name, 'ИНН получателя': row.customer.inn, 'Адрес доставки': row.fields.unloading_address }) : ''));
  }).join('');
  const signer = profile.signatory;
  const content = tag('СодИнфГО', { УИД_Зак: attemptId, СодОпер: 'Предоставление заказа и заявки на перевозку груза автомобильным транспортом', НомЗак: number, ДатаЗак: snapshot.fields.date!.split('-').reverse().join('.'), УкНормПрвз: profile.regulatoryInstructions, ПрвзПищПрод: profile.foodInstructions }, (snapshot.intermediateStops ?? []).map(row => tag('ПромПунктМрш', {}, escape(`После ${row.afterShipmentId}: ${row.name}; ${row.address}`))).join('') + organization('СвГО', snapshot.customerOrganization) + organization('СвПрв', snapshot.carrierOrganization) + pickup + route + freight + tag('ПарТСПрвз', { Тип: vehicle.type, Грузопод: vehicle.payloadTonnes, Вместим: vehicle.capacityCubicMetres }) + info({ 'Рейс CRM': snapshot.tripId, 'Доставка CRM': snapshot.shipmentId, 'Получатель доставки': snapshot.customer.name, 'ИНН получателя': snapshot.customer.inn, 'Поставщик': snapshot.supplier.name, 'Владелец нефтебазы': snapshot.fields.loading_site_owner_name, 'ИНН владельца нефтебазы': snapshot.fields.loading_site_owner_inn, 'Юридический адрес владельца нефтебазы': snapshot.fields.loading_site_owner_address, 'Водитель (план)': snapshot.driver.name, 'Телефон водителя': snapshot.driver.phone, 'Машина (план)': snapshot.vehicle.plate, 'Карта погрузки': snapshot.fields.loading_map_url, 'Карта доставки': snapshot.fields.unloading_map_url, ...(snapshot.deliveries ? Object.fromEntries(snapshot.deliveries.map((row, index) => [`Доставка ${index + 1}`, `${row.shipmentId}: ${row.customer.name}; ${row.fields.quantity_litres} л; ${row.fields.unloading_address}`])) : {}), ...(snapshot.intermediateStops ? Object.fromEntries(snapshot.intermediateStops.map((row, index) => [`Промежуточная точка ${index + 1}`, `После ${row.afterShipmentId}: ${row.name}; ${row.address}`])) : {}) }));
  const contractXml = profile.function === 'Заявка' && profile.contract ? tag('ДогОргПрвз', { НаимДок: profile.contract.name, НомерДок: profile.contract.number, ДатаДок: profile.contract.date.split('-').reverse().join('.') }, profile.contract.issuerInns.map(inn => tag('ИдРекСост', {}, tag('ИННЮЛ', {}, inn))).join('')) : '';
  const signatureInfo = tag('ПодпИнфГО', { Должн: signer.position, СпосПодтПолном: signer.authorityMethod }, tag('ФИО', { Фамилия: signer.surname, Имя: signer.name, Отчество: signer.patronymic }));
  const xml = '<?xml version="1.0" encoding="windows-1251"?>' + tag('Файл', { ИдФайл: name, ВерсПрог: 'Artel-CRM', ВерсФорм: '5.01' }, tag('Документ', { КНД: '1110361', Функция: profile.function, ДатИнфГО: createdDate.split('-').reverse().join('.'), ВрИнфГО: createdTime, НаимЭкСубСост: snapshot.customerOrganization.name }, contractXml + content + signatureInfo));
  return { xml: encodeWindows1251(xml), name: `${name}.xml`, number };
}
export function serializeSabyTransportOrder(snapshot: SabyTransportSnapshot, attemptId: string, createdAt: string, explicitNumber?: string) {
  return serializeTransport(snapshot, attemptId, createdAt, explicitNumber);
}
/** Incomplete unsigned XML for Write only; never evidence of acceptance or a valid signing title. */
export function serializeSabyTransportDraft(snapshot: SabyTransportSnapshot, attemptId: string, createdAt: string, explicitNumber?: string) {
  return serializeTransport(snapshot, attemptId, createdAt, explicitNumber, true);
}
function transportDocument(snapshot: SabyTransportSnapshot, marker: string, attemptId: string, createdAt: string, explicitNumber?: string, draft = false): SabyObject {
  const { xml, name, number } = serializeTransport(snapshot, attemptId, createdAt, explicitNumber, draft);
  return { Тип: 'TransportOrder', Регламент: { Название: 'Заказ на перевозку' }, Номер: number, Дата: snapshot.fields.date!.split('-').reverse().join('.'), Примечание: marker, НашаОрганизация: { СвЮЛ: { ИНН: snapshot.customerOrganization.inn, КПП: snapshot.customerOrganization.kpp, Название: snapshot.customerOrganization.name } }, Контрагент: { Идентификатор: snapshot.carrierOrganization.edoId, СвЮЛ: { ИНН: snapshot.carrierOrganization.inn, КПП: snapshot.carrierOrganization.kpp, Название: snapshot.carrierOrganization.name } }, Вложение: [{ Файл: { Имя: name, ДвоичныеДанные: xml.toString('base64') } }] };
}

export function buildSabyTransportDocument(snapshot: SabyTransportSnapshot, marker: string, attemptId: string, createdAt: string, explicitNumber?: string): SabyObject {
  return transportDocument(snapshot, marker, attemptId, createdAt, explicitNumber);
}
export function buildSabyTransportDraftDocument(snapshot: SabyTransportSnapshot, marker: string, attemptId: string, createdAt: string, explicitNumber?: string): SabyObject {
  return transportDocument(snapshot, marker, attemptId, createdAt, explicitNumber, true);
}

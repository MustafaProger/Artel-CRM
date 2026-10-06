import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Snapshot } from '../web/src/model';
import { validInn } from './checko';
import { parseXml, type XmlNode } from './saby-order-evidence';
import { encodeWindows1251 } from './saby-transport-order';
import { SabyError, type SabyCarrierResponsible } from './saby-client';
import type { TripSabyRecord } from './trip-saby-workflow';

const node = (name: string, attributes: Record<string, string> = {}, children: Array<XmlNode | string> = []): XmlNode => ({ name, attributes, children });
export const xmlChildren = (parent: XmlNode, name: string) => parent.children.filter((value): value is XmlNode => typeof value !== 'string' && value.name === name);
const only = (parent: XmlNode, name: string) => { const matches = xmlChildren(parent, name); if (matches.length !== 1) throw new SabyError('validation', 'Неоднозначная структура ответа НК. Проверьте черновик в Saby.'); return matches[0]; };
const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
export const serializeXml = (value: XmlNode): string => `<${value.name}${Object.entries(value.attributes).map(([key, text]) => ` ${key}="${escape(text)}"`).join('')}>${value.children.map(child => typeof child === 'string' ? escape(child) : serializeXml(child)).join('')}</${value.name}>`;
function canonical(value: XmlNode): unknown {
  return [value.name, Object.entries(value.attributes).sort(([a], [b]) => a.localeCompare(b)), value.children.flatMap(child => typeof child === 'string' ? child.trim() ? [child] : [] : [canonical(child)])];
}
export const carrierXmlHash = (bytes: Uint8Array) => createHash('sha256').update(JSON.stringify(canonical(parseXml(bytes)))).digest('hex');
const same = (left: XmlNode, right: XmlNode) => JSON.stringify(canonical(left)) === JSON.stringify(canonical(right));
const text = (value: string | undefined, max = 255) => !!value?.trim() && value.length <= max && ![...value].some(char => char.charCodeAt(0) < 32);
const positive = (value: string | undefined) => !!value && /^\d+(?:\.\d{1,2})?$/.test(value) && new Decimal(value).gt(0) && value.replace('.', '').length <= 5;
const date = (value: string | undefined) => !!value && /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
export interface CarrierDetailsInput { driver: XmlNode | null; vehicle: XmlNode | null; responsible?: XmlNode | null; paymentCalculation?: 'По договору'; blockers: string[] }

/** Supplementary details come from the exact driver/vehicle selected in the frozen order. */
export function carrierDetailsInput(snapshot: Snapshot, record: TripSabyRecord, responsible?: SabyCarrierResponsible | null): CarrierDetailsInput {
  const driver = snapshot.directories?.drivers.find(row => row.id === record.snapshot.fields.driver_id);
  const vehicle = snapshot.directories?.vehicles.find(row => row.id === record.snapshot.fields.vehicle_id);
  const driverErrors: string[] = [], vehicleErrors: string[] = [];
  const fullName = driver?.fullName?.trim() ?? '';
  const names = fullName.split(/\s+/);
  if (!driver || fullName !== record.snapshot.driver.name.trim() || names.length < 2 || names.length > 3 || names.some(name => !text(name, 60))) driverErrors.push('Сверьте полное ФИО выбранного водителя с сохранённой заявкой.');
  if (!driver?.phone || !/^\+?[\d ()-]{7,25}$/.test(driver.phone)) driverErrors.push('Укажите телефон водителя.');
  if (!driver?.inn || !/^\d{12}$/.test(driver.inn) || !validInn(driver.inn)) driverErrors.push('Для ответа НК нужен подтверждённый ИНН водителя.');
  if (!/^\d{4}$/.test(driver?.licenseSeries ?? '') || !/^\d{6}$/.test(driver?.licenseNumber ?? '') || !date(driver?.licenseIssuedAt)) driverErrors.push('Заполните серию, номер и дату выдачи действующих водительских прав.');
  if (!vehicle || vehicle.plate !== record.snapshot.vehicle.plate || !text(vehicle.plate, 20)) vehicleErrors.push('Сверьте машину рейса с сохранённой заявкой.');
  const type = vehicle?.transportVehicleType || vehicle?.vehicleType;
  if (!text(type, 1000) || !text(vehicle?.brand, 1000)) vehicleErrors.push('Заполните марку и тип автомобиля.');
  if (!positive(vehicle?.payloadTonnes) || vehicle?.maxWeight && /^\d+(?:\.\d+)?$/.test(vehicle.maxWeight) && positive(vehicle.payloadTonnes) && new Decimal(vehicle.payloadTonnes!).mul(1000).gt(vehicle.maxWeight)) vehicleErrors.push('Укажите согласованное максимальное значение для Saby в тоннах. Проверьте единицы: килограммы нужно разделить на 1000.');
  const litres = vehicle?.capacityLitres;
  const capacity = litres && /^\d+(?:\.\d+)?$/.test(litres) ? new Decimal(litres).div(1000).toFixed() : '';
  if (!positive(capacity)) vehicleErrors.push('Вместимость цистерны должна точно выражаться в м³ с двумя знаками, без округления.');
  if (!['1', '2', '3', '4', '5'].includes(vehicle?.ownershipType ?? '')) vehicleErrors.push('Укажите тип владения автомобилем.');
  const issuerInns = (vehicle?.leaseDocumentIssuerInn || '').split(',').map(value => value.trim()).filter(Boolean);
  const needsLease = ['3', '4', '5'].includes(vehicle?.ownershipType ?? '');
  if (needsLease && (!text(vehicle?.leaseDocumentName) || !text(vehicle?.leaseDocumentNumber) || !date(vehicle?.leaseDocumentDate) || !issuerInns.length || issuerInns.some(inn => !validInn(inn)))) vehicleErrors.push('Для аренды или лизинга нужны сохранённые реквизиты договора и ИНН составителя.');
  // A trailer needs a structured, verified mapping; a free-text plate is insufficient.
  if (vehicle?.trailer?.trim()) vehicleErrors.push('Сверьте прицеп в Saby: его реквизиты пока не подготовлены для автоматического заполнения.');
  const driverNode = driverErrors.length ? null : node('СвВодит', { НомВУ: driver!.licenseNumber!, СерВУ: driver!.licenseSeries!, ДатаВыдВУ: driver!.licenseIssuedAt!.split('-').reverse().join('.'), ИННФЛ: driver!.inn! }, [node('Тлф', {}, [driver!.phone!]), node('ФИО', { Фамилия: names[0], Имя: names[1], ...(names[2] ? { Отчество: names[2] } : {}) })]);
  const vehicleNode = vehicleErrors.length ? null : node('ТС', { РегНомер: vehicle!.plate, ТипВлад: vehicle!.ownershipType! }, [
    node('ПарТС', { Тип: type!, Марка: vehicle!.brand!, Грузопод: vehicle!.payloadTonnes!, Вместим: capacity }),
    ...(needsLease ? [node('ОснАрЛиз', { НаимДок: vehicle!.leaseDocumentName!, НомерДок: vehicle!.leaseDocumentNumber!, ДатаДок: vehicle!.leaseDocumentDate!.split('-').reverse().join('.') }, issuerInns.map(inn => node('ИдРекСост', {}, [node(inn.length === 10 ? 'ИННЮЛ' : 'ИННФЛ', {}, [inn])])))] : []),
  ]);
  const responsibleInvalid = responsible !== undefined && (!responsible || ![responsible.surname, responsible.name, responsible.patronymic].every(value => text(value, 60)) || !/^\+\d{11,15}$/.test(responsible.phone));
  return { driver: driverNode, vehicle: vehicleNode, ...(responsible !== undefined ? { responsible: responsibleInvalid ? null : node('СвЛицОргПрвз', {}, [node('Тлф', {}, [responsible!.phone]), node('ФИО', { Фамилия: responsible!.surname, Имя: responsible!.name, Отчество: responsible!.patronymic })]) } : {}), ...(record.carrierFill?.paymentCalculation !== undefined ? { paymentCalculation: record.carrierFill.paymentCalculation } : {}), blockers: [...driverErrors, ...vehicleErrors, ...(responsibleInvalid ? ['Проверьте серверную настройку ФИО и телефона ответственного НК.'] : [])] };
}

/** Preserve Saby's current link/signatory and every unrelated field; never replace someone's edits. */
export function patchCarrierDetails(bytes: Uint8Array, senderBytes: Uint8Array, input: CarrierDetailsInput, lastVerifiedHash?: string) {
  const beforeHash = carrierXmlHash(bytes);
  // Refresh our own unchanged draft after a directory correction. A manual edit
  // anywhere in the document invalidates this permission, including payment data.
  const mayRefresh = !!lastVerifiedHash && beforeHash === lastVerifiedHash;
  const root = parseXml(bytes), sender = parseXml(senderBytes);
  const doc = only(root, 'Документ'), senderDoc = only(sender, 'Документ');
  const link = only(doc, 'ИдИнфГО'), content = only(doc, 'СодИнфПрв');
  if (root.name !== 'Файл' || root.attributes.ВерсФорм !== '5.01' || doc.attributes.КНД !== '1110362' || senderDoc.attributes.КНД !== '1110361' || link.attributes.ИдФайлИнфГО !== sender.attributes.ИдФайл || link.attributes.ДатФайлИнфГО !== senderDoc.attributes.ДатИнфГО || link.attributes.ВрФайлИнфГО !== senderDoc.attributes.ВрИнфГО || !link.attributes.ЭП || content.attributes.СодОпер !== '1' || !content.attributes.УИД_Зак || content.attributes.УИД_Зак !== only(senderDoc, 'СодИнфГО').attributes.УИД_Зак) throw new SabyError('validation', 'Ответ НК не связан с текущим титулом исходной заявки.');
  const replace = (parent: XmlNode, value: XmlNode, order: string[]) => {
    const existing = xmlChildren(parent, value.name);
    if (existing.length) {
      if (existing.length === 1 && same(existing[0], value)) return;
      if (existing.length === 1 && mayRefresh) {
        parent.children.splice(parent.children.indexOf(existing[0]), 1, value);
        return;
      }
      throw new SabyError('validation', 'В Saby уже заполнены отличающиеся сведения ответа НК. Автоматическая перезапись остановлена; сверьте черновик.');
    }
    const position = parent.children.findIndex(child => typeof child !== 'string' && order.indexOf(child.name) > order.indexOf(value.name));
    parent.children.splice(position < 0 ? parent.children.length : position, 0, value);
  };
  const order = ['СвЛицОргПрвз', 'СвВодит', 'СвЛицПрв', 'СвТС', 'РазмПлатРасчет', 'ИнфПол'];
  if (input.responsible) replace(content, input.responsible, order);
  if (input.driver) replace(content, input.driver, order);
  if (input.vehicle) {
    const vehicles = xmlChildren(content, 'СвТС');
    if (vehicles.length > 1) throw new SabyError('validation', 'Неоднозначные сведения транспортных средств в Saby.');
    if (vehicles.length) replace(vehicles[0], input.vehicle, ['ТС', 'Прицеп', 'СпецУслДвиж', 'ИнфПол']);
    else replace(content, node('СвТС', {}, [input.vehicle]), order);
  }
  if (input.paymentCalculation !== undefined) {
    if (input.paymentCalculation !== 'По договору') throw new SabyError('validation', 'Не подтверждён порядок расчёта платы в поручении НК.');
    const payments = xmlChildren(content, 'РазмПлатРасчет');
    if (payments.length > 1) throw new SabyError('validation', 'Неоднозначные сведения расчёта платы в ответе НК.');
    if (!payments.length) replace(content, node('РазмПлатРасчет', { Расчет: input.paymentCalculation }), order);
    else {
      const payment = payments[0];
      // The user authorized this one field only. Never refresh an existing
      // different condition, even in our unchanged draft; keep cost/VAT intact.
      if (payment.attributes.Расчет?.trim() && payment.attributes.Расчет !== input.paymentCalculation) throw new SabyError('validation', 'В Saby уже указан другой расчёт платы. Автоматическая перезапись остановлена; сверьте условия.');
      payment.attributes.Расчет = input.paymentCalculation;
    }
  }
  const xml = encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(root));
  return { xml, beforeHash, afterHash: carrierXmlHash(xml), driverReady: !!input.driver, vehicleReady: !!input.vehicle, ...(input.responsible !== undefined ? { responsibleReady: !!input.responsible } : {}) };
}

import Decimal from 'decimal.js';
import { productTransportFields, vehicleTransportFields, type ProductTransportDetails, type VehicleTransportDetails } from '../web/src/directory-fields';
import { ApiError } from './api-error';
import { validInn } from './checko';

function optionalFields(input: Record<string, unknown>, fields: readonly (readonly [string, string])[]) {
  const values: Record<string, string> = {};
  for (const [key, label] of fields) {
    const raw = input[key];
    if (raw === undefined || raw === '') continue;
    if (typeof raw !== 'string' || raw.length > 500) throw new ApiError(400, `Проверьте поле «${label}».`);
    const value = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
    if (value) values[key] = value;
  }
  return values;
}

/** Partial profiles may be saved; the exchange validates completeness separately. */
export function productTransportDetails(input: Record<string, unknown>): ProductTransportDetails {
  const values = optionalFields(input, productTransportFields);
  if (values.transportProductKind && values.transportProductKind !== 'diesel') throw new ApiError(400, 'Для автоматизации транспортных документов поддерживается только дизельное топливо.');
  if (values.cargoPackaging && !['bulk', 'packaged'].includes(values.cargoPackaging)) throw new ApiError(400, 'Выберите способ перевозки: без упаковки (налив) или в упаковке.');
  if (values.dangerousGoodsUnNumber && !/^\d{4}$/.test(values.dangerousGoodsUnNumber)) throw new ApiError(400, 'Номер ООН должен содержать четыре цифры.');
  // No characteristics are inferred from a short product name or assigned by default.
  return values as ProductTransportDetails;
}

export function vehicleTransportDetails(input: Record<string, unknown>): VehicleTransportDetails {
  const values = optionalFields(input, vehicleTransportFields);
  if (values.payloadTonnes) {
    const amount = values.payloadTonnes.replace(/\s/g, '').replace(',', '.');
    if (!/^\d{1,5}(?:\.\d{1,2})?$/.test(amount) || !new Decimal(amount).gt(0)) throw new ApiError(400, 'Укажите положительную грузоподъёмность в тоннах, до двух знаков после запятой. Полная масса ТС не является грузоподъёмностью.');
    values.payloadTonnes = new Decimal(amount).toFixed();
  }
  if (values.ownershipType && !['1', '2', '3', '4', '5'].includes(values.ownershipType)) throw new ApiError(400, 'Выберите основание владения автомобилем.');
  if (values.cargoDistributable && !['0', '1'].includes(values.cargoDistributable)) throw new ApiError(400, 'Выберите возможность распределения груза по платформе.');
  if (values.leaseDocumentDate) {
    const date = /^\d{2}\.\d{2}\.\d{4}$/.test(values.leaseDocumentDate) ? values.leaseDocumentDate.split('.').reverse().join('-') : values.leaseDocumentDate;
    const parsed = new Date(`${date}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new ApiError(400, 'Укажите корректную дату договора: ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.');
    values.leaseDocumentDate = date;
  }
  if (values.leaseDocumentIssuerInn) {
    const inns = values.leaseDocumentIssuerInn.split(/[;,\s]+/).filter(Boolean);
    if (!inns.length || inns.some(inn => !validInn(inn))) throw new ApiError(400, 'Проверьте ИНН составителей договора; несколько ИНН разделите запятой.');
    values.leaseDocumentIssuerInn = [...new Set(inns)].join(', ');
  }
  return values as VehicleTransportDetails;
}

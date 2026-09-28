import { ApiError } from './api-error';
import { validInn } from './checko';

/** Optional document identifiers; their absence is not a blocker for the first order title. */
export function driverTransportDetails(input: Record<string, string>) {
  const result = { ...input };
  for (const [key, digits, label] of [['licenseSeries',4,'Серия ВУ'],['licenseNumber',6,'Номер ВУ'],['inn',12,'ИНН водителя']] as const) {
    if (!result[key]) continue;
    const value = result[key].replace(/\s/g, '');
    if (!new RegExp(`^\\d{${digits}}$`).test(value) || key === 'inn' && !validInn(value)) throw new ApiError(400, `Проверьте поле «${label}»: требуется ${digits} цифр.`);
    result[key] = value;
  }
  if (result.licenseIssuedAt) {
    const input = result.licenseIssuedAt;
    const value = /^\d{2}\.\d{2}\.\d{4}$/.test(input) ? input.split('.').reverse().join('-') : input;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0,10) !== value) throw new ApiError(400, 'Укажите корректную дату выдачи ВУ: ДД.ММ.ГГГГ или ГГГГ-ММ-ДД.');
    result.licenseIssuedAt = value;
  }
  return result;
}

import { ApiError } from './api-error';
import { validPhone } from './fleet-directory';
import type { Company, ShipmentAddress } from '../web/src/model';

export const loadingRoleKeys = ['loadingActorCompanyId', 'infrastructureOwnerCompanyId'] as const;
export const locationDetailKeys = ['address', 'mapUrl', 'latitude', 'longitude', 'receiverName', 'receiverPhone', ...loadingRoleKeys] as const;
export function locationDetails(input: Record<string, unknown>, selection?: { companies: readonly Company[]; previous?: ShipmentAddress }) {
  const result: Partial<Record<typeof locationDetailKeys[number], string>> = {};
  for (const key of locationDetailKeys) {
    const raw = input[key];
    if (raw === undefined || raw === '') continue;
    if (typeof raw !== 'string' || raw.length > 500) throw new ApiError(400, 'Проверьте адрес, ссылку на карту и координаты.');
    const value = raw.trim();
    if (value) result[key] = value;
  }
  if (result.mapUrl) {
    let url: URL;
    try { url = new URL(result.mapUrl); } catch { throw new ApiError(400, 'Укажите корректную HTTPS-ссылку на Яндекс.Карты.'); }
    if (url.protocol !== 'https:' || url.username || url.password || !['yandex.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'maps.yandex.ru', 'yandex.uz', 'ya.ru'].includes(url.hostname)) throw new ApiError(400, 'Укажите HTTPS-ссылку на Яндекс.Карты.');
  }
  for (const [key, limit] of [['latitude', 90], ['longitude', 180]] as const) {
    if (result[key] && (!/^[+-]?\d+(?:\.\d+)?$/.test(result[key]!) || Math.abs(Number(result[key])) > limit)) throw new ApiError(400, 'Проверьте координаты площадки.');
  }
  if (!!result.latitude !== !!result.longitude) throw new ApiError(400, 'Укажите обе координаты площадки.');
  if (result.receiverPhone && !validPhone(result.receiverPhone)) throw new ApiError(400, 'Проверьте телефон приёмщика площадки.');
  if (selection) for (const key of loadingRoleKeys) {
    const id = result[key]; if (!id) continue;
    const company = selection.companies.find(row => row.id === id);
    if (!company || company.directoryArchived && selection.previous?.[key] !== id) throw new ApiError(400, 'Выберите действующую компанию из справочника для погрузчика и владельца площадки.');
  }
  return result;
}

import { tripRequestExplicitCoordinates } from '../web/src/trip-request-map-coordinates';
import { ApiError } from './api-error';
import { validPhone } from './fleet-directory';
import type { Company, ShipmentAddress } from '../web/src/model';

export const loadingRoleKeys = ['loadingActorCompanyId', 'infrastructureOwnerCompanyId'] as const;
const locationStringKeys = ['address', 'mapUrl', 'latitude', 'longitude', 'receiverName', 'receiverPhone', ...loadingRoleKeys] as const;
export const locationDetailKeys = [...locationStringKeys, 'additionalReceivers'] as const;
export function locationDetails(input: Record<string, unknown>, selection?: { companies: readonly Company[]; previous?: ShipmentAddress }) {
  const result: Partial<Pick<ShipmentAddress, typeof locationDetailKeys[number]>> = {};
  for (const key of locationStringKeys) {
    const raw = input[key];
    if (raw === undefined || raw === '') continue;
    if (typeof raw !== 'string' || raw.length > 500) throw new ApiError(400, 'Проверьте адрес, ссылку на карту и координаты.');
    const value = raw.trim();
    if (value) result[key] = value;
  }
  if (input.additionalReceivers !== undefined) {
    if (!Array.isArray(input.additionalReceivers) || input.additionalReceivers.length > 49) throw new ApiError(400, 'Можно указать до 50 приёмщиков адреса.');
    result.additionalReceivers = input.additionalReceivers.map(raw => {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['name', 'phone'].includes(key)) || typeof raw.name !== 'string' || typeof raw.phone !== 'string' || raw.name.length > 500 || raw.phone.length > 500) throw new ApiError(400, 'Проверьте имя и телефон приёмщика.');
      const name = raw.name.trim(), phone = raw.phone.trim();
      if (phone && !validPhone(phone)) throw new ApiError(400, 'Проверьте телефон приёмщика площадки.');
      return { name, phone };
    }).filter(row => row.name || row.phone);
    if (!result.additionalReceivers.length) delete result.additionalReceivers;
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
  const effectiveAddress = (result.address || (typeof input.name === 'string' ? input.name : '')).trim().replace(/\s+/g, ' ');
  if (input.pointAddress !== undefined && (typeof input.pointAddress !== 'string' || input.pointAddress.length > 500 || input.pointAddress.trim().replace(/\s+/g, ' ') !== effectiveAddress)) throw new ApiError(400, 'Точка должна соответствовать текущему адресу площадки.');
  const previous = selection?.previous;
  if (previous && effectiveAddress !== (previous.address || previous.name).trim().replace(/\s+/g, ' ')) {
    const oldPoint = tripRequestExplicitCoordinates(previous), newPoint = tripRequestExplicitCoordinates(result);
    const samePoint = oldPoint?.status === 'found' && newPoint?.status === 'found' && oldPoint.latitude === newPoint.latitude && oldPoint.longitude === newPoint.longitude;
    if (input.pointAddress === undefined && (samePoint || !newPoint)) {
      delete result.latitude; delete result.longitude; delete result.mapUrl;
    }
  }
  if (result.receiverPhone && !validPhone(result.receiverPhone)) throw new ApiError(400, 'Проверьте телефон приёмщика площадки.');
  if (selection) for (const key of loadingRoleKeys) {
    const id = result[key]; if (!id) continue;
    const company = selection.companies.find(row => row.id === id);
    if (!company || company.directoryArchived && selection.previous?.[key] !== id) throw new ApiError(400, 'Выберите действующую компанию из справочника для погрузчика и владельца площадки.');
  }
  return result;
}

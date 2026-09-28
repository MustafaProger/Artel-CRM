import { ApiError } from './api-error';

export const locationDetailKeys = ['address', 'mapUrl', 'latitude', 'longitude'] as const;
export function locationDetails(input: Record<string, unknown>) {
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
  return result;
}

export type TripRequestLocationResult =
  | { status: 'found'; latitude: number; longitude: number; source: 'directory' | 'map_url' | 'geocoder'; label?: string; accuracy?: 'building' | 'street' }
  | { status: 'not_found' | 'ambiguous' | 'unavailable'; message: string }
  | { status: 'pending'; message: string; fingerprint?: string };

export interface TripRequestAddress {
  locationSnapshot?: Extract<TripRequestLocationResult, { status: 'found' }>;
  address?: string | null; latitude?: string | number | null; longitude?: string | number | null; mapUrl?: string | null;
}

function coordinate(value: unknown, limit: number): number | null {
  if (typeof value !== 'string' && typeof value !== 'number' || typeof value === 'string' && !/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && Math.abs(parsed) <= limit ? parsed : null;
}

/** Only a marked point is a location; Yandex's `ll` is merely the current viewport. */
export function tripRequestExplicitCoordinates(input: TripRequestAddress): TripRequestLocationResult | null {
  const latitude = coordinate(input.latitude, 90), longitude = coordinate(input.longitude, 180);
  if (latitude !== null && longitude !== null) {
    const saved = input.locationSnapshot;
    if (saved?.status === 'found' && saved.latitude === latitude && saved.longitude === longitude) return saved;
    return { status: 'found', latitude, longitude, source: 'directory' };
  }
  if (!input.mapUrl) return null;
  try {
    const url = new URL(input.mapUrl);
    if (url.protocol !== 'https:' || url.username || url.password || !['yandex.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'maps.yandex.ru', 'yandex.uz', 'ya.ru'].includes(url.hostname)) return null;
    const pin = url.searchParams.get('pt');
    if (!pin || pin.includes('~')) return null;
    const parts = pin.split(',');
    const lon = coordinate(parts[0], 180), lat = coordinate(parts[1], 90);
    if (lat !== null && lon !== null) return { status: 'found', latitude: lat, longitude: lon, source: 'map_url' };
  } catch { /* An invalid link is not a location. */ }
  return null;
}

/** A request owns its address snapshot. Later directory corrections must never move it. */
export function tripRequestMapCoordinates(
  request: TripRequestAddress & { addressId: string; companyId: string; location?: TripRequestLocationResult },
  addresses: readonly (TripRequestAddress & { id: string; companyId: string; kind: string; name: string })[] = [],
): TripRequestLocationResult | null {
  const saved = tripRequestExplicitCoordinates(request);
  if (saved) return saved;
  if ([request.latitude, request.longitude].some(value => value !== null && value !== undefined && String(value).trim() !== '')) return null;
  void addresses; // Kept for call-site compatibility; directory pins are copied at creation only.
  return request.location?.status === 'found' ? request.location : null;
}

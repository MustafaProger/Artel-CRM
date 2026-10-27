/** Tiles readiness metadata only. The server key is never returned to the browser.
 * Existing Nominatim address lookup remains a separate subsystem.
 */
export function readTripRequestsMapConfig(environment: Record<string, string | undefined> = process.env):
  { provider: 'yandex'; configured: boolean; rendering: 'tiles'; projection: 'web_mercator' } {
  return { provider: 'yandex', configured: !!environment.YANDEX_TILES_API_KEY?.trim(), rendering: 'tiles', projection: 'web_mercator' };
}
function invalidSavedPair(value: TripRequestAddress) {
  return [value.latitude, value.longitude].some(item => item !== null && item !== undefined && String(item).trim() !== '') && tripRequestExplicitCoordinates({ latitude: value.latitude, longitude: value.longitude })?.status !== 'found';
}

/** Resolve only authoritative addresses, never arbitrary user text or remote URLs. */
export function tripRequestGeocodeTarget(data: OperationsData, snapshot: Snapshot, actor: AccountUser | null, body: Record<string, unknown>): { address: string; version: number; fingerprint: string; location: TripRequestLocationResult | null } {
  const keys = Object.keys(body).sort().join(',');
  if (!['requestId', 'addressId,companyId', 'oilDepotId'].includes(keys) || Object.values(body).some(value => typeof value !== 'string' || !value || value.length > 200)) throw new ApiError(400, 'Выберите заявку, площадку или нефтебазу для поиска адреса.');
  let source: TripRequestAddress, identity: unknown, version: number;
  const addresses = snapshot.directories?.addresses ?? [];
  let location: TripRequestLocationResult | null;
  if (keys === 'requestId') {
    const request = requireTripRequest(data, snapshot, actor, body.requestId as string);
    source = request;
    version = request.version;
    identity = [request.id, request.version, request.status, request.address, request.latitude, request.longitude, request.mapUrl];
    if (invalidSavedPair(request)) location = { status: 'unavailable', message: 'Сохранённые координаты неполные. Уточните точку на карте.' };
    else location = tripRequestMapCoordinates(request);
  } else if (keys === 'oilDepotId') {
    const depot = snapshot.directories?.oilDepots?.find(row => row.id === body.oilDepotId);
    if (!depot || actor && !hasSection(actor, 'trips')) throw new ApiError(404, 'Нефтебаза недоступна.');
    source = depot;
    version = depot.version ?? 0;
    identity = ['oil-depot', depot.id, version, depot.address, depot.latitude, depot.longitude, depot.mapUrl];
    location = invalidSavedPair(source) ? { status: 'unavailable', message: 'Сохранённые координаты неполные. Уточните точку нефтебазы.' } : tripRequestExplicitCoordinates(source);
    if (!location && !depot.address?.trim()) location = { status: 'not_found', message: 'Адрес нефтебазы не указан.' };
  } else {
    const company = snapshot.companies.find(row => row.id === body.companyId && row.roles.includes('customer') && !row.directoryArchived);
    if (!company || !canAccessTripRequest(actor, snapshot, { companyId: company.id })) throw new ApiError(404, 'Компания недоступна.');
    const address = addresses.find(row => row.id === body.addressId && row.companyId === company.id && row.kind === 'delivery');
    if (!address) throw new ApiError(404, 'Площадка не найдена.');
    source = { ...address, address: address.address || address.name };
    version = address.version ?? 0;
    identity = [company.id, address.id, address.version, source.address, address.latitude, address.longitude, address.mapUrl];
    location = invalidSavedPair(source) ? { status: 'unavailable', message: 'Сохранённые координаты неполные. Уточните точку на карте.' } : tripRequestExplicitCoordinates(source);
  }
  return { address: source.address ?? '', version, fingerprint: JSON.stringify(identity), location };
}

import { hasSection, type AccountUser } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import { tripRequestExplicitCoordinates, tripRequestMapCoordinates, type TripRequestAddress, type TripRequestLocationResult } from '../web/src/trip-request-map-coordinates';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { canAccessTripRequest, requireTripRequest } from './trip-requests';

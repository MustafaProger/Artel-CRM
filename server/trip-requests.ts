import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { hasSection, type AccountUser } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import type { TripRequest } from '../web/src/trip-request-model';
import type { OperationsData } from './operations-store';
import { tripRequestExplicitCoordinates, type TripRequestLocationResult } from '../web/src/trip-request-map-coordinates';
import { compareRequestDates, validRequestDate } from '../web/src/trip-request-schedule';
import { ApiError } from './api-error';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[a-f0-9-]{36}$/;

export function validateTripRequests(value: unknown, creates: unknown) {
  if (value !== undefined) {
    if (!object(value)) throw new Error('Invalid trip requests');
    for (const [id, row] of Object.entries(value)) {
      if (!object(row) || row.id !== id || !id.startsWith('trip-request-') || !Number.isSafeInteger(row.version) || Number(row.version) < 1) throw new Error('Invalid trip request');
      for (const key of ['companyId', 'addressId', 'companyName', 'addressName', 'address', 'createdAt', 'updatedAt']) if (typeof row[key] !== 'string' || !row[key]) throw new Error('Invalid trip request field');
      if (typeof row.comment !== 'string' || row.comment.length > 4000 || typeof row.quantityLitres !== 'string' || !/^\d+(?:\.\d{1,6})?$/.test(row.quantityLitres) || !new Decimal(row.quantityLitres).gt(0)) throw new Error('Invalid trip request quantity');
      if (row.executionDate !== undefined && row.executionDate !== null && !validRequestDate(row.executionDate)) throw new Error('Invalid trip request execution date');
      if (row.salePricePerLitre !== undefined && row.salePricePerLitre !== null && (typeof row.salePricePerLitre !== 'string' || row.salePricePerLitre.length > 40 || !/^\d+(?:\.\d{1,6})?$/.test(row.salePricePerLitre) || !new Decimal(row.salePricePerLitre).gt(0))) throw new Error('Invalid trip request price');
      for (const key of ['ownerUserId', 'managerId', 'mapUrl', 'latitude', 'longitude', 'tripId', 'shipmentId']) if (row[key] !== null && typeof row[key] !== 'string') throw new Error('Invalid trip request reference');
      if (row.locationSnapshot !== undefined) {
        const point = row.locationSnapshot;
        if (!object(point) || point.status !== 'found' || point.source !== 'geocoder' || !['building', 'street'].includes(String(point.accuracy)) || typeof point.latitude !== 'number' || typeof point.longitude !== 'number' || !Number.isFinite(point.latitude) || !Number.isFinite(point.longitude) || Math.abs(point.latitude) > 90 || Math.abs(point.longitude) > 180 || row.latitude === null || row.longitude === null || Number(row.latitude) !== point.latitude || Number(row.longitude) !== point.longitude || point.label !== undefined && (typeof point.label !== 'string' || point.label.length > 500)) throw new Error('Invalid trip request location snapshot');
      }
      if (!['active', 'consumed', 'cancelled'].includes(String(row.status)) || (row.status === 'consumed' ? !row.tripId || !row.shipmentId : row.tripId !== null || row.shipmentId !== null)) throw new Error('Invalid trip request status');
    }
  }
  if (creates !== undefined) {
    if (!object(creates)) throw new Error('Invalid trip request creation registry');
    for (const [key, record] of Object.entries(creates)) if (!uuid.test(key) || !object(record) || typeof record.requestId !== 'string' || !object(value) || !value[record.requestId] || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint) || record.actorId !== null && typeof record.actorId !== 'string') throw new Error('Invalid trip request creation record');
  }
}

/** The user explicitly chose one common queue for everyone with the trips section. */
export function canAccessTripRequest(actor: AccountUser | null, _snapshot: Snapshot, _request: Pick<TripRequest, 'companyId'>) {
  return !actor || hasSection(actor, 'trips');
}

/** Operational company/location lookup; no accounting or bank properties are exposed. */
export function tripRequestCatalog(snapshot: Snapshot) {
  const companies = snapshot.companies.filter(row => row.roles.includes('customer') && !row.directoryArchived).map(row => ({ id: row.id, name: row.name, roles: ['customer'], shipmentIds: [], paymentIds: [], managerLabels: [], flags: [] }));
  const ids = new Set(companies.map(row => row.id));
  const addresses = (snapshot.directories?.addresses ?? []).filter(row => row.kind === 'delivery' && ids.has(row.companyId)).map(({ id, version, companyId, kind, name, address, mapUrl, latitude, longitude }) => ({ id, version: version ?? 0, companyId, kind, name, address: address || name, mapUrl, latitude, longitude }));
  return { companies, addresses };
}

export function requireTripRequest(data: OperationsData, snapshot: Snapshot, actor: AccountUser | null, id: string, active = true): TripRequest {
  const request = data.tripRequests?.[id];
  if (!request || !canAccessTripRequest(actor, snapshot, request)) throw new ApiError(404, 'Заявка не найдена.');
  if (active && request.status !== 'active') throw new ApiError(409, 'Заявка уже использована или удалена. Обновите список заявок.');
  return request;
}

export function listTripRequests(data: OperationsData, snapshot: Snapshot, actor: AccountUser | null) {
  return Object.values(data.tripRequests ?? {}).filter(row => row.status === 'active' && canAccessTripRequest(actor, snapshot, row)).sort(compareRequestDates);
}

function quantity(value: unknown) {
  if (typeof value !== 'string' || value.length > 40) throw new ApiError(400, 'Укажите положительное количество литров.');
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized) || !new Decimal(normalized).gt(0)) throw new ApiError(400, 'Укажите положительное количество литров, до 6 знаков после запятой.');
  return new Decimal(normalized).toFixed();
}
function pricePerLitre(value: unknown): string | null {
  if (value === undefined || value === null || typeof value === 'string' && !value.trim()) return null;
  if (typeof value !== 'string' || value.length > 40) throw new ApiError(400, 'Укажите цену за литр больше нуля.');
  const normalized = value.trim().replace(/\s/g, '').replace(',', '.');
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized) || !new Decimal(normalized).gt(0)) throw new ApiError(400, 'Укажите цену за литр больше нуля, до 6 знаков после запятой.');
  return new Decimal(normalized).toFixed();
}
function comment(value: unknown) {
  if (value === undefined) return '';
  if (typeof value !== 'string' || value.length > 4000) throw new ApiError(400, 'Комментарий должен содержать не более 4000 символов.');
  return value.trim();
}

function deliveryPoint(body: Record<string, unknown>) {
  if (!Object.hasOwn(body, 'latitude') && !Object.hasOwn(body, 'longitude')) return null;
  const parse = (key: 'latitude' | 'longitude', limit: number) => {
    const value = body[key];
    if (typeof value !== 'string' || value.length > 64 || !/^[+-]?\d+(?:\.\d+)?$/.test(value.trim())) throw new ApiError(400, 'Укажите обе координаты точки доставки.');
    const number = new Decimal(value.trim());
    if (!number.isFinite() || number.abs().gt(limit)) throw new ApiError(400, 'Проверьте координаты точки доставки.');
    return number.toFixed();
  };
  const latitude = parse('latitude', 90), longitude = parse('longitude', 180);
  const url = new URL('https://yandex.ru/maps/');
  url.searchParams.set('pt', `${longitude},${latitude}`);
  url.searchParams.set('z', '16');
  return { latitude, longitude, mapUrl: url.href };
}

/** Run inside the same operations mutation as authorization. */
export function saveTripRequest(data: OperationsData, snapshot: Snapshot, actor: AccountUser | null, body: Record<string, unknown>, id?: string, knownLocation?: TripRequestLocationResult) {
  const allowed = id ? ['version', 'quantityLitres', 'salePricePerLitre', 'executionDate', 'comment', 'address', 'latitude', 'longitude'] : ['companyId', 'addressId', 'address', 'quantityLitres', 'salePricePerLitre', 'executionDate', 'comment', 'idempotencyKey', 'latitude', 'longitude'];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, 'В заявке есть неизвестные параметры.');
  if (body.executionDate !== undefined && body.executionDate !== null && !validRequestDate(body.executionDate)) throw new ApiError(400, 'Укажите корректную дату выполнения заявки.');
  const executionDate = body.executionDate as string | null | undefined;
  const litres = quantity(body.quantityLitres);
  const price = pricePerLitre(body.salePricePerLitre);
  const previous = id ? requireTripRequest(data, snapshot, actor, id) : undefined;
  if (previous && body.version !== previous.version) throw new ApiError(409, 'Заявка уже изменена. Обновите её и повторите действие.');
  const note = body.comment === undefined && previous ? previous.comment : comment(body.comment);
  const point = deliveryPoint(body);
  if (body.address !== undefined && (typeof body.address !== 'string' || !body.address.trim() || body.address.length > 2000)) throw new ApiError(400, 'Укажите адрес доставки, до 2000 символов.');
  const address = typeof body.address === 'string' ? body.address.trim().replace(/\s+/g, ' ') : previous?.address;
  const changedAddress = previous && address !== previous.address;
  if (previous) {
    const request = { ...previous, ...(executionDate !== undefined ? { executionDate } : {}), ...(Object.hasOwn(body, 'salePricePerLitre') ? { salePricePerLitre: price } : {}), ...(changedAddress ? { address: address!, latitude: null, longitude: null, mapUrl: null, locationSnapshot: undefined } : {}), ...(point ? { ...point, locationSnapshot: undefined } : {}), quantityLitres: litres, comment: note, version: previous.version + 1, updatedAt: new Date().toISOString() };
    data.tripRequests![request.id] = request;
    return { request, created: false, changed: true };
  }
  if (typeof body.companyId !== 'string' || typeof body.addressId !== 'string') throw new ApiError(400, 'Выберите компанию и её место выгрузки.');
  const key = body.idempotencyKey;
  if (key !== undefined && (typeof key !== 'string' || !uuid.test(key))) throw new ApiError(400, 'Некорректный ключ сохранения заявки.');
  // Preserve legacy replay keys when optional price/address/point are absent.
  const fingerprint = createHash('sha256').update(JSON.stringify([body.companyId, body.addressId, litres, note, ...(point ? [point.latitude, point.longitude] : []), ...(address === undefined ? [] : ['address', address]), ...(price === null ? [] : ['salePricePerLitre', price]), ...(executionDate == null ? [] : ['executionDate', executionDate])])).digest('hex');
  const replay = typeof key === 'string' ? data.tripRequestCreates?.[key] : undefined;
  if (replay) {
    if (replay.actorId !== (actor?.id ?? null) || replay.fingerprint !== fingerprint) throw new ApiError(409, 'Этот ключ уже использован для другой заявки.');
    return { request: requireTripRequest(data, snapshot, actor, replay.requestId, false), created: false, changed: false };
  }
  const company = snapshot.companies.find(row => row.id === body.companyId && row.roles.includes('customer') && !row.directoryArchived);
  if (!company || !canAccessTripRequest(actor, snapshot, { companyId: company.id })) throw new ApiError(404, 'Компания недоступна.');
  const place = snapshot.directories?.addresses.find(row => row.id === body.addressId && row.companyId === company.id && row.kind === 'delivery');
  if (!place) throw new ApiError(400, 'Выберите место выгрузки этой компании из справочника.');
  const samePlaceAddress = address === undefined || address === (place.address || place.name);
  const directoryPoint = samePlaceAddress ? { mapUrl: place.mapUrl || null, latitude: place.latitude || null, longitude: place.longitude || null } : { mapUrl: null, latitude: null, longitude: null };
  const automaticPoint = !point && !tripRequestExplicitCoordinates(directoryPoint) && !directoryPoint.latitude && !directoryPoint.longitude && knownLocation?.status === 'found' ? { latitude: String(knownLocation.latitude), longitude: String(knownLocation.longitude), locationSnapshot: structuredClone(knownLocation) } : {};
  const now = new Date().toISOString();
  const request: TripRequest = { id: `trip-request-${randomUUID()}`, version: 1, companyId: company.id, addressId: place.id, quantityLitres: litres, ...(executionDate == null ? {} : { executionDate }), ...(price === null ? {} : { salePricePerLitre: price }), comment: note, ownerUserId: actor?.id ?? null, managerId: actor?.managerId ?? snapshot.directories?.customerManagers?.find(row => row.companyId === company.id)?.managerId ?? null, companyName: company.name, addressName: place.name, address: address ?? (place.address || place.name), ...directoryPoint, ...automaticPoint, ...point, status: 'active', createdAt: now, updatedAt: now, tripId: null, shipmentId: null };
  (data.tripRequests ??= {})[request.id] = request;
  if (typeof key === 'string') (data.tripRequestCreates ??= {})[key] = { requestId: request.id, actorId: actor?.id ?? null, fingerprint };
  return { request, created: true, changed: true };
}

export function cancelTripRequest(data: OperationsData, snapshot: Snapshot, actor: AccountUser | null, id: string, body: Record<string, unknown>) {
  if (Object.keys(body).some(key => key !== 'version')) throw new ApiError(400, 'В удалении заявки есть неизвестные параметры.');
  const request = requireTripRequest(data, snapshot, actor, id);
  if (body.version !== request.version) throw new ApiError(409, 'Заявка уже изменена. Обновите список.');
  Object.assign(request, { status: 'cancelled', version: request.version + 1, updatedAt: new Date().toISOString() });
  return { deleted: true as const, id };
}

import type { ShipmentTrip } from '../web/src/model';
import { ApiError } from './api-error';
import type { OperationsData } from './operations-store';

/** Assigned by the server only when a driver trip is first created. */
export const TRIP_DOCUMENT_POLICY_VERSION = 'nk-direct-autostart-v1';
export const NK_DIRECT_ETRN_MESSAGE = 'НК АРТЭЛЬ оформляет ЭТрН напрямую как отправитель и перевозчик. Для новых рейсов подписание и отправка запускаются автоматически после сохранённого убытия водителя.';
/** Historical name retained for callers protecting the legacy order endpoints. */
export const NK_SUPPLY_DELIVERY_MESSAGE = NK_DIRECT_ETRN_MESSAGE;
export const validTripDocumentPolicy = (value: unknown) => value === TRIP_DOCUMENT_POLICY_VERSION || value === 'nk-direct-etrn-v1' || value === 'supply-delivery-v1';

/** An attempted external exchange always retains its original document workflow. */
export function hasTripTransportHistory(data: OperationsData, tripId: string): boolean {
  return !!data.tripSaby?.trips[tripId] || !!data.saby?.trips[tripId] || !!data.etrn?.trips[tripId]?.direct || !!data.etrn?.trips[tripId]?.exchangeHistory?.length
    || Object.values(data.etrn?.trips[tripId]?.deliveries ?? {}).some(row => !!row.document);
}

export function isNkDirectEtrn(trip: Pick<ShipmentTrip, 'id' | 'fields'>, data: OperationsData): boolean {
  // Once explicitly authorized, this route remains direct when its documents
  // acquire external IDs. Existing standard/legacy attempts are never migrated.
  if (data.tripSaby?.trips[trip.id] || data.saby?.trips[trip.id]) return false;
  if (data.etrn?.trips[trip.id]?.direct) return true;
  if (data.etrn?.trips[trip.id]?.rebuild) return trip.fields.organization_id === 'nk-artel' && trip.fields.trip_flow_version === 'driver-v1';
  return validTripDocumentPolicy(trip.fields.trip_document_policy)
    && trip.fields.trip_flow_version === 'driver-v1'
    && trip.fields.organization_id === 'nk-artel'
    && !hasTripTransportHistory(data, trip.id);
}
export const isNkSupplyDelivery = isNkDirectEtrn;

/** Call after CRM access checks and before creating intent or contacting a provider. */
export function assertTripTransportDocumentsAllowed(trip: Pick<ShipmentTrip, 'id' | 'fields'>, data: OperationsData): void {
  if (data.etrn?.trips[trip.id]?.rebuild || data.etrn?.trips[trip.id]?.exchangeHistory?.length) throw new ApiError(409, 'Прежний обмен сохранён в истории; изменение схемы документов требует сверки.');
  if (isNkDirectEtrn(trip, data)) throw new ApiError(409, NK_DIRECT_ETRN_MESSAGE);
}

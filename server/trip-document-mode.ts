import type { ShipmentTrip } from '../web/src/model';
import { ApiError } from './api-error';
import type { OperationsData } from './operations-store';

/** Assigned by the server only when a driver trip is first created. */
export const TRIP_DOCUMENT_POLICY_VERSION = 'supply-delivery-v1';
export const NK_SUPPLY_DELIVERY_MESSAGE = 'НК АРТЭЛЬ доставляет собственное топливо по договору поставки. Заявка на перевозку и ЭТрН не создаются; данные и массы сохраняются в CRM.';

/** An attempted external exchange always retains its original document workflow. */
export function hasTripTransportHistory(data: OperationsData, tripId: string): boolean {
  return !!data.tripSaby?.trips[tripId] || !!data.saby?.trips[tripId]
    || Object.values(data.etrn?.trips[tripId]?.deliveries ?? {}).some(row => !!row.document);
}

export function isNkSupplyDelivery(trip: Pick<ShipmentTrip, 'id' | 'fields'>, data: OperationsData): boolean {
  return trip.fields.trip_document_policy === TRIP_DOCUMENT_POLICY_VERSION
    && trip.fields.trip_flow_version === 'driver-v1'
    && trip.fields.organization_id === 'nk-artel'
    && !hasTripTransportHistory(data, trip.id);
}

/** Call after CRM access checks and before creating intent or contacting a provider. */
export function assertTripTransportDocumentsAllowed(trip: Pick<ShipmentTrip, 'id' | 'fields'>, data: OperationsData): void {
  if (isNkSupplyDelivery(trip, data)) throw new ApiError(409, NK_SUPPLY_DELIVERY_MESSAGE);
}

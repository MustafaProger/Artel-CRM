import type { TripRequestLocationResult } from './trip-request-map-coordinates';

/** A customer need retained after it has been assigned to a trip. */
export interface TripRequest {
  id: string;
  version: number;
  companyId: string;
  addressId: string;
  quantityLitres: string;
  /** Optional client price; copied into a trip without updating the source request. */
  salePricePerLitre?: string | null;
  /** Planned delivery day in Europe/Moscow; older requests can be undated. */
  executionDate?: string | null;
  comment: string;
  ownerUserId: string | null;
  managerId: string | null;
  companyName: string;
  addressName: string;
  address: string;
  mapUrl: string | null;
  latitude: string | null;
  longitude: string | null;
  /** Immutable automatic result copied only during an authorized creation. */
  locationSnapshot?: Extract<TripRequestLocationResult, { status: 'found' }>;
  /** Read projection; automatic lookup never rewrites the saved business record. */
  location?: TripRequestLocationResult;
  status: 'active' | 'consumed' | 'cancelled';
  createdAt: string;
  updatedAt: string;
  tripId: string | null;
  shipmentId: string | null;
}

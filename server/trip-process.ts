import type { AccountUser } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import type { SharedTripTimeline } from '../web/src/trip-process-model';
import { readIntermediateStops } from '../web/src/trip-route';
import type { OperationsData } from './operations-store';
import { getShipmentTrip } from './shipment-trips';
import { readTripExecution } from './trip-execution';

export function readSharedTripTimelines(
  snapshot: Snapshot,
  data: OperationsData,
  actor: AccountUser,
  numbers: Record<string, number>,
  fullyVisibleIds: ReadonlySet<string>,
): SharedTripTimeline[] {
  const requestDeliveries = new Map<string, Set<string>>();
  for (const row of snapshot.shipments) {
    const tripId = row.fields.trip_id;
    const requestId = row.fields.source_request_id;
    if (!tripId || !requestId || fullyVisibleIds.has(tripId)) continue;
    const request = data.tripRequests?.[requestId];
    // A deleted delivery can leave a consumed request in history. Match the
    // current delivery and both ends of its request link before sharing a trip.
    if (request?.ownerUserId !== actor.id || request.status !== 'consumed'
      || request.tripId !== tripId || request.shipmentId !== row.id) continue;
    const own = requestDeliveries.get(tripId) ?? new Set<string>();
    own.add(row.id);
    requestDeliveries.set(tripId, own);
  }

  const names = new Map(snapshot.companies.map(company => [company.id, company.name]));
  return Array.from(requestDeliveries, ([id, ownDeliveries]): SharedTripTimeline => {
    const trip = getShipmentTrip(snapshot, id, numbers);
    const execution = readTripExecution(snapshot, data, id);
    const { fields } = trip;
    const stops = trip.customers.flatMap<SharedTripTimeline['stops'][number]>(delivery => {
      const { fields } = delivery;
      const event = execution.deliveries[delivery.id];
      return [{
        kind: 'delivery',
        name: names.get(fields.customer_id ?? '') || 'Клиент не указан',
        address: fields.unloading_address,
        fromOwnRequest: ownDeliveries.has(delivery.id),
        plannedAt: fields.unloading_planned_at,
        actualAt: fields.unloading_actual_at,
        event: event ? { at: event.at, ...(event.kind && { kind: event.kind }) } : null,
      }, ...readIntermediateStops(fields.intermediate_stops_after).map(({ name, address }) => ({ kind: 'intermediate' as const, name, address }))];
    });
    return {
      id,
      number: trip.number,
      createdAt: trip.createdAt ?? null,
      date: fields.date,
      vehicleId: fields.vehicle_id,
      driverId: fields.driver_id,
      stage: execution.stage,
      loading: {
        address: fields.loading_address,
        plannedAt: fields.loading_planned_at,
        actualAt: fields.loading_actual_at,
        arrivedAt: execution.arrivedAt,
        departedAt: execution.departedAt,
      },
      stops,
      completedAt: execution.completed?.at ?? null,
    };
  });
}

import type { AccountUser } from '../web/src/auth-model';
import type { Shipment, Snapshot } from '../web/src/model';
import { ApiError } from './api-error';

/** Keep this projection explicit. Shipment.fields contains financial and legal metadata. */
function projectTrip(snapshot: Snapshot, id: string, rows: Shipment[], actor: AccountUser) {
  const first = rows[0], fields = first.fields;
  const driver = snapshot.directories?.drivers.find(row => row.id === actor.driverId);
  return {
    id, date: first.date, driverName: driver?.fullName || driver?.name || actor.name,
    vehiclePlate: fields.vehicle_plate ?? null, supplier: first.supplier,
    loadingAddress: fields.loading_address ?? null, loadingMapUrl: fields.loading_map_url ?? null,
    loadingPlannedAt: fields.loading_planned_at ?? null, loadingActualAt: fields.loading_actual_at ?? null, notes: fields.trip_notes ?? null,
    deliveries: rows.sort((a, b) => Number(a.fields.trip_delivery_order ?? 0) - Number(b.fields.trip_delivery_order ?? 0)).map(row => ({
      id: row.id, number: row.fields.shipment_number ?? null, customer: row.customer, product: row.product, liters: row.liters,
      address: row.fields.unloading_address ?? null, mapUrl: row.fields.unloading_map_url ?? null,
      plannedAt: row.fields.unloading_planned_at ?? null, actualAt: row.fields.unloading_actual_at ?? null, notes: row.fields.delivery_notes ?? null,
    })),
  };
}
export function readDriverTrips(snapshot: Snapshot, actor: AccountUser, id?: string, query = '') {
  if (actor.role !== 'driver' || !actor.driverId || !snapshot.directories?.drivers.some(row => row.id === actor.driverId)) throw new ApiError(403, 'Доступен только кабинет назначенного водителя.');
  const grouped = new Map<string, Shipment[]>();
  for (const row of snapshot.shipments) if (row.fields.trip_id) {
    const rows = grouped.get(row.fields.trip_id) ?? []; rows.push(row); grouped.set(row.fields.trip_id, rows);
  }
  // A corrupt/mixed assignment must never disclose another driver's delivery.
  const owned = [...grouped].filter(([, rows]) => rows.every(row => row.fields.driver_id === actor.driverId));
  if (id) {
    const rows = owned.find(([tripId]) => tripId === id)?.[1];
    if (!rows) throw new ApiError(404, 'Рейс не найден.');
    return { trip: projectTrip(snapshot, id, rows, actor) };
  }
  const needle = query.trim().toLocaleLowerCase('ru-RU').slice(0, 200);
  const trips = owned.map(([tripId, rows]) => projectTrip(snapshot, tripId, rows, actor))
    .filter(trip => !needle || JSON.stringify(trip).toLocaleLowerCase('ru-RU').includes(needle))
    .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? '') || a.id.localeCompare(b.id));
  return { trips, total: trips.length };
}

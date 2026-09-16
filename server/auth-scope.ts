import Decimal from 'decimal.js';
import { hasSection, type AccountUser } from '../web/src/auth-model';
import type { Company, Shipment, Snapshot } from '../web/src/model';
import { canManage } from './auth';
import { ApiError } from './api-error';
import { shipmentOwnership } from './shipment-ownership';
const Exact = Decimal.clone({ precision: 80 });

export function ownsShipment(actor: AccountUser, row: Shipment, snapshot: Snapshot) {
  return canManage(actor) || !!actor.managerId && snapshot.directories?.managers.some(employee => employee.id === actor.managerId) && shipmentOwnership(snapshot, row).employeeId === actor.managerId;
}
export function requireOwnedShipment(actor: AccountUser, row: Shipment, snapshot: Snapshot) {
  if (!ownsShipment(actor, row, snapshot)) throw new ApiError(404, 'Отгрузка не найдена.');
}
export function requireWholeTrip(actor: AccountUser, snapshot: Snapshot, id: string) {
  const rows = snapshot.shipments.filter(row => row.fields.trip_id === id);
  if (!rows.length || !rows.some(row => ownsShipment(actor, row, snapshot))) throw new ApiError(404, 'Отгрузка машины не найдена.');
  if (rows.some(row => !ownsShipment(actor, row, snapshot))) throw new ApiError(403, 'Общий рейс доступен для изменения только администратору. Ваши строки доступны в списке отгрузок.');
}
const companyLookup = (company: Company): Company => ({ id: company.id, name: company.name, roles: company.roles, directoryArchived: company.directoryArchived, shipmentIds: [], paymentIds: [], managerLabels: [], flags: [] });
export function scopeSnapshot(snapshot: Snapshot, actor: AccountUser, context?: 'work'): Snapshot {
  if (canManage(actor) && !context) return snapshot;
  const shipmentAccess = !context && hasSection(actor, 'shipments');
  const directoryAccess = !context && hasSection(actor, 'directories');
  const shipments = shipmentAccess ? snapshot.shipments.filter(row => ownsShipment(actor, row, snapshot)).map(row => {
    const mixed = row.fields.trip_id && snapshot.shipments.some(other => other.fields.trip_id === row.fields.trip_id && !ownsShipment(actor, other, snapshot));
    return mixed ? { ...row, tripReadOnly: true, fields: { ...row.fields, trip_total_tonnes: null, trip_additional_costs: null } } : row;
  }) : [];
  const ids = new Set(shipments.map(row => row.id));
  // Shared company lookup is operational input, never a back door to directory details or records.
  const companies = (directoryAccess || shipmentAccess || hasSection(actor, 'work') ? snapshot.companies : []).map(company => ({
    ...(directoryAccess ? company : companyLookup(company)),
    shipmentIds: company.shipmentIds.filter(id => ids.has(id)), paymentIds: [], managerLabels: [], flags: [],
  }));
  const metric = (values: (string | null)[]) => { const valid = values.filter((v): v is string => v !== null && /^[+-]?\d+(?:\.\d+)?$/.test(v)); return { total: valid.length ? valid.reduce((sum, v) => sum.plus(v), new Exact(0)).toFixed() : null, numericCount: valid.length, missingCount: values.length - valid.length }; };
  const totals = (rows: Shipment[]) => ({ shipmentCount: rows.length, paymentCount: 0, liters: metric(rows.map(r => r.liters)), revenue: metric(rows.map(r => r.revenue)), cost: metric(rows.map(r => r.cost)), incoming: metric([]), outgoing: metric([]) });
  const dates = shipments.flatMap(s => s.date ? [s.date] : []).sort();
  const catalog = snapshot.directories;
  const directories = catalog && (directoryAccess || shipmentAccess) ? {
    ...catalog,
    ...(directoryAccess ? {} : {
      vehicles: catalog.vehicles.map(({ id, plate, name, capacityLitres, compartmentsLitres }) => ({ id, plate, name, capacityLitres, compartmentsLitres })),
      drivers: catalog.drivers.map(({ id, name, vehicleId }) => ({ id, name, vehicleId })),
      deletedEntries: undefined,
    }),
    managers: canManage(actor) ? catalog.managers : catalog.managers.filter(employee => employee.id === actor.managerId),
    customerManagers: canManage(actor) ? catalog.customerManagers : catalog.customerManagers?.filter(link => link.managerId === actor.managerId),
    assignedCustomerIds: [...new Set([...(catalog.customerManagers?.filter(link => link.managerId === actor.managerId).map(link => link.companyId) ?? []), ...shipments.flatMap(row => row.customerId ? [row.customerId] : [])])],
    currentEmployeeId: actor.managerId && catalog.managers.some(employee => employee.id === actor.managerId) ? actor.managerId : null,
    duplicates: [],
  } : undefined;
  return { ...snapshot, directories, shipments, payments: [], stocks: [], companies, managers: [],
    overview: { ...totals(shipments), companyCount: companies.length, missingShipmentDates: shipments.filter(s => !s.date).length, missingPaymentDates: 0 },
    monthly: [...new Set(dates.map(d => d.slice(0, 7)))].map(month => ({ month, ...totals(shipments.filter(s => s.date?.startsWith(month))) })),
    provenance: { ...snapshot.provenance, counts: { shipment_rows: shipments.length, counterparties: companies.length }, dateRange: { from: dates[0] ?? null, to: dates.at(-1) ?? null } },
    quality: { status: 'scoped', issueCounts: {}, issues: [], recordFlagCounts: { shipments: {}, payments: {} }, flaggedShipmentCount: 0, flaggedPaymentCount: 0, duplicateCandidates: [], aliasCandidates: [], multipleManagerCompanyIds: [], limitations: [] },
  };
}
export function checkShipmentWrite(actor: AccountUser, fields: Record<string, string | null>, snapshot: Snapshot, previous?: Shipment) {
  if (canManage(actor)) return;
  if (previous) requireOwnedShipment(actor, previous, snapshot);
  if (!actor.managerId || !snapshot.directories?.managers.some(employee => employee.id === actor.managerId) || fields.manager_id !== actor.managerId) throw new ApiError(403, 'Можно сохранять только свои отгрузки.');
}
/** Bind omitted owner to the authenticated employee; reject forged IDs before validation. */
export function ownShipmentInput(actor: AccountUser, input: unknown, snapshot: Snapshot, previous?: Shipment): unknown {
  if (canManage(actor)) return input;
  if (previous) requireOwnedShipment(actor, previous, snapshot);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const fields = input as Record<string, unknown>;
  if (Object.hasOwn(fields, 'manager_id') && fields.manager_id !== actor.managerId) throw new ApiError(403, 'Можно сохранять только свои отгрузки.');
  checkShipmentWrite(actor, { manager_id: actor.managerId }, snapshot, previous);
  return { ...fields, manager_id: actor.managerId };
}

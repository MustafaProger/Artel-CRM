import Decimal from 'decimal.js';
import { hasSection, hasDirectoryGrant, type AccountUser } from '../web/src/auth-model';
import type { Company, Shipment, Snapshot } from '../web/src/model';
import { canManage } from './auth';
import { ApiError } from './api-error';
import { shipmentOwnership } from './shipment-ownership';
import { SHIPMENT_DECIMAL_PRECISION } from '../web/src/shipment-calculations';
const Exact = Decimal.clone({ precision: SHIPMENT_DECIMAL_PRECISION });

export function ownsShipment(actor: AccountUser, row: Shipment, snapshot: Pick<Snapshot, 'directories'>) {
  if (actor.role === 'driver') return false;
  if (canManage(actor)) return true;
  if (!actor.managerId || !snapshot.directories?.managers.some(employee => employee.id === actor.managerId) || shipmentOwnership(snapshot, row).employeeId !== actor.managerId) return false;
  // A shared request grants access only to the consumer's own resulting delivery.
  if (row.fields.source_request_id) return true;
  const assignments = snapshot.directories.customerManagers?.filter(link => link.companyId === row.customerId) ?? [];
  return !assignments.length || assignments.some(link => link.managerId === actor.managerId);
}
/** Explicit customer assignments include clients with no shipments yet. Historical
 * shipment ownership is a fallback only while the client remains unassigned. */
export function ownCustomerIds(snapshot: Snapshot, actor: AccountUser): Set<string> {
  if (canManage(actor)) return new Set(snapshot.companies.filter(company => company.roles.includes('customer')).map(company => company.id));
  if (!actor.managerId || !snapshot.directories?.managers.some(employee => employee.id === actor.managerId)) return new Set();
  return new Set([
    ...(snapshot.directories.customerManagers?.filter(link => link.managerId === actor.managerId).map(link => link.companyId) ?? []),
    ...snapshot.shipments.filter(row => ownsShipment(actor, row, snapshot) && !row.fields.source_request_id).flatMap(row => row.customerId ? [row.customerId] : []),
  ]);
}
export function requireOwnedShipment(actor: AccountUser, row: Shipment, snapshot: Snapshot) {
  if (!ownsShipment(actor, row, snapshot)) throw new ApiError(404, 'Отгрузка не найдена.');
}
export function requireWholeTrip(actor: AccountUser, snapshot: Pick<Snapshot, 'shipments' | 'directories'>, id: string) {
  const rows = snapshot.shipments.filter(row => row.fields.trip_id === id);
  if (!rows.length || !rows.some(row => ownsShipment(actor, row, snapshot))) throw new ApiError(404, 'Отгрузка машины не найдена.');
  if (rows.some(row => !ownsShipment(actor, row, snapshot))) throw new ApiError(403, 'Общий рейс доступен для изменения только администратору. Ваши строки доступны в списке отгрузок.');
}
const companyLookup = (company: Company): Company => ({ id: company.id, name: company.name, roles: company.roles, directoryArchived: company.directoryArchived, shipmentIds: [], paymentIds: [], managerLabels: [], flags: [] });
export function scopeSnapshot(snapshot: Snapshot, actor: AccountUser, context?: 'work' | 'directories', workCompanyIds: string[] = []): Snapshot {
  if (actor.role === 'driver') throw new ApiError(403, 'Водителю доступен только кабинет рейсов.');
  if (canManage(actor) && context !== 'work') return snapshot;
  const shipmentAccess = !context && (hasSection(actor, 'shipments') || hasSection(actor, 'trips'));
  const directoryAccess = context !== 'work' && hasSection(actor, 'directories');
  const shipments = shipmentAccess ? snapshot.shipments.filter(row => ownsShipment(actor, row, snapshot)).map(row => {
    const mixed = row.fields.trip_id && snapshot.shipments.some(other => other.fields.trip_id === row.fields.trip_id && !ownsShipment(actor, other, snapshot));
    return mixed ? { ...row, tripReadOnly: true, fields: { ...row.fields, trip_total_tonnes: null, trip_additional_costs: null } } : row;
  }) : [];
  const ids = new Set(shipments.map(row => row.id));
  const customerIds = ownCustomerIds(snapshot, actor);
  const requestCustomerIds = new Set(shipments.filter(row => row.fields.source_request_id).map(row => row.customerId));
  const directoryCompanyIds = new Set((snapshot.directories?.oilDepots ?? []).filter(() => directoryAccess && hasDirectoryGrant(actor, 'oilDepots')).flatMap(row => [row.ownerCompanyId, row.loadingActorCompanyId, row.infrastructureOwnerCompanyId]));
  const sharedCompany = (company: Company) => directoryAccess && (company.roles.includes('supplier') && hasDirectoryGrant(actor, 'suppliers') || company.roles.includes('other') && hasDirectoryGrant(actor, 'oilDepots') || company.roles.includes('carrier') && (hasDirectoryGrant(actor, 'vehicles') || hasDirectoryGrant(actor, 'drivers'))); 
  // Shared company lookup is operational input, never a back door to directory details or records.
  const companies = (directoryAccess || shipmentAccess || hasSection(actor, 'work') ? snapshot.companies : [])
    .filter(company => sharedCompany(company) || directoryCompanyIds.has(company.id) || canManage(actor) || customerIds.has(company.id) || requestCustomerIds.has(company.id) || context === 'work' && workCompanyIds.includes(company.id) || context !== 'directories' && company.roles.some(role => role === 'supplier' || role === 'carrier'))
    .map(company => ({
    ...(directoryAccess && (customerIds.has(company.id) || sharedCompany(company)) ? company : companyLookup(company)),
    roles: company.roles.filter(role => role === 'customer' ? customerIds.has(company.id) || requestCustomerIds.has(company.id) : role === 'supplier' ? context !== 'directories' || hasDirectoryGrant(actor, 'suppliers') : role === 'other' ? hasDirectoryGrant(actor, 'oilDepots') : role === 'carrier' && (context !== 'directories' || hasDirectoryGrant(actor, 'vehicles') || hasDirectoryGrant(actor, 'drivers'))),
    shipmentIds: company.shipmentIds.filter(id => ids.has(id)), paymentIds: [], managerLabels: [], flags: [],
  }));
  const metric = (values: (string | null)[]) => { const valid = values.filter((v): v is string => v !== null && /^[+-]?\d+(?:\.\d+)?$/.test(v)); return { total: valid.length ? valid.reduce((sum, v) => sum.plus(v), new Exact(0)).toFixed() : null, numericCount: valid.length, missingCount: values.length - valid.length }; };
  const totals = (rows: Shipment[]) => ({ shipmentCount: rows.length, paymentCount: 0, liters: metric(rows.map(r => r.liters)), revenue: metric(rows.map(r => r.revenue)), cost: metric(rows.map(r => r.cost)), incoming: metric([]), outgoing: metric([]) });
  const dates = shipments.flatMap(s => s.date ? [s.date] : []).sort();
  const catalog = snapshot.directories;
  const directories = catalog && (directoryAccess || shipmentAccess) ? {
    ...catalog,
    vehicles: directoryAccess && hasDirectoryGrant(actor, 'vehicles') ? catalog.vehicles : shipmentAccess || directoryAccess && hasDirectoryGrant(actor, 'drivers') ? catalog.vehicles.map(({ id, plate, name, capacityLitres, compartmentsLitres }) => ({ id, plate, name, capacityLitres, compartmentsLitres })) : [],
    drivers: directoryAccess && hasDirectoryGrant(actor, 'drivers') ? catalog.drivers : shipmentAccess ? catalog.drivers.map(({ id, name, vehicleId }) => ({ id, name, vehicleId })) : [],
    products: shipmentAccess || directoryAccess && hasDirectoryGrant(actor, 'products') ? catalog.products : [],
    paymentForms: shipmentAccess || directoryAccess && hasDirectoryGrant(actor, 'paymentForms') ? catalog.paymentForms : [],
    oilDepots: shipmentAccess || directoryAccess && hasDirectoryGrant(actor, 'oilDepots') ? catalog.oilDepots : [],
    operatorServices: directoryAccess && hasDirectoryGrant(actor, 'operatorServices') ? catalog.operatorServices : [],
    operatorGroups: directoryAccess && hasDirectoryGrant(actor, 'operatorServices') ? catalog.operatorGroups : [],
    managers: directoryAccess && hasDirectoryGrant(actor, 'managers') ? catalog.managers : catalog.managers.filter(employee => employee.id === actor.managerId),
    deletedEntries: undefined,
    customerManagers: catalog.customerManagers?.filter(link => link.managerId === actor.managerId),
    addresses: catalog.addresses.filter(address => companies.some(company => company.id === address.companyId) && (customerIds.has(address.companyId) || snapshot.companies.some(company => company.id === address.companyId && sharedCompany(company)) || shipmentAccess) && (address.kind !== 'delivery' || customerIds.has(address.companyId) || shipments.some(row => row.fields.source_request_id && row.fields.unloading_address_id === address.id))),
    assignedCustomerIds: [...customerIds],
    currentEmployeeId: actor.managerId && catalog.managers.some(employee => employee.id === actor.managerId) ? actor.managerId : null,
    duplicates: [],
  } : undefined;
  return { ...snapshot, directories, shipments, payments: [], stocks: [], companies, managers: [],
    overview: { ...totals(shipments), companyCount: companies.filter(company => customerIds.has(company.id)).length, missingShipmentDates: shipments.filter(s => !s.date).length, missingPaymentDates: 0 },
    monthly: [...new Set(dates.map(d => d.slice(0, 7)))].map(month => ({ month, ...totals(shipments.filter(s => s.date?.startsWith(month))) })),
    provenance: { ...snapshot.provenance, counts: { shipment_rows: shipments.length, counterparties: companies.length }, dateRange: { from: dates[0] ?? null, to: dates.at(-1) ?? null } },
    quality: { status: 'scoped', issueCounts: {}, issues: [], recordFlagCounts: { shipments: {}, payments: {} }, flaggedShipmentCount: 0, flaggedPaymentCount: 0, duplicateCandidates: [], aliasCandidates: [], multipleManagerCompanyIds: [], limitations: [] },
  };
}
export function checkShipmentWrite(actor: AccountUser, fields: Record<string, string | null>, snapshot: Snapshot, previous?: Shipment) {
  if (canManage(actor)) return;
  if (previous) requireOwnedShipment(actor, previous, snapshot);
  if (!actor.managerId || !snapshot.directories?.managers.some(employee => employee.id === actor.managerId) || fields.manager_id !== actor.managerId) throw new ApiError(403, 'Можно сохранять только свои отгрузки.');
  if (fields.customer_id && fields.customer_id !== previous?.customerId) {
    if (fields.source_request_id) return;
    const assignments = snapshot.directories.customerManagers?.filter(link => link.companyId === fields.customer_id) ?? [];
    if (assignments.length && !assignments.some(link => link.managerId === actor.managerId)) throw new ApiError(403, 'Клиент закреплён за другим менеджером.');
    if (!ownCustomerIds(snapshot, actor).has(fields.customer_id)) throw new ApiError(403, 'Клиент недоступен. Попросите администратора закрепить его за вами.');
  }
}
/** Bind omitted owner to the authenticated employee; reject forged IDs before validation. */
export function ownShipmentInput(actor: AccountUser, input: unknown, snapshot: Snapshot, previous?: Shipment, sharedRequest = false): unknown {
  if (canManage(actor)) return input;
  if (previous) requireOwnedShipment(actor, previous, snapshot);
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const fields = input as Record<string, unknown>;
  if (Object.hasOwn(fields, 'manager_id') && fields.manager_id !== actor.managerId) throw new ApiError(403, 'Можно сохранять только свои отгрузки.');
  checkShipmentWrite(actor, { manager_id: actor.managerId, customer_id: typeof fields.customer_id === 'string' ? fields.customer_id : null, ...(sharedRequest ? { source_request_id: 'validated-request' } : {}) }, snapshot, previous);
  return { ...fields, manager_id: actor.managerId };
}

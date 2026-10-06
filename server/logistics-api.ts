import type { AccountUser } from '../web/src/auth-model';
import type { Company, Snapshot } from '../web/src/model';
import { scopeSnapshot } from './auth-scope';
import { ApiError } from './api-error';

const directoryKinds = new Set(['companies', 'customers', 'suppliers', 'oilDepots', 'products', 'vehicles', 'drivers', 'addresses']);
const bankFields = ['bankName', 'settlementAccount', 'correspondentAccount', 'bik'] as const;

/** A separate audience has a closed route list, independent of the account's broader CRM rights. */
export function requireLogisticsRoute(path: string, method: string) {
  let methods: string[] | undefined;
  if (path === '/api/auth/session' || path === '/api/context') methods = ['GET'];
  else if (path === '/api/auth/login' || path === '/api/auth/logout') methods = ['POST'];
  else if (/^\/api\/drivers\/[^/]+\/access$/.test(path)) methods = ['GET', 'POST', 'PATCH'];
  else if (/^\/api\/driver\/trips(?:\/[^/]+)?$/.test(path)) methods = ['GET'];
  else if (path === '/api/shipment-trips' || path === '/api/directories') methods = ['GET', 'POST'];
  else if (/^\/api\/shipment-trips\/[^/]+$/.test(path)) methods = ['GET', 'PATCH', 'DELETE'];
  else if (/^\/api\/shipment-trips\/[^/]+\/(saby|saby-workflow)$/.test(path)) methods = ['GET', 'POST'];
  else if (/^\/api\/shipment-trips\/[^/]+\/saby-workflow\/signing$/.test(path)) methods = ['GET'];
  else if (/^\/api\/shipment-trips\/[^/]+\/saby-workflow\/signing\/start$/.test(path)) methods = ['POST'];
  else if (/^\/api\/shipment-trips\/[^/]+\/saby-workflow\/(loading-facts|carrier-details)$/.test(path)) methods = ['POST'];
  else if (/^\/api\/shipment-trips\/[^/]+\/etrn$/.test(path)) methods = ['GET', 'PUT'];
  else if (/^\/api\/shipment-trips\/[^/]+\/etrn\/(submit|refresh)$/.test(path)) methods = ['POST'];
  else if (/^\/api\/shipment-trips\/[^/]+\/etrn\/(xml\/[^/]+|files\/[^/]+\/[^/]+)$/.test(path)) methods = ['GET'];
  else if (path === '/api/companies/lookup') methods = ['POST'];
  else {
    const kind = path.match(/^\/api\/directories\/([^/]+)\/[^/]+$/)?.[1];
    if (kind && directoryKinds.has(kind)) methods = ['PATCH', 'DELETE'];
  }
  if (!methods) throw new ApiError(403, 'Этот маршрут недоступен в интерфейсе логиста.');
  if (!methods.includes(method)) throw new ApiError(405, 'Метод не поддерживается.');
}

export function requireLogisticsDirectoryInput(path: string, body: Record<string, unknown>) {
  if (path === '/api/directories' && (typeof body.kind !== 'string' || !directoryKinds.has(body.kind))) throw new ApiError(403, 'Этот справочник недоступен в интерфейсе логиста.');
  if (path.startsWith('/api/directories') && bankFields.some(key => Object.hasOwn(body, key))) throw new ApiError(403, 'Банковские реквизиты изменяются в основной CRM.');
}

export function requireLogisticsDirectoryTarget(path: string, body: Record<string, unknown>, snapshot: Snapshot, actor: AccountUser) {
  const context = logisticsContext(snapshot, actor);
  const match = path.match(/^\/api\/directories\/(companies|customers|suppliers|addresses)\/([^/]+)$/);
  if (match) {
    const id = decodeURIComponent(match[2]);
    const rows = match[1] === 'addresses' ? context.directories?.addresses : context.companies;
    if (!rows?.some(row => row.id === id)) throw new ApiError(404, 'Запись не найдена.');
  }
  const companyIds = new Set(context.companies.map(row => row.id));
  const references = ['companyId', 'ownerCompanyId', 'loadingActorCompanyId', 'infrastructureOwnerCompanyId', 'carrierId'].map(key => body[key]);
  if (Array.isArray(body.addresses)) for (const address of body.addresses) if (address && typeof address === 'object') references.push(address.loadingActorCompanyId, address.infrastructureOwnerCompanyId);
  if (references.some(id => typeof id === 'string' && id && !companyIds.has(id))) throw new ApiError(404, 'Связанная организация недоступна в интерфейсе логиста.');
}

/** Explicit projection prevents future company/accounting properties leaking into this workspace. */
export function logisticsCompany(company: Company): Company {
  const keys = ['id', 'version', 'directoryArchived', 'name', 'roles', 'inn', 'kpp', 'ogrn', 'address', 'status', 'fullName', 'director', 'phone', 'email', 'registrySource', 'registryCheckedAt', 'defaultDriverId', 'defaultVehicleId'] as const;
  return { ...Object.fromEntries(keys.filter(key => company[key] !== undefined).map(key => [key, company[key]])), shipmentIds: [], paymentIds: [], managerLabels: [], flags: [] } as unknown as Company;
}

export function logisticsContext(snapshot: Snapshot, actor: AccountUser): Pick<Snapshot, 'companies' | 'directories'> {
  const scoped = scopeSnapshot(snapshot, actor);
  const catalog = scoped.directories;
  const referenced = new Set<string | undefined | null>([
    ...(catalog?.oilDepots ?? []).flatMap(row => [row.ownerCompanyId, row.loadingActorCompanyId, row.infrastructureOwnerCompanyId]),
    ...(catalog?.vehicles ?? []).map(row => row.carrierId), ...(catalog?.drivers ?? []).map(row => row.carrierId),
    ...scoped.shipments.filter(row => row.fields.trip_id).flatMap(row => [row.customerId, row.supplierId, row.carrierId]),
  ]);
  // Explicit "other" participants must remain selectable after creation and reload,
  // before they are attached to their first depot; payment-only roles stay excluded.
  const companies = scoped.companies.filter(company => company.roles.some(role => ['customer', 'supplier', 'carrier', 'other'].includes(role)) || referenced.has(company.id));
  const companyIds = new Set(companies.map(company => company.id));
  const addresses = (catalog?.addresses ?? []).filter(row => companyIds.has(row.companyId));
  for (const address of addresses) for (const id of [address.loadingActorCompanyId, address.infrastructureOwnerCompanyId]) if (id) referenced.add(id);
  for (const company of scoped.companies) if (!companyIds.has(company.id) && referenced.has(company.id)) { companies.push(company); companyIds.add(company.id); }
  return {
    companies: companies.map(logisticsCompany),
    directories: catalog ? {
      managers: catalog.managers, products: catalog.products, paymentForms: catalog.paymentForms,
      vehicles: catalog.vehicles, drivers: catalog.drivers, addresses,
      oilDepots: catalog.oilDepots, defaults: catalog.defaults, duplicates: [],
      customerManagers: catalog.customerManagers?.filter(row => companyIds.has(row.companyId)),
      ...(catalog.currentEmployeeId !== undefined ? { currentEmployeeId: catalog.currentEmployeeId } : {}),
      ...(catalog.assignedCustomerIds !== undefined ? { assignedCustomerIds: catalog.assignedCustomerIds } : {}),
    } : undefined,
  };
}

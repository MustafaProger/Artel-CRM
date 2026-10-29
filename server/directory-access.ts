import { hasDirectoryGrant, hasSection, isAdministrator, type AccountUser } from '../web/src/auth-model';
import type { Company, Snapshot } from '../web/src/model';
import { ownCustomerIds } from './auth-scope';
import { ApiError } from './api-error';
import { normalizeName } from './directory-operations';

/** Catalog grants never replace the per-record check at the storage transaction. */
export function canEditDirectoryCompany(actor: AccountUser, company: Company, snapshot: Snapshot): boolean {
  if (isAdministrator(actor)) return true;
  if (!hasSection(actor, 'directories')) return false;
  const businessRoles = company.roles.filter(role => ['customer', 'supplier', 'carrier', 'other'].includes(role));
  return !!businessRoles.length && businessRoles.every(role => role === 'customer' ? ownCustomerIds(snapshot, actor).has(company.id)
    : role === 'supplier' ? hasDirectoryGrant(actor, 'suppliers')
    : role === 'other' ? hasDirectoryGrant(actor, 'oilDepots')
    : hasDirectoryGrant(actor, 'vehicles') || hasDirectoryGrant(actor, 'drivers'));
}

export function directoryMutation(actor: AccountUser, snapshot: Snapshot, kind: string, body: Record<string, unknown>, id?: string, deleting = false): Record<string, unknown> {
  if (isAdministrator(actor)) return body;
  if (!hasSection(actor, 'directories') || !actor.managerId) throw new ApiError(403, 'Справочник недоступен.');
  const deny = (): never => { throw new ApiError(403, 'Нет права изменять эту запись справочника.'); };
  const company = (companyId: unknown) => {
    const entry = snapshot.companies.find(row => row.id === companyId);
    if (!entry || !canEditDirectoryCompany(actor, entry, snapshot)) deny();
    return entry!;
  };
  const checkReferences = (input: Record<string, unknown>, previous?: object) => {
    for (const key of ['companyId', 'ownerCompanyId', 'loadingActorCompanyId', 'infrastructureOwnerCompanyId', 'carrierId']) {
      if (input[key] && input[key] !== (previous as Record<string, unknown> | undefined)?.[key]) company(input[key]);
    }
  };
  if (['companies', 'customers', 'suppliers', 'carriers'].includes(kind)) {
    const previous = id ? company(id) : undefined;
    // A POST may restore an archived identity or add a role to an existing company.
    // Authorize that identity before saveCompany can merge it.
    if (!id) for (const match of snapshot.companies.filter(row => typeof body.inn === 'string' && body.inn.trim() ? row.inn === body.inn.trim() : !row.inn && typeof body.name === 'string' && normalizeName(row.name) === normalizeName(body.name))) company(match.id);
    if (deleting) return body;
    if (!Array.isArray(body.roles)) return body; // Existing schema validation returns 400.
    for (const role of body.roles) {
      if (role === 'customer') { if (previous && !ownCustomerIds(snapshot, actor).has(previous.id)) deny(); }
      else if (role === 'supplier') { if (!hasDirectoryGrant(actor, 'suppliers')) deny(); }
      else if (role === 'other') { if (!hasDirectoryGrant(actor, 'oilDepots')) deny(); }
      else if (role === 'carrier') { if (!hasDirectoryGrant(actor, 'vehicles') && !hasDirectoryGrant(actor, 'drivers')) deny(); }
    }
    const previousManager = snapshot.directories?.customerManagers?.find(row => row.companyId === previous?.id)?.managerId ?? null;
    const managerId = body.roles.includes('customer') ? actor.managerId : previousManager;
    if (body.managerId && body.managerId !== managerId) deny();
    if (Array.isArray(body.addresses)) for (const address of body.addresses) if (address && typeof address === 'object') {
      const prior = snapshot.directories?.addresses.find(row => row.id === address.id && row.companyId === previous?.id);
      checkReferences(address, prior);
    }
    return { ...body, managerId };
  }
  if (kind === 'customerManagers') deny(); // Reassignment remains an administrative operation.
  if (kind === 'addresses') {
    const previous = id ? snapshot.directories?.addresses.find(row => row.id === id) : undefined;
    if (id && !previous) throw new ApiError(404, 'Адрес не найден.');
    if (previous) company(previous.companyId);
    if (!deleting) company(body.companyId);
  } else if (!hasDirectoryGrant(actor, kind === 'operatorGroups' ? 'operatorServices' : kind)) deny();
  // Existing references can be preserved; new references require access to their company.
  if (!deleting) {
    const entries = snapshot.directories?.[kind as keyof NonNullable<Snapshot['directories']>];
    const previous = Array.isArray(entries) ? entries.find(row => typeof row === 'object' && 'id' in row && row.id === id) : undefined;
    checkReferences(body, typeof previous === 'object' ? previous : undefined);
  }
  return body;
}

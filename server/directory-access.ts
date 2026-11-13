import { hasCustomerDirectoryAccess, hasDirectoryGrant, hasFullDirectoryAccess, hasSection, isAdministrator, type AccountUser } from '../web/src/auth-model';
import type { Company, Snapshot } from '../web/src/model';
import { ownCustomerIds } from './auth-scope';
import { ApiError } from './api-error';
import { normalizeName } from './directory-operations';

const companyRoles = ['customer', 'supplier', 'carrier', 'other'] as const;
type CompanyRole = typeof companyRoles[number];
const isCompanyRole = (role: unknown): role is CompanyRole => companyRoles.some(value => value === role);

export function directoryMutation(actor: AccountUser, snapshot: Snapshot, kind: string, body: Record<string, unknown>, id?: string, deleting = false): Record<string, unknown> {
  const administrator = isAdministrator(actor);
  const customerAccess = hasCustomerDirectoryAccess(actor);
  if (!hasSection(actor, 'directories') || !administrator && !actor.managerId) throw new ApiError(403, 'Справочник недоступен.');
  if (administrator && hasFullDirectoryAccess(actor)) return body;
  const deny = (): never => { throw new ApiError(403, 'Нет права изменять эту запись справочника.'); };
  const ownCompanies = ownCustomerIds(snapshot, actor);
  const roleGrant = (role: CompanyRole, entry?: Company): boolean => {
    if (role === 'customer') return (!administrator || customerAccess) && (!entry || ownCompanies.has(entry.id));
    if (role === 'supplier') return hasDirectoryGrant(actor, 'suppliers');
    if (role === 'other') return hasDirectoryGrant(actor, 'oilDepots');
    return hasDirectoryGrant(actor, 'vehicles') || hasDirectoryGrant(actor, 'drivers');
  };
  const company = (companyId: unknown, allowOwnedCard = true) => {
    const entry = snapshot.companies.find(row => row.id === companyId);
    if (!entry) return deny();
    const roles = entry.roles.filter(isCompanyRole);
    const ownsCard = allowOwnedCard && (!administrator || customerAccess) && ownCompanies.has(entry.id);
    if (!roles.length || (!ownsCard && !roles.every(role => roleGrant(role, entry)))) return deny();
    return entry;
  };
  const checkReferences = (input: Record<string, unknown>, previous?: object) => {
    for (const key of ['companyId', 'ownerCompanyId', 'loadingActorCompanyId', 'infrastructureOwnerCompanyId', 'carrierId']) {
      if (input[key] && input[key] !== (previous as Record<string, unknown> | undefined)?.[key]) company(input[key]);
    }
  };
  if (administrator && (kind === 'customers' && !customerAccess || kind === 'suppliers' && !hasDirectoryGrant(actor, 'suppliers') ||
      kind === 'carriers' && !hasDirectoryGrant(actor, 'vehicles') && !hasDirectoryGrant(actor, 'drivers'))) deny();
  if (['companies', 'customers', 'suppliers', 'carriers'].includes(kind)) {
    const previous = id ? company(id, !deleting) : undefined;
    // Restoring or merging a hidden identity still requires the shared catalog grants.
    if (!id) {
      const inn = typeof body.inn === 'string' ? body.inn.trim() : '';
      const name = typeof body.name === 'string' ? normalizeName(body.name) : '';
      const matches = snapshot.companies.filter(row => inn ? row.inn === inn : !row.inn && name && normalizeName(row.name) === name);
      for (const match of matches) {
        company(match.id, false);
        const assignment = snapshot.directories?.customerManagers?.find(row => row.companyId === match.id);
        if (!administrator && assignment && assignment.managerId !== actor.managerId && Array.isArray(body.roles) && body.roles.includes('customer')) deny();
      }
    }
    if (deleting) return body;
    if (!Array.isArray(body.roles) || !body.roles.length || !body.roles.every(isCompanyRole)) throw new ApiError(400, 'Выберите тип компании.');

    const existingRoles = previous?.roles.filter(isCompanyRole) ?? [];
    for (const role of body.roles) {
      if (!existingRoles.includes(role) && !roleGrant(role, previous)) deny();
    }
    // Editing an assigned card must neither grant a new shared role nor drop an
    // existing one the actor has no right to manage.
    const roles = [...new Set([...body.roles, ...existingRoles.filter(role => !roleGrant(role, previous))])];
    const previousManager = snapshot.directories?.customerManagers?.find(row => row.companyId === previous?.id)?.managerId ?? null;
    if (administrator) return { ...body, roles };
    const managerId = previous ? previousManager : roles.includes('customer') ? actor.managerId : null;
    // Employee forms show the signed-in manager. Saving a card must preserve its actual assignment.
    if (body.managerId && body.managerId !== managerId && !(previous && body.managerId === actor.managerId)) deny();
    if (Array.isArray(body.addresses)) for (const address of body.addresses) if (address && typeof address === 'object') {
      const prior = snapshot.directories?.addresses.find(row => row.id === address.id && row.companyId === previous?.id);
      checkReferences(address, prior);
    }
    return { ...body, roles, managerId };
  }
  if (kind === 'customerManagers') {
    if (!administrator || !customerAccess) deny();
    return body;
  }
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

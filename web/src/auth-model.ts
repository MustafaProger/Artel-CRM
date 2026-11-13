import type { AvatarPresetId } from './avatar-model';
import { permissionSections } from './page-catalog';
export type AccountRole = 'developer' | 'director' | 'admin' | 'employee' | 'manager' | 'logistician' | 'driver';
export const roleNames: Record<AccountRole, string> = { developer: 'Разработчик', director: 'Директор', admin: 'Администратор', employee: 'Сотрудник', manager: 'Менеджер', logistician: 'Логист', driver: 'Водитель' };
export const selectableRoles = (Object.entries(roleNames) as [AccountRole, string][]).filter(([role]) => role !== 'logistician');
export const isScopedEmployee = (user: Pick<AccountUser, 'role'>) => ['employee', 'manager', 'logistician'].includes(user.role);
export const sections = permissionSections;
// Keep the removed identifier readable for existing account records.
export type SectionId = typeof sections[number]['id'] | 'settlements';
export interface AccountUser { id: string; name: string; login: string; role: AccountRole; managerId: string | null; driverId?: string; active: boolean; version: number; avatarUrl?: string; avatarPreset?: AvatarPresetId; sections?: SectionId[]; customSections?: true; directoryGrants?: SharedDirectory[]; deletedAt?: string }
export const isDeveloper = (user: Pick<AccountUser, 'role'>) => user.role === 'developer';
export const canOverseeTripRequests = (user: Pick<AccountUser, 'role'>) => isDeveloper(user) || user.role === 'director';
export const isAdministrator = (user: Pick<AccountUser, 'role'>) => canOverseeTripRequests(user) || user.role === 'admin';
export const allSectionIds = sections.map(section => section.id);
// Old managers retain only sections whose data they could previously read.
// An explicit empty list means no sections. Older privileged accounts keep their defaults until edited.
export const legacyManagerSections: SectionId[] = ['overview', 'work', 'shipments', 'stock', 'operator', 'payroll', 'directories'];
export function effectiveSections(user: AccountUser): SectionId[] {
  if (user.role === 'driver') return [];
  if (isDeveloper(user) || isAdministrator(user) && !user.customSections) return [...allSectionIds];
  const grants = user.sections ?? (user.role === 'manager' ? legacyManagerSections : []);
  return [...new Set(grants.map(section => section === 'settlements' ? 'overview' : section))];
}
export const hasSection = (user: AccountUser, section: SectionId) => user.active && !user.deletedAt && effectiveSections(user).includes(section === 'settlements' ? 'overview' : section);
export interface SessionState { user: AccountUser | null; needsSetup: boolean; setupTokenRequired: boolean }

/** A staff account starts with its own work. Shared directories require an explicit grant. */
export const defaultEmployeeSections: SectionId[] = ['overview', 'work', 'shipments', 'directories'];
export const sharedDirectories = [
  { id: 'suppliers', title: 'Поставщики' }, { id: 'oilDepots', title: 'Нефтебазы' },
  { id: 'products', title: 'Товары' }, { id: 'paymentForms', title: 'Формы оплаты' },
  { id: 'vehicles', title: 'Автомобили' }, { id: 'drivers', title: 'Водители' },
  { id: 'managers', title: 'Сотрудники' }, { id: 'operatorServices', title: 'Сервисы операторской' },
] as const;
export type SharedDirectory = typeof sharedDirectories[number]['id'];
export const validDirectoryGrants = (value: unknown): value is SharedDirectory[] => Array.isArray(value) && new Set(value).size === value.length && value.every(id => sharedDirectories.some(row => row.id === id));
export const allDirectoryIds = sharedDirectories.map(directory => directory.id);
export const effectiveDirectoryGrants = (user: Pick<AccountUser, 'role' | 'directoryGrants'>): SharedDirectory[] =>
  isDeveloper(user) ? [...allDirectoryIds] : user.directoryGrants ?? (isAdministrator(user) ? [...allDirectoryIds] : []);
export const hasDirectoryGrant = (user: AccountUser, kind: string) => hasSection(user, 'directories') && effectiveDirectoryGrants(user).includes(kind as SharedDirectory);
export const hasCustomerDirectoryAccess = (user: AccountUser) =>
  hasSection(user, 'directories') && (['overview', 'shipments', 'trips'] as const).some(section => hasSection(user, section));
export const hasFullDirectoryAccess = (user: AccountUser) =>
  hasCustomerDirectoryAccess(user) && allDirectoryIds.every(id => hasDirectoryGrant(user, id));
export const availableDirectoryTabs = (user: AccountUser) => {
  if (!hasSection(user, 'directories')) return [];
  const customerTabs = hasCustomerDirectoryAccess(user) ? ['customers', 'addresses'] : [];
  const sharedTabs = sharedDirectories.filter(row => row.id !== 'paymentForms' && hasDirectoryGrant(user, row.id)).map(row => row.id);
  return [...customerTabs, ...sharedTabs];
};

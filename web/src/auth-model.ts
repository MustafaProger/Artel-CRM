import { permissionSections } from './page-catalog';
export type AccountRole = 'director' | 'admin' | 'employee' | 'manager' | 'logistician' | 'driver';
export const roleNames: Record<AccountRole, string> = { director: 'Директор', admin: 'Администратор', employee: 'Сотрудник', manager: 'Менеджер', logistician: 'Логист', driver: 'Водитель' };
export const isScopedEmployee = (user: Pick<AccountUser, 'role'>) => ['employee', 'manager', 'logistician'].includes(user.role);
export const sections = permissionSections;
// Keep the removed identifier readable for existing account records.
export type SectionId = typeof sections[number]['id'] | 'settlements';
export interface AccountUser { id: string; name: string; login: string; role: AccountRole; managerId: string | null; driverId?: string; active: boolean; version: number; sections?: SectionId[]; directoryGrants?: SharedDirectory[]; deletedAt?: string }
export const isAdministrator = (user: Pick<AccountUser, 'role'>) => user.role === 'director' || user.role === 'admin';
// Old managers retain only sections whose data they could previously read.
// An explicit empty list means no sections, never the legacy default.
export const legacyManagerSections: SectionId[] = ['overview', 'work', 'shipments', 'stock', 'operator', 'payroll', 'directories'];
export const effectiveSections = (user: AccountUser): SectionId[] => user.role === 'driver' ? [] : isAdministrator(user) ? sections.map(section => section.id) : [...new Set((user.sections ?? (user.role === 'manager' ? legacyManagerSections : [])).map(section => section === 'settlements' ? 'overview' : section))];
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
export const hasDirectoryGrant = (user: AccountUser, kind: string) => hasSection(user, 'directories') && (isAdministrator(user) || user.directoryGrants?.includes(kind as SharedDirectory) === true);
export const availableDirectoryTabs = (user: AccountUser) => hasSection(user, 'directories') ? [...(['overview', 'shipments', 'trips'] as SectionId[]).some(section => hasSection(user, section)) ? ['customers', 'addresses'] : [], ...sharedDirectories.filter(row => hasDirectoryGrant(user, row.id)).map(row => row.id)] : [];

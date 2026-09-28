export type AccountRole = 'director' | 'admin' | 'manager';
export const sections = [
  { id: 'overview', title: 'Обзор' }, { id: 'work', title: 'Работа' },
  { id: 'shipments', title: 'Отгрузки' }, { id: 'trips', title: 'Рейсы' }, { id: 'china', title: 'Китай' },
  { id: 'stock', title: 'Склад' }, { id: 'payments', title: 'Платежи' },
  { id: 'operator', title: 'Операторская' }, { id: 'payroll', title: 'ЗП' },
  { id: 'directories', title: 'Справочники' },
] as const;
// Keep the removed identifier readable for existing account records.
export type SectionId = typeof sections[number]['id'] | 'settlements';
export interface AccountUser { id: string; name: string; login: string; role: AccountRole; managerId: string | null; active: boolean; version: number; sections?: SectionId[]; deletedAt?: string }
export const isAdministrator = (user: AccountUser) => user.role === 'director' || user.role === 'admin';
// Old managers retain only sections whose data they could previously read.
// An explicit empty list means no sections, never the legacy default.
export const legacyManagerSections: SectionId[] = ['overview', 'work', 'shipments', 'stock', 'operator', 'payroll', 'directories'];
export const effectiveSections = (user: AccountUser): SectionId[] => isAdministrator(user) ? sections.map(section => section.id) : [...new Set((user.sections ?? legacyManagerSections).map(section => section === 'settlements' ? 'overview' : section))];
export const hasSection = (user: AccountUser, section: SectionId) => user.active && !user.deletedAt && effectiveSections(user).includes(section === 'settlements' ? 'overview' : section);
export interface SessionState { user: AccountUser | null; needsSetup: boolean; setupTokenRequired: boolean }

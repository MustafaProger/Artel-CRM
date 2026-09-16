export type AccountRole = 'director' | 'admin' | 'manager';
export const sections = [
  { id: 'overview', title: 'Обзор' }, { id: 'work', title: 'Работа' },
  { id: 'shipments', title: 'Отгрузки' }, { id: 'china', title: 'Китай' },
  { id: 'stock', title: 'Склад' }, { id: 'payments', title: 'Платежи' },
  { id: 'operator', title: 'Операторская' }, { id: 'payroll', title: 'ЗП' },
  { id: 'directories', title: 'Справочники' },
] as const;
export type SectionId = typeof sections[number]['id'];
export interface AccountUser { id: string; name: string; login: string; role: AccountRole; managerId: string | null; active: boolean; version: number; sections?: SectionId[] }
export const isAdministrator = (user: AccountUser) => user.role === 'director' || user.role === 'admin';
// Old managers retain only sections whose data they could previously read.
// An explicit empty list means no sections, never the legacy default.
export const legacyManagerSections: SectionId[] = ['overview', 'work', 'shipments', 'stock', 'operator', 'payroll', 'directories'];
export const effectiveSections = (user: AccountUser): SectionId[] => isAdministrator(user) ? sections.map(section => section.id) : [...(user.sections ?? legacyManagerSections)];
export const hasSection = (user: AccountUser, section: SectionId) => user.active && effectiveSections(user).includes(section);
export interface SessionState { user: AccountUser | null; needsSetup: boolean; setupTokenRequired: boolean }

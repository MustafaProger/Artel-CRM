import { hasSection, type AccountUser, type SectionId } from '../web/src/auth-model';
import { ApiError } from './api-error';

export function requireSection(actor: AccountUser, section: SectionId) {
  if (!hasSection(actor, section)) throw new ApiError(403, 'Раздел недоступен. Обратитесь к администратору.');
  return actor;
}
export function apiSection(path: string): SectionId | null {
  if (/^\/api\/settlements(\/|$)/.test(path)) return 'settlements';
  if (/^\/api\/(shipments|shipment-trips)(\/|$)/.test(path)) return 'shipments';
  if (/^\/api\/(directories|companies)(\/|$)/.test(path)) return 'directories';
  if (/^\/api\/(work|push)(\/|$)/.test(path)) return 'work';
  if (/^\/api\/china(\/|$)/.test(path)) return 'china';
  if (/^\/api\/banking(\/|$)/.test(path)) return 'payments';
  for (const section of ['overview', 'stock', 'operator', 'payroll'] as const) if (path === `/api/${section}` || path.startsWith(`/api/${section}/`)) return section;
  return null;
}

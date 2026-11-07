import { hasSection, type AccountUser } from './auth-model';
import { enabledPages, pageCatalog, type PageId } from './page-catalog';

export function hasPageAccess(user: AccountUser, id: PageId) {
  const page = pageCatalog.find(page => page.id === id)!;
  if (!page.enabled || !user.active || user.deletedAt) return false;
  return hasSection(user, page.id);
}
export const availablePagesFor = (user: AccountUser) => enabledPages.filter(page => hasPageAccess(user, page.id));

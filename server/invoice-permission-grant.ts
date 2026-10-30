import type { OperationsData } from './operations-store';
import { effectiveSections } from '../web/src/auth-model';

/** One-time, explicitly authorized additive grant. Identity comes from the reviewed mapping. */
export function grantInvoiceAccess(data: OperationsData, mapping: unknown) {
  const value = mapping as { version?: unknown; users?: { crmUserId: string; invoiceOwnerId: string }[] };
  if (!value || value.version !== 1 || !Array.isArray(value.users) || value.users.length !== 2
      || value.users.some(row => !row || typeof row.crmUserId !== 'string' || !row.crmUserId || !/^[a-f0-9-]{36}$/.test(row.invoiceOwnerId))
      || new Set(value.users.map(row => row.crmUserId)).size !== 2 || new Set(value.users.map(row => row.invoiceOwnerId)).size !== 2) throw new Error('Invalid reviewed invoice mapping');
  const users = value.users.map(row => data.accounts?.users.find(user => user.id === row.crmUserId));
  if (users.some(user => !user || !user.active || user.deletedAt || user.role === 'driver')) throw new Error('Mapped CRM account is unavailable');
  let granted = 0;
  for (const user of users) {
    if (user!.sections?.includes('invoices')) continue;
    user!.sections = [...(user!.sections ?? effectiveSections(user!)), 'invoices'];
    user!.version++;
    granted++;
  }
  return { mapped: users.length, granted, changed: granted > 0 };
}

import type { Directories } from './model'

/** Explicit customer assignments are independent of historical shipment labels. */
export function customerManagerId(directories: Directories, companyId: string): string {
  return directories.customerManagers?.find(row => row.companyId === companyId)?.managerId ?? ''
}

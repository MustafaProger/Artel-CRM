import type { Directories } from './model'

/** Explicit customer assignments are independent of historical shipment labels. */
export function customerManagerId(directories: Directories, companyId: string): string {
  return directories.customerManagers?.find(row => row.companyId === companyId)?.managerId ?? ''
}

/** Customer choices follow the directory relation, with the saved document retained for editing. */
export function availableShipmentCustomer(directories: Directories, companyId: string, currentId = ''): boolean {
  return directories.assignedCustomerIds === undefined || directories.assignedCustomerIds.includes(companyId) || companyId === currentId;
}

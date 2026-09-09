import type { OperationsData } from './operations-store';

/** Called under the same file lock as shipment creation. A future numbering
 * policy can allocate its sequence in this transaction without UI changes. */
export function allocateShipmentNumber(_store: OperationsData, _operationDate: string): string | null {
  return null; // Prefix, numbering period and starting sequence are not defined yet.
}

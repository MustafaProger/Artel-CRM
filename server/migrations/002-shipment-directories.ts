import type { OperationsData } from '../operations-store';
import { emptyDirectories } from '../directory-operations';

/** Pure, idempotent v1 → v2 migration, persisted by the store's atomic write.
 * Source values/IDs and all shipment overrides are retained verbatim.
 * Historical carrier companies are not guessed to be people or vehicles.
 */
export function migrateShipmentDirectories(data: OperationsData): OperationsData {
  if (data.schemaVersion === 2) return data;
  return { ...data, schemaVersion: 2, directories: emptyDirectories(), paymentAllocations: [] };
}

import type { OperationsData } from '../operations-store';

/** Additive v2 migration, persisted by the normal atomic store write.
 * Legacy supplier loading addresses and all trip snapshots are retained unchanged.
 * No old address is promoted to an oil depot without verified company/role mapping.
 */
export function migrateOilDepots(data: OperationsData): OperationsData {
  if (!data.directories || data.directories.oilDepots !== undefined) return data;
  return { ...data, directories: { ...data.directories, oilDepots: [] } };
}

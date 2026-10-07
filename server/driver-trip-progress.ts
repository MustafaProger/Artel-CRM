/** Durable driver facts, separate from editable accounting and external document attempts. */
export interface DriverTripProgress {
  driverId: string;
  compositionHash: string;
  arrivedAt: string;
  arrivedBy: string;
  arrivalVersions: Record<string, number>;
  departedAt?: string;
  departedBy?: string;
  departureVersions?: Record<string, number>;
  masses?: Record<string, string>;
  continuationRequestedAt?: string;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const stamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const versions = (value: unknown): value is Record<string, number> => object(value) && Object.keys(value).length > 0 && Object.values(value).every(version => Number.isSafeInteger(version) && Number(version) >= 0);
export function validateDriverTripProgress(value: unknown): asserts value is Record<string, DriverTripProgress> | undefined {
  if (value === undefined) return;
  if (!object(value)) throw new Error('Invalid driver progress');
  for (const [id, row] of Object.entries(value)) {
    if (!/^shipment-trip-[a-f0-9-]+$/.test(id) || !object(row) || typeof row.driverId !== 'string' || !row.driverId || typeof row.arrivedBy !== 'string' || !row.arrivedBy || !stamp(row.arrivedAt) || !versions(row.arrivalVersions) || typeof row.compositionHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.compositionHash)) throw new Error('Invalid driver arrival');
    const departed = row.departedAt !== undefined;
    if (departed) {
      if (!stamp(row.departedAt) || row.departedAt < row.arrivedAt || typeof row.departedBy !== 'string' || !row.departedBy || row.continuationRequestedAt !== row.departedAt || !versions(row.departureVersions) || !object(row.masses) || !Object.keys(row.masses).length || Object.keys(row.masses).sort().join('|') !== Object.keys(row.departureVersions).sort().join('|')) throw new Error('Invalid driver departure');
      for (const mass of Object.values(row.masses)) if (typeof mass !== 'string' || !/^\d{1,11}(?:\.\d{1,6})?$/.test(mass) || !/[1-9]/.test(mass)) throw new Error('Invalid driver mass');
    } else if (['departedBy', 'departureVersions', 'masses', 'continuationRequestedAt'].some(key => row[key] !== undefined)) throw new Error('Partial driver departure');
  }
}

import type { Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';

/** CRM identity only: never changes shipment fields or Saby document numbers.
 * Include tombstones so deleting a trip cannot recycle or shift its number.
 * Legacy numbers are deterministic on read and frozen before composition changes.
 */
export function readTripNumbers(snapshot: Snapshot, data: OperationsData): Record<string, number> {
  const numbers = { ...data.tripNumbers };
  const chronology = new Map<string, string>();
  for (const row of [...snapshot.shipments, ...Object.values(data.shipments)]) {
    const id = row.fields.trip_id;
    if (!id) continue;
    const created = row.createdAt || row.fields.date || '';
    const previous = chronology.get(id);
    if (previous === undefined || created < previous) chronology.set(id, created);
  }
  let next = Object.values(numbers).reduce((max, value) => Math.max(max, value), 0);
  for (const [id] of [...chronology].sort(([a, timeA], [b, timeB]) => timeA.localeCompare(timeB) || a.localeCompare(b))) {
    if (!Object.hasOwn(numbers, id)) numbers[id] = ++next;
  }
  return numbers;
}

/** Runs inside the trip's existing OperationsStore transaction. */
export function reserveTripNumber(snapshot: Snapshot, data: OperationsData, id: string) {
  const numbers = readTripNumbers(snapshot, data);
  if (!Object.hasOwn(numbers, id)) numbers[id] = Object.values(numbers).reduce((max, value) => Math.max(max, value), 0) + 1;
  data.tripNumbers = numbers;
  return numbers[id];
}

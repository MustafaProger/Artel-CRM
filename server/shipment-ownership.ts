import type { Shipment, Snapshot } from '../web/src/model';
import { directoryEntryId, normalizeName } from './directory-operations';

/** Explicit IDs are authoritative. Only exact, unique legacy mappings are accepted.
 * A renamed deterministic employee ID keeps the original source association.
 * This never rewrites imported fields or treats an employee name as a role.
 */
export function shipmentOwnership(snapshot: Snapshot, row: Shipment) {
  const employees = snapshot.directories?.managers ?? [];
  const explicit = row.fields.manager_id;
  if (explicit) return employees.some(employee => employee.id === explicit)
    ? { employeeId: explicit, reason: 'id' }
    : { employeeId: null, reason: 'unknown-id' };
  const label = row.fields.manager_label?.trim();
  if (!label || label === '0') return { employeeId: null, reason: 'missing' };
  const candidates = employees.filter(employee => employee.id === directoryEntryId('managers', label) || normalizeName(employee.name) === normalizeName(label));
  return candidates.length === 1 ? { employeeId: candidates[0].id, reason: 'legacy-exact' }
    : { employeeId: null, reason: candidates.length ? 'ambiguous' : 'unresolved-label' };
}
export function ownershipReport(snapshot: Snapshot) {
  return snapshot.shipments.map(row => ({ shipmentId: row.id, ...shipmentOwnership(snapshot, row) }));
}

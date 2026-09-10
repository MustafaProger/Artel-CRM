import type { Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { currentSnapshot } from './shipment-operations';

/** Explicit maintenance action. Materialize the dictionaries before dropping operations. */
export function clearOperations(base: Snapshot, data: OperationsData) {
  const snapshot = currentSnapshot(base, data);
  const removed = { shipments: snapshot.shipments.length, payments: snapshot.payments.length, stocks: snapshot.stocks.length };
  data.directories = structuredClone(snapshot.directories!);
  data.directories.duplicates = [];
  data.companies = snapshot.companies.map(company => ({ ...company, shipmentIds: [], paymentIds: [], managerLabels: [], flags: [] }));
  data.shipments = {};
  data.paymentAllocations = [];
  data.sourceOperationsCleared = true;
  return { removed, companies: data.companies.length, managers: data.directories.managers.length, drivers: data.directories.drivers.length, vehicles: data.directories.vehicles.length };
}

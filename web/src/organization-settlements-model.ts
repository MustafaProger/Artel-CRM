import type { OurOrganizationId } from './our-organizations';
import type { SettlementsReport } from './settlements-model';

/** Each ledger is independent. Supplier shipped/incoming mean purchases/payments
 * to the supplier; debt and advance remain positive magnitudes in both ledgers. */
export interface OrganizationSettlement {
  id: OurOrganizationId;
  name: string;
  clients: SettlementsReport;
  suppliers: SettlementsReport;
}

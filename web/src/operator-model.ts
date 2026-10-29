import type { Directories, NamedEntry, OperatorService } from './model';
import type { OperatorCase, OperatorCaseSummary, OperatorCarryover } from './operator-case-model';

export interface OperatorRecipientFields {
  name: string; bank: string; card: string; phone: string; details: string;
}
export interface OperatorRecipient extends OperatorRecipientFields {
  id: string; version: number; archived: boolean; createdAt: string; updatedAt: string;
}
export interface OperatorPaymentEvent { paid: boolean; at: string; actorId: string; actorName: string }
export interface OperatorRefuellingFields {
  date: string; name: string; service: string; discountPercent: string;
  litres: string; pricePerLitre: string; amount: string; comment: string;
}
interface OperatorRefuellingMetadata {
  id: string; version: number;
  paid: boolean; paymentHistory: OperatorPaymentEvent[];
  createdAt: string; updatedAt: string; createdBy: string;
  /** Deleted operations remain in storage for history and idempotent retries. */
  deletedAt?: string; deletedBy?: string; deletedByName?: string;
}
export interface OperatorLegacyRefuelling extends OperatorRefuellingFields, OperatorRefuellingMetadata {
  schemaVersion?: undefined;
  recipientId: string; recipient: OperatorRecipientFields;
}
export interface OperatorRefuellingV2Fields extends OperatorRefuellingFields {
  schemaVersion: 2;
  /** Historical snapshot pair; absent on new operations created without a group. */
  groupId?: string; groupName?: string;
  serviceId: string; serviceVersion: number;
  recipientText: string;
  amountMode: 'auto' | 'manual';
  /** Server-only provenance for unchanged values accepted by the legacy format. */
  legacyPrecision?: { litres?: string; pricePerLitre?: string };
}
export interface OperatorRefuellingV2 extends OperatorRefuellingV2Fields, OperatorRefuellingMetadata {}
export type OperatorManagerId = 'aidar' | 'eldar';
export const operatorManagerNames: Record<OperatorManagerId, string> = { aidar: 'Айдар', eldar: 'Эльдар' };
export interface OperatorPlanRecipient extends OperatorRecipientFields { id: string; limit: string }
export interface OperatorPlan {
  id: string; version: number; clientName: string;
  /** Historical assignment, retained for older plans; creator is the authenticated account. */
  managerId?: OperatorManagerId;
  recipients: OperatorPlanRecipient[];
  createdAt: string; updatedAt: string; createdBy: string; createdByName?: string;
}
export interface OperatorPlanSummary extends Omit<OperatorPlan, 'recipients'> {
  recipients: (OperatorPlanRecipient & { used: string; remaining: string })[];
  totalLimit: string; allocated: string; remaining: string; status: 'active' | 'completed';
}
export type OperatorAllocation = { planId?: string; planClientName?: string } & (
  | { kind: 'recipient'; recipientId: string; amount: string; recipient: OperatorRecipientFields }
  | { kind: 'manager'; managerId: OperatorManagerId; amount: string });
export type OperatorAllocationInput = { planId?: string; planVersion?: number } & (
  | { kind: 'recipient'; recipientId: string; amount: string }
  | { kind: 'manager'; managerId: OperatorManagerId; amount: string });
export interface OperatorRefuellingV3Fields extends Omit<OperatorRefuellingV2Fields, 'schemaVersion'> {
  schemaVersion: 3; planId: string; planClientName: string; allocations: OperatorAllocation[];
  /** Total litres includes the old remainder; only payableLitres is charged again. */
  carryoverMode?: 'money'; creditedAmount?: string; payableLitres?: string; carryovers?: OperatorCarryover[];
}
export interface OperatorRefuellingV3 extends OperatorRefuellingV3Fields, OperatorRefuellingMetadata {}
export type OperatorRefuelling = OperatorLegacyRefuelling | OperatorRefuellingV2 | OperatorRefuellingV3;
export type OperatorCatalogSource = Pick<Directories, 'operatorGroups' | 'operatorServices'>;
export interface OperatorReconciliationEvent {
  litres: string; amount: string; at: string; actorId: string; actorName: string;
}
export interface OperatorReconciliationRecord {
  id: string; date: string; serviceId: string; service: string; version: number;
  litres: string; amount: string; createdAt: string; updatedAt: string;
  history: OperatorReconciliationEvent[];
}
export interface OperatorData {
  reconciliations?: Record<string, OperatorReconciliationRecord>;
  recipients: Record<string, OperatorRecipient>;
  refuellings: Record<string, OperatorRefuelling>;
  plans?: Record<string, OperatorPlan>;
  cases?: Record<string, OperatorCase>;
  requests: Record<string, { fingerprint: string; actorId: string; collection: 'recipients' | 'refuellings' | 'plans' | 'cases' | 'reconciliations'; id: string; version?: number; settlementId?: string; taskEventId?: string }>;
}
export interface OperatorWorkspace {
  reconciliations?: OperatorReconciliationRecord[];
  recipients: OperatorRecipient[]; refuellings: OperatorRefuelling[];
  groups: NamedEntry[]; services: OperatorService[];
  plans: OperatorPlanSummary[];
  cases: OperatorCaseSummary[];
}

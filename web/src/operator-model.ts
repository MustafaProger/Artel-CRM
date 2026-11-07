import type { Directories, NamedEntry, OperatorService } from './model';

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
}
export interface OperatorLegacyRefuelling extends OperatorRefuellingFields, OperatorRefuellingMetadata {
  schemaVersion?: undefined;
  recipientId: string; recipient: OperatorRecipientFields;
}
export interface OperatorRefuellingV2Fields extends OperatorRefuellingFields {
  schemaVersion: 2;
  groupId: string; groupName: string;
  serviceId: string; serviceVersion: number;
  recipientText: string;
  amountMode: 'auto' | 'manual';
  /** Server-only provenance for unchanged values accepted by the legacy format. */
  legacyPrecision?: { litres?: string; pricePerLitre?: string };
}
export interface OperatorRefuellingV2 extends OperatorRefuellingV2Fields, OperatorRefuellingMetadata {}
export type OperatorRefuelling = OperatorLegacyRefuelling | OperatorRefuellingV2;
export type OperatorCatalogSource = Pick<Directories, 'operatorGroups' | 'operatorServices'>;
export interface OperatorData {
  recipients: Record<string, OperatorRecipient>;
  refuellings: Record<string, OperatorRefuelling>;
  requests: Record<string, { fingerprint: string; actorId: string; collection: 'recipients' | 'refuellings'; id: string }>;
}
export interface OperatorWorkspace {
  recipients: OperatorRecipient[]; refuellings: OperatorRefuelling[];
  groups: NamedEntry[]; services: OperatorService[];
}

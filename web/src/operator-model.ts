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
export interface OperatorRefuelling extends OperatorRefuellingFields {
  id: string; version: number; recipientId: string; recipient: OperatorRecipientFields;
  paid: boolean; paymentHistory: OperatorPaymentEvent[];
  createdAt: string; updatedAt: string; createdBy: string;
}
export interface OperatorData {
  recipients: Record<string, OperatorRecipient>;
  refuellings: Record<string, OperatorRefuelling>;
  requests: Record<string, { fingerprint: string; actorId: string; collection: 'recipients' | 'refuellings'; id: string }>;
}
export interface OperatorWorkspace { recipients: OperatorRecipient[]; refuellings: OperatorRefuelling[] }

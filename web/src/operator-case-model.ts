export type OperatorCaseKind = 'return' | 'deferred';
export interface OperatorCaseSource {
  operationVersion: number; driverName: string; date: string; service: string;
  litres: string; pricePerLitre: string; discountPercent: string; amount: string;
}
export interface OperatorCaseSettlement {
  id: string; method: 'money' | 'fuel' | 'carryover'; litres: string; amount: string;
  at: string; actorId: string; actorName: string;
  /** Present only when this remainder was used in a new operation. */
  operationId?: string; valuation?: 'money';
}
export interface OperatorCaseTask {
  dueDate: string; comment: string; createdAt: string; createdBy: string; createdByName: string;
  updatedAt: string; updatedBy: string; updatedByName: string;
}
export interface OperatorCaseTaskEvent {
  id: string; dueDate: string; comment: string; at: string; actorId: string; actorName: string;
}
export interface OperatorCase {
  id: string; version: number; kind: OperatorCaseKind; operationId: string;
  source: OperatorCaseSource; litres: string; amount: string;
  createdAt: string; updatedAt: string; createdBy: string; createdByName: string;
  settlements: OperatorCaseSettlement[];
  task?: OperatorCaseTask; taskHistory?: OperatorCaseTaskEvent[];
}
export interface OperatorCaseSummary extends OperatorCase {
  remainingLitres: string; remainingAmount: string; status: 'open' | 'completed';
}
export interface OperatorCarryoverInput { caseId: string; version: number; litres: string }
export interface OperatorCarryover {
  caseId: string; settlementId: string; litres: string; driverName: string; amount?: string;
}

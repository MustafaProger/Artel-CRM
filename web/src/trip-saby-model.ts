/** Safe trip-level response. Private snapshots and credentials stay server-side. */
export type TripSabyExchangeStage = 'sender_action_required' | 'signature_pending' | 'sending_to_carrier' | 'carrier_details_required' | 'carrier_action_required' | 'carrier_confirmation_pending' | 'carrier_confirmed' | 'rejected' | 'operator_error' | 'cancelled' | 'unknown';
export interface TripSabyHistoryEntry { at: string; stage: TripSabyExchangeStage; remoteStateCode: string | null }
export interface TripSabyMonitoring { enabled: boolean; intervalSeconds: 15 | 300 | null; reason?: string }
/** Explicit allowlist for the authorized employee's manual carrier handoff. */
export interface TripSabyCarrierHandoff { driverName: string | null; driverPhone: string | null; vehiclePlate: string | null; vehicleType: string | null }
export interface TripSabyCarrierFill {
  state: 'waiting' | 'partial' | 'saved' | 'unknown' | 'blocked';
  blockers: string[];
  driverSaved: boolean;
  vehicleSaved: boolean;
  responsibleSaved?: boolean;
  checkedAt: string | null;
}
export interface TripSabyOrderSummary {
  id: string | null;
  number: string | null;
  date: string | null;
  status: 'pending' | 'unknown' | 'draft' | 'error';
  url: string | null;
  revision: string | null;
  remoteStatus: string | null;
  signatureStatus: 'not_signed' | 'reported_by_saby' | 'unknown';
  remoteStateCode?: string | null;
  exchangeStage?: TripSabyExchangeStage;
}
export type TripSabySigningStepState = 'not_started' | 'preparing' | 'requested' | 'waiting' | 'unknown' | 'confirmed' | 'blocked';
export interface TripSabySigningStep {
  state: TripSabySigningStepState;
  message?: string;
}
export interface TripSabySigning {
  state: 'active' | 'blocked' | 'unknown' | 'completed';
  requestedAt: string;
  sender: TripSabySigningStep;
  carrier: TripSabySigningStep;
}
export interface TripSabySigningSignature { id: string; owner: string; expiresAt: string | null }
export interface TripSabySigningSideOptions {
  organization: string;
  signatures: TripSabySigningSignature[];
  message?: string;
}
export interface TripSabySigningPreview {
  order: Pick<TripSabyOrderSummary, 'id' | 'number' | 'date' | 'revision'>;
  previewToken: string | null;
  ready: boolean;
  blockers: string[];
  checkedAt: string;
  sender: TripSabySigningSideOptions;
  carrier: TripSabySigningSideOptions;
  signing?: TripSabySigning;
}
export interface TripSabySigningStartRequest {
  requestId: string;
  previewToken: string;
  senderSignatureId: string;
  carrierSignatureId: string;
  confirmed: true;
}
export interface TripSabyResponse {
  status: 'not_sent' | 'sent' | 'error';
  phase: 'preparation' | 'submitting' | 'unknown' | 'awaiting_carrier' | 'awaiting_loading' | 'creating_etrn' | 'completed' | 'error';
  ready: boolean;
  blockers: string[];
  locked: boolean;
  updatedAt: string | null;
  lastError: string | null;
  order: TripSabyOrderSummary | null;
  deliveries: { shipmentId: string; id: string | null; status: 'not_sent' | 'pending' | 'unknown' | 'draft' | 'error'; lastError: string | null }[];
  carrierConfirmed: boolean;
  lastCheckedAt: string | null;
  lastCheckAttemptAt: string | null;
  monitoring: TripSabyMonitoring;
  history: TripSabyHistoryEntry[];
  carrierHandoff?: TripSabyCarrierHandoff;
  carrierFill?: TripSabyCarrierFill;
  signing?: TripSabySigning;
}

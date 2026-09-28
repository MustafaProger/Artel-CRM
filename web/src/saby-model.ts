/** Safe response contract: no server credentials, payloads, or personal identifiers. */
export type SabyDocumentStatus = 'pending' | 'unknown' | 'draft' | 'error';
export interface SabyDocumentSummary {
  shipmentId: string;
  id: string | null;
  revision: string | null;
  status: SabyDocumentStatus;
  url: string | null;
  remoteStatus: string | null;
  lastError: string | null;
  updatedAt: string;
}
export interface SabyTripSummary {
  status: 'unconfigured' | 'ready' | 'pending' | 'unknown' | 'draft' | 'error' | 'partial';
  updatedAt: string | null;
  lastError: string | null;
  documents: SabyDocumentSummary[];
}
export interface SabyTripResponse {
  saby: SabyTripSummary;
  readiness: { ready: boolean; blockers: string[] };
}

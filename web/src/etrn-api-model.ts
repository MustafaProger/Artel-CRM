import type { SabyConsignmentProfile } from './etrn-model'

/** Authenticated trip responses. Credentials and Saby sessions never enter this contract. */
export interface EtrnFileSummary {
  id: string
  name: string
  extension: string
  sha256?: string
  size?: number
  url: string
}

export interface EtrnDocumentSummary {
  id: string | null
  revision: string | null
  status: 'pending' | 'unknown' | 'draft' | 'error'
  url: string | null
  remoteStatus: string | null
  lastError: string | null
  updatedAt: string
  files: EtrnFileSummary[]
  signatureStatus: 'not_signed' | 'reported_by_saby' | 'unknown'
  gisStatus: string | null
  availableActions: string[]
}

export interface EtrnDeliverySummary {
  shipmentId: string
  profile: SabyConsignmentProfile | null
  blockers: string[]
  document: EtrnDocumentSummary | null
}

export interface EtrnTripResponse {
  configured: boolean
  configurationBlockers: string[]
  organizations?: { consignor: EtrnOrganizationSummary; carrier: EtrnOrganizationSummary }
  deliveries: EtrnDeliverySummary[]
  updatedAt: string | null
}

export interface EtrnOrganizationSummary { name: string; inn: string; kpp: string; address: string; phone: string }

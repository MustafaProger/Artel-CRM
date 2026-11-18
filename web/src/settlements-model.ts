import type { OrganizationSettlement } from './organization-settlements-model';

export interface SettlementAllocation {
  shipmentId: string
  paymentId: string
  amount: string
  date: string
}
export interface SettlementShipment {
  id: string
  date: string | null
  number: string | null
  amount: string | null
  openingPaid: string | null
  bankPaid: string
  paid: string | null
  debt: string | null
  issue: string | null
}
export interface SettlementReceipt {
  id: string
  bankOperationId?: string
  documentNumber?: string | null
  /** Amount is the visible allocation slice; the original total/advance is private. */
  amountIsScoped?: boolean
  date: string
  connectionId: string
  bank: string
  company: string
  account: string
  purpose: string | null
  amount: string
  allocated: string
  advance: string
  allocations: SettlementAllocation[]
}
export interface SettlementCompany {
  key: string
  name: string
  inn: string | null
  companyIds: string[]
  shipped: string
  openingPaid: string
  incoming: string
  allocated: string
  debt: string
  advance: string
  issues: string[]
  shipments: SettlementShipment[]
  receipts: SettlementReceipt[]
}
export interface SettlementReview {
  id: string
  date: string
  connectionId: string
  bank: string
  company: string
  account: string
  name: string
  inn: string | null
  amount: string
  currency: string
  reason: string
}
export interface SettlementSource {
  id: string
  name: string
  status: 'not_loaded' | 'ready' | 'error' | 'syncing'
  lastError: string | null
  lastSuccessAt: string | null
  from: string | null
  to: string | null
}
export interface SupplierPaymentTraceResult {
  match: {
    organizationName: string
    supplierName: string
    receipt: Pick<SettlementReceipt, 'amount' | 'allocated' | 'advance' | 'allocations'>
    shipments: Pick<SettlementShipment, 'id' | 'number' | 'date' | 'debt'>[]
  } | null
  reviewReason?: string
}
export interface SettlementsReport {
  scope?: 'all' | 'own'
  /** Per-organization ledgers; companies/totals retain the global customer view. */
  organizations?: OrganizationSettlement[]
  unassignedShipmentCount?: number
  companies: SettlementCompany[]
  review: SettlementReview[]
  totals: { shipped: string; incoming: string; debt: string; advance: string; allocated: string }
  sources: SettlementSource[]
}

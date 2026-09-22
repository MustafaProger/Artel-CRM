export type BankProvider = 'sber' | 'tbank'
export const bankConnections = [
  { id: 'sber-nk-artel', provider: 'sber', bankName: 'СберБизнес', company: 'НК АРТЕЛЬ' },
  { id: 'sber-artel', provider: 'sber', bankName: 'СберБизнес', company: 'АРТЕЛЬ' },
  { id: 'tbank-nk-artel', provider: 'tbank', bankName: 'Т-Банк', company: 'НК АРТЕЛЬ', envPrefix: 'ARTEL_BANK_TBANK_NK' },
] as const
export interface BankAccount { number: string; currency: string; name?: string; status?: string; bankBic?: string }
export interface BankParty { name?: string; inn?: string; kpp?: string; account?: string; bankName?: string; bic?: string; correspondentAccount?: string }
export interface BankOperation {
  id: string
  connectionId: string
  provider: BankProvider
  bankOperationId: string
  account: string
  statementDate: string
  documentNumber?: string
  documentDate?: string
  bookedAt?: string
  direction: 'incoming' | 'outgoing'
  amount: string
  currency: string
  /** Bank status is never inferred from a payment purpose. */
  status?: string
  booked: boolean
  purpose?: string
  payer: BankParty
  payee: BankParty
  vat?: string
  commission?: string
  /** All fields of the statement/detail resource, with secret keys removed. */
  bankData: Record<string, unknown>
  detailsFetchedAt?: string
  updatedAt: string
  source: 'statement-api'
  /** Reserved only; no matching, posting or allocation is performed. */
  counterpartyId: string | null
  allocations: { documentId: string; documentType: string; amount: string }[]
  importedSourceIds: string[]
}
export interface BankTotals { currency: string; incoming: string; outgoing: string; count: number }
export interface BankSyncJob {
  id: string; from: string; to: string; day: string; accountIndex: number; cursor?: string
  accounts: BankAccount[]; startedAt: string; pages: number; attempts: number; nextAttemptAt?: string
  staged?: BankOperation[]
  seenCursors?: string[]
}
export interface BankConnectionState {
  accounts: BankAccount[]
  /** Only a complete, validated replacement may admit this exact account/day to settlements. */
  settlementVerifiedDays?: { account: string; date: string; syncedAt: string }[]
  lastSuccessAt?: string
  lastScheduledAt?: string
  lastAttemptAt?: string
  lastError?: string
  lastCompletedPeriod?: { from: string; to: string }
  job?: BankSyncJob
  lease?: { id: string; until: number }
  requestNotBefore?: number
  webhookPending?: boolean
  webhookHashes?: string[]
  encryptedTokens?: string
  encryptedOAuth?: string
  oauthAttemptHash?: string
  lastOAuthError?: { message: string; reason: string; at: string; issuer?: string; checks?: Record<string, boolean>; accountCheck?: { kind: string; count: number; entries: { kind: string; fields: string[]; numberType: string; numberLength: number; last4?: string; matchesConfigured: boolean }[] } }
}
export interface BankingData { version: 1; connections: Record<string, BankConnectionState>; operations: BankOperation[]; archivedOperations?: BankOperation[] }
export interface BankCard {
  id: string; provider: BankProvider; bankName: string; company: string; accounts: BankAccount[]
  state: 'not_configured' | 'ready' | 'syncing' | 'error' | 'connected'
  missing: string[]; lastSuccessAt?: string; lastError?: string
  lastCompletedPeriod?: { from: string; to: string }
  progress?: { from: string; to: string; day: string; pages: number; attempts: number; nextAttemptAt?: string }
  totals: BankTotals[]; limitations: string[]
}
export interface BankListResult {
  connections: BankCard[]; items: BankOperation[]; total: number; page: number; pageSize: number
  totals: BankTotals[]; statuses: string[]; storedCount: number; scheduleEnabled: boolean
}

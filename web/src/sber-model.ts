import type { BankOperation } from './banking-model'

export type SberOperation = BankOperation

export interface SberDailySummary {
  date: string
  openingBalance: string | null
  incoming: string | null
  outgoing: string | null
  closingBalance: string | null
  currency: string
  syncedAt: string
  status?: 'complete' | 'partial'
  error?: string
}

export interface SberSyncProgress {
  from: string
  to: string
  day: string
  completedDays: number
  totalDays: number
  pages?: number
  nextAttemptAt?: string
}

export interface SberStatementsResult {
  account: string
  company: string
  inn: string
  days: SberDailySummary[]
  operations: SberOperation[]
  lastSuccessAt?: string
  lastError?: string
  lastCompletedPeriod?: { from: string; to: string }
  missing: string[]
  scheduleEnabled?: boolean
  progress?: SberSyncProgress
}

import Decimal from 'decimal.js'
import type { SettlementCompany } from './settlements-model'

// Amounts remain decimal strings; Number is used only for chart geometry.
export const OverviewDecimal = Decimal.clone({ precision: 512 })
export function overviewMoney(value: string | null | undefined, currency = '₽') {
  if (value == null) return 'Неизвестно'
  try {
    const parsed = new OverviewDecimal(value)
    if (!parsed.isFinite()) return 'Неизвестно'
    const [whole, fraction] = parsed.toFixed(2).split('.')
    return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')},${fraction}\u00a0${currency}`
  } catch { return 'Неизвестно' }
}
export function companyBalance(company: SettlementCompany) {
  return new OverviewDecimal(company.advance).minus(company.debt).toFixed(2)
}
export function signedMoney(value: string | null | undefined) {
  if (value == null) return overviewMoney(value)
  const amount = new OverviewDecimal(value)
  return `${amount.gt(0) ? '+' : amount.lt(0) ? '−' : ''}${overviewMoney(amount.abs().toFixed(2))}`
}
export const needsReview = (company: SettlementCompany) => company.issues.length > 0 || company.shipments.some(row => !!row.issue)
export const hasUnknownAmounts = (company: SettlementCompany) => company.shipments.some(row => row.amount === null || row.openingPaid === null || row.paid === null || row.debt === null)
export function dateMonth(value: string | null) {
  if (!value || !/^\d{4}-\d{2}-\d{2}/.test(value)) return null
  const month = Number(value.slice(5, 7))
  return month >= 1 && month <= 12 && !Number.isNaN(Date.parse(value)) ? value.slice(0, 7) : null
}
export type OverviewPeriod = '6' | '12' | 'all'
export interface OverviewMonth { month: string; incoming: string; shipped: string; receipts: number; shipments: number }
export function overviewMonths(companies: SettlementCompany[], period: OverviewPeriod, now = new Date()) {
  const grouped = new Map<string, OverviewMonth>()
  const getMonth = (month: string) => {
    let bucket = grouped.get(month)
    if (!bucket) {
      bucket = { month, incoming: '0.00', shipped: '0.00', receipts: 0, shipments: 0 }
      grouped.set(month, bucket)
    }
    return bucket
  }
  let undated = 0, unknown = 0
  for (const company of companies) {
    for (const receipt of company.receipts) {
      const month = dateMonth(receipt.date)
      if (!month) { undated++; continue }
      const bucket = getMonth(month)
      bucket.incoming = new OverviewDecimal(bucket.incoming).plus(receipt.amount).toFixed(2)
      bucket.receipts++
    }
    for (const shipment of company.shipments) {
      const month = dateMonth(shipment.date)
      if (!month) { undated++; continue }
      const bucket = getMonth(month)
      if (shipment.amount === null) unknown++
      else bucket.shipped = new OverviewDecimal(bucket.shipped).plus(shipment.amount).toFixed(2)
      bucket.shipments++
    }
  }
  const current = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit' }).format(now)
  const months = [...grouped.keys()].sort()
  const latest = months.length ? months[months.length - 1] : current
  // Anchor to the current month while retaining imported future-dated operations.
  const end = latest > current ? latest : current
  const endDate = new Date(`${end}-01T12:00:00Z`)
  const firstDate = new Date(endDate)
  firstDate.setUTCMonth(firstDate.getUTCMonth() - (period === '12' ? 11 : 5))
  const first = period === 'all' && months.length ? months[0] : firstDate.toISOString().slice(0, 7)
  const result: OverviewMonth[] = []
  const cursor = new Date(`${first}-01T12:00:00Z`)
  while (cursor <= endDate) {
    const month = cursor.toISOString().slice(0, 7)
    result.push(grouped.get(month) ?? { month, incoming: '0.00', shipped: '0.00', receipts: 0, shipments: 0 })
    cursor.setUTCMonth(cursor.getUTCMonth() + 1)
  }
  return { months: result, undated, unknown }
}

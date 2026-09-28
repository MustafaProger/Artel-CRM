import { OverviewDecimal as Exact, companyBalance } from './overview-model'
import type { SettlementCompany, SettlementReceipt, SettlementShipment } from './settlements-model'

export type OverviewSort = 'amount-desc' | 'amount-asc' | 'date-desc' | 'date-asc'
export type OverviewEntry =
  | { type: 'receipt'; date: string; item: SettlementReceipt }
  | { type: 'shipment'; date: string | null; item: SettlementShipment }

const timestamp = (value: string | null) => {
  if (!value) return null
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}
const magnitude = (value: string | null) => {
  if (value === null) return null
  try {
    const parsed = new Exact(value)
    return parsed.isFinite() ? parsed.abs() : null
  } catch { return null }
}
// Missing values stay at the end for either direction; ties use stable identity.
function compareNullable<T>(a: T | null, b: T | null, direction: number, compare: (a: T, b: T) => number) {
  if (a === null) return b === null ? 0 : 1
  if (b === null) return -1
  return direction * compare(a, b)
}
function latestOperation(company: SettlementCompany) {
  let latest: number | null = null
  for (const operation of [...company.shipments, ...company.receipts]) {
    const value = timestamp(operation.date)
    if (value !== null && (latest === null || value > latest)) latest = value
  }
  return latest
}
export function sortOverviewCompanies(companies: readonly SettlementCompany[], sort: OverviewSort) {
  const direction = sort.endsWith('asc') ? 1 : -1
  const rows = companies.map(company => ({ company, amount: magnitude(companyBalance(company)), date: latestOperation(company) }))
  rows.sort((a, b) => (sort.startsWith('amount')
    ? compareNullable(a.amount, b.amount, direction, (left, right) => left.cmp(right))
    : compareNullable(a.date, b.date, direction, (left, right) => left - right))
    || a.company.name.localeCompare(b.company.name, 'ru') || a.company.key.localeCompare(b.company.key, 'ru'))
  return rows.map(row => row.company)
}
export function sortOverviewEntries(entries: readonly OverviewEntry[], sort: OverviewSort) {
  const direction = sort.endsWith('asc') ? 1 : -1
  const rows = entries.map(entry => ({ entry, amount: magnitude(entry.item.amount), date: timestamp(entry.date) }))
  rows.sort((a, b) => (sort.startsWith('amount')
    ? compareNullable(a.amount, b.amount, direction, (left, right) => left.cmp(right))
    : compareNullable(a.date, b.date, direction, (left, right) => left - right))
    || a.entry.type.localeCompare(b.entry.type) || a.entry.item.id.localeCompare(b.entry.item.id))
  return rows.map(row => row.entry)
}

import Decimal from 'decimal.js'
import type { OperatorRefuelling, OperatorWorkspace } from './operator-model'
const D = Decimal.clone({precision: 60, rounding: Decimal.ROUND_HALF_UP})
export const reconciliationServiceId = (workspace: OperatorWorkspace, row: OperatorRefuelling) => row.schemaVersion !== undefined ? row.serviceId : workspace.services.find(service => service.name.trim().toLocaleLowerCase('ru') === row.service.trim().toLocaleLowerCase('ru'))?.id ?? `legacy:${row.service}`
export function reconciliationRows(workspace: OperatorWorkspace, date: string) {
  const services = new Map(workspace.services.map(service => [service.id, {id: service.id, name: service.name}]))
  const key = (row: OperatorRefuelling) => reconciliationServiceId(workspace, row)
  const operations = workspace.refuellings.filter(row => row.date === date && !row.deletedAt)
  for (const row of operations) if (!services.has(key(row))) services.set(key(row), {id: key(row), name: row.service})
  for (const record of workspace.reconciliations ?? []) if (record.date === date && !services.has(record.serviceId)) services.set(record.serviceId, {id: record.serviceId, name: record.service})
  return [...services.values()].map(service => {
    const rows = operations.filter(row => key(row) === service.id)
    const litres = rows.reduce((sum, row) => sum.plus(row.litres), new D(0)).toFixed()
    // Explicit business rule: add the saved service percentage to each recorded amount.
    const amount = rows.reduce((sum, row) => sum.plus(new D(row.amount).mul(new D(1).plus(new D(row.discountPercent).div(100))).toDecimalPlaces(2)), new D(0)).toFixed(2)
    const report = workspace.reconciliations?.find(row => row.date === date && row.serviceId === service.id)
    return {...service, rows, litres, amount, report, deltaLitres: report ? new D(litres).minus(report.litres).toFixed() : null, deltaAmount: report ? new D(amount).minus(report.amount).toFixed(2) : null}
  })
}

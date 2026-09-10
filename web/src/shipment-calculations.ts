import Decimal from 'decimal.js'
import type { CalculationRules, PaymentAllocation } from './model'
import { settlementKind } from './shipment-settlement'

const Exact = Decimal.clone({ precision: 80 })
export const TEMPLATE_PROFIT_RULE = 'template-payment-form' as const
export const decimal = (value: string | null | undefined) => {
  const text = value?.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!text || text.length > 200 || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text)) return null
  const parsed = new Exact(text)
  return parsed.isFinite() && Math.abs(parsed.e) <= 100 ? parsed : null
}
export const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date())
export function validDate(value?: string | null): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(value)) return null
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`)
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10) ? value.slice(0, 10) : null
}
export function overdueDays(due: string | null, paidDate: string | null, fullyPaid: boolean, asOf = today()): string | null {
  const end = validDate(fullyPaid ? paidDate : asOf), start = validDate(due)
  if (!end || !start) return null
  return String(Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 86400000)))
}
export function daysSinceShipment(date: string | null | undefined, asOf = today()): string | null {
  const start = validDate(date), end = validDate(asOf)
  return start && end ? String(Math.max(0, Math.round((Date.parse(end) - Date.parse(start)) / 86400000))) : null
}
export function unpaidShipmentDays(date: string | null | undefined, saleAmount: string | null | undefined, paidAmount: string | null | undefined, asOf = today()): string | null {
  const sale = decimal(saleAmount), paid = decimal(paidAmount)
  return sale && paid && paid.gte(sale) ? null : daysSinceShipment(date, asOf)
}
/** One calculation path for the editor and API. Unknown business rules stay explicit. */
export function calculateShipment(input: Record<string, string | null>, rules: CalculationRules, options: {
  historical?: boolean; recalculate?: boolean; changedFields?: string[]; allocations?: PaymentAllocation[]; asOf?: string;
} = {}) {
  const fields = { ...input }, warnings: string[] = []
  const value = (key: string) => decimal(fields[key])
  const date = validDate(fields.date)
  fields.month = date ? date.slice(0, 7) : null
  const affected = (keys: string[]) => !options.historical || (options.changedFields ? keys.some(k => options.changedFields!.includes(k)) : !!options.recalculate)
  const saleChanged = affected(['quantity_litres','quantity_tonnes','sale_price_per_litre'])
  const purchaseChanged = affected(['quantity_litres','quantity_tonnes','purchase_price_unspecified_unit','purchase_unit'])
  if (!options.historical || options.recalculate) {
    const litres = value('quantity_litres'), tonnes = value('quantity_tonnes'), salePrice = value('sale_price_per_litre')
    const quantity = rules.sale === 'litres' ? litres : rules.sale === 'tonnes' ? tonnes : null
    if (saleChanged) fields.customer_amount = quantity && salePrice ? quantity.times(salePrice).toFixed() : null
    if (saleChanged) fields.sale_price_per_tonne = tonnes?.gt(0) && decimal(fields.customer_amount) ? decimal(fields.customer_amount)!.div(tonnes).toFixed() : null
    const purchaseQuantity = rules.purchase === 'litres' ? litres : rules.purchase === 'tonnes' ? tonnes : null
    if (purchaseChanged) fields.purchase_amount = purchaseQuantity && value('purchase_price_unspecified_unit') ? purchaseQuantity.times(value('purchase_price_unspecified_unit')!).toFixed() : null
    if (!rules.purchase) warnings.push('Выберите единицу цены закупки: за тонну или за литр.')
    if (!rules.sale) warnings.push('Для этой исходной операции требуется уточнить формулу продажи.')
    const sale = value('customer_amount'), purchase = value('purchase_amount')
    fields.profit_source = null
    if (!rules.profit) warnings.push('Правило прибыли ещё не подтверждено.')
    else if (rules.profit === TEMPLATE_PROFIT_RULE) {
      const settlement = settlementKind(fields.payment_form)
      if (settlement === 'unspecified') warnings.push('Для расчёта прибыли выберите форму оплаты: б/нал, нал или ф2.')
      else if (sale && purchase) {
        const transport = value('transport_amount') ?? new Exact(0)
        // The template has one expense field. Legacy KVP supplies its initial value,
        // but is never subtracted again when explicit additional costs are present.
        const expenses = value('additional_costs') ?? value('kvp_source') ?? new Exact(0)
        const adjusted = settlement === 'cash' ? purchase.times('0.83') : purchase
        fields.profit_source = sale.minus(adjusted).minus(transport).minus(expenses).toFixed()
      }
    } else if (sale && purchase) {
      const transport = value('transport_amount') ?? new Exact(0), extra = value('additional_costs') ?? new Exact(0), kvp = value('kvp_source') ?? new Exact(0)
      const adjusted = rules.profit !== 'simple' && purchase.gt(sale) ? purchase.times('0.83') : purchase
      const legacyKvp = rules.profit === 'simple' || rules.profit === 'excel-legacy' && purchase.gt(sale) ? new Exact(0) : kvp
      const profit = sale.minus(adjusted).minus(transport).minus(extra).minus(legacyKvp)
      fields.profit_source = rules.profit === 'excel-rounded' ? profit.toDecimalPlaces(0, Decimal.ROUND_HALF_UP).toFixed() : profit.toFixed()
    }
  }
  // Unmapped bank rows never count as payments for a shipment. Legacy paid values
  // remain the opening amount until a separate reconciliation migrates them.
  const allocations = options.allocations ?? []
  const openingPaid = options.historical ? decimal(Object.hasOwn(input,'opening_paid_amount') ? input.opening_paid_amount : input.paid_amount_source) : new Exact(0)
  if (options.historical) {
    fields.opening_paid_amount = openingPaid?.toFixed() ?? null
    fields.opening_payment_date = Object.hasOwn(input,'opening_payment_date') ? input.opening_payment_date : input.payment_date ?? null
  }
  const paid = openingPaid ? allocations.reduce((sum, row) => sum.plus(row.amount), openingPaid) : null
  if (!options.historical || allocations.length) fields.paid_amount_source = paid?.toFixed() ?? null
  if (allocations.length) fields.payment_date = [validDate(input.payment_date), ...allocations.map(a => a.date)].filter((x): x is string => !!x).sort().at(-1) ?? null
  if (!options.historical || saleChanged || allocations.length) {
    fields.debt_overpayment_source = paid && value('customer_amount') ? paid.minus(value('customer_amount')!).toFixed() : null
  }
  const saleAmount = value('customer_amount')
  let settlementDate = options.historical && openingPaid && saleAmount && openingPaid.gte(saleAmount) ? fields.opening_payment_date : fields.payment_date
  if (paid && value('customer_amount') && allocations.length && openingPaid) {
    let running = openingPaid
    for (const allocation of [...allocations].sort((a,b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
      const before = running; running = running.plus(allocation.amount)
      if (before.lt(value('customer_amount')!) && running.gte(value('customer_amount')!)) {settlementDate = allocation.date; break}
    }
  }
  fields.overdue_days = paid && saleAmount ? overdueDays(fields.payment_due_date, settlementDate, paid.gte(saleAmount), options.asOf) : null
  fields.days_since_shipment = unpaidShipmentDays(date, fields.customer_amount, fields.paid_amount_source, options.asOf)
  return { fields, warnings }
}

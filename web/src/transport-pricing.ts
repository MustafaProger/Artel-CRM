import Decimal from 'decimal.js'
import type { OilDepot, ShipmentAddress, Vehicle } from './model'

export type TransportRounding = 'nearest100' | 'ceil100'
export interface TransportPricingSettings {
  version: number
  ratePerKmRub: string
  customerSurchargeRub: string
  rounding: TransportRounding
}
export interface TransportPriceSnapshot {
  schemaVersion: 1
  vehicleId: string
  oilDepotId: string
  customerId: string
  addressId: string
  vehicleLabel: string
  oilDepotLabel: string
  addressLabel: string
  settingsVersion: number
  sections: { index: number; litres: string; priceRub: string }[]
  sectionsTotalRub: string
  distanceKm: string
  ratePerKmRub: string
  distanceTotalRub: string
  customerSurchargeRub: string
  subtotalRub: string
  rounding: TransportRounding
  roundingAdjustmentRub: string
  totalRub: string
}
const Exact = Decimal.clone({ precision: 64 })
export const validTransportMoney = (value: unknown): value is string => typeof value === 'string' && /^\d{1,9}(?:\.\d{1,2})?$/.test(value)
export function validTransportPricing(value: unknown): value is TransportPricingSettings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const row = value as Record<string, unknown>
  return Object.keys(row).every(key => ['version', 'ratePerKmRub', 'customerSurchargeRub', 'rounding'].includes(key)) && Number.isSafeInteger(row.version) && Number(row.version) >= 0 && validTransportMoney(row.ratePerKmRub) && validTransportMoney(row.customerSurchargeRub) && ['nearest100', 'ceil100'].includes(String(row.rounding))
}
export function readTransportPricing(value?: TransportPricingSettings): TransportPricingSettings {
  return value ?? { version: 0, ratePerKmRub: '45', customerSurchargeRub: '1750', rounding: 'nearest100' }
}
export function readTransportSectionIndexes(value: string | null | undefined): number[] {
  if (!value) return []
  const parsed: unknown = JSON.parse(value)
  if (!Array.isArray(parsed) || parsed.length > 20 || parsed.some(index => !Number.isSafeInteger(index) || index < 0 || index >= 20) || new Set(parsed).size !== parsed.length) throw new Error('Выберите секции автомобиля без повторений.')
  return parsed.sort((left, right) => left - right)
}
export function validateTransportSectionAssignments(customers: { compartmentIndexes: number[] }[]): string[] {
  const selected = new Set<number>(), repeated = new Set<number>()
  for (const customer of customers) for (const index of customer.compartmentIndexes) {
    if (selected.has(index)) repeated.add(index)
    selected.add(index)
  }
  return repeated.size ? [`Секции ${[...repeated].sort((a, b) => a - b).map(index => index + 1).join(', ')} назначены нескольким доставкам. Укажите отдельные секции или введите сумму вручную: распределение одной секции не задано.`] : []
}
/** Kilometres belong to the selected directory location, not a request override. */
export function transportAddressMatches(address: Pick<ShipmentAddress, 'address' | 'name' | 'latitude' | 'longitude'> | undefined, actual: { address?: string | null; latitude?: string | null; longitude?: string | null; locationSnapshot?: { source: string } } | undefined): boolean {
  if (!address || !actual) return true
  const normalized = (value: string) => value.trim().replace(/\s+/g, ' ')
  if (actual.address && normalized(actual.address) !== normalized(address.address || address.name)) return false
  if (actual.latitude || actual.longitude) {
    if (address.latitude || address.longitude) return Number(actual.latitude) === Number(address.latitude) && Number(actual.longitude) === Number(address.longitude)
    if (actual.locationSnapshot?.source !== 'geocoder') return false
  }
  return true
}
export function calculateTransportPrice({ vehicle, address, oilDepot, customerId, compartmentIndexes, quantityLitres, settings = readTransportPricing() }: {
  vehicle?: Vehicle
  address?: ShipmentAddress
  oilDepot?: OilDepot
  customerId?: string | null
  compartmentIndexes: number[]
  quantityLitres?: string
  settings?: TransportPricingSettings
}): { ok: true; snapshot: TransportPriceSnapshot } | { ok: false; errors: string[] } {
  const errors: string[] = []
  if (!vehicle) errors.push('Выберите автомобиль.')
  else if (!vehicle.compartmentsLitres?.length) errors.push('Укажите секции в карточке автомобиля.')
  else if (!vehicle.compartmentDeparturePricesRub || vehicle.compartmentDeparturePricesRub.length !== vehicle.compartmentsLitres.length || !vehicle.compartmentDeparturePricesRub.every(validTransportMoney)) errors.push('Укажите стоимость выезда каждой секции в карточке автомобиля.')
  if (!customerId) errors.push('Выберите клиента.')
  if (!address || address.kind !== 'delivery' || address.companyId !== customerId) errors.push('Выберите адрес доставки этого клиента.')
  if (!oilDepot) errors.push('Выберите нефтебазу.')
  const distanceKm = address?.oilDepotDistancesKm?.[oilDepot?.id ?? '']
  if (address && oilDepot && (distanceKm === undefined || !/^\d+(?:\.\d+)?$/.test(distanceKm) || new Exact(distanceKm).gt(100000))) errors.push('Укажите расстояние от выбранной нефтебазы до этого адреса клиента.')
  if (!compartmentIndexes.length) errors.push('Назначьте секции автомобиля этой доставке.')
  else if (new Set(compartmentIndexes).size !== compartmentIndexes.length || compartmentIndexes.some(index => !Number.isSafeInteger(index) || index < 0 || index >= (vehicle?.compartmentsLitres?.length ?? 0))) errors.push('Проверьте выбранные секции автомобиля.')
  if (vehicle?.compartmentsLitres?.length && compartmentIndexes.length && compartmentIndexes.every(index => Number.isSafeInteger(index) && index >= 0 && index < vehicle.compartmentsLitres!.length)) {
    const assignedLitres = compartmentIndexes.reduce((sum, index) => sum.plus(vehicle.compartmentsLitres![index]), new Exact(0))
    const litres = quantityLitres?.replace(/\s/g, '').replace(',', '.')
    if (!litres || !/^\d{1,12}(?:\.\d{1,6})?$/.test(litres) || !assignedLitres.eq(litres)) errors.push('Для автоматического расчёта литры клиента должны совпадать с объёмом назначенных полных секций. Частичная загрузка или разделение секции требуют ручной суммы.')
  }
  if (!validTransportPricing(settings)) errors.push('Проверьте общие тарифы перевозки.')
  if (errors.length) return { ok: false, errors }
  const sections = [...compartmentIndexes].sort((a, b) => a - b).map(index => ({ index, litres: vehicle!.compartmentsLitres![index], priceRub: vehicle!.compartmentDeparturePricesRub![index] }))
  const sectionsTotal = sections.reduce((sum, section) => sum.plus(section.priceRub), new Exact(0))
  const distanceTotal = new Exact(distanceKm!).times(settings.ratePerKmRub)
  const subtotal = sectionsTotal.plus(distanceTotal).plus(settings.customerSurchargeRub)
  const total = subtotal.div(100).toDecimalPlaces(0, settings.rounding === 'ceil100' ? Decimal.ROUND_CEIL : Decimal.ROUND_HALF_UP).times(100)
  return { ok: true, snapshot: {
    schemaVersion: 1, vehicleId: vehicle!.id, oilDepotId: oilDepot!.id, customerId: customerId!, addressId: address!.id,
    vehicleLabel: (vehicle!.name || vehicle!.plate).slice(0, 120), oilDepotLabel: oilDepot!.name.slice(0, 120), addressLabel: (address!.address || address!.name).slice(0, 120), settingsVersion: settings.version,
    sections, sectionsTotalRub: sectionsTotal.toFixed(), distanceKm: distanceKm!, ratePerKmRub: settings.ratePerKmRub, distanceTotalRub: distanceTotal.toFixed(), customerSurchargeRub: settings.customerSurchargeRub,
    subtotalRub: subtotal.toFixed(), rounding: settings.rounding, roundingAdjustmentRub: total.minus(subtotal).toFixed(), totalRub: total.toFixed(),
  } }
}
export function readTransportPriceSnapshot(value: string | null | undefined): TransportPriceSnapshot | null {
  if (!value || value.length > 8000) return null
  try {
    const result = JSON.parse(value) as TransportPriceSnapshot
    const unsigned = (v: unknown): v is string => typeof v === 'string' && /^\d{1,18}(?:\.\d{1,12})?$/.test(v)
    if (!result || result.schemaVersion !== 1 || !Array.isArray(result.sections) || !result.sections.length || result.sections.length > 20 || !result.sections.every(row => row && Number.isSafeInteger(row.index) && row.index >= 0 && row.index < 20 && unsigned(row.litres) && new Exact(row.litres).gt(0) && validTransportMoney(row.priceRub)) || new Set(result.sections.map(row => row.index)).size !== result.sections.length || !['nearest100', 'ceil100'].includes(result.rounding)) return null
    for (const key of ['vehicleId', 'oilDepotId', 'customerId', 'addressId', 'vehicleLabel', 'oilDepotLabel', 'addressLabel'] as const) if (typeof result[key] !== 'string' || !result[key] || result[key].length > 500) return null
    if (!Number.isSafeInteger(result.settingsVersion) || result.settingsVersion < 0 || !validTransportMoney(result.ratePerKmRub) || !validTransportMoney(result.customerSurchargeRub)) return null
    for (const key of ['sectionsTotalRub', 'distanceKm', 'distanceTotalRub', 'subtotalRub', 'totalRub'] as const) if (!unsigned(result[key])) return null
    if (!/^-?\d{1,18}(?:\.\d{1,12})?$/.test(result.roundingAdjustmentRub) || new Exact(result.distanceKm).gt(100000)) return null
    const sections = result.sections.reduce((sum, row) => sum.plus(row.priceRub), new Exact(0))
    const distance = new Exact(result.distanceKm).times(result.ratePerKmRub)
    const subtotal = sections.plus(distance).plus(result.customerSurchargeRub)
    const total = subtotal.div(100).toDecimalPlaces(0, result.rounding === 'ceil100' ? Decimal.ROUND_CEIL : Decimal.ROUND_HALF_UP).times(100)
    if (!sections.eq(result.sectionsTotalRub) || !distance.eq(result.distanceTotalRub) || !subtotal.eq(result.subtotalRub) || !total.eq(result.totalRub) || !total.minus(subtotal).eq(result.roundingAdjustmentRub)) return null
    return result
  } catch { return null }
}

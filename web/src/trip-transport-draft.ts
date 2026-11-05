import type { Directories, ShipmentAddress } from './model'
import { calculateTransportPrice, readTransportPriceSnapshot, readTransportSectionIndexes, transportAddressMatches, type TransportPriceSnapshot } from './transport-pricing'

export interface TransportCustomerDraft {
  key: string
  fields: Record<string, string>
  /** Only a new row or an explicit recalculation uses today's directory values. */
  pricingLive?: boolean
  pricingNotice?: string
  pricingLocation?: Parameters<typeof transportAddressMatches>[1]
}

export interface TripTransportState {
  automatic: boolean
  frozen: boolean
  indexes: number[]
  snapshot: TransportPriceSnapshot | null
  errors: string[]
  fields: Record<string, string>
}

export function tripTransportStates(shared: Record<string, string>, customers: TransportCustomerDraft[], directories: Directories, addresses: ShipmentAddress[], original?: { fields: Record<string, string>; customers: TransportCustomerDraft[] }): Map<string, TripTransportState> {
  const parsed = customers.map(customer => {
    try { return { customer, indexes: readTransportSectionIndexes(customer.fields.transport_section_indexes), errors: [] as string[] } }
    catch { return { customer, indexes: [], errors: ['Проверьте назначение секций автомобиля.'] } }
  })
  return new Map(parsed.map(({ customer, indexes, errors: parsingErrors }) => {
    const automatic = customer.fields.transport_pricing_mode === 'auto'
    const frozen = automatic && !customer.pricingLive
    const duplicates = indexes.filter(index => parsed.some(other => other.customer.key !== customer.key && other.indexes.includes(index)))
    const repeatedCustomer = !!customer.fields.customer_id && customers.some(other => other.key !== customer.key && other.fields.customer_id === customer.fields.customer_id)
    const errors = [...parsingErrors, ...(duplicates.length ? [`Секции ${duplicates.map(index => index + 1).join(', ')} назначены нескольким доставкам. Распределение общей секции не задано; укажите отдельные секции или сумму вручную.`] : []), ...(repeatedCustomer ? ['Один клиент выбран в нескольких доставках. Правило доплаты и расстояния для такого случая не задано; укажите суммы вручную.'] : [])]
    let snapshot: TransportPriceSnapshot | null = null
    if (frozen) {
      snapshot = readTransportPriceSnapshot(customer.fields.transport_price_snapshot)
      if (!snapshot) errors.push('Сохранённая расшифровка недоступна. Проверьте сумму вручную или рассчитайте её заново.')
    } else if (automatic) {
      const address = addresses.find(address => address.id === customer.fields.unloading_address_id)
      const oilDepot = directories.oilDepots?.find(depot => depot.id === shared.oil_depot_id)
      // The API preserves saved route snapshots whenever the final IDs match,
      // including after the user selects another location and switches back.
      const savedCustomer = original?.customers.find(row => row.key === customer.key)
      const actualFields = savedCustomer?.fields.unloading_address_id === customer.fields.unloading_address_id ? savedCustomer.fields : customer.fields
      const actualLocation = customer.pricingLocation ?? (actualFields.unloading_address || actualFields.unloading_latitude || actualFields.unloading_longitude ? { address: actualFields.unloading_address, latitude: actualFields.unloading_latitude, longitude: actualFields.unloading_longitude } : undefined)
      if (!transportAddressMatches(address, actualLocation)) errors.push('Адрес или точка доставки отличаются от справочника либо происхождение точки не подтверждено. Расстояние для этого места не подтверждено; укажите сумму вручную.')
      const loadingFields = original?.fields.oil_depot_id === shared.oil_depot_id ? original.fields : shared
      const actualLoading = loadingFields.loading_address || loadingFields.loading_latitude || loadingFields.loading_longitude ? { address: loadingFields.loading_address, latitude: loadingFields.loading_latitude, longitude: loadingFields.loading_longitude } : undefined
      if (!transportAddressMatches(oilDepot, actualLoading)) errors.push('Сохранённое место погрузки отличается от текущей нефтебазы в справочнике. Расстояние для этого маршрута не подтверждено; укажите сумму вручную.')
      const calculation = calculateTransportPrice({
        vehicle: directories.vehicles.find(vehicle => vehicle.id === shared.vehicle_id),
        oilDepot,
        address,
        customerId: customer.fields.customer_id,
        quantityLitres: customer.fields.quantity_litres,
        compartmentIndexes: indexes,
        settings: directories.transportPricing,
      })
      if (calculation.ok) snapshot = calculation.snapshot
      else errors.push(...calculation.errors)
    }
    if (!frozen && errors.length) snapshot = null
    const fields = automatic && !frozen ? {
      ...customer.fields,
      transport_amount: snapshot?.totalRub ?? '',
      transport_price_snapshot: snapshot ? JSON.stringify(snapshot) : '',
    } : customer.fields
    return [customer.key, { automatic, frozen, indexes, snapshot, errors, fields }]
  }))
}

/** Editing the route of a saved calculation preserves its amount for review. */
export function changedTransportContext<T extends TransportCustomerDraft>(customer: T, resetSections = false): T {
  const frozen = customer.fields.transport_pricing_mode === 'auto' && !customer.pricingLive
  return {
    ...customer,
    ...(frozen ? { pricingNotice: 'Исходные данные изменены. Сохранённая сумма оставлена вручную; для нового расчёта нажмите «Рассчитать автоматически».' } : {}),
    fields: {
      ...customer.fields,
      ...(resetSections ? { transport_section_indexes: '' } : {}),
      ...(frozen ? { transport_pricing_mode: 'manual', transport_price_snapshot: '' } : {}),
    },
  }
}

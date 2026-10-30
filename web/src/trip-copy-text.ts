import Decimal from 'decimal.js'
import type { DirectoryData, ShipmentTrip } from './model'
import { mapLink } from './map-link'

const line = (value: string | null | undefined, fallback: string) => value?.replace(/\s+/gu, ' ').trim() || fallback

function amount(value: string | null | undefined, fixed = false): string {
  if (!value?.trim()) return '—'
  try {
    const parsed = new Decimal(value.replace(/\s/gu, '').replace(',', '.'))
    if (!parsed.isFinite()) return '—'
    return (fixed ? parsed.toFixed(2) : parsed.toFixed()).replace('.', ',')
  } catch { return '—' }
}

/** Copy the saved trip values, preserving delivery order and explicit zeroes. */
export function tripCopyText(trip: ShipmentTrip, data: DirectoryData): string {
  const fields = trip.fields
  const date = fields.date?.match(/^\d{4}-(\d{2})-(\d{2})(?:$|T)/)
  const company = (id: string | null | undefined, fallback: string) => line(data.companies.find(row => row.id === id)?.name, fallback)
  return [
    date ? `${date[2]}.${date[1]}` : 'Дата не указана',
    `${company(fields.supplier_id, 'Поставщик не указан')} ${amount(fields.purchase_price_unspecified_unit)}`,
    line(data.directories?.products.find(row => row.id === fields.product_id)?.name, 'Товар не указан'),
    ...trip.customers.map(({ fields: delivery }) => `${amount(delivery.quantity_litres)} л ${company(delivery.customer_id, 'Контрагент не указан')} ${amount(delivery.sale_price_per_litre, true)}`),
    `${line(data.directories?.drivers.find(row => row.id === fields.driver_id)?.name, 'Водитель не указан')} ${trip.customers.map(row => amount(row.fields.transport_amount)).join('+') || '—'}`,
  ].join('\n')
}

/** Driver handoff deliberately contains no prices or delivery fees. */
export function tripDriverCopyText(trip: ShipmentTrip, data: DirectoryData): string {
  const depot = data.directories?.oilDepots?.find(row => row.id === trip.fields.oil_depot_id)
  const supplier = data.companies.find(row => row.id === trip.fields.supplier_id)
  const deliveries = trip.customers.map(({ fields }) => {
    const customer = data.companies.find(row => row.id === fields.customer_id)
    const place = data.directories?.addresses.find(row => row.id === fields.unloading_address_id && row.companyId === fields.customer_id && row.kind === 'delivery')
    // Saved destination wins over subsequent edits to the address directory.
    const hasSavedAddress = !!fields.unloading_address?.trim()
    const address = hasSavedAddress ? fields.unloading_address : place?.address
    const link = mapLink({
      mapUrl: fields.unloading_map_url || (!hasSavedAddress ? place?.mapUrl : null),
      latitude: fields.unloading_latitude || (!hasSavedAddress ? place?.latitude : null),
      longitude: fields.unloading_longitude || (!hasSavedAddress ? place?.longitude : null),
      address,
    })
    return [
      `${line(customer?.name, 'Контрагент не указан')} ${amount(fields.quantity_litres)} л`,
      line(address, 'Адрес не указан'),
      link ? `${link.label === 'Найти адрес в Яндекс.Картах' ? 'Яндекс (поиск адреса): ' : ''}${link.href}` : 'Ссылка Яндекса не указана',
      ...[{name:place?.receiverName,phone:place?.receiverPhone},...(place?.additionalReceivers??[])].map(contact=>`${line(contact.name, 'Приёмщик')} ${line(contact.phone, 'телефон не указан')}`),
    ].join('\n')
  })
  return [`Погрузка на ${line(depot?.name, 'нефтебаза не указана')} от ${line(supplier?.name, 'поставщик не указан')}`, ...deliveries].join('\n\n')
}

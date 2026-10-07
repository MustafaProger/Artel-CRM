import Decimal from 'decimal.js'

export type DriverDelivery = {
  id: string; number: string | null; customer: string | null; product: string | null; liters: string | null
  address: string | null; mapUrl: string | null; actualAt: string | null; notes: string | null; netTonnes: string | null
}
export type DriverTrip = {
  id: string; date: string | null; driverName: string; vehiclePlate: string | null; supplier: string | null
  loadingAddress: string | null; loadingMapUrl: string | null; loadingActualAt: string | null; notes: string | null
  deliveries: DriverDelivery[]; flowVersion: 'driver-v1' | null; versions: Record<string, number>
  archived: boolean; arrivedAt: string | null; departedAt: string | null
}

export const driverVersionKey = (versions: Record<string, number>) => JSON.stringify(Object.entries(versions).sort(([a], [b]) => a.localeCompare(b)))

export function normalizeDriverMass(raw: string) {
  const value = raw.trim().replace(/\s/g, '').replace(',', '.')
  if (!/^(?:\d+(?:\.\d{1,6})?|\.\d{1,6})$/.test(value) || value.length > 40) return null
  const amount = new Decimal(value)
  return amount.isFinite() && amount.gt(0) && amount.lt('100000000000') ? amount.toFixed() : null
}

export function driverDateTimeLabel(value: string) {
  // Historical local timestamps were entered in Moscow. New events carry an
  // explicit server timezone; neither form is interpreted in the device zone.
  const timestamp = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value) ? `${value}+03:00` : value
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})$/.test(timestamp)) return 'Время не подтверждено'
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? 'Время не подтверждено' : `${date.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' })} МСК`
}

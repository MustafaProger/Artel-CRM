import Decimal from 'decimal.js'
import type { TripRequest } from './trip-request-model'
import type { MapPoint } from './trip-map-view'

// API quantities allow up to 40 characters; keep the whole sum without changing
// Decimal's global configuration used by financial calculations elsewhere.
const MapDecimal = Decimal.clone({ precision: 100 })

export const requestVolumeBands = [
  { id: 'blue', label: 'Менее 2 000 л', upper: 2000 },
  { id: 'green', label: '2 000 – 6 000 л', upper: 6000 },
  { id: 'yellow', label: '6 000 – 11 000 л', upper: 11000 },
  { id: 'red', label: '11 000 – 14 000 л', upper: 14000 },
  { id: 'burgundy', label: 'От 14 000 л', upper: null },
] as const

export function requestVolumeBand(litres: string) {
  const value = new MapDecimal(litres)
  return requestVolumeBands.find(band => band.upper === null || value.lt(band.upper))!
}

export type RequestLocationGroup = { coordinates: MapPoint; requests: TripRequest[]; totalLitres: string }

/** Sum exact decimal quantities before classifying a shared geographical point. */
export function groupRequestsByLocation(locations: readonly { request: TripRequest; coordinates: MapPoint | null }[]) {
  const groups = new Map<string, RequestLocationGroup>()
  for (const { request, coordinates } of locations) {
    if (!coordinates) continue
    const key = coordinates.join(',')
    const group = groups.get(key) ?? { coordinates, requests: [], totalLitres: '0' }
    group.requests.push(request)
    group.totalLitres = new MapDecimal(group.totalLitres).plus(request.quantityLitres).toFixed()
    groups.set(key, group)
  }
  return groups
}

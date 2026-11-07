import { useEffect, useMemo, useState } from 'react'
import type { TripRequest } from './trip-request-model'
import type { OilDepot, ShipmentAddress } from './model'
import type { TripRequestLocationResult } from './trip-request-map-coordinates'
import { createLocationReadPool, pollTripRequestLocation } from './trip-request-location-poll'
import { apiFetch, apiUrl } from './workspace-api'

export type LocationState = TripRequestLocationResult | { status: 'loading' }
type Identity = { requestId: string; version: number } | { companyId: string; addressId: string; version: number } | { oilDepotId: string; version: number }
export type LocationTarget = { key: string; identity: Identity; initialLocation?: TripRequestLocationResult }
const cache = new Map<string, { result: TripRequestLocationResult; expires: number }>()
const pending = createLocationReadPool<TripRequestLocationResult>()
let consumers = 0
const unavailable: TripRequestLocationResult = { status: 'unavailable', message: 'Поиск адреса временно недоступен.' }

export function requestLocationTarget(request: TripRequest): LocationTarget {
  return { key: JSON.stringify([apiUrl('/api/trip-requests/geocode'), request.id, request.version, request.companyId, request.addressId, request.address, request.latitude, request.longitude, request.mapUrl]), identity: { requestId: request.id, version: request.version }, initialLocation: request.location }
}
export function directoryLocationTarget(address: ShipmentAddress): LocationTarget {
  return { key: JSON.stringify([apiUrl('/api/trip-requests/geocode'), address]), identity: { companyId: address.companyId, addressId: address.id, version: address.version ?? 0 }, initialLocation: address.location }
}
export function oilDepotLocationTarget(depot: OilDepot): LocationTarget {
  return { key: JSON.stringify([apiUrl('/api/trip-requests/geocode'), 'oil-depot', depot.id, depot.version, depot.address, depot.latitude, depot.longitude, depot.mapUrl]), identity: { oilDepotId: depot.id, version: depot.version ?? 0 } }
}
function cached(key: string) {
  const item = cache.get(key)
  if (item && item.expires > Date.now()) return item.result
  cache.delete(key)
}
async function resolveLocation(target: LocationTarget, owner: symbol, retry = false): Promise<TripRequestLocationResult> {
  const known = cached(target.key) ?? (target.initialLocation?.status !== 'pending' ? target.initialLocation : undefined)
  if (known) return known
  try { return await pending.acquire(target.key, owner, async controller => {
    let result = unavailable
    try {
      let firstRead = true
      result = await pollTripRequestLocation(async fingerprint => {
        const explicitRetry = firstRead && retry
        firstRead = false
        const timeout = setTimeout(() => controller.abort(), 20_000)
        try {
          const response = await apiFetch('/api/trip-requests/geocode', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...target.identity, ...(fingerprint ? { fingerprint } : {}), ...(explicitRetry ? { retry: true } : {}) }), signal: controller.signal })
          if (!response.ok) throw new Error('Location unavailable')
          const value = await response.json() as TripRequestLocationResult
          if (value.status === 'found' && Number.isFinite(value.latitude) && Math.abs(value.latitude) <= 90 && Number.isFinite(value.longitude) && Math.abs(value.longitude) <= 180 || ['not_found', 'ambiguous', 'unavailable', 'pending'].includes(value.status)) return value
          return unavailable
        } finally { clearTimeout(timeout) }
      }, controller.signal)
    } catch { /* Network/authentication failures are separate from a missing address. */ }
    if (!controller.signal.aborted && consumers) {
      cache.set(target.key, { result, expires: Date.now() + 60_000 })
      while (cache.size > 128) cache.delete(cache.keys().next().value!)
    }
    return result
  }) } catch { return unavailable }
}

/** Initial API projections render synchronously. Pending jobs are observed only while mounted. */
export function useTripRequestLocations(input: readonly LocationTarget[]) {
  const signature = JSON.stringify(input)
  const targets = useMemo(() => JSON.parse(signature) as LocationTarget[], [signature])
  const [results, setResults] = useState<Record<string, TripRequestLocationResult>>({})
  const [revision, setRevision] = useState(0)
  const [retried, setRetried] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    consumers++
    return () => {
      consumers--
      if (!consumers) { cache.clear(); pending.clear() }
    }
  }, [])
  useEffect(() => {
    let disposed = false, next = 0
    const owner = Symbol('location-effect'), acquired = new Set<string>()
    const worker = async () => {
      while (!disposed && next < targets.length) {
        const target = targets[next++]
        acquired.add(target.key)
        const result = await resolveLocation(retried.has(target.key) ? { ...target, initialLocation: undefined } : target, owner, retried.has(target.key))
        if (!disposed) setResults(previous => ({ ...previous, [target.key]: result }))
      }
    }
    void Promise.all(Array.from({ length: Math.min(3, targets.length) }, worker))
    return () => { disposed = true; for (const key of acquired) pending.release(key, owner) }
  }, [targets, revision, retried])
  const states = useMemo(() => new Map(targets.map(target => [target.key, results[target.key] ?? cached(target.key) ?? (!retried.has(target.key) ? target.initialLocation : undefined) ?? { status: 'loading' as const }])), [targets, results, retried])
  const retry = (target: LocationTarget) => {
    cache.delete(target.key)
    setRetried(previous => new Set(previous).add(target.key))
    setResults(previous => { const next = { ...previous }; delete next[target.key]; return next })
    setRevision(value => value + 1)
  }
  return { states, retry }
}

export function locationStatusText(state: LocationState): string {
  if (state.status === 'loading' || state.status === 'pending') return 'Ищем адрес…'
  if (state.status === 'found') return state.accuracy === 'street' ? 'Найдена улица — уточните точку доставки' : 'Найдено по адресу'
  if (state.status === 'not_found') return 'Адрес не найден — уточните адрес доставки'
  if (state.status === 'ambiguous') return 'Не удалось точно определить место — уточните адрес доставки'
  return 'Поиск адреса временно недоступен'
}

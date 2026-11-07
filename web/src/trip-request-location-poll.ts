import type { TripRequestLocationResult } from './trip-request-map-coordinates'

function waitForLocation(milliseconds: number, signal: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const aborted = () => { clearTimeout(timer); reject(signal.reason) }
    const timer = setTimeout(() => { signal.removeEventListener('abort', aborted); resolve() }, milliseconds)
    if (signal.aborted) aborted()
    else signal.addEventListener('abort', aborted, { once: true })
  })
}

/** Poll only a server-reported pending job. Each read rejoins it; no provider retry is requested.
 * The fingerprint binds every round to the original address/version. Unmount aborts the wait.
 */
export async function pollTripRequestLocation(
  read: (fingerprint?: string) => Promise<TripRequestLocationResult>,
  signal: AbortSignal,
  wait: (milliseconds: number, signal: AbortSignal) => Promise<void> = waitForLocation,
): Promise<TripRequestLocationResult> {
  let fingerprint: string | undefined
  while (!signal.aborted) {
    const result = await read(fingerprint)
    if (signal.aborted) throw signal.reason
    if (result.status !== 'pending') return result
    fingerprint = result.fingerprint ?? fingerprint
    await wait(2500, signal)
  }
  throw signal.reason
}

/** A target can be shared by several maps/forms. Dropping its last owner cancels only that target. */
export function createLocationReadPool<T>() {
  const entries = new Map<string, { controller: AbortController; promise: Promise<T>; owners: Set<symbol> }>()
  return {
    acquire(key: string, owner: symbol, start: (controller: AbortController) => Promise<T>): Promise<T> {
      const previous = entries.get(key)
      if (previous) { previous.owners.add(owner); return previous.promise }
      const controller = new AbortController()
      const promise = Promise.resolve().then(() => {
        if (controller.signal.aborted) throw controller.signal.reason
        return start(controller)
      }).finally(() => { if (entries.get(key)?.promise === promise) entries.delete(key) })
      entries.set(key, { controller, promise, owners: new Set([owner]) })
      return promise
    },
    release(key: string, owner: symbol) {
      const entry = entries.get(key)
      if (!entry) return
      entry.owners.delete(owner)
      if (!entry.owners.size) { entry.controller.abort(); entries.delete(key) }
    },
    clear() {
      for (const entry of entries.values()) entry.controller.abort()
      entries.clear()
    },
  }
}

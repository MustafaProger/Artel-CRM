import type { DirectoryData } from './model'

/** Separate entry points keep their API and session namespaces independent. */
export const isLogisticsWorkspace = () => typeof window !== 'undefined' && /^\/logistics(?:\/|$)/.test(window.location.pathname)

export function apiUrl(url: string): string {
  return isLogisticsWorkspace() && /^\/api(?:\/|$)/.test(url) && !/^\/api\/logistics(?:\/|$)/.test(url)
    ? `/api/logistics${url.slice(4)}`
    : url
}

export const sessionExpiredEvent = 'artel:session-expired'
export const logisticsSessionExpiredEvent = 'artel:logistics-session-expired'

export async function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const target = typeof input === 'string' ? apiUrl(input) : input
  const response = await globalThis.fetch(target, init)
  if (response.status === 401 && typeof target === 'string' && /^\/api\//.test(target) && !/^\/api\/(?:logistics\/)?auth\//.test(target)) window.dispatchEvent(new Event(isLogisticsWorkspace() ? logisticsSessionExpiredEvent : sessionExpiredEvent))
  return response
}

export async function fetchDirectoryData(): Promise<DirectoryData> {
  const response = await apiFetch(isLogisticsWorkspace() ? '/api/context' : '/api/snapshot?shipments=omit', { cache: 'no-store' })
  if (!response.ok) throw new Error('Не удалось сверить актуальные данные. Ваш ввод сохранён в форме; повторите сохранение.')
  return response.json() as Promise<DirectoryData>
}

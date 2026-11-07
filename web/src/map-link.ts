import { tripRequestExplicitCoordinates } from './trip-request-map-coordinates'

const yandexMapHosts = new Set(['yandex.ru', 'yandex.com', 'yandex.by', 'yandex.kz', 'maps.yandex.ru', 'yandex.uz', 'ya.ru'])

export function safeMapUrl(value?: string | null): string | null {
  if (!value || [...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return null
  try {
    const url = new URL(value)
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password && !url.port && yandexMapHosts.has(url.hostname)
      ? url.href : null
  } catch { return null }
}

export function mapLink({ mapUrl, latitude, longitude, address }: {
  mapUrl?: string | null; latitude?: string | number | null; longitude?: string | number | null; address?: string | null
}): { href: string; label: string } | null {
  const saved = safeMapUrl(mapUrl)
  if (saved) return { href: saved, label: 'Открыть в Яндекс.Картах' }
  const point = tripRequestExplicitCoordinates({ latitude, longitude })
  const url = new URL('https://yandex.ru/maps/')
  if (point?.status === 'found') {
    // Web map pins take longitude first, unlike the JavaScript API.
    url.searchParams.set('pt', `${point.longitude},${point.latitude}`)
    url.searchParams.set('z', '16')
    return { href: url.href, label: 'Открыть в Яндекс.Картах' }
  }
  if (!address?.trim()) return null
  // Search is deliberately labeled as search: it does not confirm a site's coordinates.
  url.searchParams.set('text', address.trim())
  return { href: url.href, label: 'Найти адрес в Яндекс.Картах' }
}

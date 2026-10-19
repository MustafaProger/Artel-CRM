import { fromLonLat, toLonLat } from 'ol/proj.js'
import type { Coordinate } from 'ol/coordinate.js'
import type { Extent } from 'ol/extent.js'
import type { MapBounds, MapPoint } from './trip-map-view'

/** CRM stores [latitude, longitude]; OpenLayers EPSG:3857 takes [longitude, latitude]. */
export function projectMapPoint([latitude, longitude]: MapPoint): Coordinate {
  return fromLonLat([longitude, Math.max(-85.05112878, Math.min(85.05112878, latitude))])
}
export function unprojectMapPoint(coordinate: Coordinate): MapPoint {
  const [longitude, latitude] = toLonLat(coordinate)
  return [latitude, ((longitude + 180) % 360 + 360) % 360 - 180]
}
export function projectMapBounds([southWest, northEast]: MapBounds): Extent {
  return [...projectMapPoint(southWest), ...projectMapPoint(northEast)]
}
export function yandexTileUrl(z: number, x: number, y: number, scale: 1 | 2): string {
  return `/api/maps/yandex/tiles?x=${x}&y=${y}&z=${z}&scale=${scale}`
}
export function pointNavigationUrl(latitude: string, longitude: string) {
  return `https://yandex.ru/maps/?pt=${encodeURIComponent(`${longitude},${latitude}`)}&z=17`
}

import OlMap from 'ol/Map.js'
import View from 'ol/View.js'
import TileLayer from 'ol/layer/Tile.js'
import XYZ from 'ol/source/XYZ.js'
import ImageTile from 'ol/ImageTile.js'
import TileState from 'ol/TileState.js'
import type Tile from 'ol/Tile.js'
import type { TileSourceEvent } from 'ol/source/Tile.js'
import { unByKey } from 'ol/Observable.js'
import Control from 'ol/control/Control.js'
import Zoom from 'ol/control/Zoom.js'
import { defaults as defaultInteractions } from 'ol/interaction/defaults.js'
import { containsCoordinate } from 'ol/extent.js'
import { projectMapBounds, projectMapPoint, unprojectMapPoint, yandexTileUrl } from './yandex-map-coordinates'
import type { MapBounds, MapPoint, RequestFitView } from './trip-map-view'
// Official Russian SVG, including its built-in corner padding:
// https://yandex.ru/maps-api/docs/tiles-api/index.html#using-logo
import logoUrl from './assets/yandex-logo.svg'
import 'ol/ol.css'
import './yandex-map.css'

export { pointNavigationUrl } from './yandex-map-coordinates'
export const defaultMapCenter: MapPoint = [55.751244, 37.618423]

/** Tile events can finish after the viewport has moved. Only its current tiles affect the warning. */
export function watchMapTiles(map: OlMap, tiles: XYZ, update: (state: { loading: boolean; failed: boolean }) => void) {
  const failed = new Map<string, Tile>()
  let ready = false, timedOut = false, previous = ''
  const visible = (tile: Tile) => {
    const view = map.getView(), resolution = view.getResolution(), size = map.getSize(), grid = tiles.getTileGrid()
    if (resolution === undefined || !size || !grid) return false
    const coordinate = tile.getTileCoord(), z = grid.getZForResolution(resolution, tiles.zDirection)
    return coordinate[0] === z && grid.getTileRangeForExtentAndZ(view.calculateExtent(size), z).containsXY(coordinate[1], coordinate[2])
  }
  const publish = () => {
    const hasFailure = timedOut || [...failed.values()].some(visible)
    const loading = !ready && !hasFailure, signature = `${loading}:${hasFailure}`
    if (signature !== previous) { previous = signature; update({ loading, failed: hasFailure }) }
  }
  const timeout = setTimeout(() => { timedOut = true; publish() }, 12_000)
  const settled = (event: TileSourceEvent) => {
    const key = event.tile.getTileCoord().join('/')
    if (event.type === 'tileloaderror') failed.set(key, event.tile)
    else failed.delete(key)
    if (visible(event.tile)) { ready = true; timedOut = false; clearTimeout(timeout) }
    publish()
  }
  const listeners = [tiles.on('tileloadend', settled), tiles.on('tileloaderror', settled), map.getView().on('change', publish), map.on('change:size', publish)]
  publish()
  return () => { clearTimeout(timeout); unByKey(listeners); failed.clear() }
}

function link(label: string, href: string) {
  const anchor = document.createElement('a')
  anchor.textContent = label; anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'
  return anchor
}

/** One provider/projection for all embedded maps. The authenticated API owns key, queue and cache. */
export function createBaseMap(element: HTMLElement, overviewBounds?: MapBounds) {
  const scale = window.devicePixelRatio > 1 ? 2 : 1
  const pending = new Set<AbortController>(), objectUrls = new Set<string>()
  let disposed = false
  const tiles = new XYZ({
    projection: 'EPSG:3857', maxZoom: 20, tileSize: 256, tilePixelRatio: scale,
    tileUrlFunction: ([z, x, y]) => yandexTileUrl(z, x, y, scale),
    wrapX: false, transition: 0,
    tileLoadFunction: (tile, url) => {
      if (!(tile instanceof ImageTile) || disposed) return
      const controller = new AbortController(); pending.add(controller)
      void fetch(url, { credentials: 'same-origin', signal: controller.signal }).then(async response => {
        if (!response.ok) throw new Error('Map image unavailable')
        const blob = await response.blob()
        if (disposed) return
        const objectUrl = URL.createObjectURL(blob); objectUrls.add(objectUrl)
        const image = tile.getImage() as HTMLImageElement
        const release = () => { URL.revokeObjectURL(objectUrl); objectUrls.delete(objectUrl); image.removeEventListener('load', release); image.removeEventListener('error', release) }
        image.addEventListener('load', release); image.addEventListener('error', release)
        image.src = objectUrl
      }).catch(() => { if (!disposed) tile.setState(TileState.ERROR) }).finally(() => pending.delete(controller))
    },
  })
  const branding = document.createElement('div')
  branding.className = 'yandex-map-branding'
  const logo = link('', 'https://yandex.ru/maps')
  logo.className = 'yandex-map-logo'; logo.setAttribute('aria-label', 'Яндекс Карты')
  const image = document.createElement('img')
  image.src = logoUrl; image.alt = 'Яндекс'; image.width = 86; image.height = 43
  logo.append(image)
  const attribution = document.createElement('div')
  attribution.className = 'yandex-map-attribution'
  const open = link('Открыть в Картах', 'https://yandex.ru/maps')
  attribution.append(link('© Яндекс', 'https://yandex.ru/legal/maps_termsofuse/'), open)
  branding.append(logo, attribution)
  const layer = new TileLayer({ source: tiles, preload: 0 })
  const map = new OlMap({
    target: element, layers: [layer], maxTilesLoading: 8,
    controls: [new Zoom({ zoomInTipLabel: 'Приблизить карту', zoomOutTipLabel: 'Отдалить карту' }), new Control({ element: branding })],
    interactions: defaultInteractions({ mouseWheelZoom: false, altShiftDragRotate: false, pinchRotate: false }),
    view: new View({ center: projectMapPoint(defaultMapCenter), zoom: 10, minZoom: 2, maxZoom: 20, enableRotation: false }),
  })
  element.classList.add('yandex-map')
  element.querySelector('.ol-zoom-in')?.setAttribute('aria-label', 'Приблизить карту')
  element.querySelector('.ol-zoom-out')?.setAttribute('aria-label', 'Отдалить карту')
  if (overviewBounds) map.getView().fit(projectMapBounds(overviewBounds), { padding: [36, 36, 52, 36], maxZoom: 10 })
  const updateLink = () => {
    const center = map.getView().getCenter()
    if (!center) return
    const [latitude, longitude] = unprojectMapPoint(center)
    open.href = `https://yandex.ru/maps/?ll=${encodeURIComponent(`${longitude.toFixed(6)},${latitude.toFixed(6)}`)}&z=${Math.round(map.getView().getZoom() ?? 10)}`
  }
  map.on('moveend', updateLink); updateLink()
  const dispose = () => {
    disposed = true
    for (const controller of pending) controller.abort()
    pending.clear()
    for (const url of objectUrls) URL.revokeObjectURL(url)
    objectUrls.clear()
    map.setTarget(undefined); map.dispose(); layer.dispose(); tiles.dispose()
  }
  return { map, tiles, dispose }
}

export function mapContainsPoint(map: OlMap, point: MapPoint) {
  return containsCoordinate(map.getView().calculateExtent(map.getSize()), projectMapPoint(point))
}
export function applyRequestFit(map: OlMap, fit: RequestFitView, padding = [44, 44, 60, 44]) {
  map.updateSize()
  const view = map.getView()
  view.cancelAnimations()
  if ('center' in fit) { view.setCenter(projectMapPoint(fit.center)); view.setZoom(fit.zoom) }
  else view.fit(projectMapBounds(fit.bounds), { padding, maxZoom: fit.maxZoom })
}

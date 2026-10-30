import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { ArrowUpRight, MapPin, Maximize, RotateCcw, X } from 'lucide-react'
import type OlMap from 'ol/Map.js'
import Overlay from 'ol/Overlay.js'
import { unByKey } from 'ol/Observable.js'
import type { EventsKey } from 'ol/events.js'
import type { TripRequest } from './trip-request-model'
import type { OilDepot, ShipmentAddress } from './model'
import { tripRequestExplicitCoordinates, tripRequestMapCoordinates } from './trip-request-map-coordinates'
import { mapLink } from './map-link'
import { applyRequestFit, createBaseMap, mapContainsPoint, watchMapTiles } from './yandex-map'
import { projectMapPoint } from './yandex-map-coordinates'
import { mapCardPosition, requestFitView, requestOverviewBounds, type MapPoint } from './trip-map-view'
import { locationStatusText, oilDepotLocationTarget, requestLocationTarget, useTripRequestLocations, type LocationState } from './useTripRequestLocations'
import { groupRequestsByLocation, requestVolumeBand, requestVolumeBands } from './trip-map-points'
import { requestIsOnMap, requestDateLabel, requestToday } from './trip-request-schedule'
import './trip-requests-map.css'

type LocatedRequest = { request: TripRequest; coordinates: MapPoint | null; automatic?: LocationState }
type LocatedDepot = { depot: OilDepot; coordinates: MapPoint | null; automatic?: LocationState }
type OpenCard = { key: string; pinned: boolean }
const volume = (value: string) => {
  const [integer, fraction] = value.split('.')
  return integer.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + (fraction ? `,${fraction}` : '') + ' л'
}
const noAddresses: readonly ShipmentAddress[] = []
const noDepots: readonly OilDepot[] = []
export default function TripRequestsMap({ requests, addresses = noAddresses, oilDepots = noDepots, onEditRequest }: {
  requests: readonly TripRequest[]; addresses?: readonly ShipmentAddress[]; oilDepots?: readonly OilDepot[]; onEditRequest?: (request: TripRequest) => void
}) {
  const [today, setToday] = useState(requestToday)
  useEffect(() => {
    const update = () => setToday(requestToday())
    const timer = window.setInterval(update, 30000)
    document.addEventListener('visibilitychange', update)
    return () => { window.clearInterval(timer); document.removeEventListener('visibilitychange', update) }
  }, [])
  const active = useMemo(() => requests.filter(request => requestIsOnMap(request, new Date(`${today}T12:00:00+03:00`))), [requests, today])
  return active.length || oilDepots.length ? <ActiveRequestsMap requests={active} addresses={addresses} oilDepots={oilDepots} onEditRequest={onEditRequest} /> : <div className="trip-map-empty"><MapPin size={28} aria-hidden="true" /><strong>Нет заявок до завтра включительно</strong><p>Укажите дату выполнения заявки. На карте показаны активные заявки за прошлые даты, сегодня и завтра по московскому времени.</p></div>
}

function ActiveRequestsMap({ requests, addresses, oilDepots, onEditRequest }: {
  requests: readonly TripRequest[]; addresses: readonly ShipmentAddress[]; oilDepots: readonly OilDepot[]; onEditRequest?: (request: TripRequest) => void
}) {
  const canvas = useRef<HTMLDivElement>(null)
  const surface = useRef<HTMLDivElement>(null)
  const markers = useRef(new Map<string, HTMLButtonElement>())
  const hideTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const [map, setMap] = useState<OlMap | null>(null)
  const [card, setCard] = useState<OpenCard | null>(null)
  const [mapError, setMapError] = useState(false)
  const [tileError, setTileError] = useState(false)
  const [loadingTiles, setLoadingTiles] = useState(true)
  const [retry, setRetry] = useState(0)
  const [viewRevision, setViewRevision] = useState(0)
  const needed = useMemo(() => [...requests.filter(request => !tripRequestMapCoordinates(request, addresses)).map(requestLocationTarget), ...oilDepots.filter(depot => !tripRequestExplicitCoordinates(depot) && depot.address?.trim()).map(oilDepotLocationTarget)], [requests, addresses, oilDepots])
  const { states: automaticLocations, retry: retryLocation } = useTripRequestLocations(needed)
  const locations = useMemo<LocatedRequest[]>(() => requests.map(request => {
    const saved = tripRequestMapCoordinates(request, addresses)
    const automatic = !saved ? automaticLocations.get(requestLocationTarget(request).key) : request.location?.status === 'found' && request.location.source === 'geocoder' ? request.location : undefined
    const point = saved ?? automatic
    return { request, coordinates: point?.status === 'found' ? [point.latitude, point.longitude] : null, automatic }
  }), [requests, addresses, automaticLocations])
  const groups = useMemo(() => groupRequestsByLocation(locations), [locations])
  const depotLocations = useMemo<LocatedDepot[]>(() => oilDepots.map(depot => {
    const saved = tripRequestExplicitCoordinates(depot)
    const automatic = !saved ? automaticLocations.get(oilDepotLocationTarget(depot).key) : undefined
    const point = saved ?? automatic
    return { depot, coordinates: point?.status === 'found' ? [point.latitude, point.longitude] : null, automatic }
  }), [oilDepots, automaticLocations])
  const allPoints = useMemo(() => [...locations, ...depotLocations].flatMap(item => item.coordinates ? [item.coordinates] : []), [locations, depotLocations])
  const initialPoints = useRef(allPoints)
  useEffect(() => { initialPoints.current = allPoints }, [allPoints])
  const cancelHide = useCallback(() => clearTimeout(hideTimer.current), [])
  const showCard = useCallback((key: string, pinned = false) => {
    clearTimeout(hideTimer.current)
    setCard(previous => !pinned && previous?.pinned ? previous : { key, pinned })
  }, [])
  const hideCard = useCallback(() => {
    clearTimeout(hideTimer.current)
    hideTimer.current = setTimeout(() => {
      // The card can cover its marker. Native OpenLayers leave events and React
      // enter events do not necessarily pair up, so inspect the actual target
      // before hiding (also keeps keyboard focus inside the preview usable).
      if (surface.current?.querySelector('.trip-map-marker:hover, .trip-map-marker:focus, .trip-map-depot-marker:hover, .trip-map-depot-marker:focus, .trip-map-details:hover, .trip-map-details:focus-within')) return
      setCard(previous => previous?.pinned ? previous : null)
    }, 160)
  }, [])

  useEffect(() => {
    if (!canvas.current) return
    let disposed = false
    let instance: OlMap | undefined, resize: ResizeObserver | undefined
    const listeners: EventsKey[] = []
    let disposeMap: (() => void) | undefined
    let stopWatchingTiles: (() => void) | undefined
    setMapError(false); setTileError(false); setLoadingTiles(true); setCard(null)
    const viewChanged = () => { if (!disposed) setViewRevision(value => value + 1) }
    const dismiss = () => setCard(null)
    try {
      const base = createBaseMap(canvas.current, requestOverviewBounds(initialPoints.current))
      instance = base.map; disposeMap = base.dispose
      stopWatchingTiles = watchMapTiles(instance, base.tiles, state => { setLoadingTiles(state.loading); setTileError(state.failed) })
      listeners.push(instance.getView().on('change', viewChanged), instance.on('change:size', viewChanged), instance.on('singleclick', dismiss))
      resize = new ResizeObserver(() => instance?.updateSize())
      resize.observe(canvas.current)
      setMap(instance)
    } catch { setMapError(true); setLoadingTiles(false) }
    return () => {
      disposed = true; stopWatchingTiles?.(); clearTimeout(hideTimer.current)
      resize?.disconnect()
      unByKey(listeners)
      disposeMap?.(); markers.current.clear(); setMap(null)
    }
  }, [retry])

  // Marker data changes never change the viewport. Only initialization and explicit controls do.
  useEffect(() => {
    if (!map) return
    const overlays: Overlay[] = []
    markers.current.clear()
    const addMarker = (element: HTMLButtonElement, key: string, coordinates: MapPoint, offset?: number[]) => {
      element.setAttribute('aria-controls', 'trip-map-details')
      const marker = new Overlay({ element, position: projectMapPoint(coordinates), positioning: 'center-center', stopEvent: true, autoPan: false, offset })
      map.addOverlay(marker); overlays.push(marker)
      element.addEventListener('mouseenter', () => { if (window.matchMedia('(hover: hover) and (pointer: fine)').matches) showCard(key) })
      element.addEventListener('mouseleave', hideCard)
      element.addEventListener('click', event => { event.stopPropagation(); showCard(key, true) })
      // A pointer focuses the button before its click. Opening here can cover
      // the button and swallow that click, especially on touch screens.
      element.addEventListener('focus', () => { if (element.matches(':focus-visible')) showCard(key) })
      element.addEventListener('blur', hideCard)
      element.addEventListener('keydown', event => {
        if (event.key === 'Escape') setCard(null)
        if (event.key === ' ' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); showCard(key, true) }
      })
    }
    for (const [key, group] of groups) {
      const element = document.createElement('button')
      element.type = 'button'; element.className = 'trip-map-marker'
      element.dataset.volumeBand = requestVolumeBand(group.totalLitres).id
      element.dataset.totalLitres = group.totalLitres
      const count = document.createElement('span')
      count.textContent = group.requests.length > 1 ? String(group.requests.length) : ''
      count.setAttribute('aria-hidden', 'true'); element.append(count)
      element.setAttribute('aria-label', `${group.requests.map(request => `${request.companyName}, ${request.address || request.addressName}, ${volume(request.quantityLitres)}`).join('; ')}${group.requests.length > 1 ? `. Всего ${volume(group.totalLitres)}` : ''}`)
      addMarker(element, key, group.coordinates)
      for (const request of group.requests) markers.current.set(request.id, element)
    }
    for (const { depot, coordinates } of depotLocations) {
      if (!coordinates) continue
      const key = `depot:${depot.id}`, element = document.createElement('button')
      element.type = 'button'; element.className = 'trip-map-depot-marker'
      element.setAttribute('aria-label', `Нефтебаза: ${depot.name}${depot.address ? `, ${depot.address}` : ''}`)
      const dot = document.createElement('span'); dot.setAttribute('aria-hidden', 'true'); element.append(dot)
      // Keep the smaller depot dot visible even at a shared customer location.
      addMarker(element, key, coordinates, groups.has(coordinates.join(',')) ? [28, 28] : undefined)
      markers.current.set(key, element)
    }
    return () => { for (const overlay of overlays) map.removeOverlay(overlay); markers.current.clear() }
  }, [groups, depotLocations, map, showCard, hideCard])

  const located = locations.filter(item => item.coordinates).length
  const searching = locations.filter(item => item.automatic?.status === 'loading' || item.automatic?.status === 'pending').length
  // Reading bounds after map events keeps the outside-view notice accurate without recentering.
  const outside = useMemo(() => map ? allPoints.some(point => !mapContainsPoint(map, point)) : false, [map, allPoints, viewRevision])
  const openGroup = card ? groups.get(card.key) : undefined
  const openDepot = card ? depotLocations.find(item => `depot:${item.depot.id}` === card.key) : undefined
  const locatedDepots = depotLocations.filter(item => item.coordinates).length
  const searchingDepots = depotLocations.filter(item => item.automatic?.status === 'loading' || item.automatic?.status === 'pending').length
  function showAll() {
    if (!map) return
    const view = requestFitView(allPoints)
    if (!view) return
    setCard(null)
    applyRequestFit(map, view, oilDepots.length ? [44, 60, 88, 44] : undefined)
  }
  function focusRequest(item: LocatedRequest) {
    if (!item.coordinates || !map) return
    // A deliberate list selection may center a point; it never forces a close zoom.
    if (!mapContainsPoint(map, item.coordinates)) map.getView().setCenter(projectMapPoint(item.coordinates))
    showCard(item.coordinates.join(','), true)
    canvas.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' })
  }
  function closeCard() {
    const markerId = openGroup?.requests[0]?.id ?? (openDepot ? `depot:${openDepot.depot.id}` : undefined)
    setCard(null)
    if (card?.pinned && markerId) {
      const marker = markers.current.get(markerId)
      marker?.focus({ preventScroll: true })
      // The focus handler normally shows a preview; Escape/Close explicitly dismisses it.
      setCard(null)
    }
  }
  return <section className="trip-requests-map" aria-label="Карта заявок">
    <div className="trip-map-toolbar"><div className="trip-map-summary" aria-live="polite"><strong>{requests.length ? `На карте ${located} из ${requests.length} заявок` : 'Нет заявок до завтра включительно'}</strong>{searching > 0 ? <span>Ищем адреса: {searching}</span> : located < requests.length ? <span>Адресов без точки: {requests.length - located}</span> : requests.length > 0 && <span>Прошлые даты, сегодня и завтра · МСК</span>}{oilDepots.length > 0 && <span>Нефтебаз на карте: {locatedDepots} из {oilDepots.length}{searchingDepots > 0 ? ` · ищем адреса: ${searchingDepots}` : ''}</span>}</div><button type="button" className="button trip-map-show-all" disabled={!map || allPoints.length === 0} onClick={showAll}><Maximize size={17} aria-hidden="true" />Показать все</button></div>
    <ul className="trip-map-legend" aria-label="Цвет точки по сумме литров в заявках">{requestVolumeBands.map(band => <li key={band.id}><span className="trip-map-swatch" data-volume-band={band.id} aria-hidden="true"/>{band.label}</li>)}<li><span className="trip-map-swatch is-depot" aria-hidden="true"/>Нефтебаза</li></ul>
    {(tileError || mapError) && <div className="trip-map-load-error" role="status"><span>{mapError ? 'Не удалось открыть карту.' : 'Не удалось загрузить изображение карты. Точки заявок и список доступны.'}</span><button type="button" className="button" onClick={() => setRetry(value => value + 1)}><RotateCcw size={16} />Повторить</button></div>}
    <div ref={surface} className={`trip-map-surface${mapError ? ' trip-map-unavailable' : ''}`}>
      <div ref={canvas} className="trip-map-canvas" role="region" aria-label="Яндекс Карта площадок из активных заявок и нефтебаз" tabIndex={0} />
      {mapError && <div className="trip-map-overlay"><MapPin size={32} aria-hidden="true" /><strong>Карта временно недоступна</strong><p>Площадки и ссылки на карту доступны в списке ниже.</p></div>}
      {loadingTiles && !mapError && <span className="trip-map-loading" role="status">Загружаем карту…</span>}
      {outside && <button type="button" className="trip-map-outside" onClick={showAll}>Есть точки вне обзора · Показать все</button>}
      <div id="trip-map-details">
      {openGroup && map && <MapDetails coordinates={openGroup.coordinates} heading={openGroup.requests.length > 1 ? `Заявок: ${openGroup.requests.length} · Всего ${volume(openGroup.totalLitres)}` : 'Точка доставки'} label="Информация о точке доставки" map={map} revision={viewRevision} pinned={!!card?.pinned} onClose={closeCard} onEnter={cancelHide} onLeave={hideCard}>{openGroup.requests.map(request => <article className="trip-map-balloon" key={request.id}><strong>{request.companyName}</strong><span>{request.address || request.addressName}</span><b>{volume(request.quantityLitres)}</b><span>Дата выполнения: {requestDateLabel(request.executionDate)}</span>{request.comment.trim() && <div className="trip-map-card-comment"><small>Комментарий</small><p>{request.comment}</p></div>}</article>)}</MapDetails>}
      {openDepot?.coordinates && map && <MapDetails coordinates={openDepot.coordinates} heading="Нефтебаза" label="Информация о нефтебазе" map={map} revision={viewRevision} pinned={!!card?.pinned} onClose={closeCard} onEnter={cancelHide} onLeave={hideCard}><article className="trip-map-balloon"><strong>{openDepot.depot.name}</strong><span>{openDepot.depot.address || 'Адрес не указан'}</span>{openDepot.automatic?.status === 'found' && <span>{openDepot.automatic.accuracy === 'street' ? 'По адресу найдена улица — точку можно уточнить в справочнике' : 'Найдено по адресу'}</span>}</article></MapDetails>}
      </div>
    </div>
    <ul className="trip-map-list" aria-label="Площадки заявок">
      {locations.map(item => {
        const { request, coordinates, automatic } = item
        const link = mapLink({ mapUrl: automatic?.status === 'found' ? null : request.mapUrl, address: request.address, ...(coordinates ? { latitude: coordinates[0], longitude: coordinates[1] } : {}) })
        const action = coordinates ? automatic?.status === 'found' ? 'Уточнить точку' : 'Изменить точку' : 'Уточнить адрес'
        const content = <>
          <span className="trip-map-list-icon"><MapPin size={18} aria-hidden="true" /></span>
          <span className="trip-map-list-info">
            <strong>{request.companyName}</strong>
            <span>{request.address || request.addressName}</span>
            <span className="trip-map-list-date">Дата выполнения: <time dateTime={request.executionDate || undefined}>{requestDateLabel(request.executionDate)}</time></span>
            {automatic && <small className={`trip-map-geocode-status ${automatic.status}`} role="status">{locationStatusText(automatic)}</small>}
          </span>
          <b className="trip-map-list-volume">{volume(request.quantityLitres)}</b>
        </>
        return <li key={request.id}>{coordinates && map ? <button type="button" className="trip-map-list-location" onClick={() => focusRequest(item)} aria-label={`${request.companyName}, ${request.address || request.addressName}, ${volume(request.quantityLitres)}. Показать на карте`}>{content}</button> : <div className="trip-map-list-static">{content}</div>}<div className="trip-map-list-actions">{automatic?.status === 'unavailable' && <button type="button" className="trip-map-edit-point" onClick={() => retryLocation(requestLocationTarget(request))}>Повторить поиск адреса</button>}{onEditRequest && <button type="button" className="trip-map-edit-point" onClick={() => onEditRequest(request)} aria-label={`${action}: ${request.companyName}`}>{action}</button>}{link && <a className="trip-map-external-link" href={link.href} target="_blank" rel="noreferrer" aria-label={`${link.label}: ${request.companyName}, ${request.address || request.addressName}`}>{link.label}<ArrowUpRight size={15} aria-hidden="true" /></a>}</div></li>
      })}
    </ul>
    {oilDepots.length > 0 && <details className="trip-map-depots"><summary>Нефтебазы · на карте {locatedDepots} из {oilDepots.length}</summary><ul>{depotLocations.map(item => {
      const { depot, coordinates, automatic } = item
      const status = automatic?.status === 'loading' || automatic?.status === 'pending' ? 'Ищем адрес…' : automatic?.status === 'unavailable' ? 'Поиск адреса временно недоступен' : depot.address ? 'Адрес не найден — уточните точку в справочнике нефтебаз' : 'Укажите адрес или точку в справочнике нефтебаз'
      return <li key={depot.id}>{coordinates && map ? <button type="button" onClick={() => { if (!mapContainsPoint(map, coordinates)) map.getView().setCenter(projectMapPoint(coordinates)); showCard(`depot:${depot.id}`, true); canvas.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' }) }}><strong>{depot.name}</strong><span>{depot.address || 'Адрес не указан'}</span></button> : <div><strong>{depot.name}</strong><span>{depot.address}</span>{!coordinates && <small role="status">{status}</small>}{automatic?.status === 'unavailable' && <button type="button" className="trip-map-edit-point" onClick={() => retryLocation(oilDepotLocationTarget(depot))}>Повторить поиск</button>}</div>}</li>
    })}</ul></details>}
  </section>
}

function MapDetails({ coordinates, heading, label, children, map, revision, pinned, onClose, onEnter, onLeave }: {
  coordinates: MapPoint; heading: string; label: string; children: ReactNode; map: OlMap; revision: number; pinned: boolean; onClose: () => void; onEnter: () => void; onLeave: () => void
}) {
  const element = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState({ left: 12, top: 12 })
  useLayoutEffect(() => {
    const card = element.current
    if (!card) return
    const update = () => {
      const anchor = map.getPixelFromCoordinate(projectMapPoint(coordinates)), surface = map.getSize()
      if (!anchor || !surface) return
      const next = mapCardPosition({ x: anchor[0], y: anchor[1] }, { width: card.offsetWidth, height: card.offsetHeight }, { width: surface[0], height: surface[1] - 43 })
      setPosition(previous => previous.left === next.left && previous.top === next.top ? previous : next)
    }
    update()
    const resize = new ResizeObserver(update); resize.observe(card)
    return () => resize.disconnect()
  }, [map, coordinates, revision])
  return <div ref={element} className={`trip-map-details${pinned ? ' is-pinned' : ''}`} style={position} role="region" aria-label={label} onMouseOver={onEnter} onMouseLeave={onLeave} onFocus={onEnter} onBlur={onLeave} onKeyDown={event => { if (event.key === 'Escape') { event.stopPropagation(); onClose() } }}>
    <header><span>{heading}</span><button type="button" className="trip-map-card-close" onClick={onClose} aria-label="Закрыть карточку точки"><X size={18} aria-hidden="true" /></button></header>
    <div className="trip-map-card-scroll">{children}</div>
  </div>
}

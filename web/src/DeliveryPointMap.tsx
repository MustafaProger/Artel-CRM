import { tripRequestExplicitCoordinates } from './trip-request-map-coordinates'
import { useEffect, useRef, useState } from 'react'
import type OlMap from 'ol/Map.js'
import Feature from 'ol/Feature.js'
import Point from 'ol/geom/Point.js'
import VectorLayer from 'ol/layer/Vector.js'
import VectorSource from 'ol/source/Vector.js'
import Translate from 'ol/interaction/Translate.js'
import { Circle as CircleStyle, Fill, Stroke, Style } from 'ol/style.js'
import type { Coordinate } from 'ol/coordinate.js'
import type { MapPoint } from './trip-map-view'
import { createBaseMap, watchMapTiles } from './yandex-map'
import { projectMapPoint, unprojectMapPoint } from './yandex-map-coordinates'

type Props = {
  latitude?: string | null; longitude?: string | null; mapUrl?: string | null;
  disabled?: boolean; onChange: (latitude: string, longitude: string) => void;
}


export default function PointMap({ latitude, longitude, disabled, onChange }: Props) {
  const canvas = useRef<HTMLDivElement>(null), map = useRef<OlMap | null>(null), marker = useRef<Feature<Point> | null>(null)
  const source = useRef<VectorSource<Feature<Point>> | null>(null), translate = useRef<Translate | null>(null)
  const latest = useRef({ onChange, disabled })
  latest.current = { onChange, disabled }
  const initial = useRef({ latitude, longitude })
  const [latInput, setLatInput] = useState(latitude ?? ''), [lonInput, setLonInput] = useState(longitude ?? '')
  const [tileError, setTileError] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState(0)
  const applyPoint = ([latitude, longitude]: MapPoint) => {
    if (latest.current.disabled) return
    if (!Number.isFinite(latitude) || Math.abs(latitude) > 90 || !Number.isFinite(longitude) || Math.abs(longitude) > 180) return
    latest.current.onChange(latitude.toFixed(6), longitude.toFixed(6))
    setError('')
  }
  const applyRef = useRef(applyPoint)
  applyRef.current = applyPoint
  useEffect(() => {
    if (!canvas.current) return
    const created = createBaseMap(canvas.current)
    map.current = created.map
    source.current = new VectorSource<Feature<Point>>()
    const points = new VectorLayer({ source: source.current, style: new Style({ image: new CircleStyle({ radius: 13, fill: new Fill({ color: '#176e50' }), stroke: new Stroke({ color: '#fff', width: 3 }) }) }) })
    created.map.addLayer(points)
    const point = tripRequestExplicitCoordinates(initial.current)
    if (point?.status === 'found') { created.map.getView().setCenter(projectMapPoint([point.latitude, point.longitude])); created.map.getView().setZoom(16) }
    translate.current = new Translate({ layers: [points], hitTolerance: 12 })
    translate.current.setActive(!latest.current.disabled)
    created.map.addInteraction(translate.current)
    translate.current.on('translateend', event => {
      const geometry = event.features.item(0)?.getGeometry()
      if (geometry instanceof Point) applyRef.current(unprojectMapPoint(geometry.getCoordinates()))
    })
    created.map.on('singleclick', event => applyRef.current(unprojectMapPoint(event.coordinate)))
    const stopWatchingTiles = watchMapTiles(created.map, created.tiles, state => setTileError(state.failed))
    const resize = new ResizeObserver(() => created.map.updateSize())
    resize.observe(canvas.current)
    return () => { stopWatchingTiles(); resize.disconnect(); created.dispose(); map.current = null; marker.current = null; source.current = null; translate.current = null }
  }, [retry])
  useEffect(() => {
    setLatInput(latitude ?? ''); setLonInput(longitude ?? '')
    const point = tripRequestExplicitCoordinates({ latitude, longitude })
    if (!map.current) return
    translate.current?.setActive(!disabled)
    if (point?.status !== 'found') { source.current?.clear(); marker.current = null; return }
    const position = projectMapPoint([point.latitude, point.longitude])
    if (!marker.current) {
      map.current.getView().setCenter(position); map.current.getView().setZoom(16)
      marker.current = new Feature(new Point(position))
      source.current?.addFeature(marker.current)
    } else marker.current.getGeometry()?.setCoordinates(position)
  }, [latitude, longitude, disabled, retry])
  const applyCoordinates = () => {
    const point = tripRequestExplicitCoordinates({ latitude: latInput.trim().replace(',', '.'), longitude: lonInput.trim().replace(',', '.') })
    if (point?.status !== 'found') { setError('Укажите широту от −90 до 90 и долготу от −180 до 180.'); return }
    applyPoint([point.latitude, point.longitude])
    map.current?.getView().setCenter(projectMapPoint([point.latitude, point.longitude])); map.current?.getView().setZoom(16)
  }
  return <>
    <p>Нажмите на место доставки или перетащите метку. Точка сохранится вместе с формой; текст адреса останется прежним.</p>
    <div ref={canvas} className="delivery-point-map" role="region" aria-label="Выбор точки доставки на Яндекс Карте" tabIndex={0}/>
    {tileError && <div className="delivery-point-error" role="status">Не удалось загрузить карту. Можно повторить загрузку или ввести координаты.<button className="button" type="button" onClick={() => { initial.current = { latitude, longitude }; setTileError(false); setRetry(value => value + 1) }}>Повторить загрузку карты</button></div>}
    <div className="delivery-point-actions"><button type="button" className="button" disabled={disabled} onClick={() => { if (map.current) applyPoint(unprojectMapPoint(map.current.getView().getCenter() as Coordinate)) }}>Поставить точку в центре карты</button></div>
    <p>Координаты можно ввести вручную. Нажмите «Применить координаты», затем сохраните форму.</p>
    <div className="delivery-point-coordinates">
      <label className="shipment-field"><span>Широта точки</span><input inputMode="decimal" value={latInput} disabled={disabled} onChange={event => setLatInput(event.target.value)}/></label>
      <label className="shipment-field"><span>Долгота точки</span><input inputMode="decimal" value={lonInput} disabled={disabled} onChange={event => setLonInput(event.target.value)}/></label>
    </div>
    {error && <p className="shipment-error" role="alert">{error}</p>}
    <div className="delivery-point-actions"><button type="button" className="button" disabled={disabled} onClick={applyCoordinates}>Применить координаты</button></div>
  </>
}

import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, CalendarDays, ChevronRight, LoaderCircle, LogOut, MapPin, RefreshCw, Route, Search, Truck, X } from 'lucide-react'
import type { AccountUser } from './auth-model'
import { apiFetch } from './workspace-api'
import DriverNotifications from './DriverNotifications'
import './driver.css'

type DriverDelivery = { id: string; number: string | null; customer: string | null; product: string | null; liters: string | null; address: string | null; mapUrl: string | null; plannedAt: string | null; actualAt: string | null; notes: string | null }
type DriverTrip = { id: string; date: string | null; driverName: string; vehiclePlate: string | null; supplier: string | null; loadingAddress: string | null; loadingMapUrl: string | null; loadingPlannedAt: string | null; loadingActualAt: string | null; notes: string | null; deliveries: DriverDelivery[] }

const dateLabel = (value: string | null) => {
  if (!value) return 'Дата не указана'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' })
}
const dateTimeLabel = (value: string) => {
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' })
}
const tripFromHash = () => {
  const match = /^#driver-trip\/(.+)$/.exec(location.hash)
  if (!match) return null
  try { return decodeURIComponent(match[1]) } catch { return null }
}
const mapLink = (value: string | null) => {
  if (!value) return null
  try { const url = new URL(value); return ['https:', 'http:'].includes(url.protocol) ? url.href : null } catch { return null }
}

function Address({ address, mapUrl }: { address: string | null; mapUrl: string | null }) {
  const url = mapLink(mapUrl)
  return <div className="driver-address"><MapPin size={17}/><div><span>{address || 'Адрес пока не указан'}</span>{url && <a href={url} target="_blank" rel="noreferrer">Открыть карту <ArrowUpRight size={14}/></a>}</div></div>
}

export default function DriverWorkspace({ user, onLogout }: { user: AccountUser; onLogout: () => void }) {
  const [trips, setTrips] = useState<DriverTrip[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(tripFromHash)
  const [selected, setSelected] = useState<DriverTrip | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [revision, setRevision] = useState(0)
  const sequence = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const refresh = useCallback(() => {
    const generation = ++sequence.current
    controller.current?.abort()
    const pending = new AbortController()
    controller.current = pending
    setLoading(true)
    setError('')
    void apiFetch('/api/driver/trips', { cache: 'no-store', signal: pending.signal }).then(async response => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось загрузить ваши рейсы.')
      if (generation === sequence.current) { setTrips(result.trips); setRevision(value => value + 1) }
    }).catch(reason => {
      if (!pending.signal.aborted && generation === sequence.current) { setTrips([]); setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.') }
    }).finally(() => { if (!pending.signal.aborted && generation === sequence.current) setLoading(false) })
  }, [])

  useEffect(() => {
    document.title = 'Мои рейсы — Артэль'
    refresh()
    const navigate = () => { setSelectedId(tripFromHash()); window.scrollTo({ top: 0, behavior: 'instant' }) }
    window.addEventListener('hashchange', navigate)
    const focused = () => refresh()
    window.addEventListener('focus', focused)
    const notified = (event: MessageEvent) => { if (event.data?.type === 'artel-driver-trip-assigned') refresh() }
    navigator.serviceWorker?.addEventListener('message', notified)
    const timer = window.setInterval(() => { if (document.visibilityState === 'visible') refresh() }, 60000)
    return () => { controller.current?.abort(); sequence.current++; window.clearInterval(timer); window.removeEventListener('hashchange', navigate); window.removeEventListener('focus', focused); navigator.serviceWorker?.removeEventListener('message', notified) }
  }, [refresh])

  useEffect(() => {
    setSelected(null)
    setDetailError('')
    if (!selectedId) { setDetailLoading(false); return }
    const pending = new AbortController()
    setDetailLoading(true)
    void apiFetch(`/api/driver/trips/${encodeURIComponent(selectedId)}`, { cache: 'no-store', signal: pending.signal }).then(async response => {
      const result = await response.json()
      if (!response.ok) throw new Error(response.status === 404 ? 'Рейс не найден или больше не назначен вам.' : result.error || 'Не удалось открыть рейс.')
      if (!pending.signal.aborted) setSelected(result.trip)
    }).catch(reason => { if (!pending.signal.aborted) setDetailError(reason instanceof Error ? reason.message : 'Нет связи с сервером.') })
      .finally(() => { if (!pending.signal.aborted) setDetailLoading(false) })
    return () => pending.abort()
  }, [selectedId, revision])

  const normalizedQuery = query.trim().toLocaleLowerCase('ru')
  const visible = trips.filter(trip => [trip.date, dateLabel(trip.date), trip.vehiclePlate, trip.loadingAddress, ...trip.deliveries.flatMap(delivery => [delivery.number, delivery.customer, delivery.address, delivery.product])].some(value => value?.toLocaleLowerCase('ru').includes(normalizedQuery)))

  return <div className="driver-shell">
    <a className="skip-link" href="#driver-content" onClick={event => { event.preventDefault(); document.getElementById('driver-content')?.focus() }}>К содержимому</a>
    <header className="driver-topbar"><a href="#driver-trips" className="driver-brand"><Route size={24}/><span>Артэль<small>Кабинет водителя</small></span></a><button className="button" onClick={onLogout}><LogOut size={17}/><span>Выйти</span></button></header>
    <main id="driver-content" tabIndex={-1} className="driver-content">
      <div className="driver-heading"><div><p>{user.name}</p><h1>Мои рейсы</h1></div><div className="driver-heading-actions"><DriverNotifications userId={user.id}/><button className="button driver-refresh" aria-label="Обновить мои рейсы" disabled={loading || detailLoading} onClick={refresh}><RefreshCw size={17} className={loading ? 'spin' : ''}/><span>Обновить</span></button></div></div>
      <p className="driver-intro">Рейсы и доставки, назначенные вам логистом.</p>
      {selectedId ? <>
        <a className="button driver-back" href="#driver-trips"><ArrowLeft size={16}/>Все мои рейсы</a>
        {detailLoading && <div className="driver-empty" role="status"><LoaderCircle size={24} className="spin"/><p>Открываем рейс…</p></div>}
        {detailError && <p className="driver-error" role="alert">{detailError}</p>}
        {selected && <TripDetail trip={selected}/>}
      </> : <>
        <label className="driver-search"><Search size={18}/><input type="search" aria-label="Поиск моих рейсов" placeholder="Дата, адрес, клиент или автомобиль" value={query} onChange={event => setQuery(event.target.value)}/>{query && <button type="button" className="icon-button" aria-label="Очистить поиск рейсов" onClick={() => setQuery('')}><X size={17}/></button>}</label>
        {error && <div className="driver-error" role="alert"><p>{error}</p><button className="button" onClick={refresh}>Повторить загрузку рейсов</button></div>}
        {loading && !trips.length ? <div className="driver-empty" role="status"><LoaderCircle size={24} className="spin"/><p>Загружаем ваши рейсы…</p></div> : !error && <>
          <p className="driver-count" role="status">Рейсов: {visible.length}</p>
          <div className="driver-trip-list">{visible.map(trip => <a href={`#driver-trip/${encodeURIComponent(trip.id)}`} key={trip.id} className="driver-trip-card" aria-label={`Открыть рейс ${dateLabel(trip.date)}`}>
            <div className="driver-trip-card-heading"><strong><CalendarDays size={17}/>{dateLabel(trip.date)}</strong><ChevronRight size={19}/></div>
            {trip.vehiclePlate && <p className="driver-vehicle"><Truck size={17}/>{trip.vehiclePlate}</p>}
            <p className="driver-trip-route">{trip.loadingAddress || 'Место погрузки уточняется'}</p>
            <div className="driver-trip-destinations">{trip.deliveries.map((delivery, index) => <p key={delivery.id}><span>{index + 1}</span><span className="driver-destination-name">{[delivery.customer, delivery.address].filter(Boolean).join(' · ') || 'Место доставки уточняется'}{delivery.liters !== null && <small>{delivery.liters} л</small>}</span></p>)}</div>
            <span className="driver-trip-deliveries">Доставок: {trip.deliveries.length}</span>
          </a>)}</div>
          {!visible.length && <div className="driver-empty"><Truck size={30}/><h2>{query ? 'Ничего не найдено' : 'Назначенных рейсов пока нет'}</h2><p>{query ? 'Попробуйте другой адрес, дату или имя клиента.' : 'Когда логист назначит вам рейс, он появится здесь.'}</p></div>}
        </>}
      </>}
    </main>
  </div>
}

function TripDetail({ trip }: { trip: DriverTrip }) {
  return <article className="driver-trip-detail">
    <header className="driver-detail-heading"><h2>Рейс · {dateLabel(trip.date)}</h2>{trip.vehiclePlate && <p className="driver-vehicle"><Truck size={18}/>{trip.vehiclePlate}</p>}</header>
    <section className="driver-stop"><div className="driver-stop-heading"><span className="driver-stop-marker"><Truck size={18}/></span><h3>Погрузка</h3></div>{trip.supplier && <p className="driver-stop-party">{trip.supplier}</p>}<Address address={trip.loadingAddress} mapUrl={trip.loadingMapUrl}/><Timing planned={trip.loadingPlannedAt} actual={trip.loadingActualAt}/>{trip.notes && <p className="driver-note">{trip.notes}</p>}</section>
    <div className="driver-deliveries-heading"><h3>Доставки</h3><span>{trip.deliveries.length}</span></div>
    {trip.deliveries.map((delivery, index) => <section key={delivery.id} className="driver-stop"><div className="driver-stop-heading"><span className="driver-stop-marker">{index + 1}</span><h3>{delivery.customer || `Доставка ${index + 1}`}</h3>{delivery.number && <small>№ {delivery.number}</small>}</div><Address address={delivery.address} mapUrl={delivery.mapUrl}/><dl className="driver-cargo">{delivery.product && <div><dt>Груз</dt><dd>{delivery.product}</dd></div>}{delivery.liters !== null && <div><dt>Объём</dt><dd>{delivery.liters} л</dd></div>}</dl><Timing planned={delivery.plannedAt} actual={delivery.actualAt}/>{delivery.notes && <p className="driver-note">{delivery.notes}</p>}</section>)}
  </article>
}

function Timing({ planned, actual }: { planned: string | null; actual: string | null }) {
  if (!planned && !actual) return null
  return <dl className="driver-cargo">{planned && <div><dt>Плановое время</dt><dd>{dateTimeLabel(planned)}</dd></div>}{actual && <div><dt>Фактическое время</dt><dd>{dateTimeLabel(actual)}</dd></div>}</dl>
}

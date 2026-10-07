import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, ArrowUpRight, CalendarDays, ChevronRight, LoaderCircle, LogOut, MapPin, RefreshCw, Route, Search, Truck, X } from 'lucide-react'
import type { AccountUser } from './auth-model'
import { apiFetch } from './workspace-api'
import DriverNotifications from './DriverNotifications'
import DriverLoadingActions from './DriverLoadingActions'
import type { DriverTrip } from './driver-trip-model'
import { driverDateTimeLabel } from './driver-trip-model'
import './driver.css'
import './driver-flow.css'

const dateLabel = (value: string | null) => {
  if (!value) return 'Дата не указана'
  const date = new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T12:00:00+03:00` : value)
  return Number.isNaN(date.getTime()) ? 'Дата не указана' : date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Moscow' })
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
  const [section, setSection] = useState<'active' | 'archive'>('active')
  const [selectedId, setSelectedId] = useState<string | null>(tripFromHash)
  const [selected, setSelected] = useState<DriverTrip | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)
  const [detailError, setDetailError] = useState('')
  const [revision, setRevision] = useState(0)
  const sequence = useRef(0)
  const detailSequence = useRef(0)
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
    const generation = ++detailSequence.current
    setSelected(previous => previous?.id === selectedId ? previous : null)
    setDetailError('')
    if (!selectedId) { setDetailLoading(false); return }
    const pending = new AbortController()
    setDetailLoading(true)
    void apiFetch(`/api/driver/trips/${encodeURIComponent(selectedId)}`, { cache: 'no-store', signal: pending.signal }).then(async response => {
      const result = await response.json()
      if ([401, 403, 404].includes(response.status) && !pending.signal.aborted && generation === detailSequence.current) setSelected(null)
      if (!response.ok) throw new Error(response.status === 404 ? 'Рейс не найден или больше не назначен вам.' : result.error || 'Не удалось открыть рейс.')
      if (!pending.signal.aborted && generation === detailSequence.current) setSelected(result.trip)
    }).catch(reason => { if (!pending.signal.aborted && generation === detailSequence.current) setDetailError(reason instanceof Error ? reason.message : 'Нет связи с сервером.') })
      .finally(() => { if (!pending.signal.aborted && generation === detailSequence.current) setDetailLoading(false) })
    return () => pending.abort()
  }, [selectedId, revision])

  const updateTrip = (trip: DriverTrip) => {
    detailSequence.current++
    setSelected(trip); setDetailLoading(false); setDetailError('')
    setTrips(previous => previous.map(item => item.id === trip.id ? trip : item))
  }
  const normalizedQuery = query.trim().toLocaleLowerCase('ru')
  const visible = trips.filter(trip => (section === 'archive' ? trip.archived === true : trip.archived !== true) && [trip.date, dateLabel(trip.date), trip.vehiclePlate, trip.loadingAddress, ...trip.deliveries.flatMap(delivery => [delivery.number, delivery.customer, delivery.address, delivery.product])].some(value => value?.toLocaleLowerCase('ru').includes(normalizedQuery)))

  return <div className="driver-shell">
    <a className="skip-link" href="#driver-content" onClick={event => { event.preventDefault(); document.getElementById('driver-content')?.focus() }}>К содержимому</a>
    <header className="driver-topbar"><a href="#driver-trips" className="driver-brand"><Route size={24}/><span>Артэль<small>Кабинет водителя</small></span></a><button className="button" onClick={onLogout}><LogOut size={17}/><span>Выйти</span></button></header>
    <main id="driver-content" tabIndex={-1} className="driver-content">
      <div className="driver-heading"><div><p>{user.name}</p><h1>Мои рейсы</h1></div><div className="driver-heading-actions"><DriverNotifications userId={user.id}/><button className="button driver-refresh" aria-label="Обновить мои рейсы" disabled={loading || detailLoading} onClick={refresh}><RefreshCw size={17} className={loading ? 'spin' : ''}/><span>Обновить</span></button></div></div>
      <p className="driver-intro">Рейсы и доставки, назначенные вам логистом.</p>
      {selectedId ? <>
        <a className="button driver-back" href="#driver-trips"><ArrowLeft size={16}/>Все мои рейсы</a>
        {detailLoading && !selected && <div className="driver-empty" role="status"><LoaderCircle size={24} className="spin"/><p>Открываем рейс…</p></div>}
        {detailError && <p className="driver-error" role="alert">{detailError}</p>}
        {selected && <TripDetail key={selected.id} trip={selected} onUpdated={updateTrip}/>}
      </> : <>
        <div className="driver-sections" role="group" aria-label="Разделы рейсов"><button type="button" aria-pressed={section === 'active'} className={section === 'active' ? 'is-active' : ''} onClick={() => setSection('active')}>Активные</button><button type="button" aria-pressed={section === 'archive'} className={section === 'archive' ? 'is-active' : ''} onClick={() => setSection('archive')}>Архивные</button></div>
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
          {!visible.length && <div className="driver-empty"><Truck size={30}/><h2>{query ? 'Ничего не найдено' : section === 'archive' ? 'Архивных рейсов пока нет' : 'Активных рейсов пока нет'}</h2><p>{query ? 'Попробуйте другой адрес, дату или имя клиента.' : section === 'archive' ? 'Здесь появятся рейсы после подтверждённого завершения отправки документов по всем доставкам.' : 'Когда логист назначит вам рейс, он появится здесь.'}</p></div>}
        </>}
      </>}
    </main>
  </div>
}

function TripDetail({ trip, onUpdated }: { trip: DriverTrip; onUpdated: (trip: DriverTrip) => void }) {
  return <article className="driver-trip-detail">
    <header className="driver-detail-heading"><h2>Рейс · {dateLabel(trip.date)}</h2>{trip.vehiclePlate && <p className="driver-vehicle"><Truck size={18}/>{trip.vehiclePlate}</p>}</header>
    <section className="driver-stop"><div className="driver-stop-heading"><span className="driver-stop-marker"><Truck size={18}/></span><h3>Место погрузки</h3></div>{trip.supplier && <p className="driver-stop-party">{trip.supplier}</p>}<Address address={trip.loadingAddress} mapUrl={trip.loadingMapUrl}/><Timing actual={trip.flowVersion === 'driver-v1' ? null : trip.loadingActualAt}/>{trip.notes && <p className="driver-note">{trip.notes}</p>}</section>
    {trip.flowVersion === 'driver-v1' && <DriverLoadingActions trip={trip} onUpdated={onUpdated}/>}
    <div className="driver-deliveries-heading"><h3>Доставки</h3><span>{trip.deliveries.length}</span></div>
    {trip.deliveries.map((delivery, index) => <section key={delivery.id} className="driver-stop"><div className="driver-stop-heading"><span className="driver-stop-marker">{index + 1}</span><h3>{delivery.customer || `Доставка ${index + 1}`}</h3>{delivery.number && <small>№ {delivery.number}</small>}</div><Address address={delivery.address} mapUrl={delivery.mapUrl}/><dl className="driver-cargo">{delivery.product && <div><dt>Груз</dt><dd>{delivery.product}</dd></div>}{delivery.liters !== null && <div><dt>Объём</dt><dd>{delivery.liters} л</dd></div>}{delivery.netTonnes && <div><dt>Масса нетто</dt><dd>{delivery.netTonnes.replace('.', ',')} т</dd></div>}</dl><Timing actual={delivery.actualAt}/>{delivery.notes && <p className="driver-note">{delivery.notes}</p>}</section>)}
  </article>
}

function Timing({ actual }: { actual: string | null }) {
  if (!actual) return null
  return <dl className="driver-cargo"><div><dt>Фактическое время</dt><dd>{driverDateTimeLabel(actual)}</dd></div></dl>
}

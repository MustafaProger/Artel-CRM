import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, LoaderCircle, Pencil, Plus, RefreshCw, Search, Send, Truck } from 'lucide-react'
import type { ShipmentTrip, Snapshot } from './model'
import ShipmentTripEditor from './ShipmentTripEditor'
import { safeMapUrl } from './TripLocationPicker'
import { formatDate, number } from './utils'
import type { SabyTripResponse } from './saby-model'
import './shipments.css'
import './trips.css'

const statuses: Record<string, string> = {
  unconfigured: 'Подключение не настроено', ready: 'Готов к передаче', pending: 'Передача выполняется',
  unknown: 'Результат требует проверки', draft: 'Создано в Saby, ожидает подписания',
  error: 'Ошибка передачи', partial: 'Передана часть доставок', sent: 'Передача подтверждена',
}

function SabyPanel({ tripId }: { tripId: string }) {
  const [result, setResult] = useState<SabyTripResponse | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const lock = useRef(false)
  const perform = async (method: 'GET' | 'POST') => {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const response = await fetch(`/api/shipment-trips/${encodeURIComponent(tripId)}/saby`, { method, ...(method === 'POST' ? { headers: { 'Content-Type': 'application/json' }, body: '{}' } : {}) })
      const data = await response.json()
      if (data.saby) setResult(data)
      if (!response.ok) throw new Error(data.error || 'Не удалось получить результат Saby')
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Нет связи с сервером') }
    finally { lock.current = false; setBusy(false) }
  }
  useEffect(() => { void perform('GET') }, [tripId])
  const status = result?.saby.status
  return <section className="trip-saby-panel" aria-label="Передача рейса в Saby" aria-busy={busy}>
    <div className="trip-saby-heading"><strong>Saby · {status ? statuses[status] ?? status : busy ? 'Проверяем состояние…' : 'Состояние не получено'}</strong><button className="button" disabled={busy} onClick={() => void perform('GET')}><RefreshCw size={15}/>Проверить статус</button></div>
    {result?.readiness?.blockers?.length ? <div className="trip-saby-blockers"><p>Для передачи нужно:</p><ul>{result.readiness.blockers.map((blocker, index) => <li key={index}>{blocker}</li>)}</ul></div> : null}
    {result?.saby.lastError && <p className="shipment-error">{result.saby.lastError}</p>}
    {error && <p className="shipment-error" role="alert">{error}</p>}
    {!!result?.saby.documents?.length && <ul className="trip-saby-documents">{result.saby.documents.map((document, index) => <li key={`${document.shipmentId}-${index}`}><span>Доставка {index + 1} · {statuses[document.status] ?? document.status}{document.id && <small>ID: {document.id}</small>}{document.lastError && <small>{document.lastError}</small>}</span>{safeMapUrl(document.url) && <a href={safeMapUrl(document.url)!} target="_blank" rel="noreferrer">Открыть в Saby <ArrowUpRight size={14}/></a>}</li>)}</ul>}
    <div className="trip-saby-footer"><p>Рейс сохранён в CRM. Передача создаёт документы в Saby для дальнейшего оформления и подписания.</p><button className="button primary" disabled={busy || !result || !result.readiness?.ready || ['draft', 'sent'].includes(status ?? '')} onClick={() => void perform('POST')}>{busy ? <LoaderCircle className="spin" size={16}/> : <Send size={16}/>} {status === 'unknown' || status === 'pending' ? 'Сверить с Saby' : 'Передать в Saby'}</button></div>
  </section>
}

export default function TripsPage({ data, canManagePlaces, onChanged }: { data: Snapshot; canManagePlaces: boolean; onChanged: () => void }) {
  const [trips, setTrips] = useState<ShipmentTrip[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0), [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const [editor, setEditor] = useState<{ id?: string } | null>(null), [sabyId, setSabyId] = useState<string | null>(null), [notice, setNotice] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true); setError('')
    fetch('/api/shipment-trips', { signal: controller.signal }).then(async response => { const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Не удалось загрузить рейсы'); return result })
      .then(result => setTrips(result.trips))
      .catch(reason => { if (!controller.signal.aborted) { setTrips([]); setError(reason instanceof Error ? reason.message : 'Нет связи с сервером') } })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [refresh])
  const directories = data.directories
  if (!directories) return <p className="soft-notice">Не удалось загрузить справочники рейсов.</p>
  const companyName = (id: string | null) => data.companies.find(company => company.id === id)?.name ?? 'Не указано'
  const driverName = (id: string | null) => directories.drivers.find(driver => driver.id === id)?.name ?? 'Не указан'
  const filtered = trips.filter(trip => [trip.fields.date, companyName(trip.fields.supplier_id), driverName(trip.fields.driver_id), trip.fields.trip_notes, ...trip.customers.map(customer => companyName(customer.fields.customer_id))].join(' ').toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
  const lastPage = Math.max(0, Math.ceil(filtered.length / 20) - 1), currentPage = Math.min(page, lastPage)
  return <div className="trips-page">
    <div className="trips-toolbar"><label className="shipment-search"><Search size={17}/><input aria-label="Поиск рейса" placeholder="Клиент, поставщик, водитель…" value={query} onChange={event => { setQuery(event.target.value); setPage(0) }}/></label><button className="button primary" onClick={() => setEditor({})}><Plus size={17}/>Новый рейс</button></div>
    <p className="trips-description">Один рейс объединяет машину и доставки клиентам. Сохранённые доставки сразу доступны в «Отгрузках».</p>
    {notice && <p className="directory-notice" role="status">{notice}</p>}
    {error && <div className="shipment-error" role="alert">{error} <button className="button" onClick={() => setRefresh(value => value + 1)}>Повторить загрузку</button></div>}
    {loading ? <div className="shipment-trip-loading" role="status"><LoaderCircle className="spin" size={22}/>Загружаем рейсы…</div> : <>
      <div className="trips-list">{filtered.slice(currentPage * 20, (currentPage + 1) * 20).map(trip => {
        const vehicle = directories.vehicles.find(item => item.id === trip.fields.vehicle_id)
        return <article className="panel trip-card" key={trip.id} data-testid="trip-card">
          <header className="trip-card-heading"><div><h2><Truck size={20}/>{formatDate(trip.fields.date)}</h2><p>{driverName(trip.fields.driver_id)} · {vehicle?.plate ?? 'Автомобиль не указан'}</p></div><button className="button" onClick={() => setEditor({ id: trip.id })}><Pencil size={15}/>Изменить рейс</button></header>
          <div className="trip-origin"><span>Погрузка</span><strong>{companyName(trip.fields.supplier_id)}</strong>{trip.fields.loading_address && <p>{trip.fields.loading_address}</p>}{safeMapUrl(trip.fields.loading_map_url) && <a target="_blank" rel="noreferrer" href={safeMapUrl(trip.fields.loading_map_url)!}>Яндекс.Карты <ArrowUpRight size={13}/></a>}</div>
          <ol className="trip-deliveries">{trip.customers.map(customer => <li key={customer.id}><div><strong>{companyName(customer.fields.customer_id)}</strong><p>{customer.fields.unloading_address || 'Место доставки не выбрано'}</p>{customer.fields.invoice_not_required === 'true' && <small className="trip-invoice-badge">Счёт не нужен</small>}{customer.fields.delivery_notes && <p>{customer.fields.delivery_notes}</p>}{safeMapUrl(customer.fields.unloading_map_url) && <a href={safeMapUrl(customer.fields.unloading_map_url)!} target="_blank" rel="noreferrer">Яндекс.Карты <ArrowUpRight size={13}/></a>}</div><div className="trip-delivery-amount"><strong>{number(customer.fields.quantity_litres)} л</strong><small>Доставка {number(customer.fields.transport_amount, 2)} ₽</small></div></li>)}</ol>
          {trip.fields.trip_notes && <p className="trip-card-notes">{trip.fields.trip_notes}</p>}
          <footer className="trip-card-footer"><span>Доставок: {trip.customers.length} · {number(trip.fields.quantity_tonnes, 3)} т</span><button className="button" aria-expanded={sabyId === trip.id} onClick={() => setSabyId(current => current === trip.id ? null : trip.id)}><Send size={15}/>Saby</button></footer>
          {sabyId === trip.id && <SabyPanel tripId={trip.id}/>}
        </article>
      })}</div>
      {!filtered.length && !error && <div className="panel trips-empty"><Truck size={30}/><h2>{query ? 'Рейсы не найдены' : 'Рейсов пока нет'}</h2><p>{query ? 'Измените поисковый запрос.' : 'Добавьте машину, места погрузки и доставки, затем клиентов.'}</p></div>}
      {!!filtered.length && <div className="pagination"><span>Рейсов: {filtered.length}</span><div><button className="icon-button" aria-label="Предыдущая страница рейсов" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18}/></button><span>{currentPage + 1} / {lastPage + 1}</span><button className="icon-button" aria-label="Следующая страница рейсов" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}><ChevronRight size={18}/></button></div></div>}
    </>}
    {editor && <ShipmentTripEditor shipment={null} tripId={editor.id} tripMode companies={data.companies} directories={directories} canManagePlaces={canManagePlaces} onDirectoriesChanged={onChanged} onClose={() => { setEditor(null); if (editor.id) setRefresh(value => value + 1) }} onSaved={shipment => { setEditor(null); setNotice(editor.id ? 'Рейс обновлён. Изменения сохранены в «Отгрузках».' : 'Рейс сохранён. Доставки клиентов добавлены в «Отгрузки».'); setRefresh(value => value + 1); onChanged(); setSabyId(shipment.fields.trip_id ?? null) }}/>}
  </div>
}

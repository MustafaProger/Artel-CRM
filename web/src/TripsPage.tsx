import { apiFetch as fetch } from './workspace-api'
import { useEffect, useRef, useState } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, LoaderCircle, Pencil, Plus, Search, Send, Trash2, Truck } from 'lucide-react'
import type { ShipmentTrip, DirectoryData } from './model'
import ShipmentTripEditor from './ShipmentTripEditor'
import { safeMapUrl } from './TripLocationPicker'
import { formatDate, number } from './utils'
import TripEtrnPanel from './TripEtrnPanel'
import type { TripSabyResponse } from './trip-saby-model'
import type { SabyTripResponse } from './saby-model'
import type { EtrnTripResponse } from './etrn-api-model'
import { readIntermediateStops } from './trip-route'
import './shipments.css'
import './trips.css'

export default function TripsPage({ data, canManagePlaces, onChanged, allowDelete = false }: { data: DirectoryData; canManagePlaces: boolean; onChanged: () => void; allowDelete?: boolean }) {
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
  const [deleting, setDeleting] = useState<string | null>(null)
  const directories = data.directories
  if (!directories) return <p className="soft-notice">Не удалось загрузить справочники рейсов.</p>
  const companyName = (id: string | null) => data.companies.find(company => company.id === id)?.name ?? 'Не указано'
  const driverName = (id: string | null) => directories.drivers.find(driver => driver.id === id)?.name ?? 'Не указан'
  const filtered = trips.filter(trip => [trip.fields.date, companyName(trip.fields.supplier_id), driverName(trip.fields.driver_id), trip.fields.trip_notes, ...trip.customers.map(customer => companyName(customer.fields.customer_id))].join(' ').toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
  const lastPage = Math.max(0, Math.ceil(filtered.length / 20) - 1), currentPage = Math.min(page, lastPage)
  return <div className="trips-page">
    <div className="trips-toolbar"><label className="shipment-search"><Search size={17}/><input aria-label="Поиск рейса" placeholder="Клиент, поставщик, водитель…" value={query} onChange={event => { setQuery(event.target.value); setPage(0) }}/></label><button className="button primary" onClick={() => setEditor({})}><Plus size={17}/>Новый рейс</button></div>
    {notice && <p className="directory-notice" role="status">{notice}</p>}
    {error && <div className="shipment-error" role="alert">{error} <button className="button" onClick={() => setRefresh(value => value + 1)}>Повторить загрузку</button></div>}
    {loading ? <div className="shipment-trip-loading" role="status"><LoaderCircle className="spin" size={22}/>Загружаем рейсы…</div> : <>
      <div className="trips-list">{filtered.slice(currentPage * 20, (currentPage + 1) * 20).map(trip => {
        const vehicle = directories.vehicles.find(item => item.id === trip.fields.vehicle_id)
        return <article className="panel trip-card" key={trip.id} data-testid="trip-card">
          <header className="trip-card-heading"><div><h2><Truck size={20}/>{formatDate(trip.fields.date)}</h2><p>{driverName(trip.fields.driver_id)} · {vehicle?.plate ?? 'Автомобиль не указан'}</p></div><button className="button" onClick={() => setEditor({ id: trip.id })}><Pencil size={15}/>Изменить рейс</button></header>
          <div className="trip-origin"><span>Погрузка</span><strong>{companyName(trip.fields.supplier_id)}</strong>{trip.fields.loading_address && <p>{trip.fields.loading_address}</p>}{safeMapUrl(trip.fields.loading_map_url) && <a target="_blank" rel="noreferrer" href={safeMapUrl(trip.fields.loading_map_url)!}>Яндекс.Карты <ArrowUpRight size={13}/></a>}</div>
          <ol className="trip-deliveries">{trip.customers.flatMap(customer => [<li key={customer.id}><div><strong>{companyName(customer.fields.customer_id)}</strong><p>{customer.fields.unloading_address || 'Место доставки не выбрано'}</p>{customer.fields.invoice_not_required === 'true' && <small className="trip-invoice-badge">Счёт не нужен</small>}{customer.fields.delivery_notes && <p>{customer.fields.delivery_notes}</p>}{safeMapUrl(customer.fields.unloading_map_url) && <a href={safeMapUrl(customer.fields.unloading_map_url)!} target="_blank" rel="noreferrer">Яндекс.Карты <ArrowUpRight size={13}/></a>}</div><div className="trip-delivery-amount"><strong>{number(customer.fields.quantity_litres)} л</strong><small>Доставка {number(customer.fields.transport_amount, 2)} ₽</small></div></li>, ...readIntermediateStops(customer.fields.intermediate_stops_after).map(stop => <li className="trip-intermediate-stop" key={`${customer.id}-${stop.id}`}><div><small>Промежуточная остановка</small><strong>{stop.name}</strong><p>{stop.address}</p></div></li>)])}</ol>
          {trip.fields.trip_notes && <p className="trip-card-notes">{trip.fields.trip_notes}</p>}
          <footer className="trip-card-footer">{allowDelete && <button className="icon-button" aria-label={`Удалить рейс ${trip.id}`} title="Удалить рейс" onClick={() => setDeleting(trip.id)}><Trash2 size={16}/></button>}<span>Доставок: {trip.customers.length} · {number(trip.fields.quantity_tonnes, 3)} т</span><button className="button" aria-expanded={sabyId === trip.id} onClick={() => setSabyId(current => current === trip.id ? null : trip.id)}><Send size={15}/>Saby</button></footer>
          {sabyId === trip.id && <TripEtrnPanel trip={trip} data={data}/>}
        </article>
      })}</div>
      {!filtered.length && !error && <div className="panel trips-empty"><Truck size={30}/><h2>{query ? 'Рейсы не найдены' : 'Рейсов пока нет'}</h2>{query && <p>Измените поисковый запрос.</p>}</div>}
      {!!filtered.length && <div className="pagination"><span>Рейсов: {filtered.length}</span><div><button className="icon-button" aria-label="Предыдущая страница рейсов" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18}/></button><span>{currentPage + 1} / {lastPage + 1}</span><button className="icon-button" aria-label="Следующая страница рейсов" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}><ChevronRight size={18}/></button></div></div>}
    </>}
    {deleting && allowDelete && <DeleteTripDialog tripId={deleting} data={data} onClose={() => setDeleting(null)} onDeleted={() => { setDeleting(null); setNotice('Рейс и его доставки удалены.'); setRefresh(value => value + 1); onChanged() }}/> }
    {editor && <ShipmentTripEditor shipment={null} tripId={editor.id} tripMode companies={data.companies} directories={directories} canManagePlaces={canManagePlaces} onDirectoriesChanged={onChanged} onClose={() => { setEditor(null); if (editor.id) setRefresh(value => value + 1) }} onSaved={shipment => { setEditor(null); setNotice(editor.id ? 'Рейс обновлён. Изменения сохранены в «Отгрузках».' : 'Рейс сохранён. Доставки клиентов добавлены в «Отгрузки».'); setRefresh(value => value + 1); onChanged(); setSabyId(shipment.fields.trip_id ?? null) }}/>}
  </div>
}


function DeleteTripDialog({ tripId, data, onClose, onDeleted }: { tripId: string; data: DirectoryData; onClose: () => void; onDeleted: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), inFlight = useRef(false)
  const [trip, setTrip] = useState<ShipmentTrip | null>(null), [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [blocked, setBlocked] = useState(false), [reload, setReload] = useState(0)
  useEffect(() => {
    const element = dialog.current, focused = document.activeElement as HTMLElement | null
    element?.showModal()
    return () => { element?.close(); focused?.focus() }
  }, [])
  useEffect(() => {
    const controller = new AbortController(), endpoint = `/api/shipment-trips/${encodeURIComponent(tripId)}`
    setLoading(true); setError(''); setTrip(null); setBlocked(false)
    const read = async (suffix: string) => {
      const response = await fetch(`${endpoint}${suffix}`, { signal: controller.signal })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось проверить рейс перед удалением.')
      return result
    }
    void Promise.all([read(''), read('/saby-workflow'), read('/saby'), read('/etrn')]).then(([current, workflow, legacy, etrn]: [{ trip: ShipmentTrip }, TripSabyResponse, SabyTripResponse, EtrnTripResponse]) => {
      if (controller.signal.aborted) return
      setTrip(current.trip)
      setBlocked(workflow.locked || legacy.saby.documents.some(doc => doc.status !== 'error' || !!doc.id) || etrn.deliveries.some(delivery => delivery.document && (delivery.document.status !== 'error' || !!delivery.document.id)))
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось проверить рейс.') })
      .finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [tripId, reload])
  const remove = async () => {
    if (inFlight.current || loading || !trip || blocked || error) return
    inFlight.current = true; setSaving(true); setError('')
    try {
      const response = await fetch(`/api/shipment-trips/${encodeURIComponent(tripId)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось удалить рейс.')
      onDeleted()
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Ответ не получен. Обновите состав рейса перед повтором.') }
    finally { inFlight.current = false; setSaving(false) }
  }
  return <dialog ref={dialog} className="shipment-delete-dialog" aria-labelledby="trip-delete-title" onCancel={event => { event.preventDefault(); if (!inFlight.current) onClose() }}>
    <h2 id="trip-delete-title">Удалить рейс целиком?</h2>
    {loading ? <p role="status">Проверяем состав рейса и документы Saby…</p> : trip && <><p>{formatDate(trip.fields.date)} · доставок: {trip.customers.length}</p><div className="shipment-delete-details">{trip.customers.map(row => <span key={row.id}>{data.companies.find(company => company.id === row.fields.customer_id)?.name || 'Клиент'} · {number(row.fields.quantity_litres, 2)} л</span>)}</div>{blocked ? <p className="shipment-error" role="alert">Рейс связан с документами Saby. Удаление запрещено до сверки документов.</p> : <p>Рейс и все его доставки будут удалены из общего учёта CRM.</p>}</>}
    {error && <div className="shipment-error" role="alert">{error}<button className="button" disabled={loading || saving} onClick={() => setReload(value => value + 1)}>Обновить состав</button></div>}
    <footer><button type="button" className="button" disabled={saving} onClick={onClose} autoFocus>Отмена</button><button type="button" className="button danger" disabled={loading || saving || !trip || blocked || !!error} onClick={() => void remove()}>{saving ? <LoaderCircle size={17} className="spin"/> : <Trash2 size={17}/>}Удалить рейс</button></footer>
  </dialog>
}

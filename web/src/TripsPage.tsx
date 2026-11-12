import { useDirectAction } from './useDirectAction'
import { useViewEntrance } from './useViewEntrance'
import LoadingSkeleton, { LoadingProgress } from './LoadingSkeleton'
import { TripIssueLabel } from './TripWorkflowAlert'
import TripProcessPanel from './TripProcessPanel'
import { Activity } from 'lucide-react'
import { tripLabel } from './trip-identity'
import './trip-identity.css'
import { apiFetch as fetch } from './workspace-api'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpRight, ChevronLeft, ChevronRight, ClipboardList, Map as MapIcon, Pencil, Plus, Search, Send, Truck } from 'lucide-react'
import type { ShipmentTrip, DirectoryData, Company, ShipmentAddress } from './model'
import type { TripRequest } from './trip-request-model'
import type { SharedTripTimeline } from './trip-process-model'
import ScrollableSegments from './ScrollableSegments'
import TripRequestsPanel from './TripRequestsPanel'
type RequestsMapComponent = typeof import('./TripRequestsMap').default
let readyRequestsMap: RequestsMapComponent | null = null
let requestsMapModule: Promise<RequestsMapComponent> | null = null
function loadRequestsMap() {
  if (!requestsMapModule) requestsMapModule = import('./TripRequestsMap').then(module => {
    readyRequestsMap = module.default
    return module.default
  }).catch(reason => { requestsMapModule = null; throw reason })
  return requestsMapModule
}
import TripRequestEditor from './TripRequestEditor'
import './trip-requests.css'
import ShipmentTripEditor from './ShipmentTripEditor'
import { mapLink } from './map-link'
import { creationTime, formatDate, number } from './utils'
import TripEtrnPanel from './TripEtrnPanel'
import type { TripSabyAutomationCapability } from './trip-saby-model'
import { readIntermediateStops } from './trip-route'
import { compareTripsNewestFirst } from './trip-order'
import './shipments.css'
import './trips.css'

export default function TripsPage({ data, canManagePlaces, onChanged, allowDelete = false }: { data: DirectoryData; canManagePlaces: boolean; onChanged: () => void; allowDelete?: boolean }) {
  const issueVersions = useRef(new Map<string, number>())
  const updateWorkflowIssues = useCallback((tripId: string, issues: import('./trip-workflow-issues').TripWorkflowIssue[]) => {
    issueVersions.current.set(tripId, (issueVersions.current.get(tripId) ?? 0) + 1)
    setTrips(current => current.map(trip => trip.id === tripId ? { ...trip, workflowIssues: issues } : trip))
  }, [])
  const [mapRequest, setMapRequest] = useState<TripRequest | null>(null)
  const [view, setView] = useState<'requests' | 'map' | 'trips' | 'process'>('requests')
  const viewEntrance = useViewEntrance<HTMLDivElement>(view, '.trip-requests-panel, .trips-page-map > section, .trips-toolbar, .trips-list, .trips-empty, .trip-process')
  const [RequestsMap, setRequestsMap] = useState<RequestsMapComponent | null>(() => readyRequestsMap)
  const [mapLoadError, setMapLoadError] = useState(''), [mapLoadRevision, setMapLoadRevision] = useState(0)
  // Load the map module alongside its data. One outer placeholder remains mounted
  // until both are ready, regardless of which request finishes first.
  useEffect(() => {
    if (view !== 'map' || RequestsMap) return
    let active = true
    setMapLoadError('')
    void loadRequestsMap().then(component => {
      if (active) setRequestsMap(() => component)
    }).catch(() => { if (active) setMapLoadError('Не удалось загрузить карту. Повторите попытку.') })
    return () => { active = false }
  }, [view, RequestsMap, mapLoadRevision])
  const [tripsLoaded, setTripsLoaded] = useState(false), [requestsLoaded, setRequestsLoaded] = useState(false)
  const [requests, setRequests] = useState<TripRequest[]>([]), [requestsLoading, setRequestsLoading] = useState(true), [requestsError, setRequestsError] = useState('')
  const [requestCompanies, setRequestCompanies] = useState<Company[]>([]), [requestAddresses, setRequestAddresses] = useState<ShipmentAddress[]>([])
  const [sharedTrips, setSharedTrips] = useState<SharedTripTimeline[]>([])
  const [trips, setTrips] = useState<ShipmentTrip[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [refresh, setRefresh] = useState(0), [requestRefresh, setRequestRefresh] = useState(0), [query, setQuery] = useState(''), [page, setPage] = useState(0)
  const [editor, setEditor] = useState<{ id?: string } | null>(null), [sabyIds, setSabyIds] = useState<ReadonlySet<string>>(() => new Set()), [notice, setNotice] = useState('')
  const [automation, setAutomation] = useState<TripSabyAutomationCapability | undefined>(undefined)
  useEffect(() => {
    if (view !== 'trips' && view !== 'process') return
    const controller = new AbortController()
    let inFlight = false, hasList = false
    const load = async (background = false) => {
      if (inFlight || controller.signal.aborted) return
      inFlight = true
      const versions = new Map(issueVersions.current)
      if (!background) { setLoading(true); setError('') }
      try {
        const path = view === 'process' ? '/api/shipment-trips?view=process' : '/api/shipment-trips'
        const response = await fetch(path, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(20_000)]) })
        const result = await response.json()
        if (!response.ok) {
          if ([401, 403].includes(response.status) && !controller.signal.aborted) {
            setTrips([])
            setSharedTrips([])
            setTripsLoaded(false)
            setError(result.error || 'Доступ к рейсам недоступен.')
          }
          throw new Error(result.error || 'Не удалось загрузить рейсы')
        }
        if (controller.signal.aborted) return
        const indicatorsOnly = background && hasList && view === 'trips'
        hasList = true
        setTripsLoaded(true)
        if (view === 'process') setSharedTrips(result.sharedTrips ?? [])
        setTrips(previous => {
          const fresh = new Map((result.trips as ShipmentTrip[]).map(trip => [trip.id, trip]))
          // Updating indicators must not reorder cards, unmount open panels or
          // replace a more recent verdict already returned by an expanded panel.
          if (indicatorsOnly) return previous.map(trip => {
            const row = fresh.get(trip.id)
            return row && versions.get(trip.id) === issueVersions.current.get(trip.id) ? { ...trip, workflowIssues: row.workflowIssues } : trip
          })
          const old = new Map(previous.map(trip => [trip.id, trip]))
          return (result.trips as ShipmentTrip[]).map(trip => {
            const saved = old.get(trip.id)
            return { ...trip,
              ...(saved && versions.get(trip.id) !== issueVersions.current.get(trip.id) ? { workflowIssues: saved.workflowIssues } : {}),
              ...(saved?.execution && saved.execution.version > (trip.execution?.version ?? 0) ? { execution: saved.execution } : {}),
            }
          })
        })
        setAutomation(result.automation ?? { enabled: false })
        setError('')
      } catch (reason) {
        if (!controller.signal.aborted && !background) { setError(reason instanceof Error ? reason.message : 'Нет связи с сервером') }
      } finally {
        inFlight = false
        if (!controller.signal.aborted && !background) setLoading(false)
      }
    }
    void load()
    const refreshVisible = () => { if (document.visibilityState === 'visible') void load(true) }
    const timer = window.setInterval(refreshVisible, 30000)
    document.addEventListener('visibilitychange', refreshVisible)
    window.addEventListener('focus', refreshVisible)
    return () => { controller.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', refreshVisible); window.removeEventListener('focus', refreshVisible) }
  }, [refresh, view])
  const requestGeneration = useRef(0)
  useEffect(() => {
    const generation = ++requestGeneration.current
    const controller = new AbortController()
    setRequestsLoading(true); setRequestsError('')
    void fetch('/api/trip-requests', { signal: controller.signal }).then(async response => { const result = await response.json(); if (!response.ok) { if ([401, 403].includes(response.status) && !controller.signal.aborted && generation === requestGeneration.current) { setRequests([]); setRequestCompanies([]); setRequestAddresses([]); setRequestsLoaded(false) } throw new Error(result.error || 'Не удалось загрузить заявки.') } return result })
      .then(result => { if (!controller.signal.aborted && generation === requestGeneration.current) { setRequests(result.requests); setRequestsLoaded(true); setRequestCompanies(result.companies ?? []); setRequestAddresses(result.addresses ?? []) } })
      .catch(reason => { if (!controller.signal.aborted && generation === requestGeneration.current) { setRequestsError(reason instanceof Error ? reason.message : 'Нет связи с сервером') } })
      .finally(() => { if (!controller.signal.aborted && generation === requestGeneration.current) setRequestsLoading(false) })
    return () => controller.abort()
  }, [requestRefresh])
  // Apply only acknowledged server results. In-flight older lists cannot undo a save.
  const requestSaved = (saved: TripRequest) => {
    requestGeneration.current++
    setRequests(previous => saved.status === 'active' ? [...previous.filter(row => row.id !== saved.id), saved] : previous.filter(row => row.id !== saved.id))
    setRequestsLoaded(true); setRequestsLoading(false); setRequestsError('')
  }
  const requestDeleted = (id: string) => {
    requestGeneration.current++
    setRequests(previous => previous.filter(row => row.id !== id))
    setRequestsLoaded(true); setRequestsLoading(false); setRequestsError('')
  }
  const reloadRequests = () => setRequestRefresh(value => value + 1)
  const reloadAll = () => { setRefresh(value => value + 1); reloadRequests() }
  const removal = useDirectAction()
  const remove = (trip: ShipmentTrip) => removal.run(trip.id, async () => {
    const response = await fetch(`/api/shipment-trips/${encodeURIComponent(trip.id)}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) }) })
    const result = await response.json()
    if (!response.ok) { setRefresh(value => value + 1); throw new Error(result.error || 'Не удалось удалить рейс.') }
    setNotice('Рейс и его доставки удалены.')
    reloadAll()
    await onChanged()
  })
  const directories = data.directories
  const companyNames = useMemo(() => new Map([...requestCompanies, ...data.companies].map(company => [company.id, company.name])), [data.companies, requestCompanies])
  const driverNames = useMemo(() => new Map(directories?.drivers.map(driver => [driver.id, driver.name])), [directories?.drivers])
  if (!directories) return <p className="soft-notice">Не удалось загрузить справочники рейсов.</p>
  const companyName = (id: string | null) => (id ? companyNames.get(id) : undefined) ?? 'Не указано'
  const driverName = (id: string | null) => (id ? driverNames.get(id) : undefined) ?? 'Не указан'
  const filtered = view !== 'trips' ? [] : trips.filter(trip => [tripLabel(trip), trip.fields.date, companyName(trip.fields.supplier_id), driverName(trip.fields.driver_id), trip.fields.trip_notes, ...trip.customers.map(customer => companyName(customer.fields.customer_id))].join(' ').toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))).sort(compareTripsNewestFirst)
  const lastPage = Math.max(0, Math.ceil(filtered.length / 20) - 1), currentPage = Math.min(page, lastPage)
  return <div ref={viewEntrance} className={`trips-page${view === 'map' ? ' trips-page-map' : ''}`}>
    <ScrollableSegments className="trips-section-tabs" label="Разделы рейсов" value={view}>{([{ id: 'requests', name: 'Заявки', icon: ClipboardList }, { id: 'map', name: 'Карта', icon: MapIcon }, { id: 'trips', name: 'Рейсы', icon: Truck }, { id: 'process', name: 'В процессе', icon: Activity }] as const).map(item => <button type="button" className={`button ${item.id === view ? 'primary' : ''}`} key={item.id} aria-pressed={item.id === view} onClick={() => { if (item.id === view) return; setView(item.id); setNotice(''); reloadRequests() }}><item.icon size={17} aria-hidden="true"/>{item.name}</button>)}</ScrollableSegments>
    {view === 'process' && <TripProcessPanel trips={trips} sharedTrips={sharedTrips} data={data} loading={loading} loaded={tripsLoaded} error={error} onReload={() => setRefresh(value => value + 1)}/>}
    {view === 'requests' && <TripRequestsPanel requests={requests} loading={requestsLoading} loaded={requestsLoaded} error={requestsError} companies={requestCompanies} directories={{ ...directories, addresses: requestAddresses, assignedCustomerIds: undefined }} onReload={reloadRequests} onSaved={requestSaved} onDeleted={requestDeleted}/>}
    {view === 'map' && <section aria-label="Карта заявок">
      {requestsError && <div className="shipment-error" role="alert">{requestsError}<button className="button" onClick={reloadRequests}>Повторить загрузку</button></div>}
      {mapLoadError && <div className="shipment-error" role="alert">{mapLoadError}<button className="button" onClick={() => { setMapLoadError(''); setMapLoadRevision(value => value + 1) }}>Повторить загрузку карты</button></div>}
      {!mapLoadError && (!requestsError || requests.length > 0) && (requestsLoading && !requestsLoaded || !RequestsMap ? <LoadingSkeleton variant="map" label="Загружаем карту заявок"/> : <RequestsMap requests={requests} addresses={requestAddresses} oilDepots={directories.oilDepots} onEditRequest={setMapRequest}/>)}
    </section>}
    {view === 'trips' && <><div className="trips-toolbar search-add-toolbar"><label className="shipment-search"><Search size={17}/><input aria-label="Поиск рейса" placeholder="Номер рейса, клиент, водитель…" value={query} onChange={event => { setQuery(event.target.value); setPage(0) }}/></label><button className="button primary mobile-icon-action" aria-label="Новый рейс" title="Новый рейс" onClick={() => setEditor({})}><Plus size={17} aria-hidden="true"/><span className="mobile-action-label">Новый рейс</span></button></div>
    {requestsError && <div className="shipment-error" role="alert">{requestsError} <button type="button" className="button" onClick={reloadRequests}>Повторить загрузку заявок</button></div>}
    {removal.error && <p className="shipment-error" role="alert">{removal.error}</p>}
    {notice && <p className="directory-notice" role="status">{notice}</p>}
    {error && <div className="shipment-error" role="alert">{error} <button className="button" onClick={() => setRefresh(value => value + 1)}>Повторить загрузку</button></div>}
    {loading && tripsLoaded && <LoadingProgress label="Обновляем рейсы"/>}
    {loading && !tripsLoaded ? <LoadingSkeleton variant="trips" label="Загружаем рейсы" rows={2}/> : <>
      <div className="trips-list">{filtered.slice(currentPage * 20, (currentPage + 1) * 20).map(trip => {
        const issues = trip.workflowIssues ?? []
        const vehicle = directories.vehicles.find(item => item.id === trip.fields.vehicle_id)
        return <article className={`panel trip-card${issues.length ? ' trip-has-error' : ''}`} key={trip.id} data-testid="trip-card">
          <header className="trip-card-heading"><div><div className="trip-identity-heading"><h2><Truck size={20}/>{tripLabel(trip)}</h2><span className="trip-identity-date">{formatDate(trip.fields.date)}</span></div><p>{driverName(trip.fields.driver_id)} · {vehicle?.plate ?? 'Автомобиль не указан'}</p></div><div className="trip-edit-action"><TripIssueLabel issues={issues} onClick={() => setSabyIds(current => new Set(current).add(trip.id))}/><button className="button trip-edit-button" aria-label="Изменить рейс" onClick={() => setEditor({ id: trip.id })}><Pencil size={15}/><span>Изменить<span className="trip-edit-context"> рейс</span></span></button></div></header>
          <div className="trip-origin"><span>Погрузка</span><strong>{companyName(trip.fields.supplier_id)}</strong>{trip.fields.loading_address && <p>{trip.fields.loading_address}</p>}<TripMapLink address={trip.fields.loading_address} mapUrl={trip.fields.loading_map_url}/></div>
          <ol className="trip-deliveries">{trip.customers.flatMap(customer => [<li key={customer.id}><div><strong>{customer.fields.customer_name || companyName(customer.fields.customer_id)}</strong><p>{customer.fields.unloading_address || 'Место доставки не выбрано'}</p>{customer.fields.invoice_not_required === 'true' && <small className="trip-invoice-badge">Счёт не нужен</small>}{customer.fields.etrn_not_required === 'true' && <small className="trip-invoice-badge">ЭТрН не нужна</small>}{customer.fields.delivery_notes && <p>{customer.fields.delivery_notes}</p>}<TripMapLink address={customer.fields.unloading_address} mapUrl={customer.fields.unloading_map_url}/></div><div className="trip-delivery-amount"><strong>{number(customer.fields.quantity_litres)} л</strong><small>Доставка {number(customer.fields.transport_amount, 2)} ₽</small></div></li>, ...readIntermediateStops(customer.fields.intermediate_stops_after).map(stop => <li className="trip-intermediate-stop" key={`${customer.id}-${stop.id}`}><div><small>Промежуточная остановка</small><strong>{stop.name}</strong><p>{stop.address}</p></div></li>)])}</ol>
          {trip.fields.trip_notes && <p className="trip-card-notes">{trip.fields.trip_notes}</p>}
          {trip.createdAt && <small className="trip-creation-meta">Создан: {trip.createdByName ?? 'автор неизвестен'} · <time dateTime={trip.createdAt}>{creationTime(trip.createdAt)}</time></small>}
          <footer className="trip-card-footer"><span>Доставок: {trip.customers.length} · {trip.fields.quantity_tonnes ? `${number(trip.fields.quantity_tonnes, 3)} т` : 'масса ожидает водителя'}</span><div className="trip-saby-action"><button className="button" aria-expanded={sabyIds.has(trip.id)} onClick={() => setSabyIds(current => { const next = new Set(current); if (next.has(trip.id)) next.delete(trip.id); else next.add(trip.id); return next })}><Send size={15}/>Saby</button></div></footer>
          {sabyIds.has(trip.id) && <TripEtrnPanel deleting={removal.pending === trip.id} onDelete={allowDelete && (!removal.pending || removal.pending === trip.id) ? () => void remove(trip) : undefined} trip={trip} data={data} onIssuesChange={updateWorkflowIssues}/>}
        </article>
      })}</div>
      {!filtered.length && !error && <div className="panel trips-empty"><Truck size={30}/><h2>{query ? 'Рейсы не найдены' : 'Рейсов пока нет'}</h2>{query && <p>Измените поисковый запрос.</p>}</div>}
      {!!filtered.length && <div className="pagination"><span>Рейсов: {filtered.length}</span><div><button className="icon-button" aria-label="Предыдущая страница рейсов" disabled={!currentPage} onClick={() => setPage(currentPage - 1)}><ChevronLeft size={18}/></button><span>{currentPage + 1} / {lastPage + 1}</span><button className="icon-button" aria-label="Следующая страница рейсов" disabled={currentPage === lastPage} onClick={() => setPage(currentPage + 1)}><ChevronRight size={18}/></button></div></div>}
    </>}
    </>}
    {mapRequest && <TripRequestEditor request={mapRequest} companies={requestCompanies} directories={{ ...directories, addresses: requestAddresses, assignedCustomerIds: undefined }} onClose={() => { setMapRequest(null); reloadRequests() }} onSaved={saved => { setMapRequest(null); requestSaved(saved) }}/>}
    {editor && <ShipmentTripEditor shipment={null} tripId={editor.id} tripMode sabyAutomation={automation} onRequestsChanged={reloadRequests} companies={data.companies} directories={directories} canManagePlaces={canManagePlaces} onDirectoriesChanged={onChanged} onClose={() => { setEditor(null); if (editor.id) setRefresh(value => value + 1) }} onSaved={shipment => { setEditor(null); if (!editor.id) { setPage(0); setQuery('') } setNotice(editor.id ? 'Рейс обновлён. Изменения сохранены в «Отгрузках».' : 'Рейс сохранён. Доставки клиентов добавлены в «Отгрузки».'); reloadAll(); onChanged(); setSabyIds(current => shipment.fields.trip_id ? new Set(current).add(shipment.fields.trip_id) : current) }}/>}
  </div>
}


function TripMapLink({ address, mapUrl }: { address: string | null; mapUrl: string | null }) {
  const link = mapLink({ address, mapUrl })
  return link ? <a href={link.href} target="_blank" rel="noreferrer">{link.label} <ArrowUpRight size={13}/></a> : null
}

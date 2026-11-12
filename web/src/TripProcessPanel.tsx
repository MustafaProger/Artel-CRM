import { useViewEntrance } from './useViewEntrance'
import LoadingSkeleton from './LoadingSkeleton'
import { TripIssueLabel } from './TripWorkflowAlert'
import { useState } from 'react'
import { Check, ChevronDown, MapPin, RefreshCw, Search, Truck } from 'lucide-react'
import type { DirectoryData, ShipmentTrip } from './model'
import { tripLabel } from './trip-identity'
import { compareTripsNewestFirst } from './trip-order'
import { formatDate, number } from './utils'
import { executionStageHint, executionStageLabel } from './trip-execution-model'
import TripExecutionAction, { ExecutionEvent } from './TripExecutionAction'
import ScrollableSegments from './ScrollableSegments'
import AnimatedDetails from './AnimatedDetails'
import TripCopyButton from './TripCopyButton'
import SharedTripTimelineCard from './SharedTripTimelineCard'
import type { SharedTripTimeline } from './trip-process-model'
import './trip-execution.css'

export default function TripProcessPanel({ trips, sharedTrips, data, loading, loaded, error, onReload }: {
  trips: ShipmentTrip[]; sharedTrips: SharedTripTimeline[]; data: DirectoryData; loading: boolean; loaded?: boolean; error: string; onReload: () => void
}) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'active' | 'completed' | 'all'>('active')
  const viewEntrance = useViewEntrance<HTMLElement>(filter, '.execution-context, .execution-fleet, .trips-empty')
  const [vehicleId, setVehicleId] = useState(''), [stage, setStage] = useState('')
  const name = (id: string | null) => data.companies.find(row => row.id === id)?.name || 'Клиент не указан'
  const driver = (id: string | null) => data.directories?.drivers.find(row => row.id === id)?.name || 'Водитель не указан'
  const rows = [...trips.map(trip => ({
    id: trip.id,
    date: trip.fields.date,
    createdAt: trip.createdAt,
    vehicle: trip.fields.vehicle_id || '',
    driver: driver(trip.fields.driver_id),
    stage: trip.execution?.stage,
    completed: !!trip.execution?.completed,
    total: trip.customers.length,
    done: trip.customers.filter(customer => trip.execution?.deliveries[customer.id]).length,
    search: [tripLabel(trip), ...trip.customers.map(customer => `${name(customer.fields.customer_id)} ${customer.fields.unloading_address || ''}`)],
    trip,
  })), ...sharedTrips.map(trip => ({
    id: trip.id,
    date: trip.date,
    createdAt: trip.createdAt,
    vehicle: trip.vehicleId || '',
    driver: driver(trip.driverId),
    stage: trip.stage,
    completed: !!trip.completedAt,
    total: trip.stops.filter(stop => stop.kind === 'delivery').length,
    done: trip.stops.filter(stop => stop.kind === 'delivery' && stop.event).length,
    search: [tripLabel(trip), ...trip.stops.map(stop => `${stop.name} ${stop.address || ''}`)],
    trip,
  }))]
  const active = rows.filter(row => !row.completed)
  const vehicles = [...new Set(rows.map(row => row.vehicle))]
    .map(id => ({ id, plate: data.directories?.vehicles.find(v => v.id === id)?.plate || 'Машина не указана' }))
    .sort((a, b) => a.plate.localeCompare(b.plate, 'ru'))
  const needle = query.trim().toLocaleLowerCase('ru')
  const groups = vehicles.filter(v => !vehicleId || v.id === vehicleId).map(vehicle => ({
    ...vehicle,
    visible: rows.filter(row => row.vehicle === vehicle.id)
      .filter(row => filter === 'all' || (filter === 'completed' ? row.completed : !row.completed))
      .filter(row => !stage || row.stage === stage)
      .filter(row => [vehicle.plate, row.driver, ...row.search].join(' ').toLocaleLowerCase('ru').includes(needle))
      .sort(compareTripsNewestFirst),
  })).filter(group => group.visible.length)
  const visibleCount = groups.reduce((n,g) => n + g.visible.length, 0)
  const changeFilter = (next: typeof filter) => { setFilter(next); setStage('') }
  return <section ref={viewEntrance} className="trip-process" aria-label="Процесс рейсов" aria-busy={loading}>
    <div className="execution-controls">
      <div className="execution-search-row"><label className="shipment-search"><Search size={17}/><input aria-label="Поиск машины или рейса" placeholder="Рейс, водитель, клиент или адрес" value={query} onChange={e => setQuery(e.target.value)}/></label><button className="button execution-refresh" aria-label="Обновить" title="Обновить" onClick={onReload} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/><span>Обновить</span></button><select aria-label="Машина" value={vehicleId} onChange={e => setVehicleId(e.target.value)}><option value="">Все машины</option>{vehicles.filter(v => v.id).map(v => <option key={v.id} value={v.id}>{v.plate}</option>)}</select><select aria-label="Этап рейса" value={stage} onChange={e => setStage(e.target.value)}><option value="">Все этапы</option>{Object.entries(executionStageLabel).filter(([key]) => key !== 'delivered' && (filter !== 'active' || key !== 'completed') && (filter !== 'completed' || key === 'completed')).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      <div className="execution-toolbar"><ScrollableSegments className="execution-filters" label="Статус рейсов" value={filter}>{([{ id: 'active', label: 'В работе', count: active.length }, { id: 'completed', label: 'Завершённые', count: rows.length-active.length }, { id: 'all', label: 'Все', count: rows.length }] as const).map(f => <button type="button" className="button" key={f.id} aria-pressed={filter === f.id} onClick={() => changeFilter(f.id)}>{f.label}<small>{f.count}</small></button>)}</ScrollableSegments><div className="execution-totals"><span><strong>{active.length}</strong> в работе</span><span><strong>{active.reduce((n, row) => n + row.total - row.done, 0)}</strong> доставок осталось</span></div></div>
    </div>
    <div className="execution-context"><span>Показано рейсов: {visibleCount}{loading ? ' · Обновляем…' : ' · Автообновление 30 с'}</span><AnimatedDetails className="execution-help" summary="Как работают статусы?"><div className="execution-help-body"><p>Водитель нажимает «Прибыл на место доставки» у нужного клиента. Сотрудник с доступом к рейсу может нажать «Завершить доставку». В истории сохраняются автор и время отметки.</p><dl>{(['planned','loading','enroute','delivering','completed'] as const).map(s => <div key={s}><dt>{executionStageLabel[s]}</dt><dd>{executionStageHint[s]}</dd></div>)}</dl><p>Последняя подтверждённая доставка автоматически завершает рейс. Документы СБИС и приёмка клиента в ЭТрН учитываются отдельно.</p><p>Если отметки нет, это не доказывает, что старый рейс фактически не выполнен.</p></div></AnimatedDetails></div>
    {error && <p className="shipment-error" role="alert">{error}</p>}
    {loading && !loaded && <LoadingSkeleton variant="process" label="Загружаем процесс рейсов"/>}
    <div className="execution-fleet">{groups.map(group => <article className="execution-vehicle" key={group.id}>
      <header><div><Truck size={19}/><h3>{group.plate}</h3></div><span>Рейсов: {group.visible.length}</span></header>
      <div className="execution-trip-list panel">{group.visible.map(({ trip, driver, done, total }) => {
        if ('stops' in trip) return <SharedTripTimelineCard key={trip.id} trip={trip} driver={driver} done={done} total={total}/>
        const execution = trip.execution
        const labels = [...new Set(trip.customers.map(c => name(c.fields.customer_id)))].join(' · ')
        return <div key={trip.id} className="execution-trip-entry"><AnimatedDetails className={`execution-trip${trip.workflowIssues?.length ? ' trip-has-error' : ''}`} testId="execution-trip" summary={<><div className="execution-trip-identity"><strong>{tripLabel(trip)}</strong><span>{formatDate(trip.fields.date)} · {driver}</span></div><div className="execution-trip-route"><span>{labels}</span><small>{number(trip.customers.reduce((n,c) => n + Number(c.fields.quantity_litres || 0), 0))} л</small></div><div className="execution-trip-status"><TripIssueLabel issues={trip.workflowIssues ?? []}/><span className={`execution-stage stage-${execution?.stage || 'unknown'}`}>{execution ? executionStageLabel[execution.stage] : 'Статус уточняется'}</span><span className="execution-progress-label">Доставлено {done} из {total}</span><progress max={Math.max(total,1)} value={done} aria-label={`Доставлено ${done} из ${total}`}/></div><ChevronDown className="execution-chevron" size={18}/></>}>
          <div className="execution-trip-body">
            <p className="execution-next">{execution ? executionStageHint[execution.stage] : 'Обновите рейсы, чтобы получить статус.'}</p>
            <div className="execution-loading"><MapPin size={16}/><div><span>Погрузка</span><p>{trip.fields.loading_address || 'Адрес не указан'}</p></div></div>
            <ol className="execution-deliveries">{trip.customers.map((c,i) => <li key={c.id} className={execution?.deliveries[c.id] ? 'is-delivered' : ''}><span className="execution-stop-number" aria-hidden="true">{execution?.deliveries[c.id] ? <Check size={16}/> : i+1}</span><div className="execution-customer"><strong>{name(c.fields.customer_id)}</strong><p>{c.fields.unloading_address || 'Адрес не указан'}</p><span>{number(c.fields.quantity_litres)} л</span></div>{execution?.deliveries[c.id] ? <div className="execution-record"><ExecutionEvent event={execution.deliveries[c.id]} elapsed/></div> : <>{execution && <TripExecutionAction key={`${c.id}-${execution.version}`} staff tripId={trip.id} versions={Object.fromEntries(trip.customers.map(row => [row.id, row.version]))} execution={execution} deliveryId={c.id} onSaved={onReload} onReload={onReload}/>}</>}</li>)}</ol>
            {execution?.completed ? <div className="execution-completion"><span>Все доставки выполнены</span><ExecutionEvent event={execution.completed}/></div> : <p className="execution-auto-note">Рейс завершится автоматически после подтверждения последней доставки.</p>}
            {trip.fields.trip_notes && <AnimatedDetails className="execution-notes" summary="Примечание к рейсу"><p>{trip.fields.trip_notes}</p></AnimatedDetails>}
          </div>
        </AnimatedDetails><TripCopyButton trip={trip} data={data} kind="summary"/><TripCopyButton trip={trip} data={data} kind="driver"/></div>
      })}</div>
    </article>)}</div>
    {!loading && !error && !groups.length && <div className="panel trips-empty"><Truck size={30}/><h2>Рейсы не найдены</h2><button className="button" onClick={() => { setQuery(''); setVehicleId(''); changeFilter('all') }}>Сбросить фильтры</button></div>}
  </section>
}

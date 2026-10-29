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
import './trip-execution.css'

export default function TripProcessPanel({ trips, data, loading, error, onReload }: {
  trips: ShipmentTrip[]; data: DirectoryData; loading: boolean; error: string; onReload: () => void
}) {
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'active' | 'completed' | 'all'>('active')
  const [vehicleId, setVehicleId] = useState(''), [stage, setStage] = useState('')
  const name = (id: string | null) => data.companies.find(row => row.id === id)?.name || 'Клиент не указан'
  const driver = (id: string | null) => data.directories?.drivers.find(row => row.id === id)?.name || 'Водитель не указан'
  const active = trips.filter(t => !t.execution?.completed)
  const vehicles = [...new Set(trips.map(t => t.fields.vehicle_id || ''))].map(id => ({ id, plate: data.directories?.vehicles.find(v => v.id === id)?.plate || 'Машина не указана' })).sort((a,b) => a.plate.localeCompare(b.plate, 'ru'))
  const needle = query.trim().toLocaleLowerCase('ru')
  const groups = vehicles.filter(v => !vehicleId || v.id === vehicleId).map(vehicle => ({ ...vehicle,
    visible: trips.filter(t => (t.fields.vehicle_id || '') === vehicle.id)
      .filter(t => filter === 'all' || (filter === 'completed' ? !!t.execution?.completed : !t.execution?.completed))
      .filter(t => !stage || t.execution?.stage === stage)
      .filter(t => [vehicle.plate, tripLabel(t), driver(t.fields.driver_id), ...t.customers.map(c => `${name(c.fields.customer_id)} ${c.fields.unloading_address || ''}`)].join(' ').toLocaleLowerCase('ru').includes(needle)).sort(compareTripsNewestFirst),
  })).filter(g => g.visible.length)
  const visibleCount = groups.reduce((n,g) => n + g.visible.length, 0)
  const changeFilter = (next: typeof filter) => { setFilter(next); setStage('') }
  return <section className="trip-process" aria-label="Процесс рейсов" aria-busy={loading}>
    <div className="execution-controls">
      <div className="execution-search-row"><label className="shipment-search"><Search size={17}/><input aria-label="Поиск машины или рейса" placeholder="Рейс, водитель, клиент или адрес" value={query} onChange={e => setQuery(e.target.value)}/></label><button className="button execution-refresh" aria-label="Обновить" title="Обновить" onClick={onReload} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/><span>Обновить</span></button><select aria-label="Машина" value={vehicleId} onChange={e => setVehicleId(e.target.value)}><option value="">Все машины</option>{vehicles.filter(v => v.id).map(v => <option key={v.id} value={v.id}>{v.plate}</option>)}</select><select aria-label="Этап рейса" value={stage} onChange={e => setStage(e.target.value)}><option value="">Все этапы</option>{Object.entries(executionStageLabel).filter(([key]) => key !== 'delivered' && (filter !== 'active' || key !== 'completed') && (filter !== 'completed' || key === 'completed')).map(([key,label]) => <option key={key} value={key}>{label}</option>)}</select></div>
      <div className="execution-toolbar"><ScrollableSegments className="execution-filters" label="Статус рейсов" value={filter}>{([{ id: 'active', label: 'В работе', count: active.length }, { id: 'completed', label: 'Завершённые', count: trips.length-active.length }, { id: 'all', label: 'Все', count: trips.length }] as const).map(f => <button type="button" className="button" key={f.id} aria-pressed={filter === f.id} onClick={() => changeFilter(f.id)}>{f.label}<small>{f.count}</small></button>)}</ScrollableSegments><div className="execution-totals"><span><strong>{active.length}</strong> в работе</span><span><strong>{active.reduce((n,t) => n + t.customers.filter(c => !t.execution?.deliveries[c.id]).length, 0)}</strong> доставок осталось</span></div></div>
    </div>
    <div className="execution-context"><span>Показано рейсов: {visibleCount}{loading ? ' · Обновляем…' : ' · Автообновление 30 с'}</span><AnimatedDetails className="execution-help" summary="Как работают статусы?"><div className="execution-help-body"><p>Водитель нажимает «Прибыл на место доставки» у нужного клиента. Сотрудник с доступом к рейсу может нажать «Завершить доставку». В истории сохраняются автор и время отметки.</p><dl>{(['planned','loading','enroute','delivering','completed'] as const).map(s => <div key={s}><dt>{executionStageLabel[s]}</dt><dd>{executionStageHint[s]}</dd></div>)}</dl><p>Последняя подтверждённая доставка автоматически завершает рейс. Документы СБИС и приёмка клиента в ЭТрН учитываются отдельно.</p><p>Если отметки нет, это не доказывает, что старый рейс фактически не выполнен.</p></div></AnimatedDetails></div>
    {error && <p className="shipment-error" role="alert">{error}</p>}
    {loading && !trips.length && <p role="status">Загружаем рейсы…</p>}
    <div className="execution-fleet">{groups.map(group => <article className="execution-vehicle" key={group.id}>
      <header><div><Truck size={19}/><h3>{group.plate}</h3></div><span>Рейсов: {group.visible.length}</span></header>
      <div className="execution-trip-list panel">{group.visible.map(trip => {
        const execution = trip.execution
        const done = trip.customers.filter(c => execution?.deliveries[c.id]).length, total = trip.customers.length
        const labels = [...new Set(trip.customers.map(c => name(c.fields.customer_id)))].join(' · ')
        return <div key={trip.id} className="execution-trip-entry"><AnimatedDetails className="execution-trip" testId="execution-trip" summary={<><div className="execution-trip-identity"><strong>{tripLabel(trip)}</strong><span>{formatDate(trip.fields.date)} · {driver(trip.fields.driver_id)}</span></div><div className="execution-trip-route"><span>{labels}</span><small>{number(trip.customers.reduce((n,c) => n + Number(c.fields.quantity_litres || 0), 0))} л</small></div><div className="execution-trip-status"><span className={`execution-stage stage-${execution?.stage || 'unknown'}`}>{execution ? executionStageLabel[execution.stage] : 'Статус уточняется'}</span><span className="execution-progress-label">Доставлено {done} из {total}</span><progress max={Math.max(total,1)} value={done} aria-label={`Доставлено ${done} из ${total}`}/></div><ChevronDown className="execution-chevron" size={18}/></>}>
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
    {!loading && !error && !groups.length && <div className="panel trips-empty"><Truck size={30}/><h2>Рейсы не найдены</h2><p>Измените поиск или фильтры.</p><button className="button" onClick={() => { setQuery(''); setVehicleId(''); changeFilter('all') }}>Сбросить фильтры</button></div>}
  </section>
}

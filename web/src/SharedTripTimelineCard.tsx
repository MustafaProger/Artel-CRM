import { ChevronDown, MapPin } from 'lucide-react'
import AnimatedDetails from './AnimatedDetails'
import { driverDateTimeLabel } from './driver-trip-model'
import { executionStageLabel } from './trip-execution-model'
import { tripLabel } from './trip-identity'
import type { SharedTripTimeline } from './trip-process-model'
import { formatDate } from './utils'

function TimelineTime({ label, at }: { label: string; at: string | null }) {
  if (!at) return null
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(at)
  return <span className="execution-timeline-time">{label} · <time dateTime={at}>{dateOnly ? formatDate(at) : driverDateTimeLabel(at)}</time></span>
}

export default function SharedTripTimelineCard({ trip, driver, done, total }: {
  trip: SharedTripTimeline; driver: string; done: number; total: number
}) {
  const names = [...new Set(trip.stops.filter(stop => stop.kind === 'delivery').map(stop => stop.name))].join(' · ')
  return <div className="execution-trip-entry execution-shared-trip">
    <AnimatedDetails className="execution-trip" testId="execution-trip" summary={<>
      <div className="execution-trip-identity">
        <strong>{tripLabel(trip)}</strong>
        <span>{formatDate(trip.date)} · {driver}</span>
      </div>
      <div className="execution-trip-route"><span>{names}</span><small>Общий рейс · Только просмотр</small></div>
      <div className="execution-trip-status">
        <span className={`execution-stage stage-${trip.stage}`}>{executionStageLabel[trip.stage]}</span>
        <span className="execution-progress-label">Доставлено {done} из {total}</span>
        <progress max={Math.max(total, 1)} value={done} aria-label={`Доставлено ${done} из ${total}`}/>
      </div>
      <ChevronDown className="execution-chevron" size={18}/>
    </>}>
      <div className="execution-trip-body">
        <div className="execution-loading">
          <MapPin size={16} aria-hidden="true"/>
          <div>
            <span>Погрузка</span>
            <p>{trip.loading.address || 'Адрес не указан'}</p>
            <TimelineTime label="По плану" at={trip.loading.plannedAt}/>
            <TimelineTime label="Прибытие" at={trip.loading.arrivedAt}/>
            {!trip.loading.arrivedAt && <TimelineTime label="Фактическая погрузка" at={trip.loading.actualAt}/>}
            <TimelineTime label="Убытие" at={trip.loading.departedAt}/>
          </div>
        </div>
        <ol className="execution-deliveries" aria-label="Порядок точек рейса">
          {trip.stops.map((stop, index) => <li key={index} className={stop.kind === 'delivery' && stop.event ? 'is-delivered' : undefined}>
            <span className="execution-stop-number" aria-hidden="true">{index + 1}</span>
            <div className="execution-customer">
              <strong>{stop.name}</strong>
              <p>{stop.address || 'Адрес не указан'}</p>
              {stop.kind === 'delivery' && stop.fromOwnRequest && <span>Ваша заявка</span>}
            </div>
            {stop.kind === 'delivery' ? <div className={stop.event ? 'execution-record' : 'execution-awaiting'}>
              {stop.event
                ? <TimelineTime label={stop.event.kind === 'arrival' ? 'Прибытие' : 'Доставка отмечена'} at={stop.event.at}/>
                : <span>Ожидает отметки</span>}
              <TimelineTime label="По плану" at={stop.plannedAt}/>
              {stop.actualAt !== stop.event?.at && <TimelineTime label="Фактическая выгрузка" at={stop.actualAt}/>}
            </div> : <span className="execution-awaiting">Промежуточная остановка</span>}
          </li>)}
        </ol>
        {trip.completedAt && <div className="execution-completion"><TimelineTime label="Рейс завершён" at={trip.completedAt}/></div>}
      </div>
    </AnimatedDetails>
  </div>
}

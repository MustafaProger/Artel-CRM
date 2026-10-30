import { useEffect, useRef, useState } from 'react'
import { Check, LoaderCircle } from 'lucide-react'
import { apiFetch } from './workspace-api'
import type { TripExecution, TripExecutionEvent } from './trip-execution-model'
import type { DriverTrip } from './driver-trip-model'
import { driverDateTimeLabel } from './driver-trip-model'
import './trip-execution.css'

export function ExecutionEvent({ event, elapsed = false }: { event: TripExecutionEvent; elapsed?: boolean }) {
  const [now, setNow] = useState(Date.now)
  useEffect(() => {
    if (!elapsed) return
    const timer = window.setInterval(() => setNow(Date.now()), 30_000)
    return () => window.clearInterval(timer)
  }, [elapsed])
  const minutes = Math.max(0, Math.floor((now - Date.parse(event.at)) / 60_000))
  const relative = new Intl.RelativeTimeFormat('ru', { numeric: 'always' })
  const [value, unit]: [number, Intl.RelativeTimeFormatUnit] = minutes < 60 ? [minutes, 'minute'] : minutes < 1440 ? [Math.floor(minutes / 60), 'hour'] : minutes < 43200 ? [Math.floor(minutes / 1440), 'day'] : minutes < 525600 ? [Math.floor(minutes / 43200), 'month'] : [Math.floor(minutes / 525600), 'year']
  const duration = minutes < 1 ? 'только что' : relative.format(-value, unit)
  if (elapsed) return <span className="execution-event"><Check size={15}/><span><strong>{event.kind === 'arrival' ? 'Прибыл' : 'Доставка отмечена'} {duration}</strong><small>{driverDateTimeLabel(event.at)}</small></span></span>
  return <span className="execution-event"><Check size={15}/><span>{driverDateTimeLabel(event.at)}</span></span>
}
export default function TripExecutionAction({ tripId, versions, execution, deliveryId, staff = false, onSaved, onReload }: {
  tripId: string; versions: Record<string, number>; execution: TripExecution; deliveryId: string; customer?: string; staff?: boolean
  onSaved: (result: { execution?: TripExecution; trip?: DriverTrip }) => void; onReload: () => void
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState('')
  const flight = useRef(false)
  const event = execution.deliveries[deliveryId]
  if (event) return <div className="execution-record"><ExecutionEvent event={event} elapsed/></div>
  const ready = execution.stage !== 'conflict' && !!execution.departedAt && !execution.completed
  const save = async () => {
    if (flight.current || !ready || error) return
    flight.current = true; setBusy(true); setError('')
    try {
      const path = staff ? `/api/shipment-trips/${encodeURIComponent(tripId)}/execution` : `/api/driver/trips/${encodeURIComponent(tripId)}`
      const response = await apiFetch(`${path}/deliver`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ versions, executionVersion: execution.version, deliveryId }) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить отметку.')
      onSaved(result)
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Нет связи. Обновите рейс, чтобы проверить сохранение.') }
    finally { flight.current = false; setBusy(false) }
  }
  return <div className="execution-action">
    <button className="button primary" disabled={!ready || busy || !!error} onClick={() => void save()}>{busy ? <LoaderCircle size={16} className="spin"/> : <Check size={16}/>}{staff ? 'Завершить доставку' : 'Прибыл на место доставки'}</button>
    {!ready && <small>{execution.stage === 'conflict' ? 'Состав рейса изменён. Обратитесь к логисту.' : 'Доступно после убытия с погрузки.'}</small>}
    {error && <div className="shipment-error" role="alert">{error}<button className="button" disabled={busy} onClick={() => { setError(''); onReload() }}>Обновить рейс</button></div>}
  </div>
}

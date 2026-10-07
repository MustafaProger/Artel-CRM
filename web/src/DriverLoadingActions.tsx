import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, RefreshCw } from 'lucide-react'
import { apiFetch } from './workspace-api'
import { driverDateTimeLabel, driverVersionKey, normalizeDriverMass, type DriverTrip } from './driver-trip-model'

export default function DriverLoadingActions({ trip, onUpdated }: { trip: DriverTrip; onUpdated: (trip: DriverTrip) => void }) {
  const [masses, setMasses] = useState<Record<string, string>>({})
  const [draftVersions, setDraftVersions] = useState<Record<string, number> | null>(null)
  const [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false)
  const [message, setMessage] = useState(''), [notice, setNotice] = useState('')
  const inFlight = useRef(false), alive = useRef(true)
  useEffect(() => { alive.current = true; return () => { alive.current = false } }, [])
  const stale = !!draftVersions && driverVersionKey(draftVersions) !== driverVersionKey(trip.versions)
  const complete = trip.deliveries.length > 0 && trip.deliveries.every(delivery => normalizeDriverMass(masses[delivery.id] || '') !== null)
  const endpoint = `/api/driver/trips/${encodeURIComponent(trip.id)}`
  const readCurrent = async () => {
    const response = await apiFetch(endpoint, { cache: 'no-store', signal: AbortSignal.timeout(15000) })
    const result = await response.json()
    if (!response.ok) throw new Error(response.status === 404 ? 'Рейс больше не назначен вам.' : result.error || 'Не удалось проверить сохранённое состояние.')
    if (!result.trip || result.trip.id !== trip.id) throw new Error('Не удалось проверить сохранённое состояние.')
    if (alive.current) { onUpdated(result.trip); setUncertain(false) }
    return result.trip as DriverTrip
  }
  const accepted = (current: DriverTrip, action: 'arrive' | 'depart') => action === 'arrive' ? !!current.arrivedAt : !!current.departedAt
  const success = (action: 'arrive' | 'depart') => action === 'arrive' ? 'Прибытие сохранено.' : 'Убытие и все массы сохранены. Дальнейшую отправку документов выполняет CRM.'
  const perform = async (action: 'arrive' | 'depart') => {
    if (inFlight.current || uncertain || trip.archived || (action === 'arrive' ? !!trip.arrivedAt : !trip.arrivedAt || !!trip.departedAt || stale || !complete)) return
    inFlight.current = true; setBusy(true); setMessage(''); setNotice('')
    const payload = action === 'arrive' ? { versions: trip.versions } : { versions: draftVersions ?? trip.versions, masses: trip.deliveries.map(delivery => ({ deliveryId: delivery.id, netTonnes: normalizeDriverMass(masses[delivery.id] || '')! })) }
    try {
      const response = await apiFetch(`${endpoint}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload), signal: AbortSignal.timeout(20000) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Действие не подтверждено сервером.')
      if (!result.trip || result.trip.id !== trip.id || !accepted(result.trip, action)) throw new Error('Действие пока не подтверждено. Проверяем сохранённое состояние.')
      if (alive.current) { onUpdated(result.trip); setNotice(success(action)); setUncertain(false) }
    } catch (reason) {
      if (!alive.current) return
      // Resolve a lost response by reading. Never automatically post again.
      setUncertain(true)
      try {
        const current = await readCurrent()
        if (!alive.current) return
        if (accepted(current, action)) setNotice(success(action))
        else setMessage(reason instanceof Error ? reason.message : 'Действие не сохранено. Проверьте данные и повторите.')
      } catch {
        if (alive.current) setMessage('Ответ не подтверждён. Проверьте сохранённое состояние перед следующим действием.')
      }
    } finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  const reconcile = async () => {
    if (inFlight.current) return
    inFlight.current = true; setBusy(true)
    try {
      const current = await readCurrent()
      if (alive.current) { setMessage(''); setNotice(current.departedAt ? success('depart') : current.arrivedAt ? success('arrive') : 'Состояние проверено. Прибытие ещё не сохранено.') }
    } catch (reason) { if (alive.current) setMessage(reason instanceof Error ? reason.message : 'Нет связи с сервером. Попробуйте проверить ещё раз.') }
    finally { inFlight.current = false; if (alive.current) setBusy(false) }
  }
  return <section className="driver-loading-actions driver-stop" aria-label="Действия на погрузке" aria-busy={busy}>
    <h3>{trip.archived ? 'Рейс завершён' : 'Погрузка'}</h3>
    <dl className="driver-cargo driver-events">{trip.arrivedAt && <div><dt>Прибыл</dt><dd>{driverDateTimeLabel(trip.arrivedAt)}</dd></div>}{trip.departedAt && <div><dt>Убыл</dt><dd>{driverDateTimeLabel(trip.departedAt)}</dd></div>}</dl>
    {message && <p className="driver-error" role="alert">{message}</p>}
    {notice && <p className="driver-action-notice" role="status">{notice}</p>}
    {uncertain && <button type="button" className="button" disabled={busy} onClick={() => void reconcile()}><RefreshCw size={17}/>Проверить состояние</button>}
    {!trip.archived && !trip.arrivedAt && <><p className="driver-action-help">Нажмите, когда прибудете на нефтебазу. Время сохранится автоматически.</p><button type="button" className="button primary driver-event-button" disabled={busy || uncertain} onClick={() => void perform('arrive')}>{busy && <LoaderCircle size={17} className="spin"/>}Прибыл</button></>}
    {!trip.archived && trip.arrivedAt && !trip.departedAt && <form onSubmit={event => { event.preventDefault(); void perform('depart') }}>
      <p className="driver-action-help">После погрузки укажите массу нетто по бумажной ТТН в тоннах. Для каждой доставки сложите массу всех её секций.</p>
      <div className="driver-mass-list">{trip.deliveries.map((delivery, index) => <label className="driver-mass-field" key={delivery.id}><span><strong>{index + 1}. {delivery.customer || 'Доставка'}</strong><small>{delivery.address || 'Адрес не указан'}</small></span><span className="driver-mass-input"><input aria-label={`Масса нетто доставки ${index + 1}, т`} inputMode="decimal" type="text" autoComplete="off" placeholder="0,000" required disabled={busy || uncertain || stale} value={masses[delivery.id] || ''} aria-invalid={!!masses[delivery.id] && normalizeDriverMass(masses[delivery.id]) === null} onChange={event => { if (!draftVersions) setDraftVersions(trip.versions); setMasses(previous => ({ ...previous, [delivery.id]: event.target.value })); setMessage('') }}/><span>т</span></span>{!!masses[delivery.id] && normalizeDriverMass(masses[delivery.id]) === null && <small className="driver-mass-error">Введите положительную массу, до 6 знаков после запятой.</small>}</label>)}</div>
      {stale && <div className="driver-error" role="alert"><p>Рейс изменён после начала ввода. Проверьте актуальные доставки и введите массы заново.</p><button type="button" className="button" disabled={busy || uncertain} onClick={() => { setMasses({}); setDraftVersions(null); setMessage('') }}>Проверить состав и начать ввод заново</button></div>}
      <button type="submit" className="button primary driver-event-button" disabled={busy || uncertain || stale || !complete}>{busy && <LoaderCircle size={17} className="spin"/>}Убыл</button>
      <p className="driver-action-help">Кнопка сохранит все массы и время убытия. После отправки они доступны только для просмотра.</p>
    </form>}
    {trip.departedAt && <p className="driver-action-help">{trip.archived ? 'Отправка документов по всем доставкам подтверждена.' : 'Массы и убытие сохранены. CRM продолжает обработку документов. Рейс появится в архиве после завершения всех этапов.'}</p>}
  </section>
}

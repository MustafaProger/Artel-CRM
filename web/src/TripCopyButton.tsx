import { useEffect, useState } from 'react'
import { Check, ClipboardList, Truck } from 'lucide-react'
import type { DirectoryData, ShipmentTrip } from './model'
import { tripLabel } from './trip-identity'
import { tripCopyText, tripDriverCopyText } from './trip-copy-text'

export default function TripCopyButton({ trip, data, kind }: { trip: ShipmentTrip; data: DirectoryData; kind: 'summary' | 'driver' }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const [fallbackText, setFallbackText] = useState('')
  useEffect(() => {
    if (status !== 'copied') return
    const timer = window.setTimeout(() => setStatus('idle'), 2500)
    return () => window.clearTimeout(timer)
  }, [status])
  const copy = async () => {
    const text = kind === 'driver' ? tripDriverCopyText(trip, data) : tripCopyText(trip, data)
    setStatus('copying')
    try {
      await navigator.clipboard.writeText(text)
      setStatus('copied')
      setFallbackText('')
    } catch {
      setFallbackText(text)
      setStatus('error')
    }
  }
  const description = kind === 'driver' ? 'Задание водителю' : 'Сводка с ценами'
  const label = status === 'copied' ? `${description}: ${tripLabel(trip)} — скопировано` : `Скопировать: ${description.toLocaleLowerCase('ru')}, ${tripLabel(trip).toLocaleLowerCase('ru')}`
  return <>
    <button type="button" className={`button execution-copy execution-copy-${kind}`} title={label} aria-label={label} onClick={() => void copy()} disabled={status === 'copying'}>
      {status === 'copied' ? <Check size={18} aria-hidden="true"/> : kind === 'driver' ? <Truck size={18} aria-hidden="true"/> : <ClipboardList size={18} aria-hidden="true"/>}
    </button>
    <span className="execution-copy-notice" role="status">{status === 'copied' ? label : ''}</span>
    {status === 'error' && <div className={`execution-copy-fallback execution-copy-fallback-${kind}`}>
      <p role="alert">Не удалось скопировать. Выделите текст ниже и скопируйте вручную.</p>
      <textarea aria-label={`${description}: ${tripLabel(trip)}`} readOnly value={fallbackText} rows={Math.min(fallbackText.split('\n').length, 12)} onFocus={event => event.currentTarget.select()}/>
      <button type="button" className="button" onClick={() => { setStatus('idle'); setFallbackText('') }}>Закрыть</button>
    </div>}
  </>
}

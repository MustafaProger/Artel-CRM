import { useEffect, useState } from 'react'
import { Check, Copy } from 'lucide-react'
import type { Directories } from './model'
import type { TripRequest } from './trip-request-model'
import { tripRequestCopyText } from './trip-request-copy-text'

export default function TripRequestCopyButton({ request, addresses }: { request: TripRequest; addresses: Directories['addresses'] }) {
  const [status, setStatus] = useState<'idle' | 'copying' | 'copied' | 'error'>('idle')
  const [fallbackText, setFallbackText] = useState('')
  useEffect(() => {
    if (status !== 'copied') return
    const timer = window.setTimeout(() => setStatus('idle'), 2500)
    return () => window.clearTimeout(timer)
  }, [status])
  const copy = async () => {
    const text = tripRequestCopyText(request, addresses)
    setStatus('copying')
    try {
      await navigator.clipboard.writeText(text)
      setFallbackText('')
      setStatus('copied')
    } catch {
      setFallbackText(text)
      setStatus('error')
    }
  }
  const label = `${status === 'copied' ? 'Заявка скопирована' : 'Скопировать заявку'}: ${request.companyName}, ${request.addressName}`
  return <>
    <button type="button" className="button trip-request-copy" title={label} aria-label={label} disabled={status === 'copying'} onClick={() => void copy()}>
      {status === 'copied' ? <Check size={16} aria-hidden="true"/> : <Copy size={16} aria-hidden="true"/>}
    </button>
    <span className="trip-request-copy-notice" role="status">{status === 'copied' ? 'Заявка скопирована' : ''}</span>
    {status === 'error' && <div className="trip-request-copy-fallback">
      <p role="alert">Не удалось скопировать. Выделите текст ниже и скопируйте вручную.</p>
      <textarea aria-label={`Текст заявки: ${request.companyName}`} readOnly value={fallbackText} rows={Math.min(fallbackText.split('\n').length, 12)} onFocus={event => event.currentTarget.select()}/>
      <button type="button" className="button" onClick={() => setStatus('idle')}>Закрыть</button>
    </div>}
  </>
}

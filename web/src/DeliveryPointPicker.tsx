import { lazy, Suspense, useState } from 'react'
import { Check, MapPin } from 'lucide-react'
import { tripRequestExplicitCoordinates } from './trip-request-map-coordinates'
const PointMap = lazy(() => import('./DeliveryPointMap'))

type Props = {
  latitude?: string | null; longitude?: string | null; mapUrl?: string | null;
  disabled?: boolean; onChange: (latitude: string, longitude: string) => void;
}

/** Edits only the enclosing form's draft. The form owns persistence and cancellation. */
export default function DeliveryPointPicker({ latitude, longitude, mapUrl, disabled = false, onChange }: Props) {
  const [open, setOpen] = useState(false)
  const point = tripRequestExplicitCoordinates({ latitude, longitude, mapUrl })
  return <div className="delivery-point-picker">
    <div className="delivery-point-summary">{point?.status === 'found' ? <><Check size={16} aria-hidden="true"/><span>Точка выбрана: {point.latitude.toFixed(6)}, {point.longitude.toFixed(6)}</span></> : <span>Точка доставки ещё не выбрана</span>}</div>
    <button type="button" className="button" aria-expanded={open} disabled={disabled} onClick={() => setOpen(value => !value)}><MapPin size={16}/>{open ? 'Скрыть карту выбора' : point?.status === 'found' ? 'Изменить точку на карте' : 'Выбрать точку на карте'}</button>
    {open && <Suspense fallback={<p role="status">Загружаем карту…</p>}><PointMap latitude={point?.status === 'found' ? String(point.latitude) : null} longitude={point?.status === 'found' ? String(point.longitude) : null} disabled={disabled} onChange={onChange}/></Suspense>}
  </div>
}

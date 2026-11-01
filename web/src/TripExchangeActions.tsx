import { useRef, useState } from 'react'
import { LoaderCircle, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import type { TripSabyResponse } from './trip-saby-model'
import { useDialogMotion } from './useDialogMotion'

export default function TripExchangeActions({ control, busy, onRefresh, onControl, onDelete }: {
  control?: TripSabyResponse['exchangeControl']; busy: boolean; onRefresh: () => Promise<void>;
  onControl: (paused: boolean) => Promise<void>; onDelete?: () => void;
}) {
  const [confirm, setConfirm] = useState<boolean | null>(null)
  return <div className="trip-exchange-actions">
    {control?.paused && <p className="soft-notice" role="status">Обмен остановлен. Следующие действия CRM в Saby не выполняются. Уже отправленный запрос может завершиться в Saby.</p>}
    <div className="etrn-actions">
      <button type="button" className="button" disabled={busy} onClick={() => void onRefresh()}>{busy ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}Проверить данные</button>
      {control && <button type="button" className={control.paused ? "button" : "button trip-exchange-pause"} disabled={busy} onClick={() => setConfirm(!control.paused)}>{control.paused ? <Play size={15}/> : <Pause size={15}/>} {control.paused ? 'Возобновить обмен' : 'Остановить обмен'}</button>}
      {onDelete && <button type="button" className="button danger" disabled={busy} onClick={onDelete}><Trash2 size={15}/>Удалить рейс</button>}
    </div>
    {confirm !== null && <ControlDialog paused={confirm} onClose={() => setConfirm(null)} onSave={() => onControl(confirm)}/>}
  </div>
}

function ControlDialog({ paused, onClose, onSave }: { paused: boolean; onClose: () => void; onSave: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null), savingRef = useRef(false)
  const [saving, setSaving] = useState(false), [error, setError] = useState('')
  const { close, complete } = useDialogMotion(dialog, onClose)
  const save = async () => {
    if (savingRef.current) return
    savingRef.current = true; setSaving(true); setError('')
    try { await onSave(); await complete(onClose) }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить действие. Проверьте состояние рейса.') }
    finally { savingRef.current = false; setSaving(false) }
  }
  return <dialog ref={dialog} className="shipment-delete-dialog" aria-labelledby="trip-control-title" onCancel={event => { event.preventDefault(); if (!savingRef.current) close() }}>
    <h2 id="trip-control-title">{paused ? 'Остановить обмен рейса?' : 'Возобновить обмен рейса?'}</h2>
    <p>{paused ? 'CRM остановит следующие действия по документам этого рейса. Рейс, доставки, документы и подписи сохранятся. Уже отправленный запрос и действия других участников в Saby могут завершиться.' : 'CRM продолжит обмен по сохранённому поручению после проверки данных и прав. Уже созданные документы и подписи сохранятся.'}</p>
    {error && <p className="shipment-error" role="alert">{error}</p>}
    <footer><button type="button" className="button" disabled={saving} onClick={close} autoFocus>Отмена</button><button type="button" className={paused ? "button trip-exchange-pause" : "button primary"} disabled={saving} onClick={() => void save()}>{saving && <LoaderCircle size={15} className="spin"/>}{paused ? 'Остановить обмен' : 'Возобновить обмен'}</button></footer>
  </dialog>
}

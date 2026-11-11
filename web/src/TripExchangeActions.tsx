import { useDirectAction } from './useDirectAction'
import { LoaderCircle, Pause, Play, RefreshCw, Trash2 } from 'lucide-react'
import type { TripSabyResponse } from './trip-saby-model'

export default function TripExchangeActions({ control, busy, onRefresh, onControl, onDelete, deleting = false }: {
  control?: TripSabyResponse['exchangeControl']; busy: boolean; onRefresh: () => Promise<void>;
  onControl: (paused: boolean) => Promise<void>; onDelete?: () => void; deleting?: boolean;
}) {
  const action = useDirectAction()
  return <div className="trip-exchange-actions">
    {control?.paused && <p className="soft-notice" role="status">Обмен остановлен. Следующие действия CRM в Saby не выполняются. Уже отправленный запрос может завершиться в Saby.</p>}
    <div className="etrn-actions">
      <button type="button" className="button" disabled={busy || deleting || !!action.pending} onClick={() => void onRefresh()}>{busy ? <LoaderCircle size={15} className="spin"/> : <RefreshCw size={15}/>}Проверить данные</button>
      {control && <button type="button" className={control.paused ? "button" : "button trip-exchange-pause"} disabled={busy || deleting || !!action.pending} onClick={() => void action.run('exchange', () => onControl(!control.paused))}>{control.paused ? <Play size={15}/> : <Pause size={15}/>} {control.paused ? 'Возобновить обмен' : 'Остановить обмен'}</button>}
      {onDelete && <button type="button" className="button danger" disabled={busy || deleting || !!action.pending} onClick={onDelete}><Trash2 size={15}/>{deleting ? 'Удаляем…' : 'Удалить рейс'}</button>}
    </div>
    {action.error && <p className="shipment-error" role="alert">{action.error}</p>}
  </div>
}

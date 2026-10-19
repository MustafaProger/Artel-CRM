import { useId, useRef, useState, type ReactNode } from 'react'
import { Bell, X } from 'lucide-react'
import { useDialogMotion } from './useDialogMotion'
import PushSettings from './PushSettings'
import './driver-notifications.css'

export function NotificationMenu({ userId, kind = 'driver', count = 0, children }: { userId: string; kind?: 'driver' | 'work'; count?: number; children?: ReactNode | ((closeWith: (callback: () => void) => void) => ReactNode) }) {
  const [enabled, setEnabled] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const { open, close, complete } = useDialogMotion(dialog, () => trigger.current?.focus({ preventScroll: true }), false)

  const label = kind === 'driver' ? 'Настройки уведомлений' : `Напоминания${count ? `, ${count}` : ''}`
  return <>
    <button ref={trigger} type="button" className={`button driver-notification-button${kind === 'work' ? ' mobile-icon-action' : ''}`} aria-haspopup="dialog"
      aria-label={enabled ? `${label}, включены` : label}
      title={label}
      onClick={open}>
      <Bell size={18} aria-hidden="true"/>{kind === 'work' && <span className="mobile-action-label">Напоминания</span>}{count > 0 && <span className="notification-count" aria-hidden="true">{count > 99 ? '99+' : count}</span>}{enabled && <span className="driver-notification-indicator" aria-hidden="true"/>}
    </button>
    <dialog ref={dialog} className="driver-notifications-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close() }}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
      }}>
      <div className="driver-notifications-title"><h2 id={titleId}>{kind === 'driver' ? 'Уведомления о рейсах' : 'Напоминания'}</h2><button type="button" className="button driver-notification-close" aria-label="Закрыть настройки уведомлений" onClick={close}><X size={19}/></button></div>
      {kind === 'driver' && <p>Сообщим о новом рейсе. Нажмите на уведомление, чтобы открыть его подробности.</p>}
      <div>{typeof children === 'function' ? children(callback => { void complete(() => { trigger.current?.focus({ preventScroll: true }); callback() }) }) : children}</div>
      {/* Keep device binding and receipt polling alive while the settings are closed. */}
      <PushSettings userId={userId} kind={kind} onEnabledChange={setEnabled} onEnabled={close}/>
    </dialog>
  </>
}

export default function DriverNotifications({ userId }: { userId: string }) {
  return <NotificationMenu userId={userId}/>
}

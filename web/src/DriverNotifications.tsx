import { useId, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Bell, X } from 'lucide-react'
import { useDialogMotion } from './useDialogMotion'
import PushSettings from './PushSettings'
import './driver-notifications.css'

export function NotificationMenu({ userId, kind = 'driver', count = 0, operatorPlanId, sidebar = false, children }: { userId: string; kind?: 'driver' | 'work' | 'invoices' | 'operator'; count?: number; operatorPlanId?: string; sidebar?: boolean; children?: ReactNode | ((closeWith: (callback: () => void) => void) => ReactNode) }) {
  const [enabled, setEnabled] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const { open, close, complete } = useDialogMotion(dialog, () => trigger.current?.focus({ preventScroll: true }), false)

  const label = sidebar ? 'Уведомления' : kind === 'driver' ? 'Настройки уведомлений' : kind === 'operator' ? 'Уведомления операторской' : kind === 'invoices' ? 'Уведомления о счетах' : `Напоминания${count ? `, ${count}` : ''}`
  return <>
    <button ref={trigger} type="button" className={`button driver-notification-button${sidebar ? ' sidebar-account-action' : kind !== 'driver' ? ' mobile-icon-action' : ''}${!sidebar && kind === 'operator' ? ' operator-toolbar-icon' : ''}`} aria-haspopup="dialog"
      aria-label={enabled ? `${label}, включены` : label}
      title={label}
      onClick={open}>
      <Bell size={18} aria-hidden="true"/>{!sidebar && kind !== 'driver' && <span className="mobile-action-label">{kind === 'invoices' || kind === 'operator' ? 'Уведомления' : 'Напоминания'}</span>}{count > 0 && <span className="notification-count" aria-hidden="true">{count > 99 ? '99+' : count}</span>}{enabled && <span className="driver-notification-indicator" aria-hidden="true"/>}
    </button>
    {createPortal(<dialog ref={dialog} className="driver-notifications-dialog" aria-labelledby={titleId}
      onCancel={event => { event.preventDefault(); close() }}
      onClick={event => {
        if (event.target !== event.currentTarget) return
        const rect = event.currentTarget.getBoundingClientRect()
        if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
      }}>
      <div className="driver-notifications-title"><h2 id={titleId}>{sidebar ? 'Уведомления' : kind === 'driver' ? 'Уведомления о рейсах' : kind === 'operator' ? 'Уведомления операторской' : kind === 'invoices' ? 'Уведомления о счетах' : 'Напоминания'}</h2><button type="button" className="button driver-notification-close" aria-label="Закрыть настройки уведомлений" onClick={close}><X size={19}/></button></div>
      {!sidebar && kind === 'operator' && <p>Сообщим о новых заданиях других сотрудников и о выполнении ваших заданий оператором. Нажмите на уведомление, чтобы открыть задание.</p>}
      {!sidebar && kind === 'invoices' && <p>Сообщим, когда ваш счёт и PDF будут готовы. Уведомление откроет личную историю.</p>}
      {kind === 'driver' && <p>Сообщим о новом рейсе. Нажмите на уведомление, чтобы открыть его подробности.</p>}
      <div>{typeof children === 'function' ? children(callback => { void complete(() => { trigger.current?.focus({ preventScroll: true }); callback() }) }) : children}</div>
      {/* Keep device binding and receipt polling alive while the settings are closed. */}
      <PushSettings userId={userId} kind={kind} operatorPlanId={kind === 'operator' ? operatorPlanId : undefined} onEnabledChange={setEnabled} onEnabled={close}/>
    </dialog>, document.body)}
  </>
}

export default function DriverNotifications({ userId }: { userId: string }) {
  return <NotificationMenu userId={userId}/>
}

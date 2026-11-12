import { Bell, ChevronDown } from 'lucide-react'
import { useRef } from 'react'
import { hasSection, type AccountUser } from './auth-model'
import NotificationSources, { type NotificationSource } from './NotificationSources'
import PersonalProfileSettings from './PersonalProfileSettings'
import PushSettings from './PushSettings'
import './personal-settings.css'

export default function PersonalSettings({ user, onUserChanged, visible }: {
  user: AccountUser; onUserChanged: (user: AccountUser) => void; visible: boolean
}) {
  const notifications = useRef<HTMLElement>(null)
  const showNotifications = () => {
    notifications.current?.scrollIntoView({ block: 'start' })
    notifications.current?.focus({ preventScroll: true })
  }
  const sources: NotificationSource[] = []
  if (user.role === 'driver') sources.push('tripAssignments')
  if (hasSection(user, 'work')) sources.push('tasks', 'companies')
  if (user.role === 'director' && hasSection(user, 'trips')) sources.push('tripRequests')
  if (hasSection(user, 'invoices')) sources.push('invoices')
  if (hasSection(user, 'operator')) sources.push('operator')
  const audience = user.role === 'driver' ? 'driver' : hasSection(user, 'work') ? 'work' : hasSection(user, 'invoices') ? 'invoices' : 'operator'

  return <div className="personal-settings-page" hidden={!visible}>
    <div className="personal-settings-jump"><button type="button" className="button" onClick={showNotifications}><Bell size={17} aria-hidden="true"/>К уведомлениям<ChevronDown size={16} aria-hidden="true"/></button></div>
    <section className="panel personal-settings-card" aria-labelledby="personal-profile-title">
      <h2 id="personal-profile-title" className="personal-profile-heading">Профиль</h2>
      {visible && <PersonalProfileSettings user={user} onUserChanged={onUserChanged}/>}
    </section>
    <section className="panel personal-settings-card" aria-labelledby="personal-notifications-title" ref={notifications} tabIndex={-1}>
      <header className="personal-settings-card-heading">
        <span aria-hidden="true"><Bell size={20}/></span>
        <h2 id="personal-notifications-title">Уведомления</h2>
      </header>
      {sources.length > 0 ? <PushSettings key={user.id} userId={user.id} kind={audience}>
        <NotificationSources userId={user.id} sources={sources} visible={visible}/>
      </PushSettings> : <p className="personal-settings-empty">Для вашей учётной записи пока нет доступных источников уведомлений.</p>}
    </section>
  </div>
}

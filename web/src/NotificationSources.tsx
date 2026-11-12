import { useEffect, useRef, useState } from 'react'
import { pushRequest } from './push-client'
import './account-toggle.css'

const labels = {
  tasks: 'Задачи',
  companies: 'Работа с компаниями — (напоминания)',
  tripRequests: 'Заявки на рейс',
  tripAssignments: 'Рейсы',
  invoices: 'Счета (уведомления о готовности)',
  operator: 'Операторская (новые и выполненные задания)',
} as const
export type NotificationSource = keyof typeof labels
type Preferences = Record<NotificationSource, boolean>
type PreferencesResponse = { preferences: Preferences }

export default function NotificationSources({ userId, sources, visible }: {
  userId: string; sources: NotificationSource[]; visible: boolean
}) {
  const [preferences, setPreferences] = useState<Preferences | null>(null)
  const [pending, setPending] = useState<NotificationSource | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [loading, setLoading] = useState(false)
  const saving = useRef(false)
  useEffect(() => {
    if (!visible || saving.current) return
    let current = true
    setLoading(true)
    setError('')
    void (pushRequest('preferences', 'GET', undefined, userId) as Promise<PreferencesResponse>)
      .then(({ preferences }) => { if (current) setPreferences(preferences) })
      .catch(reason => { if (current) setError((reason as Error).message) })
      .finally(() => { if (current) setLoading(false) })
    return () => { current = false }
  }, [userId, visible, attempt])

  const change = async (source: NotificationSource) => {
    if (loading || saving.current || !preferences) return
    saving.current = true
    setError('')
    setPending(source)
    try {
      const result: PreferencesResponse = await pushRequest('preferences', 'PATCH', { [source]: !preferences[source] }, userId)
      setPreferences(result.preferences)
    } catch (reason) {
      setError((reason as Error).message)
    } finally {
      saving.current = false
      setPending(null)
    }
  }

  return <div className="notification-sources" role="group" aria-label="Источники уведомлений" aria-busy={loading || pending !== null}>
    {loading && !preferences && <p role="status">Загружаем настройки…</p>}
    {preferences && <ul>{sources.map(source => <li key={source}>
      <label className="notification-source">
        <span>{labels[source]}</span>
        <input type="checkbox" role="switch" className="account-toggle" checked={preferences[source]}
          aria-disabled={loading || pending !== null} onChange={() => void change(source)}/>
      </label>
    </li>)}</ul>}
    {error && <><p role="alert">{error}</p><button type="button" className="button" onClick={() => setAttempt(value => value + 1)}>Обновить настройки</button></>}
  </div>
}

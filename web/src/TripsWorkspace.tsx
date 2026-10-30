import { useEffect, useState } from 'react'
import type { DirectoryData } from './model'
import { apiFetch } from './workspace-api'
import TripsPage from './TripsPage'

/** This page needs operational directories, never a financial dashboard snapshot. */
export default function TripsWorkspace({ canManagePlaces }: { canManagePlaces: boolean }) {
  const [data, setData] = useState<DirectoryData | null>(null)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    void apiFetch('/api/trip-requests/context', { signal: controller.signal }).then(async response => {
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось загрузить справочники рейсов.')
      if (!controller.signal.aborted) setData(result)
    }).catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Нет связи с сервером') })
    return () => controller.abort()
  }, [revision])
  return <>
    {error && <div className="shipment-error" role="alert">{error} <button className="button" onClick={() => setRevision(value => value + 1)}>Повторить загрузку справочников</button></div>}
    {data ? <TripsPage data={data} canManagePlaces={canManagePlaces} onChanged={() => setRevision(value => value + 1)}/> : !error && <p role="status">Загружаем справочники рейсов…</p>}
  </>
}

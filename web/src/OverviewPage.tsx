import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, CircleCheck, LoaderCircle, RefreshCw, Wallet } from 'lucide-react'
import type { SettlementsReport } from './settlements-model'
import OrganizationOverview from './OrganizationOverview'
import './overview.css'

const time = (value: string | null) => {
  if (!value) return 'Ещё не загружались'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Время не указано' : parsed.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })
}

export default function OverviewPage() {
  const [data, setData] = useState<SettlementsReport | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const activeRequest = useRef<AbortController | null>(null), requestNumber = useRef(0)
  const refresh = useCallback(async () => {
    activeRequest.current?.abort()
    const controller = new AbortController(), request = ++requestNumber.current
    activeRequest.current = controller
    setLoading(true)
    try {
      const response = await fetch('/api/settlements', { signal: controller.signal, cache: 'no-store' })
      if (controller.signal.aborted || request !== requestNumber.current) return
      if (response.status === 401 || response.status === 403) {
        setData(null); setUpdatedAt(null)
      }
      const result = await response.json()
      if (controller.signal.aborted || request !== requestNumber.current) return
      if (!response.ok) throw new Error(result.error || 'Не удалось загрузить обзор.')
      setData(result); setError(''); setUpdatedAt(new Date().toISOString())
    } catch (cause) {
      if (!controller.signal.aborted && request === requestNumber.current) setError(cause instanceof Error ? cause.message : 'Нет связи с сервером.')
    } finally {
      if (!controller.signal.aborted && request === requestNumber.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh() }
    const interval = window.setInterval(visibleRefresh, 30_000)
    window.addEventListener('focus', visibleRefresh)
    document.addEventListener('visibilitychange', visibleRefresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', visibleRefresh)
      document.removeEventListener('visibilitychange', visibleRefresh)
      activeRequest.current?.abort()
    }
  }, [refresh])

  return <section className="overview-page" aria-label="Обзор взаиморасчётов">
    <div className="overview-heading"><button type="button" className="button overview-refresh" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/>{loading && data ? 'Обновляем…' : 'Обновить'}</button></div>
    {error && <div className="overview-notice overview-error" role="alert"><AlertCircle size={18}/><div><strong>{error}</strong>{data && <p>Данные от {time(updatedAt)} могут быть неактуальны.</p>}<button type="button" className="button" disabled={loading} onClick={() => void refresh()}>Повторить загрузку</button></div></div>}
    {!data ? <div className="overview-empty overview-card" role="status">{loading ? <><LoaderCircle size={28} className="spin"/><h3>Загрузка…</h3></> : <><Wallet size={30}/><h3>Обзор пока недоступен</h3></>}</div> : <>
      <div className="overview-freshness"><span>{loading ? <LoaderCircle size={13} className="spin"/> : <CircleCheck size={13}/>}Обновлено: {time(updatedAt)}</span></div>
      <OrganizationOverview organizations={data.organizations ?? []} unassignedShipmentCount={data.unassignedShipmentCount ?? 0}/>
    </>}
  </section>
}

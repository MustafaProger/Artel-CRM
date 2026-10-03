import { useCallback, useEffect, useRef, useState } from 'react'
import { Building2, Factory, Fuel, LoaderCircle, LogOut, MapPin, Package, Truck, UsersRound, Route, type LucideIcon } from 'lucide-react'
import AuthGate from './AuthGate'
import DriverWorkspace from './DriverWorkspace'
import TripsPage from './TripsPage'
import DirectoriesPage, { type DirectoryTab } from './DirectoriesPage'
import { hasSection, isAdministrator, type AccountUser } from './auth-model'
import type { DirectoryData } from './model'
import { apiFetch } from './workspace-api'

type LogisticsPage = 'trips' | DirectoryTab
const pages: { id: LogisticsPage; title: string; description: string; icon: LucideIcon; group: 'work' | 'reference' }[] = [
  { id: 'trips', title: 'Рейсы', description: 'Маршруты, доставки и документы Saby.', icon: Route, group: 'work' },
  { id: 'vehicles', title: 'Автомобили', description: 'Машины, вместимость и транспортные документы.', icon: Truck, group: 'reference' },
  { id: 'drivers', title: 'Водители', description: 'Контакты, документы и автомобили водителей.', icon: UsersRound, group: 'reference' },
  { id: 'customers', title: 'Клиенты', description: 'Получатели груза и сведения для доставки.', icon: Building2, group: 'reference' },
  { id: 'suppliers', title: 'Поставщики', description: 'Поставщики топлива и их реквизиты.', icon: Package, group: 'reference' },
  { id: 'oilDepots', title: 'Нефтебазы', description: 'Места погрузки и участники перевозки.', icon: Factory, group: 'reference' },
  { id: 'products', title: 'Товары', description: 'Топливо и сведения для транспортных документов.', icon: Fuel, group: 'reference' },
  { id: 'addresses', title: 'Адреса доставки', description: 'Площадки, адреса и ссылки на карты.', icon: MapPin, group: 'reference' },
]
const pageFromHash = (): LogisticsPage => pages.find(item => `#${item.id}` === location.hash)?.id ?? 'trips'

export default function LogisticsApp() {
  return <AuthGate workspace="logistics">{(user, onLogout) => user.role === 'driver' ? <DriverWorkspace key={user.id} user={user} onLogout={onLogout}/> : <LogisticsWorkspace key={`${user.id}:${user.version}`} user={user} onLogout={onLogout}/>}</AuthGate>
}

function LogisticsWorkspace({ user, onLogout }: { user: AccountUser; onLogout: () => void }) {
  const [page, setPage] = useState<LogisticsPage>(pageFromHash)
  const [data, setData] = useState<DirectoryData | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const request = useRef(0)
  const controller = useRef<AbortController | null>(null)
  const canEnter = hasSection(user, 'trips')
  const canReadDirectories = hasSection(user, 'directories')
  const canManage = isAdministrator(user)
  const available = pages.filter(item => item.id === 'trips' || canReadDirectories)
  const active = available.find(item => item.id === page) ?? available[0]
  const refresh = useCallback(() => {
    const sequence = ++request.current
    controller.current?.abort()
    const pending = new AbortController()
    controller.current = pending
    setLoading(true)
    setError('')
    void apiFetch('/api/context', { cache: 'no-store', signal: pending.signal })
      .then(async response => {
        const result = await response.json()
        if (!response.ok) throw new Error(result.error || 'Не удалось загрузить справочники рейсов.')
        if (sequence === request.current) setData(result)
      })
      .catch(reason => { if (!pending.signal.aborted && sequence === request.current) setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.') })
      .finally(() => { if (!pending.signal.aborted && sequence === request.current) setLoading(false) })
  }, [])
  useEffect(() => {
    if (canEnter) refresh()
    return () => { controller.current?.abort(); request.current++ }
  }, [refresh, canEnter])
  useEffect(() => {
    const navigate = () => { setPage(pageFromHash()); window.scrollTo({ top: 0, behavior: 'instant' }) }
    window.addEventListener('hashchange', navigate)
    return () => window.removeEventListener('hashchange', navigate)
  }, [])
  useEffect(() => { document.title = `${active.title} — Артэль Логистика` }, [active.title])

  return <div className="logistics-shell">
    <a className="skip-link" href="#logistics-content" onClick={event => { event.preventDefault(); document.getElementById('logistics-content')?.focus() }}>К содержимому</a>
    <header className="logistics-topbar">
      <a href="#trips" className="logistics-brand" aria-label="Артэль — Логистика"><span className="logistics-brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32"><path d="M5 26 16 5l11 21h-7l-4-8-4 8Z" fill="currentColor"/></svg></span><span><strong>Артэль</strong><small>Логистика</small></span></a>
      <div className="logistics-account"><span title={user.name}>{user.name}</span><button className="button" onClick={onLogout}><LogOut size={16}/><span>Выйти</span></button></div>
    </header>
    {canEnter && <aside className="logistics-navigation">
      <nav aria-label="Навигация логистики">{(['work', 'reference'] as const).map(group => <div className="logistics-nav-group" key={group}>
        {available.some(item => item.group === group) && <p>{group === 'work' ? 'Рабочее место' : 'Справочники'}</p>}
        {available.filter(item => item.group === group).map(item => <a key={item.id} href={`#${item.id}`} aria-current={active.id === item.id ? 'page' : undefined}><item.icon size={19}/><span>{item.title}</span></a>)}
      </div>)}</nav>
      <label className="logistics-mobile-navigation"><span>Раздел</span><select aria-label="Раздел логистики" value={active.id} onChange={event => { location.hash = event.target.value }}>{(['work', 'reference'] as const).filter(group => available.some(item => item.group === group)).map(group => <optgroup key={group} label={group === 'work' ? 'Рабочее место' : 'Справочники'}>{available.filter(item => item.group === group).map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</optgroup>)}</select></label>
    </aside>}
    <main id="logistics-content" tabIndex={-1} className="logistics-content">
      <div className="logistics-page-heading"><div><h1>{active.title}</h1><p>{active.description}</p></div><span className="logistics-workspace-label">Рабочее место логиста</span></div>
      {!canEnter ? <p className="shipment-error" role="alert">Раздел «Рейсы» недоступен. Обратитесь к администратору.</p> : <>
        {error && <div className="shipment-error logistics-load-error" role="alert"><span>{error}</span><button className="button" disabled={loading} onClick={refresh}>Повторить загрузку</button></div>}
        {!data && loading && <div className="loading-state" role="status"><LoaderCircle className="spin"/><p>Загружаем рабочее место…</p></div>}
        {data && <div className="logistics-page-content">
          {active.id === 'trips' ? <TripsPage data={data} canManagePlaces={canManage} onChanged={refresh} allowDelete={canManage}/> : <>
            {!canManage && <p className="logistics-readonly">Справочник доступен для просмотра. Изменения вносит администратор.</p>}
            <DirectoriesPage key={active.id} data={data} onChanged={refresh} canManage={canManage} initialTab={active.id} allowedTabs={[active.id]} hideTabs/>
          </>}
        </div>}
      </>}
    </main>
  </div>
}

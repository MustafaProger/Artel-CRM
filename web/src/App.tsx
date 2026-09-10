import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowDownToLine, ArrowRight, ArrowUpRight, Building2, CalendarDays, Check, ChevronDown, ChevronLeft, ChevronRight, CircleHelp, Database, ClipboardList, Globe, Headphones, Banknote, LayoutDashboard, LoaderCircle, Menu, PackageCheck, Search, PanelLeftClose, PanelLeftOpen, Truck, Users, Wallet, X, type LucideIcon } from 'lucide-react'
import type { Snapshot, Company, Shipment, Payment } from './model'
import ChinaPage from './ChinaPage'
import TeamPage from './TeamPage'
import ShipmentsPage from './ShipmentsPage'
import DirectoriesPage from './DirectoriesPage'
import CompanySearchDialog from './CompanySearchDialog'
import WorkPage from './WorkPage'
import AuthGate from './AuthGate'
import AccountManagement from './AccountManagement'
import type { AccountUser } from './auth-model'
import { number, money, shortNumber, formatDate, monthName, roleName, descendingDate, downloadCsv, sum } from './utils'

type Page = 'overview' | 'work' | 'shipments' | 'payments' | 'stock' | 'china' | 'operator' | 'payroll' | 'team' | 'directories'
const pages: {id: Page; title: string; icon: LucideIcon; section: number; description: string}[] = [
  {id:'overview',title:'Обзор',icon:LayoutDashboard,section:0,description:''},
  {id:'work',title:'Работа',icon:ClipboardList,section:0,description:'Задачи, календарь и работа с компаниями.'},
  {id:'shipments',title:'Отгрузки',icon:Truck,section:0,description:'Движение топлива — от поставщика до покупателя.'},
  {id:'payments',title:'Платежи',icon:Wallet,section:0,description:'Поступления и списания из банковской выписки.'},
  {id:'stock',title:'Склад',icon:PackageCheck,section:0,description:''},
  {id:'china',title:'Китай',icon:Globe,section:0,description:''},
  {id:'operator',title:'Операторская',icon:Headphones,section:0,description:''},
  {id:'payroll',title:'ЗП',icon:Banknote,section:1,description:''},
  {id:'directories',title:'Справочники',icon:Building2,section:1,description:'Компании и менеджеры, товары, водители и автомобили.'},
  {id:'team',title:'Команды и роли',icon:Users,section:1,description:'Пользователи и права доступа.'},
]
const getPage = (): Page => location.hash === '#companies' ? 'shipments' : pages.some(p => p.id === location.hash.slice(1)) ? location.hash.slice(1) as Page : 'overview'
type Detail = {kind:'company'; item: Company} | {kind:'shipment'; item: Shipment} | {kind:'payment'; item: Payment} | {kind:'about'}

export default function App(){return <AuthGate>{(user,onLogout)=><WorkspaceApp key={user.id} user={user} onLogout={onLogout}/>}</AuthGate>}
function WorkspaceApp({user,onLogout}:{user:AccountUser;onLogout:()=>void}) {
  const canManage=user.role!=='manager'
  const [data,setData] = useState<Snapshot | null>(null)
  const [error,setError] = useState('')
  const [page,setPage] = useState<Page>(getPage)
  const [menu,setMenu] = useState(false)
  const [collapsed,setCollapsed] = useState(()=>{try{return localStorage.getItem('artel-sidebar-collapsed')==='true'}catch{return false}})
  const toggleSidebar = ()=>setCollapsed(value=>{const next=!value;try{localStorage.setItem('artel-sidebar-collapsed',String(next))}catch{/* Storage may be disabled. */}return next})
  const [search,setSearch] = useState('')
  const [companySearch,setCompanySearch] = useState(false)
  const [period,setPeriod] = useState('all')
  const [detail,setDetail] = useState<Detail | null>(null)
  const [toast,setToast] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const sidebarRef = useRef<HTMLElement>(null)
  useEffect(() => {
    if (!menu) return
    const opener = document.activeElement as HTMLElement | null
    const sidebar = sidebarRef.current
    sidebar?.querySelector<HTMLButtonElement>('.sidebar-mobile-close')?.focus()
    const trapFocus = (event: KeyboardEvent) => {
      if (event.key !== 'Tab' || !sidebar) return
      const items = Array.from(sidebar.querySelectorAll<HTMLElement>('a[href], button')).filter(item => item.getClientRects().length > 0)
      const first = items[0], last = items[items.length - 1]
      if (event.shiftKey && document.activeElement === first) {event.preventDefault();last?.focus()}
      else if (!event.shiftKey && document.activeElement === last) {event.preventDefault();first?.focus()}
    }
    window.addEventListener('keydown', trapFocus)
    return () => {window.removeEventListener('keydown', trapFocus);if(opener?.isConnected)opener.focus()}
  }, [menu])
  const fetchData = () => { setError(''); fetch('/api/snapshot?shipments=omit').then(r => {if(!r.ok) throw new Error('Не удалось открыть локальную выгрузку'); return r.json()}).then(setData).catch(e => setError(e.message)) }
  useEffect(fetchData, [])
  useEffect(() => { if(location.hash === '#companies') location.replace('#shipments') }, [])
  useEffect(() => { const handle = () => {const nextPage=getPage();setPage(nextPage);setMenu(false);setDetail(null);setToast('')}; window.addEventListener('hashchange',handle);return () => window.removeEventListener('hashchange',handle) },[])
  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(''),3200); return () => clearTimeout(timer) },[toast])
  useEffect(() => { const key = (event: KeyboardEvent) => {if((event.metaKey || event.ctrlKey) && event.key === 'k') {event.preventDefault();setCompanySearch(true)} if(event.key === 'Escape') setMenu(false)};window.addEventListener('keydown',key);return () => window.removeEventListener('keydown',key) },[])
  const navigate = (id: Page) => {location.hash = id;setPage(id);setMenu(false);window.scrollTo({top:0,behavior:'instant'})}
  const active = pages.find(p => p.id === page)!
  const notifyExport = () => setToast('Файл CSV подготовлен и скачан')
  return <div className={`app-shell ${page === 'shipments' ? 'shipments-focus' : ''} ${collapsed && page !== 'shipments' ? 'sidebar-collapsed' : ''}`}>
    {menu && <button className="sidebar-scrim" aria-label="Закрыть меню" onClick={() => setMenu(false)}/>}
    <aside id="app-navigation" ref={sidebarRef} inert={page === 'shipments' && !menu} role={menu ? 'dialog' : undefined} aria-modal={menu ? true : undefined} aria-label={menu ? 'Меню разделов' : undefined} className={`sidebar ${menu ? 'is-open' : ''}`}>
      <div className="sidebar-heading"><a className="brand" href="#overview" onClick={() => setMenu(false)}><span className="brand-mark"><svg viewBox="0 0 32 32" aria-hidden="true"><path d="M5 26 16 5l11 21h-7l-4-8-4 8Z" fill="currentColor"/></svg></span><span className="brand-name">Артель</span></a><button className="icon-button sidebar-toggle" aria-label={collapsed?'Развернуть панель':'Свернуть панель'} title={collapsed?'Развернуть панель':'Свернуть панель'} aria-expanded={!collapsed} onClick={toggleSidebar}>{collapsed?<PanelLeftOpen size={20}/>:<PanelLeftClose size={20}/>}</button><button className="icon-button sidebar-mobile-close" aria-label="Закрыть меню" onClick={()=>setMenu(false)}><X size={20}/></button></div>
      <nav aria-label="Основная навигация">{pages.filter(p => p.section === 0).map(p => <NavItem key={p.id} {...p} active={page === p.id} onClick={() => navigate(p.id)} count={data && p.id === 'shipments' ? data.overview.shipmentCount : undefined}/>)}</nav>
      <div className="nav-label second-label">УПРАВЛЕНИЕ</div>
      <nav aria-label="Управление">{pages.filter(p => p.section === 1).map(p => <NavItem key={p.id} {...p} active={page === p.id} onClick={() => navigate(p.id)}/>)}</nav>
      <div className="sidebar-bottom"><button className="nav-item" aria-label="О приложении" title="О приложении" onClick={()=>setDetail({kind:'about'})}><CircleHelp size={19}/><span>О приложении</span></button></div>
    </aside>
    <div className="workspace-main" inert={menu}>
      <header className="topbar"><div className="breadcrumb"><button className="icon-button mobile-menu" aria-label="Открыть меню" onClick={() => setMenu(true)}><Menu size={21}/></button><strong>{active.title}</strong></div><div className="topbar-actions"><form className="global-search" onSubmit={e => {e.preventDefault();setCompanySearch(true)}}><button type="submit" className="icon-button global-search-submit" aria-label="Найти контрагента" title="Найти контрагента"><Search size={18}/></button><input ref={searchRef} aria-label="Глобальный поиск контрагентов" placeholder="Найти контрагента…" value={search} onChange={e => setSearch(e.target.value)}/><kbd>⌘ K</kbd></form><div className="auth-user"><span title={user.name}>{user.name}</span><button className="button" onClick={onLogout}>Выйти</button></div></div></header>
      <main id="main-content"><div className="page-heading"><div><div className="eyebrow">АРТЕЛЬ / {page === 'overview' ? 'РАБОЧИЙ СТОЛ' : active.title.toUpperCase()}</div><h1>{active.title}<span className="heading-dot">.</span></h1><p>{active.description}</p></div>{(page === 'shipments' || page === 'payments') && data && <label className="period-control"><CalendarDays size={16}/><select aria-label="Период" value={period} onChange={e => setPeriod(e.target.value)}><option value="all">Все месяцы</option>{data.monthly.map(m => <option key={m.month} value={m.month}>{monthName(m.month)}</option>)}</select><ChevronDown size={14}/></label>}</div>
      {page === 'shipments' && (!data || error) && <button className="button" aria-label="Открыть меню" aria-controls="app-navigation" aria-expanded={menu} onClick={()=>setMenu(true)}><Menu size={20}/>Меню</button>}
      {error ? <div className="panel error-state"><Database size={32}/><h2>Данные пока недоступны</h2><p>{error}. Проверьте, что сервер запущен из папки проекта.</p><button className="button primary" onClick={fetchData}>Повторить загрузку</button></div> : !data ? <div className="loading-state"><LoaderCircle className="spin"/><p>Загружаем CRM…</p></div> : <div key={page} className="page-content">
      {['overview','stock'].includes(page) && <section className="blank-workspace" aria-label={`${active.title}: рабочее пространство`}/>}
      {page === 'china' && <ChinaPage canManage={canManage}/>}
      {page === 'operator' && <section className="blank-workspace" aria-label="Операторская: рабочее пространство"><p className="soft-notice">Excel-файл с системой учёта не предоставлен. Структура работы и расчёты пока не настроены.</p></section>}
      {page === 'work' && <WorkPage/>}
      {page === 'payroll' && <PayrollPage/>}
      {page === 'shipments' && <ShipmentsPage canDelete={canManage} onOpenMenu={()=>setMenu(true)} menuOpen={menu} data={data} period={period} onPeriodChange={setPeriod} onChanged={fetchData} onOpenCompany={company=>setDetail({kind:'company',item:company})}/>}
      {page === 'directories' && <DirectoriesPage canManage={canManage} data={data} onChanged={fetchData}/>}
      {page === 'payments' && <Payments data={data} period={period} open={setDetail} notify={notifyExport}/>}
      {page === 'team' && <>{canManage&&<AccountManagement directories={data.directories!}/>}<TeamPage managerLabels={data.directories!.managers.map(m => ({name:m.name,shipmentCount:data.managers.find(manager=>manager.label===m.name)?.shipmentCount??0}))}/></>}
      </div>}
      <footer className="page-footer"><span><span className="tiny-mark">а</span> Артель CRM <span className="footer-divider">/</span> Учёт отгрузок</span><span>Компании · Топливо · Расчёты</span></footer>
      </main>
    </div>
    {companySearch && data && <CompanySearchDialog companies={data.companies} initialQuery={search} onClose={()=>setCompanySearch(false)} onOpen={company=>{setCompanySearch(false);setDetail({kind:'company',item:company})}}/>}
    {detail && data && <DetailDialog detail={detail} data={data} onClose={() => setDetail(null)} open={setDetail}/>}
    {toast && <div className="toast" role="status"><Check size={18}/>{toast}</div>}
  </div>
}
function NavItem({title,icon:Icon,active,onClick,count}: {title:string;icon:LucideIcon;active:boolean;onClick:()=>void;count?:number}) {return <button className={`nav-item ${active?'active':''}`} aria-label={title} title={title} onClick={onClick} aria-current={active?'page':undefined}><Icon size={19} strokeWidth={1.7}/><span>{title}</span>{count !== undefined && <small>{number(count)}</small>}{active && <span className="active-indicator"/>}</button>}
function Stat({label,value,unit,description,icon:Icon,trend}: {label:string;value:string;unit?:string;description:string;icon:LucideIcon;trend?:number[]}) {return <div className="stat-card"><div className="stat-label">{label}<Icon size={18}/></div><div className="stat-value">{value}<span>{unit}</span></div><div className="stat-bottom"><span>{description}</span>{trend && <Sparkline values={trend}/>}</div></div>}
function Sparkline({values}: {values:number[]}) {const max = Math.max(...values,1),min=Math.min(...values,0);return <svg viewBox="0 0 84 26" className="sparkline" aria-hidden="true"><polyline points={values.map((v,i)=>`${i*84/Math.max(values.length-1,1)},${24-(v-min)/(max-min)*21}`).join(' ')} fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round"/></svg>}
function Empty(){return <div className="empty-state"><Search size={25}/><strong>Ничего не найдено</strong><span>Попробуйте другой запрос или сбросьте фильтры.</span></div>}
function SearchField({value,onChange,placeholder}: {value:string;onChange:(v:string)=>void;placeholder:string}) {return <label className="table-search"><Search size={17}/><input aria-label={placeholder} placeholder={placeholder} value={value} onChange={e=>onChange(e.target.value)}/>{value&&<button className="clear-input" aria-label="Очистить поиск" onClick={()=>onChange('')}><X size={14}/></button>}</label>}
function Pagination({page,setPage,total,size=12}: {page:number;setPage:(n:number)=>void;total:number;size?:number}) {const max=Math.max(1,Math.ceil(total/size));return <div className="pagination"><span>{total?`${number((page-1)*size+1)}–${number(Math.min(page*size,total))}`:'0'} из {number(total)}</span><div><button className="icon-button" disabled={page<=1} aria-label="Предыдущая страница" onClick={()=>setPage(page-1)}><ChevronLeft size={17}/></button><span>{page} <span className="muted">/ {max}</span></span><button className="icon-button" disabled={page>=max} aria-label="Следующая страница" onClick={()=>setPage(page+1)}><ChevronRight size={17}/></button></div></div>}
function ExportButton({onClick}: {onClick:()=>void}) {return <button className="button" onClick={onClick}><ArrowDownToLine size={16}/>Экспорт CSV</button>}
function Payments({data,period,open,notify}: {data:Snapshot;period:string;open:(d:Detail)=>void;notify:()=>void}) {
 const [query,setQuery]=useState(''),[direction,setDirection]=useState('all'),[page,setPage]=useState(1)
 useEffect(()=>setPage(1),[query,direction,period])
 const filtered=data.payments.filter(p=>(period==='all'||p.date?.startsWith(period))&&(direction==='all'||(direction==='incoming'?p.incoming!==null&&Number(p.incoming)!==0:direction==='outgoing'?p.outgoing!==null&&Number(p.outgoing)!==0:!p.date))&&[p.counterparty,p.purpose,p.fields.month,p.fields.unlabelled_extra,String(p.sourceRow)].some(v=>v?.toLowerCase().includes(query.toLowerCase()))).sort(descendingDate)
 return <><div className="payment-stats"><Stat label="Поступления" value={shortNumber(sum(filtered.map(p=>p.incoming)))} unit="₽" description="Включая суммы, распознанные из текста" icon={ArrowDownLeft}/><Stat label="Списания" value={shortNumber(sum(filtered.map(p=>p.outgoing)))} unit="₽" description="По выбранным строкам выписки" icon={ArrowUpRight}/><Stat label="Строки выписки" value={number(filtered.length)} description="По текущим фильтрам" icon={Wallet}/></div><section className="panel"><div className="table-toolbar"><SearchField value={query} onChange={setQuery} placeholder="Контрагент или назначение…"/><div className="toolbar-actions"><select aria-label="Направление платежа" className="filter-select" value={direction} onChange={e=>setDirection(e.target.value)}><option value="all">Все операции</option><option value="incoming">Поступления</option><option value="outgoing">Списания</option><option value="undated">Без даты</option></select><ExportButton onClick={()=>{downloadCsv('Артель-платежи.csv',['Месяц из файла','Дата','Строка источника','Контрагент','Поступление, ₽','Списание, ₽','Назначение','Доп. поле из файла'],filtered.map(p=>[p.fields.month??null,p.date,p.sourceRow,p.counterparty,p.incoming,p.outgoing,p.purpose,p.fields.unlabelled_extra??null]));notify()}}/></div></div><div className="table-scroll"><table aria-label="Платежи из выписки"><thead><tr><th data-field="month">Месяц из файла</th><th>Дата / строка</th><th>Контрагент</th><th>Назначение платежа</th><th className="align-right">Поступление, ₽</th><th className="align-right">Списание, ₽</th><th data-field="unlabelled_extra">Доп. поле из файла</th><th/></tr></thead><tbody>{filtered.slice((page-1)*12,page*12).map(p=><tr key={p.id} data-source-row={p.sourceRow}><td data-field="month" className="tabular">{p.fields.month??'—'}</td><td><button className="date-link" onClick={()=>open({kind:'payment',item:p})}>{formatDate(p.date)}<small>#{p.sourceRow}</small></button></td><td><button className="company-text-link" onClick={()=>open({kind:'payment',item:p})}>{p.counterparty||'Не указан'}</button></td><td className="purpose-cell" title={p.purpose||''}>{p.purpose||'—'}</td><td className="align-right tabular positive">{money(p.incoming,2)}</td><td className="align-right tabular">{money(p.outgoing,2)}</td><td data-field="unlabelled_extra">{p.fields.unlabelled_extra??'—'}</td><td><button className="icon-button" aria-label={`Открыть платёж ${p.sourceRow}`} onClick={()=>open({kind:'payment',item:p})}><ChevronRight size={15}/></button></td></tr>)}</tbody></table>{!filtered.length&&<Empty/>}</div><Pagination page={page} setPage={setPage} total={filtered.length}/></section><p className="section-note">Поступления и списания не определяют долг контрагента без сверки начального остатка и назначения платежей.</p></>
}
function DetailDialog({detail,data,onClose,open}: {detail:Detail;data:Snapshot;onClose:()=>void;open:(d:Detail)=>void}) {
 const ref=useRef<HTMLDialogElement>(null)
 const [tab,setTab]=useState('info')
 useEffect(()=>{const dialog=ref.current;dialog?.showModal();const old=document.body.style.overflow;document.body.style.overflow='hidden';return()=>{dialog?.close();document.body.style.overflow=old}},[])
 useEffect(()=>setTab('info'),[detail])
 const title=detail.kind==='about'?'О приложении Артель':detail.kind==='company'?detail.item.name:detail.kind==='shipment'?(detail.item.sourceRow ? `Отгрузка · строка ${detail.item.sourceRow}` : `Отгрузка · ${formatDate(detail.item.date)}`):`Платёж · строка ${detail.item.sourceRow}`
 return <dialog ref={ref} className="detail-dialog" onCancel={onClose} onClick={e=>{if(e.target===ref.current)onClose()}} aria-labelledby="dialog-title"><div className="dialog-inner"><div className="dialog-heading"><span className="eyebrow">{detail.kind==='company'?'КАРТОЧКА КОНТРАГЕНТА':detail.kind==='about'?'АРТЕЛЬ CRM / 0.1':detail.kind==='shipment'&&!detail.item.sourceRow?'ОПЕРАЦИЯ CRM':'ЗАПИСЬ ИЗ EXCEL'}</span><button className="icon-button" aria-label="Закрыть карточку" onClick={onClose}><X size={20}/></button></div><h2 id="dialog-title">{title}</h2>
 {detail.kind==='about'?<><p className="dialog-lead">Артель — CRM для учёта отгрузок топлива и расчётов.</p><div className="about-grid"><Info label="Операции" value="Создание, редактирование и экспорт отгрузок"/><Info label="Справочники" value="Компании, менеджеры, товары, водители и автомобили"/></div></>:detail.kind==='company'?<><div className="badge-list dialog-badges">{[...new Set(detail.item.roles.map(roleName))].map(r=><span className="badge green" key={r}>{r}</span>)}<span className="badge">{detail.item.registrySource ? 'Чекко' : 'Справочник'}</span></div><div className="dialog-tabs"><button onClick={()=>setTab('info')} className={tab==='info'?'selected':''}>Информация</button><button onClick={()=>setTab('shipments')} className={tab==='shipments'?'selected':''}>Отгрузки <small>{detail.item.shipmentIds.length}</small></button><button onClick={()=>setTab('payments')} className={tab==='payments'?'selected':''}>Платежи <small>{detail.item.paymentIds.length}</small></button></div>{tab==='info'?<><div className="about-grid"><Info label="Наименование" value={detail.item.name}/>{detail.item.fullName&&<Info label="Полное наименование" value={detail.item.fullName}/>}<Info label="Менеджер компании" value={data.directories?.managers.find(manager=>manager.id===data.directories?.customerManagers?.find(row=>row.companyId===detail.item.id)?.managerId)?.name||'Не назначен'}/><Info label="Фактические адреса" value={data.directories?.addresses.filter(address=>address.companyId===detail.item.id).map(address=>`${address.kind==='loading'?'Загрузка':'Отгрузка клиента'}: ${address.name}`).join('\n')||'Не указаны'}/><Info label="ИНН" value={detail.item.inn || 'Не указан'}/><Info label="КПП" value={detail.item.kpp || 'Не указан'}/><Info label="ОГРН / ОГРНИП" value={detail.item.ogrn || 'Не указан'}/><Info label="Юридический адрес" value={detail.item.address || 'Не указан'}/><Info label="Статус" value={detail.item.status || 'Не проверен'}/></div><div className="soft-notice">{detail.item.registrySource ? `Реквизиты получены из Чекко${detail.item.registryCheckedAt ? ' · ' + new Date(detail.item.registryCheckedAt).toLocaleDateString('ru-RU') : ''}.` : 'Данные компании можно изменить в справочнике.'}</div></>:tab==='shipments'?<CompanyShipmentRecords company={detail.item} open={open}/>:<div className="dialog-records">{data.payments.filter(p=>detail.item.paymentIds.includes(p.id)).sort(descendingDate).map(p=><button key={p.id} onClick={()=>open({kind:'payment',item:p})}><span><strong>{formatDate(p.date)}</strong><small>Строка {p.sourceRow} · {p.incoming!==null&&p.outgoing!==null?'Поступление / списание':p.incoming!==null?'Поступление':p.outgoing!==null?'Списание':'Без суммы'}</small></span><strong>{p.incoming!==null&&<>Приход: {money(p.incoming,2)}<br/></>}{p.outgoing!==null&&<>Расход: {money(p.outgoing,2)}</>}{p.incoming===null&&p.outgoing===null?'Без суммы':null}</strong><ChevronRight size={16}/></button>)}{!detail.item.paymentIds.length&&<Empty/>}</div>}</>:<><p className="dialog-lead">{detail.item.sourceRow ? `${detail.item.sourceSheet} / строка ${detail.item.sourceRow}` : 'Локальная операция'}</p><div className="about-grid"><Info label="Дата" value={formatDate(detail.item.date)}/>{detail.kind==='shipment'?<><Info label="Покупатель" value={detail.item.customer||'Не указан'}/><Info label="Поставщик" value={detail.item.supplier||'Не указан'}/><Info label="Перевозчик" value={detail.item.carrier||'Не указан'}/><Info label="Топливо" value={detail.item.product||'Не указано'}/><Info label="Объём" value={`${number(detail.item.liters,2)} л`}/><Info label="Сумма отгрузки" value={money(detail.item.revenue,2)}/><Info label="Закупка по источнику" value={money(detail.item.cost,2)}/><Info label="Подпись менеджера" value={detail.item.manager||'Не указана'}/></>:<><Info label="Месяц из файла" value={detail.item.fields.month??'Не указан'}/><Info label="Контрагент" value={detail.item.counterparty||'Не указан'}/><Info label="Поступление" value={money(detail.item.incoming,2)}/><Info label="Списание" value={money(detail.item.outgoing,2)}/><Info label="Доп. поле из файла" value={detail.item.fields.unlabelled_extra??'Не указано'}/></>}</div>{detail.kind==='payment'&&<Info label="Назначение платежа" value={detail.item.purpose||'Не указано'}/>}<div className="soft-notice">{detail.item.flags.length ? <>Замечания источника: {detail.item.flags.map(flag=>flagLabel(flag)).join('; ')}.</> : !detail.item.sourceRow ? 'Операция сохранена в CRM.' : 'Значения сохранены из исходного Excel. Формулы не пересчитывались.'}</div>{(()=>{const id=detail.kind==='shipment'?detail.item.customerId:detail.item.counterpartyId;const company=data.companies.find(c=>c.id===id);return company?<button className="button primary" onClick={()=>open({kind:'company',item:company})}>Открыть контрагента <ArrowRight size={16}/></button>:null})()}</>}
 </div></dialog>
}
function Info({label,value}: {label:string;value:ReactNode}){return <div className="info-item"><span>{label}</span><strong>{value}</strong></div>}
function CompanyShipmentRecords({company,open}: {company:Company;open:(detail:Detail)=>void}) {
 const [rows,setRows]=useState<Shipment[]>([])
 const [offset,setOffset]=useState(0)
 const [total,setTotal]=useState(0)
 const [loading,setLoading]=useState(true)
 const [error,setError]=useState('')
 const [retry,setRetry]=useState(0)
 useEffect(()=>{
   const controller=new AbortController()
   setLoading(true);setError('')
   fetch(`/api/shipments?limit=50&offset=${offset}&companyId=${encodeURIComponent(company.id)}`,{signal:controller.signal})
     .then(async response=>{if(!response.ok)throw new Error('Не удалось загрузить отгрузки');return response.json()})
     .then(result=>{setRows(previous=>offset?[...previous,...result.items]:result.items);setTotal(result.total)})
     .catch(error=>{if(error.name!=='AbortError')setError(error.message)})
     .finally(()=>{if(!controller.signal.aborted)setLoading(false)})
   return()=>controller.abort()
 },[company.id,offset,retry])
 return <div className="dialog-records">{rows.map(shipment=><button key={shipment.id} onClick={()=>open({kind:'shipment',item:shipment})}><span><strong>{formatDate(shipment.date)} · {shipment.product||'Топливо не указано'}</strong><small>{shipment.customer||'Без покупателя'}</small></span><strong>{number(shipment.liters,2)} л</strong><ChevronRight size={16}/></button>)}{loading&&<p className="soft-notice">Загружаем отгрузки…</p>}{error&&<div className="soft-notice" role="alert">{error} <button className="button" onClick={()=>setRetry(value=>value+1)}>Повторить</button></div>}{!loading&&!error&&!rows.length&&<Empty/>}{!loading&&!error&&rows.length<total&&<button className="button" onClick={()=>setOffset(rows.length)}>Показать ещё 50</button>}</div>
}
function flagLabel(flag:string) {return ({incoming_amount_stored_as_text:'поступление распознано из текста',outgoing_amount_stored_as_text:'списание распознано из текста',manager_formula_broken:'повреждена формула менеджера',manager_unresolved:'менеджер не определён',missing_customer:'не указан покупатель',missing_supplier:'не указан поставщик',missing_counterparty:'не указан контрагент',no_nonzero_amount:'нет ненулевой суммы',missing_or_invalid_date:'дата отсутствует или некорректна',both_incoming_and_outgoing:'одновременно поступление и списание',invalid_date:'некорректная дата',zero_date:'ноль вместо даты',incomplete_source_row:'неполная строка',missing_date:'дата отсутствует'}[flag]||flag.replaceAll('_',' '))}

function PayrollPage(){const [tab,setTab]=useState('drivers');return <><div className="payroll-tabs" role="tablist" aria-label="Направление зарплат">{[['drivers','Зарплаты водителей'],['managers','Зарплаты менеджеров']].map(([id,title])=><button key={id} id={`payroll-${id}`} className={`button ${tab===id?'primary':''}`} role="tab" aria-selected={tab===id} aria-controls="payroll-content" onClick={()=>setTab(id)}>{title}</button>)}</div><section id="payroll-content" role="tabpanel" aria-labelledby={`payroll-${tab}`} className="payroll-space"/></>}

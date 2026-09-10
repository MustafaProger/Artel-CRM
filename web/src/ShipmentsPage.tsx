import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { ArrowDownToLine, ArrowUp, ArrowDown, Filter, BookOpen, Check, ChevronDown, LoaderCircle, Pencil, Plus, Menu, Search, Trash2, Truck, X } from 'lucide-react'
import type { Company, Metric, Shipment, ShipmentTrip, ShipmentType, Snapshot } from './model'
import { downloadCsv, formatDate, number } from './utils'
import ShipmentEditor from './ShipmentEditor'
import ShipmentColumnFilter from './ShipmentColumnFilter'
import type { ColumnFilter } from './shipment-filters'
import { monthName } from './utils'
import { fieldValue, groupTitles, shipmentTemplates, azsShipmentTemplates, type ShipmentColumn, type TemplateId } from './shipment-templates'
import './shipments.css'

interface ShipmentPageResult {
  items: Shipment[]; total: number; hasMore: boolean; nextOffset: number;
  summary: {liters: Metric; revenue: Metric; cost: Metric}; topCustomers: {id:string;name:string;revenue:string|null}[]
}
const PAGE_SIZE = 50, ROW_HEIGHT = 38, HEADER_HEIGHT = 76, OVERSCAN = 8
const settlementOptions = [{id:'cashless',label:'Безнал'},{id:'cash',label:'Наличка'},{id:'f2',label:'Ф2'},{id:'unspecified',label:'Не указано'},{id:'all',label:'Все'}]
const templatePreference = () => {try {const saved = localStorage.getItem('artel:shipment-template'); return saved && Object.hasOwn(shipmentTemplates,saved) ? saved as TemplateId : 'expanded'} catch {return 'expanded'}}
const apiError = async (response: Response) => {const body = await response.json().catch(() => ({}));return new Error(body.error || body.message || `Не удалось выполнить запрос (${response.status})`)}

export default function ShipmentsPage({onOpenMenu,menuOpen,data,period,onPeriodChange,onChanged,onOpenCompany,initialQuery = '',canDelete = true}: {
  onOpenMenu: () => void; menuOpen: boolean; data: Snapshot; period: string; onPeriodChange: (period:string)=>void; onChanged: () => void; onOpenCompany: (company: Company) => void; initialQuery?: string; canDelete?: boolean
}) {
  const [shipmentType,setShipmentType] = useState<ShipmentType>('tanker')
  const [query,setQuery] = useState(initialQuery), [debouncedQuery,setDebouncedQuery] = useState(initialQuery)
  const [manager,setManager] = useState('all'), [settlement,setSettlement] = useState('all')
  const [filters,setFilters] = useState<Record<string,ColumnFilter>>({}), [filterColumn,setFilterColumn] = useState<ShipmentColumn|null>(null)
  const [sort,setSort] = useState('date'), [direction,setDirection] = useState('desc')
  const [azsFormat, setAzsFormat] = useState<'medium'|'small'>(() => { try { return localStorage.getItem('artel:azs-format') === 'small' ? 'small' : 'medium'; } catch { return 'medium'; } });
  const [template,setTemplate] = useState<TemplateId>(templatePreference)
  const [items,setItems] = useState<Shipment[]>([]), [total,setTotal] = useState(0), [hasMore,setHasMore] = useState(false), [nextOffset,setNextOffset] = useState(0)
  const [summary,setSummary] = useState<ShipmentPageResult['summary'] | null>(null)
  const [loading,setLoading] = useState(true), [error,setError] = useState(''), [revision,setRevision] = useState(0)
  const [editor,setEditor] = useState<{shipment:Shipment|null} | null>(null), [deleting,setDeleting] = useState<Shipment|null>(null)
  const [exporting,setExporting] = useState(false), [exportError,setExportError] = useState(''), [notice,setNotice] = useState('')
  const [scrollTop,setScrollTop] = useState(0), [viewportHeight,setViewportHeight] = useState(600)
  const scroller = useRef<HTMLDivElement>(null), request = useRef<AbortController|null>(null), exportRequest = useRef<AbortController|null>(null)
  const generation = useRef(0), busy = useRef(false)
  useEffect(() => setQuery(initialQuery), [initialQuery])
  useEffect(() => {const timer = setTimeout(() => setDebouncedQuery(query),250);return () => clearTimeout(timer)}, [query])
  useEffect(() => {try {localStorage.setItem('artel:shipment-template',template)} catch {/* The view also works without persistent browser storage. */}}, [template])
  useEffect(() => {if(!notice) return;const timer = setTimeout(() => setNotice(''),4500);return () => clearTimeout(timer)}, [notice])
  const params = useMemo(() => new URLSearchParams({type:shipmentType,period,query:debouncedQuery,manager,settlement,sort,direction,filters:JSON.stringify(filters)}).toString(), [shipmentType,period,debouncedQuery,manager,settlement,sort,direction,filters])
  const loadPage = useCallback(async (offset: number, replace: boolean, currentGeneration: number) => {
    if(busy.current) return
    const controller = new AbortController();request.current = controller;busy.current = true;setLoading(true);setError('')
    try {
      const response = await fetch(`/api/shipments?${params}&limit=${PAGE_SIZE}&offset=${offset}`,{signal:controller.signal})
      if(!response.ok) throw await apiError(response)
      const result: ShipmentPageResult = await response.json()
      if(currentGeneration !== generation.current) return
      setItems(previous => replace ? result.items : [...previous,...result.items.filter(item => !previous.some(p => p.id === item.id))])
      setTotal(result.total);setHasMore(result.hasMore);setNextOffset(result.nextOffset);setSummary(result.summary)
    } catch(e) {if(!controller.signal.aborted && currentGeneration === generation.current) setError(e instanceof Error ? e.message : 'Не удалось загрузить отгрузки')}
    finally {if(currentGeneration === generation.current) {busy.current = false;setLoading(false)}}
  },[params])
  useEffect(() => {
    request.current?.abort();busy.current = false
    const current = ++generation.current
    setItems([]);setTotal(0);setHasMore(false);setNextOffset(0);setSummary(null);setScrollTop(0)
    scroller.current?.scrollTo({top:0,behavior:'instant'})
    void loadPage(0,true,current)
    return () => {request.current?.abort();++generation.current;busy.current = false}
  }, [loadPage,revision])
  useEffect(() => {
    const element = scroller.current
    if(!element) return
    const observer = new ResizeObserver(() => setViewportHeight(element.clientHeight))
    observer.observe(element);setViewportHeight(element.clientHeight)
    return () => observer.disconnect()
  }, [])
  useEffect(() => () => exportRequest.current?.abort(), [])
  const loadMore = () => {if(hasMore && !busy.current) void loadPage(nextOffset,false,generation.current)}
  const refresh = () => {setRevision(value => value + 1);onChanged()}
  const chosenTemplate = shipmentType === 'azs' ? azsShipmentTemplates[azsFormat] : shipmentTemplates[template]
  const columns = chosenTemplate.columns
  const showActions = !(shipmentType === 'azs' && azsFormat === 'small')
  const extraColumns = showActions ? 1 : 0
  const groups = useMemo(() => columns.reduce<{key:string;title:string;count:number}[]>((result,column) => {
    const last = result[result.length - 1]
    if(last?.key === column.group) last.count++
    else result.push({key:column.group,title:groupTitles[column.group],count:1})
    return result
  },[]), [columns])
  const start = Math.max(0,Math.floor(Math.max(0,scrollTop - HEADER_HEIGHT) / ROW_HEIGHT) - OVERSCAN)
  const end = Math.min(items.length,start + Math.ceil(viewportHeight / ROW_HEIGHT) + OVERSCAN * 2)
  const visible = items.slice(start,end)
  const stickyStyle = (column: ShipmentColumn): CSSProperties | undefined => column.key === columns[0].key ? {left:0} : column.key === columns[1].key ? {left:columns[0].width} : undefined
  const exportRows = async () => {
    setExporting(true);setExportError('')
    const controller = new AbortController();exportRequest.current = controller
    const chosen = chosenTemplate
    try {
      const all: Shipment[] = [];let offset = 0, more = true
      while(more) {
        const response = await fetch(`/api/shipments?${params}&limit=${PAGE_SIZE}&offset=${offset}`,{signal:controller.signal})
        if(!response.ok) throw await apiError(response)
        const result: ShipmentPageResult = await response.json()
        all.push(...result.items);more = result.hasMore
        if(more && result.nextOffset <= offset) throw new Error('Сервер не вернул следующую часть выгрузки')
        offset = result.nextOffset
      }
      downloadCsv(`Артель-отгрузки-${chosen.title}.csv`,chosen.columns.map(c => c.title),all.map(item => chosen.columns.map(c => fieldValue(item,c.key))))
      setNotice(`Экспортировано операций: ${number(all.length)}`)
    } catch(e) {if(!controller.signal.aborted) setExportError(e instanceof Error ? e.message : 'Не удалось подготовить экспорт')}
    finally {setExporting(false)}
  }
  const companyFor = (shipment:Shipment,key:string) => data.companies.find(company => company.id === (key === 'customer_name' ? shipment.customerId : key === 'supplier_name' ? shipment.supplierId : shipment.carrierId))
  return <div className="shipments-workspace">
    <section className="panel shipment-panel" aria-label="Операции отгрузки">
      <div className="shipment-toolbar"><div className="shipment-title"><button className="icon-button shipment-menu" aria-label="Открыть меню" title="Меню разделов" aria-controls="app-navigation" aria-expanded={menuOpen} onClick={onOpenMenu}><Menu size={21}/></button><h1>Отгрузки</h1></div><label className="shipment-search"><Search size={17}/><input aria-label="Поиск отгрузок" placeholder="Поиск по всем колонкам…" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button className="icon-button" aria-label="Очистить поиск" onClick={()=>setQuery('')}><X size={16}/></button>}</label><button className="button primary" onClick={()=>setEditor({shipment:null})}><Plus size={17}/>Добавить отгрузку</button><a className="button" href="#directories"><BookOpen size={17}/>Справочники</a></div>
      <div className="shipment-type-tabs" role="tablist" aria-label="Тип отгрузок">{([{id:'tanker',label:'Бензовозы'},{id:'azs',label:'АЗС'}] as const).map(item=><button key={item.id} type="button" role="tab" aria-selected={shipmentType===item.id} className={shipmentType===item.id?'selected':''} onClick={()=>{setShipmentType(item.id);setFilters({});setFilterColumn(null);setSettlement('all');setSort('date');setDirection('desc')}}>{item.label}</button>)}</div>
      <div className="shipment-template-row"><div className="shipment-view-controls"><select aria-label="Период отгрузок" value={period} onChange={e=>onPeriodChange(e.target.value)}><option value="all">Все месяцы</option>{data.monthly.map(m=><option key={m.month} value={m.month}>{monthName(m.month)}</option>)}</select><select aria-label="Форма расчёта" value={settlement} onChange={e=>setSettlement(e.target.value)}>{settlementOptions.filter(o=>shipmentType !== 'azs' || !['f2','unspecified'].includes(o.id)).map(o=><option key={o.id} value={o.id}>{o.label}</option>)}</select><select aria-label="Фильтр менеджера" value={manager} onChange={e=>setManager(e.target.value)}><option value="all">Все менеджеры</option><option value="none">Без менеджера</option>{data.managers.map(m=><option key={m.id} value={m.label}>{m.label}</option>)}</select>{shipmentType === 'azs' && <select aria-label="Формат таблицы АЗС" value={azsFormat} onChange={e => { const format = e.target.value as 'medium'|'small'; setAzsFormat(format); setFilterColumn(null); try { localStorage.setItem('artel:azs-format', format); } catch { /* Optional preference */ } }}>{Object.entries(azsShipmentTemplates).map(([id, value]) => <option key={id} value={id}>{value.title}</option>)}</select>}{shipmentType === 'tanker' && <select aria-label="Вид таблицы" value={template} onChange={e=>setTemplate(e.target.value as TemplateId)}>{(Object.keys(shipmentTemplates) as TemplateId[]).map(id=><option key={id} value={id}>{shipmentTemplates[id].title} · {shipmentTemplates[id].columns.length}</option>)}</select>}</div><div className="shipment-view-actions">{(Object.keys(filters).length>0||query||manager!=='all'||settlement!=='all'||period!=='all')&&<button className="button" onClick={()=>{setFilters({});setQuery('');setManager('all');setSettlement('all');onPeriodChange('all')}}>Сбросить фильтры{Object.keys(filters).length?` · ${Object.keys(filters).length}`:''}</button>}<button className="button" onClick={exportRows} disabled={exporting||loading&&!items.length}>{exporting?<LoaderCircle className="spin" size={16}/>:<ArrowDownToLine size={16}/>}CSV</button></div></div>
      {exportError && <div className="shipment-error" role="alert">{exportError}</div>}
      <div ref={scroller} className="shipment-grid-scroll" data-testid="shipments-scroll" tabIndex={0} aria-label="Таблица отгрузок с горизонтальной и вертикальной прокруткой" onScroll={event => {
        const element = event.currentTarget;setScrollTop(element.scrollTop)
        if(element.scrollHeight - element.scrollTop - element.clientHeight < 850 || (element.scrollTop + element.clientHeight) / element.scrollHeight >= .7) loadMore()
      }}>
        <table className="shipment-grid" style={{width:columns.reduce((total,column) => total + column.width,0) + (showActions ? 80 : 0)}} aria-rowcount={total + 2} aria-colcount={columns.length + extraColumns}>
          <colgroup>{columns.map(column => <col key={column.key} style={{width:column.width}}/>)}{showActions && <col style={{width:80}}/>}</colgroup>
          <thead><tr className="shipment-group-headings">{groups.map((group,index) => <th key={`${group.key}-${index}`} colSpan={group.count} scope="colgroup" className={`group-${group.key}`}>{group.title}</th>)}{showActions && <th rowSpan={2} className="shipment-actions-heading" scope="col">Действия</th>}</tr><tr className="shipment-column-headings">{columns.map(column => <th key={column.key} scope="col" aria-sort={sort===column.key?(direction==='asc'?'ascending':'descending'):'none'} data-field={column.key} className={`group-${column.group} ${stickyStyle(column) ? 'shipment-sticky' : ''}`} style={stickyStyle(column)}><div className="column-controls"><button className="column-sort" aria-label={`Сортировать: ${column.title}`} onClick={()=>{setSort(column.key);setDirection(sort===column.key&&direction==='asc'?'desc':'asc')}}>{column.title}{sort===column.key&&(direction==='asc'?<ArrowUp size={13}/>:<ArrowDown size={13}/>)}</button><button className={`column-filter ${filters[column.key]?'is-filtered':''}`} aria-label={`Фильтр: ${column.title}`} aria-pressed={!!filters[column.key]} onClick={()=>setFilterColumn(column)}><Filter size={14}/></button></div></th>)}</tr></thead>
          <tbody>
            {start > 0 && <tr className="shipment-spacer" aria-hidden="true"><td colSpan={columns.length + extraColumns} style={{height:start * ROW_HEIGHT}}/></tr>}
            {visible.map((shipment,index) => <tr key={shipment.id} data-testid="shipment-row" data-shipment-id={shipment.id} aria-rowindex={start + index + 3}>
              {columns.map((column,columnIndex) => {
                const raw = fieldValue(shipment,column.key), company = column.kind === 'company' ? companyFor(shipment,column.key) : undefined
                const displayed = column.key === 'purchase_unit' && raw ? raw==='tonnes'?'₽/т':'₽/л' : column.key === 'month' && raw && /^\d{4}-\d{2}$/.test(raw) ? monthName(raw) : raw === null || raw === '' ? '—' : column.kind === 'date' && /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(raw) ? formatDate(raw.slice(0,10)) : column.kind === 'number' && /^-?\d+(\.\d+)?$/.test(raw) ? number(raw,4) : raw
                return <td key={column.key} tabIndex={index===0&&columnIndex===0?0:-1} data-column-index={columnIndex} onDoubleClick={()=>setEditor({shipment})} onKeyDown={e=>{if(e.key==='F2'||e.key==='Enter'){e.preventDefault();setEditor({shipment});return}if(!['ArrowDown','ArrowUp','ArrowLeft','ArrowRight'].includes(e.key))return;e.preventDefault();const cell=e.currentTarget;const target=(e.key==='ArrowRight'?cell.nextElementSibling:e.key==='ArrowLeft'?cell.previousElementSibling:(e.key==='ArrowDown'?cell.parentElement?.nextElementSibling:cell.parentElement?.previousElementSibling)?.querySelector(`[data-column-index="${columnIndex}"]`)) as HTMLElement|null;target?.focus()}} className={`${column.kind === 'number' ? 'shipment-numeric' : ''} ${stickyStyle(column) ? 'shipment-sticky' : ''} ${['customer_amount','profit_source'].includes(column.key) ? 'shipment-emphasis' : ''}`} style={stickyStyle(column)} title={raw ?? 'Не указано'}>{!showActions && column.key === 'date' ? <button className="shipment-company-link" aria-label={`Редактировать отгрузку ${shipment.id}`} onClick={() => setEditor({shipment})}>{displayed}</button> : company ? <button className="shipment-company-link" onClick={() => onOpenCompany(company)}>{displayed}</button> : <span className="shipment-cell-value">{displayed}</span>}</td>
              })}
              {showActions && <td className="shipment-row-actions"><button className="icon-button" aria-label={`${shipment.fields.trip_id ? 'Изменить состав клиентов' : 'Редактировать отгрузку'} ${shipment.id}`} title={shipment.fields.trip_id ? 'Редактировать машину и всех клиентов' : 'Редактировать'} onClick={() => setEditor({shipment})}><Pencil size={17}/></button>{canDelete && <button className="icon-button shipment-delete-button" aria-label={`Удалить отгрузку ${shipment.id}`} title={shipment.fields.trip_id ? 'Удалить отгрузку всей машины' : 'Удалить'} onClick={() => setDeleting(shipment)}><Trash2 size={17}/></button>}</td>}
            </tr>)}
            {end < items.length && <tr className="shipment-spacer" aria-hidden="true"><td colSpan={columns.length + extraColumns} style={{height:(items.length - end) * ROW_HEIGHT}}/></tr>}
          </tbody>
        </table>
        {!items.length && <div className="shipment-table-state">{loading ? <><LoaderCircle className="spin" size={25}/><strong>Загружаем отгрузки…</strong></> : error ? <><strong>Не удалось загрузить операции</strong><p role="alert">{error}</p><button className="button" onClick={() => void loadPage(0,true,generation.current)}>Повторить загрузку</button></> : <><Truck size={30}/><strong>Операций пока нет</strong><p>Измените фильтры или добавьте отгрузку.</p><button className="button" onClick={() => {setQuery('');setManager('all');setSettlement('all');setFilters({});onPeriodChange('all')}}>Показать все группы</button></>}</div>}
      </div>
      <div className="shipment-load-footer"><span data-testid="shipments-loaded-count" data-loaded={items.length} data-total={total}>Загружено {number(items.length)} из {number(total)}</span>{summary&&<span className="shipment-footer-totals">{number(summary.liters.total,2)} л · {number(summary.revenue.total,2)} ₽</span>}{loading && items.length > 0 ? <span role="status"><LoaderCircle size={17} className="spin"/>Загружаем следующие 50…</span> : error && items.length > 0 ? <><span className="shipment-error-text" role="alert">{error}</span><button className="button" onClick={loadMore}>Повторить</button></> : hasMore ? <button className="button" onClick={loadMore}>Загрузить ещё 50 <ChevronDown size={16}/></button> : items.length > 0 ? <span><Check size={16}/>Все операции загружены</span> : null}</div>
    </section>
    {filterColumn&&<ShipmentColumnFilter column={filterColumn} params={params} filter={filters[filterColumn.key]} onClose={()=>setFilterColumn(null)} onApply={filter=>{setFilters(previous=>{const next={...previous};if(filter)next[filterColumn.key]=filter;else delete next[filterColumn.key];return next});setFilterColumn(null)}}/>}
    {editor&&data.directories&&<ShipmentEditor shipmentType={shipmentType} shipment={editor.shipment} companies={data.companies} directories={data.directories} defaultPaymentForm={settlement==='cash'?'нал':settlement==='f2'?'ф2':'б/нал'} onClose={()=>setEditor(null)} onSaved={()=>{setEditor(null);setNotice('Отгрузка сохранена');refresh()}}/>}
    {deleting && <DeleteShipmentDialog shipment={deleting} companies={data.companies} onClose={() => setDeleting(null)} onDeleted={() => {setDeleting(null);setNotice('Отгрузка удалена');refresh()}}/>}
    {notice && <div className="toast" role="status"><Check size={18}/>{notice}</div>}
  </div>
}

function DeleteShipmentDialog({shipment,companies,onClose,onDeleted}:{shipment:Shipment;companies:Company[];onClose:()=>void;onDeleted:()=>void}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [saving,setSaving] = useState(false), [error,setError] = useState('')
  const [trip,setTrip] = useState<ShipmentTrip|null>(null), [loading,setLoading] = useState(!!shipment.fields.trip_id), [reload,setReload] = useState(0)
  useEffect(() => {const element = dialog.current;const previous = document.activeElement as HTMLElement|null;element?.showModal();return () => {element?.close();previous?.focus()}},[])
  useEffect(() => {
    if (!shipment.fields.trip_id) return
    const controller = new AbortController()
    const load = async () => {
      setLoading(true);setError('')
      try {
        const response = await fetch(`/api/shipment-trips/${encodeURIComponent(shipment.fields.trip_id!)}`,{signal:controller.signal})
        if (!response.ok) throw await apiError(response)
        const result = await response.json()
        if (!controller.signal.aborted) setTrip(result.trip)
      } catch (reason) {if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Не удалось загрузить клиентов отгрузки')}
      finally {if (!controller.signal.aborted) setLoading(false)}
    }
    void load()
    return () => controller.abort()
  },[shipment.fields.trip_id,reload])
  const remove = async () => {
    if (saving || loading || (shipment.fields.trip_id && !trip)) return
    setSaving(true);setError('')
    try {
      const response = await fetch(trip ? `/api/shipment-trips/${encodeURIComponent(trip.id)}` : `/api/shipments/${encodeURIComponent(shipment.id)}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(trip ? {versions:Object.fromEntries(trip.customers.map(customer=>[customer.id,customer.version]))} : {version:shipment.version ?? 0})})
      if(!response.ok) throw await apiError(response)
      onDeleted()
    } catch(e) {setError(e instanceof Error ? e.message : 'Не удалось удалить операцию')}
    finally {setSaving(false)}
  }
  return <dialog ref={dialog} className="shipment-delete-dialog" aria-labelledby="shipment-delete-title" onCancel={e => {e.preventDefault();if(!saving) onClose()}}><h2 id="shipment-delete-title">{shipment.fields.trip_id ? 'Удалить отгрузку всей машины?' : 'Удалить эту отгрузку?'}</h2>{shipment.fields.trip_id ? <>{loading ? <p role="status">Загружаем состав отгрузки…</p> : trip && <><p>{formatDate(trip.fields.date)} · {number(trip.fields.quantity_tonnes,6)} т · клиентов: {trip.customers.length}</p><div className="shipment-delete-details">{trip.customers.map(customer=><span key={customer.id}>{companies.find(company=>company.id===customer.fields.customer_id)?.name ?? 'Клиент'} · {number(customer.fields.quantity_litres,2)} л</span>)}</div><p>Все перечисленные клиенты этой машины будут удалены из отгрузок и исключены из итогов.</p></>}</> : <><p>{formatDate(shipment.date)} · {shipment.customer || 'Контрагент не указан'}</p><div className="shipment-delete-details"><span>{shipment.product || 'Топливо не указано'}</span><strong>{number(shipment.liters,2)} л · {number(shipment.revenue,2)} ₽</strong></div><p>Операция будет удалена из CRM и исключена из итогов.</p></>}{error && <div className="shipment-error" role="alert">{error}{shipment.fields.trip_id && <button className="button" disabled={loading||saving} onClick={()=>setReload(value=>value+1)}>Обновить состав</button>}</div>}<footer><button className="button" onClick={onClose} disabled={saving} autoFocus>Отмена</button><button className="button danger" onClick={remove} disabled={saving||loading||!!shipment.fields.trip_id&&!trip}>{saving ? <LoaderCircle size={17} className="spin"/> : <Trash2 size={17}/>} {saving ? 'Удаляем…' : shipment.fields.trip_id ? 'Удалить всю отгрузку' : 'Удалить операцию'}</button></footer></dialog>
}

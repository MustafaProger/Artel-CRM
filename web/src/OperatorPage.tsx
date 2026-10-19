import { useEffect, useRef, useState, type FormEvent } from 'react'
import Decimal from 'decimal.js'
import { Copy, Plus, RefreshCw, X } from 'lucide-react'
import ScrollableSegments from './ScrollableSegments'
import { useDialogMotion } from './useDialogMotion'
import { apiFetch } from './workspace-api'
import type { OperatorRecipient, OperatorRecipientFields, OperatorRefuelling, OperatorWorkspace } from './operator-model'
import './operator.css'

type Tab = 'analytics' | 'refuellings' | 'recipients'
type Editor = { kind: 'recipient'; row?: OperatorRecipient } | { kind: 'fuel'; row?: OperatorRefuelling } | { kind: 'payment'; row: OperatorRefuelling } | { kind: 'archive'; row: OperatorRecipient }
const ExactDecimal = Decimal.clone({precision:60})
const tabs: { id: Tab; label: string }[] = [{id:'analytics',label:'Аналитика'},{id:'refuellings',label:'Заправки'},{id:'recipients',label:'Реквизиты'}]
const display = (value: string) => { const [whole,fraction] = new Decimal(value).toFixed().split('.'); return whole.replace(/\B(?=(\d{3})+(?!\d))/g,'\u00a0') + (fraction ? ','+fraction : '') }
const recipientText = (r: OperatorRecipientFields) => [r.name,r.bank,r.card && `Карта: ${r.card}`,r.phone && `Телефон: ${r.phone}`,r.details].filter(Boolean).join('\n')
const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date())
async function readWorkspace(): Promise<OperatorWorkspace> {
  const response = await apiFetch('/api/operator',{cache:'no-store',signal:AbortSignal.timeout(15000)})
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Не удалось загрузить операторскую.')
  return body
}
export default function OperatorPage() {
  const [data,setData] = useState<OperatorWorkspace | null>(null), [tab,setTab] = useState<Tab>('refuellings')
  const [error,setError] = useState(''), [busy,setBusy] = useState(false), [message,setMessage] = useState('')
  const [editor,setEditor] = useState<Editor | null>(null), [query,setQuery] = useState(''), [from,setFrom] = useState(''), [to,setTo] = useState(''), [paid,setPaid] = useState('all')
  const request = useRef(0)
  const reload = async () => {
    const serial = ++request.current
    setBusy(true);setError('')
    try { const next = await readWorkspace(); if (serial === request.current) setData(next) }
    catch (e) { if (serial === request.current) {setError((e as Error).message);setData(null)} }
    finally { if (serial === request.current) setBusy(false) }
  }
  useEffect(() => { void reload(); return () => {request.current++} }, [])
  useEffect(() => { if (!message) return; const timer=setTimeout(()=>setMessage(''),3500);return()=>clearTimeout(timer) },[message])
  const copy = async (value: string) => {try {await navigator.clipboard.writeText(value);setMessage('Реквизиты скопированы')}catch{setError('Не удалось скопировать. Выделите реквизиты и скопируйте вручную.')}}
  const q=query.trim().toLocaleLowerCase('ru')
  const rows = (data?.refuellings ?? []).filter(r => (!from || r.date >= from) && (!to || r.date <= to) && (paid === 'all' || r.paid === (paid === 'paid')) && `${r.name} ${r.service} ${r.recipient.name} ${r.comment}`.toLocaleLowerCase('ru').includes(q))
  const sum = (items: OperatorRefuelling[], key: 'amount' | 'litres') => display(items.reduce((total,r)=>total.plus(r[key]),new ExactDecimal(0)).toFixed())
  return <section className="operator-workspace" aria-label="Операторская">
    <ScrollableSegments className="segmented" label="Разделы операторской" value={tab} role="tablist">{tabs.map(t=><button key={t.id} id={`operator-tab-${t.id}`} role="tab" aria-selected={tab===t.id} aria-controls={`operator-panel-${t.id}`} className={tab===t.id?'active':''} onClick={()=>setTab(t.id)}>{t.label}</button>)}</ScrollableSegments>
    <div className="operator-toolbar"><button className="button" disabled={busy} onClick={()=>void reload()}><RefreshCw size={16}/>Обновить</button>{tab!=='analytics'&&<button className="button primary" disabled={!data} onClick={()=>setEditor({kind:tab==='recipients'?'recipient':'fuel'})}><Plus size={17}/>{tab==='recipients'?'Добавить реквизиты':'Новая заправка'}</button>}</div>
    {error&&<p className="soft-notice" role="alert">{error}</p>}{message&&<p className="operator-feedback" role="status">{message}</p>}
    {!data ? <p role="status">{busy?'Загружаем операторскую…':'Данные не загружены.'}</p> : <div id={`operator-panel-${tab}`} role="tabpanel" aria-labelledby={`operator-tab-${tab}`}>
      {tab!=='recipients'&&<div className="operator-filters"><label>Поиск<input aria-label="Поиск заправок" value={query} onChange={e=>setQuery(e.target.value)} placeholder="Имя, сервис, получатель"/></label><label>С даты<input type="date" value={from} onChange={e=>setFrom(e.target.value)}/></label><label>По дату<input type="date" value={to} onChange={e=>setTo(e.target.value)}/></label><label>Оплата<select value={paid} onChange={e=>setPaid(e.target.value)}><option value="all">Все</option><option value="paid">Оплачено</option><option value="unpaid">Не оплачено</option></select></label></div>}
      {from&&to&&from>to&&tab!=='recipients'&&<p role="alert">Начало периода позже окончания.</p>}
      {tab==='analytics'&&<><div className="operator-stats">{[['Записей',String(rows.length)],['Литры по записям',sum(rows,'litres')],['Оплачено, ₽',sum(rows.filter(r=>r.paid),'amount')],['Не оплачено, ₽',sum(rows.filter(r=>!r.paid),'amount')]].map(([title,value])=><article className="panel" key={title}><span>{title}</span><strong>{value}</strong></article>)}</div><p className="muted">Итоги по введённым суммам и ручным отметкам оплаты за выбранный период. Дата в журнале не подтверждает факт заправки. Сверка с личными кабинетами пока не настроена.</p></>}
      {tab==='refuellings'&&(rows.length?<div className="operator-table-wrap"><table className="operator-table"><caption className="sr-only">Журнал заправок</caption><thead><tr>{['Дата','Имя водителя','Сервис','Скидка, %','Литры','Цена, ₽/л','Сумма, ₽','Оплата','Получатель','Действия'].map(v=><th key={v}>{v}</th>)}</tr></thead><tbody>{rows.map(r=><tr key={r.id}><td>{r.date.split('-').reverse().join('.')}</td><td><button className="operator-link" onClick={()=>setEditor({kind:'fuel',row:r})}>{r.name}</button></td><td>{r.service}</td><td>{display(r.discountPercent)}</td><td>{display(r.litres)}</td><td>{display(r.pricePerLitre)}</td><td>{display(r.amount)}</td><td><span className={`operator-status ${r.paid?'is-paid':''}`}>{r.paid?'Оплачено':'Не оплачено'}</span></td><td>{r.recipient.name}<button className="icon-button" aria-label={`Копировать реквизиты для ${r.name}`} title="Копировать реквизиты" onClick={()=>void copy(recipientText(r.recipient))}><Copy size={15}/></button></td><td><button className="button" onClick={()=>setEditor({kind:'payment',row:r})}>{r.paid?'Снять подтверждение':'Подтвердить оплату'}</button></td></tr>)}</tbody></table></div>:<div className="empty-state"><strong>Заправок пока нет</strong><span>Создайте запись, когда водитель обратится за заправкой. Оплату можно подтвердить позже.</span></div>)}
      {tab==='recipients'&&(data.recipients.length?<div className="operator-recipients">{data.recipients.map(r=><article key={r.id} className="panel"><header><h2>{r.name}</h2>{r.archived&&<span className="operator-status">В архиве</span>}</header><pre>{recipientText(r)}</pre><div className="operator-actions"><button className="button" onClick={()=>void copy(recipientText(r))}><Copy size={16}/>Копировать</button><button className="button" onClick={()=>setEditor({kind:'recipient',row:r})}>Изменить</button><button className="button" onClick={()=>setEditor({kind:'archive',row:r})}>{r.archived?'Вернуть':'В архив'}</button></div></article>)}</div>:<div className="empty-state"><strong>Добавьте получателя денег</strong><span>Сохраните имя, банк и реквизиты для выбора в заправке.</span></div>)}
    </div>}
    {editor&&data&&<OperatorEditor editor={editor} recipients={data.recipients} onClose={()=>setEditor(null)} onSaved={next=>{request.current++;setData(next);setEditor(null);setMessage('Сохранено')}}/>}
  </section>
}
function OperatorEditor({editor,recipients,onClose,onSaved}:{editor:Editor;recipients:OperatorRecipient[];onClose:()=>void;onSaved:(data:OperatorWorkspace)=>void}) {
  const row=editor.row, fuel=editor.kind==='fuel'?editor.row:undefined
  const initial:Record<string,string> = editor.kind==='recipient' ? Object.fromEntries(['name','bank','card','phone','details'].map(k=>[k,String(row?.[k as keyof typeof row]??'')])) : {date:fuel?.date??today(),name:fuel?.name??'',service:fuel?.service??'',discountPercent:fuel?.discountPercent??'0',litres:fuel?.litres??'',pricePerLitre:fuel?.pricePerLitre??'',amount:fuel?.amount??'',comment:fuel?.comment??'',recipientId:fuel?.recipientId??''}
  const [values,setValues]=useState(initial), [saving,setSaving]=useState(false), [error,setError]=useState(''), [uncertain,setUncertain]=useState(false), [discard,setDiscard]=useState(false)
  const original=useRef(initial), pending=useRef<string | null>(null), lock=useRef(false), dialog=useRef<HTMLDialogElement>(null)
  const {close,complete}=useDialogMotion(dialog,onClose)
  const payment=editor.kind==='payment',archive=editor.kind==='archive',readonly=editor.kind==='fuel'&&!!fuel?.paid
  const dirty=JSON.stringify(values)!==JSON.stringify(original.current)
  const title=payment?(editor.row.paid?'Снять подтверждение оплаты':'Подтвердить оплату'):archive?(editor.row.archived?'Вернуть реквизиты':'Архивировать реквизиты'):editor.kind==='recipient'?(row?'Реквизиты получателя':'Новые реквизиты'):(row?'Заправка':'Новая заправка')
  const dismiss=()=>{if(lock.current)return;if(uncertain){setError('Результат пока неизвестен. Нажмите «Проверить сохранение» для повтора того же запроса.');return}if(dirty)setDiscard(true);else close()}
  useEffect(()=>{if(!dirty&&!uncertain)return;const handler=(e:BeforeUnloadEvent)=>{e.preventDefault();e.returnValue=''};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler)},[dirty,uncertain])
  const field=(key:string,label:string,type='text',required=true)=><label key={key}>{label}<input aria-label={label} type={type} required={required} value={values[key]} maxLength={key==='comment'||key==='details'?2000:500} inputMode={['litres','pricePerLitre','amount','discountPercent'].includes(key)?'decimal':undefined} onChange={e=>setValues({...values,[key]:e.target.value})}/></label>
  const submit=async(e:FormEvent)=>{
    e.preventDefault();if(lock.current||readonly)return
    const collection=editor.kind==='recipient'||archive?'recipients':'refuellings'
    const path=`/api/operator/${collection}${row?`/${row.id}`:''}${payment?'/payment':archive?'/archive':''}`
    let body=pending.current
    if(!body){
      let payload:Record<string,unknown>={...values}
      if(editor.kind==='payment')payload={paid:!editor.row.paid}
      else if(editor.kind==='archive')payload={archived:!editor.row.archived}
      else if(editor.kind==='fuel')payload.recipientVersion=recipients.find(r=>r.id===values.recipientId)?.version
      body=JSON.stringify({...payload,...(row?{version:row.version}:{}),idempotencyKey:crypto.randomUUID()})
      pending.current=body
    }
    lock.current=true;setSaving(true);setError('')
    try {
      const response=await apiFetch(path,{method:row?'PATCH':'POST',headers:{'Content-Type':'application/json'},body,signal:AbortSignal.timeout(20000)})
      const result=await response.json()
      if(!response.ok){
        if(response.status<500){pending.current=null;setUncertain(false)}else setUncertain(true)
        setError(result.error||'Сохранение не подтверждено.');return
      }
      // Keep the same operation pending until a separate persisted read succeeds.
      setUncertain(true)
      const next=await readWorkspace()
      if(!next[collection].some(r=>r.id===result.id))throw new Error('Сохранённая запись пока не найдена. Повторите проверку.')
      pending.current=null;setUncertain(false);await complete(()=>onSaved(next))
    }catch{setUncertain(true);setError('Ответ не получен или повторное чтение не удалось. Проверьте сохранение тем же запросом.')}finally{lock.current=false;setSaving(false)}
  }
  return <dialog ref={dialog} className="operator-dialog" aria-labelledby="operator-editor-title" onCancel={dismiss}>
    <form onSubmit={e=>void submit(e)}><header><h2 id="operator-editor-title">{title}</h2><button type="button" className="icon-button" aria-label="Закрыть форму" disabled={saving} onClick={dismiss}><X size={20}/></button></header>
    {error&&<p role="alert" className="soft-notice">{error}</p>}
    {discard?<div><p>Закрыть форму без сохранения?</p><div className="operator-actions"><button type="button" className="button" onClick={()=>setDiscard(false)}>Продолжить ввод</button><button type="button" className="button" onClick={close}>Не сохранять</button></div></div>:<>
    {editor.kind==='payment'?<><p><strong>{editor.row.name}</strong> · {display(editor.row.amount)} ₽</p><p>{editor.row.paid?'Отметка будет снята. Предыдущее подтверждение останется в истории.':'Подтвердите, что деньги получены. Это ручная отметка оператора.'}</p><pre>{recipientText(editor.row.recipient)}</pre></>:editor.kind==='archive'?<p>{editor.row.archived?'Реквизиты снова появятся в списке выбора.':'Реквизиты исчезнут из выбора новых заправок. Сохранённые записи останутся без изменений.'}</p>:<fieldset disabled={saving||uncertain||readonly} className="operator-form-grid">
      {editor.kind==='recipient'?<>{field('name','Наименование получателя')}{field('bank','Банк получателя')}{field('card','Номер карты','text',false)}{field('phone','Телефон','tel',false)}{field('details','Другие реквизиты','text',false)}</>:<>
      {field('date','Дата заправки','date')}{field('name','Имя водителя')}
      <label>Сервис<input aria-label="Сервис" list="operator-services" required value={values.service} onChange={e=>setValues({...values,service:e.target.value})}/><datalist id="operator-services">{['Газпромнефть','Лукойл','Роснефть'].map(v=><option key={v} value={v}/>)}</datalist></label>
      {field('discountPercent','Скидка, %')}{field('litres','Литры')}{field('pricePerLitre','Цена за литр, ₽')}{field('amount','Сумма к оплате, ₽')}
      <label>Получатель<select aria-label="Получатель" required value={values.recipientId} onChange={e=>setValues({...values,recipientId:e.target.value})}><option value="">Выберите реквизиты</option>{recipients.filter(r=>!r.archived||r.id===values.recipientId).map(r=><option key={r.id} value={r.id} disabled={r.archived}>{r.name} · {r.bank}{r.archived?' (в архиве)':''}</option>)}</select></label>{field('comment','Комментарий','text',false)}
      <p className="operator-full muted">Сумму вводит оператор. Скидка записывается отдельно и автоматически сумму не изменяет.</p>
      {!recipients.some(r=>!r.archived)&&<p className="operator-full">Сначала добавьте получателя на вкладке «Реквизиты».</p>}
      </>}
    </fieldset>}
    {fuel&&<><h3>Реквизиты в записи</h3><pre>{recipientText(fuel.recipient)}</pre>{readonly&&<p>Для исправления снимите подтверждение оплаты в журнале.</p>}{fuel.paymentHistory.length>0&&<><h3>История оплаты</h3><ul>{fuel.paymentHistory.map((event,i)=><li key={i}>{event.paid?'Подтверждена':'Подтверждение снято'} · {event.actorName} · {new Date(event.at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК</li>)}</ul></>}</>}
    <footer><button type="button" className="button" disabled={saving||uncertain} onClick={dismiss}>Закрыть</button>{!readonly&&<button type="submit" className="button primary" disabled={saving||(!payment&&!archive&&!!row&&!dirty&&!uncertain)}>{saving?'Сохраняем…':uncertain?'Проверить сохранение':payment||archive?'Подтвердить':'Сохранить'}</button>}</footer>
    </>}
    </form>
  </dialog>
}

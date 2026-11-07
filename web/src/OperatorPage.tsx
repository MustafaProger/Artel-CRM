import { useEffect, useRef, useState, type FormEvent } from 'react'
import Decimal from 'decimal.js'
import { Copy, Plus, RefreshCw, X } from 'lucide-react'
import { useDialogMotion } from './useDialogMotion'
import { apiFetch } from './workspace-api'
import { calculateOperatorAmount } from './operator-calculation'
import type { OperatorRefuelling, OperatorWorkspace } from './operator-model'
import './operator.css'

type Editor = { kind: 'fuel'; row?: OperatorRefuelling } | { kind: 'payment'; row: OperatorRefuelling }
const display = (value: string, money = false) => {
  const [whole, fraction] = new Decimal(value).toFixed(money ? 2 : undefined).split('.')
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + (fraction ? ',' + fraction : '')
}
const recipientText = (row: OperatorRefuelling) => row.schemaVersion === 2 ? row.recipientText : [row.recipient.name, row.recipient.bank, row.recipient.card && `Карта: ${row.recipient.card}`, row.recipient.phone && `Телефон: ${row.recipient.phone}`, row.recipient.details].filter(Boolean).join('\n')
const groupName = (row: OperatorRefuelling) => row.schemaVersion === 2 ? row.groupName : ''
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
async function readWorkspace(): Promise<OperatorWorkspace> {
  const response = await apiFetch('/api/operator', { cache: 'no-store', signal: AbortSignal.timeout(15000) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Не удалось загрузить операторскую.')
  return body
}

export default function OperatorPage() {
  const [data, setData] = useState<OperatorWorkspace | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null)
  const [query, setQuery] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState(''), [paid, setPaid] = useState('all')
  const request = useRef(0)
  const reload = async () => {
    const serial = ++request.current
    setBusy(true); setError('')
    try { const next = await readWorkspace(); if (serial === request.current) setData(next) }
    catch (e) { if (serial === request.current) { setError((e as Error).message); setData(null) } }
    finally { if (serial === request.current) setBusy(false) }
  }
  useEffect(() => { void reload(); return () => { request.current++ } }, [])
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 3500); return () => clearTimeout(timer) }, [message])
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setMessage('Реквизиты скопированы') }
    catch { setError('Не удалось скопировать. Выделите реквизиты и скопируйте вручную.') }
  }
  const q = query.trim().toLocaleLowerCase('ru')
  const rows = (data?.refuellings ?? []).filter(row => (!from || row.date >= from) && (!to || row.date <= to) && (paid === 'all' || row.paid === (paid === 'paid')) && `${row.name} ${row.service} ${groupName(row)} ${recipientText(row)} ${row.comment}`.toLocaleLowerCase('ru').includes(q))
  return <section className="operator-workspace" aria-label="Операторская">
    <div className="operator-toolbar">
      <button className="button" disabled={busy} onClick={() => void reload()}><RefreshCw size={16} />Обновить</button>
      <button className="button primary" disabled={!data} onClick={() => setEditor({ kind: 'fuel' })}><Plus size={17} />Новая заправка</button>
    </div>
    {error && <p className="soft-notice" role="alert">{error}</p>}
    {message && <p className="operator-feedback" role="status">{message}</p>}
    {!data ? <p role="status">{busy ? 'Загружаем операторскую…' : 'Данные не загружены.'}</p> : <div>
      <div className="operator-filters">
        <label>Поиск<input aria-label="Поиск заправок" value={query} onChange={e => setQuery(e.target.value)} placeholder="Имя, группа, сервис, реквизиты" /></label>
        <label>С даты<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
        <label>По дату<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
        <label>Оплата<select value={paid} onChange={e => setPaid(e.target.value)}><option value="all">Все</option><option value="paid">Оплачено</option><option value="unpaid">Не оплачено</option></select></label>
      </div>
      {from && to && from > to && <p role="alert">Начало периода позже окончания.</p>}
      {rows.length ? <div className="operator-table-wrap"><table className="operator-table">
        <caption className="sr-only">Журнал заправок</caption>
        <thead><tr>{['Дата', 'Имя водителя', 'Группа', 'Сервис', 'Скидка, %', 'Литры', 'Цена, ₽/л', 'Сумма, ₽', 'Оплата', 'Имя получателя и реквизиты', 'Действия'].map(value => <th key={value}>{value}</th>)}</tr></thead>
        <tbody>{rows.map(row => <tr key={row.id}>
          <td>{row.date.split('-').reverse().join('.')}</td>
          <td><button className="operator-link" onClick={() => setEditor({ kind: 'fuel', row })}>{row.name}</button></td>
          <td>{groupName(row) || '—'}</td><td>{row.service}</td><td>{display(row.discountPercent)}</td><td>{display(row.litres)}</td><td>{display(row.pricePerLitre, row.schemaVersion === 2 && !row.legacyPrecision?.pricePerLitre)}</td><td>{display(row.amount, true)}</td>
          <td><span className={`operator-status ${row.paid ? 'is-paid' : ''}`}>{row.paid ? 'Оплачено' : 'Не оплачено'}</span></td>
          <td className="operator-recipient-cell"><span>{recipientText(row)}</span><button className="icon-button" aria-label={`Копировать реквизиты для ${row.name}`} title="Копировать реквизиты" onClick={() => void copy(recipientText(row))}><Copy size={15} /></button></td>
          <td><button className="button" onClick={() => setEditor({ kind: 'payment', row })}>{row.paid ? 'Снять подтверждение' : 'Подтвердить оплату'}</button></td>
        </tr>)}</tbody>
      </table></div> : <div className="empty-state"><strong>{data.refuellings.length ? 'Заправки не найдены' : 'Заправок пока нет'}</strong><span>{data.refuellings.length ? 'Измените поиск или фильтры.' : 'Создайте запись, когда водитель обратится за заправкой. Оплату можно подтвердить позже.'}</span></div>}
    </div>}
    {editor && data && <OperatorEditor editor={editor} workspace={data} onClose={() => setEditor(null)} onSaved={next => { request.current++; setData(next); setEditor(null); setMessage('Сохранено') }} />}
  </section>
}

function OperatorEditor({ editor, workspace, onClose, onSaved }: { editor: Editor; workspace: OperatorWorkspace; onClose: () => void; onSaved: (data: OperatorWorkspace) => void }) {
  const row = editor.row, fuel = editor.kind === 'fuel' ? editor.row : undefined
  const existingServiceId = fuel?.schemaVersion === 2 ? fuel.serviceId : workspace.services.find(service => service.name === fuel?.service)?.id ?? ''
  const initial: Record<string, string> = {
    date: fuel?.date ?? today(), name: fuel?.name ?? '', groupId: fuel?.schemaVersion === 2 ? fuel.groupId : '',
    serviceId: existingServiceId, serviceVersion: String(fuel?.schemaVersion === 2 ? fuel.serviceVersion : workspace.services.find(service => service.id === existingServiceId)?.version ?? 0),
    discountPercent: fuel?.discountPercent ?? '', litres: fuel?.litres ?? '', pricePerLitre: fuel?.pricePerLitre ?? '',
    amount: fuel?.amount ?? '', amountMode: fuel?.schemaVersion === 2 ? fuel.amountMode : fuel ? 'manual' : 'auto',
    comment: fuel?.comment ?? '', recipientText: fuel ? recipientText(fuel) : '',
  }
  const [values, setValues] = useState(initial), [catalog, setCatalog] = useState(workspace)
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [discard, setDiscard] = useState(false), [stale, setStale] = useState(false)
  const original = useRef(initial), pending = useRef<string | null>(null), lock = useRef(false), dialog = useRef<HTMLDialogElement>(null)
  const { close, complete } = useDialogMotion(dialog, onClose)
  const payment = editor.kind === 'payment', readonly = editor.kind === 'fuel' && !!fuel?.paid
  const historicalPrecision = !!fuel && (fuel.schemaVersion !== 2 || !!fuel.legacyPrecision)
  const dirty = JSON.stringify(values) !== JSON.stringify(original.current)
  const title = payment ? (editor.row.paid ? 'Снять подтверждение оплаты' : 'Подтвердить оплату') : row ? 'Заправка' : 'Новая заправка'
  const dismiss = () => {
    if (lock.current) return
    if (uncertain) { setError('Результат пока неизвестен. Нажмите «Проверить сохранение» для повтора того же запроса.'); return }
    if (dirty) setDiscard(true); else close()
  }
  useEffect(() => {
    if (!dirty && !uncertain) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, uncertain])
  const update = (key: string, value: string) => setValues(previous => {
    const next = { ...previous, [key]: value }
    if (key === 'amount') next.amountMode = 'manual'
    if (key === 'serviceId') {
      const service = catalog.services.find(item => item.id === value)
      const historical = !!fuel && value === existingServiceId
      next.discountPercent = historical ? fuel.discountPercent : service?.discountPercent ?? ''
      next.serviceVersion = String(historical && fuel.schemaVersion === 2 ? fuel.serviceVersion : service?.version ?? 0)
    }
    if (['litres', 'pricePerLitre', 'serviceId'].includes(key)) {
      next.amountMode = 'auto'
      next.amount = calculateOperatorAmount(next.litres, next.pricePerLitre, next.discountPercent, historicalPrecision) ?? ''
    }
    return next
  })
  const refreshCatalog = async () => {
    if (lock.current) return
    lock.current = true; setSaving(true)
    try {
      const next = await readWorkspace(); setCatalog(next)
      const service = next.services.find(item => item.id === values.serviceId)
      if (service && fuel && fuel.schemaVersion !== 2 && values.serviceId === existingServiceId) {
        // Legacy records have no saved service version, but keep their historical rate.
        setValues(previous => ({ ...previous, serviceVersion: String(service.version ?? 0) }))
      } else if (service && (!fuel || values.serviceId !== existingServiceId)) {
        setValues(previous => ({ ...previous, serviceVersion: String(service.version ?? 0), discountPercent: service.discountPercent,
          ...(service.discountPercent !== previous.discountPercent ? { amountMode: 'auto', amount: calculateOperatorAmount(previous.litres, previous.pricePerLitre, service.discountPercent, historicalPrecision) ?? '' } : {}),
        }))
      }
      setStale(false); setError('Справочники обновлены. Проверьте данные и сумму перед сохранением.')
    } catch { setError('Не удалось обновить справочники. Ваш ввод сохранён.') }
    finally { lock.current = false; setSaving(false) }
  }
  const field = (key: string, label: string, type = 'text', required = true) => <label key={key}>{label}<input aria-label={label} type={type} required={required} value={values[key]} maxLength={key === 'comment' ? 4000 : 500} inputMode={['litres', 'pricePerLitre', 'amount'].includes(key) ? 'decimal' : undefined} onChange={event => update(key, event.target.value)} /></label>
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current || readonly) return
    const path = `/api/operator/refuellings${row ? `/${row.id}` : ''}${payment ? '/payment' : ''}`
    let body = pending.current
    if (!body) {
      const payload = editor.kind === 'payment' ? { paid: !editor.row.paid } : { ...values, schemaVersion: 2, serviceVersion: Number(values.serviceVersion) }
      body = JSON.stringify({ ...payload, ...(row ? { version: row.version } : {}), idempotencyKey: crypto.randomUUID() })
      pending.current = body
    }
    lock.current = true; setSaving(true); setError(''); setStale(false)
    try {
      const response = await apiFetch(path, { method: row ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20000) })
      const result = await response.json()
      if (!response.ok) {
        if (response.status < 500) { pending.current = null; setUncertain(false) } else setUncertain(true)
        setStale(!payment && response.status === 409 && /сервис|скидк|справочник|групп/i.test(result.error ?? ''))
        setError(result.error || 'Сохранение не подтверждено.'); return
      }
      // Retain exactly the same request until persisted read-back succeeds.
      setUncertain(true)
      const next = await readWorkspace()
      if (!next.refuellings.some(item => item.id === result.id)) throw new Error('Сохранённая запись пока не найдена.')
      pending.current = null; setUncertain(false); await complete(() => onSaved(next))
    } catch { setUncertain(true); setError('Ответ не получен или повторное чтение не удалось. Проверьте сохранение тем же запросом.') }
    finally { lock.current = false; setSaving(false) }
  }
  return <dialog ref={dialog} className="operator-dialog" aria-labelledby="operator-editor-title" onCancel={event => { event.preventDefault(); dismiss() }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2 id="operator-editor-title">{title}</h2><button type="button" className="icon-button" aria-label="Закрыть форму" disabled={saving} onClick={dismiss}><X size={20} /></button></header>
      {error && <p role="alert" className="soft-notice">{error}</p>}
      {stale && <button type="button" className="button" disabled={saving || uncertain} onClick={() => void refreshCatalog()}>Обновить справочники</button>}
      {discard ? <div><p>Закрыть форму без сохранения?</p><div className="operator-actions"><button type="button" className="button" onClick={() => setDiscard(false)}>Продолжить ввод</button><button type="button" className="button" onClick={close}>Не сохранять</button></div></div> : <>
        {editor.kind === 'payment' ? <><p><strong>{editor.row.name}</strong> · {display(editor.row.amount, true)} ₽</p><p>{editor.row.paid ? 'Отметка будет снята. Предыдущее подтверждение останется в истории.' : 'Подтвердите, что деньги получены. Это ручная отметка оператора.'}</p><pre>{recipientText(editor.row)}</pre></> : <fieldset disabled={saving || uncertain || readonly} className="operator-form-grid">
          {field('date', 'Дата заправки', 'date')}{field('name', 'Имя водителя')}
          <label>Группа<select aria-label="Группа" required value={values.groupId} onChange={event => update('groupId', event.target.value)}><option value="">Выберите группу</option>
            {fuel?.schemaVersion === 2 && !catalog.groups.some(item => item.id === fuel.groupId) && <option value={fuel.groupId}>{fuel.groupName}</option>}
            {catalog.groups.map(item => <option key={item.id} value={item.id}>{item.id === (fuel?.schemaVersion === 2 ? fuel.groupId : '') ? groupName(fuel!) : item.name}</option>)}
          </select></label>
          <label>Сервис<select aria-label="Сервис" required value={values.serviceId} onChange={event => update('serviceId', event.target.value)}><option value="">Выберите сервис</option>
            {fuel?.schemaVersion === 2 && !catalog.services.some(item => item.id === fuel.serviceId) && <option value={fuel.serviceId}>{fuel.service}</option>}
            {catalog.services.map(item => <option key={item.id} value={item.id}>{item.id === existingServiceId && fuel ? fuel.service : item.name}</option>)}
          </select></label>
          <label>Скидка, %<input aria-label="Скидка, %" value={values.discountPercent.replace('.', ',')} readOnly /></label>
          {field('litres', 'Литры')}{field('pricePerLitre', 'Цена за литр, ₽')}{field('amount', 'Сумма к оплате, ₽')}
          <p className="operator-full muted" role="status">{values.amountMode === 'manual' ? 'Сумма изменена вручную. При изменении литров, цены или сервиса она рассчитается заново.' : 'Сумма рассчитывается с учётом скидки сервиса. При необходимости её можно изменить вручную.'}</p>
          <label className="operator-full">Имя получателя и реквизиты<textarea aria-label="Имя получателя и реквизиты" required rows={4} maxLength={4000} value={values.recipientText} onChange={event => update('recipientText', event.target.value)} /></label>
          {field('comment', 'Комментарий', 'text', false)}
          {!catalog.groups.length && <p className="operator-full">Для новой заправки сначала добавьте группу на странице «Справочники».</p>}
        </fieldset>}
        {fuel && <>
          {readonly && <p>Для исправления снимите подтверждение оплаты в журнале.</p>}
          {fuel.paymentHistory.length > 0 && <><h3>История оплаты</h3><ul>{fuel.paymentHistory.map((entry, index) => <li key={index}>{entry.paid ? 'Подтверждена' : 'Подтверждение снято'} · {entry.actorName} · {new Date(entry.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</li>)}</ul></>}
        </>}
        <footer><button type="button" className="button" disabled={saving || uncertain} onClick={dismiss}>Закрыть</button>{!readonly && <button type="submit" className="button primary" disabled={saving || (!payment && !!row && !dirty && !uncertain)}>{saving ? 'Сохраняем…' : uncertain ? 'Проверить сохранение' : payment ? 'Подтвердить' : 'Сохранить'}</button>}</footer>
      </>}
    </form>
  </dialog>
}

import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Copy, Eye, Pencil, Plus, RefreshCw, Trash2, X } from 'lucide-react'
import ScrollableSegments from './ScrollableSegments'
import { PlanEditor, PlanCards, planDate, AllocationEditor, allocationError, type AllocationDraft, allocationFromRow, resolveAllocationSuggestions } from './OperatorPlans'
import { useDialogMotion } from './useDialogMotion'
import { apiFetch } from './workspace-api'
import { display, readWorkspace, isDefinitiveOperatorRejection } from './operator-ui-utils'
import { calculateOperatorAmount } from './operator-calculation'
import type { OperatorPlanSummary, OperatorRefuelling, OperatorWorkspace } from './operator-model'
import './operator.css'

type Editor = { kind: 'fuel'; row?: OperatorRefuelling; planId?: string } | { kind: 'payment' | 'delete'; row: OperatorRefuelling }
const recipientText = (row: OperatorRefuelling) => row.schemaVersion !== undefined ? row.recipientText : [row.recipient.name, row.recipient.bank, row.recipient.card && `Карта: ${row.recipient.card}`, row.recipient.phone && `Телефон: ${row.recipient.phone}`, row.recipient.details].filter(Boolean).join('\n')
const groupName = (row: OperatorRefuelling) => row.schemaVersion !== undefined ? row.groupName : ''
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

export default function OperatorPage({ creatorName }: { creatorName: string }) {
  const [data, setData] = useState<OperatorWorkspace | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [editor, setEditor] = useState<Editor | null>(null), [planEditor, setPlanEditor] = useState<{ plan?: OperatorPlanSummary } | null>(null)
  const [tab, setTab] = useState('operations'), [planStatus, setPlanStatus] = useState('active'), [planId, setPlanId] = useState('')
  const [query, setQuery] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState(''), [paid, setPaid] = useState('all')
  const request = useRef(0)
  const reload = async () => {
    const serial = ++request.current
    setBusy(true); setError('')
    try { const next = await readWorkspace(); if (serial === request.current) setData(next) }
    catch (e) { if (serial === request.current) setError((e as Error).message) }
    finally { if (serial === request.current) setBusy(false) }
  }
  useEffect(() => { void reload(); return () => { request.current++ } }, [])
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 3500); return () => clearTimeout(timer) }, [message])
  const copy = async (value: string) => {
    try { await navigator.clipboard.writeText(value); setMessage('Реквизиты скопированы') }
    catch { setError('Не удалось скопировать. Выделите реквизиты и скопируйте вручную.') }
  }
  const saved = (next: OperatorWorkspace, notice = 'Сохранено') => { request.current++; setData(next); setEditor(null); setPlanEditor(null); setMessage(notice) }
  const q = query.trim().toLocaleLowerCase('ru')
  const rows = (data?.refuellings ?? []).filter(row => (!planId || row.schemaVersion === 3 && row.planId === planId) && (!from || row.date >= from) && (!to || row.date <= to) && (paid === 'all' || row.paid === (paid === 'paid')) && `${row.name} ${row.service} ${groupName(row)} ${recipientText(row)} ${row.comment} ${row.schemaVersion === 3 ? row.planClientName : ''}`.toLocaleLowerCase('ru').includes(q))
  const selectedPlan = data?.plans.find(plan => plan.id === planId)
  return <section className="operator-workspace" aria-label="Операторская">
    <div className="operator-topbar">
      <ScrollableSegments className="operator-tabs" role="tablist" label="Раздел операторской" value={tab}>
        {[['plans', 'Задания'], ['operations', 'Операции']].map(([id, label]) => <button type="button" key={id} id={`operator-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="operator-content" onClick={() => setTab(id)}>{label}</button>)}
      </ScrollableSegments>
      <div className="operator-toolbar">
        <button className="button operator-toolbar-icon" aria-label="Обновить" title="Обновить" disabled={busy} onClick={() => void reload()}><RefreshCw size={18} aria-hidden="true" /></button>
        {tab === 'plans' ? <button className="button primary operator-toolbar-icon" aria-label="Новое задание" title="Новое задание" disabled={!data} onClick={() => setPlanEditor({})}><Plus size={20} aria-hidden="true" /></button> : <button className="button primary operator-toolbar-icon" aria-label="Новая операция" title="Новая операция" disabled={!data?.plans.some(plan => plan.status === 'active')} onClick={() => setEditor({ kind: 'fuel', planId: selectedPlan?.status === 'active' ? selectedPlan.id : undefined })}><Plus size={20} aria-hidden="true" /></button>}
      </div>
    </div>
    {error && <p className="soft-notice" role="alert">{error}</p>}
    {message && <p className="operator-feedback" role="status">{message}</p>}
    {!data ? <p role="status">{busy ? 'Загружаем операторскую…' : 'Данные не загружены.'}</p> : <div id="operator-content" role="tabpanel" aria-labelledby={`operator-tab-${tab}`}>
      {tab === 'plans' && <>
      <div className="operator-plan-heading">
        <h2>Задания менеджеров</h2>
        <div className="operator-actions" role="group" aria-label="Статус заданий">
          {[['active', 'Активные'], ['completed', 'Выполненные']].map(([status, label]) => <button className={`button ${planStatus === status ? 'selected' : ''}`} aria-pressed={planStatus === status} key={status} onClick={() => setPlanStatus(status)}>{label} · {data.plans.filter(plan => plan.status === status).length}</button>)}
        </div>
      </div>
      <PlanCards plans={data.plans.filter(plan => plan.status === planStatus)} onSelect={id => { setPlanId(id); setTab('operations') }} onEdit={plan => setPlanEditor({ plan })} />
      </>}
      {tab === 'operations' && <>
        <div className="operator-journal-heading"><h2>Операции по водителям <span>{rows.length}</span></h2><label className="operator-plan-filter">Задание<select aria-label="Фильтр по заданию" value={planId} onChange={event => setPlanId(event.target.value)}><option value="">Все задания</option>{data.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.clientName} · {plan.status === 'completed' ? 'Выполнено' : 'Активно'} · {planDate(plan.createdAt)}</option>)}</select></label></div>
        {selectedPlan && <div className="operator-selection"><p><strong>{selectedPlan.clientName}</strong> · {selectedPlan.status === 'completed' ? 'Выполнено' : `Осталось ${display(selectedPlan.remaining, true)} ₽`}</p><button className="operator-link" onClick={() => setPlanId('')}>Показать все операции</button></div>}
        <div className="operator-filters">
          <label>Поиск<input aria-label="Поиск операций" value={query} onChange={e => setQuery(e.target.value)} placeholder="Водитель, клиент, получатель" /></label>
          <label>С даты<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
          <label>По дату<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
          <label>Оплата<select value={paid} onChange={e => setPaid(e.target.value)}><option value="all">Все</option><option value="paid">Оплачено</option><option value="unpaid">Не оплачено</option></select></label>
        </div>
        {from && to && from > to && <p role="alert">Начало периода позже окончания.</p>}
        {rows.length ? <div className="operator-table-wrap"><table className="operator-table">
          <caption className="operator-visually-hidden">Операции по водителям</caption>
          <thead><tr>{['Дата', 'Имя водителя', 'Клиент / задание', 'Группа', 'Сервис', 'Скидка, %', 'Литры', 'Цена, ₽/л', 'Сумма, ₽', 'Оплата', 'Получатели и суммы', 'Действия'].map(value => <th key={value}>{value}</th>)}</tr></thead>
          <tbody>{rows.map(row => <tr key={row.id}>
            <td>{row.date.split('-').reverse().join('.')}</td>
            <td><button className="operator-link" onClick={() => setEditor({ kind: 'fuel', row })}>{row.name}</button></td>
            <td>{row.schemaVersion === 3 ? row.planClientName : 'Без задания'}</td>
            <td>{groupName(row) || '—'}</td><td>{row.service}</td><td>{display(row.discountPercent)}</td><td>{display(row.litres)}</td><td>{display(row.pricePerLitre, row.schemaVersion !== undefined && !row.legacyPrecision?.pricePerLitre)}</td><td>{display(row.amount, true)}</td>
            <td><span className={`operator-status ${row.paid ? 'is-paid' : ''}`}>{row.paid ? 'Оплачено' : 'Не оплачено'}</span></td>
            <td className="operator-recipient-cell">{row.schemaVersion === 3 ? <ul className="operator-allocation-history">{row.allocations.map((allocation, index) => <li key={index} className={allocation.kind === 'manager' ? 'is-manager' : ''}><strong>{allocation.kind === 'manager' ? `Менеджер ${allocation.managerId === 'aidar' ? 'Айдар' : 'Эльдар'}` : allocation.recipient.name} · {display(allocation.amount, true)} ₽</strong>{allocation.kind === 'recipient' && <span>{[allocation.recipient.bank, allocation.recipient.card, allocation.recipient.phone, allocation.recipient.details].filter(Boolean).join(' · ')}</span>}</li>)}</ul> : <span>{recipientText(row)}</span>}<button className="icon-button" aria-label={`Копировать реквизиты для ${row.name}`} title="Копировать реквизиты" onClick={() => void copy(recipientText(row))}><Copy size={15} /></button></td>
            <td><div className="operator-row-actions"><div><button className="button operator-row-edit" aria-label={`${row.paid ? 'Просмотреть' : 'Редактировать'} операцию ${row.name}`} onClick={() => setEditor({ kind: 'fuel', row })}>{row.paid ? <Eye size={15} /> : <Pencil size={15} />}{row.paid ? 'Просмотр' : 'Изменить'}</button><button className="icon-button operator-delete" aria-label={`Удалить операцию ${row.name}`} title={row.paid ? 'Для удаления сначала снимите подтверждение оплаты' : 'Удалить операцию'} disabled={row.paid} onClick={() => setEditor({ kind: 'delete', row })}><Trash2 size={16} /></button></div><button className="button" onClick={() => setEditor({ kind: 'payment', row })}>{row.paid ? 'Снять подтверждение' : 'Подтвердить оплату'}</button></div></td>
          </tr>)}</tbody>
        </table></div> : <div className="empty-state"><strong>{data.refuellings.length ? 'Операции не найдены' : 'Операций пока нет'}</strong><span>{data.refuellings.length ? 'Измените задание, поиск или фильтры.' : 'Выберите активное задание и создайте операцию для водителя. Оплату можно подтвердить позже.'}</span></div>}
      </>}
    </div>}
    {editor && data && <OperatorEditor editor={editor} workspace={data} onClose={() => setEditor(null)} onSaved={saved} />}
    {planEditor && data && <PlanEditor plan={planEditor.plan} workspace={data} creatorName={creatorName} onClose={() => setPlanEditor(null)} onSaved={saved} />}
  </section>
}

function OperatorEditor({ editor, workspace, onClose, onSaved }: { editor: Editor; workspace: OperatorWorkspace; onClose: () => void; onSaved: (data: OperatorWorkspace, notice?: string) => void }) {
  const row = editor.row, fuel = editor.kind === 'fuel' ? editor.row : undefined
  const existingServiceId = fuel?.schemaVersion !== undefined ? fuel.serviceId : workspace.services.find(service => service.name === fuel?.service)?.id ?? ''
  const initial: Record<string, string> = {
    date: fuel?.date ?? today(), name: fuel?.name ?? '', groupId: fuel?.schemaVersion !== undefined ? fuel.groupId : '',
    serviceId: existingServiceId, serviceVersion: String(fuel?.schemaVersion !== undefined ? fuel.serviceVersion : workspace.services.find(service => service.id === existingServiceId)?.version ?? 0),
    discountPercent: fuel?.discountPercent ?? '', litres: fuel?.litres ?? '', pricePerLitre: fuel?.pricePerLitre ?? '',
    amount: fuel?.amount ?? '', amountMode: fuel?.schemaVersion !== undefined ? fuel.amountMode : fuel ? 'manual' : 'auto',
    comment: fuel?.comment ?? '', recipientText: fuel ? recipientText(fuel) : '',
  }
  const [values, setValues] = useState(initial), [catalog, setCatalog] = useState(workspace)
  const planned = !fuel || fuel.schemaVersion === 3
  const [planId, setPlanId] = useState(fuel?.schemaVersion === 3 ? fuel.planId : editor.kind === 'fuel' ? editor.planId ?? '' : '')
  const [allocationDrafts, setAllocations] = useState<AllocationDraft[]>(allocationFromRow(fuel))
  const initialPlan = useRef(planId), initialAllocations = useRef(allocationDrafts)
  const plan = catalog.plans.find(item => item.id === planId)
  const allocations = resolveAllocationSuggestions(allocationDrafts, plan, values.amount, fuel)
  const allocationProblem = planned ? allocationError(plan, allocations, values.amount, fuel) : ''
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [discard, setDiscard] = useState(false), [stale, setStale] = useState(false)
  const original = useRef(initial), pending = useRef<string | null>(null), lock = useRef(false), dialog = useRef<HTMLDialogElement>(null)
  const { close, complete } = useDialogMotion(dialog, onClose)
  const payment = editor.kind === 'payment', deleting = editor.kind === 'delete', readonly = editor.kind === 'fuel' && !!fuel?.paid
  const historicalPrecision = !!fuel && (fuel.schemaVersion === undefined || !!fuel.legacyPrecision)
  const dirty = JSON.stringify(values) !== JSON.stringify(original.current) || planId !== initialPlan.current || JSON.stringify(allocations) !== JSON.stringify(initialAllocations.current)
  const title = deleting ? 'Удаление операции' : payment ? (editor.row.paid ? 'Снять подтверждение оплаты' : 'Подтвердить оплату') : row ? 'Операция' : 'Новая операция'
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
      next.serviceVersion = String(historical && fuel.schemaVersion !== undefined ? fuel.serviceVersion : service?.version ?? 0)
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
      if (service && fuel && fuel.schemaVersion === undefined && values.serviceId === existingServiceId) {
        // Legacy records have no saved service version, but keep their historical rate.
        setValues(previous => ({ ...previous, serviceVersion: String(service.version ?? 0) }))
      } else if (service && (!fuel || values.serviceId !== existingServiceId)) {
        setValues(previous => ({ ...previous, serviceVersion: String(service.version ?? 0), discountPercent: service.discountPercent,
          ...(service.discountPercent !== previous.discountPercent ? { amountMode: 'auto', amount: calculateOperatorAmount(previous.litres, previous.pricePerLitre, service.discountPercent, historicalPrecision) ?? '' } : {}),
        }))
      }
      setStale(false); setError('Задания и справочники обновлены. Ваш ввод сохранён: проверьте остатки, распределение и сумму перед сохранением.')
    } catch { setError('Не удалось обновить данные. Ваш ввод сохранён.') }
    finally { lock.current = false; setSaving(false) }
  }
  const field = (key: string, label: string, type = 'text', required = true) => <label key={key}>{label}<input aria-label={label} type={type} required={required} value={values[key]} maxLength={key === 'comment' ? 4000 : 500} inputMode={['litres', 'pricePerLitre', 'amount'].includes(key) ? 'decimal' : undefined} onChange={event => update(key, event.target.value)} /></label>
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current || readonly) return
    if (!payment && !deleting && !pending.current && allocationProblem) { setError(allocationProblem); return }
    const path = `/api/operator/refuellings${row ? `/${row.id}` : ''}${payment ? '/payment' : deleting ? '/delete' : ''}`
    let body = pending.current
    if (!body) {
      const payload = editor.kind === 'payment' ? { paid: !editor.row.paid } : deleting ? {} : planned ? {
        date: values.date, name: values.name, groupId: values.groupId, serviceId: values.serviceId, serviceVersion: Number(values.serviceVersion),
        discountPercent: values.discountPercent, litres: values.litres, pricePerLitre: values.pricePerLitre, amount: values.amount, amountMode: values.amountMode, comment: values.comment,
        schemaVersion: 3, planId, planVersion: plan?.version, allocations: allocations.map(item => item.kind === 'recipient' ? { kind: item.kind, recipientId: item.recipientId, amount: item.amount } : { kind: item.kind, managerId: item.managerId, amount: item.amount }),
      } : { ...values, schemaVersion: 2, serviceVersion: Number(values.serviceVersion) }
      body = JSON.stringify({ ...payload, ...(row ? { version: row.version } : {}), idempotencyKey: crypto.randomUUID() })
      pending.current = body
    }
    lock.current = true; setSaving(true); setError(''); setStale(false)
    try {
      const response = await apiFetch(path, { method: row ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(20000) })
      const result = await response.json()
      if (!response.ok) {
        if (isDefinitiveOperatorRejection(response.status, result.error, uncertain)) { pending.current = null; setUncertain(false) } else setUncertain(true)
        setStale(!payment && !deleting && response.status === 409 && /сервис|скидк|справочник|групп|задан|план|остат|лимит/i.test(result.error ?? ''))
        setError(result.error || 'Сохранение не подтверждено.'); return
      }
      // Retain exactly the same request until persisted read-back succeeds.
      setUncertain(true)
      const next = await readWorkspace()
      if (deleting || result.deleted === true ? next.refuellings.some(item => item.id === result.id) : !next.refuellings.some(item => item.id === result.id)) throw new Error('Результат записи пока не подтверждён.')
      pending.current = null; setUncertain(false); await complete(() => onSaved(next, deleting ? 'Операция удалена' : result.deleted === true ? 'Операция уже была удалена. Повторный запрос не восстановил её.' : undefined))
    } catch { setUncertain(true); setError('Ответ не получен или повторное чтение не удалось. Проверьте сохранение тем же запросом.') }
    finally { lock.current = false; setSaving(false) }
  }
  return <dialog ref={dialog} className="operator-dialog" aria-labelledby="operator-editor-title" onCancel={event => { event.preventDefault(); dismiss() }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2 id="operator-editor-title">{title}</h2><button type="button" className="icon-button" aria-label="Закрыть форму" disabled={saving} onClick={dismiss}><X size={20} /></button></header>
      <div className="operator-dialog-body">
      {error && <p role="alert" className="soft-notice">{error}</p>}
      {stale && <button type="button" className="button" disabled={saving || uncertain} onClick={() => void refreshCatalog()}>{planned ? 'Обновить задания и справочники' : 'Обновить справочники'}</button>}
      {discard ? <div className="operator-discard"><p>Закрыть форму без сохранения?</p><div className="operator-actions"><button type="button" className="button" onClick={() => setDiscard(false)}>Продолжить ввод</button><button type="button" className="button" onClick={close}>Не сохранять</button></div></div> : <>
        {editor.kind === 'delete' ? <div className="operator-delete-summary"><p>Удалить операцию водителя <strong>{editor.row.name}</strong> на <strong>{display(editor.row.amount, true)} ₽</strong>?</p><p>{editor.row.schemaVersion === 3 ? 'Суммы вернутся в доступные остатки задания. Операция исчезнет из журнала.' : 'Операция исчезнет из журнала.'}</p></div> : editor.kind === 'payment' ? <><p><strong>{editor.row.name}</strong> · {display(editor.row.amount, true)} ₽</p><p>{editor.row.paid ? 'Отметка будет снята. Предыдущее подтверждение останется в истории.' : 'Подтвердите, что деньги получены. Это ручная отметка оператора.'}</p><pre>{recipientText(editor.row)}</pre></> : <fieldset disabled={saving || uncertain || readonly} className="operator-form-grid">
          {planned && <label className="operator-full">Задание<select aria-label="Задание" required disabled={!!fuel} value={planId} onChange={event => { setPlanId(event.target.value); setAllocations([]) }}><option value="">Выберите активное задание</option>{catalog.plans.filter(item => item.status === 'active' || item.id === planId).map(item => <option key={item.id} value={item.id}>{item.clientName} · {planDate(item.createdAt)} · осталось {display(item.remaining, true)} ₽</option>)}</select></label>}
          {field('date', 'Дата заправки', 'date')}{field('name', 'Имя водителя')}
          <label>Группа<select aria-label="Группа" required value={values.groupId} onChange={event => update('groupId', event.target.value)}><option value="">Выберите группу</option>
            {fuel?.schemaVersion !== undefined && !catalog.groups.some(item => item.id === fuel.groupId) && <option value={fuel.groupId}>{fuel.groupName}</option>}
            {catalog.groups.map(item => <option key={item.id} value={item.id}>{item.id === (fuel?.schemaVersion !== undefined ? fuel.groupId : '') ? groupName(fuel!) : item.name}</option>)}
          </select></label>
          <label>Сервис<select aria-label="Сервис" required value={values.serviceId} onChange={event => update('serviceId', event.target.value)}><option value="">Выберите сервис</option>
            {fuel?.schemaVersion !== undefined && !catalog.services.some(item => item.id === fuel.serviceId) && <option value={fuel.serviceId}>{fuel.service}</option>}
            {catalog.services.map(item => <option key={item.id} value={item.id}>{item.id === existingServiceId && fuel ? fuel.service : item.name}</option>)}
          </select></label>
          <label>Скидка, %<input aria-label="Скидка, %" value={values.discountPercent.replace('.', ',')} readOnly /></label>
          {field('litres', 'Литры')}{field('pricePerLitre', 'Цена за литр, ₽')}{field('amount', 'Сумма к оплате, ₽')}
          <p className="operator-full muted" role="status">{values.amountMode === 'manual' ? 'Сумма изменена вручную. При изменении литров, цены или сервиса она рассчитается заново.' : 'Сумма рассчитывается с учётом скидки сервиса. При необходимости её можно изменить вручную.'}</p>
          {planned ? <AllocationEditor plan={plan} allocations={allocations} onChange={setAllocations} amount={values.amount} original={fuel} /> : <label className="operator-full">Имя получателя и реквизиты<textarea aria-label="Имя получателя и реквизиты" required rows={4} maxLength={4000} value={values.recipientText} onChange={event => update('recipientText', event.target.value)} /></label>}
          {field('comment', 'Комментарий', 'text', false)}
          {!catalog.groups.length && <p className="operator-full">Для новой заправки сначала добавьте группу на странице «Справочники».</p>}
        </fieldset>}
        {fuel && <>
          {readonly && <p>Для исправления снимите подтверждение оплаты в журнале.</p>}
          {fuel.paymentHistory.length > 0 && <><h3>История оплаты</h3><ul>{fuel.paymentHistory.map((entry, index) => <li key={index}>{entry.paid ? 'Подтверждена' : 'Подтверждение снято'} · {entry.actorName} · {new Date(entry.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</li>)}</ul></>}
        </>}
      </>}
      </div>
      {!discard && <footer><button type="button" className="button" disabled={saving || uncertain} onClick={dismiss}>{deleting ? 'Отмена' : 'Закрыть'}</button>{!readonly && <button type="submit" className={`button primary ${deleting ? 'operator-danger-button' : ''}`} disabled={saving || (!uncertain && !payment && !deleting && (!!allocationProblem || !!row && !dirty))}>{saving ? 'Сохраняем…' : uncertain ? 'Проверить сохранение' : deleting ? 'Удалить операцию' : payment ? 'Подтвердить' : 'Сохранить операцию'}</button>}</footer>}
    </form>
  </dialog>
}

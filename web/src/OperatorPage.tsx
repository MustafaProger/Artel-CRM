import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ChevronLeft, ChevronRight, Plus, RefreshCw, X } from 'lucide-react'
import Decimal from 'decimal.js'
import OperatorCaseSourcePicker from './OperatorCaseSourcePicker'
import OperatorJournal from './OperatorJournal'
import { useOperatorPayment } from './useOperatorPayment'
import OperatorOperationActions from './OperatorOperationActions'
import { CaseList, CaseCards, CaseEditor, type CaseEditorState } from './OperatorCases'
import { CaseTaskEditor, OperatorTaskPicker } from './OperatorCaseTasks'
import type { OperatorCaseKind, OperatorCaseSummary } from './operator-case-model'
import ScrollableSegments from './ScrollableSegments'
import { PlanEditor, PlanCards, planDate, AllocationEditor, allocationError, type AllocationDraft, allocationFromRow, resolveAllocationSuggestions } from './OperatorPlans'
import { useDialogMotion } from './useDialogMotion'
import { apiFetch } from './workspace-api'
import { display, readWorkspace, isDefinitiveOperatorRejection } from './operator-ui-utils'
import { calculateOperatorPayable } from './operator-calculation'
import type { OperatorPlanSummary, OperatorRefuelling, OperatorWorkspace } from './operator-model'
import { operatorServiceBackground, operatorServiceInk } from './operator-service-presentation'
import OperatorReconciliation from './OperatorReconciliation'
import { reconciliationServiceId } from './operator-reconciliation'
import OperatorServiceBadge, { OperatorServicesContext } from './OperatorServiceBadge'
import { operatorDiscountAt } from './operator-catalog'
import './operator.css'

type Editor = { kind: 'fuel'; row?: OperatorRefuelling; planId?: string } | { kind: 'payment' | 'delete'; row: OperatorRefuelling }
const recipientText = (row: OperatorRefuelling) => row.schemaVersion !== undefined ? row.recipientText : [row.recipient.name, row.recipient.bank, row.recipient.card && `Карта: ${row.recipient.card}`, row.recipient.phone && `Телефон: ${row.recipient.phone}`, row.recipient.details].filter(Boolean).join('\n')
const groupName = (row: OperatorRefuelling) => row.schemaVersion !== undefined ? row.groupName ?? '' : ''
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())

export default function OperatorPage({ creatorName }: { creatorName: string }) {
  const [data, setData] = useState<OperatorWorkspace | null>(null)
  const [error, setError] = useState(''), [busy, setBusy] = useState(false), [message, setMessage] = useState('')
  const [actionRow, setActionRow] = useState<OperatorRefuelling | null>(null)
  const [sourcePicker, setSourcePicker] = useState<OperatorCaseKind | null>(null)
  const [focusedCaseId, setFocusedCaseId] = useState(''), [taskPicker, setTaskPicker] = useState(false), [caseTask, setCaseTask] = useState<OperatorCaseSummary | null>(null)
  const [caseEditor, setCaseEditor] = useState<CaseEditorState | null>(null)
  const [editor, setEditor] = useState<Editor | null>(null), [planEditor, setPlanEditor] = useState<{ plan?: OperatorPlanSummary } | null>(null)
  const [tab, setTab] = useState('operations'), [planStatus, setPlanStatus] = useState('active'), [planId, setPlanId] = useState('')
  const [caseStatus, setCaseStatus] = useState<'open' | 'completed'>('open')
  const [query, setQuery] = useState(''), [from, setFrom] = useState(''), [to, setTo] = useState(''), [paid, setPaid] = useState('all')
  const [serviceId, setServiceId] = useState('')
  const [journalPage, setJournalPage] = useState({ filters: '', index: 0 })
  const request = useRef(0)
  const notificationTarget = useRef(new URLSearchParams(window.location.search).get('operatorPlan'))
  const reload = async () => {
    const serial = ++request.current
    setBusy(true); setError('')
    try {
      const next = await readWorkspace()
      if (serial === request.current) {
        setData(next)
        const plan = next.plans.find(row => row.id === notificationTarget.current)
        if (plan) { setPlanId(plan.id); setTab('operations') }
        notificationTarget.current = null
      }
    }
    catch (e) { if (serial === request.current) setError((e as Error).message) }
    finally { if (serial === request.current) setBusy(false) }
  }
  const openNewOperation = () => {
    if (data) setEditor({ kind: 'fuel', planId: data.plans.some(plan => plan.id === planId && plan.status === 'active') ? planId : undefined })
  }
  useEffect(() => { void reload(); return () => { request.current++ } }, [])
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(''), 3500); return () => clearTimeout(timer) }, [message])
  const saved = (next: OperatorWorkspace, notice = 'Сохранено') => { request.current++; setData(next); setEditor(null); setPlanEditor(null); setCaseEditor(null); setCaseTask(null); setTaskPicker(false); setActionRow(null); setMessage(notice) }
  const payment = useOperatorPayment(next => { request.current++; setData(next) })
  const q = query.trim().toLocaleLowerCase('ru')
  const rows = (data?.refuellings ?? []).filter(row => !row.deletedAt && (!serviceId || !!data && reconciliationServiceId(data, row) === serviceId) && (!planId || row.schemaVersion === 3 && (row.planId === planId || row.allocations.some(item => item.planId === planId))) && (!from || row.date >= from) && (!to || row.date <= to) && (paid === 'all' || row.paid === (paid === 'paid')) && `${row.name} ${row.schemaVersion !== undefined ? data?.services.find(service => service.id === row.serviceId)?.name ?? row.service : row.service} ${groupName(row)} ${recipientText(row)} ${row.comment} ${row.schemaVersion === 3 ? [row.planClientName, ...row.allocations.map(item => item.planClientName)].join(' ') : ''}`.toLocaleLowerCase('ru').includes(q))
  const filters = JSON.stringify([q, from, to, paid, serviceId, planId])
  // Reset before committing rows for a different filter; clearing a search must
  // not restore a stale page from before that search.
  if (journalPage.filters !== filters) setJournalPage({ filters, index: 0 })
  const lastPage = Math.max(0, Math.ceil(rows.length / 50) - 1)
  const page = journalPage.filters === filters ? Math.min(journalPage.index, lastPage) : 0
  const serviceOptions = data ? [...new Map([...data.refuellings.map(row => [reconciliationServiceId(data, row), row.service] as const), ...data.services.map(service => [service.id, service.name] as const)])] : []
  const selectedPlan = data?.plans.find(plan => plan.id === planId)
  const scheduled = (data?.cases ?? []).filter(entry => !!entry.task)
  const taskRows = scheduled.filter(entry => planStatus === 'active' ? entry.status === 'open' : entry.status === 'completed').sort((a, b) => a.task!.dueDate.localeCompare(b.task!.dueDate) || a.createdAt.localeCompare(b.createdAt))
  const viewCaseSource = (id: string) => { const row = data?.refuellings.find(item => item.id === id); if (row) setEditor({ kind: 'fuel', row }) }
  const settleCase = (entry: OperatorCaseSummary, method: 'money' | 'fuel') => setCaseEditor({ mode: 'settle', entry, method })
  return <OperatorServicesContext.Provider value={data?.services ?? []}><section className="operator-workspace" aria-label="Операторская">
    <div className="operator-topbar">
      <ScrollableSegments className="operator-tabs" role="tablist" label="Раздел операторской" value={tab}>
        {[['plans', `Задания · ${(data?.plans ?? []).filter(plan => plan.status === 'active').length + scheduled.filter(entry => entry.status === 'open').length}`], ['operations', 'Операции'], ['return', `Возвраты · ${(data?.cases ?? []).filter(entry => entry.kind === 'return' && entry.status === 'open').length}`], ['deferred', `Ожидают заправки · ${(data?.cases ?? []).filter(entry => entry.kind === 'deferred' && entry.status === 'open').length}`], ['reconciliation', 'Сверки']].map(([id, label]) => <button type="button" key={id} id={`operator-tab-${id}`} role="tab" aria-selected={tab === id} aria-controls="operator-content" onClick={() => { if (id !== tab || focusedCaseId) setCaseStatus('open'); setTab(id); setFocusedCaseId('') }}>{label}</button>)}
      </ScrollableSegments>
      {tab !== 'reconciliation' && <div className="operator-controls">
        {tab === 'plans' && data && <div className="operator-plan-heading">
          <div className="operator-actions" role="group" aria-label="Статус заданий">
            {[['active', 'Активные'], ['completed', 'Выполненные']].map(([status, label]) => <button className={`button ${planStatus === status ? 'selected' : ''}`} aria-pressed={planStatus === status} key={status} onClick={() => setPlanStatus(status)}>{label} · {data.plans.filter(plan => plan.status === status).length + scheduled.filter(entry => entry.status === (status === 'active' ? 'open' : 'completed')).length}</button>)}
          </div>
        </div>}
        {(tab === 'return' || tab === 'deferred') && data && <div className="operator-plan-heading">
        <div className="operator-actions operator-case-filters" role="group" aria-label="Состояние записей">
          {([['open', 'Открытые'], ['completed', 'Выполненные']] as const).map(([status, label]) => <button type="button" key={status} className={`button${caseStatus === status ? ' selected' : ''}`} aria-pressed={caseStatus === status} onClick={() => setCaseStatus(status)}>{label} · {data.cases.filter(entry => entry.kind === tab && entry.status === status).length}</button>)}
        </div>
        </div>}
      <div className="operator-toolbar">
        <button className="button operator-toolbar-icon mobile-icon-action" aria-label="Обновить" title="Обновить" disabled={busy} onClick={() => void reload()}><RefreshCw size={18} aria-hidden="true" /><span className="mobile-action-label">Обновить</span></button>
        {tab === 'plans' ? <button className="button primary operator-toolbar-icon mobile-icon-action" aria-label="Новое задание" title="Новое задание" disabled={!data} onClick={() => setTaskPicker(true)}><Plus size={20} aria-hidden="true" /><span className="mobile-action-label">Новое задание</span></button> : tab === 'return' || tab === 'deferred' ? <button className="button primary operator-toolbar-icon mobile-icon-action" aria-label={tab === 'return' ? 'Создать возврат' : 'Отложить заправку'} title={tab === 'return' ? 'Создать возврат' : 'Отложить заправку'} disabled={!data} onClick={event => { event.currentTarget.focus({ preventScroll: true }); setSourcePicker(tab as OperatorCaseKind) }}><Plus size={20} aria-hidden="true"/><span className="mobile-action-label">{tab === 'return' ? 'Создать возврат' : 'Отложить заправку'}</span></button> : <button className="button primary operator-toolbar-icon mobile-icon-action" aria-label="Новая операция" title="Новая операция" disabled={!data?.plans.some(plan => plan.status === 'active')} onClick={() => void openNewOperation()}><Plus size={20} aria-hidden="true" /><span className="mobile-action-label">Новая операция</span></button>}
        </div>
        </div>}
    </div>
    {error && <p className="soft-notice" role="alert">{error}</p>}
    {payment.error && <p className="soft-notice" role="alert">{payment.error}</p>}
    {payment.pending && <button type="button" className="button" disabled={payment.busy} onClick={() => void payment.retry()}>Проверить сохранение оплаты</button>}
    {payment.busy && <p role="status">Сохраняем отметку оплаты…</p>}
    {message && <p className="operator-feedback" role="status">{message}</p>}
    {!data ? <p role="status">{busy ? 'Загружаем операторскую…' : 'Данные не загружены.'}</p> : <div id="operator-content" role="tabpanel" aria-labelledby={`operator-tab-${tab}`}>
      <div hidden={tab !== 'reconciliation'}><OperatorReconciliation workspace={data} busy={busy} onRefresh={() => void reload()} onSaved={next => setData(next)} onOperation={row => setEditor({kind:'fuel',row})} onDate={(date, service) => {setFrom(date);setTo(date);setServiceId(service);setQuery('');setPaid('all');setPlanId('');setFocusedCaseId('');setTab('operations');document.getElementById('operator-tab-operations')?.focus({preventScroll:true})}}/></div>
      {tab === 'plans' && <>
      <section className="operator-task-section" aria-label="Задания на приём оплаты"><h2>Приём оплаты</h2><PlanCards plans={data.plans.filter(plan => plan.status === planStatus)} onSelect={id => { setPlanId(id); setFrom('');setTo('');setServiceId('');setQuery('');setPaid('all'); setTab('operations') }} onEdit={plan => setPlanEditor({ plan })} /></section>
      <section className="operator-task-section" aria-label="Задания на возвраты и заправки"><h2>Возвраты и заправки</h2>
      {taskRows.length ? <CaseCards entries={taskRows} operations={data.refuellings} taskView onSettle={settleCase} onViewSource={viewCaseSource} onTask={setCaseTask}/> : <p className="operator-case-explanation">{scheduled.length ? 'Заданий с выбранным состоянием нет.' : 'Откройте подробности возврата или ожидающей заправки, нажмите «Запланировать» и выберите дату.'}</p>}</section>
      </>}
      {tab === 'operations' && <>
        <div className="operator-journal-heading"><h2>Операции по водителям <span>{rows.length}</span></h2></div>
        {selectedPlan && <div className="operator-selection"><p><strong>{selectedPlan.clientName}</strong> · {selectedPlan.status === 'completed' ? 'Выполнено' : `Осталось ${display(selectedPlan.remaining, true)} ₽`}</p><button className="operator-link" onClick={() => setPlanId('')}>Показать все операции</button></div>}
        <div className="operator-filters">
          <label>Поиск<input aria-label="Поиск операций" value={query} onChange={e => setQuery(e.target.value)} placeholder="Водитель, клиент, получатель" /></label>
          <label>С даты<input type="date" value={from} onChange={e => setFrom(e.target.value)} /></label>
          <label>По дату<input type="date" value={to} onChange={e => setTo(e.target.value)} /></label>
          <label>Сервис<select aria-label="Сервис операций" value={serviceId} onChange={event => setServiceId(event.target.value)}><option value="">Все сервисы</option>{serviceOptions.map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select></label>
          <label>Оплата<select aria-label="Оплата операций" value={paid} onChange={e => setPaid(e.target.value)}><option value="all">Все</option><option value="paid">Оплачено</option><option value="unpaid">Не оплачено</option></select></label>
          <label className="operator-plan-filter">Задание<select aria-label="Фильтр по заданию" value={planId} onChange={event => setPlanId(event.target.value)}><option value="">Все задания</option>{data.plans.map(plan => <option key={plan.id} value={plan.id}>{plan.clientName} · {plan.status === 'completed' ? 'Выполнено' : 'Активно'} · {planDate(plan.createdAt)}</option>)}</select></label>
        </div>
        {from && to && from > to && <p role="alert">Начало периода позже окончания.</p>}
        {rows.length ? <OperatorJournal rows={rows.slice(page * 50, (page + 1) * 50)} onView={row => setEditor({ kind: 'fuel', row })} onAction={setActionRow} paymentDisabled={payment.disabled} onPayment={row => void payment.change(row)} cases={data.cases} onCase={entry => { setCaseStatus(entry.status); setTab(entry.kind); setFocusedCaseId(entry.id) }} /> : <div className="empty-state"><strong>{data.refuellings.length ? 'Операции не найдены' : 'Операций пока нет'}</strong><span>{data.refuellings.length ? 'Измените задание, поиск или фильтры.' : 'Выберите задание и создайте операцию для водителя. Оплату можно подтвердить позже.'}</span></div>}
        {rows.length > 50 && <nav className="pagination" aria-label="Страницы операций"><span>{page * 50 + 1}–{Math.min((page + 1) * 50, rows.length)} из {rows.length}</span><div><button type="button" className="icon-button" aria-label="Предыдущая страница операций" disabled={!page} onClick={() => setJournalPage({ filters, index: page - 1 })}><ChevronLeft size={18}/></button><span aria-live="polite">{page + 1} / {lastPage + 1}</span><button type="button" className="icon-button" aria-label="Следующая страница операций" disabled={page === lastPage} onClick={() => setJournalPage({ filters, index: page + 1 })}><ChevronRight size={18}/></button></div></nav>}
      </>}
      {(tab === 'return' || tab === 'deferred') && <CaseList operations={data.refuellings} key={`${tab}:${focusedCaseId}`} cases={data.cases ?? []} kind={tab as OperatorCaseKind} status={caseStatus} focusedId={focusedCaseId} onSettle={settleCase} onTask={setCaseTask} onViewSource={viewCaseSource} />}
    </div>}
    {actionRow && data && <OperatorOperationActions paymentDisabled={payment.disabled} row={actionRow} onClose={() => setActionRow(null)} canReturn={actionRow.paid && claimedLitres(data, actionRow).lt(actionRow.litres)} canDefer={actionRow.paid && claimedLitres(data, actionRow).isZero()} historyLocked={operationLocked(data, actionRow)} onAction={action => {
      if (action === 'return' || action === 'defer') setCaseEditor({ mode: 'create', source: actionRow, kind: action === 'return' ? 'return' : 'deferred' })
      else if (action === 'payment') void payment.change(actionRow)
      else setEditor({ kind: action === 'view' ? 'fuel' : action, row: actionRow })
    }} />}
    {sourcePicker && data && <OperatorCaseSourcePicker workspace={data} kind={sourcePicker} onClose={() => setSourcePicker(null)} onSelect={source => { setCaseEditor({ mode: 'create', source, kind: sourcePicker }); setSourcePicker(null) }}/>}
    {taskPicker && data && <OperatorTaskPicker cases={data.cases ?? []} onClose={() => setTaskPicker(false)} onPlan={() => { setTaskPicker(false); setPlanEditor({}) }} onTask={entry => { setTaskPicker(false); setCaseTask(entry) }}/>} 
    {caseTask && <CaseTaskEditor entry={caseTask} onClose={() => setCaseTask(null)} onSaved={(next, notice) => { saved(next, notice); setTab('plans'); setPlanStatus(next.cases.find(item => item.id === caseTask.id)?.status === 'completed' ? 'completed' : 'active') }}/>} 
    {caseEditor && data && <CaseEditor editor={caseEditor} workspace={data} onClose={() => setCaseEditor(null)} onSaved={saved} />}
    {editor && data && <OperatorEditor editor={editor} workspace={data} onClose={() => setEditor(null)} onSaved={saved} />}
    {planEditor && data && <PlanEditor plan={planEditor.plan} workspace={data} creatorName={creatorName} onClose={() => setPlanEditor(null)} onSaved={saved} />}
  </section></OperatorServicesContext.Provider>
}

const claimedLitres = (data: OperatorWorkspace, row: OperatorRefuelling) => (data.cases ?? []).filter(entry => entry.operationId === row.id).reduce((sum, entry) => sum.plus(entry.litres), new Decimal(0))
const operationLocked = (data: OperatorWorkspace, row: OperatorRefuelling) => (data.cases ?? []).some(entry => entry.operationId === row.id) || row.schemaVersion === 3 && !!row.carryovers?.length

function OperatorEditor({ editor, workspace, onClose, onSaved }: { editor: Editor; workspace: OperatorWorkspace; onClose: () => void; onSaved: (data: OperatorWorkspace, notice?: string) => void }) {
  const row = editor.row, fuel = editor.kind === 'fuel' ? editor.row : undefined
  const existingServiceId = fuel?.schemaVersion !== undefined ? fuel.serviceId : workspace.services.find(service => service.name === fuel?.service)?.id ?? ''
  const initial: Record<string, string> = {
    date: fuel?.date ?? today(), name: fuel?.name ?? '', groupId: fuel?.schemaVersion !== undefined ? fuel.groupId ?? '' : '',
    serviceId: existingServiceId, serviceVersion: String(fuel?.schemaVersion !== undefined ? fuel.serviceVersion : workspace.services.find(service => service.id === existingServiceId)?.version ?? 0),
    discountPercent: fuel?.discountPercent ?? '', litres: fuel?.litres ?? '', pricePerLitre: fuel?.pricePerLitre ?? '',
    amount: fuel?.amount ?? '', amountMode: fuel?.schemaVersion !== undefined ? fuel.amountMode : fuel ? 'manual' : 'auto',
    comment: fuel?.comment ?? '', recipientText: fuel ? recipientText(fuel) : '',
  }
  const [values, setValues] = useState(initial), [catalog, setCatalog] = useState(workspace)
  const [carryoverId, setCarryoverId] = useState(''), [carryoverAmount, setCarryoverAmount] = useState('')
  const carryoverCase = (catalog.cases ?? []).find(entry => entry.id === carryoverId)
  const parsedCredit = /^\d+(?:[.,]\d{1,2})?$/.test(carryoverAmount) && carryoverAmount.length <= 40 ? new Decimal(carryoverAmount.replace(',', '.')) : null
  const carryoverProblem = !carryoverId ? '' : !carryoverCase || carryoverCase.status !== 'open' ? 'Этот остаток уже использован. Обновите данные.'
    : !parsedCredit?.gt(0) ? 'Укажите сумму из остатка.' : parsedCredit.gt(carryoverCase.remainingAmount) ? 'Сумма превышает остаток водителя.'
    : calculateOperatorPayable(values.litres, values.pricePerLitre, values.discountPercent, carryoverAmount) === null ? 'Стоимость заправки должна быть больше суммы зачёта. Для заправки только на остаток откройте его карточку.' : ''
  const chooseCarryover = (id: string, value?: string) => {
    const entry = (catalog.cases ?? []).find(item => item.id === id), amount = value ?? entry?.remainingAmount ?? ''
    setCarryoverId(id); setCarryoverAmount(amount)
    setValues(previous => ({ ...previous, ...(entry ? { name: entry.source.driverName } : {}), amountMode: 'auto', amount: calculateOperatorPayable(previous.litres, previous.pricePerLitre, previous.discountPercent, id ? amount : '0') ?? '' }))
  }
  const planned = !fuel || fuel.schemaVersion === 3
  const [planId, setPlanId] = useState(fuel?.schemaVersion === 3 ? fuel.planId : editor.kind === 'fuel' ? editor.planId ?? '' : '')
  const [allocationDrafts, setAllocations] = useState<AllocationDraft[]>(allocationFromRow(fuel))
  const initialPlan = useRef(planId), initialAllocations = useRef(allocationDrafts)
  const operationPlans = catalog.plans.filter(item => item.status === 'active' || fuel?.schemaVersion === 3 && (item.id === fuel.planId || fuel.allocations.some(allocation => allocation.planId === item.id)))
  const plan = operationPlans.find(item => item.id === planId)
  const allocations = resolveAllocationSuggestions(allocationDrafts, plan, values.amount, fuel, operationPlans)
  const allocationProblem = planned ? allocationError(plan, allocations, values.amount, operationPlans) : ''
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [uncertain, setUncertain] = useState(false), [discard, setDiscard] = useState(false), [stale, setStale] = useState(false)
  const original = useRef(initial), pending = useRef<string | null>(null), lock = useRef(false), dialog = useRef<HTMLDialogElement>(null)
  const { close, complete } = useDialogMotion(dialog, onClose)
  const payment = editor.kind === 'payment', deleting = editor.kind === 'delete', readonly = editor.kind === 'fuel' && !!fuel && (fuel.paid || operationLocked(workspace, fuel))
  const historicalPrecision = !!fuel && (fuel.schemaVersion === undefined || !!fuel.legacyPrecision)
  const dirty = JSON.stringify(values) !== JSON.stringify(original.current) || planId !== initialPlan.current || JSON.stringify(allocations) !== JSON.stringify(initialAllocations.current) || !!carryoverId
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
    if (key === 'serviceId' || key === 'date') {
      const service = catalog.services.find(item => item.id === next.serviceId)
      const historical = !!fuel && next.serviceId === existingServiceId
      next.discountPercent = historical ? fuel.discountPercent : service ? operatorDiscountAt(service, next.date) : ''
      next.serviceVersion = String(historical && fuel.schemaVersion !== undefined ? fuel.serviceVersion : service?.version ?? 0)
    }
    if (['litres', 'pricePerLitre', 'serviceId'].includes(key) || key === 'date' && next.discountPercent !== previous.discountPercent) {
      next.amountMode = 'auto'
      next.amount = calculateOperatorPayable(next.litres, next.pricePerLitre, next.discountPercent, carryoverId ? carryoverAmount : '0', historicalPrecision) ?? ''
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
        setValues(previous => {
          const discountPercent = operatorDiscountAt(service, previous.date)
          return { ...previous, serviceVersion: String(service.version ?? 0), discountPercent,
            ...(discountPercent !== previous.discountPercent ? { amountMode: 'auto', amount: calculateOperatorPayable(previous.litres, previous.pricePerLitre, discountPercent, carryoverId ? carryoverAmount : '0', historicalPrecision) ?? '' } : {}),
          }
        })
      }
      setStale(false); setError('Задания и справочники обновлены. Ваш ввод сохранён: проверьте остатки, распределение и сумму перед сохранением.')
    } catch { setError('Не удалось обновить данные. Ваш ввод сохранён.') }
    finally { lock.current = false; setSaving(false) }
  }
  const field = (key: string, label: string, type = 'text', required = true) => <label key={key}>{label}<input aria-label={label} type={type} required={required} readOnly={key === 'name' && !!carryoverId} value={values[key]} maxLength={key === 'comment' ? 4000 : 500} inputMode={['litres', 'pricePerLitre', 'amount'].includes(key) ? 'decimal' : undefined} onChange={event => update(key, event.target.value)} /></label>
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current || readonly) return
    if (!payment && !deleting && !pending.current && (allocationProblem || carryoverProblem)) { setError(carryoverProblem || allocationProblem); return }
    const path = `/api/operator/refuellings${row ? `/${row.id}` : ''}${payment ? '/payment' : deleting ? '/delete' : ''}`
    let body = pending.current
    if (!body) {
      const payload = editor.kind === 'payment' ? { paid: !editor.row.paid } : deleting ? {} : planned ? {
        date: values.date, name: values.name, ...(values.groupId ? { groupId: values.groupId } : {}), serviceId: values.serviceId, serviceVersion: Number(values.serviceVersion),
        discountPercent: values.discountPercent, litres: values.litres, pricePerLitre: values.pricePerLitre, amount: values.amount, amountMode: values.amountMode, comment: values.comment,
        schemaVersion: 3, planId, planVersion: plan?.version, ...(fuel?.schemaVersion === 3 ? { planVersions: Object.fromEntries([...new Set([fuel.planId, ...fuel.allocations.map(item => item.planId ?? fuel.planId), ...allocations.map(item => item.planId ?? planId)])].map(id => [id, catalog.plans.find(p => p.id === id)?.version])) } : {}), ...(carryoverId && carryoverCase ? { carryovers: [{ caseId: carryoverId, version: carryoverCase.version, amount: carryoverAmount }] } : {}), allocations: allocations.map(item => ({ ...(item.kind === 'recipient' ? { kind: item.kind, recipientId: item.recipientId, amount: item.amount } : { kind: item.kind, managerId: item.managerId, amount: item.amount }), planId: item.planId ?? planId, planVersion: catalog.plans.find(p => p.id === (item.planId ?? planId))?.version })),
      } : { ...values, groupId: values.groupId || undefined, schemaVersion: 2, serviceVersion: Number(values.serviceVersion) }
      body = JSON.stringify({ ...payload, ...(row ? { version: row.version } : {}), idempotencyKey: crypto.randomUUID() })
      pending.current = body
    }
    lock.current = true; setSaving(true); setError(''); setStale(false)
    try {
      const response = await apiFetch(path, { method: row ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json', Prefer: 'respond-async' }, body, signal: AbortSignal.timeout(20000) })
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
  return <dialog ref={dialog} className={`operator-dialog${discard ? ' operator-discard-dialog' : ''}`} aria-labelledby="operator-editor-title" onCancel={event => { event.preventDefault(); dismiss() }}>
    <form onSubmit={event => void submit(event)}>
      <header><h2 id="operator-editor-title">{title}</h2><button type="button" className="icon-button" aria-label="Закрыть форму" disabled={saving} onClick={dismiss}><X size={20} /></button></header>
      <div className="operator-dialog-body">
      {error && <p role="alert" className="soft-notice">{error}</p>}
      {stale && !discard && <button type="button" className="button" disabled={saving || uncertain} onClick={() => void refreshCatalog()}>Загрузить актуальные данные</button>}
      {discard ? <div className="operator-discard"><p>Закрыть форму без сохранения?</p><div className="operator-actions"><button type="button" className="button" onClick={() => setDiscard(false)}>Продолжить ввод</button><button type="button" className="button" onClick={close}>Не сохранять</button></div></div> : <>
        {editor.kind === 'delete' ? <div className="operator-delete-summary"><p>Удалить операцию водителя <strong>{editor.row.name}</strong> на <strong>{display(editor.row.amount, true)} ₽</strong>?</p><p>{editor.row.schemaVersion === 3 ? 'Суммы вернутся в доступные остатки задания. Операция исчезнет из журнала.' : 'Операция исчезнет из журнала.'}</p></div> : editor.kind === 'payment' ? <><p><strong>{editor.row.name}</strong> · {display(editor.row.amount, true)} ₽</p><p>{editor.row.paid ? 'Отметка будет снята. Предыдущее подтверждение останется в истории.' : 'Подтвердите, что деньги получены. Это ручная отметка оператора.'}</p><pre>{recipientText(editor.row)}</pre></> : <fieldset disabled={saving || uncertain || readonly} className="operator-form-grid">
          {planned && <label className="operator-full">Задание<select aria-label="Задание" required disabled={!!fuel} value={plan?.id ?? ''} onChange={event => { setPlanId(event.target.value); setAllocations([]) }}><option value="">Выберите задание</option>{operationPlans.map(item => <option key={item.id} value={item.id} disabled={item.status === 'completed'}>{item.clientName} · {planDate(item.createdAt)} · осталось {display(item.remaining, true)} ₽</option>)}</select></label>}
          {field('date', 'Дата заправки', 'date')}{field('name', 'Имя водителя')}
          <label>Сервис<select style={values.serviceId ? {backgroundColor: catalog.services.find(item => item.id === values.serviceId)?.backgroundColor ?? operatorServiceBackground(catalog.services.find(item => item.id === values.serviceId)?.name ?? '', values.serviceId), color: operatorServiceInk(catalog.services.find(item => item.id === values.serviceId)?.backgroundColor ?? operatorServiceBackground(catalog.services.find(item => item.id === values.serviceId)?.name ?? '', values.serviceId))} : undefined} aria-label="Сервис" required value={values.serviceId} onChange={event => update('serviceId', event.target.value)}><option value="">Выберите сервис</option>
            {fuel?.schemaVersion !== undefined && !catalog.services.some(item => item.id === fuel.serviceId) && <option value={fuel.serviceId}>{fuel.service}</option>}
            {catalog.services.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>{values.serviceId && <OperatorServiceBadge service={catalog.services.find(item => item.id === values.serviceId)?.name ?? fuel?.service ?? ''} serviceId={values.serviceId} part="name"/>}</label>
          <label>Скидка, %<input aria-label="Скидка, %" value={values.discountPercent.replace('.', ',')} readOnly /></label>
          {field('litres', 'Литры')}{field('pricePerLitre', 'Цена за литр, ₽')}
          {!fuel && (catalog.cases ?? []).some(entry => entry.status === 'open') && <div className="operator-full operator-carryover-picker">
            <label>Остаток водителя<select aria-label="Остаток водителя" value={carryoverId} onChange={event => chooseCarryover(event.target.value)}><option value="">Без зачёта остатка</option>{(catalog.cases ?? []).filter(entry => entry.status === 'open').map(entry => <option key={entry.id} value={entry.id}>{entry.source.driverName} · {entry.kind === 'return' ? 'Возврат' : 'Ожидает заправки'} · {entry.source.date.split('-').reverse().join('.')} · {display(entry.remainingAmount, true)} ₽</option>)}</select></label>
            {carryoverId && <><label>Сумма из остатка, ₽<input aria-label="Сумма из остатка, ₽" inputMode="decimal" value={carryoverAmount} onChange={event => chooseCarryover(carryoverId, event.target.value)} /></label><p role="status">{carryoverProblem || `Зачёт ${display(parsedCredit!.toFixed(2), true)} ₽ по исходной стоимости. К оплате ${display(values.amount || '0', true)} ₽.`}</p></>}
          </div>}
          {fuel?.schemaVersion === 3 && fuel.carryoverMode === 'money' ? <p className="operator-full operator-edit-note">Зачтено из остатка: {display(fuel.creditedAmount!, true)} ₽.</p> : fuel?.schemaVersion === 3 && fuel.carryovers?.length ? <p className="operator-full operator-edit-note">{display(new Decimal(fuel.litres).minus(fuel.payableLitres ?? fuel.litres).toFixed())} л из остатка + {display(fuel.payableLitres ?? fuel.litres)} л к оплате. Всего {display(fuel.litres)} л.</p> : null}
          {field('amount', 'Сумма к оплате, ₽')}
          <p className="operator-full muted" role="status">{values.amountMode === 'manual' ? 'Сумма изменена вручную. При изменении литров, цены или сервиса она рассчитается заново.' : 'Сумма рассчитывается с учётом скидки сервиса. При необходимости её можно изменить вручную.'}</p>
          {planned ? <AllocationEditor plan={plan} plans={operationPlans} allocations={allocations} onChange={setAllocations} amount={values.amount} original={fuel} /> : <label className="operator-full">Имя получателя и реквизиты<textarea aria-label="Имя получателя и реквизиты" required rows={4} maxLength={4000} value={values.recipientText} onChange={event => update('recipientText', event.target.value)} /></label>}
          {field('comment', 'Комментарий', 'text', false)}
        </fieldset>}
        {fuel && <>
          {fuel.schemaVersion === 3 && <details open><summary>Сохранённые получатели и реквизиты</summary><pre>{recipientText(fuel)}</pre></details>}
          {readonly && <p>{operationLocked(workspace, fuel) ? 'Операция связана с возвратом или остатком литров. Исходная оплата и распределение сохранены.' : 'Для исправления снимите подтверждение оплаты в журнале.'}</p>}
          {fuel.paymentHistory.length > 0 && <><h3>История оплаты</h3><ul>{fuel.paymentHistory.map((entry, index) => <li key={index}>{entry.paid ? 'Подтверждена' : 'Подтверждение снято'} · {entry.actorName} · {new Date(entry.at).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow' })} МСК</li>)}</ul></>}
        </>}
      </>}
      </div>
      {!discard && <footer><button type="button" className="button" disabled={saving || uncertain} onClick={dismiss}>{deleting ? 'Отмена' : 'Закрыть'}</button>{!readonly && <button type="submit" className={`button primary ${deleting ? 'operator-danger-button' : ''}`} disabled={saving || (!uncertain && !payment && !deleting && (!!allocationProblem || !!carryoverProblem || !!row && !dirty))}>{saving ? 'Сохраняем…' : uncertain ? 'Проверить сохранение' : deleting ? 'Удалить операцию' : payment ? 'Подтвердить' : 'Сохранить операцию'}</button>}</footer>}
    </form>
  </dialog>
}

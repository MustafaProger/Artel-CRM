import { useEffect, useRef, useState, type FormEvent } from 'react'
import Decimal from 'decimal.js'
import { ArrowRight, Pencil, Plus, X } from 'lucide-react'
import { apiFetch } from './workspace-api'
import { useDialogMotion } from './useDialogMotion'
import { display, readWorkspace, isDefinitiveOperatorRejection } from './operator-ui-utils'
import { operatorRequisitesDraft, operatorRequisitesError, operatorRequisitesInputText, operatorRequisitesPayload, operatorRequisitesText } from './operator-requisites'
import './operator-cards.css'
import OperatorDetailsDrawer, { OperatorDetailsButton } from './OperatorDetailsDrawer'
import type { OperatorPlanSummary, OperatorRefuelling, OperatorWorkspace } from './operator-model'

type Manager = '' | 'aidar' | 'eldar'
export type AllocationDraft = ({ kind: 'recipient'; recipientId: string; amount: string } | { kind: 'manager'; managerId: Manager; amount: string }) & { automatic?: boolean }
export const planDate = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК'
const decimal = (value: string) => {
  const cleaned = value.trim().replace(',', '.')
  return /^\d+(?:\.\d{1,2})?$/.test(cleaned) ? new Decimal(cleaned) : null
}
const total = (rows: AllocationDraft[]) => rows.reduce((sum, row) => sum.plus(decimal(row.amount) ?? 0), new Decimal(0))
const capacity = (plan: OperatorPlanSummary, recipientId: string, original?: OperatorRefuelling) => new Decimal(plan.recipients.find(item => item.id === recipientId)?.remaining ?? 0).plus(original?.schemaVersion === 3 && original.planId === plan.id ? original.allocations.filter(item => item.kind === 'recipient' && item.recipientId === recipientId).reduce((sum, item) => sum.plus(item.amount), new Decimal(0)) : 0)
export const allocationFromRow = (row?: OperatorRefuelling): AllocationDraft[] => row?.schemaVersion === 3 ? row.allocations.map(item => item.kind === 'recipient' ? { kind: 'recipient', recipientId: item.recipientId, amount: item.amount } : { kind: 'manager', managerId: item.managerId, amount: item.amount }) : []

/** Suggestions follow the operation amount; an amount the operator typed is always preserved. */
export function resolveAllocationSuggestions(rows: AllocationDraft[], plan: OperatorPlanSummary | undefined, amount: string, original?: OperatorRefuelling): AllocationDraft[] {
  if (!plan) return rows
  let remaining = Decimal.max(0, (decimal(amount) ?? new Decimal(0)).minus(total(rows.filter(row => !row.automatic))))
  return rows.map(row => {
    if (!row.automatic) return row
    const suggested = row.kind === 'recipient' ? Decimal.min(remaining, capacity(plan, row.recipientId, original)) : remaining
    remaining = Decimal.max(0, remaining.minus(suggested))
    return { ...row, amount: suggested.greaterThan(0) ? suggested.toFixed(2) : '' }
  })
}

export function allocationError(plan: OperatorPlanSummary | undefined, rows: AllocationDraft[], amount: string, original?: OperatorRefuelling) {
  if (!plan) return 'Выберите активное задание.'
  const money = decimal(amount)
  if (!money?.greaterThan(0)) return 'Укажите сумму операции больше нуля.'
  if (!rows.length) return 'Добавьте получателя и распределите сумму операции.'
  if (total(rows).greaterThan(money)) return `Распределение превышает сумму операции на ${display(total(rows).minus(money).toFixed(2), true)} ₽. Уменьшите суммы получателям.`
  const ids = new Set<string>()
  for (const row of rows) {
    if (!decimal(row.amount)?.greaterThan(0)) return 'Укажите положительную сумму для каждого получателя.'
    if (row.kind === 'recipient') {
      if (!row.recipientId || !plan.recipients.some(item => item.id === row.recipientId)) return 'Выберите получателя из задания.'
      if (ids.has(row.recipientId)) return 'Один получатель должен быть указан один раз.'
      ids.add(row.recipientId)
      if (decimal(row.amount)!.greaterThan(capacity(plan, row.recipientId, original))) return 'Сумма получателю превышает его доступный остаток.'
    } else if (!row.managerId) return 'Выберите менеджера для остатка: Айдар или Эльдар.'
  }
  if (!rows.some(row => row.kind === 'recipient')) return 'Добавьте получателя из задания.'
  if (rows.filter(row => row.kind === 'manager').length > 1) return 'Остаток можно передать одному менеджеру.'
  if (rows.some(row => row.kind === 'manager') && plan.recipients.some(recipient => !capacity(plan, recipient.id, original).equals(total(rows.filter(row => row.kind === 'recipient' && row.recipientId === recipient.id))))) return 'Сначала распределите доступные остатки всех получателей задания.'
  if (!total(rows).equals(money)) return `Осталось распределить ${display(money.minus(total(rows)).toFixed(2), true)} ₽ из суммы операции.`
  return ''
}

export function PlanCards({ plans, onSelect, onEdit }: { plans: OperatorPlanSummary[]; onSelect: (id: string) => void; onEdit: (plan: OperatorPlanSummary) => void }) {
  const [detailsId, setDetailsId] = useState('')
  const selected = plans.find(plan => plan.id === detailsId)
  if (!plans.length) return <div className="empty-state operator-plan-empty"><strong>Заданий в этом списке пока нет</strong><span>Создайте задание кнопкой «+»: укажите клиента, реквизиты и лимит каждого получателя.</span></div>
  return <><div className="operator-plan-cards operator-card-grid">{plans.map(plan => <article key={plan.id} className="operator-plan-card operator-card">
    <header><div><h3>{plan.clientName}</h3><span className="operator-plan-date">{planDate(plan.createdAt)}</span></div><div className="operator-card-state"><span className={`operator-status ${plan.status === 'completed' ? 'is-paid' : ''}`}>{plan.status === 'completed' ? 'Выполнено' : 'Активно'}</span><OperatorDetailsButton label={`Подробности задания ${plan.clientName}`} onClick={() => setDetailsId(plan.id)}/></div></header>
    <PlanTotals plan={plan}/>
  </article>)}</div>
  {selected && <OperatorDetailsDrawer title="Приём оплаты" onClose={() => setDetailsId('')}>{navigate => <>
    <section><h3>{selected.clientName}</h3><span className={`operator-status ${selected.status === 'completed' ? 'is-paid' : ''}`}>{selected.status === 'completed' ? 'Выполнено' : 'Активно'}</span></section>
    <PlanTotals plan={selected}/>
    <dl className="operator-details-meta"><div><dt>Кем оформлено</dt><dd>{selected.createdByName || 'Пользователь CRM'}</dd></div><div><dt>Дата оформления</dt><dd>{planDate(selected.createdAt)}</dd></div></dl>
    <section className="operator-plan-details"><h3>Реквизиты и лимиты</h3><ul>{selected.recipients.map(recipient => <li key={recipient.id}>
      <div className="operator-recipient-heading"><strong>{recipient.name}</strong><span>{recipient.bank}</span></div>
      <dl className="operator-recipient-requisites">
        {operatorRequisitesText(recipient) && <div><dt>Карта / счёт / телефон</dt><dd>{operatorRequisitesText(recipient)}</dd></div>}
      </dl>
      <dl className="operator-recipient-balances"><div><dt>Лимит</dt><dd>{display(recipient.limit, true)} ₽</dd></div><div><dt>Распределено</dt><dd>{display(recipient.used, true)} ₽</dd></div><div><dt>Осталось</dt><dd>{display(recipient.remaining, true)} ₽</dd></div></dl>
    </li>)}</ul></section>
    <footer className="operator-details-actions"><button type="button" className="button" aria-label={`Редактировать задание ${selected.clientName}`} onClick={() => navigate(() => onEdit(selected))}><Pencil size={16} aria-hidden="true"/>Изменить</button><button type="button" className="button" onClick={() => navigate(() => onSelect(selected.id))}>Операции<ArrowRight size={16} aria-hidden="true"/></button></footer>
  </>}</OperatorDetailsDrawer>}
  </>
}

function PlanTotals({ plan }: { plan: OperatorPlanSummary }) {
  return <div className="operator-plan-totals"><span>Общий лимит<strong>{display(plan.totalLimit, true)} ₽</strong></span><span>Распределено<strong>{display(plan.allocated, true)} ₽</strong></span><span className="operator-plan-remaining">Остаток<strong>{display(plan.remaining, true)} ₽</strong></span></div>
}

export function AllocationEditor({ plan, allocations, onChange, amount, original }: { plan?: OperatorPlanSummary; allocations: AllocationDraft[]; onChange: (rows: AllocationDraft[]) => void; amount: string; original?: OperatorRefuelling }) {
  if (!plan) return <p className="operator-full muted">После выбора задания здесь появятся получатели и доступные остатки.</p>
  const money = decimal(amount) ?? new Decimal(0), assigned = total(allocations), unassigned = money.minus(assigned)
  const available = plan.recipients.filter(recipient => capacity(plan, recipient.id, original).greaterThan(0))
  const freeRecipients = available.filter(recipient => !allocations.some(row => row.kind === 'recipient' && row.recipientId === recipient.id))
  const exhausted = plan.recipients.every(recipient => capacity(plan, recipient.id, original).equals(total(allocations.filter(row => row.kind === 'recipient' && row.recipientId === recipient.id))))
  const hasManager = allocations.some(row => row.kind === 'manager')
  const change = (index: number, item: AllocationDraft) => onChange(allocations.map((row, i) => i === index ? item : row))
  const problem = allocationError(plan, allocations, amount, original)
  return <section className="operator-full operator-allocation-editor" aria-label="Распределение суммы">
    <div className="operator-allocation-heading"><h3>Распределение суммы</h3><strong>{display(money.toFixed(2), true)} ₽</strong></div>
    <p className="muted">Распределите сумму операции между получателями. Сумма каждому получателю ограничена его доступным остатком.</p>
    {allocations.map((row, index) => <div className={`operator-allocation-row ${row.kind === 'manager' ? 'is-manager' : ''}`} key={index}>
      {row.kind === 'recipient' ? <label>Получатель {index + 1}<select aria-label={`Получатель ${index + 1}`} required value={row.recipientId} onChange={event => {
        change(index, { ...row, recipientId: event.target.value, automatic: row.automatic ?? !row.amount })
      }}><option value="">Выберите получателя</option>{row.recipientId && !available.some(recipient => recipient.id === row.recipientId) && <option value={row.recipientId} disabled>{plan.recipients.find(recipient => recipient.id === row.recipientId)?.name ?? 'Прежний получатель'} · остаток исчерпан</option>}{available.filter(recipient => recipient.id === row.recipientId || !allocations.some(other => other.kind === 'recipient' && other.recipientId === recipient.id)).map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name} · {recipient.bank}{recipient.card || recipient.phone ? ` · …${(recipient.card || recipient.phone).replace(/\s/g, '').slice(-4)}` : ''}</option>)}</select></label> : <label>Менеджер для остатка<select aria-label="Менеджер для остатка" required value={row.managerId} onChange={event => change(index, { ...row, managerId: event.target.value as Manager })}><option value="">Выберите менеджера</option><option value="aidar">Айдар</option><option value="eldar">Эльдар</option></select></label>}
      <label>{row.kind === 'manager' ? 'Сумма менеджеру, ₽' : `Сумма получателю ${index + 1}, ₽`}<input aria-label={row.kind === 'manager' ? 'Сумма менеджеру, ₽' : `Сумма получателю ${index + 1}, ₽`} required inputMode="decimal" value={row.amount} onChange={event => change(index, { ...row, amount: event.target.value, automatic: false })} /></label>
      <button type="button" className="icon-button" aria-label={`Удалить распределение ${index + 1}`} onClick={() => onChange(allocations.filter((_, i) => i !== index))}><X size={17} /></button>
      {row.kind === 'recipient' && row.recipientId && <p className="operator-full operator-allocation-details">{(() => { const recipient = plan.recipients.find(item => item.id === row.recipientId); return recipient ? `${operatorRequisitesText(recipient)}${recipient.card || recipient.phone ? ' · ' : ''}Доступно: ${display(capacity(plan, recipient.id, original).toFixed(2), true)} ₽${row.automatic ? ' · Сумма подставлена автоматически' : ''}` : '' })()}</p>}
    </div>)}
    <div className="operator-actions"><button type="button" className="button" disabled={!freeRecipients.length || allocations.some(row => row.kind === 'recipient' && !row.recipientId)} onClick={() => onChange([...allocations, { kind: 'recipient', recipientId: '', amount: '', automatic: true }])}><Plus size={16} />Добавить получателя</button>
      <button type="button" className="button" disabled={hasManager || !exhausted || !unassigned.greaterThan(0)} onClick={() => onChange([...allocations, { kind: 'manager', managerId: '', amount: unassigned.toFixed(2), automatic: true }])}>Передать остаток менеджеру</button></div>
    {!hasManager && !exhausted && money.greaterThan(total(plan.recipients.map(recipient => ({ kind: 'recipient' as const, recipientId: recipient.id, amount: capacity(plan, recipient.id, original).toFixed(2) })))) && <p className="muted operator-allocation-hint">Передать остаток Айдару или Эльдару можно после распределения всех доступных лимитов задания.</p>}
    <div className={`operator-distribution-total ${unassigned.isNegative() ? 'has-error' : ''}`} role="status"><span>Распределено<strong>{display(assigned.toFixed(2), true)} ₽</strong></span><span>{unassigned.isNegative() ? 'Сверх суммы операции' : 'Осталось распределить'}<strong>{display(unassigned.abs().toFixed(2), true)} ₽</strong></span></div>
    {problem && allocations.length > 0 && <p className="operator-allocation-hint" role="status">{problem}</p>}
    {!problem && <p className="operator-feedback">{exhausted ? 'Сумма распределена полностью. После сохранения задание перейдёт в выполненные.' : 'Сумма распределена полностью. Остатки получателей уменьшатся после сохранения.'}</p>}
  </section>
}

const newRecipient = () => operatorRequisitesDraft({ id: crypto.randomUUID(), name: '', bank: '', card: '', phone: '', details: '', limit: '' })
const recipientFields = (plan?: OperatorPlanSummary) => plan?.recipients.map(({ id, name, bank, card, phone, details, limit }) => operatorRequisitesDraft({ id, name, bank, card, phone, details, limit })) ?? [newRecipient()]
export function PlanEditor({ plan: initialPlan, workspace, creatorName, onClose, onSaved }: { plan?: OperatorPlanSummary; workspace: OperatorWorkspace; creatorName: string; onClose: () => void; onSaved: (data: OperatorWorkspace) => void }) {
  const [plan, setPlan] = useState(initialPlan), [catalog, setCatalog] = useState(workspace), [stale, setStale] = useState(false)
  const [clientName, setClientName] = useState(plan?.clientName ?? '')
  const [recipients, setRecipients] = useState(() => recipientFields(plan)), [error, setError] = useState(''), [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false), [discard, setDiscard] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), pending = useRef<string | null>(null)
  const original = useRef(JSON.stringify({ clientName, recipients })), dirty = JSON.stringify({ clientName, recipients }) !== original.current
  const hasOperations = !!plan && catalog.refuellings.some(row => row.schemaVersion === 3 && row.planId === plan.id)
  const hasOverflow = !!plan && catalog.refuellings.some(row => row.schemaVersion === 3 && row.planId === plan.id && row.allocations.some(item => item.kind === 'manager'))
  const usedRecipient = (id: string) => !!plan?.recipients.some(item => item.id === id && new Decimal(item.used).greaterThan(0))
  const { close, complete } = useDialogMotion(dialog, onClose)
  const dismiss = () => { if (lock.current) return; if (uncertain) { setError('Проверьте сохранение тем же запросом, прежде чем закрыть форму.'); return } if (dirty) setDiscard(true); else close() }
  useEffect(() => {
    if (!dirty && !uncertain) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, uncertain])
  const refreshPlan = async () => {
    if (lock.current || uncertain || !plan) return
    lock.current = true; setSaving(true)
    try {
      const next = await readWorkspace(), latest = next.plans.find(item => item.id === plan.id)
      if (!latest) throw new Error('Задание не найдено. Закройте форму и обновите список.')
      const freshRecipients = recipientFields(latest)
      original.current = JSON.stringify({ clientName: latest.clientName, recipients: freshRecipients })
      setPlan(latest); setCatalog(next); setClientName(latest.clientName); setRecipients(freshRecipients)
      setStale(false); setError('Загружена актуальная версия задания. Можно внести изменения заново.')
    } catch (error) { setError((error as Error).message || 'Не удалось обновить задание. Ваш ввод сохранён.') }
    finally { lock.current = false; setSaving(false) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current) return
    if (!pending.current) {
      const requisitesError = recipients.map(recipient => operatorRequisitesError(recipient, recipient.requisites)).find(Boolean)
      if (requisitesError) { setError(requisitesError); return }
      pending.current = JSON.stringify({ clientName, recipients: recipients.map(operatorRequisitesPayload), ...(plan ? { version: plan.version } : {}), idempotencyKey: crypto.randomUUID() })
    }
    lock.current = true; setSaving(true); setError(''); setStale(false)
    try {
      const response = await apiFetch(`/api/operator/plans${plan ? `/${plan.id}` : ''}`, { method: plan ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: pending.current, signal: AbortSignal.timeout(20000) })
      const result = await response.json()
      if (!response.ok) { if (response.status === 409 && !uncertain) setStale(true); if (isDefinitiveOperatorRejection(response.status, result.error, uncertain)) { pending.current = null; setUncertain(false) } else setUncertain(true); setError(result.error || 'Сохранение не подтверждено.'); return }
      setUncertain(true)
      const next = await readWorkspace()
      if (!next.plans.some(item => item.id === result.id)) throw new Error('Задание пока не найдено.')
      pending.current = null; setUncertain(false); await complete(() => onSaved(next))
    } catch { setUncertain(true); setError('Ответ не получен или повторное чтение не удалось. Проверьте сохранение тем же запросом.') }
    finally { lock.current = false; setSaving(false) }
  }
  return <dialog ref={dialog} className="operator-dialog operator-plan-dialog" aria-labelledby="operator-plan-title" onCancel={event => { event.preventDefault(); dismiss() }}><form onSubmit={event => void submit(event)}>
    <header><h2 id="operator-plan-title">{plan ? 'Редактирование задания' : 'Новое задание'}</h2><button type="button" className="icon-button" disabled={saving} aria-label="Закрыть форму" onClick={dismiss}><X size={20} /></button></header>
    <div className="operator-dialog-body">
    {error && <p className="soft-notice" role="alert">{error}</p>}
    {stale && !uncertain && <div className="operator-edit-conflict"><p>Можно загрузить актуальную версию задания. Это заменит несохранённые изменения в форме.</p><button type="button" className="button" disabled={saving} onClick={() => void refreshPlan()}>Загрузить актуальное задание</button></div>}
    {discard ? <div className="operator-discard"><p>Закрыть форму без сохранения?</p><div className="operator-actions"><button type="button" className="button" onClick={() => setDiscard(false)}>Продолжить ввод</button><button type="button" className="button" onClick={close}>Не сохранять</button></div></div> : <>
      <fieldset className="operator-form-grid" disabled={saving || uncertain}>
        <label className="operator-full">Клиент<input aria-label="Клиент" required readOnly={hasOperations} maxLength={500} value={clientName} placeholder="Например, ООО Метр" onChange={event => setClientName(event.target.value)} /></label>
        <p className="operator-full operator-plan-author">Создатель: <strong>{plan ? plan.createdByName || 'Пользователь CRM' : creatorName}</strong></p>
        {hasOperations && <p className="operator-full operator-edit-note">По заданию уже есть операции. Клиент и использованные реквизиты сохранены для истории; лимит не может быть меньше распределённой суммы.{hasOverflow ? ' Остаток передан менеджеру, поэтому лимиты этого задания уже зафиксированы.' : ''}</p>}
        <div className="operator-full operator-plan-recipient-list">{recipients.map((recipient, index) => <section className="operator-plan-recipient" key={recipient.id} aria-label={`Реквизиты получателя ${index + 1}`}><header><h3>Получатель {index + 1}</h3>{recipients.length > 1 && !usedRecipient(recipient.id) && !hasOverflow && <button type="button" className="icon-button" aria-label={`Удалить получателя ${index + 1}`} onClick={() => setRecipients(recipients.filter(item => item.id !== recipient.id))}><X size={17} /></button>}</header><div className="operator-form-grid">
          {([['name', 'Имя получателя'], ['bank', 'Банк']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={`${label} ${index + 1}`} required readOnly={usedRecipient(recipient.id)} maxLength={500} value={recipient[key]} onChange={event => setRecipients(recipients.map(item => item.id === recipient.id ? { ...item, [key]: event.target.value } : item))} /></label>)}
          <label>Карта / счёт / телефон<input type="text" aria-label={`Карта / счёт / телефон ${index + 1}`} readOnly={usedRecipient(recipient.id)} maxLength={Math.max(500, operatorRequisitesInputText(recipient).length)} value={recipient.requisites} aria-invalid={!!operatorRequisitesError(recipient, recipient.requisites)} aria-describedby={operatorRequisitesError(recipient, recipient.requisites) ? `operator-requisites-error-${recipient.id}` : undefined} onChange={event => setRecipients(recipients.map(item => item.id === recipient.id ? { ...item, requisites: event.target.value } : item))} />{operatorRequisitesError(recipient, recipient.requisites) && <span id={`operator-requisites-error-${recipient.id}`} role="status">{operatorRequisitesError(recipient, recipient.requisites)}</span>}</label>
          <label>Лимит, ₽<input aria-label={`Лимит, ₽ ${index + 1}`} required readOnly={hasOverflow} inputMode="decimal" maxLength={500} value={recipient.limit} onChange={event => setRecipients(recipients.map(item => item.id === recipient.id ? { ...item, limit: event.target.value } : item))} /></label>
        </div>{usedRecipient(recipient.id) && <p className="operator-edit-note">Уже распределено: {display(plan!.recipients.find(item => item.id === recipient.id)!.used, true)} ₽</p>}</section>)}</div>
        <button type="button" className="button operator-full" disabled={recipients.length >= 50 || hasOverflow} onClick={() => setRecipients([...recipients, newRecipient()])}><Plus size={16} />Добавить реквизиты</button>
        <p className="operator-full muted operator-form-hint">У каждого получателя свой лимит. Задание завершится, когда все лимиты будут распределены по операциям.</p>
      </fieldset>
    </>}
    </div>
    {!discard && <footer><button type="button" className="button" disabled={saving || uncertain} onClick={dismiss}>Закрыть</button><button type="submit" className="button primary" disabled={saving || !!plan && !dirty && !uncertain}>{saving ? 'Сохраняем…' : uncertain ? 'Проверить сохранение' : 'Сохранить задание'}</button></footer>}
  </form></dialog>
}

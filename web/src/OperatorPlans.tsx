import { useEffect, useRef, useState, type FormEvent } from 'react'
import Decimal from 'decimal.js'
import { Plus, X } from 'lucide-react'
import { apiFetch } from './workspace-api'
import { useDialogMotion } from './useDialogMotion'
import { display, readWorkspace, isDefinitiveOperatorRejection } from './operator-ui-utils'
import type { OperatorPlanSummary, OperatorRefuelling, OperatorWorkspace } from './operator-model'

type Manager = '' | 'aidar' | 'eldar'
export type AllocationDraft = { kind: 'recipient'; recipientId: string; amount: string } | { kind: 'manager'; managerId: Manager; amount: string }
export const planDate = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' }) + ' МСК'
const managerName = (value: string) => value === 'aidar' ? 'Айдар' : 'Эльдар'
const decimal = (value: string) => {
  const cleaned = value.trim().replace(',', '.')
  return /^\d+(?:\.\d{1,2})?$/.test(cleaned) ? new Decimal(cleaned) : null
}
const total = (rows: AllocationDraft[]) => rows.reduce((sum, row) => sum.plus(decimal(row.amount) ?? 0), new Decimal(0))
const capacity = (plan: OperatorPlanSummary, recipientId: string, original?: OperatorRefuelling) => new Decimal(plan.recipients.find(item => item.id === recipientId)?.remaining ?? 0).plus(original?.schemaVersion === 3 && original.planId === plan.id ? original.allocations.filter(item => item.kind === 'recipient' && item.recipientId === recipientId).reduce((sum, item) => sum.plus(item.amount), new Decimal(0)) : 0)
export const allocationFromRow = (row?: OperatorRefuelling): AllocationDraft[] => row?.schemaVersion === 3 ? row.allocations.map(item => item.kind === 'recipient' ? { kind: 'recipient', recipientId: item.recipientId, amount: item.amount } : { kind: 'manager', managerId: item.managerId, amount: item.amount }) : []
export function allocationError(plan: OperatorPlanSummary | undefined, rows: AllocationDraft[], amount: string, original?: OperatorRefuelling) {
  if (!plan) return 'Выберите активное задание.'
  const money = decimal(amount)
  if (!money?.greaterThan(0)) return 'Укажите сумму операции больше нуля.'
  if (!rows.length) return 'Добавьте получателя и распределите сумму операции.'
  const ids = new Set<string>()
  for (const row of rows) {
    if (!decimal(row.amount)?.greaterThan(0)) return 'Укажите положительную сумму для каждого получателя.'
    if (row.kind === 'recipient') {
      if (!row.recipientId || !plan.recipients.some(item => item.id === row.recipientId)) return 'Выберите получателя из задания.'
      if (ids.has(row.recipientId)) return 'Один получатель должен быть указан один раз.'
      ids.add(row.recipientId)
      if (decimal(row.amount)!.greaterThan(capacity(plan, row.recipientId, original))) return 'Сумма получателю превышает доступный остаток.'
    } else if (!row.managerId) return 'Выберите менеджера для остатка: Айдар или Эльдар.'
  }
  if (!rows.some(row => row.kind === 'recipient')) return 'Добавьте получателя из задания.'
  if (rows.filter(row => row.kind === 'manager').length > 1) return 'Остаток можно передать одному менеджеру.'
  if (rows.some(row => row.kind === 'manager') && plan.recipients.some(recipient => !capacity(plan, recipient.id, original).equals(total(rows.filter(row => row.kind === 'recipient' && row.recipientId === recipient.id))))) return 'Сначала распределите доступные остатки всех получателей задания.'
  if (!total(rows).equals(money)) return 'Распределите сумму операции полностью.'
  return ''
}

export function PlanCards({ plans, selectedId, onSelect }: { plans: OperatorPlanSummary[]; selectedId: string; onSelect: (id: string) => void }) {
  if (!plans.length) return <div className="empty-state operator-plan-empty"><strong>Заданий в этом списке пока нет</strong><span>Менеджер указывает клиента, получателей и их лимиты во вкладке «Задания».</span></div>
  return <div className="operator-plan-cards">{plans.map(plan => <article key={plan.id} className={`operator-plan-card ${selectedId === plan.id ? 'is-selected' : ''}`}>
    <header><div><h3>{plan.clientName}</h3><span>Менеджер: {managerName(plan.managerId)}</span><span className="operator-plan-date">{planDate(plan.createdAt)}</span></div><span className={`operator-status ${plan.status === 'completed' ? 'is-paid' : ''}`}>{plan.status === 'completed' ? 'Выполнено' : 'Активно'}</span></header>
    <div className="operator-plan-totals"><span>Лимит<strong>{display(plan.totalLimit, true)} ₽</strong></span><span>Распределено<strong>{display(plan.allocated, true)} ₽</strong></span><span>Остаток<strong>{display(plan.remaining, true)} ₽</strong></span></div>
    <details><summary>Получатели · {plan.recipients.length}</summary><ul>{plan.recipients.map(recipient => <li key={recipient.id}><strong>{recipient.name} · {recipient.bank}</strong><span>{[recipient.card, recipient.phone, recipient.details].filter(Boolean).join(' · ')}</span><span>Остаток {display(recipient.remaining, true)} ₽ из {display(recipient.limit, true)} ₽</span></li>)}</ul></details>
    <button className="button" aria-pressed={selectedId === plan.id} onClick={() => onSelect(plan.id)}>{selectedId === plan.id ? 'Выбрано' : 'Открыть операции'}</button>
  </article>)}</div>
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
    <h3>Распределение суммы</h3>
    <p className="muted">Укажите сумму каждому получателю. Остатки задания уменьшатся после сохранения операции.</p>
    {allocations.map((row, index) => <div className={`operator-allocation-row ${row.kind === 'manager' ? 'is-manager' : ''}`} key={index}>
      {row.kind === 'recipient' ? <label>Получатель {index + 1}<select aria-label={`Получатель ${index + 1}`} required value={row.recipientId} onChange={event => {
        const recipientId = event.target.value
        const suggestion = Decimal.max(0, Decimal.min(capacity(plan, recipientId, original), money.minus(total(allocations.filter((_, i) => i !== index)))))
        change(index, { ...row, recipientId, amount: row.amount || (suggestion.greaterThan(0) ? suggestion.toFixed(2) : '') })
      }}><option value="">Выберите получателя</option>{row.recipientId && !available.some(recipient => recipient.id === row.recipientId) && <option value={row.recipientId} disabled>{plan.recipients.find(recipient => recipient.id === row.recipientId)?.name ?? 'Прежний получатель'} · остаток исчерпан</option>}{available.filter(recipient => recipient.id === row.recipientId || !allocations.some(other => other.kind === 'recipient' && other.recipientId === recipient.id)).map(recipient => <option key={recipient.id} value={recipient.id}>{recipient.name} · {recipient.bank}{recipient.card || recipient.phone ? ` · …${(recipient.card || recipient.phone).replace(/\s/g, '').slice(-4)}` : recipient.details ? ` · ${recipient.details.slice(0, 24)}` : ''} · {display(capacity(plan, recipient.id, original).toFixed(2), true)} ₽</option>)}</select></label> : <label>Менеджер для остатка<select aria-label="Менеджер для остатка" required value={row.managerId} onChange={event => change(index, { ...row, managerId: event.target.value as Manager })}><option value="">Выберите менеджера</option><option value="aidar">Айдар</option><option value="eldar">Эльдар</option></select></label>}
      <label>{row.kind === 'manager' ? 'Сумма менеджеру, ₽' : `Сумма получателю ${index + 1}, ₽`}<input aria-label={row.kind === 'manager' ? 'Сумма менеджеру, ₽' : `Сумма получателю ${index + 1}, ₽`} required inputMode="decimal" value={row.amount} onChange={event => change(index, { ...row, amount: event.target.value })} /></label>
      <button type="button" className="icon-button" aria-label={`Удалить распределение ${index + 1}`} onClick={() => onChange(allocations.filter((_, i) => i !== index))}><X size={17} /></button>
      {row.kind === 'recipient' && row.recipientId && <p className="operator-full operator-allocation-details">{(() => { const recipient = plan.recipients.find(item => item.id === row.recipientId); return recipient ? `${[recipient.card, recipient.phone, recipient.details].filter(Boolean).join(' · ')}${recipient.card || recipient.phone || recipient.details ? ' · ' : ''}Доступно: ${display(capacity(plan, recipient.id, original).toFixed(2), true)} ₽` : '' })()}</p>}
    </div>)}
    <div className="operator-actions"><button type="button" className="button" disabled={!freeRecipients.length || allocations.some(row => row.kind === 'recipient' && !row.recipientId)} onClick={() => onChange([...allocations, { kind: 'recipient', recipientId: '', amount: '' }])}><Plus size={16} />Добавить получателя</button>
      <button type="button" className="button" disabled={hasManager || !exhausted || !unassigned.greaterThan(0)} onClick={() => onChange([...allocations, { kind: 'manager', managerId: '', amount: unassigned.toFixed(2) }])}>Передать остаток менеджеру</button></div>
    {!hasManager && !exhausted && <p className="muted operator-allocation-hint">Передать остаток Айдару или Эльдару можно после распределения всех доступных лимитов задания.</p>}
    <div className="operator-distribution-total" role="status"><span>Распределено: <strong>{display(assigned.toFixed(2), true)} ₽</strong></span><span>{unassigned.isNegative() ? 'Превышение' : 'Не распределено'}: <strong>{display(unassigned.abs().toFixed(2), true)} ₽</strong></span></div>
    {problem && allocations.length > 0 && <p className="operator-allocation-hint" role="status">{problem}</p>}
    {!problem && exhausted && <p className="operator-feedback">После сохранения задание перейдёт в выполненные.</p>}
  </section>
}

const newRecipient = () => ({ id: crypto.randomUUID(), name: '', bank: '', card: '', phone: '', details: '', limit: '' })
export function PlanEditor({ onClose, onSaved }: { onClose: () => void; onSaved: (data: OperatorWorkspace) => void }) {
  const [clientName, setClientName] = useState(''), [managerId, setManagerId] = useState<Manager>('')
  const [recipients, setRecipients] = useState([newRecipient()]), [error, setError] = useState(''), [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false), [discard, setDiscard] = useState(false)
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), pending = useRef<string | null>(null)
  const original = useRef(JSON.stringify(recipients)), dirty = !!clientName || !!managerId || JSON.stringify(recipients) !== original.current
  const { close, complete } = useDialogMotion(dialog, onClose)
  const dismiss = () => { if (lock.current) return; if (uncertain) { setError('Проверьте сохранение тем же запросом, прежде чем закрыть форму.'); return } if (dirty) setDiscard(true); else close() }
  useEffect(() => {
    if (!dirty && !uncertain) return
    const handler = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', handler); return () => window.removeEventListener('beforeunload', handler)
  }, [dirty, uncertain])
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current) return
    if (!pending.current) pending.current = JSON.stringify({ clientName, managerId, recipients, idempotencyKey: crypto.randomUUID() })
    lock.current = true; setSaving(true); setError('')
    try {
      const response = await apiFetch('/api/operator/plans', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: pending.current, signal: AbortSignal.timeout(20000) })
      const result = await response.json()
      if (!response.ok) { if (isDefinitiveOperatorRejection(response.status, result.error, uncertain)) { pending.current = null; setUncertain(false) } else setUncertain(true); setError(result.error || 'Сохранение не подтверждено.'); return }
      setUncertain(true)
      const next = await readWorkspace()
      if (!next.plans.some(plan => plan.id === result.id)) throw new Error('Задание пока не найдено.')
      pending.current = null; setUncertain(false); await complete(() => onSaved(next))
    } catch { setUncertain(true); setError('Ответ не получен или повторное чтение не удалось. Проверьте сохранение тем же запросом.') }
    finally { lock.current = false; setSaving(false) }
  }
  return <dialog ref={dialog} className="operator-dialog operator-plan-dialog" aria-labelledby="operator-plan-title" onCancel={event => { event.preventDefault(); dismiss() }}><form onSubmit={event => void submit(event)}>
    <header><h2 id="operator-plan-title">Новое задание</h2><button type="button" className="icon-button" disabled={saving} aria-label="Закрыть форму" onClick={dismiss}><X size={20} /></button></header>
    {error && <p className="soft-notice" role="alert">{error}</p>}
    {discard ? <div><p>Закрыть форму без сохранения?</p><div className="operator-actions"><button type="button" className="button" onClick={() => setDiscard(false)}>Продолжить ввод</button><button type="button" className="button" onClick={close}>Не сохранять</button></div></div> : <>
      <fieldset className="operator-form-grid" disabled={saving || uncertain}>
        <label>Клиент<input aria-label="Клиент" required maxLength={500} value={clientName} placeholder="Например, ООО Метр" onChange={event => setClientName(event.target.value)} /></label>
        <label>Менеджер задания<select aria-label="Менеджер задания" required value={managerId} onChange={event => setManagerId(event.target.value as Manager)}><option value="">Выберите менеджера</option><option value="aidar">Айдар</option><option value="eldar">Эльдар</option></select></label>
        <div className="operator-full operator-plan-recipient-list">{recipients.map((recipient, index) => <section className="operator-plan-recipient" key={recipient.id} aria-label={`Реквизиты получателя ${index + 1}`}><header><h3>Получатель {index + 1}</h3>{recipients.length > 1 && <button type="button" className="icon-button" aria-label={`Удалить получателя ${index + 1}`} onClick={() => setRecipients(recipients.filter(item => item.id !== recipient.id))}><X size={17} /></button>}</header><div className="operator-form-grid">
          {([['name', 'Имя получателя'], ['bank', 'Банк'], ['card', 'Номер карты / счёта'], ['phone', 'Телефон'], ['details', 'Дополнительные реквизиты'], ['limit', 'Лимит, ₽']] as const).map(([key, label]) => <label key={key}>{label}<input aria-label={`${label} ${index + 1}`} required={['name', 'bank', 'limit'].includes(key)} inputMode={key === 'limit' ? 'decimal' : undefined} maxLength={key === 'details' ? 2000 : 500} value={recipient[key]} onChange={event => setRecipients(recipients.map(item => item.id === recipient.id ? { ...item, [key]: event.target.value } : item))} /></label>)}
        </div></section>)}</div>
        <button type="button" className="button operator-full" disabled={recipients.length >= 50} onClick={() => setRecipients([...recipients, newRecipient()])}><Plus size={16} />Добавить реквизиты</button>
        <p className="operator-full muted">У каждого получателя свой лимит. Задание завершится, когда все лимиты будут распределены по операциям.</p>
      </fieldset>
      <footer><button type="button" className="button" disabled={saving || uncertain} onClick={dismiss}>Закрыть</button><button type="submit" className="button primary" disabled={saving}>{saving ? 'Сохраняем…' : uncertain ? 'Проверить сохранение' : 'Сохранить задание'}</button></footer>
    </>}
  </form></dialog>
}

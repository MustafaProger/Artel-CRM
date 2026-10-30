import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import Decimal from 'decimal.js'
import { ArrowUpRight, CalendarDays, Check, ChevronDown, Fuel, Pencil, RotateCcw, X } from 'lucide-react'
import type { OperatorCaseKind, OperatorCaseSource, OperatorCaseSummary } from './operator-case-model'
import type { OperatorRefuelling, OperatorWorkspace } from './operator-model'
import { apiFetch } from './workspace-api'
import { display, isDefinitiveOperatorRejection, readWorkspace } from './operator-ui-utils'
import { useDialogMotion } from './useDialogMotion'
import OperatorServiceBadge from './OperatorServiceBadge'
import './operator-cases.css'
import './operator-cards.css'
import OperatorDetailsDrawer, { OperatorDetailsButton } from './OperatorDetailsDrawer'

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP })
const calendarDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('.') : value
const timestamp = (value: string) => new Date(value).toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) + ' МСК'
const quantity = (value: string) => {
  const text = value.trim().replace(',', '.')
  return text.length <= 40 && /^\d+(?:\.\d{1,6})?$/.test(text) && new D(text).gt(0) && new D(text).lte('1000000000000') ? new D(text) : null
}
const valueOf = (source: Pick<OperatorCaseSource, 'pricePerLitre' | 'discountPercent'>, litres: Decimal) => litres.times(source.pricePerLitre).times(new D(1).minus(new D(source.discountPercent).div(100))).toFixed(2)

export const operatorToday = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export const caseTaskDate = (entry: OperatorCaseSummary) => !entry.task ? '' : entry.task.dueDate === operatorToday() ? 'На сегодня' : `${entry.status === 'open' && entry.task.dueDate < operatorToday() ? 'Просрочено · ' : ''}${calendarDate(entry.task.dueDate)}`

export type CaseCardActions = {
  onSettle: (entry: OperatorCaseSummary, method: 'money' | 'fuel') => void
  onViewSource: (operationId: string) => void
  onTask: (entry: OperatorCaseSummary) => void
  operations?: OperatorRefuelling[]
}

export function CaseCards({ operations = [], entries, onSettle, onViewSource, onTask, focusedId = '', taskView = false }: CaseCardActions & { entries: OperatorCaseSummary[]; focusedId?: string; taskView?: boolean }) {
  const [detailsId, setDetailsId] = useState('')
  const selected = entries.find(entry => entry.id === detailsId)
  useEffect(() => {
    if (focusedId) document.getElementById(`operator-case-${focusedId}`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [focusedId])
  return <><div className="operator-case-cards operator-card-grid">{entries.map(entry => <article id={`operator-case-${entry.id}`} className={`operator-case-card operator-card${focusedId === entry.id ? ' is-focused' : ''}`} tabIndex={-1} key={entry.id}>
    <header><div>{taskView && <span className="operator-case-kind">{entry.kind === 'return' ? 'Возврат водителю' : 'Заправка из остатка'}</span>}<h3>{entry.source.driverName}</h3><span>Заправка от {calendarDate(entry.source.date)}</span></div><div className="operator-card-state"><OperatorDetailsButton label={`Подробности: ${entry.source.driverName}`} onClick={() => setDetailsId(entry.id)}/></div></header>
    <div className={`operator-case-deadline${entry.status === 'open' && entry.task && entry.task.dueDate < operatorToday() ? ' is-overdue' : ''}`}>{entry.status === 'completed' ? <><Check size={14} aria-hidden="true"/>Выполнено</> : entry.task ? <><CalendarDays size={14} aria-hidden="true"/><time dateTime={entry.task.dueDate}>{caseTaskDate(entry)}</time></> : 'Срок не назначен'}</div>
    <OperatorServiceBadge service={entry.source.service} serviceId={operations.find(row => row.id === entry.operationId && row.schemaVersion !== undefined)?.schemaVersion !== undefined ? (operations.find(row => row.id === entry.operationId) as import('./operator-model').OperatorRefuellingV2).serviceId : undefined} discountPercent={entry.source.discountPercent}/>
    <CaseTotals entry={entry}/><p className="operator-case-price">Цена за литр: <strong>{display(entry.source.pricePerLitre, true)} ₽</strong></p>
    {entry.status === 'open' && <footer className="operator-card-actions">
      {entry.kind === 'return' && <button type="button" className="button operator-return-action" aria-label="Вернуть деньги" title="Вернуть деньги водителю" onClick={event => { event.currentTarget.focus({ preventScroll: true }); onSettle(entry, 'money') }}><RotateCcw size={15} aria-hidden="true"/>Возврат</button>}
      <button type="button" className="button operator-fuel-action" aria-label="Отметить заправку" title="Отметить выполненную заправку" onClick={event => { event.currentTarget.focus({ preventScroll: true }); onSettle(entry, 'fuel') }}><Fuel size={15} aria-hidden="true"/>Заправка</button>
    </footer>}
  </article>)}</div>
  {selected && <CaseDetails operation={operations.find(row => row.id === selected.operationId)} entry={selected} onClose={() => setDetailsId('')} onTask={onTask} onViewSource={onViewSource}/>}
  </>
}

function CaseTotals({ entry }: { entry: OperatorCaseSummary }) {
  return <dl className="operator-case-totals"><div><dt>Осталось литров</dt><dd>{display(entry.remainingLitres)} л</dd></div><div><dt>Сумма остатка</dt><dd>{display(entry.remainingAmount, true)} ₽</dd></div></dl>
}

function CaseDetails({ operation, entry, onClose, onTask, onViewSource }: Pick<CaseCardActions, 'onTask' | 'onViewSource'> & { operation?: OperatorRefuelling; entry: OperatorCaseSummary; onClose: () => void }) {
  return <OperatorDetailsDrawer title={entry.kind === 'return' ? 'Возврат водителю' : 'Заправка из остатка'} onClose={onClose}>{navigate => <>
    <section><h3>{entry.source.driverName}</h3><p>Заправка от {calendarDate(entry.source.date)} · {entry.status === 'completed' ? 'Выполнено' : 'Открыто'}</p></section>
    <OperatorServiceBadge service={entry.source.service} serviceId={operation?.schemaVersion !== undefined ? operation.serviceId : undefined} discountPercent={entry.source.discountPercent}/>
    <CaseTotals entry={entry}/>
    <dl className="operator-source-details">
      <div><dt>Цена за литр</dt><dd>{display(entry.source.pricePerLitre, true)} ₽</dd></div>
      <div><dt>Исходный литраж</dt><dd>{display(entry.source.litres)} л</dd></div>
      <div><dt>Сумма операции</dt><dd>{display(entry.source.amount, true)} ₽</dd></div>
      {operation?.schemaVersion !== undefined && operation?.groupName && <div><dt>Группа</dt><dd>{operation.groupName}</dd></div>}
      {operation?.schemaVersion === 3 && <div><dt>Клиент / задание</dt><dd>{operation.planClientName}</dd></div>}
      {operation && <div className="operator-source-wide"><dt>Получатели и реквизиты</dt><dd>{operation.schemaVersion !== undefined ? operation.recipientText : [operation.recipient.name, operation.recipient.bank, operation.recipient.card, operation.recipient.phone, operation.recipient.details].filter(Boolean).join(' · ')}</dd></div>}
      {operation?.comment && <div className="operator-source-wide"><dt>Комментарий к операции</dt><dd>{operation.comment}</dd></div>}
    </dl>
    {entry.task && <div className={`operator-case-task${entry.status === 'open' && entry.task.dueDate < operatorToday() ? ' is-overdue' : ''}`}><strong><CalendarDays size={14} aria-hidden="true"/><time dateTime={entry.task.dueDate}>{caseTaskDate(entry)}</time></strong>{entry.task.comment && <p>{entry.task.comment}</p>}<small>Поставил: {entry.task.createdByName || 'Пользователь CRM'}</small>{entry.taskHistory && entry.taskHistory.length > 1 && <small>Изменил: {entry.task.updatedByName} · {timestamp(entry.task.updatedAt)}</small>}</div>}
    <div className="operator-case-origin"><p>Оформлено: {display(entry.litres)} л · {display(entry.amount, true)} ₽</p><p>{entry.kind === 'return' ? 'Создал возврат' : 'Перенёс заправку'}: {entry.createdByName || 'Пользователь CRM'}<br/>{timestamp(entry.createdAt)}</p><button type="button" className="operator-case-source" onClick={event => { event.currentTarget.focus({ preventScroll: true }); navigate(() => onViewSource(entry.operationId)) }}>Исходная операция<ArrowUpRight size={15} aria-hidden="true"/></button></div>
    {entry.settlements.length > 0 && <details className="operator-case-history" open><summary>История исполнения · {entry.settlements.length}<ChevronDown size={17} aria-hidden="true"/></summary><ol>{entry.settlements.map(event => <li key={event.id}><strong>{event.method === 'money' ? 'Деньги возвращены' : event.method === 'carryover' ? 'Зачтено в новой заправке' : 'Заправка выполнена'}</strong><span>{display(event.litres)} л · {display(event.amount, true)} ₽</span><small>{event.actorName} · {timestamp(event.at)}</small>{event.operationId && <button type="button" className="operator-case-source" onClick={click => { click.currentTarget.focus({ preventScroll: true }); navigate(() => onViewSource(event.operationId!)) }}>Операция заправки<ArrowUpRight size={15} aria-hidden="true"/></button>}</li>)}</ol></details>}
    {entry.taskHistory && entry.taskHistory.length > 1 && <details className="operator-case-history" open><summary>История задания<ChevronDown size={17} aria-hidden="true"/></summary><ol>{entry.taskHistory.map(event => <li key={event.id}><strong>На {calendarDate(event.dueDate)}</strong>{event.comment && <span>{event.comment}</span>}<small>{event.actorName} · {timestamp(event.at)}</small></li>)}</ol></details>}
    {entry.status === 'open' && <footer className="operator-details-actions"><button type="button" className="button" aria-label={entry.task ? 'Изменить задание' : 'Поставить задание'} onClick={() => navigate(() => onTask(entry))}><Pencil size={16} aria-hidden="true"/>{entry.task ? 'Изменить задание' : 'Запланировать'}</button></footer>}
  </>}</OperatorDetailsDrawer>
}

export function CaseList({ operations, cases, kind, status, onSettle, onViewSource, onTask, focusedId = '' }: CaseCardActions & {
  cases: OperatorCaseSummary[]; kind: OperatorCaseKind; status: 'open' | 'completed'; focusedId?: string
}) {
  const entries = cases.filter(entry => entry.kind === kind)
  const rows = entries.filter(entry => entry.status === status).sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  return <section className="operator-cases" aria-label={kind === 'return' ? 'Возвраты' : 'Ожидают заправки'}>
    <div className="operator-cases-heading"><h2>{kind === 'return' ? 'Возвраты водителям' : 'Ожидают заправки'}</h2></div>
    {rows.length === 0 ? <div className="operator-cases-empty"><span aria-hidden="true">{kind === 'return' ? <RotateCcw size={24}/> : <Fuel size={24}/>}</span><p>{status === 'completed' ? 'Выполненных записей пока нет.' : kind === 'return' ? 'Открытых возвратов пока нет.' : 'Ожидающих заправки пока нет.'}</p>{status === 'open' && <small>Оформите запись через «Действие» у оплаченной операции. Затем в подробностях карточки можно поставить задание на нужную дату.</small>}</div> : <>
      <CaseCards operations={operations} entries={rows} focusedId={focusedId} onSettle={onSettle} onViewSource={onViewSource} onTask={onTask}/>
    </>}
  </section>
}

export type CaseEditorState =
  | { mode: 'create'; source: OperatorRefuelling; kind: OperatorCaseKind }
  | { mode: 'settle'; entry: OperatorCaseSummary; method: 'money' | 'fuel' }

export function CaseEditor({ editor, workspace, onClose, onSaved }: {
  editor: CaseEditorState
  workspace: OperatorWorkspace
  onClose: () => void
  onSaved: (workspace: OperatorWorkspace, message?: string) => void
}) {
  const [data, setData] = useState(workspace)
  const [source, setSource] = useState(editor.mode === 'create' ? editor.source : null)
  const [entry, setEntry] = useState(editor.mode === 'settle' ? editor.entry : null)
  const [litres, setLitres] = useState(editor.mode === 'settle' && editor.method === 'fuel' ? editor.entry.remainingLitres : '')
  const [transferred, setTransferred] = useState(false)
  const [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false), [stale, setStale] = useState(false), [discard, setDiscard] = useState(false), [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), pending = useRef<string | null>(null)
  const titleId = useId(), volumeId = useId(), previewId = useId()
  const initialLitres = useRef(litres)
  const dirty = litres !== initialLitres.current || transferred
  const { close, complete } = useDialogMotion(dialog, onClose)
  const creating = editor.mode === 'create', money = editor.mode === 'settle' && editor.method === 'money'
  const kind = creating ? editor.kind : entry!.kind
  const fuelInput = !creating && !money, volumeInput = creating && kind === 'return' || fuelInput
  const facts = source ?? entry!.source
  const driverName = source?.name ?? entry!.source.driverName
  const title = creating ? kind === 'return' ? 'Оформить возврат' : 'Заправка позже' : money ? 'Отметить выполненный перевод' : 'Отметить заправку'
  const claimed = source ? data.cases.filter(item => item.operationId === source.id).reduce((sum, item) => sum.plus(item.litres), new D(0)) : new D(0)
  const available = source ? D.max(0, new D(source.litres).minus(claimed)) : new D(entry!.remainingLitres)
  const amountLitres = creating && kind === 'deferred' ? quantity(source!.litres) : money ? quantity(entry!.remainingLitres) : quantity(litres)
  const consumed = entry ? new D(entry.litres).minus(entry.remainingLitres) : new D(0)
  const amount = money ? entry!.remainingAmount : amountLitres ? new D(valueOf(facts, consumed.plus(amountLitres))).minus(valueOf(facts, consumed)).toFixed(2) : null
  const problem = creating && !source!.paid ? 'Сначала подтвердите оплату исходной операции.'
    : !creating && entry!.status !== 'open' ? 'Остаток уже исполнен.'
    : money && kind !== 'return' ? 'Для ожидания заправки отметьте фактическую заправку.'
    : !amountLitres ? 'Укажите положительный литраж, до шести знаков после запятой.'
    : amountLitres.gt(available) ? `Доступно не более ${display(available.toFixed())} л.`
    : money && !transferred ? 'Подтвердите, что деньги уже переведены водителю.' : ''
  const visibleProblem = problem && !(money && !transferred && entry!.status === 'open') && (!volumeInput || litres.trim()) ? problem : ''

  const dismiss = () => {
    if (lock.current) return
    if (uncertain) { setError('Проверьте сохранение тем же запросом, прежде чем закрыть форму.'); return }
    if (dirty) setDiscard(true)
    else close()
  }
  useEffect(() => {
    if (!dirty && !uncertain) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty, uncertain])

  const refresh = async () => {
    if (lock.current || uncertain) return
    lock.current = true; setSaving(true)
    try {
      const next = await readWorkspace()
      if (source) {
        const latest = next.refuellings.find(item => item.id === source.id)
        if (!latest) throw new Error('Исходная операция не найдена. Закройте форму и обновите список.')
        setSource(latest)
      } else {
        const latest = next.cases.find(item => item.id === entry!.id)
        if (!latest) throw new Error('Запись не найдена. Закройте форму и обновите список.')
        setEntry(latest); setTransferred(false)
      }
      setData(next); setStale(false); setError('Данные обновлены. Проверьте литры и сумму перед сохранением.')
    } catch (reason) { setError((reason as Error).message || 'Не удалось обновить данные. Ваш ввод сохранён.') }
    finally { lock.current = false; setSaving(false) }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (lock.current) return
    if (!pending.current) {
      if (problem) { setError(problem); return }
      const payload = creating ? { operationId: source!.id, operationVersion: source!.version, kind, ...(kind === 'return' ? { litres } : {}) }
        : { version: entry!.version, method: editor.method, ...(!money ? { litres } : {}) }
      pending.current = JSON.stringify({ ...payload, idempotencyKey: crypto.randomUUID() })
    }
    lock.current = true; setSaving(true); setError(''); setStale(false)
    const wasUncertain = uncertain
    try {
      const response = await apiFetch(creating ? '/api/operator/cases' : `/api/operator/cases/${entry!.id}/settle`, { method: creating ? 'POST' : 'PATCH', headers: { 'Content-Type': 'application/json' }, body: pending.current, signal: AbortSignal.timeout(20000) })
      const result = await response.json()
      if (!response.ok) {
        const definitive = isDefinitiveOperatorRejection(response.status, result.error, wasUncertain)
        if (definitive) { pending.current = null; setUncertain(false) } else setUncertain(true)
        setStale(definitive && response.status === 409)
        setError(result.error || 'Сохранение не подтверждено.'); return
      }
      setUncertain(true)
      const next = await readWorkspace()
      const saved = next.cases.find(item => item.id === result.id)
      if (!saved || !Number.isSafeInteger(result.version) || saved.version < result.version || saved.operationId !== (source?.id ?? entry!.operationId) || saved.kind !== kind) throw new Error('Результат записи пока не подтверждён.')
      if (!creating && (result.version <= entry!.version || typeof result.settlementId !== 'string' || !saved.settlements.some(item => item.id === result.settlementId && item.method === editor.method && !entry!.settlements.some(previous => previous.id === item.id)))) throw new Error('Исполнение пока не подтверждено.')
      pending.current = null; setUncertain(false)
      await complete(() => onSaved(next, creating ? kind === 'return' ? 'Возврат оформлен' : 'Заправка перенесена' : money ? 'Возврат денег отмечен' : saved.status === 'completed' ? 'Заправка отмечена, остаток исполнен' : 'Заправка отмечена, оставшиеся литры сохранены'))
    } catch { setUncertain(true); setError('Ответ не получен или повторное чтение не удалось. Проверьте сохранение тем же запросом.') }
    finally { lock.current = false; setSaving(false) }
  }

  return <dialog ref={dialog} className="operator-dialog operator-case-dialog" aria-labelledby={titleId} onCancel={event => { event.preventDefault(); dismiss() }}><form onSubmit={event => void submit(event)}>
    <header><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Закрыть форму" disabled={saving} onClick={dismiss}><X size={20} aria-hidden="true"/></button></header>
    <div className="operator-dialog-body">
      {error && <p className="soft-notice" role="alert">{error}</p>}
      {stale && !uncertain && <button type="button" className="button operator-case-refresh" disabled={saving} onClick={() => void refresh()}>Обновить данные</button>}
      {discard ? <div className="operator-discard"><p>Закрыть форму без сохранения?</p><div className="operator-actions"><button type="button" className="button" onClick={() => setDiscard(false)}>Продолжить ввод</button><button type="button" className="button" onClick={close}>Не сохранять</button></div></div> : <>
        <div className="operator-case-dialog-source"><strong>{driverName}</strong><span>Исходная операция от {calendarDate(facts.date)}</span><OperatorServiceBadge service={facts.service} discountPercent={facts.discountPercent}/></div>
        <fieldset disabled={saving || uncertain} className="operator-case-fields">
          {volumeInput && <label htmlFor={volumeId}>{creating ? 'Литры к возврату' : 'Заправлено, л'}<input id={volumeId} aria-label={creating ? 'Литры к возврату' : 'Заправлено, л'} required inputMode="decimal" autoComplete="off" maxLength={40} value={litres} onChange={event => { setLitres(event.target.value); setError('') }} aria-invalid={!!visibleProblem} aria-describedby={previewId}/></label>}
          {visibleProblem && <p className="operator-case-explanation" role="status">{visibleProblem}</p>}
          {creating && kind === 'deferred' && <p className="operator-case-explanation">Водитель оплатил, но не заправился. В ожидание заправки будет записано <strong>{display(source!.litres)} л</strong>.</p>}
          {money && <p className="operator-case-explanation">Возврат водителю <strong>{driverName}</strong> за оставшиеся <strong>{display(entry!.remainingLitres)} л</strong>. После перевода по реквизитам водителя отметьте его здесь. CRM деньги не переводит.</p>}
          <div id={previewId} className="operator-case-preview" aria-live="polite"><span>{money ? 'Вернуть водителю' : creating ? 'Сумма по исходной цене и скидке' : 'Сумма заправленного остатка'}</span><output>{amount === null ? '—' : `${display(amount, true)} ₽`}</output>{volumeInput && <small>Доступно: {display(available.toFixed())} л</small>}</div>
          {money ? <label className="operator-case-confirm"><input type="checkbox" checked={transferred} onChange={event => setTransferred(event.target.checked)} required/><span>Подтверждаю: {display(entry!.remainingAmount, true)} ₽ уже переведены водителю.</span></label> : <p className="operator-case-explanation">{creating ? 'Цена и скидка взяты из исходной операции. Оплата, распределение получателям и лимиты задания сохраняются.' : 'Укажите фактически заправленный литраж. Неиспользованные литры останутся открытыми.'}</p>}
        </fieldset>
      </>}
    </div>
    {!discard && <footer><button type="button" className="button" disabled={saving || uncertain} onClick={dismiss}>Закрыть</button><button type="submit" className="button primary" disabled={saving || !uncertain && (!!problem || stale)}>{saving ? 'Сохраняем…' : uncertain ? 'Проверить сохранение' : creating ? kind === 'return' ? 'Создать возврат' : 'Перенести заправку' : money ? <><Check size={16} aria-hidden="true"/>Деньги возвращены</> : 'Подтвердить заправку'}</button></footer>}
  </form></dialog>
}

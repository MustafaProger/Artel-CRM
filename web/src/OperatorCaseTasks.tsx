import { useEffect, useId, useRef, useState, type FormEvent } from 'react'
import { ArrowLeft, X } from 'lucide-react'
import type { OperatorCaseKind, OperatorCaseSummary } from './operator-case-model'
import type { OperatorWorkspace } from './operator-model'
import { operatorToday } from './OperatorCases'
import { useDialogMotion } from './useDialogMotion'
import { apiFetch } from './workspace-api'
import { display, isDefinitiveOperatorRejection, readWorkspace } from './operator-ui-utils'

export function OperatorTaskPicker({ cases, onClose, onPlan, onTask }: {
  cases: OperatorCaseSummary[]; onClose: () => void; onPlan: () => void; onTask: (entry: OperatorCaseSummary) => void
}) {
  const [kind, setKind] = useState<OperatorCaseKind | null>(null), [query, setQuery] = useState('')
  const ref = useRef<HTMLDialogElement>(null), title = useId()
  const { close, complete } = useDialogMotion(ref, onClose)
  const rows = cases.filter(entry => entry.kind === kind && entry.status === 'open' && entry.source.driverName.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
  return <dialog ref={ref} className="operator-dialog operator-case-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); close() }}><form onSubmit={event => event.preventDefault()}>
    <header><h2 id={title}>{!kind ? 'Новое задание' : kind === 'return' ? 'Выберите оформленный возврат' : 'Выберите ожидающую заправку'}</h2><button type="button" className="icon-button" aria-label="Закрыть выбор задания" onClick={close}><X size={20}/></button></header>
    <div className="operator-dialog-body">{!kind ? <div className="operator-task-options">
      <button type="button" className="operator-source-choice" onClick={() => void complete(onPlan)}><strong>Приём оплаты</strong><span>Задание с получателями и лимитами</span></button>
      <button type="button" className="operator-source-choice" onClick={() => setKind('return')}><strong>Возврат водителю</strong><span>Из уже оформленного возврата</span></button>
      <button type="button" className="operator-source-choice" onClick={() => setKind('deferred')}><strong>Заправка из остатка</strong><span>Из списка «Ожидают заправки»</span></button>
    </div> : <><button type="button" className="operator-case-source" onClick={() => { setKind(null); setQuery('') }}><ArrowLeft size={16}/>Другой вид задания</button><label>Водитель<input aria-label="Поиск водителя для задания" value={query} onChange={event => setQuery(event.target.value)}/></label>
      <div className="operator-source-list">{rows.map(entry => <button type="button" className="operator-source-choice" key={entry.id} onClick={() => void complete(() => onTask(entry))}><strong>{entry.source.driverName}</strong><span>{entry.source.date.split('-').reverse().join('.')} · {entry.source.service} · осталось {display(entry.remainingLitres)} л</span><span>{entry.task ? 'Задание уже поставлено — можно изменить дату и описание' : 'Поставить задание на нужную дату'}</span></button>)}</div>
      {!rows.length && <p className="operator-case-explanation">{query.trim() ? 'По этому водителю открытых записей нет.' : kind === 'return' ? 'Оформленных открытых возвратов пока нет. Сначала создайте возврат из оплаченной операции.' : 'Ожидающих заправки пока нет. Сначала перенесите оплаченную заправку через «Действие» у операции.'}</p>}
    </>}</div><footer><button type="button" className="button" onClick={close}>Закрыть</button></footer>
  </form></dialog>
}

export function CaseTaskEditor({ entry: initial, onClose, onSaved }: {
  entry: OperatorCaseSummary; onClose: () => void; onSaved: (data: OperatorWorkspace, notice?: string) => void
}) {
  const [entry, setEntry] = useState(initial)
  const [dueDate, setDueDate] = useState(initial.task?.dueDate ?? operatorToday()), [comment, setComment] = useState(initial.task?.comment ?? '')
  const [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false), [stale, setStale] = useState(false), [discard, setDiscard] = useState(false), [error, setError] = useState('')
  const dialog = useRef<HTMLDialogElement>(null), lock = useRef(false), pending = useRef<string | null>(null), original = useRef({ dueDate, comment })
  const title = useId(), { close, complete } = useDialogMotion(dialog, onClose)
  const dirty = dueDate !== original.current.dueDate || comment !== original.current.comment
  const dismiss = () => {
    if (lock.current) return
    if (uncertain) { setError('Проверьте сохранение тем же запросом, прежде чем закрыть форму.'); return }
    if (dirty) setDiscard(true); else close()
  }
  useEffect(() => {
    if (!dirty && !uncertain) return
    const prevent = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = '' }
    window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty, uncertain])
  const refresh = async () => {
    if (lock.current || uncertain) return
    lock.current = true; setSaving(true)
    try {
      const next = await readWorkspace(), latest = next.cases.find(item => item.id === entry.id)
      if (!latest) throw new Error('Возврат или остаток не найден. Закройте форму и обновите список.')
      original.current = { dueDate: latest.task?.dueDate ?? operatorToday(), comment: latest.task?.comment ?? '' }
      setEntry(latest); setStale(false)
      setError(latest.status === 'completed' ? 'Остаток уже исполнен. Новое задание не требуется.' : 'Данные обновлены. Проверьте дату и описание перед сохранением.')
    } catch (reason) { setError((reason as Error).message) }
    finally { lock.current = false; setSaving(false) }
  }
  const submit = async (event: FormEvent) => {
    event.preventDefault(); if (lock.current) return
    if (!pending.current) {
      if (entry.status !== 'open') { setError('Остаток уже исполнен.'); return }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) { setError('Укажите дату выполнения.'); return }
      pending.current = JSON.stringify({ version: entry.version, dueDate, comment, idempotencyKey: crypto.randomUUID() })
    }
    const wasUncertain = uncertain
    lock.current = true; setSaving(true); setError('')
    try {
      const response = await apiFetch(`/api/operator/cases/${entry.id}/task`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: pending.current, signal: AbortSignal.timeout(20000) })
      const result = await response.json()
      if (!response.ok) {
        const definitive = isDefinitiveOperatorRejection(response.status, result.error, wasUncertain)
        if (definitive) { pending.current = null; setUncertain(false) } else setUncertain(true)
        setStale(definitive && response.status === 409); setError(result.error || 'Сохранение не подтверждено.'); return
      }
      setUncertain(true)
      const next = await readWorkspace(), saved = next.cases.find(item => item.id === entry.id)
      const event = saved?.taskHistory?.find(item => item.id === result.taskEventId)
      const submitted = JSON.parse(pending.current!) as { dueDate: string; comment: string }
      if (result.id !== entry.id || !Number.isSafeInteger(result.version) || result.version <= entry.version || !saved || saved.version < result.version || !event || event.dueDate !== submitted.dueDate || event.comment !== submitted.comment.trim()) throw new Error('Сохранение задания пока не подтверждено.')
      pending.current = null; setUncertain(false)
      await complete(() => onSaved(next, entry.task ? 'Задание обновлено' : 'Задание поставлено'))
    } catch { setUncertain(true); setError('Ответ не получен или повторное чтение не удалось. Проверьте сохранение тем же запросом.') }
    finally { lock.current = false; setSaving(false) }
  }
  return <dialog ref={dialog} className="operator-dialog operator-case-dialog" aria-labelledby={title} onCancel={event => { event.preventDefault(); dismiss() }}><form onSubmit={event => void submit(event)}>
    <header><h2 id={title}>{entry.kind === 'return' ? 'Задание на возврат' : 'Задание на заправку'}</h2><button type="button" className="icon-button" aria-label="Закрыть форму задания" disabled={saving} onClick={dismiss}><X size={20}/></button></header>
    <div className="operator-dialog-body">{error && <p className="soft-notice" role="alert">{error}</p>}{stale && <button type="button" className="button operator-case-refresh" disabled={saving || uncertain} onClick={() => void refresh()}>Обновить данные</button>}
      {discard ? <div className="operator-discard"><p>Закрыть форму без сохранения?</p><div className="operator-actions"><button type="button" className="button" onClick={() => setDiscard(false)}>Продолжить ввод</button><button type="button" className="button" onClick={close}>Не сохранять</button></div></div> : <>
        <div className="operator-case-dialog-source"><strong>{entry.source.driverName}</strong><span>{entry.source.service} · осталось {display(entry.remainingLitres)} л · {display(entry.remainingAmount, true)} ₽</span></div>
        <fieldset className="operator-case-fields" disabled={saving || uncertain || entry.status === 'completed'}>
          <label>Дата выполнения<input type="date" aria-label="Дата выполнения" required value={dueDate} onChange={event => setDueDate(event.target.value)}/></label>
          <label>Что нужно сделать<textarea aria-label="Что нужно сделать" rows={3} maxLength={2000} value={comment} placeholder={entry.kind === 'return' ? 'Например, сегодня связаться с водителем и вернуть остаток' : 'Например, сегодня заправить водителя из сохранённого остатка'} onChange={event => setComment(event.target.value)}/></label>
          <p className="operator-case-explanation">Задание появится во вкладке «Задания». При выполнении {entry.kind === 'return' ? 'выберите возврат денег или заправку' : 'отметьте фактически заправленные литры'}. Неиспользованные литры сохранятся, дату задания можно будет перенести.</p>
        </fieldset>
      </>}
    </div>{!discard && <footer><button type="button" className="button" disabled={saving || uncertain} onClick={dismiss}>Закрыть</button><button type="submit" className="button primary" disabled={saving || !uncertain && (stale || entry.status !== 'open' || !dueDate || !!entry.task && !dirty)}>{saving ? 'Сохраняем…' : uncertain ? 'Проверить сохранение' : entry.task ? 'Сохранить задание' : 'Поставить задание'}</button></footer>}
  </form></dialog>
}

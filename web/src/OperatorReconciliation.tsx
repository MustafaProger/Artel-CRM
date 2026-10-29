import { Fragment, useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import Decimal from 'decimal.js'
import type { OperatorRefuelling, OperatorWorkspace } from './operator-model'
import { reconciliationRows } from './operator-reconciliation'
import OperatorServiceBadge from './OperatorServiceBadge'
import { display, readWorkspace, isDefinitiveOperatorRejection } from './operator-ui-utils'
import { apiFetch } from './workspace-api'
import ScrollableSegments from './ScrollableSegments'
import { operatorServiceInk, operatorServiceBackground } from './operator-service-presentation'
import { useDialogMotion } from './useDialogMotion'
import { Check, X, RefreshCw, History } from 'lucide-react'
import './operator-reconciliation.css'

const today = () => new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Moscow'}).format(new Date())
type ReconciliationRow = ReturnType<typeof reconciliationRows>[number]
const dateLabel = (date: string) => date.split('-').reverse().join('.')
const statusOf = (row: ReconciliationRow) => row.report ? new Decimal(row.deltaAmount!).isZero() && new Decimal(row.deltaLitres!).isZero() ? 'matched' : 'different' : 'empty'

export default function OperatorReconciliation({workspace, busy, onRefresh, onDate, onSaved, onOperation}: {workspace: OperatorWorkspace; busy: boolean; onRefresh: () => void; onDate: (date: string, serviceId: string) => void; onSaved: (next: OperatorWorkspace) => void; onOperation: (row: OperatorRefuelling) => void}) {
  const [month, setMonth] = useState(today().slice(0, 7))
  const [serviceId, setServiceId] = useState(workspace.services[0]?.id ?? '')
  const [selectedDate, setSelectedDate] = useState<string | null>(null)
  const [editingDate, setEditingDate] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const days = /^\d{4}-\d{2}$/.test(month) ? Array.from({length: new Date(Number(month.slice(0,4)), Number(month.slice(5)), 0).getDate()}, (_, index) => `${month}-${String(index + 1).padStart(2, '0')}`).filter(date => month !== today().slice(0, 7) || date <= today()).reverse() : []
  const dailyRows = days.map(date => ({date, rows: reconciliationRows(workspace, date)}))
  const services = [...new Map(dailyRows.flatMap(day => day.rows.map(row => [row.id, {id: row.id, name: row.name}] as const))).values()]
  const activeService = services.some(service => service.id === serviceId) ? serviceId : services[0]?.id ?? ''
  const rows = dailyRows.map(day => ({date: day.date, row: day.rows.find(row => row.id === activeService)})).filter((item): item is {date: string; row: ReconciliationRow} => !!item.row)
  const selected = rows.find(item => item.date === selectedDate)
  return <section className="operator-reconciliation" aria-label="Сверки">
    <div className="operator-reconciliation-heading"><button type="button" className="button reconciliation-refresh" aria-label="Обновить сверки" title="Обновить сверки" disabled={busy} onClick={onRefresh}><RefreshCw size={20} aria-hidden="true"/><span className="reconciliation-refresh-label">Обновить</span></button><input type="month" aria-label="Месяц сверки" disabled={!!editingDate} required value={month} onChange={event => {if(event.target.value) {setMonth(event.target.value);setNotice('')}}}/></div>
    <ScrollableSegments className="operator-reconciliation-services" label="Сервисы сверки" value={activeService}>
      {services.map(service => {
        const color = workspace.services.find(item => item.id === service.id)?.backgroundColor ?? operatorServiceBackground(service.name, service.id)
        return <button type="button" key={service.id} aria-disabled={!!editingDate} title={editingDate ? 'Сохраните отчёт или отмените ввод' : undefined} aria-pressed={activeService === service.id} onClick={() => {if (!editingDate) {setServiceId(service.id);setNotice('')}}} style={{'--service-fill': color, '--service-ink': operatorServiceInk(color), backgroundColor: color, color: operatorServiceInk(color)} as CSSProperties}>{service.name}</button>
      })}
    </ScrollableSegments>
    <p className="operator-reconciliation-summary" role="status">{notice}</p>
    {rows.length ? <div className="operator-reconciliation-scroll"><table role="table" className="operator-reconciliation-table" aria-label={`Сверки: ${services.find(service => service.id === activeService)?.name}, ${month}`}>
      <thead role="rowgroup"><tr role="row"><th rowSpan={2} scope="col" role="columnheader">Дата</th><th colSpan={2} scope="colgroup" role="columnheader">CRM</th><th colSpan={2} scope="colgroup" role="columnheader">Отчёт оператора</th><th colSpan={2} scope="colgroup" role="columnheader">Разница</th><th rowSpan={2} scope="col" role="columnheader">Отчёт</th></tr><tr role="row">{['CRM', 'Отчёт оператора', 'Разница'].map(group => <Fragment key={group}><th scope="col" role="columnheader">Литры</th><th scope="col" role="columnheader">Сумма, ₽</th></Fragment>)}</tr></thead>
      <tbody role="rowgroup">{rows.map(({date, row}) => <ReconciliationDay key={`${activeService}:${date}`} row={row} date={date} editing={editingDate === date} locked={!!editingDate && editingDate !== date} onEdit={() => {setEditingDate(date);setNotice('')}} onCancel={() => setEditingDate(null)} onDate={() => onDate(date, activeService)} onDetails={() => setSelectedDate(date)} onSaved={next => {onSaved(next);setEditingDate(null);setNotice(`Отчёт ${row.name} за ${dateLabel(date)} сохранён`)}}/>)}</tbody>
    </table></div> : <p>В справочнике пока нет сервисов.</p>}
    {selected && <ReconciliationDetails key={`${selected.date}:${activeService}`} row={selected.row} date={selected.date} onOperation={operation => {setSelectedDate(null);onOperation(operation)}} onClose={() => setSelectedDate(null)}/>}
  </section>
}

function ReconciliationDay({row, date, editing, locked, onEdit, onCancel, onDate, onDetails, onSaved}: {row: ReconciliationRow; date: string; editing: boolean; locked: boolean; onEdit: () => void; onCancel: () => void; onDate: () => void; onDetails: () => void; onSaved: (next: OperatorWorkspace) => void}) {
  const [litres, setLitres] = useState(''), [amount, setAmount] = useState('')
  const [saving, setSaving] = useState(false), [uncertain, setUncertain] = useState(false), [error, setError] = useState('')
  const original = useRef(row.report)
  const pending = useRef<string | null>(null), lock = useRef(false)
  const firstInput = useRef<HTMLInputElement>(null), secondInput = useRef<HTMLInputElement>(null), editButton = useRef<HTMLButtonElement>(null)
  const focusField = useRef<'litres' | 'amount'>('litres')
  const formId = `reconciliation-${row.id}-${date}`
  const status = statusOf(row)
  const begin = (field: 'litres' | 'amount' = 'litres') => {
    original.current = row.report
    setLitres(row.report?.litres ?? '');setAmount(row.report?.amount ?? '');setError('');focusField.current = field;onEdit()
  }
  const cancel = () => {
    if (lock.current || uncertain) return
    pending.current = null;setError('');onCancel();editButton.current?.focus({preventScroll:true})
  }
  useEffect(() => {
    if (!editing) return
    const input = focusField.current === 'amount' ? secondInput.current : firstInput.current
    input?.focus({preventScroll:true});input?.select()
  }, [editing])
  const dirty = editing && (litres !== (original.current?.litres ?? '') || amount !== (original.current?.amount ?? '') || uncertain || saving)
  useEffect(() => {
    if (!dirty) return
    const prevent = (event: BeforeUnloadEvent) => {event.preventDefault();event.returnValue=''}
    window.addEventListener('beforeunload', prevent)
    return () => window.removeEventListener('beforeunload', prevent)
  }, [dirty])
  const save = async (event: FormEvent) => {
    event.preventDefault();if (lock.current) return
    const prior = original.current
    pending.current ??= JSON.stringify({date, serviceId: row.id, litres, amount, ...(prior ? {version: prior.version} : {}), idempotencyKey: crypto.randomUUID()})
    lock.current = true;setSaving(true);setError('')
    try {
      const response = await apiFetch(`/api/operator/reconciliations${prior ? `/${prior.id}` : ''}`, {method: prior ? 'PATCH' : 'POST', headers:{'Content-Type':'application/json'}, body:pending.current, signal:AbortSignal.timeout(20000)})
      const result = await response.json()
      if (!response.ok) {
        if (isDefinitiveOperatorRejection(response.status, result.error, uncertain)) {pending.current=null;setUncertain(false)} else setUncertain(true)
        setError(result.error || 'Не удалось сохранить отчёт.');return
      }
      setUncertain(true)
      const next = await readWorkspace()
      if (!next.reconciliations?.some(item => item.id === result.id)) throw new Error('Не удалось подтвердить сохранение.')
      pending.current=null;setUncertain(false);onSaved(next);editButton.current?.focus({preventScroll:true})
    } catch {setUncertain(true);setError('Ответ не получен. Проверьте сохранение тем же запросом.')}
    finally {lock.current=false;setSaving(false)}
  }
  return <tr role="row" data-date={date} className={editing ? 'is-editing' : !row.rows.length && !row.report ? 'is-empty-day' : undefined} onKeyDown={event => {if(editing && event.key === 'Escape') {event.preventDefault();cancel()}}}>
    <th scope="row" role="rowheader"><button type="button" className="operator-reconciliation-date" aria-label={`Операции ${row.name} за ${date}`} disabled={editing || locked} onClick={onDate}>{dateLabel(date)}</button><span className="reconciliation-mobile-columns" aria-hidden="true"><span/><span>Литры</span><span>Сумма, ₽</span></span></th>
    <td role="cell" data-label="CRM · Литры" data-source="CRM">{row.rows.length || row.report ? display(row.litres) : '—'}</td><td role="cell" data-label="CRM · Сумма, ₽">{row.rows.length || row.report ? display(row.amount,true) : '—'}</td>
    <td role="cell" data-label="Отчёт · Литры" data-source="Отчёт" className="reconciliation-report-cell">{editing ? <input ref={firstInput} form={formId} aria-label={`Литры из кабинета ${row.name}`} required inputMode="decimal" autoComplete="off" disabled={saving || uncertain} value={litres} onChange={event=>setLitres(event.target.value)}/> : <button type="button" disabled={locked} className="reconciliation-cell-edit" aria-label={`Ввести литры ${row.name} за ${date}`} onClick={()=>begin('litres')}>{row.report ? display(row.report.litres) : '—'}</button>}</td>
    <td role="cell" data-label="Отчёт · Сумма, ₽" className="reconciliation-report-cell">{editing ? <input ref={secondInput} form={formId} aria-label={`Сумма из кабинета ${row.name}`} required inputMode="decimal" autoComplete="off" disabled={saving || uncertain} value={amount} onChange={event=>setAmount(event.target.value)}/> : <button type="button" disabled={locked} className="reconciliation-cell-edit" aria-label={`Ввести сумму ${row.name} за ${date}`} onClick={()=>begin('amount')}>{row.report ? display(row.report.amount,true) : '—'}</button>}</td>
    <td role="cell" data-label="Разница · Литры" data-source="Разница" className={`reconciliation-difference is-${status}`} aria-label={status === 'empty' ? 'Разница не рассчитана' : status === 'matched' ? 'Совпадает' : 'Есть расхождение'}>{row.deltaLitres === null ? '—' : display(row.deltaLitres)}</td><td role="cell" data-label="Разница · Сумма, ₽" className={`reconciliation-difference is-${status}`}>{row.deltaAmount === null ? '—' : display(row.deltaAmount,true)}</td>
    <td role="cell" className="reconciliation-row-actions">
      {row.report && !editing && <button type="button" className="reconciliation-history" disabled={locked} aria-label={`История отчёта ${row.name} за ${date}`} title="История отчёта" onClick={onDetails}><History size={16} aria-hidden="true"/></button>}
      <button ref={editButton} type="button" hidden={editing} disabled={locked} className="operator-reconciliation-edit" aria-label={`${row.report ? 'Изменить' : 'Внести'} отчёт ${row.name} за ${date}`} onClick={()=>begin()}>{row.report ? 'Изменить' : 'Внести'}</button>
      {editing && <form id={formId} onSubmit={event=>void save(event)} aria-label={`Отчёт ${row.name} за ${date}`}><div className="reconciliation-inline-actions"><button type="submit" className="reconciliation-save" disabled={saving} aria-label={saving ? 'Сохраняем отчёт' : uncertain ? 'Проверить сохранение' : 'Сохранить отчёт'} title={uncertain ? 'Проверить сохранение' : 'Сохранить отчёт'}><Check size={16}/><span>{saving?'Сохраняем…':uncertain?'Проверить':'Сохранить'}</span></button><button type="button" className="reconciliation-cancel" disabled={saving || uncertain} onClick={cancel} aria-label="Отменить ввод" title="Отменить ввод"><X size={16}/></button></div>{error && <p role="alert">{error}</p>}</form>}
    </td>
  </tr>
}

function ReconciliationDetails({row, date, onOperation, onClose}: {row: ReconciliationRow; date: string; onOperation: (row: OperatorRefuelling) => void; onClose: () => void}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const {close} = useDialogMotion(dialog, onClose)
  const matches = statusOf(row) === 'matched'
  return <dialog ref={dialog} className="detail-dialog operator-reconciliation-dialog" aria-labelledby="reconciliation-detail-title" onCancel={event => {event.preventDefault();close()}}>
    <div className="directory-editor-heading"><h2 id="reconciliation-detail-title">{row.name} · {dateLabel(date)}</h2><button type="button" className="icon-button" aria-label="Закрыть сверку" onClick={close}><X size={20}/></button></div>
    <div className="directory-editor-body"><article className={`operator-reconciliation-card${row.report ? matches ? ' is-matched' : ' is-different' : ''}`}>
      <header><OperatorServiceBadge service={row.name} serviceId={row.id} part="name"/><span>{row.report ? matches ? 'Совпадает' : 'Есть расхождение' : 'Ожидает отчёта'}</span></header>
      <table aria-label={`Итоги ${row.name}`}><thead><tr><th scope="col">Источник</th><th scope="col">Литры</th><th scope="col">Сумма, ₽</th></tr></thead><tbody>
        <tr><th scope="row">CRM</th><td>{display(row.litres)}</td><td>{display(row.amount,true)}</td></tr>
        <tr><th scope="row">Личный кабинет</th><td>{row.report ? display(row.report.litres) : '—'}</td><td>{row.report ? display(row.report.amount,true) : '—'}</td></tr>
        <tr className="operator-reconciliation-delta"><th scope="row">Разница</th><td>{row.deltaLitres === null ? '—' : display(row.deltaLitres)}</td><td>{row.deltaAmount === null ? '—' : display(row.deltaAmount,true)}</td></tr>
      </tbody></table>
      <details open><summary>Операции за день · {row.rows.length}</summary>{row.rows.map(operation=><button type="button" className="operator-reconciliation-operation" key={operation.id} onClick={()=>onOperation(operation)}><span>{operation.name}<small>{display(operation.litres)} л · +{display(operation.discountPercent)}%</small></span><strong>{display(operation.amount,true)} ₽</strong></button>)}{!row.rows.length && <p>Операций за этот день нет.</p>}</details>
      {row.report && <details><summary>История отчёта · {row.report.history.length}</summary><ul>{[...row.report.history].reverse().map((entry,index)=><li key={index}>{display(entry.litres)} л · {display(entry.amount,true)} ₽<small>{entry.actorName} · {new Date(entry.at).toLocaleString('ru-RU',{timeZone:'Europe/Moscow'})} МСК</small></li>)}</ul></details>}
    </article></div>
  </dialog>
}

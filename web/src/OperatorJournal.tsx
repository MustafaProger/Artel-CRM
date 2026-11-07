import type { OperatorRefuelling, OperatorAllocation } from './operator-model'
import type { OperatorCaseSummary } from './operator-case-model'
import { operatorRequisitesText } from './operator-requisites'
import { display } from './operator-ui-utils'
import OperatorServiceBadge from './OperatorServiceBadge'
import './operator-journal.css'

interface Props {
  rows: OperatorRefuelling[]
  cases?: OperatorCaseSummary[]
  onView: (row: OperatorRefuelling) => void
  onAction: (row: OperatorRefuelling) => void
  onCase?: (entry: OperatorCaseSummary) => void
}
const client = (row: OperatorRefuelling) => row.schemaVersion === 3 ? row.planClientName : 'Без задания'
const date = (row: OperatorRefuelling) => row.date.split('-').reverse().join('.')
const legacyRecipient = (row: OperatorRefuelling) => row.schemaVersion === undefined
  ? [row.recipient.name, row.recipient.bank, operatorRequisitesText(row.recipient), row.recipient.details].filter(Boolean).join(' · ')
  : row.recipientText
function recipient(allocation: OperatorAllocation) {
  return allocation.kind === 'manager' ? { name: `Менеджер ${allocation.managerId === 'aidar' ? 'Айдар' : 'Эльдар'}`, details: 'Остаток менеджеру', amount: allocation.amount }
    : { name: allocation.recipient.name, details: [allocation.recipient.bank, operatorRequisitesText(allocation.recipient), allocation.recipient.details].filter(Boolean).join(' · '), amount: allocation.amount }
}
function allocations(row: OperatorRefuelling) {
  return row.schemaVersion === 3 ? row.allocations.map(recipient) : [{ name: legacyRecipient(row), details: '', amount: row.amount }]
}
function Service({ row }: { row: OperatorRefuelling }) {
  return <OperatorServiceBadge service={row.service} serviceId={row.schemaVersion === undefined ? undefined : row.serviceId} discountPercent={row.discountPercent} />
}
function Quantity({ row }: { row: OperatorRefuelling }) {
  return <><strong>{display(row.litres)} л</strong>{row.schemaVersion === 3 && row.payableLitres !== undefined && <small>{display(row.payableLitres)} л к оплате</small>}</>
}
function Recipient({ entry, split }: { entry: ReturnType<typeof recipient>; split: boolean }) {
  return <><div className="operator-recipient-line"><strong>{entry.name}</strong>{split && <span className="operator-recipient-amount">{display(entry.amount, true)} ₽</span>}</div>{entry.details && <span className="operator-recipient-details">{entry.details}</span>}</>
}
function CaseLinks({ row, cases, onCase }: Pick<Props, 'cases' | 'onCase'> & { row: OperatorRefuelling }) {
  const linked = cases?.filter(entry => entry.operationId === row.id) ?? []
  if (!linked.length) return null
  return <div className="operator-journal-cases" aria-label="Возвраты и ожидания по операции">{linked.map(entry => {
    const completed = entry.status === 'completed'
    const name = entry.kind === 'return' ? 'Возврат' : completed ? 'Ожидание' : 'Ожидает'
    const label = `${name}: ${display(completed ? entry.litres : entry.remainingLitres)} л${completed ? entry.kind === 'return' ? ' · завершён' : ' · завершено' : ''}`
    const className = `operator-journal-case is-${entry.kind}${completed ? ' is-completed' : ''}`
    return onCase ? <button key={entry.id} type="button" className={className} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onCase(entry) }}>{label}</button> : <span key={entry.id} className={className}>{label}</span>
  })}</div>
}
export default function OperatorJournal({ rows, cases = [], onView, onAction, onCase }: Props) {
  const action = (row: OperatorRefuelling) => <button type="button" className="button operator-action-trigger" aria-label={`Действие с операцией ${row.name}`} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onAction(row) }}>Действие</button>
  return <>
    <div className="operator-table-wrap operator-desktop-journal"><table className="operator-table operator-grouped-table">
      <caption className="operator-visually-hidden">Операции по водителям, отдельная строка каждого получателя</caption>
      <thead><tr>{['Дата / водитель', 'Клиент / задание', 'Сервис / скидка', 'Литры', 'Цена, ₽/л', 'Итого операции, ₽', 'Оплата', 'Получатель', ''].map((value, index) => <th key={index} className={value === 'Получатель' ? 'operator-recipient-column' : undefined} scope="col">{value || <span className="operator-visually-hidden">Действие</span>}</th>)}</tr></thead>
      {rows.map(row => {
        const entries = allocations(row), span = entries.length
        return <tbody key={row.id} data-operation-id={row.id} className="operator-operation-group" aria-label={`Операция ${row.name}, ${date(row)}`}>
          {entries.map((entry, index) => <tr key={index}>
            {index === 0 && <>
              <th scope="rowgroup" rowSpan={span} className="operator-group-driver"><small>{date(row)}</small><button className="operator-link" onClick={() => onView(row)}>{row.name}</button><CaseLinks row={row} cases={cases} onCase={onCase}/></th>
              <td rowSpan={span}>{client(row)}</td><td rowSpan={span}><Service row={row}/></td>
              <td rowSpan={span} className="operator-journal-quantity"><Quantity row={row}/></td><td rowSpan={span}>{display(row.pricePerLitre, row.schemaVersion !== undefined && !row.legacyPrecision?.pricePerLitre)}</td>
              <td rowSpan={span} className="operator-operation-total">{display(row.amount, true)}</td><td rowSpan={span}><span className={`operator-status ${row.paid ? 'is-paid' : ''}`}>{row.paid ? 'Оплачено' : 'Не оплачено'}</span></td>
            </>}
            <td className="operator-recipient-row"><Recipient entry={entry} split={span > 1}/></td>
            {index === 0 && <td rowSpan={span}>{action(row)}</td>}
          </tr>)}
        </tbody>
      })}
    </table></div>
    <div className="operator-mobile-journal">{rows.map(row => {
      const entries = allocations(row)
      return <article key={row.id} className="operator-operation-card" data-operation-id={row.id} aria-label={`Операция ${row.name}, ${date(row)}`}>
        <header><div><small>{date(row)}</small><button className="operator-link" onClick={() => onView(row)}>{row.name}</button><span>{client(row)}</span></div>{action(row)}</header>
        <div className="operator-card-service"><Service row={row}/></div>
        <div className="operator-card-totals"><span><Quantity row={row}/><small>{display(row.pricePerLitre, row.schemaVersion !== undefined && !row.legacyPrecision?.pricePerLitre)} ₽/л</small></span><span><strong>{display(row.amount, true)} ₽</strong><small>Итого операции</small></span></div>
        <span className={`operator-status ${row.paid ? 'is-paid' : ''}`}>{row.paid ? 'Оплачено' : 'Не оплачено'}</span>
        <CaseLinks row={row} cases={cases} onCase={onCase}/>
        <ul className="operator-card-recipients">{entries.map((entry, index) => <li key={index}><Recipient entry={entry} split={entries.length > 1}/></li>)}</ul>
      </article>
    })}</div>
  </>
}

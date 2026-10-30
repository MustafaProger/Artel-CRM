import { useSyncExternalStore } from 'react'
import type { OperatorRefuelling, OperatorAllocation } from './operator-model'
import type { OperatorCaseSummary } from './operator-case-model'
import { display } from './operator-ui-utils'
import OperatorServiceBadge from './OperatorServiceBadge'
import './operator-journal.css'

interface Props {
  rows: OperatorRefuelling[]
  cases?: OperatorCaseSummary[]
  onView: (row: OperatorRefuelling) => void
  paymentDisabled?: boolean
  onPayment: (row: OperatorRefuelling) => void
  onAction: (row: OperatorRefuelling) => void
  onCase?: (entry: OperatorCaseSummary) => void
}
const client = (row: OperatorRefuelling) => row.schemaVersion === 3 ? row.planClientName : 'Без задания'
const date = (row: OperatorRefuelling) => row.date.split('-').reverse().join('.')
function recipient(allocation: OperatorAllocation, fallback: string) {
  return allocation.kind === 'manager' ? { client: allocation.planClientName ?? fallback, name: `Менеджер ${allocation.managerId === 'aidar' ? 'Айдар' : 'Эльдар'}`, details: '', amount: allocation.amount }
    : { client: allocation.planClientName ?? fallback, name: allocation.recipient.name, details: allocation.recipient.bank, amount: allocation.amount }
}
function allocations(row: OperatorRefuelling) {
  if (row.schemaVersion === 3) return row.allocations.map(item => recipient(item, client(row)))
  // V2 stores one opaque free-text field: do not guess names/banks or expose payment details.
  return [{ client: 'Без задания', name: row.schemaVersion === undefined ? row.recipient.name : 'Получатель — в подробностях', details: row.schemaVersion === undefined ? row.recipient.bank : '', amount: row.amount }]
}
function Service({ row }: { row: OperatorRefuelling }) {
  return <OperatorServiceBadge service={row.service} serviceId={row.schemaVersion === undefined ? undefined : row.serviceId} discountPercent={row.discountPercent} />
}
function Quantity({ row }: { row: OperatorRefuelling }) {
  return <><strong className="operator-litres">{display(row.litres)} л</strong>{row.schemaVersion === 3 && row.payableLitres !== undefined && <small>{display(row.payableLitres)} л к оплате</small>}</>
}
function Recipient({ entry }: { entry: ReturnType<typeof recipient> }) {
  return <div className="operator-recipient-inline"><span className="operator-recipient-client">{entry.client}</span><strong>{entry.name}</strong><span className="operator-recipient-amount">{display(entry.amount, true)} ₽</span><span className="operator-recipient-details">{entry.details}</span></div>
}
const compactQuery = '(max-width:700px)'
const subscribeCompact = (notify: () => void) => {
  const media = window.matchMedia(compactQuery)
  media.addEventListener('change', notify)
  return () => media.removeEventListener('change', notify)
}
const isCompact = () => window.matchMedia(compactQuery).matches

export default function OperatorJournal({ rows, onView, onAction, onPayment, paymentDisabled = false }: Props) {
  const compact = useSyncExternalStore(subscribeCompact, isCompact, () => false)
  const action = (row: OperatorRefuelling) => <button type="button" className="button operator-action-trigger" aria-label={`Действие с операцией ${row.name}`} onClick={event => { event.currentTarget.focus({ preventScroll: true }); onAction(row) }}>Действие</button>
  const payment = (row: OperatorRefuelling) => <select disabled={paymentDisabled} aria-busy={paymentDisabled} className={`operator-status operator-payment-select ${row.paid ? 'is-paid' : ''}`} aria-label={`Оплата ${row.name}`} value={row.paid ? 'paid' : 'unpaid'} onChange={event => { if ((event.target.value === 'paid') !== row.paid) onPayment(row) }}><option value="paid">Оплачено</option><option value="unpaid">Не оплачено</option></select>
  return !compact ? <div className="operator-table-wrap operator-desktop-journal"><table className="operator-table operator-grouped-table">
      <caption className="operator-visually-hidden">Операции по водителям, отдельная строка каждого получателя</caption>
      <thead><tr>{['Дата', 'Водитель', 'Сервис / скидка', 'Литры', 'Цена, ₽/л', 'Итого операции, ₽', 'Оплата', 'Получатель', ''].map((value, index) => <th key={index} className={value === 'Получатель' ? 'operator-recipient-column' : undefined} scope="col">{value || <span className="operator-visually-hidden">Действие</span>}</th>)}</tr></thead>
      {rows.map(row => {
        const entries = allocations(row), span = entries.length
        return <tbody key={row.id} data-operation-id={row.id} className="operator-operation-group" aria-label={`Операция ${row.name}, ${date(row)}`}>
          {entries.map((entry, index) => <tr key={index}>
            {index === 0 && <>
              <td rowSpan={span} className="operator-date-column">{date(row)}</td><th scope="rowgroup" rowSpan={span} className="operator-group-driver"><button className="operator-link" onClick={() => onView(row)}>{row.name}</button></th>
              <td rowSpan={span}><Service row={row}/></td>
              <td rowSpan={span} className="operator-journal-quantity"><Quantity row={row}/></td><td rowSpan={span} className="operator-price">{display(row.pricePerLitre, row.schemaVersion !== undefined && !row.legacyPrecision?.pricePerLitre)}</td>
              <td rowSpan={span} className="operator-operation-total">{display(row.amount, true)}</td><td rowSpan={span}>{payment(row)}</td>
            </>}
            <td className="operator-recipient-row"><div className="operator-recipient-scroll" role="group" aria-label={`Получатель ${entry.name}`} tabIndex={0}><Recipient entry={entry}/></div></td>
            {index === 0 && <td rowSpan={span}>{action(row)}</td>}
          </tr>)}
        </tbody>
      })}
    </table></div> : <div className="operator-mobile-journal">{rows.map(row => {
      const entries = allocations(row)
      return <article key={row.id} className="operator-operation-card" data-operation-id={row.id} aria-label={`Операция ${row.name}, ${date(row)}`}>
        <header><div><small>{date(row)}</small><button className="operator-link" onClick={() => onView(row)}>{row.name}</button></div>{action(row)}</header>
        <div className="operator-card-service"><Service row={row}/></div>
        <div className="operator-card-totals"><span><Quantity row={row}/><small className="operator-price">{display(row.pricePerLitre, row.schemaVersion !== undefined && !row.legacyPrecision?.pricePerLitre)} ₽/л</small></span><span><strong>{display(row.amount, true)} ₽</strong><small>Итого операции</small></span></div>
        {payment(row)}
        
        <ul className="operator-card-recipients">{entries.map((entry, index) => <li key={index}><Recipient entry={entry}/></li>)}</ul>
      </article>
    })}</div>
}

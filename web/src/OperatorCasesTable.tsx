import { useId } from 'react'
import type { OperatorCaseKind, OperatorCaseSummary } from './operator-case-model'
import { display } from './operator-ui-utils'
import OperatorServiceBadge from './OperatorServiceBadge'

const calendarDate = (value: string) => value.split('-').reverse().join('.')
const methods = { money: 'Возврат денег', fuel: 'Заправка', carryover: 'Зачёт в новой операции' }

export default function OperatorCasesTable({ entries, kind, today, taskDate, onOpen }: {
  entries: OperatorCaseSummary[]
  kind: OperatorCaseKind
  today: string
  taskDate: (entry: OperatorCaseSummary) => string
  onOpen: (id: string) => void
}) {
  const titleId = useId()
  if (!entries.length) return null
  const name = kind === 'return' ? 'Таблица возвратов' : 'Таблица ожидающих заправки'
  return <section className="operator-cases-table-section" aria-labelledby={titleId}>
    <h3 id={titleId}>{name}</h3>
    <div className="operator-cases-table-scroll" role="region" aria-label={`${name}, прокрутка по горизонтали`} tabIndex={0}>
      <table className="operator-cases-table">
        <caption className="operator-visually-hidden">{name}: {entries[0].status === 'open' ? 'открытые записи' : 'выполненные записи'}</caption>
        <thead><tr>{['Водитель / исходная дата', 'Сервис / скидка', 'Оформлено, л', 'Осталось, л', 'Сумма остатка, ₽', 'Задание', 'Исполнение', 'Действие'].map(label => <th key={label} scope="col">{label}</th>)}</tr></thead>
        <tbody>{entries.map(entry => {
          const completed = entry.status === 'completed'
          const status = completed ? 'Выполнено' : entry.settlements.length ? 'Частично исполнено' : kind === 'return' ? 'К возврату' : 'Ожидает заправки'
          const performed = [...new Set(entry.settlements.map(event => methods[event.method]))]
          return <tr key={entry.id} data-case-id={entry.id}>
            <th scope="row" className="operator-cases-table-driver"><strong>{entry.source.driverName}</strong><time dateTime={entry.source.date}>{calendarDate(entry.source.date)}</time></th>
            <td><OperatorServiceBadge service={entry.source.service} discountPercent={entry.source.discountPercent}/></td>
            <td className="operator-cases-table-number">{display(entry.litres)}</td>
            <td className="operator-cases-table-number operator-cases-table-remaining">{display(entry.remainingLitres)}</td>
            <td className="operator-cases-table-number">{display(entry.remainingAmount, true)}</td>
            <td className="operator-cases-table-task">{entry.task ? <>
              <time dateTime={entry.task.dueDate} className={entry.status === 'open' && entry.task.dueDate < today ? 'is-overdue' : undefined}>{taskDate(entry)}{entry.task.dueDate === today ? ` · ${calendarDate(entry.task.dueDate)}` : ''}</time>
              {entry.task.comment && <p title={entry.task.comment}>{entry.task.comment}</p>}
              <small>Поставил: {entry.task.createdByName || 'Пользователь CRM'}</small>
            </> : <span className="operator-cases-table-muted">Не поставлено</span>}</td>
            <td className="operator-cases-table-status"><span className={`operator-case-status${completed ? ' is-completed' : ''}`}>{status}</span><small>{performed.length ? performed.join(' · ') : 'Пока не исполнено'}</small></td>
            <td><button type="button" className="button operator-cases-table-open" aria-controls={`operator-case-${entry.id}`} aria-label={`Открыть карточку ${kind === 'return' ? 'возврата' : 'ожидающей заправки'}: ${entry.source.driverName}`} onClick={() => onOpen(entry.id)}>Открыть</button></td>
          </tr>
        })}</tbody>
      </table>
    </div>
  </section>
}

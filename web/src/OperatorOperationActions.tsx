import { useId, useRef } from 'react'
import { ArrowUpRight, Check, Eye, Fuel, Pencil, RotateCcw, Trash2, Undo2, X } from 'lucide-react'
import type { OperatorRefuelling } from './operator-model'
import { display } from './operator-ui-utils'
import { useDialogMotion } from './useDialogMotion'
import OperatorServiceBadge from './OperatorServiceBadge'
import './operator-operation-presentation.css'

export type OperatorOperationAction = 'view' | 'payment' | 'delete' | 'return' | 'defer'

export interface OperatorOperationActionsProps {
  row: OperatorRefuelling
  onClose: () => void
  onAction: (action: OperatorOperationAction) => void
  canReturn?: boolean
  canDefer?: boolean
  historyLocked?: boolean
  paymentDisabled?: boolean
}

export default function OperatorOperationActions({ row, onClose, onAction, canReturn = false, canDefer = false, historyLocked = false, paymentDisabled = false }: OperatorOperationActionsProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId(), contextId = useId(), deleteReasonId = useId()
  const { close, complete } = useDialogMotion(dialog, onClose)
  const date = /^\d{4}-\d{2}-\d{2}$/.test(row.date) ? row.date.split('-').reverse().join('.') : row.date
  const context = [date, row.schemaVersion === 3 ? row.planClientName : ''].filter(Boolean).join(' · ')
  const viewOnly = row.paid || historyLocked
  const paymentLocked = paymentDisabled
  const deleteLocked = row.paid || historyLocked
  const select = (action: OperatorOperationAction) => {
    if (action === 'delete' && deleteLocked || action === 'payment' && paymentLocked || action === 'return' && !canReturn || action === 'defer' && !canDefer) return
    void complete(() => { onClose(); onAction(action) })
  }

  return <dialog ref={dialog} className="operator-operation-actions" aria-labelledby={titleId} aria-describedby={contextId}
    onCancel={event => { event.preventDefault(); close() }}
    onKeyDown={event => {
      if (event.key !== 'Tab') return
      const buttons = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const first = buttons[0], last = buttons.at(-1)
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}
    onClick={event => {
      if (event.target !== event.currentTarget) return
      const rect = event.currentTarget.getBoundingClientRect()
      if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close()
    }}>
    <header className="operator-operation-actions-header">
      <div><span className="operator-operation-actions-eyebrow">Действие с операцией</span><h2 id={titleId}>{row.name}</h2></div>
      <button type="button" className="operator-operation-close" aria-label="Закрыть действия с операцией" onClick={close} autoFocus><X size={20} aria-hidden="true"/></button>
    </header>
    <div className="operator-operation-actions-body">
      <p id={contextId} className="operator-operation-context">{context || 'Операция водителя'}</p>
      <section className="operator-operation-summary" aria-label="Сведения об операции">
        <div className="operator-operation-summary-top"><OperatorServiceBadge service={row.service} serviceId={row.schemaVersion !== undefined ? row.serviceId : undefined} discountPercent={row.discountPercent}/><span className={`operator-operation-payment${row.paid ? ' is-paid' : ''}`}>{row.paid ? 'Оплачено' : 'Не оплачено'}</span></div>
        <dl><div><dt>Общая сумма операции</dt><dd>{display(row.amount, true)} ₽</dd></div><div><dt>Литры</dt><dd>{display(row.litres)} л</dd></div></dl>
      </section>
      <div className="operator-operation-action-list" role="group" aria-label="Доступные действия">
        <button type="button" className="operator-operation-action" onClick={() => select('view')}>
          {viewOnly ? <Eye size={20} aria-hidden="true"/> : <Pencil size={20} aria-hidden="true"/>}<span><strong>{viewOnly ? 'Просмотр операции' : 'Изменить операцию'}</strong><small>{viewOnly ? 'Все сведения и история оплаты' : 'Сведения о заправке и получателях'}</small></span><ArrowUpRight className="operator-operation-action-arrow" size={18} aria-hidden="true"/>
        </button>
        <button type="button" className="operator-operation-action" disabled={paymentLocked} aria-describedby={paymentLocked ? deleteReasonId : undefined} onClick={() => select('payment')}>
          {row.paid ? <Undo2 size={20} aria-hidden="true"/> : <Check size={20} aria-hidden="true"/>}<span><strong>{row.paid ? 'Снять подтверждение оплаты' : 'Подтвердить оплату'}</strong><small>{row.paid ? 'Сразу отметить как неоплаченную' : 'Сразу отметить как оплаченную'}</small></span><ArrowUpRight className="operator-operation-action-arrow" size={18} aria-hidden="true"/>
        </button>
        {canReturn && <button type="button" className="operator-operation-action" onClick={() => select('return')}><RotateCcw size={20} aria-hidden="true"/><span><strong>Оформить возврат</strong><small>Открыть возврат по этой операции</small></span><ArrowUpRight className="operator-operation-action-arrow" size={18} aria-hidden="true"/></button>}
        {canDefer && <button type="button" className="operator-operation-action" onClick={() => select('defer')}><Fuel size={20} aria-hidden="true"/><span><strong>Заправка позже</strong><small>Открыть перенос оплаченной заправки</small></span><ArrowUpRight className="operator-operation-action-arrow" size={18} aria-hidden="true"/></button>}
      </div>
      <div className="operator-operation-delete-group">
        <button type="button" className="operator-operation-action operator-operation-action-delete" disabled={deleteLocked} aria-describedby={deleteLocked ? deleteReasonId : undefined} onClick={() => select('delete')}><Trash2 size={20} aria-hidden="true"/><span><strong>Удалить операцию</strong><small>Открыть подтверждение удаления</small></span></button>
        {deleteLocked && <p id={deleteReasonId}>{historyLocked ? 'Есть возврат или использованный остаток; исходная оплата сохранена.' : 'Для удаления сначала снимите подтверждение оплаты.'}</p>}
      </div>
    </div>
    <footer className="operator-operation-actions-footer"><button type="button" className="button" onClick={close}>Закрыть</button></footer>
  </dialog>
}

import { useRef, useState } from 'react'
import { X } from 'lucide-react'
import Decimal from 'decimal.js'
import type { OperatorWorkspace, OperatorRefuelling } from './operator-model'
import type { OperatorCaseKind } from './operator-case-model'
import { useDialogMotion } from './useDialogMotion'
import { display } from './operator-ui-utils'

export default function OperatorCaseSourcePicker({ workspace, kind, onClose, onSelect }: { workspace: OperatorWorkspace; kind: OperatorCaseKind; onClose: () => void; onSelect: (row: OperatorRefuelling) => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const { close, complete } = useDialogMotion(dialog, onClose)
  const [query, setQuery] = useState('')
  const candidates = workspace.refuellings.filter(row => {
    const claimed = (workspace.cases ?? []).filter(entry => entry.operationId === row.id).reduce((sum, entry) => sum.plus(entry.litres), new Decimal(0))
    return row.paid && (kind === 'return' ? claimed.lt(row.litres) : claimed.isZero()) && `${row.name} ${row.service} ${row.schemaVersion === 3 ? row.planClientName : ''}`.toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru'))
  })
  return <dialog ref={dialog} className="operator-dialog" aria-labelledby="case-source-title" onCancel={event => { event.preventDefault(); close() }}>
    <form onSubmit={event => event.preventDefault()}><header><h2 id="case-source-title">{kind === 'return' ? 'Из какой операции вернуть литры' : 'Какая заправка не состоялась'}</h2><button type="button" className="icon-button" aria-label="Закрыть выбор операции" onClick={close}><X size={20}/></button></header>
      <div className="operator-dialog-body"><label>Поиск водителя или клиента<input autoFocus value={query} onChange={event => setQuery(event.target.value)} /></label>
        <div className="operator-source-list">{candidates.map(row => <button type="button" className="operator-source-choice" key={row.id} onClick={() => void complete(() => onSelect(row))}><strong>{row.name}</strong><span>{row.date.split('-').reverse().join('.')} · {row.service} · {display(row.litres)} л</span><span>{row.schemaVersion === 3 ? row.planClientName : 'Без задания'} · {display(row.amount, true)} ₽</span></button>)}</div>
        {!candidates.length && <p>Подходящих оплаченных операций нет. Проверьте поиск и подтверждение оплаты.</p>}
      </div><footer><button type="button" className="button" onClick={close}>Закрыть</button></footer>
    </form>
  </dialog>
}

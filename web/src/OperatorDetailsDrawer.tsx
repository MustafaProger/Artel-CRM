import { useId, useRef, type KeyboardEvent, type ReactNode } from 'react'
import { Info, X } from 'lucide-react'
import { useDialogMotion } from './useDialogMotion'
import './operator-details.css'

export function OperatorDetailsButton({ label, onClick }: { label: string; onClick: () => void }) {
  return <button type="button" className="icon-button operator-details-button" aria-label={label} title="Подробная информация" aria-haspopup="dialog" onClick={event => { event.currentTarget.focus({ preventScroll: true }); onClick() }}><Info size={19} aria-hidden="true"/></button>
}

export default function OperatorDetailsDrawer({ title, onClose, children }: {
  title: string; onClose: () => void; children: (navigate: (action: () => void) => void) => ReactNode
}) {
  const dialog = useRef<HTMLDialogElement>(null), titleId = useId(), backdropDown = useRef(false)
  const { close, complete } = useDialogMotion(dialog, onClose)
  const outside = (event: { clientX: number; clientY: number }) => {
    const box = dialog.current!.getBoundingClientRect()
    return event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom
  }
  const trapFocus = (event: KeyboardEvent<HTMLDialogElement>) => {
    if (event.key !== 'Tab') return
    const controls = Array.from(event.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], summary, [tabindex="0"]')).filter(node => node.getClientRects().length > 0)
    const first = controls[0], last = controls.at(-1)
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
  }
  const navigate = (action: () => void) => { void complete(() => { onClose(); action() }) }
  return <dialog ref={dialog} className="operator-details-drawer" aria-labelledby={titleId}
    onKeyDown={trapFocus}
    onCancel={event => { event.preventDefault(); close() }}
    onPointerDown={event => { backdropDown.current = event.target === event.currentTarget && outside(event) }}
    onClick={event => { if (backdropDown.current && event.target === event.currentTarget && outside(event)) close(); backdropDown.current = false }}>
    <header className="operator-details-heading"><h2 id={titleId}>{title}</h2><button type="button" className="icon-button" aria-label="Закрыть подробности" onClick={close}><X size={20} aria-hidden="true"/></button></header>
    <div className="operator-details-body">{children(navigate)}</div>
  </dialog>
}

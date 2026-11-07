import { useRef, useState } from 'react'
import { apiFetch } from './workspace-api'
import { isDefinitiveOperatorRejection, readWorkspace } from './operator-ui-utils'
import type { OperatorRefuelling, OperatorWorkspace } from './operator-model'

type PaymentRequest = { id: string; body: string; version: number; uncertain: boolean }

/** Keep an unknown write's exact idempotency key until authoritative read-back. */
export function useOperatorPayment(onRead: (workspace: OperatorWorkspace) => void) {
  const lock = useRef(false), request = useRef<PaymentRequest | null>(null)
  const [busy, setBusy] = useState(false), [pending, setPending] = useState(false), [error, setError] = useState('')
  const submit = async () => {
    const current = request.current
    if (lock.current || !current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const response = await apiFetch(`/api/operator/refuellings/${current.id}/payment`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: current.body, signal: AbortSignal.timeout(20000),
      })
      const result = await response.json()
      if (!response.ok) {
        if (isDefinitiveOperatorRejection(response.status, result.error, current.uncertain)) {
          request.current = null; setPending(false)
          try { onRead(await readWorkspace()) } catch { /* Keep the last confirmed state. */ }
        } else { current.uncertain = true; setPending(true) }
        setError(result.error || 'Сохранение отметки оплаты не подтверждено.'); return
      }
      current.uncertain = true
      const next = await readWorkspace(), row = next.refuellings.find(item => item.id === current.id)
      if (row && row.version <= current.version) throw new Error('Запись пока не подтверждена')
      onRead(next); request.current = null; setPending(false)
    } catch {
      current.uncertain = true; setPending(true)
      setError('Ответ не получен. Отметка пока не подтверждена. Нажмите «Проверить сохранение оплаты»: повторится тот же запрос.')
    } finally { lock.current = false; setBusy(false) }
  }
  const change = async (row: OperatorRefuelling) => {
    if (lock.current || request.current) return
    request.current = { id: row.id, version: row.version, uncertain: false, body: JSON.stringify({ version: row.version, paid: !row.paid, idempotencyKey: crypto.randomUUID() }) }
    await submit()
  }
  return { change, retry: submit, busy, pending, error, disabled: busy || pending }
}

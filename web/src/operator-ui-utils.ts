import Decimal from 'decimal.js'
import { apiFetch } from './workspace-api'
import type { OperatorWorkspace } from './operator-model'

export const display = (value: string, money = false) => {
  const [whole, fraction] = new Decimal(value).toFixed(money ? 2 : undefined).split('.')
  return whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + (fraction ? ',' + fraction : '')
}

export async function readWorkspace(): Promise<OperatorWorkspace> {
  const response = await apiFetch('/api/operator', { cache: 'no-store', signal: AbortSignal.timeout(15000) })
  const body = await response.json()
  if (!response.ok) throw new Error(body.error || 'Не удалось загрузить операторскую.')
  return body
}


/** Replay lookup precedes validation/version checks. Auth, proxy and key-conflict rejections cannot resolve an earlier unknown result. */
export function isDefinitiveOperatorRejection(status: number, error: unknown, wasUncertain: boolean) {
  return status < 500 && (!wasUncertain || [400, 409].includes(status) && typeof error === 'string' && !/ключ/i.test(error))
}

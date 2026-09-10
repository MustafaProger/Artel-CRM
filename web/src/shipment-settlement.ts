import type { ShipmentSettlement } from './model'

export function settlementKind(paymentForm: string | null | undefined): Exclude<ShipmentSettlement, 'all'> {
  const value = (paymentForm ?? '').normalize('NFKC').toLocaleLowerCase('ru').replace(/[\s./_-]/g, '')
  if (['бнал', 'безнал', 'безналичный', 'cashless'].includes(value)) return 'cashless'
  if (['нал', 'наличный', 'наличные', 'cash'].includes(value)) return 'cash'
  if (['ф2', 'f2'].includes(value)) return 'f2'
  return 'unspecified'
}

import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { OperationsData } from './operations-store';
import type { Snapshot } from '../web/src/model';
import { ApiError } from './api-error';
/** Bank integration extension point. Call only inside OperationsStore.mutate.
 * One allocation per payment/shipment pair, with an idempotent repeated match.
 * No endpoint or automatic matching is enabled in this iteration.
 */
export function allocatePayment(snapshot: Snapshot, data: OperationsData, shipmentId: string, paymentId: string, amount: string) {
  const payment = snapshot.payments.find(p => p.id === paymentId);
  if (!snapshot.shipments.some(s => s.id === shipmentId) || !payment?.date || !payment.incoming) throw new ApiError(400,'Нужны отгрузка и входящий платёж с корректной датой.');
  if (!/^\d+(?:\.\d+)?$/.test(amount) || !new Decimal(amount).gt(0)) throw new ApiError(400,'Сумма распределения должна быть положительной.');
  const allocations = data.paymentAllocations ??= [];
  const existing = allocations.find(a => a.shipmentId === shipmentId && a.paymentId === paymentId);
  if (existing) {
    if (!new Decimal(existing.amount).eq(amount)) throw new ApiError(409,'Этот платёж уже связан с отгрузкой на другую сумму.');
    return { allocation: existing, created: false };
  }
  const allocated = allocations.filter(a => a.paymentId === paymentId).reduce((sum,a) => sum.plus(a.amount),new Decimal(0));
  if (allocated.plus(amount).gt(payment.incoming)) throw new ApiError(400,'Распределение превышает сумму входящего платежа.');
  const allocation = { id:`allocation-${randomUUID()}`,shipmentId,paymentId,amount:new Decimal(amount).toFixed(),date:payment.date };
  allocations.push(allocation);
  return { allocation, created: true };
}

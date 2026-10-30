import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { ApiError } from './api-error';
import type { AccountUser } from '../web/src/auth-model';
import type { OperatorData, OperatorRefuelling } from '../web/src/operator-model';
import type { OperatorCase, OperatorCaseSummary, OperatorCaseSource, OperatorCarryover } from '../web/src/operator-case-model';

const D = Decimal.clone({ precision: 60, rounding: Decimal.ROUND_HALF_UP });
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, 'Есть неизвестные параметры возврата или остатка.');
}
function quantity(value: unknown): string {
  const text = typeof value === 'string' ? value.trim().replace(',', '.') : '';
  if (text.length > 40 || !/^\d+(?:\.\d{1,6})?$/.test(text) || new D(text).lte(0) || new D(text).gt('1000000000000')) throw new ApiError(400, 'Укажите положительный литраж, до шести знаков после запятой.');
  return new D(text).toFixed();
}
function taskFields(body: Record<string, unknown>) {
  const dueDate = body.dueDate;
  if (typeof dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(Date.parse(dueDate)) || new Date(dueDate).toISOString().slice(0, 10) !== dueDate) throw new ApiError(400, 'Укажите существующую дату задания.');
  const comment = body.comment;
  if (typeof comment !== 'string' || comment.length > 2000 || [...comment].some(c => c.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(c))) throw new ApiError(400, 'Комментарий задания должен содержать не более 2000 символов.');
  return { dueDate, comment: comment.trim() };
}
function sourceOf(row: OperatorRefuelling): OperatorCaseSource {
  return { operationVersion: row.version, driverName: row.name, date: row.date, service: row.service, litres: row.litres, pricePerLitre: row.pricePerLitre, discountPercent: row.discountPercent, amount: row.amount };
}
function valueOf(source: OperatorCaseSource, litres: string | Decimal): string {
  return new D(litres).times(source.pricePerLitre).times(new D(1).minus(new D(source.discountPercent).div(100))).toFixed(2);
}
export function operatorCaseSummary(row: OperatorCase): OperatorCaseSummary {
  const settled = row.settlements.reduce((sum, event) => sum.plus(event.litres), new D(0));
  const remaining = new D(row.litres).minus(settled);
  return { ...row, remainingLitres: remaining.toFixed(), remainingAmount: new D(row.amount).minus(row.settlements.reduce((sum, event) => sum.plus(event.amount), new D(0))).toFixed(2), status: remaining.isZero() ? 'completed' : 'open' };
}
/** Completed claims still count: settlement never permits the source to issue those litres again. */
function claimed(state: OperatorData, operationId: string) {
  return Object.values(state.cases ?? {}).filter(row => row.operationId === operationId).reduce((sum, row) => sum.plus(row.litres), new D(0));
}
export function assertOperatorOperationMutable(state: OperatorData, row: OperatorRefuelling) {
  if (row.schemaVersion === 3 && row.carryovers?.length || Object.values(state.cases ?? {}).some(item => item.operationId === row.id)) throw new ApiError(409, 'Операция связана с возвратом или зачётом остатка. Её сумму, реквизиты и оплату нельзя менять или удалять: сохранена история исполнения.');
}
export function createOperatorCase(state: OperatorData, body: Record<string, unknown>, actor: AccountUser, id: string, now: string) {
  keys(body, ['operationId', 'operationVersion', 'kind', 'litres', 'idempotencyKey']);
  const source = typeof body.operationId === 'string' && uuid.test(body.operationId) ? state.refuellings[body.operationId] : undefined;
  if (!source || source.deletedAt) throw new ApiError(404, 'Исходная операция не найдена.');
  if (!source.paid) throw new ApiError(409, 'Сначала подтвердите оплату исходной операции.');
  if (body.operationVersion !== source.version) throw new ApiError(409, 'Исходная операция изменилась. Обновите список.');
  if (body.kind !== 'return' && body.kind !== 'deferred') throw new ApiError(400, 'Выберите возврат или ожидание заправки.');
  if (body.kind === 'deferred' && Object.hasOwn(body, 'litres')) throw new ApiError(400, 'В ожидание заправки переносится весь литраж исходной операции.');
  const litres = quantity(body.kind === 'deferred' ? source.litres : body.litres);
  if (claimed(state, source.id).plus(litres).gt(source.litres)) throw new ApiError(409, 'Литраж превышает ещё не учтённую часть исходной операции. Уже созданные возвраты и ожидания, включая выполненные, учитываются.');
  const snapshot = sourceOf(source);
  const row: OperatorCase = { id, version: 1, kind: body.kind, operationId: source.id, source: snapshot, litres, amount: valueOf(snapshot, litres), createdAt: now, updatedAt: now, createdBy: actor.id, createdByName: actor.name, settlements: [] };
  (state.cases ??= {})[id] = row;
  return row;
}
function settle(state: OperatorData, row: OperatorCase, method: 'money' | 'fuel' | 'carryover', litres: string, actor: AccountUser, now: string, operationId?: string, settlementId: string = randomUUID(), creditAmount?: string) {
  const before = operatorCaseSummary(row);
  if (new D(litres).gt(before.remainingLitres)) throw new ApiError(409, 'Литраж превышает доступный остаток. Обновите список.');
  const amount = creditAmount ?? new D(before.remainingAmount).times(litres).div(before.remainingLitres).toFixed(2);
  row.settlements.push({ id: settlementId, method, litres, amount, valuation: 'money', at: now, actorId: actor.id, actorName: actor.name, ...(operationId ? { operationId } : {}) });
  row.version++; row.updatedAt = now;
  state.cases![row.id] = row;
}
export function settleOperatorCase(state: OperatorData, body: Record<string, unknown>, actor: AccountUser, id: string, now: string) {
  keys(body, ['version', 'method', 'litres', 'idempotencyKey']);
  const row = state.cases?.[id];
  if (!row) throw new ApiError(404, 'Возврат или остаток не найден.');
  if (row.version !== body.version) throw new ApiError(409, 'Остаток изменён другим сотрудником. Обновите список.');
  const summary = operatorCaseSummary(row);
  if (summary.status === 'completed') throw new ApiError(409, 'Остаток уже исполнен.');
  if (body.method !== 'money' && body.method !== 'fuel') throw new ApiError(400, 'Выберите возврат денег или заправку.');
  if (body.method === 'money' && (row.kind !== 'return' || Object.hasOwn(body, 'litres'))) throw new ApiError(400, 'Деньгами закрывается весь оставшийся возврат. Для ожидания заправки отметьте фактическую заправку.');
  const litres = body.method === 'money' ? summary.remainingLitres : quantity(body.litres);
  settle(state, row, body.method, litres, actor, now);
}
export function scheduleOperatorCaseTask(state: OperatorData, body: Record<string, unknown>, actor: AccountUser, id: string, now: string) {
  keys(body, ['version', 'dueDate', 'comment', 'idempotencyKey']);
  const row = state.cases?.[id];
  if (!row) throw new ApiError(404, 'Возврат или остаток не найден.');
  if (row.version !== body.version) throw new ApiError(409, 'Остаток изменён другим сотрудником. Обновите список.');
  if (operatorCaseSummary(row).status !== 'open') throw new ApiError(409, 'Возврат или остаток уже исполнен. Задание нельзя перенести.');
  const fields = taskFields(body);
  (row.taskHistory ??= []).push({ id: randomUUID(), ...fields, at: now, actorId: actor.id, actorName: actor.name });
  row.task = { ...fields, createdAt: row.task?.createdAt ?? now, createdBy: row.task?.createdBy ?? actor.id, createdByName: row.task?.createdByName ?? actor.name, updatedAt: now, updatedBy: actor.id, updatedByName: actor.name };
  row.version++; row.updatedAt = now;
}
/** Preparation is read-only; debit is committed only after the new operation and allocations pass validation. */
export function prepareOperatorCarryovers(state: OperatorData, body: Record<string, unknown>) {
  if (body.carryovers === undefined) return undefined;
  if (!Array.isArray(body.carryovers) || !body.carryovers.length || body.carryovers.length > 50) throw new ApiError(400, 'Выберите от одного до 50 остатков для зачёта.');
  quantity(body.litres);
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  const ids = new Set<string>();
  const carryovers: OperatorCarryover[] = body.carryovers.map(value => {
    if (!object(value)) throw new ApiError(400, 'Некорректный остаток для зачёта.');
    keys(value, ['caseId', 'version', 'litres', 'amount']);
    const row = typeof value.caseId === 'string' && uuid.test(value.caseId) ? state.cases?.[value.caseId] : undefined;
    if (!row || ids.has(row.id)) throw new ApiError(400, 'Остаток не найден или указан дважды.');
    ids.add(row.id);
    if (value.version !== row.version) throw new ApiError(409, 'Остаток изменён другим сотрудником. Обновите список.');
    if (name !== row.source.driverName) throw new ApiError(400, 'Остаток можно зачесть только водителю, указанному в исходной операции.');
    const summary = operatorCaseSummary(row);
    if (summary.status !== 'open' || new D(summary.remainingAmount).lte(0)) throw new ApiError(409, 'Остаток уже использован.');
    if ((value.amount === undefined) === (value.litres === undefined)) throw new ApiError(400, 'Укажите сумму остатка.');
    let litres: string, amount: string;
    if (value.amount !== undefined) {
      if (typeof value.amount !== 'string' || !/^\d+(?:[.,]\d{1,2})?$/.test(value.amount) || value.amount.length > 40) throw new ApiError(400, 'Укажите сумму остатка с точностью до копеек.');
      amount = new D(value.amount.replace(',', '.')).toFixed(2);
      if (new D(amount).lte(0) || new D(amount).gt(summary.remainingAmount)) throw new ApiError(409, 'Сумма превышает денежный остаток водителя.');
      litres = new D(summary.remainingLitres).times(amount).div(summary.remainingAmount).toDecimalPlaces(6).toFixed();
      if (new D(litres).lte(0) || new D(litres).eq(summary.remainingLitres) && !new D(amount).eq(summary.remainingAmount)) throw new ApiError(400, 'Для этой суммы недостаточно точности литража; используйте весь остаток.');
    } else {
      litres = quantity(value.litres);
      if (new D(litres).gt(summary.remainingLitres)) throw new ApiError(409, 'Для зачёта недостаточно оставшихся литров.');
      amount = new D(summary.remainingAmount).times(litres).div(summary.remainingLitres).toFixed(2);
    }
    return { caseId: row.id, settlementId: randomUUID(), litres, amount, driverName: row.source.driverName };
  });
  return { carryovers, carryoverMode: 'money' as const, creditedAmount: carryovers.reduce((sum, row) => sum.plus(row.amount!), new D(0)).toFixed(2) };
}

export function commitOperatorCarryovers(state: OperatorData, carryovers: OperatorCarryover[], operationId: string, actor: AccountUser, now: string) {
  for (const row of carryovers) settle(state, state.cases![row.caseId], 'carryover', row.litres, actor, now, operationId, row.settlementId, row.amount);
}
/** Optional extension: old stores are accepted without creating or changing any records. */
export function validateOperatorCases(state: OperatorData) {
  if (state.cases !== undefined && !object(state.cases)) throw new Error('Invalid operator cases');
  const eventIds = new Set<string>();
  for (const [id, row] of Object.entries(state.cases ?? {})) {
    if (!object(row) || row.id !== id || !uuid.test(id) || !['return', 'deferred'].includes(row.kind) || !Number.isSafeInteger(row.version) || row.version < 1 || !date(row.createdAt) || !date(row.updatedAt) || typeof row.createdBy !== 'string' || !row.createdBy || typeof row.createdByName !== 'string' || !row.createdByName || !Array.isArray(row.settlements)) throw new Error('Invalid operator case metadata');
    keys(row, ['id', 'version', 'kind', 'operationId', 'source', 'litres', 'amount', 'createdAt', 'updatedAt', 'createdBy', 'createdByName', 'settlements', 'task', 'taskHistory']);
    if (row.task !== undefined || row.taskHistory !== undefined) {
      if (!object(row.task) || !Array.isArray(row.taskHistory) || !row.taskHistory.length) throw new Error('Invalid operator case task');
      keys(row.task, ['dueDate', 'comment', 'createdAt', 'createdBy', 'createdByName', 'updatedAt', 'updatedBy', 'updatedByName']);
      for (const event of row.taskHistory) {
        if (!object(event) || !uuid.test(event.id) || eventIds.has(event.id) || !date(event.at) || typeof event.actorId !== 'string' || !event.actorId || typeof event.actorName !== 'string' || !event.actorName) throw new Error('Invalid operator case task history');
        keys(event, ['id', 'dueDate', 'comment', 'at', 'actorId', 'actorName']);
        const fields = taskFields(event);
        if (fields.comment !== event.comment) throw new Error('Invalid operator case task comment');
        eventIds.add(event.id);
      }
      const first = row.taskHistory[0], last = row.taskHistory.at(-1)!;
      if (row.task.dueDate !== last.dueDate || row.task.comment !== last.comment || row.task.createdAt !== first.at || row.task.createdBy !== first.actorId || row.task.createdByName !== first.actorName || row.task.updatedAt !== last.at || row.task.updatedBy !== last.actorId || row.task.updatedByName !== last.actorName) throw new Error('Invalid operator case task snapshot');
    }
    if (row.version !== row.settlements.length + (row.taskHistory?.length ?? 0) + 1) throw new Error('Invalid operator case version');
    const source = state.refuellings[row.operationId];
    if (!source || source.deletedAt || !object(row.source)) throw new Error('Invalid operator case source');
    const snapshot = sourceOf(source);
    keys(row.source, Object.keys(snapshot));
    if (( !Number.isSafeInteger(row.source.operationVersion) || row.source.operationVersion < 1 || row.source.operationVersion > source.version || Object.entries(snapshot).some(([key, value]) => key !== 'operationVersion' && row.source[key as keyof OperatorCaseSource] !== value)) || quantity(row.litres) !== row.litres || row.amount !== valueOf(row.source, row.litres) || row.kind === 'deferred' && !new D(row.litres).eq(source.litres)) throw new Error('Invalid operator case snapshot');
    let consumed = new D(0), consumedMoney = new D(0);
    for (const event of row.settlements) {
      if (!object(event) || !uuid.test(event.id) || eventIds.has(event.id) || !['money', 'fuel', 'carryover'].includes(event.method) || !date(event.at) || typeof event.actorId !== 'string' || !event.actorId || typeof event.actorName !== 'string' || !event.actorName || quantity(event.litres) !== event.litres) throw new Error('Invalid operator case settlement');
      keys(event, ['id', 'method', 'litres', 'amount', 'at', 'actorId', 'actorName', 'valuation', ...(event.method === 'carryover' ? ['operationId'] : [])]);
      eventIds.add(event.id);
      const next = consumed.plus(event.litres);
      const remainingMoney = new D(row.amount).minus(consumedMoney), remainingLitres = new D(row.litres).minus(consumed);
      const monetary = event.valuation === 'money';
      if (event.valuation !== undefined && !monetary || typeof event.amount !== 'string' || !/^\d+\.\d{2}$/.test(event.amount) || next.gt(row.litres) || new D(event.amount).gt(remainingMoney)) throw new Error('Invalid operator case balance');
      const expected = monetary ? remainingMoney.times(event.litres).div(remainingLitres).toFixed(2) : new D(valueOf(row.source, next)).minus(valueOf(row.source, consumed)).toFixed(2);
      if (monetary && event.method === 'carryover') {
        if (event.amount !== expected && !remainingLitres.times(event.amount).div(remainingMoney).toDecimalPlaces(6).eq(event.litres) || next.eq(row.litres) && !new D(event.amount).eq(remainingMoney)) throw new Error('Invalid monetary carryover quantity');
      } else if (event.amount !== expected) throw new Error('Invalid settlement valuation');
      if (event.method === 'money' && (row.kind !== 'return' || !next.eq(row.litres))) throw new Error('Invalid money settlement');
      consumedMoney = consumedMoney.plus(event.amount);
      if (event.method === 'carryover') {
        const operation = event.operationId ? state.refuellings[event.operationId] : undefined;
        if (!operation || operation.schemaVersion !== 3 || operation.deletedAt || !operation.carryovers?.some(credit => credit.caseId === id && credit.settlementId === event.id && credit.litres === event.litres && credit.driverName === row.source.driverName)) throw new Error('Invalid operator carryover settlement');
      }
      consumed = next;
    }
    const settlementAt = row.settlements.at(-1)?.at ?? row.createdAt, taskAt = row.taskHistory?.at(-1)?.at;
    const updatedAt = taskAt && Date.parse(taskAt) > Date.parse(settlementAt) ? taskAt : settlementAt;
    if (row.updatedAt !== updatedAt || claimed(state, row.operationId).gt(source.litres)) throw new Error('Invalid operator total claimed volume');
  }
  for (const operation of Object.values(state.refuellings)) {
    if (operation.schemaVersion !== 3) {
      if (Object.hasOwn(operation, 'carryovers') || Object.hasOwn(operation, 'payableLitres') || Object.hasOwn(operation, 'carryoverMode') || Object.hasOwn(operation, 'creditedAmount')) throw new Error('Invalid legacy carryover');
      continue;
    }
    if (operation.carryovers === undefined && operation.payableLitres === undefined && operation.carryoverMode === undefined && operation.creditedAmount === undefined) continue;
    if (!Array.isArray(operation.carryovers) || !operation.carryovers.length || operation.carryovers.length > 50 || operation.deletedAt || (operation.carryoverMode === undefined ? quantity(operation.payableLitres) !== operation.payableLitres : operation.carryoverMode !== 'money' || operation.payableLitres !== undefined)) throw new Error('Invalid operator carryovers');
    const ids = new Set<string>();
    let credited = new D(0), creditedMoney = new D(0);
    for (const credit of operation.carryovers) {
      if (!object(credit)) throw new Error('Invalid operator carryover');
      keys(credit, ['caseId', 'settlementId', 'litres', 'driverName', 'amount']);
      const row = state.cases?.[credit.caseId];
      const event = row?.settlements.find(item => item.id === credit.settlementId);
      if (!row || ids.has(row.id) || !event || event.method !== 'carryover' || event.operationId !== operation.id || event.litres !== credit.litres || credit.driverName !== row.source.driverName || credit.driverName !== operation.name) throw new Error('Invalid operator carryover link');
      if (operation.carryoverMode === 'money') {
        if (credit.amount !== event.amount || event.valuation !== 'money') throw new Error('Invalid monetary carryover value');
        creditedMoney = creditedMoney.plus(credit.amount!);
      } else if (credit.amount !== undefined) throw new Error('Invalid legacy credit');
      ids.add(row.id); credited = credited.plus(quantity(credit.litres));
    }
    if (operation.carryoverMode === 'money' ? creditedMoney.toFixed(2) !== operation.creditedAmount : !new D(operation.litres).minus(credited).eq(operation.payableLitres!)) throw new Error('Invalid operator payable volume');
  }
}

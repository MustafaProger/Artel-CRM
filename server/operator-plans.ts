import Decimal from 'decimal.js';
import { ApiError } from './api-error';
import { operatorManagerNames } from '../web/src/operator-model';
import type { OperatorAllocation, OperatorData, OperatorManagerId, OperatorPlan, OperatorPlanRecipient, OperatorPlanSummary, OperatorRecipientFields, OperatorRefuelling } from '../web/src/operator-model';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const recipientKeys = ['name', 'bank', 'card', 'phone', 'details'];
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new ApiError(400, 'Есть неизвестные параметры задания или распределения.');
}
function text(value: unknown, required = false, max = 500) {
  if (typeof value !== 'string' || value.length > max || [...value].some(char => char.charCodeAt(0) < 32 && !['\n', '\r', '\t'].includes(char)) || required && !value.trim()) throw new ApiError(400, 'Проверьте клиента и реквизиты задания.');
  return value.trim();
}
function money(value: unknown) {
  const raw = typeof value === 'string' ? value.trim().replace(',', '.') : '';
  if (raw.length > 40 || !/^\d+(?:\.\d{1,2})?$/.test(raw)) throw new ApiError(400, 'Укажите положительную сумму, не более двух знаков после запятой.');
  const parsed = new Decimal(raw);
  if (parsed.lte(0) || parsed.gt('1000000000000')) throw new ApiError(400, 'Недопустимая сумма задания или распределения.');
  return parsed.toFixed(2);
}
function manager(value: unknown): OperatorManagerId {
  if (value !== 'aidar' && value !== 'eldar') throw new ApiError(400, 'Выберите Айдара или Эльдара.');
  return value;
}
function recipientSnapshot(row: Record<string, unknown>): OperatorRecipientFields {
  const recipient = { name: text(row.name, true), bank: text(row.bank, true), card: text(row.card), phone: text(row.phone), details: text(row.details, false, 2000) };
  if (!recipient.card && !recipient.phone && !recipient.details) throw new ApiError(400, 'Укажите номер карты, телефон или другие реквизиты получателя.');
  return recipient;
}
export function operatorPlanFields(body: Record<string, unknown>): Pick<OperatorPlan, 'clientName' | 'managerId' | 'recipients'> {
  const clientName = text(body.clientName, true);
  const managerId = body.managerId === undefined ? undefined : manager(body.managerId);
  if (!Array.isArray(body.recipients) || !body.recipients.length || body.recipients.length > 50) throw new ApiError(400, 'Добавьте от 1 до 50 получателей задания.');
  const ids = new Set<string>();
  const recipients = body.recipients.map((row): OperatorPlanRecipient => {
    if (!object(row) || typeof row.id !== 'string' || !uuid.test(row.id) || ids.has(row.id)) throw new ApiError(400, 'Некорректный или повторяющийся получатель задания.');
    keys(row, ['id', ...recipientKeys, 'limit']);
    ids.add(row.id);
    return { id: row.id, ...recipientSnapshot(row), limit: money(row.limit) };
  });
  return { clientName, ...(managerId === undefined ? {} : { managerId }), recipients };
}
export function operatorUsageIndex(state: OperatorData, excludeId?: string) {
  const index = new Map<string, { amounts: Map<string, Decimal>; managerAmount: Decimal }>();
  for (const row of Object.values(state.refuellings)) {
    if (row.schemaVersion !== 3 || row.deletedAt || row.id === excludeId) continue;
    for (const allocation of row.allocations) {
      const planId = allocation.planId ?? row.planId;
      let entry = index.get(planId);
      if (!entry) { entry = { amounts: new Map(), managerAmount: new Decimal(0) }; index.set(planId, entry); }
      if (allocation.kind === 'manager') entry.managerAmount = entry.managerAmount.plus(allocation.amount);
      else entry.amounts.set(allocation.recipientId, (entry.amounts.get(allocation.recipientId) ?? new Decimal(0)).plus(allocation.amount));
    }
  }
  return index;
}
function usage(state: OperatorData, planId: string) {
  return operatorUsageIndex(state).get(planId) ?? { amounts: new Map<string, Decimal>(), managerAmount: new Decimal(0) };
}
/** Keep the operation snapshots and existing overflow accounting intact during plan edits. */
export function validateOperatorPlanEdit(state: OperatorData, prior: OperatorPlan, fields: Pick<OperatorPlan, 'clientName' | 'recipients'>) {
  const { amounts } = usage(state, prior.id);
  if (Object.values(state.refuellings).some(row => row.schemaVersion === 3 && !row.deletedAt && (row.planId === prior.id || row.allocations.some(item => item.planId === prior.id))) && fields.clientName !== prior.clientName) throw new ApiError(409, 'По заданию уже есть операции. Клиента нельзя изменить: он сохранён в истории операций.');
  for (const [id] of amounts) {
    const before = prior.recipients.find(row => row.id === id)!;
    const after = fields.recipients.find(row => row.id === id);
    if (!after || recipientKeys.some(key => before[key as keyof OperatorRecipientFields] !== after[key as keyof OperatorRecipientFields])) throw new ApiError(409, 'Реквизиты уже используются в операциях. Их нельзя удалить или изменить; можно изменить лимит.');
  }
}
export function operatorPlanSummary(state: OperatorData, plan: OperatorPlan, index = operatorUsageIndex(state)): OperatorPlanSummary {
  const { amounts } = index.get(plan.id) ?? { amounts: new Map<string, Decimal>() };
  const recipients = plan.recipients.map(row => ({ ...row, used: (amounts.get(row.id) ?? new Decimal(0)).toFixed(2), remaining: new Decimal(row.limit).minus(amounts.get(row.id) ?? 0).toFixed(2) }));
  const totalLimit = recipients.reduce((sum, row) => sum.plus(row.limit), new Decimal(0));
  const allocated = recipients.reduce((sum, row) => sum.plus(row.used), new Decimal(0));
  const remaining = totalLimit.minus(allocated);
  return { ...plan, recipients, totalLimit: totalLimit.toFixed(2), allocated: allocated.toFixed(2), remaining: remaining.toFixed(2), status: remaining.lte(0) ? 'completed' : 'active' };
}
export function operatorAllocationText(allocations: OperatorAllocation[]) {
  return allocations.map(row => row.kind === 'manager'
    ? `${operatorManagerNames[row.managerId]} — ${row.amount} ₽ (остаток менеджеру)`
    : `${[row.recipient.name, row.recipient.bank, row.recipient.card, row.recipient.phone, row.recipient.details].filter(Boolean).join(' · ')} — ${row.amount} ₽`).join('\n');
}
export function selectedOperatorAllocations(state: OperatorData, body: Record<string, unknown>, amount: string, prior?: OperatorRefuelling) {
  const plan = typeof body.planId === 'string' && uuid.test(body.planId) ? state.plans?.[body.planId] : undefined;
  if (!plan) throw new ApiError(400, 'Выберите задание из списка.');
  if (prior?.schemaVersion === 3 && prior.planId !== plan.id) throw new ApiError(400, 'Основное задание операции нельзя изменить.');
  if (body.planVersion !== plan.version) throw new ApiError(409, 'Задание изменилось. Обновите остатки.');
  if (!Array.isArray(body.allocations) || !body.allocations.length || body.allocations.length > 51) throw new ApiError(400, 'Добавьте от 1 до 51 распределения.');
  const touched = new Set([plan.id]);
  if (prior?.schemaVersion === 3) for (const item of prior.allocations) touched.add(item.planId ?? prior.planId);
  const ids = new Set<string>();
  const allocations = body.allocations.map((value): OperatorAllocation => {
    if (!object(value)) throw new ApiError(400, 'Некорректное распределение суммы.');
    const target = value.planId === undefined ? plan : typeof value.planId === 'string' && uuid.test(value.planId) ? state.plans?.[value.planId] : undefined;
    if (!target) throw new ApiError(400, 'Задание получателя не найдено.');
    if ((value.planVersion ?? (target.id === plan.id ? body.planVersion : undefined)) !== target.version) throw new ApiError(409, 'Задание получателя изменилось. Обновите остатки.');
    touched.add(target.id);
    const link = { planId: target.id, planClientName: target.clientName };
    if (value.kind === 'manager') {
      keys(value, ['kind', 'managerId', 'amount', 'planId', 'planVersion']);
      const managerId = manager(value.managerId), key = `${target.id}:manager:${managerId}`;
      if (ids.has(key)) throw new ApiError(400, 'Менеджер в задании указан дважды.');
      ids.add(key);
      return { ...link, kind: 'manager', managerId, amount: money(value.amount) };
    }
    keys(value, ['kind', 'recipientId', 'amount', 'planId', 'planVersion']);
    const recipient = target.recipients.find(row => row.id === value.recipientId);
    const key = `${target.id}:recipient:${value.recipientId}`;
    if (value.kind !== 'recipient' || !recipient || ids.has(key)) throw new ApiError(400, 'Получатель отсутствует в задании или указан дважды.');
    ids.add(key);
    return { ...link, kind: 'recipient', recipientId: recipient.id, amount: money(value.amount), recipient: recipientSnapshot({ ...recipient }) };
  });
  // A removed secondary allocation still changes that plan's totals. Its version
  // must be checked even though the plan is absent from the new allocations.
  if (body.planVersions !== undefined) {
    if (!object(body.planVersions) || Object.entries(body.planVersions).some(([id, version]) => !touched.has(id) || !Number.isSafeInteger(version) || state.plans?.[id]?.version !== version)) throw new ApiError(409, 'Затронутое задание изменилось. Обновите остатки.');
  }
  const retained = new Set([plan.id, ...allocations.map(row => row.planId ?? plan.id)]);
  for (const id of touched) {
    if (!retained.has(id) && (!object(body.planVersions) || body.planVersions[id] !== state.plans![id].version)) throw new ApiError(409, 'Исключаемое задание изменилось. Обновите остатки.');
  }
  if (!allocations.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).eq(amount)) throw new ApiError(400, 'Сумма распределения должна совпадать с суммой операции.');
  return { plan, touched: [...touched], allocations, recipientText: operatorAllocationText(allocations) };
}
/** Verify persisted links, immutable snapshots and accounting before accepting any store. */
export function validateOperatorPlans(state: OperatorData) {
  if (state.plans !== undefined && !object(state.plans)) throw new Error('Invalid operator plans');
  for (const [id, plan] of Object.entries(state.plans ?? {})) {
    if (!object(plan) || plan.id !== id || !uuid.test(id) || !Number.isSafeInteger(plan.version) || plan.version < 1 || typeof plan.createdBy !== 'string' || !plan.createdBy || !['createdAt', 'updatedAt'].every(key => typeof plan[key] === 'string' && Number.isFinite(Date.parse(plan[key] as string)))) throw new Error('Invalid operator plan metadata');
    keys(plan, ['id', 'version', 'clientName', 'managerId', 'recipients', 'createdAt', 'updatedAt', 'createdBy', 'createdByName']);
    if (plan.createdByName !== undefined && text(plan.createdByName, true) !== plan.createdByName) throw new Error('Invalid operator plan creator');
    const fields = operatorPlanFields(plan);
    if (JSON.stringify(fields.recipients) !== JSON.stringify(plan.recipients) || fields.clientName !== plan.clientName) throw new Error('Invalid operator plan values');
  }
  for (const row of Object.values(state.refuellings)) {
    if (row.schemaVersion !== 3) continue;
    const plan = typeof row.planId === 'string' && Object.hasOwn(state.plans ?? {}, row.planId) ? state.plans![row.planId] : undefined;
    if (!plan || (!row.deletedAt && row.planClientName !== plan.clientName) || text(row.planClientName, true) !== row.planClientName || !Array.isArray(row.allocations) || !row.allocations.length || row.allocations.length > 51) throw new Error('Invalid operator plan link');
    const ids = new Set<string>();

    for (const allocation of row.allocations) {
      if (!object(allocation) || money(allocation.amount) !== allocation.amount) throw new Error('Invalid allocation amount');
      if ((allocation.planId === undefined) !== (allocation.planClientName === undefined)) throw new Error('Incomplete allocation plan snapshot');
      const target = allocation.planId === undefined ? plan : state.plans?.[allocation.planId];
      if (!target || (allocation.planId !== undefined && (!uuid.test(allocation.planId) || text(allocation.planClientName, true) !== allocation.planClientName || !row.deletedAt && allocation.planClientName !== target.clientName))) throw new Error('Invalid allocation plan');
      const identity = `${target.id}:${allocation.kind}:${allocation.kind === 'manager' ? allocation.managerId : allocation.recipientId}`;
      if (ids.has(identity)) throw new Error('Duplicate allocation');
      ids.add(identity);
      if (allocation.kind === 'manager') {
        keys(allocation, ['kind', 'managerId', 'amount', 'planId', 'planClientName']);
        manager(allocation.managerId);

      } else {
        keys(allocation, ['kind', 'recipientId', 'amount', 'recipient', 'planId', 'planClientName']);
        if (allocation.kind !== 'recipient' || typeof allocation.recipientId !== 'string' || !uuid.test(allocation.recipientId)) throw new Error('Invalid recipient allocation');
        const recipient = target.recipients.find(item => item.id === allocation.recipientId);
        if ((!row.deletedAt && !recipient) || !object(allocation.recipient)) throw new Error('Invalid recipient link');
        keys(allocation.recipient, recipientKeys);
        // Deleted operations keep their original snapshots even when unused plan details are edited.
        const snapshot = recipientSnapshot({ ...(row.deletedAt ? allocation.recipient : recipient) });
        if (recipientKeys.some(key => allocation.recipient[key as keyof OperatorRecipientFields] !== snapshot[key as keyof OperatorRecipientFields])) throw new Error('Invalid recipient snapshot');

      }
    }
    if (!ids.size || !row.allocations.reduce((sum, allocation) => sum.plus(allocation.amount), new Decimal(0)).eq(row.amount) || row.recipientText !== operatorAllocationText(row.allocations)) throw new Error('Invalid allocation total or text');
  }
}

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
function usage(state: OperatorData, planId: string, excludeId?: string) {
  const amounts = new Map<string, Decimal>();
  let managerAmount = new Decimal(0);
  for (const row of Object.values(state.refuellings)) {
    if (row.schemaVersion !== 3 || row.deletedAt || row.planId !== planId || row.id === excludeId) continue;
    for (const allocation of row.allocations) {
      if (allocation.kind === 'manager') managerAmount = managerAmount.plus(allocation.amount);
      else amounts.set(allocation.recipientId, (amounts.get(allocation.recipientId) ?? new Decimal(0)).plus(allocation.amount));
    }
  }
  return { amounts, managerAmount };
}
/** Keep the operation snapshots and existing overflow accounting intact during plan edits. */
export function validateOperatorPlanEdit(state: OperatorData, prior: OperatorPlan, fields: Pick<OperatorPlan, 'clientName' | 'recipients'>) {
  const { amounts, managerAmount } = usage(state, prior.id);
  if (amounts.size && fields.clientName !== prior.clientName) throw new ApiError(409, 'По заданию уже есть операции. Клиента нельзя изменить: он сохранён в истории операций.');
  for (const [id, amount] of amounts) {
    const before = prior.recipients.find(row => row.id === id)!;
    const after = fields.recipients.find(row => row.id === id);
    if (!after || recipientKeys.some(key => before[key as keyof OperatorRecipientFields] !== after[key as keyof OperatorRecipientFields])) throw new ApiError(409, 'Реквизиты уже используются в операциях. Их нельзя удалить или изменить; можно изменить лимит.');
    if (amount.gt(after.limit)) throw new ApiError(409, `Лимит получателя «${after.name}» не может быть меньше уже распределённой суммы ${amount.toFixed(2)} ₽.`);
  }
  const remaining = fields.recipients.reduce((sum, row) => sum.plus(new Decimal(row.limit).minus(amounts.get(row.id) ?? 0)), new Decimal(0));
  if (managerAmount.gt(0) && !remaining.isZero()) throw new ApiError(409, 'По заданию уже указан остаток менеджеру. Изменение лимитов не должно создавать новый остаток по картам. Сначала исправьте соответствующую операцию.');
}
export function operatorPlanSummary(state: OperatorData, plan: OperatorPlan): OperatorPlanSummary {
  const { amounts } = usage(state, plan.id);
  const recipients = plan.recipients.map(row => ({ ...row, used: (amounts.get(row.id) ?? new Decimal(0)).toFixed(2), remaining: new Decimal(row.limit).minus(amounts.get(row.id) ?? 0).toFixed(2) }));
  const totalLimit = recipients.reduce((sum, row) => sum.plus(row.limit), new Decimal(0));
  const allocated = recipients.reduce((sum, row) => sum.plus(row.used), new Decimal(0));
  const remaining = totalLimit.minus(allocated);
  return { ...plan, recipients, totalLimit: totalLimit.toFixed(2), allocated: allocated.toFixed(2), remaining: remaining.toFixed(2), status: remaining.isZero() ? 'completed' : 'active' };
}
export function validateOperatorOperationDeletion(state: OperatorData, row: OperatorRefuelling) {
  if (row.schemaVersion !== 3) return;
  const plan = state.plans![row.planId];
  const { amounts, managerAmount } = usage(state, plan.id, row.id);
  const remaining = plan.recipients.reduce((sum, recipient) => sum.plus(new Decimal(recipient.limit).minus(amounts.get(recipient.id) ?? 0)), new Decimal(0));
  if (managerAmount.gt(0) && !remaining.isZero()) throw new ApiError(409, 'После удаления появится остаток по картам, но в другой операции уже указан остаток менеджеру. Сначала исправьте или удалите эту операцию.');
}
export function operatorAllocationText(allocations: OperatorAllocation[]) {
  return allocations.map(row => row.kind === 'manager'
    ? `${operatorManagerNames[row.managerId]} — ${row.amount} ₽ (остаток менеджеру)`
    : `${[row.recipient.name, row.recipient.bank, row.recipient.card, row.recipient.phone, row.recipient.details].filter(Boolean).join(' · ')} — ${row.amount} ₽`).join('\n');
}
export function selectedOperatorAllocations(state: OperatorData, body: Record<string, unknown>, amount: string, prior?: OperatorRefuelling) {
  const plan = typeof body.planId === 'string' && Object.hasOwn(state.plans ?? {}, body.planId) ? state.plans![body.planId] : undefined;
  if (!plan) throw new ApiError(400, 'Выберите задание из списка.');
  if (prior?.schemaVersion === 3 && prior.planId !== plan.id) throw new ApiError(400, 'Операцию нельзя перенести в другое задание.');
  if (body.planVersion !== plan.version) throw new ApiError(409, 'Задание изменилось. Обновите остатки и проверьте распределение перед сохранением.');
  if (!Array.isArray(body.allocations) || !body.allocations.length || body.allocations.length > 51) throw new ApiError(400, 'Добавьте получателей распределения.');
  const { amounts, managerAmount } = usage(state, plan.id, prior?.id);
  const ids = new Set<string>();
  let managerCount = 0;
  const allocations = body.allocations.map((value): OperatorAllocation => {
    if (!object(value)) throw new ApiError(400, 'Некорректное распределение суммы.');
    if (value.kind === 'manager') {
      keys(value, ['kind', 'managerId', 'amount']);
      if (++managerCount > 1) throw new ApiError(400, 'Остаток можно направить одному менеджеру.');
      return { kind: 'manager', managerId: manager(value.managerId), amount: money(value.amount) };
    }
    if (value.kind !== 'recipient' || typeof value.recipientId !== 'string' || ids.has(value.recipientId)) throw new ApiError(400, 'Получатель распределения некорректен или повторяется.');
    keys(value, ['kind', 'recipientId', 'amount']);
    const recipient = plan.recipients.find(row => row.id === value.recipientId);
    if (!recipient) throw new ApiError(400, 'Получатель отсутствует в выбранном задании.');
    ids.add(recipient.id);
    const allocationAmount = money(value.amount);
    const used = (amounts.get(recipient.id) ?? new Decimal(0)).plus(allocationAmount);
    if (used.gt(recipient.limit)) throw new ApiError(409, 'Сумма превышает остаток получателя. Обновите остатки и проверьте распределение.');
    amounts.set(recipient.id, used);
    return { kind: 'recipient', recipientId: recipient.id, amount: allocationAmount, recipient: recipientSnapshot({ ...recipient }) };
  });
  if (!ids.size) throw new ApiError(400, 'Добавьте сумму хотя бы на одни реквизиты задания.');
  if (!allocations.reduce((sum, row) => sum.plus(row.amount), new Decimal(0)).eq(amount)) throw new ApiError(400, 'Сумма распределения должна совпадать с суммой операции.');
  const remaining = plan.recipients.reduce((sum, row) => sum.plus(new Decimal(row.limit).minus(amounts.get(row.id) ?? 0)), new Decimal(0));
  if (!remaining.isZero() && (managerCount > 0 || managerAmount.gt(0))) throw new ApiError(409, 'Остаток менеджеру допустим только после исчерпания всех лимитов задания. Проверьте также другие операции с остатком менеджеру.');
  return { plan, allocations, recipientText: operatorAllocationText(allocations) };
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
    let managers = 0;
    for (const allocation of row.allocations) {
      if (!object(allocation) || money(allocation.amount) !== allocation.amount) throw new Error('Invalid allocation amount');
      if (allocation.kind === 'manager') {
        keys(allocation, ['kind', 'managerId', 'amount']);
        manager(allocation.managerId);
        if (++managers > 1) throw new Error('Invalid manager allocation');
      } else {
        keys(allocation, ['kind', 'recipientId', 'amount', 'recipient']);
        if (allocation.kind !== 'recipient' || typeof allocation.recipientId !== 'string' || !uuid.test(allocation.recipientId) || ids.has(allocation.recipientId)) throw new Error('Invalid recipient allocation');
        const recipient = plan.recipients.find(item => item.id === allocation.recipientId);
        if ((!row.deletedAt && !recipient) || !object(allocation.recipient)) throw new Error('Invalid recipient link');
        keys(allocation.recipient, recipientKeys);
        // Deleted operations keep their original snapshots even when unused plan details are edited.
        const snapshot = recipientSnapshot({ ...(row.deletedAt ? allocation.recipient : recipient) });
        if (recipientKeys.some(key => allocation.recipient[key as keyof OperatorRecipientFields] !== snapshot[key as keyof OperatorRecipientFields])) throw new Error('Invalid recipient snapshot');
        ids.add(allocation.recipientId);
      }
    }
    if (!ids.size || !row.allocations.reduce((sum, allocation) => sum.plus(allocation.amount), new Decimal(0)).eq(row.amount) || row.recipientText !== operatorAllocationText(row.allocations)) throw new Error('Invalid allocation total or text');
  }
  for (const plan of Object.values(state.plans ?? {})) {
    const summary = operatorPlanSummary(state, plan);
    if (summary.recipients.some(row => new Decimal(row.remaining).lt(0)) || summary.status !== 'completed' && usage(state, plan.id).managerAmount.gt(0)) throw new Error('Invalid plan balance');
  }
}

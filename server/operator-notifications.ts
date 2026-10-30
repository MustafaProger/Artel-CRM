import { randomUUID } from 'node:crypto';
import { hasSection } from '../web/src/auth-model';
import type { OperationsData } from './operations-store';
import { operatorPlanSummary, operatorUsageIndex } from './operator-plans';

export interface OperatorPlanEvent {
  planId: string; kind: 'created' | 'completed'; token: string; at: number; recipientIds: string[];
}
const lifetime = 86400000;
export function operatorPlanStatuses(data: OperationsData) {
  if (!data.operator) return {};
  const index = operatorUsageIndex(data.operator);
  return Object.fromEntries(Object.values(data.operator.plans ?? {}).map(plan => [plan.id, operatorPlanSummary(data.operator!, plan, index).status]));
}
/** Save events atomically with the operation. A replay never reaches this function. */
export function queueOperatorPlanEvents(data: OperationsData, before: Record<string, string>, actorId: string, operation: boolean) {
  const after = operatorPlanStatuses(data);
  for (const plan of Object.values(data.operator?.plans ?? {})) {
    const events = data.push?.operatorPlanEvents;
    if (after[plan.id] !== 'completed' && events) delete events[`${plan.id}:completed`];
    if (after[plan.id] === 'completed' && events) delete events[`${plan.id}:created`];
    const kind = before[plan.id] === undefined ? 'created' : operation && before[plan.id] === 'active' && after[plan.id] === 'completed' ? 'completed' : null;
    if (!kind) continue;
    const recipientIds = (data.accounts?.users ?? [])
      .filter(user => user.id !== actorId && hasSection(user, 'operator') && (kind === 'created' || user.id === plan.createdBy))
      .map(user => user.id);
    if (!recipientIds.length) continue;
    const push = data.push ??= { devices: [], deliveries: {} };
    (push.operatorPlanEvents ??= {})[`${plan.id}:${kind}`] = { planId: plan.id, kind, token: randomUUID(), at: Date.now(), recipientIds };
  }
  if (data.push?.operatorPlanEvents && !Object.keys(data.push.operatorPlanEvents).length) delete data.push.operatorPlanEvents;
}
export function validOperatorPlanEvent(data: OperationsData, event: OperatorPlanEvent, now: number) {
  const plan = data.operator?.plans?.[event.planId];
  if (!plan || event.at <= now - lifetime) return false;
  const status = operatorPlanSummary(data.operator!, plan).status;
  return event.kind === 'created' ? status === 'active' : status === 'completed';
}
export function operatorPlanCandidates(data: OperationsData, now: number) {
  return Object.values(data.push?.operatorPlanEvents ?? {}).flatMap(event => {
    if (!validOperatorPlanEvent(data, event, now)) return [];
    return event.recipientIds.filter(id => data.accounts?.users.some(user => user.id === id && hasSection(user, 'operator')))
      .map(assigneeId => ({ kind: `operator-plan-${event.kind}`, id: event.planId, assigneeId, token: event.token, event: 'operator-plan' as const, occurredAt: event.at }));
  });
}
export function validateOperatorPlanEvents(value: Record<string, OperatorPlanEvent> | undefined) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid operator notification storage');
  for (const [key, row] of Object.entries(value)) {
    if (!row || typeof row.planId !== 'string' || !/^[a-f0-9-]{36}$/.test(row.planId) || !['created', 'completed'].includes(row.kind)
      || key !== `${row.planId}:${row.kind}` || typeof row.token !== 'string' || !/^[a-f0-9-]{36}$/.test(row.token)
      || !Number.isSafeInteger(row.at) || row.at < 0 || !Array.isArray(row.recipientIds) || row.recipientIds.some(id => typeof id !== 'string' || !id)
      || new Set(row.recipientIds).size !== row.recipientIds.length) throw new Error('Invalid operator notification');
  }
}

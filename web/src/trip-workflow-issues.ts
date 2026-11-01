import type { TripSabyResponse, TripSabySigningStep } from './trip-saby-model'

export interface TripWorkflowIssue { step: number; stage: string; message: string; shipmentId?: string }
type Delivery = { shipmentId: string; status?: string; lastError?: string | null; dispatch?: { sender: Pick<TripSabySigningStep, 'state'>; carrier: Pick<TripSabySigningStep, 'state'>; completedAt?: string | null; lastError?: string | null } }
export type WorkflowIssueInput = Partial<Pick<TripSabyResponse, 'documentMode' | 'phase' | 'lastError' | 'order' | 'carrierFill' | 'blockers'>> & { signing?: { sender: TripSabySigningStep; carrier: TripSabySigningStep }; deliveries?: Delivery[]; carrierConfirmed?: boolean }
const needsAttention = (state?: string) => state === 'blocked' || state === 'unknown' || state === 'error'
/** Current errors only: history and ordinary waiting states are not failures. */
export function tripWorkflowIssues(result: WorkflowIssueInput): TripWorkflowIssue[] {
  const direct = result.documentMode === 'nk_direct_etrn'
  const labels = direct
    ? ['Подготовка', 'Подтверждение водителя', 'Создание ЭТрН', 'Подпись отправителя НК', 'Подпись перевозчика НК', 'Передача клиентам', 'Приёмка клиентами']
    : ['Подготовка', 'Подтверждение водителя', 'Отправка АРТЭЛЬ', 'Водитель и машина', 'Подтверждение НК', 'Создание ЭТрН', 'Отправка клиентам']
  const issues: TripWorkflowIssue[] = []
  const add = (step: number, message: string, shipmentId?: string) => {
    const text = message.trim()
    if (text && !issues.some(issue => issue.step === step && issue.message === text && issue.shipmentId === shipmentId)) issues.push({ step, stage: labels[step], message: text, ...(shipmentId ? { shipmentId } : {}) })
  }
  for (const message of result.blockers ?? []) add(0, message)
  for (const side of ['sender', 'carrier'] as const) {
    const signing = result.signing?.[side]
    if (needsAttention(signing?.state)) add(side === 'sender' ? 2 : 4, signing?.message || 'Подписание приостановлено. Требуется сверка с Saby.')
  }
  if (['partial', 'blocked', 'unknown'].includes(result.carrierFill?.state ?? '')) {
    for (const message of result.carrierFill?.blockers.length ? result.carrierFill.blockers : ['Заполнение ответа НК требует проверки.']) add(3, message)
  }
  const stage = result.order?.exchangeStage
  if (stage && ['rejected', 'cancelled', 'operator_error'].includes(stage)) add(stage === 'rejected' ? 4 : 2, result.lastError || (stage === 'rejected' ? 'Заявка отклонена.' : stage === 'cancelled' ? 'Заявка аннулирована.' : 'Ошибка обработки Saby.'))
  for (const delivery of result.deliveries ?? []) {
    const dispatch = delivery.dispatch
    const step = direct ? needsAttention(dispatch?.sender.state) ? 3 : needsAttention(dispatch?.carrier.state) ? 4 : dispatch ? 5 : 2 : dispatch ? 6 : 5
    if (delivery.lastError || dispatch?.lastError || needsAttention(delivery.status) || needsAttention(dispatch?.sender.state) || needsAttention(dispatch?.carrier.state)) {
      add(step, dispatch?.lastError || delivery.lastError || 'Обработка ЭТрН приостановлена. Требуется сверка с Saby.', delivery.shipmentId)
    }
  }
  if (result.lastError || needsAttention(result.phase)) {
    const step = issues[0]?.step ?? (direct ? result.phase === 'sending_etrn' ? 5 : 2 : result.carrierConfirmed ? 5 : result.signing?.sender.state === 'confirmed' ? 4 : result.order?.id ? 2 : 0)
    if (!issues.some(issue => issue.message === result.lastError)) add(step, result.lastError || 'Обмен приостановлен. Требуется сверка с Saby.')
  }
  return issues
}

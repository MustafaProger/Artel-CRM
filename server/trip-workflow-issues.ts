import type { OperationsData } from './operations-store'
import { tripWorkflowIssues } from '../web/src/trip-workflow-issues'

/** Read-only projection of saved state; no preparation, provider calls or writes. */
export function readTripWorkflowIssues(data: OperationsData, tripId: string) {
  const workflow = data.tripSaby?.trips[tripId]
  const etrn = data.etrn?.trips[tripId]
  const direct = etrn?.direct
  const automatic = etrn?.directAutostart
  const deliveries = new Map((workflow?.deliveries ?? []).map(row => [row.shipmentId, { shipmentId: row.shipmentId, status: row.status, lastError: row.lastError }]))
  const documents = Object.entries(etrn?.deliveries ?? {}).flatMap(([shipmentId, row]) => row.document ? [{ shipmentId, ...row.document }] : [])
  for (const doc of documents) deliveries.delete(doc.shipmentId)
  return tripWorkflowIssues({
    ...(direct || automatic ? { documentMode: 'nk_direct_etrn' as const, phase: direct?.phase, ...(!direct && automatic?.state === 'blocked' ? { blockers: [automatic.lastError || 'Автоматическая отправка приостановлена.'] } : {}), lastError: direct?.lastError || (automatic?.state === 'blocked' ? automatic.lastError || 'Автоматическая отправка приостановлена.' : null) } : workflow ? {
      phase: workflow.phase, lastError: workflow.lastError, order: workflow.order,
      signing: workflow.signing, carrierFill: workflow.carrierFill, carrierConfirmed: !!workflow.carrierEvidence,
    } : {}),
    deliveries: [...deliveries.values(), ...documents],
  })
}

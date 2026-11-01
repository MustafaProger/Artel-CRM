import type { OperationsData } from './operations-store'
import { tripWorkflowIssues } from '../web/src/trip-workflow-issues'
import type { ShipmentTrip, Snapshot } from '../web/src/model'
import { ApiError } from './api-error'
import { isNkDirectEtrn } from './trip-document-mode'
import { requiresEtrn } from './trip-etrn-scope'
import { prepareNkDirectEtrn, prepareTripSaby } from './trip-saby-preparation'
import type { SabyConfig } from './saby-client'

/** Pure readiness + saved errors. The list and expanded panel use the same verdict.
 * Preparation here only validates local fields: no provider calls, intent or writes. */
export function readTripWorkflowIssues(data: OperationsData, tripId: string, context?: { snapshot: Snapshot; trip: ShipmentTrip; config: SabyConfig }) {
  const workflow = data.tripSaby?.trips[tripId]
  const etrn = data.etrn?.trips[tripId]
  const direct = etrn?.direct
  const automatic = etrn?.directAutostart
  const deliveries = new Map((workflow?.deliveries ?? []).map(row => [row.shipmentId, { shipmentId: row.shipmentId, status: row.status, lastError: row.lastError }]))
  const documents = Object.entries(etrn?.deliveries ?? {}).flatMap(([shipmentId, row]) => row.document ? [{ shipmentId, ...row.document }] : [])
  for (const doc of documents) deliveries.delete(doc.shipmentId)
  const issues = tripWorkflowIssues({
    ...(direct || automatic ? { documentMode: 'nk_direct_etrn' as const, phase: direct?.phase, ...(!direct && automatic?.state === 'blocked' ? { blockers: [automatic.lastError || 'Автоматическая отправка приостановлена.'] } : {}), lastError: direct?.lastError || (automatic?.state === 'blocked' ? automatic.lastError || 'Автоматическая отправка приостановлена.' : null) } : workflow ? {
      phase: workflow.phase, lastError: workflow.lastError, order: workflow.order,
      signing: workflow.signing, carrierFill: workflow.carrierFill, carrierConfirmed: !!workflow.carrierEvidence,
    } : {}),
    deliveries: [...deliveries.values(), ...documents],
  })
  if (!context) return issues
  const { snapshot, trip, config } = context
  const required = trip.customers.filter(requiresEtrn)
  if (!required.length) return []
  // Completed documents retain their approved data, even if directories change later.
  if (workflow?.phase === 'completed' || direct?.phase === 'completed') return issues
  try {
    const prepare = isNkDirectEtrn(trip, data) ? prepareNkDirectEtrn : prepareTripSaby
    for (const message of prepare(snapshot, data, trip, config).blockers) {
      if (!issues.some(issue => issue.message === message)) issues.push({ step: 0, stage: 'Подготовка', message })
    }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    issues.push({ step: 0, stage: 'Подготовка', message: error.message })
  }
  // Masses belong to the driver's normal loading stage. Only an inconsistency
  // after recorded departure/confirmation is an input error for the operator.
  if (trip.fields.trip_flow_version === 'driver-v1' && (data.driverTripProgress?.[tripId]?.departedAt || workflow?.driverFlow?.state === 'ready')) {
    for (const [index, delivery] of trip.customers.entries()) {
      if (requiresEtrn(delivery) && !(Number(delivery.fields.quantity_tonnes) > 0)) {
        issues.push({ step: 1, stage: 'Подтверждение водителя', message: `Доставка ${index + 1}: не указана масса.`, shipmentId: delivery.id })
      }
    }
  }
  return issues
}

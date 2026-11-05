// Historical persisted attempts remain supported; this fixture deliberately models
// the pre-departure records produced by the release before 2026-11-05.
import { createHash, randomUUID } from 'node:crypto';
import { currentSnapshot } from '../../server/shipment-operations';
import { getShipmentTrip } from '../../server/shipment-trips';
import { newCarrierFill } from '../../server/trip-saby-carrier';
import { prepareTripSaby, type TripSabyPreparation } from '../../server/trip-saby-preparation';
import { policyHash, type TripSabyRecord, type enqueueAutomaticTripSaby } from '../../server/trip-saby-workflow';
const newSenderVerificationPolicy = 'address-multidelivery-v1' as const;
const now = () => new Date().toISOString();
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
function newTripSabyRecord(prepared: TripSabyPreparation, initiatorId?: string): TripSabyRecord {
  const stamp = now();
  return { senderVerificationPolicy: newSenderVerificationPolicy, ...(initiatorId ? { initiatorId } : {}), ...(prepared.order.fields.trip_flow_version === 'driver-v1' ? { orderConsignmentCreationVersion: 2 as const, driverFlow: { state: 'waiting_driver', processingAllowanceHours: 10 } as const } : {}), scenario: prepared.scenario, snapshot: structuredClone(prepared.order), payloadHash: hash(prepared.order), marker: `ARTEL-CRM:TRIP:${randomUUID()}`, attemptId: randomUUID(), createdAt: stamp, updatedAt: stamp, leaseId: null, leaseUntil: null, reservationAttempted: false, uploadAttempted: false, order: { id: null, number: null, date: prepared.order.fields.date, status: 'pending', url: null, revision: null, remoteStatus: null, signatureStatus: 'unknown' }, carrierEvidence: null, carrierFill: newCarrierFill('По договору'), phase: 'submitting', lastError: null, deliveries: prepared.deliveries.map(row => ({ shipmentId: row.shipmentId, snapshot: structuredClone(row.snapshot), payloadHash: hash(row.snapshot), id: null, status: 'not_sent', lastError: null })) };
}


export function seedLegacyDriverAttempt({ base, data, tripId, actorId, config, prepare = prepareTripSaby }: Parameters<typeof enqueueAutomaticTripSaby>[0]) {
  const snapshot = currentSnapshot(base, data), trip = getShipmentTrip(snapshot, tripId);
  const record = newTripSabyRecord(prepare(snapshot, data, trip, config), actorId), policy = config.automaticSigning!;
  record.autoAuthorization = { requestId: randomUUID(), requestedBy: actorId, requestedAt: record.createdAt, policyId: policy.id, policyHash: policyHash(policy), mode: 'deferred', selection: { sender: policy.sender.thumbprint, carrier: policy.carrier.thumbprint } };
  data.tripSaby ??= { trips: {} }; data.tripSaby.trips[tripId] = record;
  return { enqueued: true, blockers: [] };
}

import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { validateNkDirectEtrn, type NkDirectEtrnRecord } from '../server/nk-direct-etrn';
import { NATIVE_APPROVED_REDIRECTION_METHOD } from '../server/saby-consignment-evidence';
import { serializeSabyConsignmentNote, type SabyConsignmentSnapshot } from '../server/saby-consignment-note';
import { currentSnapshot } from '../server/shipment-operations';
import { getShipmentTrip, saveShipmentTrip } from '../server/shipment-trips';
import { prepareNkDirectEtrn, prepareTripSaby } from '../server/trip-saby-preparation';
import { validateTripSabyData, type TripSabyRecord } from '../server/trip-saby-workflow';
import { integrationConfig, integrationRuntime, integrationSettings } from './helpers/trip-saby-integration';

const at = '2026-10-29T10:00:00.000Z';
const attempt = '11111111-1111-4111-8111-111111111111';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const settings = (method: string) => ({ ...integrationSettings, instructions: { ...integrationSettings.instructions, redirectionMethod: method } });

async function fixture(direct: boolean) {
  const runtime = await integrationRuntime();
  try {
    const created = await runtime.store.mutate(runtime.source, data => {
      const fields = Object.fromEntries(['supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, runtime.trip.fields[key]]));
      Object.assign(fields, { organization_id: direct ? 'nk-artel' : 'artel', trip_flow_version: 'driver-v1', loading_at: '2026-10-29T09:00' });
      const customers = runtime.trip.customers.map(row => ({ fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id', 'quantity_litres'].map(key => [key, row.fields[key]])) }));
      return { result: saveShipmentTrip(runtime.base, data, { fields, customers, idempotencyKey: randomUUID() }), changed: true };
    });
    const data = await runtime.store.read(runtime.source), source = currentSnapshot(runtime.base, data);
    const trip = getShipmentTrip(source, created.trip.id), config = integrationConfig();
    config.login = 'synthetic-login'; config.password = 'synthetic-password'; config.accountNumber = 'synthetic-artel'; config.carrierAccountNumber = 'synthetic-nk';
    config.nkConsignmentSigner = { surname: 'НКПодписант', name: 'Тест', patronymic: '', position: 'Директор' };
    config.nkRegulatoryInstructions = 'Синтетические подтверждённые указания НК';
    const prepare = (method: string) => direct
      ? prepareNkDirectEtrn(source, data, trip, config, settings(method))
      : prepareTripSaby(source, data, trip, config, settings(method));
    return { runtime, data, source, trip, config, prepare };
  } catch (error) { await runtime.close(); throw error; }
}

function senderXml(snapshot: SabyConsignmentSnapshot): string {
  const completed = structuredClone(snapshot);
  completed.profile.order = { number: completed.documentMode === 'nk-direct-v1' ? 'Без номера' : '45', date: '2026-10-29' };
  completed.profile.deliveryMassTonnes = '5'; completed.profile.plannedGrossMassTonnes = '5';
  completed.profile.loading = { arrivedAt: '2026-10-29T09:01', departedAt: '2026-10-29T10:03', grossMassTonnes: '5', massMethod: '03' };
  return new TextDecoder('windows-1251').decode(serializeSabyConsignmentNote(completed, attempt, at, '100', { senderTitleVersion: 2 }).xml);
}

for (const direct of [false, true]) test(`new ${direct ? 'NK direct' : 'ARTEL order'} trips select electronic Saby terms despite a telephone autofill setting`, async () => {
  const f = await fixture(direct);
  try {
    const before = structuredClone({ data: f.data, source: f.source, trip: f.trip });
    if (direct) assert.equal(f.data.etrn!.trips[f.trip.id].loadingActorMode, 'sender', 'The normal trip-save route must opt into the new direct policy');
    for (const method of ['По телефону', 'Телефон', NATIVE_APPROVED_REDIRECTION_METHOD]) {
      const prepared = f.prepare(method);
      assert.deepEqual(prepared.blockers, []);
      assert.equal(prepared.deliveries.length, 2);
      for (const row of prepared.deliveries) {
        const xml = senderXml(row.snapshot);
        assert.match(xml, /СпосПерУкПА="Электронное уведомление перевозчика о переадресовке"/);
        assert.doesNotMatch(xml, /СпосПерУкПА="(?:По телефону|Телефон)"/);
        assert.equal(row.snapshot.profile.loadingActor.sameAsConsignor, true);
        assert.equal(row.snapshot.profile.infrastructureOwner.party.inn, f.source.companies.find(company => company.id === 'supplier')!.inn);
      }
    }
    assert.deepEqual({ data: f.data, source: f.source, trip: f.trip }, before, 'Preflight must not rewrite data or authorize an exchange');
  } finally { await f.runtime.close(); }
});

for (const direct of [false, true]) test(`electronic defaults preserve each frozen ${direct ? 'NK direct' : 'ARTEL order'} delivery and its authorization`, async () => {
  const f = await fixture(direct);
  try {
    const prepared = f.prepare('По телефону');
    assert.deepEqual(prepared.blockers, []);
    const deliveries = structuredClone(prepared.deliveries);
    // An old first delivery and an electronic second delivery share the same
    // customer/address: preservation must bind by delivery ID, not by recipient.
    deliveries[0].snapshot.profile.instructions.redirectionMethod = 'По телефону';
    if (direct) {
      const record: NkDirectEtrnRecord = {
        version: 'nk-direct-v1', attemptId: attempt, createdAt: at, updatedAt: at, phase: 'creating_etrn', lastError: null, leaseId: null, leaseUntil: null,
        authorization: { actorId: 'synthetic-actor', requestedAt: at, mode: 'sign_and_send', grantedRoles: ['sender', 'carrier'], selection: { sender: 'ab'.repeat(20), carrier: 'ab'.repeat(20) }, policyHash: hash('policy'), factsHash: hash('facts'), sourceHash: hash('source') },
        deliveries,
      };
      validateNkDirectEtrn(record, f.trip.id);
      f.data.etrn!.trips[f.trip.id].direct = record;
    } else {
      const order = prepareTripSaby(f.source, f.data, f.trip, f.config, settings('По телефону'));
      const record: TripSabyRecord = {
        scenario: order.scenario, snapshot: order.order, payloadHash: hash(order.order), marker: 'ARTEL-CRM:TRIP:synthetic-history', attemptId: attempt, createdAt: at, updatedAt: at,
        leaseId: null, leaseUntil: null, reservationAttempted: false, uploadAttempted: false, phase: 'submitting', lastError: null, carrierEvidence: null,
        driverFlow: { state: 'waiting_driver', processingAllowanceHours: 10 }, initiatorId: 'synthetic-actor',
        order: { id: null, number: null, date: f.trip.fields.date, status: 'pending', url: null, revision: null, remoteStatus: null, signatureStatus: 'unknown' },
        autoAuthorization: { requestId: 'synthetic-authorization', requestedBy: 'synthetic-actor', requestedAt: at, policyId: 'synthetic-policy', policyHash: hash('policy'), mode: 'deferred', selection: { sender: 'ab'.repeat(20), carrier: 'cd'.repeat(20) } },
        deliveries: deliveries.map(row => ({ ...row, payloadHash: hash(row.snapshot), id: null, status: 'not_sent', lastError: null })),
      };
      f.data.tripSaby = { trips: { [f.trip.id]: record } };
      validateTripSabyData(f.data.tripSaby);
    }
    const before = structuredClone(f.data), xmlBefore = deliveries.map(row => senderXml(row.snapshot));
    for (const method of ['По телефону', NATIVE_APPROVED_REDIRECTION_METHOD]) {
      const refreshed = f.prepare(method);
      assert.deepEqual(refreshed.blockers, []);
      assert.deepEqual(refreshed.deliveries.map(row => senderXml(row.snapshot)), xmlBefore);
      assert.deepEqual(refreshed.deliveries.map(row => row.snapshot.profile.instructions.redirectionMethod), ['По телефону', NATIVE_APPROVED_REDIRECTION_METHOD]);
      assert.deepEqual(f.data, before, 'A new default must not amend old snapshots, hashes or signing grants');
    }
  } finally { await f.runtime.close(); }
});

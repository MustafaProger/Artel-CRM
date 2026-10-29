import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import test from 'node:test';
import { ApiError } from '../server/api-error';
import { validate, type OperationsData } from '../server/operations-store';
import { validateEtrnData, type EtrnDocument, type EtrnTrip } from '../server/etrn-service';
import { nkDirectRebuildFingerprint, rebuildNkDirectDraft } from '../server/nk-direct-rebuild';
import { signingManifestHash, type SabySigningBinding } from '../server/saby-signing';
import { currentSnapshot } from '../server/shipment-operations';
import { integrationRuntime } from './helpers/trip-saby-integration';
import { carrier, syntheticEtrnFixture } from './helpers/etrn-fixture';

const time = '2026-10-21T10:00:00.000Z';
const afterTime = '2026-10-21T10:10:00.000Z';
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

async function fixture() {
  const rt = await integrationRuntime(), data = await rt.store.read(rt.source);
  const ids = rt.trip.customers.map(row => row.id), sample = syntheticEtrnFixture().snapshot;
  for (const id of ids) Object.assign(data.shipments[id].fields, { organization_id: 'nk-artel', trip_flow_version: 'driver-v1', trip_document_policy: 'nk-direct-autostart-v1', etrn_not_required: 'false', quantity_gross_tonnes: data.shipments[id].fields.quantity_tonnes });
  data.accounts = { users: ['actor', 'other-actor'].map(id => ({ id, login: id, name: id, role: 'director' as const, managerId: null, active: true, version: 1, passwordHash: 'a'.repeat(128), salt: 'a'.repeat(32) })), sessions: [], attempts: {} };
  data.tripNumbers = { ...data.tripNumbers, [rt.tripId]: 30 };
  rt.base.payments.push({ id: 'payment-preserved', date: '2026-10-21', counterpartyId: 'customer', counterparty: 'Синтетический клиент', incoming: '500', outgoing: null, purpose: 'Синтетическая оплата', sourceRow: 1, sourceSheet: 'synthetic', flags: [], fields: {} });
  data.paymentAllocations = [{ id: 'allocation-preserved', shipmentId: ids[0], paymentId: 'payment-preserved', amount: '500', date: '2026-10-21' }];
  data.driverTripProgress = { [rt.tripId]: {
    driverId: 'driver', compositionHash: 'a'.repeat(64), arrivedAt: '2026-10-21T09:00:00.000Z', arrivedBy: 'driver-user',
    arrivalVersions: Object.fromEntries(ids.map(id => [id, data.shipments[id].version])),
    departedAt: time, departedBy: 'driver-user', departureVersions: Object.fromEntries(ids.map(id => [id, data.shipments[id].version])),
    continuationRequestedAt: time, masses: Object.fromEntries(ids.map((id, i) => [id, i ? '5.2' : '7'])),
  } };
  const directSnapshots = ids.map(shipmentId => ({ shipmentId, snapshot: { ...structuredClone(sample), tripId: rt.tripId, shipmentId, documentMode: 'nk-direct-v1' as const, customerOrganization: carrier, carrierOrganization: carrier } }));
  const deliveries: EtrnTrip['deliveries'] = {};
  for (const [index, row] of directSnapshots.entries()) {
    const id = `native-${index + 2}`;
    const binding: SabySigningBinding = { side: 'sender', documentId: id, revision: 'revision', stageId: 'stage', stageName: 'Отправка', actionName: 'Погружен', certificateThumbprint: 'cd'.repeat(20), organizationInn: carrier.inn, organizationKpp: carrier.kpp, counterpartyInn: carrier.inn, counterpartyKpp: carrier.kpp, documentType: 'ConsignmentNote', attachmentSubtype: '1110339', attachmentId: 'title', keyType: 'Отложенный', routePolicy: 'nk-direct-v1', documentDirection: 'Исходящий', actionStateCode: '0' };
    const manifest = { binding, attachments: [{ id: 'title', name: 'sender.xml', subtype: '1110339', sha256: 'e'.repeat(64) }] };
    const document: EtrnDocument = {
      id, revision: 'revision', url: null, status: 'unknown', remoteStatus: 'Проблемы при доставке', lastError: 'Неизвестный результат Execute', gisStatus: null, signatureStatus: 'unknown', availableActions: [],
      updatedAt: time, createdAt: time, marker: `ARTEL-CRM:ETRN:old-${index}`, attemptId: `old-attempt-${index}`, payloadHash: hash(row.snapshot), snapshot: structuredClone(row.snapshot), artifacts: [], leaseId: null, leaseUntil: null,
      number: String(index + 2), reservationAttempted: true, uploadAttempted: true,
      writeAttempts: [{ action: 'reservation', outcome: 'uncertain', request: { version: 1, method: 'СБИС.ЗаписатьДокумент', requestId: index + 1, requestedAt: time, bodySha256: 'f'.repeat(64), bodyBytes: 45 } }],
      ...(index === 0 ? { dispatch: { version: 1 as const, sender: { state: 'unknown' as const, binding, prepared: { ...manifest, preparedHash: signingManifestHash(manifest) }, verified: true, executeAttempted: true, dispatchState: 'attempted' as const }, carrier: { state: 'not_started' as const } } } : {}),
    };
    deliveries[row.shipmentId] = { profile: structuredClone(row.snapshot.profile), snapshot: structuredClone(row.snapshot), preparedHash: hash(row.snapshot), document, updatedAt: time };
  }
  data.etrn = { trips: { [rt.tripId]: {
    updatedAt: time, deliveries,
    loadingFacts: { ...rt.facts(), recordedAt: time, actorId: 'driver-user' },
    direct: { version: 'nk-direct-v1', attemptId: 'original-direct-attempt', createdAt: time, updatedAt: time, phase: 'unknown', lastError: 'Сверка внешней попытки', leaseId: null, leaseUntil: null,
      authorization: { actorId: 'actor', requestedAt: time, mode: 'sign_and_send', grantedRoles: ['sender', 'carrier'], selection: { sender: 'cd'.repeat(20), carrier: 'cd'.repeat(20) }, policyHash: 'b'.repeat(64), factsHash: 'c'.repeat(64), sourceHash: 'd'.repeat(64) }, deliveries: directSnapshots },
    directAutostart: { version: 'nk-direct-autostart-v1', actorId: 'actor', createdAt: time, updatedAt: time, source: 'trip_save', sourceHash: 'c'.repeat(64), policyHash: 'b'.repeat(64), certificate: 'cd'.repeat(20), state: 'queued', lastError: null, event: { driverId: 'driver', actorId: 'driver-user', departedAt: time, factsHash: 'c'.repeat(64) } },
  }, unrelated: { updatedAt: time, deliveries: {} } } };
  validate(data, rt.source);
  const options = () => ({ base: rt.base, data, tripId: rt.tripId, actorId: 'actor', requestId: randomUUID(), expectedFingerprint: nkDirectRebuildFingerprint(rt.base, data, rt.tripId), loadingActorMode: 'sender' as const, now: afterTime });
  return { ...rt, data, ids, options };
}

test('recreates the draft with the reviewed sender loading role and archives exact uncertain attempts, grant, manifest and autostart', async () => {
  const f = await fixture();
  try {
    const before = structuredClone(f.data), old = before.etrn!.trips[f.tripId], beforeRows = currentSnapshot(f.base, before, false).shipments;
    const result = rebuildNkDirectDraft(f.options()), draft = f.data.etrn!.trips[f.tripId], entry = draft.exchangeHistory![0];
    assert.equal(result.changed, true); assert.equal(result.replayed, false);
    assert.deepEqual(entry.exchange, { direct: old.direct, deliveries: old.deliveries, directAutostart: old.directAutostart });
    assert.equal(entry.sha256, hash(entry.exchange)); assert.equal(entry.sha256, result.archiveSha256);
    assert.equal(draft.rebuild!.externalRestartBlocked, true);
    assert.equal(draft.loadingActorMode, 'sender');
    assert.equal(draft.direct, undefined); assert.equal(draft.directAutostart, undefined); assert.deepEqual(draft.deliveries, {});
    assert.deepEqual(draft.loadingFacts, old.loadingFacts);
    const allowed = new Set(['direct', 'deliveries', 'directAutostart', 'exchangeHistory', 'rebuild', 'updatedAt', 'loadingActorMode']);
    assert.deepEqual(Object.fromEntries(Object.entries(draft).filter(([key]) => !allowed.has(key))), Object.fromEntries(Object.entries(old).filter(([key]) => !allowed.has(key))), 'only the approved exchange draft and loading role change');
    assert.deepEqual(currentSnapshot(f.base, f.data, false).shipments, beforeRows);
    const restored = structuredClone(f.data); restored.etrn!.trips[f.tripId] = old;
    assert.deepEqual(restored, before, 'every field outside the exact ETRN trip is unchanged, including all financial data and driver facts');
    validate(JSON.parse(JSON.stringify(f.data)), f.source);
    const tampered = structuredClone(f.data); tampered.etrn!.trips[f.tripId].exchangeHistory![0].exchange.direct.attemptId = 'overwritten';
    assert.throws(() => validateEtrnData(tampered.etrn), /history|archive|rebuild/i);
  } finally { await f.close(); }
});

test('rebuild requires the explicitly reviewed sender loading role instead of deriving it from the owner', async () => {
  const f = await fixture();
  try {
    const before = JSON.stringify(f.data);
    for (const mode of [undefined, 'external']) {
      assert.throws(() => rebuildNkDirectDraft({ ...f.options(), loadingActorMode: mode as 'sender' }), ApiError);
      assert.equal(JSON.stringify(f.data), before);
    }
  } finally { await f.close(); }
});

test('same request replays without mutation; changed actor, fingerprint, request or draft refuses', async () => {
  const f = await fixture();
  try {
    const opts = f.options(), first = rebuildNkDirectDraft(opts), raw = JSON.stringify(f.data);
    assert.deepEqual(rebuildNkDirectDraft({ ...opts, now: '2026-10-21T11:00:00.000Z' }), { ...first, changed: false, replayed: true });
    assert.equal(JSON.stringify(f.data), raw);
    for (const change of [{ actorId: 'other-actor' }, { expectedFingerprint: '0'.repeat(64) }, { requestId: randomUUID() }]) {
      assert.throws(() => rebuildNkDirectDraft({ ...opts, ...change }), ApiError); assert.equal(JSON.stringify(f.data), raw);
    }
    delete f.data.etrn!.trips[f.tripId].loadingActorMode;
    const withoutConfirmedRole = JSON.stringify(f.data);
    assert.throws(() => rebuildNkDirectDraft(opts), ApiError); assert.equal(JSON.stringify(f.data), withoutConfirmedRole);
    f.data.etrn!.trips[f.tripId].loadingActorMode = 'sender';
    f.data.etrn!.trips[f.tripId].deliveries = structuredClone(f.data.etrn!.trips[f.tripId].exchangeHistory![0].exchange.deliveries);
    const modified = JSON.stringify(f.data);
    assert.throws(() => rebuildNkDirectDraft(opts), ApiError); assert.equal(JSON.stringify(f.data), modified);
  } finally { await f.close(); }
});

test('fingerprint detects changed facts, exact shipment records, number and external receipts', async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.data), expected = f.options().expectedFingerprint;
    const changes: Array<(data: OperationsData) => void> = [
      data => { data.shipments[f.ids[0]].fields.sale_price_per_litre = '61'; },
      data => { data.driverTripProgress![f.tripId].masses![f.ids[0]] = '7.1'; },
      data => { data.tripNumbers![f.tripId] = 31; },
      data => { data.etrn!.trips[f.tripId].deliveries[f.ids[0]].document!.lastError = 'Новое наблюдение'; },
      data => { data.etrn!.trips[f.tripId].loadingActorMode = 'sender'; },
    ];
    for (const change of changes) {
      const data = structuredClone(original); change(data); const before = JSON.stringify(data);
      assert.throws(() => rebuildNkDirectDraft({ ...f.options(), data, expectedFingerprint: expected }), /изменились/);
      assert.equal(JSON.stringify(data), before);
    }
  } finally { await f.close(); }
});

test('rejects non-direct trips, changed delivery sets, completed deliveries and active worker leases atomically', async () => {
  const f = await fixture();
  try {
    const original = structuredClone(f.data);
    const changes: Array<(data: OperationsData) => void> = [
      data => { for (const id of f.ids) data.shipments[id].fields.organization_id = 'artel'; },
      data => { data.etrn!.trips[f.tripId].direct!.deliveries.pop(); },
      data => { delete data.etrn!.trips[f.tripId].deliveries[f.ids[1]]; },
      data => { data.etrn!.trips[f.tripId].direct!.completedAt = time; },
      data => { data.etrn!.trips[f.tripId].deliveries[f.ids[0]].document!.dispatch!.completedAt = time; },
      data => { Object.assign(data.etrn!.trips[f.tripId].direct!, { leaseId: 'running', leaseUntil: '2026-10-21T10:15:00.000Z' }); },
      data => { Object.assign(data.etrn!.trips[f.tripId].deliveries[f.ids[1]].document!, { leaseId: 'running', leaseUntil: '2026-10-21T10:15:00.000Z' }); },
    ];
    for (const change of changes) {
      const data = structuredClone(original); change(data); const before = JSON.stringify(data);
      const opts = { ...f.options(), data, expectedFingerprint: nkDirectRebuildFingerprint(f.base, data, f.tripId) };
      assert.throws(() => rebuildNkDirectDraft(opts), ApiError); assert.equal(JSON.stringify(data), before);
    }
    const before = JSON.stringify(f.data);
    assert.throws(() => rebuildNkDirectDraft({ ...f.options(), actorId: 'missing-actor' }), ApiError);
    assert.equal(JSON.stringify(f.data), before);
  } finally { await f.close(); }
});

test('expired leases remain intact in the archive and no new provider intent is introduced', async () => {
  const f = await fixture();
  try {
    const saved = f.data.etrn!.trips[f.tripId];
    Object.assign(saved.direct!, { leaseId: 'expired-work', leaseUntil: time });
    Object.assign(saved.deliveries[f.ids[0]].document!, { leaseId: 'expired-document', leaseUntil: time });
    const before = structuredClone(saved);
    rebuildNkDirectDraft(f.options());
    const archive = f.data.etrn!.trips[f.tripId].exchangeHistory![0].exchange;
    assert.deepEqual(archive.direct, before.direct); assert.deepEqual(archive.deliveries, before.deliveries);
    assert.equal(f.data.etrn!.trips[f.tripId].rebuild!.externalRestartBlocked, true);
    assert.equal(Object.keys(f.data.shipments).length, f.ids.length);
  } finally { await f.close(); }
});

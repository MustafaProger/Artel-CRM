import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SabyClient, type SabyObject } from '../server/saby-client';
import { signingManifestHash, type SabySigningBinding } from '../server/saby-signing';
import { exchangePreparedEtrn, saveTripLoadingFacts } from '../server/etrn-service';
import { runTripSabyWorkflow, type CreateTripSabyDelivery } from '../server/trip-saby-workflow';
import { integrationApi, integrationConfig, integrationRuntime } from './helpers/trip-saby-integration';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
async function fixture() {
  const rt = await integrationRuntime(), api = integrationApi();
  const wait = async () => ({ status: 'error' as const, id: null, lastError: 'Synthetic loading wait', waitingForLoading: true });
  await runTripSabyWorkflow({ ...rt, client: api.client(), createDelivery: wait }); api.accept();
  const order = [...api.docs.values()].find(doc => doc.Тип === 'TransportOrder')!;
  for (const [index, file] of (order.Вложение as SabyObject[]).entries()) file.Подпись = [{ Сертификат: { Отпечаток: (index ? 'b' : 'a').repeat(40) }, Файл: { Ссылка: 'https://disk.saby.ru/synthetic-signature.sig' } }];
  await runTripSabyWorkflow({ ...rt, client: api.client(), createDelivery: wait });
  await saveTripLoadingFacts({ ...rt, client: api.client() }, rt.facts(), 'synthetic-employee');
  const signingFiles = await Promise.all((order.Вложение as SabyObject[]).map(file => api.client().downloadTransportOrderAttachment(String(order.Идентификатор), String(file.Идентификатор), `${order.Идентификатор}-revision`)));
  await rt.store.mutate(rt.source, data => {
    const record = data.tripSaby!.trips[rt.tripId], original = structuredClone(record.snapshot);
    record.snapshot.fields.trip_flow_version = 'driver-v1'; record.payloadHash = hash(record.snapshot);
    record.driverFlow = { state: 'ready', processingAllowanceHours: 10, draftSnapshot: original, draftAttachment: { id: 'synthetic-original-title', revision: record.order.revision!, name: 'synthetic-original.xml', sha256: 'a'.repeat(64) } };
    record.orderConsignmentCreationVersion = 2;
    const steps = (['sender', 'carrier'] as const).map((side, index) => {
      const file = signingFiles[index], party = side === 'sender' ? record.snapshot.customerOrganization : record.snapshot.carrierOrganization;
      const counterparty = side === 'sender' ? record.snapshot.carrierOrganization : record.snapshot.customerOrganization;
      const binding: SabySigningBinding = { side, documentId: record.order.id!, revision: record.order.revision!, stageId: 'observed-signed', stageName: side === 'sender' ? 'Отправка' : 'Утверждение', actionName: side === 'sender' ? 'Отправить' : 'Утвердить', certificateThumbprint: (index ? 'b' : 'a').repeat(40), organizationInn: party.inn, organizationKpp: party.kpp, counterpartyInn: counterparty.inn, counterpartyKpp: counterparty.kpp, attachmentSubtype: side === 'sender' ? '1110361' : '1110362', attachmentId: file.id };
      const attachments = [{ id: file.id, name: file.name, subtype: binding.attachmentSubtype, sha256: createHash('sha256').update(file.bytes).digest('hex') }];
      return { state: 'confirmed' as const, binding, prepared: { binding, attachments, preparedHash: signingManifestHash({ binding, attachments }) }, preparedVerified: true };
    });
    record.signing = { requestedBy: 'synthetic-employee', requestedAt: record.createdAt, requestId: 'synthetic-signing-request', previewToken: 'a'.repeat(64), workflowAttemptId: record.attemptId, documentId: record.order.id!, revision: record.order.revision!, payloadHash: record.payloadHash, selection: { sender: 'a'.repeat(40), carrier: 'b'.repeat(40) }, sender: steps[0], carrier: steps[1] };
    return { result: undefined, changed: true };
  });
  let loseCreate = false, failList = false, appearDuringScan = false, created = 0;
  let requestHook: ((url: Parameters<typeof fetch>[0], init: Parameters<typeof fetch>[1]) => Promise<Response | undefined>) | undefined;
  const send: typeof fetch = async (url, init) => {
    const intercepted = await requestHook?.(url, init); if (intercepted) return intercepted;
    if (init?.method === 'GET') return api.send(url, init);
    const req = JSON.parse(String(init?.body));
    if (req.method === 'СБИС.СписокДокументов' && req.params.Фильтр.Тип === 'ConsignmentNote') {
      if (failList) return api.json(req, { Документ: [] });
      if (appearDuringScan) { appearDuringScan = false; order.ДокументСледствие = [{ Документ: { Идентификатор: 'appeared-native', Тип: 'ConsignmentNote' } }]; }
      const notes = [...api.docs.values()].filter(doc => doc.Тип === 'ConsignmentNote');
      return api.json(req, { Документ: notes, Навигация: { ЕстьЕще: 'Нет', РазмерСтраницы: '200', Страница: '0' } });
    }
    const response = await api.send(url, init);
    if (req.method === 'СБИС.ЗаписатьДокумент' && req.params.Документ.Тип === 'ConsignmentNote') {
      const result = await response.json(); const note = api.docs.get(result.result.Идентификатор)!;
      note.Состояние = { Код: '0', Название: 'Черновик' };
      if (!req.params.Документ.Идентификатор) {
        created++;
        order.ДокументСледствие = [...(order.ДокументСледствие as SabyObject[] ?? []), { Документ: { Идентификатор: note.Идентификатор, Тип: 'ConsignmentNote' } }];
        if (loseCreate) { loseCreate = false; throw new Error('Synthetic lost creation response'); }
      }
      return api.json(req, note);
    }
    return response;
  };
  const client = new SabyClient(integrationConfig(), send);
  const run = async (index = 0) => {
    const record = (await rt.store.read(rt.source)).tripSaby!.trips[rt.tripId];
    const row = record.deliveries[index];
    const input: CreateTripSabyDelivery = { shipmentId: row.shipmentId, snapshot: structuredClone(row.snapshot), order: { id: record.order.id!, number: record.order.number!, date: record.order.date! }, carrierEvidence: record.carrierEvidence!, remoteOrder: structuredClone(order) };
    return exchangePreparedEtrn({ ...rt, client }, input);
  };
  const readDoc = async (index = 0) => (await rt.store.read(rt.source)).etrn!.trips[rt.tripId].deliveries[rt.trip.customers[index].id].document!;
  return { ...rt, api, order, run, readDoc, created: () => created, lose: () => { loseCreate = true; }, incomplete: () => { failList = true; }, appear: () => { appearDuringScan = true; }, setHook: (hook: typeof requestHook) => { requestHook = hook; } };
}

/** Fail the actual transaction that arms numbering, before its changed data can
 * commit. The external writer has not been invoked at this failure point. */
async function interruptNumberFinalization(f: Awaited<ReturnType<typeof fixture>>) {
  const mutate = f.store.mutate.bind(f.store); let interrupted = false, flagAndIntentAtomic = false;
  f.store.mutate = (source, update) => mutate(source, async data => {
    const before = data.etrn?.trips[f.tripId]?.deliveries[f.trip.customers[0].id]?.document;
    const wasAttempted = before?.orderAutoNumber?.numberFinalizationAttempted;
    const result = await update(data), doc = data.etrn?.trips[f.tripId]?.deliveries[f.trip.customers[0].id]?.document;
    if (!interrupted && !wasAttempted && doc?.orderAutoNumber?.numberFinalizationAttempted) {
      interrupted = true; flagAndIntentAtomic = doc.writeAttempts?.filter(row => row.action === 'upload').length === 1;
      throw new Error('Synthetic core queue busy before finalization transaction commit');
    }
    return result;
  });
  try { assert.equal((await f.run()).status, 'unknown'); } finally { f.store.mutate = mutate; }
  assert.equal(interrupted, true); assert.equal(flagAndIntentAtomic, true);
  const doc = await f.readDoc(); assert.equal(doc.orderAutoNumber?.numberFinalizationAttempted, undefined); assert.equal(doc.writeAttempts?.length, 1);
  assert.equal(doc.writeAttempts?.[0].outcome, 'received'); assert.equal(f.created(), 1);
}

async function flagOnlyGap(f: Awaited<ReturnType<typeof fixture>>) {
  await interruptNumberFinalization(f);
  await f.store.mutate(f.source, data => {
    const workflow = data.tripSaby!.trips[f.tripId], doc = data.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
    // Reproduce the historical committed flag whose following intent failed.
    doc.orderAutoNumber!.numberFinalizationAttempted = true;
    workflow.initiatorId = 'synthetic-employee';
    workflow.autoAuthorization = { requestId: workflow.signing!.requestId, requestedBy: 'synthetic-employee', requestedAt: workflow.createdAt, policyId: 'synthetic-policy', policyHash: 'a'.repeat(64), mode: 'deferred', selection: structuredClone(workflow.signing!.selection) };
    workflow.signing!.mode = 'automatic';
    return { result: undefined, changed: true };
  });
}

test('number finalization flag and upload intent commit together; a failed commit resumes once', async () => {
  const f = await fixture();
  try {
    await interruptNumberFinalization(f);
    assert.equal((await f.run()).status, 'draft'); assert.equal(f.created(), 1);
    const doc = await f.readDoc(); assert.equal(doc.writeAttempts?.filter(row => row.action === 'upload').length, 1);
    assert.equal(doc.orderAutoNumber?.numberFinalizationAttempted, true);
    await f.run(); assert.equal(f.api.writes('ConsignmentNote').length, 2);
  } finally { await f.close(); }
});

test('exact v2 flag-only gap preserves original evidence and numbers the same draft once', async () => {
  const f = await fixture();
  try {
    await flagOnlyGap(f); const before = await f.readDoc(); const result = await f.run();
    assert.equal(result.status, 'draft', result.lastError ?? ''); assert.equal(result.id, before.id); assert.equal(f.created(), 1);
    const after = await f.readDoc(); assert.deepEqual(after.writeAttempts?.[0], before.writeAttempts?.[0]);
    assert.deepEqual(after.snapshot, before.snapshot); assert.deepEqual(after.orderCreationAllocation, before.orderCreationAllocation);
    assert.equal(after.orderAutoNumber?.numberFinalizationAttempted, true); assert.equal(after.writeAttempts?.length, 2);
    await f.run(); assert.equal(f.api.writes('ConsignmentNote').length, 2);
  } finally { await f.close(); }
});

test('any recorded finalization intent forbids a retry even when its draft remains unnumbered', async () => {
  for (const outcome of ['attempted', 'uncertain', 'denied', 'received'] as const) {
    const f = await fixture();
    try {
      await flagOnlyGap(f);
      await f.store.mutate(f.source, data => {
        const doc = data.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
        doc.writeAttempts!.push({ action: 'upload', request: { ...doc.writeAttempts![0].request, requestId: 999 }, outcome });
        return { result: undefined, changed: true };
      });
      assert.equal((await f.run()).status, 'unknown'); assert.equal(f.api.writes('ConsignmentNote').length, 1);
    } finally { await f.close(); }
  }
});

test('flag-only recovery rejects changed bytes, signatures, revision races, legacy protocol and changed provenance', async () => {
  for (const change of ['bytes', 'signed', 'revision-race', 'legacy', 'reservation-hash', 'grant'] as const) {
    const f = await fixture();
    try {
      await flagOnlyGap(f); const doc = await f.readDoc(), remote = f.api.docs.get(doc.id!)!;
      if (change === 'bytes') f.setHook(async (url, init) => init?.method === 'GET' && String(url).includes(`${doc.id}.xml`) ? new Response(Buffer.concat([Buffer.from(await (await f.api.send(url, init)).arrayBuffer()), Buffer.from(' ')])) : undefined);
      if (change === 'signed') (remote.Вложение as SabyObject[])[0].Подпись = [{}];
      if (change === 'revision-race') {
        let reads = 0;
        f.setHook(async (_url, init) => { if (init?.method === 'POST') { const req = JSON.parse(String(init.body)); if (req.method === 'СБИС.ПрочитатьДокумент' && req.params.Документ.Идентификатор === doc.id && ++reads === 2) remote.Редакция = [{ Идентификатор: 'changed-revision', Актуален: 'Да' }]; } return undefined; });
      }
      if (['legacy', 'reservation-hash', 'grant'].includes(change)) await f.store.mutate(f.source, data => {
        const w = data.tripSaby!.trips[f.tripId], d = data.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
        if (change === 'legacy') delete w.orderConsignmentCreationVersion;
        if (change === 'reservation-hash') d.writeAttempts![0].request.bodySha256 = 'f'.repeat(64);
        if (change === 'grant') { delete w.autoAuthorization; delete w.signing!.mode; }
        return { result: undefined, changed: true };
      });
      const result = await f.run(); assert.notEqual(result.status, 'draft', change);
      assert.equal(f.api.writes('ConsignmentNote').length, 1, change); assert.equal((await f.readDoc()).orderAutoNumber?.numberFinalizationAttempted, true);
    } finally { await f.close(); }
  }
});

test('version two creates the first full numbered T1 and each subsequent delivery exactly once with reciprocal order links', async () => {
  const f = await fixture();
  try {
    const before = await f.store.read(f.source);
    const first = await f.run(); assert.equal(first.status, 'draft', first.lastError ?? '');
    const saved = await f.readDoc();
    assert.equal(saved.nativeDraftEnabled, false); assert.equal(saved.orderCreationAllocation?.version, 2);
    assert.deepEqual(saved.orderCreationAllocation?.shipmentIds, f.trip.customers.map(row => row.id));
    assert.equal(saved.writeAttempts?.[0].outcome, 'received');
    const second = await f.run(1); assert.equal(second.status, 'draft', second.lastError ?? '');
    assert.notEqual(first.id, second.id); assert.equal(f.created(), 2);
    await f.run(); await f.run(1); assert.equal(f.created(), 2);
    const after = await f.store.read(f.source);
    assert.deepEqual(after.tripSaby, before.tripSaby); assert.deepEqual(after.etrn!.trips[f.tripId].loadingFacts, before.etrn!.trips[f.tripId].loadingFacts);
    assert.ok(f.api.writes('ConsignmentNote').every(row => (row.params.Документ.ДокументОснование as SabyObject[])[0].Документ));
  } finally { await f.close(); }
});

test('a lost first creation response is reconciled by the same marker and never repeats creation', async () => {
  const f = await fixture();
  try {
    f.lose(); const first = await f.run(); assert.equal(first.status, 'unknown'); assert.equal(f.created(), 1);
    const attempted = await f.readDoc(); assert.equal(attempted.reservationAttempted, true); assert.equal(attempted.nativeDraftEnabled, false);
    assert.equal(attempted.orderCreationAllocation?.version, 2); assert.equal(attempted.writeAttempts?.[0].outcome, 'uncertain');
    const recovered = await f.run(); assert.equal(recovered.status, 'draft', recovered.lastError ?? ''); assert.equal(f.created(), 1);
    assert.equal((await f.readDoc()).attemptId, attempted.attemptId);
  } finally { await f.close(); }
});

test('incomplete discovery or a native link appearing during discovery prevents the first write', async () => {
  for (const change of ['incomplete', 'appear'] as const) {
    const f = await fixture();
    try {
      f[change](); const result = await f.run(); assert.notEqual(result.status, 'draft');
      assert.equal(f.created(), 0); assert.equal((await f.readDoc()).reservationAttempted, false);
      assert.equal((await f.readDoc()).nativeDraftEnabled, true); assert.equal((await f.readDoc()).orderCreationAllocation, undefined);
    } finally { await f.close(); }
  }
});

test('historical native-only flow and an existing uncertain first attempt never opt into first creation', async () => {
  const f = await fixture();
  try {
    await f.store.mutate(f.source, data => { delete data.tripSaby!.trips[f.tripId].orderConsignmentCreationVersion; return { result: undefined, changed: true }; });
    assert.equal((await f.run()).waitingForNativeDraft, true); assert.equal(f.created(), 0);
    await f.store.mutate(f.source, data => {
      data.tripSaby!.trips[f.tripId].orderConsignmentCreationVersion = 2;
      const doc = data.etrn!.trips[f.tripId].deliveries[f.trip.customers[0].id].document!;
      doc.reservationAttempted = true; doc.status = 'unknown';
      return { result: undefined, changed: true };
    });
    const result = await f.run(); assert.equal(result.status, 'unknown'); assert.equal(f.created(), 0);
    assert.equal((await f.readDoc()).orderCreationAllocation, undefined);
  } finally { await f.close(); }
});

test('missing order signatures and a changed first draft stop creation without a replacement', async () => {
  const f = await fixture();
  try {
    const sender = (f.order.Вложение as SabyObject[])[0], signature = sender.Подпись;
    delete sender.Подпись;
    assert.notEqual((await f.run()).status, 'draft'); assert.equal(f.created(), 0);
    sender.Подпись = signature;
    const first = await f.run(); assert.equal(first.status, 'draft', first.lastError ?? '');
    f.api.docs.get(first.id!)!.Номер = '999';
    assert.notEqual((await f.run(1)).status, 'draft'); assert.equal(f.created(), 1);
  } finally { await f.close(); }
});

test('an unresolved lost creation result does not repeat Write even when marker search returns no note', async () => {
  const f = await fixture();
  try {
    f.lose(); assert.equal((await f.run()).status, 'unknown'); assert.equal(f.created(), 1);
    for (const [id, doc] of f.api.docs) if (doc.Тип === 'ConsignmentNote') f.api.docs.delete(id);
    assert.equal((await f.run()).status, 'unknown'); assert.equal(f.created(), 1);
    assert.equal((await f.readDoc()).reservationAttempted, true);
  } finally { await f.close(); }
});

test('a version marker alone does not authorize first creation without confirmed signing manifests', async () => {
  const f = await fixture();
  try {
    await f.store.mutate(f.source, data => { delete data.tripSaby!.trips[f.tripId].signing; return { result: undefined, changed: true }; });
    const result = await f.run(); assert.notEqual(result.status, 'draft'); assert.equal(f.created(), 0);
    assert.equal((await f.readDoc()).reservationAttempted, false);
  } finally { await f.close(); }
});

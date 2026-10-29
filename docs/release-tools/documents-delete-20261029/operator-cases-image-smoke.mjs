// Run in each candidate image with --network none, no production mounts, and a tmpfs /tmp.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { createProductionRuntime } from '/app/server-render/production.mjs';

assert.equal(process.env.ARTEL_RELEASE_NETWORK_NONE, 'true', 'Use the isolated release smoke runner');
let externalRequests = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async () => { externalRequests++; throw new Error('External fetch forbidden in synthetic operator-case smoke'); };
const root = await mkdtemp(resolve(tmpdir(), 'artel-case-image-smoke-'));
const snapshot = resolve(root, 'snapshot'), store = resolve(root, 'operations');
await Promise.all([mkdir(snapshot), mkdir(store)]);
const hash = value => createHash('sha256').update(value).digest('hex');
const sourceSha256 = 'a'.repeat(64);
const meta = { source_file: 'synthetic.xlsx', source_sha256: sourceSha256, created_at_utc: '2026-10-21T00:00:00Z', source_kind: 'test', google_verified: false, formula_policy: '', ownership_policy: '' };
const validation = { status: 'ok', registry_verified: false, issue_counts: {}, cell_issues: [], record_flag_counts: {}, duplicate_record_candidates: [], legal_form_alias_candidate_groups: [], multiple_manager_companies: [], limitations: [] };
const files = {};
for (const name of ['companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report']) {
  const raw = JSON.stringify({ meta, data: name === 'validation_report' ? validation : [] });
  await writeFile(resolve(snapshot, name + '.json'), raw);
  files[name + '.json'] = { sha256: hash(raw), bytes: Buffer.byteLength(raw) };
}
await writeFile(resolve(snapshot, 'manifest.json'), JSON.stringify({ meta, counts: {}, files }));
const initial = { schemaVersion: 2, sourceSha256, revision: 0, shipments: {}, companies: [], paymentAllocations: [], directories: { managers: [], products: [], paymentForms: [], vehicles: [], drivers: [], addresses: [], defaults: { profit: 'template-payment-form' }, duplicates: [], customerManagers: [], fleetSeedApplied: true } };
await writeFile(resolve(store, 'operations.json'), JSON.stringify({ sha256: hash(JSON.stringify(initial)), data: initial }));
const origin = 'https://operator-cases-qa.example.test', setupToken = randomUUID();
const env = { ARTEL_PUBLIC_ORIGIN: origin, ARTEL_SNAPSHOT_DIR: snapshot, ARTEL_STORE_DIR: store, ARTEL_SETUP_TOKEN: setupToken, ARTEL_BANK_REQUESTS_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_GEOCODER_ENABLED: 'false', SABY_WORKFLOW_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false', PORT: '0' };
let runtime, cookie;
const checks = [];
const request = (path, method = 'GET', body) => new Promise((done, reject) => {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  const req = httpRequest({ hostname: '127.0.0.1', port: runtime.server.address().port, path, method, headers: { host: 'operator-cases-qa.example.test', origin, 'content-type': 'application/json', ...(payload ? { 'content-length': Buffer.byteLength(payload) } : {}), ...(cookie ? { cookie } : {}) } }, response => {
    const chunks = []; response.on('data', chunk => chunks.push(chunk)); response.on('error', reject);
    response.on('end', () => done({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()), cookie: response.headers['set-cookie']?.[0]?.split(';')[0] }));
  });
  req.on('error', reject); req.setTimeout(15000, () => req.destroy(new Error('Synthetic HTTP request timed out'))); req.end(payload);
});
const ok = async (path, method = 'GET', body, status = 200) => {
  const response = await request(path, method, body);
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(response.body)}`);
  return response.body;
};
const workspace = () => ok('/api/operator');
const diskOperator = async () => JSON.parse(await readFile(resolve(store, 'operations.json'), 'utf8')).data.operator;
const operationById = async id => (await workspace()).refuellings.find(row => row.id === id);
const caseById = async id => (await workspace()).cases.find(row => row.id === id);

try {
  runtime = await createProductionRuntime(env); await runtime.start();
  assert.equal((await request('/api/operator/cases', 'POST', {})).status, 401);
  const password = randomUUID();
  const setup = await request('/api/auth/setup', 'POST', { name: 'Synthetic case director', login: 'case-image-admin', password, setupToken });
  assert.equal(setup.status, 200); cookie = setup.cookie;
  const manager = (await ok('/api/directories', 'POST', { kind: 'managers', name: 'Synthetic case operator' }, 201)).entry;
  await ok('/api/auth/users', 'POST', { name: 'Synthetic case operator', login: 'case-image-operator', password, role: 'employee', managerId: manager.id, sections: ['operator', 'directories'] }, 201);
  const secondManager = (await ok('/api/directories', 'POST', { kind: 'managers', name: 'Synthetic second operator' }, 201)).entry;
  await ok('/api/auth/users', 'POST', { name: 'Synthetic second operator', login: 'case-image-second', password, role: 'employee', managerId: secondManager.id, sections: ['operator'] }, 201);
  const login = await request('/api/auth/login', 'POST', { login: 'case-image-operator', password });
  assert.equal(login.status, 200); cookie = login.cookie;
  const actor = login.body.user;
  const catalog = await workspace(), service = catalog.services.find(row => row.name === 'Лукойл');
  assert.ok(service); assert.ok(catalog.services.some(row => row.name === 'ННК' && row.discountPercent === '10'));
  assert.deepEqual(catalog.groups, [], 'A new operation must work without any operator group in the catalog');
  const recipients = ['First', 'Second'].map(name => ({ id: randomUUID(), name: 'Synthetic ' + name, bank: 'Synthetic bank', card: '0000', phone: '', details: '', limit: '1000000' }));
  const planResult = await ok('/api/operator/plans', 'POST', { clientName: 'Synthetic case client', recipients, idempotencyKey: randomUUID() }, 201);
  const plan = async () => (await workspace()).plans.find(row => row.id === planResult.id);
  assert.equal((await plan()).createdBy, actor.id); checks.push('operatorCreatesOwnPlan', 'nnkTenPercent');

  const fuelPayload = async (overrides = {}) => {
    const current = await plan(), amount = overrides.amount ?? '64800.00';
    const second = (Math.round(Number(amount) * 100) - 3000000) / 100;
    return { schemaVersion: 3, date: '2026-10-21', name: 'Synthetic case driver', serviceId: service.id, serviceVersion: service.version ?? 0, discountPercent: '10', litres: '900', pricePerLitre: '80', amount, amountMode: 'auto', comment: 'Synthetic isolated check', planId: current.id, planVersion: current.version, allocations: [{ kind: 'recipient', recipientId: recipients[0].id, amount: '30000.00' }, { kind: 'recipient', recipientId: recipients[1].id, amount: second.toFixed(2) }], ...overrides, idempotencyKey: randomUUID() };
  };
  const saveFuel = async (overrides = {}, paid = true) => {
    const payload = await fuelPayload(overrides), result = await ok('/api/operator/refuellings', 'POST', payload, 201);
    if (paid) await ok(`/api/operator/refuellings/${result.id}/payment`, 'PATCH', { version: 1, paid: true, idempotencyKey: randomUUID() });
    return { payload, row: await operationById(result.id) };
  };
  const createCase = async (row, kind, litres = '50') => {
    const payload = { operationId: row.id, operationVersion: row.version, kind, ...(kind === 'return' ? { litres } : {}), idempotencyKey: randomUUID() };
    const result = await ok('/api/operator/cases', 'POST', payload, 201);
    return { payload, result, row: await caseById(result.id) };
  };
  const settle = (entry, method, litres) => ok(`/api/operator/cases/${entry.id}/settle`, 'PATCH', { version: entry.version, method, ...(method === 'fuel' ? { litres } : {}), idempotencyKey: randomUUID() });

  const paidSource = await saveFuel();
  assert.equal(Object.hasOwn(paidSource.row, 'groupId'), false); assert.equal(Object.hasOwn(paidSource.row, 'groupName'), false);
  assert.deepEqual((await workspace()).groups, []); checks.push('blankGroupCreationWithoutCatalogGroups');
  const sourceBefore = structuredClone(paidSource.row), planBefore = await plan();
  const refund = await createCase(paidSource.row, 'return');
  assert.equal(refund.row.amount, '3600.00'); assert.equal(refund.row.source.driverName, paidSource.row.name);
  assert.deepEqual(await ok('/api/operator/cases', 'POST', refund.payload), { ...refund.result, replayed: true });
  const moneyBody = { version: 1, method: 'money', idempotencyKey: randomUUID() };
  const returned = await ok(`/api/operator/cases/${refund.row.id}/settle`, 'PATCH', moneyBody);
  assert.ok(returned.settlementId); assert.equal(returned.version, 2);
  assert.deepEqual(await ok(`/api/operator/cases/${refund.row.id}/settle`, 'PATCH', moneyBody), { ...returned, replayed: true });
  const closedRefund = await caseById(refund.row.id);
  assert.equal(closedRefund.remainingLitres, '0'); assert.equal(closedRefund.remainingAmount, '0.00'); assert.equal(closedRefund.status, 'completed'); assert.equal(closedRefund.settlements.length, 1); assert.equal(closedRefund.settlements[0].amount, '3600.00');
  assert.deepEqual(await operationById(paidSource.row.id), sourceBefore); assert.deepEqual(await plan(), planBefore);
  checks.push('paid900Return50Money3600', 'returnCreateReplay', 'moneyReplaySingleSettlement', 'sourceAllocationsLimitsUnchanged');
  const guardedBefore = await diskOperator();
  for (const [suffix, fields] of [['/delete', {}], ['', { ...paidSource.payload, comment: 'Forbidden change' }]]) {
    assert.equal((await request(`/api/operator/refuellings/${paidSource.row.id}${suffix}`, 'PATCH', { ...fields, version: paidSource.row.version, idempotencyKey: randomUUID() })).status, 409);
  }
  assert.deepEqual(await diskOperator(), guardedBefore); checks.push('sourceHistoryGuardsNoMutation');

  const manual = await saveFuel({ amount: '63000.00', amountMode: 'manual' });
  const manualRefund = await createCase(manual.row, 'return');
  assert.equal(manualRefund.row.amount, '3600.00'); assert.equal(manualRefund.row.source.amount, '63000.00');
  assert.equal(Object.hasOwn(manualRefund.row, 'task'), false); assert.equal(Object.hasOwn(manualRefund.row, 'taskHistory'), false);
  const taskFinancialBefore = await workspace(), originalManualCase = structuredClone(manualRefund.row);
  const taskPath = `/api/operator/cases/${manualRefund.row.id}/task`;
  const taskBody = { version: manualRefund.row.version, dueDate: '2026-10-22', comment: '  Confirm return with the driver  ', idempotencyKey: randomUUID() };
  const scheduledReplies = await Promise.all([request(taskPath, 'PATCH', taskBody), request(taskPath, 'PATCH', taskBody)]);
  assert.deepEqual(scheduledReplies.map(row => row.status), [200, 200]);
  assert.deepEqual(scheduledReplies.map(row => row.body.replayed).sort(), [false, true]);
  const originalTaskResult = scheduledReplies.find(row => row.body.replayed === false).body;
  assert.ok(originalTaskResult.taskEventId); assert.equal(originalTaskResult.version, 2);
  let tasked = await caseById(manualRefund.row.id);
  assert.equal(tasked.taskHistory.length, 1); assert.equal(tasked.taskHistory[0].id, originalTaskResult.taskEventId);
  assert.equal(tasked.task.comment, taskBody.comment.trim()); assert.equal(tasked.task.dueDate, taskBody.dueDate);
  assert.equal(tasked.task.createdBy, actor.id); assert.equal(tasked.task.updatedBy, actor.id);
  assert.equal(tasked.version, 1 + tasked.settlements.length + tasked.taskHistory.length);
  const financialCase = entry => Object.fromEntries(Object.entries(entry).filter(([key]) => !['task', 'taskHistory', 'version', 'updatedAt'].includes(key)));
  assert.deepEqual(financialCase(tasked), financialCase(originalManualCase));
  assert.equal((await workspace()).cases.length, taskFinancialBefore.cases.length);
  checks.push('manualTaskOnlyExistingCaseNoFinancialCreation', 'taskSameKeyConcurrencyAndOriginalReplay');

  const taskInvalidBefore = await diskOperator();
  for (const fields of [{ dueDate: '' }, { dueDate: '2026-02-30' }, { comment: 'x'.repeat(2001) }, { amount: '1' }, { litres: '1' }]) {
    assert.equal((await request(taskPath, 'PATCH', { version: tasked.version, dueDate: '2026-10-22', comment: '', ...fields, idempotencyKey: randomUUID() })).status, 400);
  }
  assert.equal((await request(taskPath, 'PATCH', { ...taskBody, comment: 'Different body, same key' })).status, 409);
  assert.deepEqual(await diskOperator(), taskInvalidBefore); checks.push('invalidTaskPayloadsNoMutation');

  const firstOperatorCookie = cookie;
  const secondLogin = await request('/api/auth/login', 'POST', { login: 'case-image-second', password });
  assert.equal(secondLogin.status, 200); cookie = secondLogin.cookie;
  const secondActor = secondLogin.body.user, sharedCase = await caseById(manualRefund.row.id);
  assert.equal(sharedCase.taskHistory[0].id, originalTaskResult.taskEventId);
  const transferred = await ok(taskPath, 'PATCH', { version: sharedCase.version, dueDate: '2026-10-23', comment: 'Driver will arrive tomorrow', idempotencyKey: randomUUID() });
  tasked = await caseById(manualRefund.row.id);
  assert.equal(tasked.task.createdBy, actor.id); assert.equal(tasked.task.updatedBy, secondActor.id);
  assert.equal(tasked.createdBy, originalManualCase.createdBy); assert.equal(tasked.taskHistory.length, 2);
  assert.equal(tasked.taskHistory[1].id, transferred.taskEventId); assert.equal(tasked.taskHistory[1].actorId, secondActor.id);
  cookie = firstOperatorCookie; checks.push('sharedTaskPoolPreservesCreatorAndChangesActor');

  const racingVersion = tasked.version;
  const raced = await Promise.all(['2026-10-24', '2026-10-25'].map(dueDate => request(taskPath, 'PATCH', { version: racingVersion, dueDate, comment: 'Concurrent update', idempotencyKey: randomUUID() })));
  assert.deepEqual(raced.map(row => row.status).sort(), [200, 409]);
  tasked = await caseById(manualRefund.row.id);
  assert.equal(tasked.version, racingVersion + 1); assert.equal(tasked.taskHistory.length, 3); assert.equal(tasked.settlements.length, 0);
  const staleBefore = await diskOperator();
  assert.equal((await request(`/api/operator/cases/${tasked.id}/settle`, 'PATCH', { version: racingVersion, method: 'fuel', litres: '20', idempotencyKey: randomUUID() })).status, 409);
  assert.deepEqual(await diskOperator(), staleBefore); checks.push('competingTaskUpdatesRejectStaleVersion');

  await settle(tasked, 'fuel', '20');
  tasked = await caseById(manualRefund.row.id);
  assert.equal(tasked.status, 'open'); assert.equal(tasked.remainingLitres, '30'); assert.equal(tasked.remainingAmount, '2160.00');
  assert.equal(tasked.taskHistory.length, 3); assert.equal(tasked.settlements.length, 1); assert.equal(tasked.settlements[0].amount, '1440.00');
  assert.equal(tasked.version, 1 + tasked.settlements.length + tasked.taskHistory.length);
  await ok(taskPath, 'PATCH', { version: tasked.version, dueDate: '2026-10-26', comment: '', idempotencyKey: randomUUID() });
  tasked = await caseById(manualRefund.row.id); assert.equal(tasked.status, 'open'); assert.equal(tasked.taskHistory.length, 4);
  checks.push('partialFuelTaskRemainsOpen');
  await settle(tasked, 'money');
  const completedTask = await caseById(manualRefund.row.id);
  assert.equal(completedTask.status, 'completed'); assert.equal(completedTask.remainingLitres, '0'); assert.equal(completedTask.remainingAmount, '0.00');
  assert.equal(completedTask.taskHistory.length, 4); assert.equal(completedTask.settlements.length, 2); assert.equal(completedTask.settlements[1].amount, '2160.00');
  assert.equal(completedTask.version, 1 + completedTask.settlements.length + completedTask.taskHistory.length);
  const completedBefore = await diskOperator();
  assert.equal((await request(taskPath, 'PATCH', { version: completedTask.version, dueDate: '2026-10-27', comment: '', idempotencyKey: randomUUID() })).status, 409);
  assert.deepEqual(await ok(taskPath, 'PATCH', taskBody), { ...originalTaskResult, replayed: true });
  assert.deepEqual(await diskOperator(), completedBefore);
  checks.push('completedCaseTaskClosesAndRejectsReschedule', 'taskOriginalReplayAfterFurtherHistory');
  const taskFinancialAfter = await workspace();
  assert.deepEqual(taskFinancialAfter.refuellings, taskFinancialBefore.refuellings); assert.deepEqual(taskFinancialAfter.plans, taskFinancialBefore.plans);
  assert.equal(taskFinancialAfter.cases.length, taskFinancialBefore.cases.length);
  assert.deepEqual(taskFinancialAfter.cases.filter(row => row.id !== manualRefund.row.id), taskFinancialBefore.cases.filter(row => row.id !== manualRefund.row.id));
  checks.push('taskDoesNotChangeOriginalOperationPlanOrAllocations', 'manualSourceAmountKeepsOriginalDiscountedReturn');

  const postponedSource = await saveFuel(), postponed = await createCase(postponedSource.row, 'deferred');
  assert.equal(postponed.row.litres, '900');
  const deferredBefore = { operation: postponedSource.row, plan: await plan() };
  await settle(postponed.row, 'fuel', '800');
  const remainder = await caseById(postponed.row.id);
  assert.equal(remainder.remainingLitres, '100'); assert.equal(remainder.remainingAmount, '7200.00'); assert.equal(remainder.status, 'open');
  assert.equal((await request(`/api/operator/cases/${remainder.id}/settle`, 'PATCH', { version: remainder.version, method: 'money', idempotencyKey: randomUUID() })).status, 400);
  assert.equal((await request(`/api/operator/cases/${remainder.id}/settle`, 'PATCH', { version: 1, method: 'fuel', litres: '100', idempotencyKey: randomUUID() })).status, 409);
  assert.deepEqual(await operationById(postponedSource.row.id), deferredBefore.operation); assert.deepEqual(await plan(), deferredBefore.plan);
  checks.push('deferred900Fuel800Leaves100', 'deferredMoneyForbidden', 'staleSettlementRejected');

  const creditSource = await saveFuel(), credit = await createCase(creditSource.row, 'return');
  const carryPayload = await fuelPayload({ amount: '61200.00', carryovers: [{ caseId: credit.row.id, version: credit.row.version, litres: '50' }] });
  const carryResult = await ok('/api/operator/refuellings', 'POST', carryPayload, 201), carryBeforeReplay = await diskOperator();
  assert.equal((await ok('/api/operator/refuellings', 'POST', carryPayload)).id, carryResult.id);
  assert.deepEqual(await diskOperator(), carryBeforeReplay);
  const carried = await operationById(carryResult.id), consumedCredit = await caseById(credit.row.id);
  assert.equal(carried.litres, '900'); assert.equal(carried.creditedAmount, '3600.00'); assert.equal(carried.amount, '61200.00'); assert.equal(carried.carryovers.length, 1); assert.equal(carried.allocations[1].amount, '31200.00');
  assert.equal(consumedCredit.remainingLitres, '0'); assert.equal(consumedCredit.settlements.length, 1); assert.equal(consumedCredit.settlements[0].operationId, carried.id);
  assert.equal((await request(`/api/operator/refuellings/${carried.id}/delete`, 'PATCH', { version: carried.version, idempotencyKey: randomUUID() })).status, 409);
  await ok(`/api/operator/refuellings/${carried.id}/payment`, 'PATCH', { version: carried.version, paid: true, idempotencyKey: randomUUID() });
  const carriedPaid = await operationById(carried.id), carriedDeferred = await createCase(carriedPaid, 'deferred');
  assert.equal(carriedDeferred.row.litres, '900');
  const chain = (await workspace()).cases.filter(row => [credit.row.id, carriedDeferred.row.id].includes(row.id));
  assert.deepEqual(chain.filter(row => row.status === 'open').map(row => row.remainingLitres), ['900']);
  assert.equal((await request(`/api/operator/refuellings/${carried.id}/payment`, 'PATCH', { version: carriedPaid.version, paid: false, idempotencyKey: randomUUID() })).status, 200);
  const carryGuardsBefore = await diskOperator();
  assert.equal((await request('/api/operator/refuellings', 'POST', { ...carryPayload, idempotencyKey: randomUUID() })).status, 409);
  assert.deepEqual(await diskOperator(), carryGuardsBefore);
  checks.push('new900CreditsOldValue3600', 'carryoverReplayNoSecondDebit', 'creditedPurchasePaymentAllowed', 'newDeferred900ClosesOld50', 'carryoverReuseRejectedPaymentReversible');

  const beforeReconciliation = await workspace();
  const reconciliationPayload = {date:'2026-10-28',serviceId:service.id,litres:'123.456',amount:'7890.12',idempotencyKey:randomUUID()};
  const reconciliation = await ok('/api/operator/reconciliations','POST',reconciliationPayload,201);
  const savedReconciliation = (await workspace()).reconciliations.find(row=>row.id===reconciliation.id);
  assert.equal(savedReconciliation.litres,'123.456'); assert.equal(savedReconciliation.amount,'7890.12');
  assert.equal(savedReconciliation.history.length,1); assert.equal(savedReconciliation.history[0].actorId,actor.id);
  const reconciledStore=await diskOperator();
  assert.equal((await ok('/api/operator/reconciliations','POST',reconciliationPayload)).id,reconciliation.id);
  assert.deepEqual(await diskOperator(),reconciledStore);
  assert.equal((await request('/api/operator/reconciliations','POST',{...reconciliationPayload,idempotencyKey:randomUUID()})).status,409);
  await ok(`/api/operator/reconciliations/${reconciliation.id}`,'PATCH',{...reconciliationPayload,version:1,litres:'0',amount:'0',idempotencyKey:randomUUID()});
  const finalReconciliation=(await workspace()).reconciliations.find(row=>row.id===reconciliation.id);
  assert.equal(finalReconciliation.version,2);assert.equal(finalReconciliation.history.length,2);
  assert.equal((await request(`/api/operator/reconciliations/${reconciliation.id}`,'PATCH',{...reconciliationPayload,version:1,idempotencyKey:randomUUID()})).status,409);
  const afterReconciliation=await workspace();
  for(const key of ['refuellings','plans','cases','recipients'])assert.deepEqual(afterReconciliation[key],beforeReconciliation[key]);
  checks.push('reconciliationCreateHistoryAndReplay','reconciliationDuplicateAndStaleGuards','reconciliationZeroUpdateAndNoMoneyMutation');

  const beforeRestart = await workspace(), operatorBeforeRestart = await diskOperator();
  await runtime.stop(); runtime = await createProductionRuntime(env); await runtime.start();
  assert.deepEqual(await workspace(), beforeRestart); assert.deepEqual(await diskOperator(), operatorBeforeRestart);
  assert.deepEqual(await ok(taskPath, 'PATCH', taskBody), { ...originalTaskResult, replayed: true });
  assert.deepEqual(await caseById(manualRefund.row.id), completedTask); assert.deepEqual(await diskOperator(), operatorBeforeRestart);
  assert.equal(externalRequests, 0); checks.push('restartPersistsCasesCarryoversAndSession', 'restartPersistsTaskHistoryAndExactReplay', 'zeroExternalRequests');
  console.log(JSON.stringify({ synthetic: true, networkDisabled: true, productionMountsUsed: false, externalRequests, checks }));
} finally {
  await runtime?.stop(); globalThis.fetch = originalFetch; await rm(root, { recursive: true, force: true });
}

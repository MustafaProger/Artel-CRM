// Reusable synthetic contract tests. Reads only the adjacent audit helper.
// Run: node --test test-audit-data.mjs
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const auditPath = fileURLToPath(new URL('./audit-data.mjs', import.meta.url));
const sha = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const time = '2026-10-20T10:00:00.000Z';
const later = '2026-10-20T10:01:00.000Z';
const fixture = () => ({
  revision: 10,
  shipments: {
    'shipment-synthetic': { id: 'shipment-synthetic', fields: { quantity_litres: '10228' } },
  },
  directories: {
    vehicles: [{ id: 'vehicle-synthetic', capacityLitres: '10228', payloadTonnes: '12', cargoDistributable: '1' }],
  },
  companies: [{ id: 'company-synthetic', phone: '+70000000000' }],
  operator: {
    recipients: {},
    plans: {
      syntheticPlan: { recipients: [{ id: 'syntheticRecipient', limit: '100000.00' }] },
    },
    refuellings: {
      syntheticSource: { litres: '900', amount: '63000.00', paid: true },
      syntheticPurchase: {
        litres: '900', payableLitres: '850', amount: '61200.00',
        carryovers: [{ caseId: 'syntheticCase', settlementId: 'syntheticSettlement', litres: '50', driverName: 'Synthetic driver' }],
        allocations: [{ recipientId: 'syntheticRecipient', amount: '61200.00' }],
      },
    },
    cases: {
      syntheticCase: {
        version: 2, operationId: 'syntheticSource', kind: 'return', litres: '50', amount: '3600.00',
        updatedAt: time,
        source: { operationVersion: 2, driverName: 'Synthetic driver', litres: '900', pricePerLitre: '80', discountPercent: '10', amount: '63000.00' },
        settlements: [{ id: 'syntheticSettlement', method: 'carryover', litres: '50', amount: '3600.00', operationId: 'syntheticPurchase', at: time }],
      },
    },
    requests: {
      syntheticRequest: { collection: 'cases', id: 'syntheticCase', fingerprint: 'f'.repeat(64), actorId: 'syntheticActor', version: 2, settlementId: 'syntheticSettlement' },
    },
  },
  tripSaby: {
    trips: {
      'trip-ordinary': {
        updatedAt: time, lastCheckedAt: time, lastCheckAttemptAt: time, leaseId: null, leaseUntil: null,
        phase: 'signing', attemptId: 'ordinary-attempt', payloadHash: 'a'.repeat(64),
        snapshot: { fields: { quantity_litres: '10228' } },
        carrierFill: { checkedAt: time },
        carrierEvidence: { confirmedAt: time },
        signing: { sender: { state: 'confirmed', confirmedAt: time } },
      },
    },
  },
  etrn: {
    trips: {
      'trip-direct': {
        updatedAt: time,
        direct: {
          updatedAt: time, lastCheckedAt: time, lastCheckAttemptAt: time, leaseId: null, leaseUntil: null,
          phase: 'unknown', lastError: 'synthetic unknown reserve', attemptId: 'direct-attempt',
          authorization: { sourceHash: 'b'.repeat(64), factsHash: 'c'.repeat(64), actorId: 'synthetic-actor' },
          deliveries: [{ shipmentId: 'shipment-synthetic', snapshot: { fields: { quantity_litres: '10228' } } }],
        },
        deliveries: {
          'shipment-synthetic': {
            updatedAt: time,
            document: {
              updatedAt: time, leaseId: null, leaseUntil: null, status: 'unknown', id: null,
              attemptId: 'document-attempt', marker: 'synthetic-marker', payloadHash: 'd'.repeat(64),
              reservationAttempted: true, uploadAttempted: false,
              snapshot: { fields: { quantity_litres: '10228' }, profile: { vehicle: { capacityCubicMetres: '10.228' } } },
              dispatch: { signing: { confirmedAt: time } },
            },
          },
        },
      },
    },
  },
  banking: {
    connections: {
      synthetic: {
        updatedAt: time, lastAttemptAt: time,
        transactions: [
          { id: 'transaction-one', amount: '100.25', date: '2026-10-20' },
          { id: 'transaction-two', amount: '200.50', date: '2026-10-19' },
        ],
      },
    },
  },
  sber: { transactions: [{ id: 'sber-one', amount: '300.75' }, { id: 'sber-two', amount: '400.00' }] },
  sberArtel: { transactions: [{ id: 'artel-one', amount: '500.25' }, { id: 'artel-two', amount: '600.50' }] },
});
const envelope = data => ({ data, sha256: sha(data) });
function runEnvelope(before, after) {
  const result = spawnSync(process.execPath, [auditPath], {
    input: JSON.stringify({ before, after }), encoding: 'utf8', timeout: 10_000,
  });
  assert.equal(result.error, undefined, result.error?.message);
  return result;
}
function audit(before, after) {
  const result = runEnvelope(envelope(before), envelope(after));
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
function change(path, value) {
  const before = fixture(), after = structuredClone(before), parts = path.split('.');
  let parent = after;
  for (const key of parts.slice(0, -1)) parent = parent[key];
  parent[parts.at(-1)] = value;
  return audit(before, after);
}
function assertReviewed(result) {
  assert.equal(result.strictDataEqual, false);
  assert.ok(result.unexplainedChanges > 0);
  assert.ok(result.differences.some(row => row.classification === 'requires_review'));
  assert.equal(result.unexplainedChanges, result.differences.filter(row => row.classification === 'requires_review').length);
}
const direct = 'etrn.trips.trip-direct.direct';
const doc = 'etrn.trips.trip-direct.deliveries.shipment-synthetic.document';
const ordinary = 'tripSaby.trips.trip-ordinary';

test('identical stores verify checksums and all preservation checks', () => {
  const before = fixture(), result = audit(before, structuredClone(before));
  assert.equal(result.checksumVerified, true);
  assert.equal(result.strictDataEqual, true);
  assert.equal(result.unexplainedChanges, 0);
  assert.deepEqual(result.differences, []);
  assert.ok(Object.values(result.checks.facts).every(Boolean));
  assert.equal(result.checks.workflowDocumentsAndAuthorizationUnchanged, true);
  assert.equal(result.checks.bankDataExceptPollingUnchanged, true);
  assert.equal(result.checks.revisionNotRewound, true);
});

for (const side of ['before', 'after']) test(`rejects corrupted ${side} checksum before reporting preservation`, () => {
  const pair = { before: envelope(fixture()), after: envelope(fixture()) };
  pair[side].data.shipments['shipment-synthetic'].fields.quantity_litres = '1';
  const result = runEnvelope(pair.before, pair.after);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Store checksum mismatch/);
  assert.equal(result.stdout.trim(), '');
});

for (const [field, value] of [
  ['updatedAt', later], ['lastCheckedAt', later], ['lastCheckAttemptAt', later],
  ['leaseId', 'synthetic-lease'], ['leaseUntil', later],
]) test(`direct ${field} is polling, with strict inequality retained`, () => {
  const result = change(`${direct}.${field}`, value);
  assert.equal(result.strictDataEqual, false);
  assert.equal(result.checks.workflowDocumentsAndAuthorizationUnchanged, true);
  assert.equal(result.unexplainedChanges, 0);
  assert.equal(result.differences.length, 1);
  assert.equal(result.differences[0].classification, 'workflow_poll');
});

for (const [path, value] of [
  [`${direct}.phase`, 'completed'],
  [`${direct}.lastError`, 'different synthetic result'],
  [`${direct}.attemptId`, 'replacement-attempt'],
  [`${direct}.authorization.sourceHash`, 'e'.repeat(64)],
  [`${direct}.authorization.factsHash`, 'e'.repeat(64)],
  [`${direct}.authorization.actorId`, 'different-actor'],
  [`${direct}.deliveries.0.snapshot.fields.quantity_litres`, '10229'],
  [`${doc}.payloadHash`, 'e'.repeat(64)],
  [`${doc}.attemptId`, 'replacement-document-attempt'],
  [`${doc}.marker`, 'replacement-marker'],
  [`${doc}.reservationAttempted`, false],
  [`${doc}.uploadAttempted`, true],
  [`${doc}.status`, 'draft'],
  [`${doc}.id`, 'new-external-id'],
  [`${doc}.snapshot.fields.quantity_litres`, '10229'],
  [`${doc}.snapshot.profile.vehicle.capacityCubicMetres`, '10.229'],
  [`${doc}.dispatch.signing.confirmedAt`, later],
  [`${ordinary}.signing.sender.confirmedAt`, later],
  [`${ordinary}.payloadHash`, 'e'.repeat(64)],
]) test(`protected workflow mutation remains visible: ${path}`, () => {
  const result = change(path, value);
  assertReviewed(result);
  assert.equal(result.checks.workflowDocumentsAndAuthorizationUnchanged, false);
});

for (const [path, value, group] of [
  ['shipments.shipment-synthetic.fields.quantity_litres', '10229', 'shipments'],
  ['directories.vehicles.0.capacityLitres', '10229', 'directories'],
  ['directories.vehicles.0.payloadTonnes', '13', 'directories'],
  ['directories.vehicles.0.cargoDistributable', '0', 'directories'],
  ['companies.0.phone', '+70000000001', 'companies'],
]) test(`business fact mutation is detected: ${path}`, () => {
  const result = change(path, value);
  assertReviewed(result);
  assert.equal(result.checks.facts[group], false);
});

for (const [path, value] of [
  ['cases.syntheticCase.litres', '51'],
  ['cases.syntheticCase.amount', '3601.00'],
  ['cases.syntheticCase.version', 3],
  ['cases.syntheticCase.updatedAt', later],
  ['cases.syntheticCase.source.amount', '64800.00'],
  ['cases.syntheticCase.source.pricePerLitre', '81'],
  ['cases.syntheticCase.source.discountPercent', '0'],
  ['cases.syntheticCase.source.driverName', 'Replacement driver'],
  ['cases.syntheticCase.settlements.0.litres', '49'],
  ['cases.syntheticCase.settlements.0.amount', '3599.00'],
  ['cases.syntheticCase.settlements.0.operationId', 'replacementPurchase'],
  ['cases.syntheticCase.settlements.0.at', later],
  ['refuellings.syntheticSource.paid', false],
  ['refuellings.syntheticPurchase.carryovers.0.caseId', 'replacementCase'],
  ['refuellings.syntheticPurchase.carryovers.0.settlementId', 'replacementSettlement'],
  ['refuellings.syntheticPurchase.carryovers.0.litres', '49'],
  ['refuellings.syntheticPurchase.payableLitres', '851'],
  ['refuellings.syntheticPurchase.amount', '61272.00'],
  ['refuellings.syntheticPurchase.allocations.0.amount', '61272.00'],
  ['plans.syntheticPlan.recipients.0.limit', '100050.00'],
  ['requests.syntheticRequest.fingerprint', 'e'.repeat(64)],
  ['requests.syntheticRequest.version', 3],
  ['requests.syntheticRequest.settlementId', 'replacementSettlement'],
]) test(`operator accounting and replay history mutation is detected: ${path}`, () => {
  const result = change(`operator.${path}`, value);
  assertReviewed(result);
  assert.equal(result.checks.facts.operator, false);
  assert.equal(result.differences.length, 1);
  assert.equal(result.differences[0].classification, 'requires_review');
});

for (const mutation of ['caseAdded', 'caseRemoved', 'settlementRemoved', 'carryoverRemoved', 'requestRemoved']) {
  test(`operator history structure change is detected: ${mutation}`, () => {
    const before = fixture(), after = structuredClone(before);
    if (mutation === 'caseAdded') after.operator.cases.additionalCase = structuredClone(after.operator.cases.syntheticCase);
    else if (mutation === 'caseRemoved') delete after.operator.cases.syntheticCase;
    else if (mutation === 'settlementRemoved') after.operator.cases.syntheticCase.settlements.pop();
    else if (mutation === 'carryoverRemoved') after.operator.refuellings.syntheticPurchase.carryovers.pop();
    else delete after.operator.requests.syntheticRequest;
    const result = audit(before, after);
    assertReviewed(result);
    assert.equal(result.checks.facts.operator, false);
    assert.ok(result.differences.every(row => row.classification === 'requires_review'));
  });
}

test('adding an empty operator cases map on an old store is still reported as a migration', () => {
  const before = fixture(); delete before.operator.cases;
  const after = structuredClone(before); after.operator.cases = {};
  const result = audit(before, after);
  assertReviewed(result);
  assert.equal(result.checks.facts.operator, false);
});

for (const bank of ['banking', 'sber', 'sberArtel']) {
  const transactions = data => bank === 'banking' ? data.banking.connections.synthetic.transactions : data[bank].transactions;
  test(`${bank} transaction reordering is normalized, with strict inequality retained`, () => {
    const before = fixture(), after = structuredClone(before);
    transactions(after).reverse();
    const result = audit(before, after);
    assert.equal(result.strictDataEqual, false);
    assert.equal(result.checks.bankDataExceptPollingUnchanged, true);
    assert.equal(result.unexplainedChanges, 0);
    assert.deepEqual(result.differences, []);
  });
  for (const mutation of ['amount', 'removed', 'added']) test(`${bank} ${mutation} transaction is detected even after reordering`, () => {
    const before = fixture(), after = structuredClone(before), rows = transactions(after);
    rows.reverse();
    if (mutation === 'amount') rows[0].amount = '999.99';
    else if (mutation === 'removed') rows.pop();
    else rows.push({ id: 'transaction-new', amount: '123.45' });
    const result = audit(before, after);
    assertReviewed(result);
    assert.equal(result.checks.bankDataExceptPollingUnchanged, false);
  });
}

test('bank polling can change without suppressing an accompanying amount change', () => {
  const before = fixture(), after = structuredClone(before);
  after.banking.connections.synthetic.updatedAt = later;
  after.banking.connections.synthetic.transactions[0].amount = '999.99';
  const result = audit(before, after);
  assertReviewed(result);
  assert.equal(result.checks.bankDataExceptPollingUnchanged, false);
  assert.ok(result.differences.some(row => row.classification === 'bank_poll'));
  assert.equal(result.unexplainedChanges, 1);
});

test('decreased revision is explicitly reported as rewound', () => {
  const result = change('revision', 9);
  assert.equal(result.strictDataEqual, false);
  assert.equal(result.checks.revisionNotRewound, false);
  assert.equal(result.differences[0].classification, 'revision');
});

test('differences contain hashes rather than old or new business values', () => {
  const value = 'synthetic confidential replacement reason';
  const result = change(`${direct}.lastError`, value);
  assertReviewed(result);
  assert.doesNotMatch(JSON.stringify(result), /synthetic unknown reserve|synthetic confidential replacement reason/);
  for (const row of result.differences) {
    assert.match(row.beforeHash, /^[a-f0-9]{64}$/);
    assert.match(row.afterHash, /^[a-f0-9]{64}$/);
  }
});


test('trip execution facts match the independent classifier and reject changes', () => {
  const before = fixture(), after = structuredClone(before);
  before.tripExecutions = { synthetic: { version: 1 } }; after.tripExecutions = { synthetic: { version: 2 } };
  const result = spawnSync(process.execPath, [auditPath], { input: JSON.stringify({ before: { data: before, sha256: sha(before) }, after: { data: after, sha256: sha(after) } }), encoding: 'utf8' });
  assert.equal(result.status, 0);
  assert.equal(JSON.parse(result.stdout).checks.facts.tripExecutions, false);
});

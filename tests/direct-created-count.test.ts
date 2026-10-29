import assert from 'node:assert/strict';
import test from 'node:test';
import { directWorkflowSteps } from '../web/src/trip-workflow-view';
import type { TripSabyResponse } from '../web/src/trip-saby-model';
test('an existing direct document remains created while its signature needs reconciliation', () => {
  const result = { ready: false, locked: true, deliveries: [{ shipmentId: 'one', id: 'remote-document', status: 'unknown', dispatch: { sender: { state: 'blocked' }, carrier: { state: 'not_started' } } }, { shipmentId: 'two', id: null, status: 'not_sent' }] } as TripSabyResponse;
  const steps = directWorkflowSteps(result, ['one', 'two']);
  assert.equal(steps[2].note, '1 из 2');
  assert.equal(steps[2].state, 'current');
  assert.equal(steps[3].note, '0 из 2');
});

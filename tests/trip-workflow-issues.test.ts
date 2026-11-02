import assert from 'node:assert/strict'
import test from 'node:test'
import { tripWorkflowIssues } from '../web/src/trip-workflow-issues'
import { readTripWorkflowIssues } from '../server/trip-workflow-issues'
import type { OperationsData } from '../server/operations-store'

test('ordinary pending signatures and successful completion have no warning', () => {
  for (const state of ['waiting', 'requested', 'confirmed'] as const) assert.deepEqual(tripWorkflowIssues({ phase: 'completed', signing: { sender: { state }, carrier: { state } } }), [])
})
test('each side and preparation can require attention independently', () => {
  const issues = tripWorkflowIssues({ blockers: ['Не указан VIN'], signing: { sender: { state: 'blocked', message: 'Нет подписи' }, carrier: { state: 'unknown' } } })
  assert.deepEqual(issues.map(row => row.step), [0, 2, 4])
})
test('direct carrier issue is marked at carrier signing; recovery clears indicator', () => {
  const dispatch = { sender: { state: 'confirmed' as const }, carrier: { state: 'blocked' as 'blocked' | 'confirmed' }, lastError: 'Проверьте титул перевозчика' }
  const input = { documentMode: 'nk_direct_etrn' as const, deliveries: [{ shipmentId: 'one', status: 'draft', dispatch }] }
  assert.equal(tripWorkflowIssues(input)[0].step, 4)
  dispatch.carrier.state = 'confirmed'; dispatch.lastError = ''
  assert.deepEqual(tripWorkflowIssues(input), [])
})
test('saved projection includes document dispatch errors without exposing private fields or changing data', () => {
  const data = { tripSaby: { trips: {} }, etrn: { trips: { one: { direct: { phase: 'sending_etrn', lastError: null, authorization: { secret: 'PRIVATE' } }, deliveries: { customer: { document: { status: 'draft', snapshot: { private: 'PRIVATE' }, dispatch: { sender: { state: 'confirmed' }, carrier: { state: 'blocked' }, lastError: 'Титул не заполнен' } } } } } } } } as unknown as OperationsData
  const before = JSON.stringify(data)
  const issues = readTripWorkflowIssues(data, 'one')
  assert.equal(issues[0].step, 4)
  assert.equal(issues[0].shipmentId, 'customer')
  assert.doesNotMatch(JSON.stringify(issues), /PRIVATE|snapshot|authorization/)
  assert.equal(JSON.stringify(data), before)
})
test('unknown result and failed automatic enrollment remain visible', () => {
  assert.equal(tripWorkflowIssues({ phase: 'unknown' }).length, 1)
  const data = { etrn: { trips: { one: { directAutostart: { state: 'blocked', lastError: 'Запуск приостановлен' }, deliveries: {} } } } } as unknown as OperationsData
  assert.equal(readTripWorkflowIssues(data, 'one')[0].message, 'Запуск приостановлен')
})

test('completed ordinary handoff never hides genuine stage 7 errors or unknown outcomes', () => {
  const dispatch = { sender: { state: 'confirmed' as const }, carrier: { state: 'confirmed' as const }, completedAt: '2026-11-01T12:00:00Z', lastError: null as string | null };
  const input = { phase: 'completed' as const, deliveries: [{ shipmentId: 'one', status: 'draft', lastError: null as string | null, dispatch }] };
  assert.deepEqual(tripWorkflowIssues(input), []);
  for (const status of ['unknown', 'error']) {
    assert.equal(tripWorkflowIssues({ ...input, deliveries: [{ ...input.deliveries[0], status }] })[0].step, 6);
  }
  for (const message of ['Для автоматической сверки требуется одна ЭТрН, связанная с единственной доставкой заявки.', 'Получатель не совпадает', 'Документ отклонён']) {
    const issue = tripWorkflowIssues({ ...input, deliveries: [{ ...input.deliveries[0], lastError: message }] });
    assert.equal(issue[0].step, 6); assert.equal(issue[0].message, message);
    const dispatchIssue = tripWorkflowIssues({ ...input, deliveries: [{ ...input.deliveries[0], dispatch: { ...dispatch, lastError: message } }] });
    assert.equal(dispatchIssue[0].message, message);
  }
  for (const side of ['sender', 'carrier'] as const) for (const state of ['unknown', 'blocked'] as const) {
    const issues = tripWorkflowIssues({ ...input, deliveries: [{ ...input.deliveries[0], dispatch: { ...dispatch, [side]: { state } } }] });
    assert.equal(issues[0].step, 6);
  }
});

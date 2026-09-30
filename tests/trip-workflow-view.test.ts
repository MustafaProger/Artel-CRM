import assert from 'node:assert/strict';
import test from 'node:test';
import type { TripSabyExchangeStage, TripSabyResponse } from '../web/src/trip-saby-model';
import { workflowView } from '../web/src/trip-workflow-view';

function failedWorkflow(stage?: TripSabyExchangeStage, carrierConfirmed = false): TripSabyResponse {
  return {
    status: 'error', phase: 'error', ready: true, blockers: [], locked: true,
    updatedAt: null, lastError: 'Создание документа не выполнено.', deliveries: [],
    carrierConfirmed, lastCheckedAt: null, lastCheckAttemptAt: null,
    monitoring: { enabled: false, intervalSeconds: null }, history: [],
    order: {
      id: 'order-id', number: null, date: null, status: 'draft', url: null,
      revision: null, remoteStatus: null, signatureStatus: 'unknown', exchangeStage: stage,
    },
  };
}

test('ETRN creation failure after carrier confirmation stays at the ETRN step and reports a pause', () => {
  for (const state of [failedWorkflow('carrier_confirmed', true), failedWorkflow(undefined, true)]) {
    const view = workflowView(state);
    assert.equal(view.title, 'Создание ЭТрН приостановлено');
    assert.equal(view.step, 3);
  }
});

test('terminal remote states retain their specific failure labels over prior confirmation', () => {
  const cases = [
    ['rejected', 'НК АРТЕЛЬ отклонило заявку', 2],
    ['operator_error', 'Ошибка обработки Saby', 1],
    ['cancelled', 'Заявка аннулирована', 1],
  ] as const;
  for (const [stage, title, step] of cases) {
    const view = workflowView(failedWorkflow(stage, true));
    assert.equal(view.title, title);
    assert.equal(view.step, step);
  }
});

test('other workflow failures do not present the last pending stage as an ongoing action', () => {
  for (const stage of ['sender_action_required', 'signature_pending', 'sending_to_carrier', 'carrier_details_required', 'carrier_action_required', 'carrier_confirmation_pending', 'unknown', undefined] as const) {
    const view = workflowView(failedWorkflow(stage));
    assert.equal(view.title, 'Обмен приостановлен');
    assert.equal(view.step, 1);
  }
});

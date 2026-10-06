import assert from 'node:assert/strict';
import test from 'node:test';
import type { TripSabyExchangeStage, TripSabyResponse } from '../web/src/trip-saby-model';
import { signingStepView, workflowDate, workflowOrderLabel, workflowView } from '../web/src/trip-workflow-view';

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
    assert.equal(view.step, 4);
  }
});

test('terminal remote states retain their specific failure labels over prior confirmation', () => {
  const cases = [
    ['rejected', 'НК АРТЕЛЬ отклонило заявку', 3],
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

test('sender and carrier actions explain explicit CRM signing without obsolete access assumptions', () => {
  for (const stage of ['sender_action_required', 'carrier_action_required'] as const) {
    const state = failedWorkflow(stage);
    state.phase = 'awaiting_carrier';
    const view = workflowView(state);
    assert.match(view.text, /CRM/);
    assert.match(view.text, /запустите|запуска/);
    assert.doesNotMatch(view.text, /МЧД|нет подписи|откройте заявку|кабинете/);
    assert.equal(view.step, stage === 'sender_action_required' ? 1 : 3);
  }
});

test('generic signature wait does not assume owner approval or device availability was verified', () => {
  const state = failedWorkflow('signature_pending');
  state.phase = 'awaiting_carrier';
  assert.match(workflowView(state).text, /Может потребоваться/);
  assert.doesNotMatch(workflowView(state).text, /Saby ожидает подтверждение владельца/);
});

test('signing confirmation identifies the actual order number and date without guessing missing values', () => {
  assert.equal(workflowOrderLabel({ number: '41', date: '2026-09-30' }), 'Заявка № 41 от 30.09.2026');
  assert.equal(workflowOrderLabel({ number: '42', date: '01.10.2026' }), 'Заявка № 42 от 01.10.2026');
  assert.equal(workflowOrderLabel({ number: null, date: null }), 'Заявка · номер ожидается · дата уточняется');
});

test('signature expiry uses the Moscow calendar date across UTC midnight', () => {
  assert.equal(workflowDate('2027-08-07 21:46:48 UTC'), '08.08.2027');
  assert.equal(workflowDate('2027-08-07T21:46:48Z'), '08.08.2027');
  assert.equal(workflowDate('2027-08-08T00:46:48+03:00'), '08.08.2027');
  assert.equal(workflowDate('2027-08-07T20:59:59Z'), '07.08.2027');
  assert.equal(workflowDate('2027-08-07'), '07.08.2027');
  assert.equal(workflowDate('07.08.2027'), '07.08.2027');
});

test('missing, invalid and timezone-free expiry values use the unknown fallback', () => {
  for (const value of [null, undefined, '', 'unknown', '2027-13-07', '2027-02-30', '2027-08-07 21:46:48']) {
    assert.equal(workflowDate(value), 'дата неизвестна');
  }
});

test('automatic signing tracks the selected side and only advances after sender evidence', () => {
  const state = failedWorkflow('signature_pending');
  state.phase = 'awaiting_carrier';
  state.signing = { state: 'active', requestedAt: '2026-10-06T10:00:00Z', sender: { state: 'waiting' }, carrier: { state: 'not_started' } };
  assert.equal(workflowView(state).step, 1);
  assert.match(workflowView(state).title, /^АРТЕЛЬ/);
  state.signing.sender.state = 'confirmed';
  state.signing.carrier.state = 'waiting';
  assert.equal(workflowView(state).step, 3);
  assert.match(workflowView(state).title, /^НК АРТЕЛЬ/);
});

test('lost signing responses explain reconciliation without suggesting another send', () => {
  const state = failedWorkflow('sender_action_required');
  state.phase = 'awaiting_carrier';
  state.signing = { state: 'unknown', requestedAt: '2026-10-06T10:00:00Z', sender: { state: 'unknown' }, carrier: { state: 'not_started' } };
  assert.match(workflowView(state).title, /не подтверждён/);
  assert.match(workflowView(state).text, /повторная отправка не выполняется/);
});

test('carrier filling retains its own step before the automatic carrier signature starts', () => {
  const state = failedWorkflow('carrier_details_required');
  state.phase = 'awaiting_carrier';
  state.carrierFill = { state: 'waiting', blockers: [], driverSaved: false, vehicleSaved: false, checkedAt: null };
  state.signing = { state: 'active', requestedAt: '2026-10-06T10:00:00Z', sender: { state: 'confirmed' }, carrier: { state: 'not_started' } };
  assert.equal(workflowView(state).step, 2);
  assert.equal(workflowView(state).title, 'Ожидаем готовность ответа НК');
});

test('provider owner/device instructions are visible without claiming completion', () => {
  assert.equal(signingStepView({ state: 'waiting', message: 'Включите рабочий компьютер с Saby.' }, 'carrier').text, 'Включите рабочий компьютер с Saby.');
  assert.doesNotMatch(signingStepView({ state: 'waiting' }, 'carrier').title, /подтверждена/);
  assert.match(signingStepView({ state: 'confirmed' }, 'carrier').text, /ответ НК/);
  assert.doesNotMatch(signingStepView({ state: 'waiting' }, 'carrier').text, /ваш|этом устройстве|текущем устройстве/);
  assert.match(signingStepView({ state: 'waiting' }, 'carrier').text, /доступный компьютер/);
});

test('automatic waiting does not claim an owner approval is needed', () => {
  const view = signingStepView({ state: 'waiting' }, 'carrier', 'automatic');
  assert.match(view.text, /ещё не подтвердил подпись/);
  assert.doesNotMatch(view.text, /подтверждение владельца|ваш компьютер|запустите/);
});

test('automatic enrollment before an order exists shows the queue and incomplete data separately', () => {
  const state = failedWorkflow();
  state.phase = 'preparation'; state.order = null; state.locked = false;
  state.automation = { enabled: true, enrolled: true };
  assert.equal(workflowView(state).title, 'Автоматическая отправка в очереди');
  assert.equal(workflowView(state).step, 0);
  state.ready = false; state.blockers = ['Не указан адрес нефтебазы'];
  assert.equal(workflowView(state).title, 'Рейс сохранён · отправка приостановлена');
  assert.doesNotMatch(workflowView(state).text, /нажмите|подтвердите|проверьте подписи/i);
});

test('a global automatic policy alone never presents a legacy order as enrolled', () => {
  const state = failedWorkflow('sender_action_required');
  state.phase = 'awaiting_carrier'; state.automation = { enabled: true, enrolled: false };
  assert.equal(workflowView(state).title, 'Состояние существующей заявки');
  assert.match(workflowView(state).text, /не запускает повторную отправку/);
});

test('legacy carrier uncertainty preserves sender evidence and does not promise automatic completion', () => {
  const state = failedWorkflow('carrier_action_required');
  state.phase = 'awaiting_carrier'; state.automation = { enabled: true, enrolled: false };
  state.signing = { state: 'unknown', mode: 'with_confirmation', requestedAt: '2026-10-06T10:00:00Z', sender: { state: 'confirmed' }, carrier: { state: 'unknown' } };
  assert.equal(workflowView(state).step, 3);
  assert.match(workflowView(state).title, /^НК АРТЕЛЬ/);
  assert.match(workflowView(state).text, /Продолжение приостановлено/);
  assert.doesNotMatch(workflowView(state).text, /подтверждение владельца|после запуска|дождитесь|начнётся/);
  state.phase = 'unknown';
  assert.equal(workflowView(state).step, 3);
});

test('automatic sender and carrier stages do not ask for another launch', () => {
  for (const stage of ['sender_action_required', 'carrier_action_required'] as const) {
    const state = failedWorkflow(stage);
    state.phase = 'awaiting_carrier'; state.automation = { enabled: true, enrolled: true };
    assert.match(workflowView(state).text, /автоматически/);
    assert.doesNotMatch(workflowView(state).text, /запустите|после запуска|выбранной подписью/i);
  }
});

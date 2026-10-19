import assert from 'node:assert/strict';
import test from 'node:test';
import type { TripSabyExchangeStage, TripSabyResponse } from '../web/src/trip-saby-model';
import { driverConfirmedAt, signingStepView, workflowDate, workflowOrderLabel, workflowSteps, workflowTime, workflowView } from '../web/src/trip-workflow-view';

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
  for (const state of [failedWorkflow('carrier_confirmed', true), failedWorkflow(undefined, true), failedWorkflow('carrier_confirmed')]) {
    const view = workflowView(state);
    assert.equal(view.title, 'Создание ЭТрН приостановлено');
    assert.equal(view.step, 5);
  }
});

test('unknown ETRN creation after carrier confirmation stays at stage six without claiming creation succeeded', () => {
  for (const state of [failedWorkflow('carrier_confirmed', true), failedWorkflow(undefined, true), failedWorkflow('carrier_confirmed')]) {
    state.phase = 'unknown';
    state.signing = { state: 'completed', mode: 'automatic', requestedAt: '2026-10-07T13:32:00Z', sender: { state: 'confirmed' }, carrier: { state: 'confirmed' } };
    state.deliveries = [{ shipmentId: 'delivery-id', id: null, status: 'unknown', lastError: 'Результат создания ЭТрН пока не установлен. Повторное создание запрещено.' }];
    for (const driverFlow of [undefined, { state: 'ready' as const, processingAllowanceHours: 10 as const }]) {
      state.driverFlow = driverFlow;
      const view = workflowView(state);
      assert.equal(view.step, 5);
      assert.equal(view.title, 'Создание ЭТрН · нужна сверка');
      assert.match(view.text, /Подтверждение НК получено/);
      assert.match(view.text, /Результат создания ЭТрН пока не установлен/);
      assert.match(view.text, /повторная накладная не создаётся/);
      assert.doesNotMatch(view.title, /ЭТрН созданы|завершены/);
    }
  }
});

test('unknown sender or carrier result remains before ETRN creation without carrier acceptance evidence', () => {
  for (const senderConfirmed of [false, true]) {
    const state = failedWorkflow(senderConfirmed ? 'carrier_confirmation_pending' : 'sender_action_required');
    state.phase = 'unknown';
    state.driverFlow = { state: 'ready', processingAllowanceHours: 10 };
    state.signing = { state: 'unknown', mode: 'automatic', requestedAt: '2026-10-07T13:32:00Z', sender: { state: senderConfirmed ? 'confirmed' : 'unknown' }, carrier: { state: 'unknown' } };
    assert.equal(workflowView(state).step, senderConfirmed ? 4 : 2);
    assert.doesNotMatch(workflowView(state).text, /Подтверждение НК получено/);
  }
});

test('terminal remote states retain their specific failure labels over prior confirmation', () => {
  const cases = [
    ['rejected', 'НК АРТЭЛЬ отклонило заявку', 4],
    ['operator_error', 'Ошибка обработки Saby', 2],
    ['cancelled', 'Заявка аннулирована', 2],
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
    assert.equal(view.step, 2);
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
    assert.equal(view.step, stage === 'sender_action_required' ? 2 : 4);
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
  assert.equal(workflowView(state).step, 2);
  assert.match(workflowView(state).title, /^АРТЭЛЬ/);
  state.signing.sender.state = 'confirmed';
  state.signing.carrier.state = 'waiting';
  assert.equal(workflowView(state).step, 4);
  assert.match(workflowView(state).title, /^НК АРТЭЛЬ/);
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
  assert.equal(workflowView(state).step, 3);
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

test('saved loading facts without an order or enrollment require reconciliation regardless of global automation and readiness', () => {
  for (const enabled of [undefined, false, true]) {
    for (const ready of [false, true]) {
      const state = failedWorkflow();
      state.phase = 'preparation'; state.order = null; state.locked = false;
      state.ready = ready;
      state.blockers = ready ? [] : ['Не указан адрес нефтебазы'];
      state.automation = enabled === undefined ? undefined : { enabled, enrolled: false, message: 'При сохранении рейса заявка отправится и подпишется автоматически.' };
      const view = workflowView(state, true);
      assert.equal(view.requiresReconciliation, true);
      assert.equal(view.step, 0);
      assert.match(view.text, /Факты погрузки есть в CRM/);
      assert.match(view.text, /сверка состояния документов/);
      assert.doesNotMatch(`${view.title} ${view.text}`, /сохраните|при сохранении|отправится|подпишется|ожидаем водителя/i);
      assert.deepEqual(state.blockers, ready ? [] : ['Не указан адрес нефтебазы']);
    }
  }
});

test('only saved facts with missing order and enrollment change the preparation view', () => {
  const state = failedWorkflow();
  state.phase = 'preparation'; state.order = null; state.locked = false;
  state.automation = { enabled: true, enrolled: false };
  assert.equal(workflowView(state, false).requiresReconciliation, undefined);
  state.automation.enrolled = true;
  for (const ready of [false, true]) {
    state.ready = ready;
    assert.deepEqual(workflowView(state, true), workflowView(state, false));
  }
  state.order = failedWorkflow('sender_action_required').order;
  state.automation.enrolled = false;
  assert.deepEqual(workflowView(state, true), workflowView(state, false));
});

test('saved loading facts do not replace established failure, driver or delivery phases', () => {
  const state = failedWorkflow();
  state.order = null;
  state.automation = { enabled: true, enrolled: false };
  for (const phase of ['unknown', 'error', 'awaiting_loading', 'creating_etrn', 'sending_etrn', 'completed'] as const) {
    state.phase = phase;
    assert.deepEqual(workflowView(state, true), workflowView(state, false));
  }
  state.phase = 'preparation';
  for (const driverState of ['mass_pending'] as const) {
    state.driverFlow = { state: driverState, processingAllowanceHours: 10 };
    assert.deepEqual(workflowView(state, true), workflowView(state, false));
  }
  state.stage6CompletedAt = '2026-10-08T09:00:00Z';
  assert.equal(workflowView(state, true).step, 7);
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
  assert.equal(workflowView(state).step, 4);
  assert.match(workflowView(state).title, /^НК АРТЭЛЬ/);
  assert.match(workflowView(state).text, /Продолжение приостановлено/);
  assert.doesNotMatch(workflowView(state).text, /подтверждение владельца|после запуска|дождитесь|начнётся/);
  state.phase = 'unknown';
  assert.equal(workflowView(state).step, 4);
});

test('automatic sender and carrier stages do not ask for another launch', () => {
  for (const stage of ['sender_action_required', 'carrier_action_required'] as const) {
    const state = failedWorkflow(stage);
    state.phase = 'awaiting_carrier'; state.automation = { enabled: true, enrolled: true };
    assert.match(workflowView(state).text, /автоматически/);
    assert.doesNotMatch(workflowView(state).text, /запустите|после запуска|выбранной подписью/i);
  }
});

test('driver preparation distinguishes actual Saby draft from waiting preparation and shows the driver stage', () => {
  const state = failedWorkflow('sender_action_required');
  state.phase = 'awaiting_driver'; state.driverFlow = { state: 'waiting_driver', processingAllowanceHours: 10 };
  assert.equal(workflowView(state).step, 1);
  assert.match(workflowView(state).title, /Черновик заявки/);
  state.order = null;
  assert.doesNotMatch(workflowView(state).title, /Черновик/);
  assert.match(workflowView(state).text, /ещё не подтверждено/);
  state.phase = 'preparation'; state.driverFlow.state = 'mass_pending';
  assert.equal(workflowView(state).step, 0);
  assert.match(workflowView(state).text, /после подтверждённого сохранения/);
  state.phase = 'error';
  assert.equal(workflowView(state).step, 0);
  assert.match(workflowView(state).title, /Подготовка/);
});

test('new ETRN drafts remain at sending stage until terminal evidence is confirmed', () => {
  const state = failedWorkflow('carrier_confirmed', true);
  state.driverFlow = { state: 'ready', processingAllowanceHours: 10 };
  state.driverConfirmation = { arrivedAt: '2026-10-08T05:10:00Z', confirmedAt: '2026-10-08T05:14:58Z' };
  for (const phase of ['completed', 'sending_etrn'] as const) {
    state.phase = phase;
    assert.equal(workflowView(state).step, 6);
    assert.match(workflowView(state).text, /остаётся активным/);
    assert.doesNotMatch(workflowView(state).text, /откройте|подпишите/);
  }
  state.stage6CompletedAt = '2026-10-08T09:00:00Z';
  for (const phase of ['completed', 'unknown', 'error'] as const) {
    state.phase = phase;
    assert.equal(workflowView(state).step, 7);
    assert.match(workflowView(state).title, /Все этапы/);
    assert.match(workflowView(state).text, /архиве/);
  }
});

test('accepted driver confirmation is visible before the background workflow consumes its facts', () => {
  const state = failedWorkflow('sender_action_required');
  state.phase = 'awaiting_driver';
  state.driverFlow = { state: 'waiting_driver', processingAllowanceHours: 10 };
  state.driverConfirmation = { arrivedAt: '2026-10-08T05:10:00Z', confirmedAt: '2026-10-08T05:14:58Z' };
  const view = workflowView(state);
  assert.equal(view.step, 2);
  assert.equal(view.title, 'Данные водителя получены · ожидают обработки');
  assert.doesNotMatch(`${view.title} ${view.text}`, /ожидаем водителя|подписан|внесены в Saby/i);
  assert.match(view.text, /проверит их запись в Saby/);
  assert.equal(workflowSteps(state, view.step)[1].state, 'done');
  assert.equal(workflowSteps(state, view.step)[2].state, 'current');
  assert.equal(workflowTime(driverConfirmedAt(state)), '08.10, 08:14');
});

test('arrival alone keeps driver confirmation pending and explains the missing departure action', () => {
  const state = failedWorkflow('sender_action_required');
  state.phase = 'awaiting_driver';
  state.driverFlow = { state: 'waiting_driver', processingAllowanceHours: 10 };
  state.driverConfirmation = { arrivedAt: '2026-10-08T05:10:00Z', confirmedAt: null };
  const view = workflowView(state);
  assert.equal(view.step, 1);
  assert.match(view.text, /зафиксировал прибытие/);
  assert.match(view.text, /кнопкой «Убыл»/);
  assert.equal(driverConfirmedAt(state), null);
  assert.equal(workflowSteps(state, view.step)[1].state, 'current');
  assert.equal(workflowSteps(state, view.step)[2].state, 'pending');
});

test('mass persistence is distinct from the driver confirmation and sender signature', () => {
  const state = failedWorkflow('sender_action_required');
  state.phase = 'awaiting_driver';
  state.driverFlow = { state: 'mass_pending', processingAllowanceHours: 10 };
  state.driverConfirmation = { arrivedAt: '2026-10-08T05:10:00Z', confirmedAt: '2026-10-08T05:14:58Z' };
  assert.equal(workflowView(state).step, 2);
  assert.equal(workflowView(state).title, 'Массы получены · дополняем заявку');
  assert.match(workflowView(state).text, /Подписание начнётся после подтверждённого сохранения/);
  state.driverFlow.state = 'ready';
  state.phase = 'awaiting_carrier';
  state.signing = { state: 'active', mode: 'automatic', requestedAt: '2026-10-08T05:20:00Z', sender: { state: 'waiting' }, carrier: { state: 'not_started' } };
  assert.equal(workflowView(state).step, 2);
  assert.match(workflowView(state).title, /АРТЭЛЬ · ожидаем подпись/);
  assert.equal(workflowSteps(state, workflowView(state).step)[1].state, 'done');
  assert.equal(workflowSteps(state, workflowView(state).step)[2].state, 'current');
});

test('loading facts alone never prove the driver confirmed or require waiting for the driver again', () => {
  const state = failedWorkflow('sender_action_required');
  state.phase = 'awaiting_driver';
  state.driverFlow = { state: 'waiting_driver', processingAllowanceHours: 10 };
  const view = workflowView(state, true);
  assert.equal(view.step, 2);
  assert.equal(view.title, 'Факты погрузки сохранены · ожидают обработки');
  assert.equal(driverConfirmedAt(state), null);
  assert.equal(workflowSteps(state, view.step)[1].state, 'unconfirmed');
});

test('legacy and invalid confirmation records do not acquire a completed driver stage', () => {
  const state = failedWorkflow('carrier_confirmed', true);
  state.phase = 'sending_etrn';
  for (const driverConfirmation of [undefined, null, { arrivedAt: null, confirmedAt: null }, { arrivedAt: null, confirmedAt: 'invalid' }]) {
    state.driverConfirmation = driverConfirmation;
    for (const step of [2, 4, 6, 7]) {
      const steps = workflowSteps(state, step);
      assert.equal(steps.length, 7);
      assert.equal(steps[1].state, 'unconfirmed');
      assert.equal(steps[1].note, 'Не зафиксировано');
    }
  }
  state.stage6CompletedAt = '2026-10-08T06:00:00Z';
  assert.equal(workflowView(state).title, 'Обмен с Saby завершён');
  assert.match(workflowView(state).text, /Подтверждение водителя в CRM не зафиксировано/);
});

test('driver confirmation survives failure and missing Saby linkage without claiming remote success', () => {
  const state = failedWorkflow();
  state.driverFlow = { state: 'mass_pending', processingAllowanceHours: 10 };
  state.driverConfirmation = { arrivedAt: '2026-10-08T05:10:00Z', confirmedAt: '2026-10-08T05:14:58Z' };
  for (const phase of ['error', 'unknown'] as const) {
    state.phase = phase;
    assert.equal(workflowView(state).step, 2);
    assert.equal(workflowSteps(state, workflowView(state).step)[1].state, 'done');
  }
  state.order = null;
  state.phase = 'awaiting_driver';
  state.driverFlow.state = 'waiting_driver';
  assert.equal(workflowView(state).step, 0);
  assert.match(workflowView(state).text, /ещё не подтверждены/);
  assert.equal(workflowSteps(state, 0)[0].state, 'current');
  assert.equal(workflowSteps(state, 0)[1].state, 'done');
});

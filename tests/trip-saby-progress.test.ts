import assert from 'node:assert/strict';
import test from 'node:test';
import { appendSabyHistory, sabyOrderProgress, TRIP_SABY_HISTORY_LIMIT } from '../server/trip-saby-progress';
import type { TripSabyHistoryEntry } from '../web/src/trip-saby-model';
import type { SabyObject } from '../server/saby-client';

test('stages use structured code and current carrier title, never a label or sender signature', () => {
  const remote: SabyObject = { Состояние: { Код: '4', Название: 'Утверждено' }, Редакция: [{ Идентификатор: 'current', Актуален: 'Да' }] };
  const title = { Идентификатор: 'carrier', Подтип: '1110362', ВерсияФормата: '5.01' };
  const signature = [{ Сертификат: { Отпечаток: 'synthetic' } }];
  assert.equal(sabyOrderProgress(remote).exchangeStage, 'carrier_details_required');
  assert.equal(sabyOrderProgress({ ...remote, Вложение: [title] }).exchangeStage, 'carrier_action_required');
  assert.equal(sabyOrderProgress({ ...remote, Вложение: [{ ...title, Подпись: signature }] }).exchangeStage, 'carrier_confirmation_pending');
  for (const change of [{ Подтип: '1110361' }, { Редакция: 'obsolete' }, { Удален: 'Да' }]) assert.equal(sabyOrderProgress({ ...remote, Вложение: [{ ...title, Подпись: signature, ...change }] }).exchangeStage, 'carrier_details_required');
  assert.equal(sabyOrderProgress({ ...remote, Состояние: { Название: 'Утверждено' } }).exchangeStage, 'unknown');
  assert.equal(sabyOrderProgress({ ...remote, Код: { Состояние: '7' } }, true).exchangeStage, 'unknown');
  assert.equal(sabyOrderProgress({ ...remote, Состояние: { Код: '7' } }).exchangeStage, 'carrier_confirmation_pending');
  assert.equal(sabyOrderProgress({ ...remote, Состояние: { Код: 7 } }, true).exchangeStage, 'carrier_confirmed');
  assert.equal(sabyOrderProgress({ ...remote, ЧастичныеДанные: 'Да' }).exchangeStage, 'unknown');
});

test('history keeps only changed stages, bounds retention and preserves transition time', () => {
  let history: TripSabyHistoryEntry[] = [];
  for (let index = 0; index < 70; index++) history = appendSabyHistory(history, { at: new Date(index * 1_000).toISOString(), stage: index % 2 ? 'sending_to_carrier' : 'sender_action_required', remoteStateCode: index % 2 ? '3' : '0' });
  assert.equal(history.length, TRIP_SABY_HISTORY_LIMIT);
  const same = appendSabyHistory(history, { ...history.at(-1)!, at: new Date().toISOString() });
  assert.equal(same, history); assert.equal(history[0].at, new Date(20_000).toISOString());
});

import type { TripSabyExchangeStage, TripSabyHistoryEntry } from '../web/src/trip-saby-model';
import { sabyDocumentWorkflow, sabyObject, sabyText, type SabyObject } from './saby-client';

export const TRIP_SABY_HISTORY_LIMIT = 50;
export const tripSabyStages: readonly TripSabyExchangeStage[] = ['sender_action_required', 'signature_pending', 'sending_to_carrier', 'carrier_details_required', 'carrier_action_required', 'carrier_confirmation_pending', 'carrier_confirmed', 'rejected', 'operator_error', 'cancelled', 'unknown'];
const rows = (value: unknown): SabyObject[] => Array.isArray(value) ? value.filter(sabyObject) : sabyObject(value) ? [value] : [];
const code = (value: unknown): string | null => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? String(value) : typeof value === 'string' && /^\d{1,3}$/.test(value) ? value : null;

/** A label is never evidence of sending; disagreeing structured codes stay unknown. */
export function sabyOrderStateCode(remote: SabyObject): string | null {
  const state = sabyObject(remote.Состояние) ? code(remote.Состояние.Код) : null;
  const legacy = sabyObject(remote.Код) ? code(remote.Код.Состояние) : null;
  return state && legacy && state !== legacy ? null : state ?? legacy;
}

/** This describes only evidence visible in the sender's account, not a second account's unsent edits. */
export function sabyOrderProgress(remote: SabyObject, carrierConfirmed = false): { remoteStateCode: string | null; exchangeStage: TripSabyExchangeStage } {
  const remoteStateCode = sabyOrderStateCode(remote);
  const terminal: Partial<Record<string, TripSabyExchangeStage>> = { '6': 'operator_error', '9': 'rejected', '22': 'cancelled' };
  if (remoteStateCode && terminal[remoteStateCode]) return { remoteStateCode, exchangeStage: terminal[remoteStateCode]! };
  if (carrierConfirmed && remoteStateCode === '7') return { remoteStateCode, exchangeStage: 'carrier_confirmed' };
  if (remoteStateCode === '0') return { remoteStateCode, exchangeStage: 'sender_action_required' };
  if (remoteStateCode === '23') return { remoteStateCode, exchangeStage: 'signature_pending' };
  if (remoteStateCode === '3') return { remoteStateCode, exchangeStage: 'sending_to_carrier' };
  if (remoteStateCode === '7') return { remoteStateCode, exchangeStage: 'carrier_confirmation_pending' };
  if (remoteStateCode !== '4') return { remoteStateCode, exchangeStage: 'unknown' };
  const revision = sabyDocumentWorkflow(remote).revision;
  const titles = rows(remote.Вложение).filter(row => {
    const titleRevision = sabyObject(row.Редакция) ? sabyText(row.Редакция.Идентификатор) : sabyText(row.Редакция);
    return row.Подтип === '1110362' && row.ВерсияФормата === '5.01' && row.Удален !== 'Да' && row.Актуален !== 'Нет' && (!titleRevision || titleRevision === revision);
  });
  if (titles.length > 1 || remote.ЧастичныеДанные === 'Да') return { remoteStateCode, exchangeStage: 'unknown' };
  if (!titles.length) return { remoteStateCode, exchangeStage: 'carrier_details_required' };
  const signed = rows(titles[0].Подпись).some(signature => !signature.Ошибка && Number(signature.КоличествоОшибок ?? 0) === 0 && !(Array.isArray(signature.Ошибки) && signature.Ошибки.length) && ((sabyObject(signature.Файл) && (sabyText(signature.Файл.Ссылка) || sabyText(signature.Файл.ДвоичныеДанные))) || (sabyObject(signature.Сертификат) && sabyText(signature.Сертификат.Отпечаток))));
  return { remoteStateCode, exchangeStage: signed ? 'carrier_confirmation_pending' : 'carrier_action_required' };
}

export function appendSabyHistory(history: TripSabyHistoryEntry[] | undefined, entry: TripSabyHistoryEntry): TripSabyHistoryEntry[] {
  if (history?.at(-1)?.stage === entry.stage) return history;
  return [...(history ?? []), entry].slice(-TRIP_SABY_HISTORY_LIMIT);
}

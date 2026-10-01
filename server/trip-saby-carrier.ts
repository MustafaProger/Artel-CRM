import type { Snapshot } from '../web/src/model';
import type { TripSabyCarrierFill } from '../web/src/trip-saby-model';
import type { TripSabyRecord } from './trip-saby-workflow';
import { carrierDetailsInput, carrierXmlHash, patchCarrierDetails } from './saby-carrier-details';
import { SabyClient, SabyError, sabyDocumentWorkflow, sabyObject, sabyText, type SabyObject } from './saby-client';
import { sabyOrderStateCode } from './trip-saby-progress';

export interface CarrierFillRecord extends TripSabyCarrierFill {
  requestedAt: string;
  /** Persisted BEFORE the request; an unverified intent is never resubmitted automatically. */
  intent?: { attachmentId: string; revision: string; beforeHash: string; afterHash: string; driverReady: boolean; vehicleReady: boolean; responsibleReady?: boolean; verified: boolean };
}
export const newCarrierFill = (): CarrierFillRecord => ({ requestedAt: new Date().toISOString(), state: 'waiting', blockers: [], driverSaved: false, vehicleSaved: false, checkedAt: null });
export const carrierFastPolling = (record: TripSabyRecord, now = Date.now()) => record.carrierFill?.state === 'waiting' && ['3', '4'].includes(record.order.remoteStateCode ?? '') && now - Date.parse(record.carrierFill.requestedAt) < 600_000;
export function validateCarrierFill(value: unknown): void {
  if (value === undefined) return;
  if (!sabyObject(value) || !['waiting', 'partial', 'saved', 'unknown', 'blocked'].includes(String(value.state)) || !Array.isArray(value.blockers) || value.blockers.some(x => typeof x !== 'string') || typeof value.driverSaved !== 'boolean' || typeof value.vehicleSaved !== 'boolean' || value.checkedAt !== null && (typeof value.checkedAt !== 'string' || !Number.isFinite(Date.parse(value.checkedAt)))) throw new Error('Invalid carrier fill');
  if (value.responsibleSaved !== undefined && typeof value.responsibleSaved !== 'boolean') throw new Error('Invalid responsible fill');
  if (typeof value.requestedAt !== 'string' || !Number.isFinite(Date.parse(value.requestedAt))) throw new Error('Invalid carrier fill request time');
  if (value.intent !== undefined) {
    const i = value.intent;
    if (sabyObject(i) && i.responsibleReady !== undefined && typeof i.responsibleReady !== 'boolean') throw new Error('Invalid responsible intent');
    if (!sabyObject(i) || !sabyText(i.attachmentId) || !sabyText(i.revision) || ![i.beforeHash, i.afterHash].every(x => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x)) || ![i.driverReady, i.vehicleReady, i.verified].every(x => typeof x === 'boolean')) throw new Error('Invalid carrier fill intent');
  }
}
const rows = (raw: unknown) => Array.isArray(raw) ? raw.filter(sabyObject) : sabyObject(raw) ? [raw] : [];
export function verifyCarrierOrder(remote: SabyObject, record: TripSabyRecord) {
  const org = (raw: unknown, expected: typeof record.snapshot.carrierOrganization) => sabyObject(raw) && sabyObject(raw.СвЮЛ) && raw.СвЮЛ.ИНН === expected.inn && raw.СвЮЛ.КПП === expected.kpp;
  if (remote.Идентификатор !== record.order.id || remote.Тип !== 'TransportOrder' || remote.Направление !== 'Входящий' || remote.Номер !== record.order.number || remote.Дата !== record.snapshot.fields.date?.split('-').reverse().join('.') || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да' || !org(remote.НашаОрганизация, record.snapshot.carrierOrganization) || !org(remote.Контрагент, record.snapshot.customerOrganization)) throw new SabyError('validation', 'В кабинете НК не подтверждены заявка и её участники. Заполнение остановлено.');
  const revision = sabyDocumentWorkflow(remote).revision;
  if (!revision) throw new SabyError('validation', 'Saby не вернул текущую редакцию входящей заявки.');
  const active = rows(remote.Вложение).filter(a => a.Удален !== 'Да' && a.Актуален !== 'Нет' && (!sabyObject(a.Редакция) || !a.Редакция.Идентификатор || a.Редакция.Идентификатор === revision));
  const carrier = active.filter(a => a.Подтип === '1110362' && a.ВерсияФормата === '5.01');
  const sender = active.filter(a => a.Подтип === '1110361' && a.ВерсияФормата === '5.01');
  if (carrier.length > 1 || sender.length !== 1) throw new SabyError('validation', 'Нельзя однозначно выбрать текущие титулы заявки в НК.');
  if (!carrier.length) return null;
  const response = carrier[0];
  if (rows(response.Подпись).length || response.Направление !== 'Исходящий' || !sabyText(response.Идентификатор) || !sabyText(sender[0].Идентификатор) || !sabyObject(response.Файл) || !sabyText(response.Файл.Имя)) throw new SabyError('validation', 'Ответ НК уже подписан или недоступен для безопасного заполнения.');
  return { revision, attachmentId: String(response.Идентификатор), senderId: String(sender[0].Идентификатор), name: String(response.Файл.Имя) };
}

/** Called under the trip workflow's durable lease. No prepare, approve, sign or send methods. */
export async function fillCarrierDetails(options: {
  client: SabyClient; record: TripSabyRecord; snapshot: () => Promise<Snapshot>;
  update: (fn: (row: TripSabyRecord) => void) => Promise<void>; checkAccess: () => Promise<void>;
}): Promise<void> {
  const { client, record, update, checkAccess } = options;
  if (!record.carrierFill || !record.order.id) return;
  const fill = structuredClone(record.carrierFill);
  const save = async () => { const saved = structuredClone(fill); await update(row => { row.carrierFill = saved; }); };
  let attempted = false;
  try {
    await checkAccess();
    const remote = await client.readCarrierOrder(record.order.id);
    const title = verifyCarrierOrder(remote, record);
    const state = sabyOrderStateCode(remote);
    if (state !== '10') {
      fill.state = 'blocked'; fill.blockers = ['Входящая заявка НК сейчас не находится на этапе обработки. Обновите состояние Saby.']; await save(); return;
    }
    if (!title) {
      fill.state = 'waiting'; fill.blockers = ['Saby ещё готовит черновик ответа НК. Проверка продолжится автоматически.']; await save(); return;
    }
    await checkAccess();
    const draft = await client.downloadCarrierOrderAttachment(record.order.id, title.attachmentId, title.revision);
    if (fill.intent && !fill.intent.verified) {
      if (fill.intent.attachmentId !== title.attachmentId || carrierXmlHash(draft.bytes) !== fill.intent.afterHash) {
        fill.state = 'unknown'; fill.blockers = ['Предыдущая запись ещё не подтверждена. CRM сверяет сохранённый ответ НК и не повторяет запись.']; await save(); return;
      }
      fill.intent.verified = true; fill.driverSaved = fill.intent.driverReady; fill.vehicleSaved = fill.intent.vehicleReady;
      if (fill.intent.responsibleReady !== undefined) fill.responsibleSaved = fill.intent.responsibleReady;
      fill.checkedAt = new Date().toISOString(); await save();
    }
    const input = carrierDetailsInput(await options.snapshot(), record, client.config.carrierResponsible);
    await checkAccess();
    const sender = await client.downloadCarrierOrderAttachment(record.order.id, title.senderId, title.revision);
    const previous = fill.intent;
    const lastVerifiedHash = previous?.verified && previous.attachmentId === title.attachmentId && previous.revision === title.revision ? previous.afterHash : undefined;
    const patch = patchCarrierDetails(draft.bytes, sender.bytes, input, lastVerifiedHash);
    fill.blockers = input.blockers;
    if (patch.beforeHash !== patch.afterHash) {
      // Last read catches concurrent edits and signing before persisting intent.
      await checkAccess();
      const latest = verifyCarrierOrder(await client.readCarrierOrder(record.order.id), record);
      if (!latest || latest.revision !== title.revision || latest.attachmentId !== title.attachmentId) throw new SabyError('validation', 'Черновик НК изменился во время заполнения. Обновите состояние.');
      const before = await client.downloadCarrierOrderAttachment(record.order.id, title.attachmentId, title.revision);
      if (carrierXmlHash(before.bytes) !== patch.beforeHash) throw new SabyError('validation', 'Данные черновика НК изменились. Автоматическая запись остановлена.');
      fill.intent = { attachmentId: title.attachmentId, revision: title.revision, beforeHash: patch.beforeHash, afterHash: patch.afterHash, driverReady: patch.driverReady, vehicleReady: patch.vehicleReady, ...(patch.responsibleReady !== undefined ? { responsibleReady: patch.responsibleReady } : {}), verified: false };
      fill.state = 'unknown'; await save();
      await checkAccess(); attempted = true;
      await client.writeCarrierAttachment(record.order.id, title.revision, title.attachmentId, title.name, patch.xml);
      await checkAccess();
      const readBack = verifyCarrierOrder(await client.readCarrierOrder(record.order.id), record);
      if (!readBack || readBack.attachmentId !== title.attachmentId) throw new SabyError('unknown', 'Не подтверждено сохранённое вложение ответа НК.', true);
      const result = await client.downloadCarrierOrderAttachment(record.order.id, readBack.attachmentId, readBack.revision);
      if (carrierXmlHash(result.bytes) !== patch.afterHash) throw new SabyError('unknown', 'Saby пока не подтвердил записанные сведения. Повторная запись не выполняется.', true);
      fill.intent.verified = true;
    }
    fill.driverSaved = patch.driverReady; fill.vehicleSaved = patch.vehicleReady;
    if (patch.responsibleReady !== undefined) fill.responsibleSaved = patch.responsibleReady;
    fill.state = input.blockers.length ? 'partial' : 'saved'; fill.checkedAt = new Date().toISOString(); await save();
  } catch (error) {
    fill.state = attempted || fill.intent && !fill.intent.verified ? 'unknown' : 'blocked';
    // Provider error payloads may contain private XML. Only controlled messages reach UI.
    fill.blockers = [error instanceof SabyError && error.kind === 'validation' ? error.message : 'Не удалось подтвердить заполнение ответа НК. Обновите состояние; повторная запись без сверки не выполняется.'];
    await save();
    await checkAccess();
  }
}

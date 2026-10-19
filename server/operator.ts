import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { AccountUser } from '../web/src/auth-model';
import type { OperatorData, OperatorRecipientFields, OperatorRefuellingFields } from '../web/src/operator-model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { requireSection } from './permissions';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const recipientKeys = ['name', 'bank', 'card', 'phone', 'details'];
const fuelKeys = ['date', 'name', 'service', 'discountPercent', 'litres', 'pricePerLitre', 'amount', 'comment'];
const empty = (): OperatorData => ({ recipients: {}, refuellings: {}, requests: {} });
function text(body: Record<string, unknown>, key: string, required = false, max = 500) {
  const value = body[key];
  if (typeof value !== 'string' || value.length > max || [...value].some(c => c.charCodeAt(0) < 32 && !['\n','\r','\t'].includes(c)) || required && !value.trim()) throw new ApiError(400, `Проверьте поле «${({name:'Имя / наименование',bank:'Банк',card:'Номер карты',phone:'Телефон',details:'Другие реквизиты',service:'Сервис',comment:'Комментарий'} as Record<string,string>)[key] ?? key}».`);
  return value.trim();
}
function decimal(body: Record<string, unknown>, key: string, label: string, scale: number, zero = false, max = '1000000000000') {
  const raw = body[key];
  const value = typeof raw === 'string' ? raw.trim().replace(',', '.') : '';
  if (value.length > 40 || !new RegExp(`^\\d+(?:\\.\\d{1,${scale}})?$`).test(value)) throw new ApiError(400, `Проверьте поле «${label}»: число, до ${scale} знаков после запятой.`);
  const number = new Decimal(value);
  if (number.lt(0) || !zero && number.eq(0) || number.gt(max)) throw new ApiError(400, `Недопустимое значение поля «${label}».`);
  return number.toFixed();
}
function recipientFields(body: Record<string, unknown>): OperatorRecipientFields {
  const fields = { name: text(body, 'name', true), bank: text(body, 'bank', true), card: text(body, 'card'), phone: text(body, 'phone'), details: text(body, 'details', false, 2000) };
  if (!fields.card && !fields.phone && !fields.details) throw new ApiError(400, 'Укажите номер карты, телефон или другие реквизиты.');
  return fields;
}
function fuelFields(body: Record<string, unknown>): OperatorRefuellingFields {
  const date = body.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new ApiError(400, 'Укажите существующую дату заправки.');
  return { date, name: text(body, 'name', true), service: text(body, 'service', true), discountPercent: decimal(body, 'discountPercent', 'Скидка, %', 6, true, '100'), litres: decimal(body, 'litres', 'Литры', 6), pricePerLitre: decimal(body, 'pricePerLitre', 'Цена за литр', 6), amount: decimal(body, 'amount', 'Сумма', 2), comment: text(body, 'comment', false, 4000) };
}
function keys(body: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(body).some(k => !allowed.includes(k))) throw new ApiError(400, 'Есть неизвестные параметры.');
}
function metadata(row: Record<string, unknown>, id: string) {
  if (row.id !== id || !uuid.test(id) || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || !['createdAt','updatedAt'].every(k => typeof row[k] === 'string' && Number.isFinite(Date.parse(row[k] as string)))) throw new Error('Invalid operator metadata');
}
/** Optional extension: reading old stores never creates or migrates business records. */
export function validateOperator(value: unknown) {
  if (value === undefined) return;
  if (!object(value) || !object(value.recipients) || !object(value.refuellings) || !object(value.requests)) throw new Error('Invalid operator storage');
  for (const [id,row] of Object.entries(value.recipients)) {
    if (!object(row) || typeof row.archived !== 'boolean') throw new Error('Invalid recipient');
    metadata(row,id); recipientFields(row);
  }
  for (const [id,row] of Object.entries(value.refuellings)) {
    if (!object(row) || typeof row.recipientId !== 'string' || !Object.hasOwn(value.recipients,row.recipientId) || !object(row.recipient) || typeof row.paid !== 'boolean' || typeof row.createdBy !== 'string' || !Array.isArray(row.paymentHistory)) throw new Error('Invalid refuelling');
    metadata(row,id); fuelFields(row); recipientFields(row.recipient);
    let paid = false;
    for (const event of row.paymentHistory) {
      if (!object(event) || typeof event.paid !== 'boolean' || event.paid === paid || typeof event.actorId !== 'string' || !event.actorId || typeof event.actorName !== 'string' || !event.actorName || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid payment history');
      paid = event.paid;
    }
    if (row.paid !== paid) throw new Error('Invalid payment status');
  }
  for (const [key,record] of Object.entries(value.requests)) {
    if (!uuid.test(key) || !object(record) || typeof record.actorId !== 'string' || !record.actorId || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint) || !['recipients','refuellings'].includes(String(record.collection)) || typeof record.id !== 'string' || !Object.hasOwn(value[record.collection as string] as object,record.id)) throw new Error('Invalid operator request');
  }
}
export function readOperator(data: OperationsData, actor: AccountUser) {
  requireSection(actor, 'operator');
  const state = data.operator ?? empty();
  return { recipients: Object.values(state.recipients).sort((a,b) => a.name.localeCompare(b.name,'ru')), refuellings: Object.values(state.refuellings).sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)) };
}
export function mutateOperator(data: OperationsData, actor: AccountUser, collection: 'recipients' | 'refuellings', body: Record<string,unknown>, id?: string, action?: 'payment' | 'archive') {
  requireSection(actor,'operator');
  const state = data.operator ?? empty();
  if (id && !Object.hasOwn(state[collection],id)) throw new ApiError(404,'Запись не найдена.');
  const key = body.idempotencyKey;
  if (typeof key !== 'string' || !uuid.test(key)) throw new ApiError(400,'Некорректный ключ сохранения.');
  const fingerprint = createHash('sha256').update(JSON.stringify([collection,id ?? null,action ?? null,Object.keys(body).sort().map(k => [k,body[k]])])).digest('hex');
  const replay = state.requests[key];
  if (replay) {
    if (replay.fingerprint !== fingerprint || replay.actorId !== actor.id) throw new ApiError(409,'Этот ключ уже использован для другого действия.');
    return { changed: false, result: { id: replay.id, replayed: true } };
  }
  const previous = id ? state[collection][id] : undefined;
  if (previous && previous.version !== body.version) throw new ApiError(409,'Запись изменена другим сотрудником. Закройте форму, обновите список и повторите действие.');
  const now = new Date().toISOString();
  const recordId = id ?? randomUUID();
  if (action === 'payment' && collection === 'refuellings' && id) {
    keys(body,['idempotencyKey','version','paid']);
    const row = state.refuellings[id];
    if (typeof body.paid !== 'boolean' || body.paid === row.paid) throw new ApiError(409,'Статус оплаты уже изменён. Обновите список.');
    row.paid = body.paid; row.paymentHistory.push({paid:body.paid,at:now,actorId:actor.id,actorName:actor.name});
    row.version++; row.updatedAt = now;
  } else if (action === 'archive' && collection === 'recipients' && id) {
    keys(body,['idempotencyKey','version','archived']);
    if (typeof body.archived !== 'boolean') throw new ApiError(400,'Некорректный статус реквизитов.');
    Object.assign(state.recipients[id],{archived:body.archived,version:previous!.version+1,updatedAt:now});
  } else if (!action && collection === 'recipients') {
    keys(body,[...recipientKeys,'idempotencyKey',...(id?['version']:[])]);
    const fields = recipientFields(body);
    state.recipients[recordId] = {...fields,id:recordId,version:(previous?.version ?? 0)+1,archived:state.recipients[recordId]?.archived ?? false,createdAt:previous?.createdAt ?? now,updatedAt:now};
  } else if (!action && collection === 'refuellings') {
    keys(body,[...fuelKeys,'recipientId','recipientVersion','idempotencyKey',...(id?['version']:[])]);
    const prior = id ? state.refuellings[id] : undefined;
    if (prior?.paid) throw new ApiError(409,'Для исправления оплаченной записи сначала снимите подтверждение оплаты. История сохранится.');
    const fields = fuelFields(body);
    const recipient = typeof body.recipientId === 'string' && Object.hasOwn(state.recipients,body.recipientId) ? state.recipients[body.recipientId] : undefined;
    if (!recipient || recipient.archived) throw new ApiError(400,'Выберите действующие реквизиты получателя.');
    if (body.recipientVersion !== recipient.version) throw new ApiError(409,'Реквизиты изменились. Обновите список и проверьте получателя.');
    state.refuellings[recordId] = {...fields,id:recordId,version:(prior?.version ?? 0)+1,recipientId:recipient.id,recipient:recipientFields({...recipient}),paid:false,paymentHistory:prior?.paymentHistory ?? [],createdBy:prior?.createdBy ?? actor.id,createdAt:prior?.createdAt ?? now,updatedAt:now};
  } else throw new ApiError(404,'Действие не найдено.');
  state.requests[key] = {fingerprint,actorId:actor.id,collection,id:recordId};
  data.operator = state;
  return {changed:true,result:{id:recordId,replayed:false}};
}

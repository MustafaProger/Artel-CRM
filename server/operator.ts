import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { AccountUser } from '../web/src/auth-model';
import type { OperatorCatalogSource, OperatorData, OperatorRecipientFields, OperatorRefuelling, OperatorRefuellingFields, OperatorRefuellingV2Fields, OperatorWorkspace } from '../web/src/operator-model';
import { calculateOperatorAmount } from '../web/src/operator-calculation';
import { readOperatorCatalog } from '../web/src/operator-catalog';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { requireSection } from './permissions';
import { operatorPlanFields, operatorPlanSummary, selectedOperatorAllocations, validateOperatorOperationDeletion, validateOperatorPlanEdit, validateOperatorPlans } from './operator-plans';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const recipientKeys = ['name', 'bank', 'card', 'phone', 'details'];
const fuelKeys = ['date', 'name', 'service', 'discountPercent', 'litres', 'pricePerLitre', 'amount', 'comment'];
const fuelV2Keys = ['schemaVersion', 'date', 'name', 'groupId', 'serviceId', 'serviceVersion', 'discountPercent', 'litres', 'pricePerLitre', 'amount', 'amountMode', 'recipientText', 'comment'];
const fuelV3Keys = [...fuelV2Keys.filter(key => key !== 'recipientText'), 'planId', 'planVersion', 'allocations'];
const empty = (): OperatorData => ({ recipients: {}, refuellings: {}, requests: {} });
function text(body: Record<string, unknown>, key: string, required = false, max = 500) {
  const value = body[key];
  if (typeof value !== 'string' || value.length > max || [...value].some(c => c.charCodeAt(0) < 32 && !['\n','\r','\t'].includes(c)) || required && !value.trim()) throw new ApiError(400, `Проверьте поле «${({name:'Имя / наименование',bank:'Банк',card:'Номер карты',phone:'Телефон',details:'Другие реквизиты',service:'Сервис',comment:'Комментарий',recipientText:'Имя и реквизиты',groupId:'Группа',groupName:'Группа',serviceId:'Сервис'} as Record<string,string>)[key] ?? key}».`);
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
const precisionFields = { litres: 'Литры', pricePerLitre: 'Цена за литр' } as const;
type LegacyPrecision = NonNullable<OperatorRefuellingV2Fields['legacyPrecision']>;
function validatedPrecision(body: Record<string, unknown>): LegacyPrecision | undefined {
  if (body.legacyPrecision === undefined) return;
  const value = body.legacyPrecision;
  if (!object(value) || !Object.keys(value).length || Object.keys(value).some(key => !Object.hasOwn(precisionFields, key))) throw new ApiError(400, 'Некорректная точность исторической записи.');
  const result: LegacyPrecision = {};
  for (const key of Object.keys(precisionFields) as (keyof LegacyPrecision)[]) {
    if (!Object.hasOwn(value, key)) continue;
    const preserved = decimal(value, key, precisionFields[key], 6);
    if (new Decimal(preserved).decimalPlaces() <= 2 || !new Decimal(preserved).eq(decimal(body, key, precisionFields[key], 6))) throw new ApiError(400, 'Историческое значение изменено. Укажите не более двух знаков после запятой.');
    result[key] = preserved;
  }
  return result;
}
function preservedPrecision(body: Record<string, unknown>, prior: OperatorRefuelling | undefined): LegacyPrecision | undefined {
  if (!prior) return;
  const source = prior.schemaVersion !== undefined ? prior.legacyPrecision : prior;
  const result: LegacyPrecision = {};
  for (const key of Object.keys(precisionFields) as (keyof LegacyPrecision)[]) {
    const historic = source?.[key];
    if (historic === undefined || new Decimal(historic).decimalPlaces() <= 2) continue;
    const entered = decimal(body, key, precisionFields[key], 6);
    if (new Decimal(historic).eq(entered)) result[key] = historic;
  }
  return Object.keys(result).length ? result : undefined;
}
function fuelV2Fields(body: Record<string, unknown>, recipientMax = 4000): OperatorRefuellingV2Fields {
  if (body.schemaVersion !== 2 || !['auto', 'manual'].includes(String(body.amountMode))) throw new ApiError(400, 'Некорректный способ расчёта суммы.');
  if (!Number.isSafeInteger(body.serviceVersion) || Number(body.serviceVersion) < 0) throw new ApiError(400, 'Некорректная версия сервиса.');
  const date = body.date;
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0,10) !== date) throw new ApiError(400, 'Укажите существующую дату заправки.');
  const amountMode = body.amountMode as 'auto' | 'manual';
  const legacyPrecision = validatedPrecision(body);
  const fields: OperatorRefuellingV2Fields = {
    schemaVersion: 2, date, name: text(body, 'name', true),
    groupId: text(body, 'groupId', true), groupName: text(body, 'groupName', true),
    serviceId: text(body, 'serviceId', true), serviceVersion: Number(body.serviceVersion), service: text(body, 'service', true),
    discountPercent: decimal(body, 'discountPercent', 'Скидка, %', 6, true, '100'),
    litres: decimal(body, 'litres', 'Литры', legacyPrecision?.litres ? 6 : 2), pricePerLitre: decimal(body, 'pricePerLitre', 'Цена за литр', legacyPrecision?.pricePerLitre ? 6 : 2),
    amount: new Decimal(decimal(body, 'amount', 'Сумма', 2, amountMode === 'auto')).toFixed(2), amountMode,
    recipientText: text(body, 'recipientText', true, recipientMax), comment: text(body, 'comment', false, 4000),
    ...(legacyPrecision ? { legacyPrecision } : {}),
  };
  if (amountMode === 'auto' && fields.amount !== calculateOperatorAmount(fields.litres, fields.pricePerLitre, fields.discountPercent, !!legacyPrecision)) throw new ApiError(400, 'Сумма не соответствует расчёту. Проверьте литры, цену и скидку.');
  return fields;
}
function selectedV2Fields(body: Record<string, unknown>, prior: OperatorRefuelling | undefined, directories: OperatorCatalogSource): OperatorRefuellingV2Fields {
  const catalog = readOperatorCatalog(directories);
  const groupId = text(body, 'groupId', true), serviceId = text(body, 'serviceId', true);
  const previous = prior?.schemaVersion !== undefined ? prior : undefined;
  const group = catalog.groups.find(row => row.id === groupId);
  const groupName = previous?.groupId === groupId ? previous.groupName : group?.name;
  if (!groupName) throw new ApiError(400, 'Выберите группу из справочника.');
  const selected = catalog.services.find(row => row.id === serviceId);
  const unchanged = previous?.serviceId === serviceId ? previous : undefined;
  if (!unchanged && !selected) throw new ApiError(400, 'Выберите сервис из справочника.');
  const serviceVersion = unchanged ? unchanged.serviceVersion : selected!.version ?? 0;
  // A legacy row has no service ID. Only an exact name match preserves its terms
  // during the explicit conversion; choosing a different service uses its rate.
  const legacyTerms = prior && prior.schemaVersion === undefined && prior.service === selected?.name ? prior : undefined;
  const snapshotDiscount = unchanged?.discountPercent ?? legacyTerms?.discountPercent ?? selected!.discountPercent;
  const serviceName = unchanged?.service ?? legacyTerms?.service ?? selected!.name;
  const discountPercent = decimal(body, 'discountPercent', 'Скидка, %', 6, true, '100');
  if (body.serviceVersion !== serviceVersion || !new Decimal(discountPercent).eq(snapshotDiscount)) throw new ApiError(409, 'Скидка или данные сервиса изменились. Обновите список и проверьте расчёт перед сохранением.');
  return fuelV2Fields({ ...body, groupName, service: serviceName, serviceVersion, discountPercent: snapshotDiscount, legacyPrecision: preservedPrecision(body, prior) });
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
    if (!object(row) || typeof row.paid !== 'boolean' || typeof row.createdBy !== 'string' || !Array.isArray(row.paymentHistory)) throw new Error('Invalid refuelling');
    if (['deletedAt', 'deletedBy', 'deletedByName'].some(key => Object.hasOwn(row, key)) && (typeof row.deletedAt !== 'string' || !Number.isFinite(Date.parse(row.deletedAt)) || typeof row.deletedBy !== 'string' || !row.deletedBy || text(row, 'deletedByName', true) !== row.deletedByName || row.paid)) throw new Error('Invalid deleted refuelling');
    metadata(row,id);
    if (row.schemaVersion === 2 || row.schemaVersion === 3) {
      if (Object.hasOwn(row, 'recipientId') || Object.hasOwn(row, 'recipient')) throw new Error('Invalid version 2 recipient');
      if (row.schemaVersion === 2 && ['planId', 'planClientName', 'allocations'].some(key => Object.hasOwn(row, key))) throw new Error('Invalid version 2 plan');
      fuelV2Fields({ ...row, schemaVersion: 2 }, row.schemaVersion === 3 ? 262144 : 4000);
    } else {
      if (row.schemaVersion !== undefined || typeof row.recipientId !== 'string' || !Object.hasOwn(value.recipients,row.recipientId) || !object(row.recipient)) throw new Error('Invalid legacy refuelling');
      fuelFields(row); recipientFields(row.recipient);
    }
    let paid = false;
    for (const event of row.paymentHistory) {
      if (!object(event) || typeof event.paid !== 'boolean' || event.paid === paid || typeof event.actorId !== 'string' || !event.actorId || typeof event.actorName !== 'string' || !event.actorName || typeof event.at !== 'string' || !Number.isFinite(Date.parse(event.at))) throw new Error('Invalid payment history');
      paid = event.paid;
    }
    if (row.paid !== paid) throw new Error('Invalid payment status');
  }
  validateOperatorPlans(value as unknown as OperatorData);
  for (const [key,record] of Object.entries(value.requests)) {
    if (!uuid.test(key) || !object(record) || typeof record.actorId !== 'string' || !record.actorId || typeof record.fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(record.fingerprint) || !['recipients','refuellings','plans'].includes(String(record.collection)) || typeof record.id !== 'string' || !object(value[record.collection as string]) || !Object.hasOwn(value[record.collection as string] as object,record.id)) throw new Error('Invalid operator request');
  }
}
export function readOperator(data: OperationsData, actor: AccountUser, directories: OperatorCatalogSource = {}): OperatorWorkspace {
  requireSection(actor, 'operator');
  const state = data.operator ?? empty();
  const plans = Object.values(state.plans ?? {}).map(plan => {
    const createdByName = plan.createdByName ?? data.accounts?.users.find(user => user.id === plan.createdBy)?.name;
    return { ...operatorPlanSummary(state, plan), ...(createdByName === undefined ? {} : { createdByName }) };
  }).sort((a,b) => b.createdAt.localeCompare(a.createdAt));
  return { ...readOperatorCatalog(directories), plans, recipients: Object.values(state.recipients).sort((a,b) => a.name.localeCompare(b.name,'ru')), refuellings: Object.values(state.refuellings).filter(row => !row.deletedAt).sort((a,b) => b.date.localeCompare(a.date) || b.createdAt.localeCompare(a.createdAt)) };
}
export function mutateOperator(data: OperationsData, actor: AccountUser, collection: 'recipients' | 'refuellings' | 'plans', body: Record<string,unknown>, id?: string, action?: 'payment' | 'archive' | 'delete', directories: OperatorCatalogSource = {}) {
  requireSection(actor,'operator');
  const state = data.operator ?? empty();
  if (id && !Object.hasOwn(state[collection] ?? {},id)) throw new ApiError(404,'Запись не найдена.');
  const key = body.idempotencyKey;
  if (typeof key !== 'string' || !uuid.test(key)) throw new ApiError(400,'Некорректный ключ сохранения.');
  const fingerprint = createHash('sha256').update(JSON.stringify([collection,id ?? null,action ?? null,Object.keys(body).sort().map(k => [k,body[k]])])).digest('hex');
  const replay = state.requests[key];
  if (replay) {
    if (replay.fingerprint !== fingerprint || replay.actorId !== actor.id) throw new ApiError(409,'Этот ключ уже использован для другого действия.');
    return { changed: false, result: { id: replay.id, replayed: true, ...(collection === 'refuellings' && state.refuellings[replay.id]?.deletedAt ? { deleted: true } : {}) } };
  }
  const previous = id ? state[collection]?.[id] : undefined;
  if (collection === 'refuellings' && id && state.refuellings[id]?.deletedAt) throw new ApiError(409, 'Операция уже удалена. Обновите список.');
  if (previous && previous.version !== body.version) throw new ApiError(409,'Запись изменена другим сотрудником. Закройте форму, обновите список и повторите действие.');
  const now = new Date().toISOString();
  const recordId = id ?? randomUUID();
  if (action === 'delete' && collection === 'refuellings' && id) {
    keys(body, ['idempotencyKey', 'version']);
    const row = state.refuellings[id];
    if (row.paid) throw new ApiError(409, 'Для удаления оплаченной операции сначала снимите подтверждение оплаты. История сохранится.');
    validateOperatorOperationDeletion(state, row);
    row.deletedAt = now; row.deletedBy = actor.id; row.deletedByName = actor.name;
    row.version++; row.updatedAt = now;
    if (row.schemaVersion === 3) {
      state.plans![row.planId].version++;
      state.plans![row.planId].updatedAt = now;
    }
  } else if (action === 'payment' && collection === 'refuellings' && id) {
    keys(body,['idempotencyKey','version','paid']);
    const row = state.refuellings[id];
    if (typeof body.paid !== 'boolean' || body.paid === row.paid) throw new ApiError(409,'Статус оплаты уже изменён. Обновите список.');
    row.paid = body.paid; row.paymentHistory.push({paid:body.paid,at:now,actorId:actor.id,actorName:actor.name});
    row.version++; row.updatedAt = now;
  } else if (action === 'archive' && collection === 'recipients' && id) {
    keys(body,['idempotencyKey','version','archived']);
    if (typeof body.archived !== 'boolean') throw new ApiError(400,'Некорректный статус реквизитов.');
    Object.assign(state.recipients[id],{archived:body.archived,version:previous!.version+1,updatedAt:now});
  } else if (!action && collection === 'plans') {
    keys(body, ['clientName', 'managerId', 'recipients', 'idempotencyKey', ...(id ? ['version'] : [])]);
    const fields = operatorPlanFields(body);
    const prior = id ? state.plans?.[id] : undefined;
    if (prior) {
      if (body.managerId !== undefined && body.managerId !== prior.managerId) throw new ApiError(409, 'Исторического менеджера задания нельзя изменить. Создатель определяется учётной записью.');
      validateOperatorPlanEdit(state, prior, fields);
    }
    state.plans ??= {};
    state.plans[recordId] = {
      ...fields,
      ...(prior?.managerId === undefined ? {} : { managerId: prior.managerId }),
      id: recordId, version: (prior?.version ?? 0) + 1,
      createdBy: prior?.createdBy ?? actor.id,
      ...(prior ? prior.createdByName === undefined ? {} : { createdByName: prior.createdByName } : { createdByName: actor.name }),
      createdAt: prior?.createdAt ?? now, updatedAt: now,
    };
  } else if (!action && collection === 'recipients') {
    keys(body,[...recipientKeys,'idempotencyKey',...(id?['version']:[])]);
    const fields = recipientFields(body);
    state.recipients[recordId] = {...fields,id:recordId,version:(previous?.version ?? 0)+1,archived:state.recipients[recordId]?.archived ?? false,createdAt:previous?.createdAt ?? now,updatedAt:now};
  } else if (!action && collection === 'refuellings') {
    const prior = id ? state.refuellings[id] : undefined;
    if (prior?.paid) throw new ApiError(409,'Для исправления оплаченной записи сначала снимите подтверждение оплаты. История сохранится.');
    const common = { id:recordId, version:(prior?.version ?? 0)+1, paid:false, paymentHistory:prior?.paymentHistory ?? [], createdBy:prior?.createdBy ?? actor.id, createdAt:prior?.createdAt ?? now, updatedAt:now };
    if (prior?.schemaVersion === 3 && body.schemaVersion !== 3) throw new ApiError(400, 'Операцию нельзя отсоединить от задания.');
    if (body.schemaVersion === 3) {
      keys(body, [...fuelV3Keys, 'idempotencyKey', ...(id ? ['version'] : [])]);
      const fields = selectedV2Fields({ ...body, schemaVersion: 2, recipientText: 'Распределение по заданию' }, prior, directories);
      if (new Decimal(fields.amount).lte(0)) throw new ApiError(400, 'Сумма операции по заданию должна быть больше нуля.');
      const selected = selectedOperatorAllocations(state, body, fields.amount, prior);
      state.refuellings[recordId] = { ...fields, ...common, schemaVersion: 3, planId: selected.plan.id, planClientName: selected.plan.clientName, allocations: selected.allocations, recipientText: selected.recipientText };
      selected.plan.version++;
      selected.plan.updatedAt = now;
    } else if (body.schemaVersion === 2) {
      keys(body,[...fuelV2Keys,'idempotencyKey',...(id?['version']:[])]);
      state.refuellings[recordId] = { ...selectedV2Fields(body, prior, directories), ...common };
    } else {
      if (prior?.schemaVersion !== undefined) throw new ApiError(400, 'Используйте актуальную форму записи.');
      keys(body,[...fuelKeys,'recipientId','recipientVersion','idempotencyKey',...(id?['version']:[])]);
      const fields = fuelFields(body);
      const recipient = typeof body.recipientId === 'string' && Object.hasOwn(state.recipients,body.recipientId) ? state.recipients[body.recipientId] : undefined;
      if (!recipient || recipient.archived) throw new ApiError(400,'Выберите действующие реквизиты получателя.');
      if (body.recipientVersion !== recipient.version) throw new ApiError(409,'Реквизиты изменились. Обновите список и проверьте получателя.');
      state.refuellings[recordId] = {...fields, ...common, recipientId:recipient.id, recipient:recipientFields({...recipient})};
    }
  } else throw new ApiError(404,'Действие не найдено.');
  state.requests[key] = {fingerprint,actorId:actor.id,collection,id:recordId};
  data.operator = state;
  return {changed:true,result:{id:recordId,replayed:false,...(action === 'delete' ? { deleted: true } : {})}};
}

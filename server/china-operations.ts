import { randomUUID } from 'node:crypto';
import type { AccountUser } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import { emptyChina, type ChinaData, type ChinaFuel } from '../web/src/china-model';
import { decimal, validDate } from '../web/src/shipment-calculations';
import { ApiError } from './api-error';
import { StoreError, type OperationsData } from './operations-store';
import { requireManage } from './auth';
const obj = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 180;
const day = (value: unknown): value is string => typeof value === 'string' && value.length === 10 && validDate(value) === value;
const amount = (value: unknown): value is string => typeof value === 'string' && /^\d{1,18}(?:\.\d{1,6})?$/.test(value) && !!decimal(value)?.gte(0);
const timestamp = (value: unknown): boolean => typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
export function validateChina(value: unknown): asserts value is ChinaData | undefined {
  if (value === undefined) return;
  if (!obj(value) || !Array.isArray(value.days) || !Array.isArray(value.payments)) throw new StoreError('Invalid China data');
  const ids = new Set<string>(), dates = new Set<string>();
  for (const kind of ['days', 'payments'] as const) for (const row of value[kind] as unknown[]) {
    if (!obj(row) || !text(row.id) || ids.has(row.id) || !day(row.date) || !text(row.createdBy) || !timestamp(row.createdAt)) throw new StoreError('Invalid China entry');
    ids.add(row.id);
    if (kind === 'days') {
      if (dates.has(row.date) || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || !timestamp(row.updatedAt) || !Array.isArray(row.fuels) || !row.fuels.length || row.fuels.length > 100) throw new StoreError('Invalid China day');
      dates.add(row.date);
      for (const fuel of row.fuels) if (!obj(fuel) || !text(fuel.supplierId) || !amount(fuel.litres) || !decimal(fuel.litres)?.gt(0) || !amount(fuel.amount)) throw new StoreError('Invalid China fuel');
    } else if (!amount(row.amount) || !decimal(row.amount)?.gt(0)) throw new StoreError('Invalid China payment');
  }
}
export function mutateChina(data: OperationsData, snapshot: Snapshot, actor: AccountUser, kind: string, body: Record<string, unknown>, id?: string) {
  requireManage(actor);
  const china = data.china ?? emptyChina();
  if (!['days','payments'].includes(kind) || id && kind !== 'days') throw new ApiError(404, 'Запись не найдена.');
  const previous = id ? china.days.find(row => row.id === id) : undefined;
  if (id && !previous) throw new ApiError(404, 'День не найден.');
  if (Object.keys(body).some(key => !['date', ...(id ? ['version'] : ['requestId']), ...(kind === 'days' ? ['fuels'] : ['amount'])].includes(key))) throw new ApiError(400, 'Неизвестные поля.');
  if (previous && body.version !== previous.version) throw new ApiError(409, 'День изменён. Обновите список и повторите изменение.');
  if (!day(body.date)) throw new ApiError(400, 'Укажите корректную дату.');
  if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))) throw new ApiError(400, 'Некорректный идентификатор запроса.');
  const now = new Date().toISOString();
  const common = { id: id ?? `china-${kind}-${body.requestId ?? randomUUID()}`, date: body.date, createdBy: previous?.createdBy ?? actor.id, createdAt: previous?.createdAt ?? now };
  let fuels: ChinaFuel[] = [];
  if (kind === 'days') {
    if (!Array.isArray(body.fuels) || !body.fuels.length || body.fuels.length > 100) throw new ApiError(400, 'Добавьте от 1 до 100 строк заправок.');
    fuels = body.fuels.map(fuel => {
      if (!obj(fuel) || Object.keys(fuel).some(key => !['supplierId','litres','amount'].includes(key)) || !text(fuel.supplierId) || !snapshot.companies.some(company => company.id === fuel.supplierId && company.roles.includes('supplier'))) throw new ApiError(400, 'Выберите поставщика из общего справочника.');
      if (!amount(fuel.litres) || !decimal(fuel.litres)?.gt(0) || !amount(fuel.amount)) throw new ApiError(400, 'Литры должны быть больше нуля, сумма — неотрицательной. До 18 цифр и 6 знаков после точки.');
      return { supplierId: fuel.supplierId, litres: decimal(fuel.litres)!.toFixed(), amount: decimal(fuel.amount)!.toFixed() };
    });
  } else if (!amount(body.amount) || !decimal(body.amount)?.gt(0)) throw new ApiError(400, 'Укажите сумму платежа больше нуля. До 18 цифр и 6 знаков после точки.');
  const entry = kind === 'days' ? { ...common, version: (previous?.version ?? 0) + 1, updatedAt: now, fuels } : { ...common, amount: decimal(body.amount as string)!.toFixed() };
  const duplicate = !id ? [...china.days, ...china.payments].find(row => row.id === entry.id) : undefined;
  if (duplicate) {
    const comparable = (row: typeof duplicate | typeof entry) => ({ date: row.date, createdBy: row.createdBy, ...('fuels' in row ? {fuels: row.fuels} : {amount: row.amount}) });
    if (JSON.stringify(comparable(duplicate)) !== JSON.stringify(comparable(entry))) throw new ApiError(409, 'Запрос уже сохранён с другими значениями.');
    return { entry: duplicate, created: false, changed: false };
  }
  if ('fuels' in entry) {
    if (china.days.some(row => row.date === entry.date && row.id !== id)) throw new ApiError(409, 'Этот день уже внесён. Откройте его и добавьте строку поставщика.');
    china.days = [...china.days.filter(row => row.id !== id), entry];
  } else china.payments.push(entry);
  validateChina(china); data.china = china;
  return { entry, created: !previous, changed: true };
}

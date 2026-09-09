import type { Shipment } from '../web/src/model';
import { shipmentColumns, fieldValue } from '../web/src/shipment-templates';
import { ApiError } from './api-error';
import { normalizeName } from './directory-operations';
import type { ColumnFilter } from '../web/src/shipment-filters';
import { decimal, validDate } from '../web/src/shipment-calculations';

export function parseFilters(params: URLSearchParams): Record<string, ColumnFilter> {
  const raw = params.get('filters') ?? '{}';
  if (raw.length > 16000) throw new ApiError(400,'Слишком много условий фильтра.');
  let filters: Record<string, ColumnFilter>;
  try { filters = JSON.parse(raw); } catch { throw new ApiError(400,'Некорректный фильтр.'); }
  if (!filters || Array.isArray(filters) || typeof filters !== 'object' || Object.keys(filters).length > shipmentColumns.length) throw new ApiError(400,'Некорректный фильтр.');
  for (const [key,filter] of Object.entries(filters)) {
    const column = shipmentColumns.find(c => c.key === key);
    if (!column || !filter || !['values','contains','equals','range','empty','notEmpty'].includes(filter.op)) throw new ApiError(400,'Некорректное условие колонки.');
    if (filter.op === 'values' && (!Array.isArray(filter.values) || filter.values.length > 1000 || filter.values.some(v => typeof v !== 'string' || v.length > 4000))) throw new ApiError(400,'Некорректный список значений.');
    if (['contains','equals'].includes(filter.op) && (typeof filter.value !== 'string' || filter.value.length > 4000)) throw new ApiError(400,'Некорректное значение фильтра.');
    if (filter.op === 'range') {
      if (!['number','date'].includes(column.kind) || (!filter.value && !filter.to)) throw new ApiError(400,'Укажите границы диапазона.');
      for (const value of [filter.value,filter.to]) if (value && (typeof value !== 'string' || !(column.kind === 'number' ? decimal(value) : validDate(value)))) throw new ApiError(400,'Некорректная граница диапазона.');
    }
  }
  return filters;
}
export function matchesColumn(row: Shipment, key: string, filter: ColumnFilter): boolean {
  const value = fieldValue(row,key) ?? '';
  if (filter.op === 'empty') return !value;
  if (filter.op === 'notEmpty') return !!value;
  if (filter.op === 'values') return filter.values!.includes(value);
  if (filter.op === 'contains') return normalizeName(value).includes(normalizeName(filter.value!));
  if (filter.op === 'equals') return normalizeName(value) === normalizeName(filter.value!);
  if (!value) return false;
  const kind = shipmentColumns.find(c => c.key === key)!.kind;
  if (kind === 'number') {
    const number = decimal(value);
    return !!number && (!filter.value || number.gte(decimal(filter.value)!)) && (!filter.to || number.lte(decimal(filter.to)!));
  }
  const date = validDate(value);
  return !!date && (!filter.value || date >= validDate(filter.value)!) && (!filter.to || date <= validDate(filter.to)!);
}
export function sortShipments(rows: Shipment[], params: URLSearchParams) {
  const key = params.get('sort') ?? 'date', direction = params.get('direction') ?? 'desc';
  const column = shipmentColumns.find(c => c.key === key);
  if (!column || !['asc','desc'].includes(direction)) throw new ApiError(400,'Некорректная сортировка.');
  return rows.sort((a,b) => {
    const left = fieldValue(a,key), right = fieldValue(b,key);
    if (!left || !right) return !left && !right ? a.id.localeCompare(b.id) : !left ? 1 : -1;
    const compared = column.kind === 'number' && decimal(left) && decimal(right) ? decimal(left)!.comparedTo(decimal(right)!) : left.localeCompare(right,'ru',{numeric:true});
    return compared * (direction === 'asc' ? 1 : -1) || a.id.localeCompare(b.id);
  });
}

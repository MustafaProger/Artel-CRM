import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { NamedEntry, OperatorService, Snapshot } from '../web/src/model';
import { readOperatorCatalog, operatorCatalogDate } from '../web/src/operator-catalog';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';

export function operatorDiscount(value: unknown): string {
  if (typeof value !== 'string' || value.length > 32) throw new ApiError(400, 'Укажите скидку от 0 до 100%.');
  const normalized = value.trim().replace(',', '.');
  if (!/^\d+(?:\.\d{1,6})?$/.test(normalized) || new Decimal(normalized).gt(100)) throw new ApiError(400, 'Укажите скидку от 0 до 100%, до 6 знаков после запятой.');
  return new Decimal(normalized).toFixed();
}

export function saveOperatorDirectory(kind: 'operatorGroups' | 'operatorServices', input: Record<string, unknown>, snapshot: Snapshot, data: OperationsData, id?: string) {
  const allowed = ['kind', 'name', ...(id ? ['version'] : []), ...(kind === 'operatorServices' ? ['discountPercent', 'backgroundColor'] : [])];
  if (Object.keys(input).some(key => !allowed.includes(key))) throw new ApiError(400, 'Неизвестное поле справочника.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 500) throw new ApiError(400, 'Укажите название.');
  const name = input.name.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const { groups, services } = readOperatorCatalog(snapshot.directories!);
  const rows: (NamedEntry | OperatorService)[] = kind === 'operatorGroups' ? groups : services;
  const previous = id ? rows.find(row => row.id === id) : undefined;
  if (id && !previous) throw new ApiError(404, 'Запись не найдена.');
  if (previous && input.version !== (previous.version ?? 0)) throw new ApiError(409, 'Запись уже изменена. Закройте карточку и откройте её снова.');
  const discountPercent = kind === 'operatorServices' ? operatorDiscount(input.discountPercent) : undefined;
  if (input.backgroundColor !== undefined && (typeof input.backgroundColor !== 'string' || !/^#[0-9a-f]{6}$/i.test(input.backgroundColor))) throw new ApiError(400, 'Укажите цвет фона в формате #RRGGBB.');
  const duplicate = rows.find(row => row.id !== id && row.name.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'));
  if (duplicate) {
    if (id) throw new ApiError(409, 'Такая запись уже есть в справочнике.');
    return { entry: duplicate, created: false };
  }
  const priorService = previous as OperatorService | undefined;
  const history = priorService?.discountHistory;
  const discountChanged = discountPercent !== undefined && priorService && discountPercent !== priorService.discountPercent;
  const day = operatorCatalogDate();
  const discountHistory = discountChanged
    ? [...(history ?? [{ effectiveFrom: '0001-01-01', discountPercent: priorService.discountPercent }]).filter(rate => rate.effectiveFrom !== day), { effectiveFrom: day, discountPercent }]
    : history;
  const backgroundColor = typeof input.backgroundColor === 'string' ? input.backgroundColor.toLowerCase() : priorService?.backgroundColor;
  const entry = { ...(backgroundColor ? { backgroundColor } : {}), ...(discountHistory ? { discountHistory } : {}), id: id ?? `${kind}-${randomUUID()}`, name, version: (previous?.version ?? 0) + 1, ...(discountPercent !== undefined ? { discountPercent } : {}) };
  const updated = previous ? rows.map(row => row.id === id ? entry : row) : [...rows, entry];
  if (kind === 'operatorGroups') data.directories!.operatorGroups = updated;
  else data.directories!.operatorServices = updated as OperatorService[];
  return { entry, created: !previous };
}

import { randomUUID } from 'node:crypto';
import type { Company, OilDepot, Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { locationDetails } from './location-details';

export const oilDepotRoleKeys = ['ownerCompanyId', 'loadingActorCompanyId', 'infrastructureOwnerCompanyId'] as const;
export const oilDepotFields = ['name', 'address', 'mapUrl', 'latitude', 'longitude', ...oilDepotRoleKeys] as const;
const normalized = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ');

/** Optional facts stay missing; company roles and legal addresses are never inferred. */
export function oilDepotDetails(input: Record<string, unknown>, selection?: { companies: readonly Company[]; previous?: OilDepot }): Omit<OilDepot, 'id' | 'version'> {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 500) throw new ApiError(400, 'Укажите наименование нефтебазы.');
  const location = locationDetails(Object.fromEntries(['address', 'mapUrl', 'latitude', 'longitude'].map(key => [key, input[key]])));
  const result: Omit<OilDepot, 'id' | 'version'> = { name: normalized(input.name), ...location };
  for (const key of oilDepotRoleKeys) {
    const value = input[key];
    if (value === undefined || value === '') continue;
    if (typeof value !== 'string' || value.length > 500 || !value.trim()) throw new ApiError(400, 'Выберите компанию для соответствующей роли нефтебазы.');
    const id = value.trim();
    if (selection) {
      const company = selection.companies.find(row => row.id === id);
      if (!company || company.directoryArchived && selection.previous?.[key] !== id) throw new ApiError(400, 'Выберите действующую компанию из справочника для каждой роли нефтебазы.');
    }
    result[key] = id;
  }
  return result;
}

export function saveOilDepot(input: Record<string, unknown>, snapshot: Snapshot, data: OperationsData, id?: string) {
  if (Object.keys(input).some(key => !['kind', 'version', ...oilDepotFields].includes(key))) throw new ApiError(400, 'Неизвестное поле нефтебазы.');
  const catalog = snapshot.directories?.oilDepots ?? [];
  const previous = id ? catalog.find(row => row.id === id) : undefined;
  if (id && !previous) throw new ApiError(404, 'Нефтебаза не найдена.');
  if (previous && input.version !== (previous.version ?? 0)) throw new ApiError(409, 'Нефтебаза уже изменена. Откройте карточку повторно.');
  const details = oilDepotDetails({ ...previous, ...input }, { companies: snapshot.companies, previous });
  const duplicate = catalog.find(row => row.id !== id && normalized(row.name).toLocaleLowerCase('ru') === details.name.toLocaleLowerCase('ru') && normalized(row.address || '').toLocaleLowerCase('ru') === normalized(details.address || '').toLocaleLowerCase('ru'));
  if (duplicate) {
    if (id || oilDepotFields.some(key => (details[key] || '') !== (duplicate[key] || ''))) throw new ApiError(409, 'Нефтебаза с таким названием и адресом уже есть. Сверьте существующую карточку.');
    return { entry: duplicate, created: false };
  }
  const entry: OilDepot = { ...details, id: id || `oilDepots-${randomUUID()}`, ...(previous ? { version: (previous.version ?? 0) + 1 } : {}) };
  const rows = data.directories!.oilDepots ??= [];
  const index = rows.findIndex(row => row.id === entry.id);
  if (index >= 0) rows[index] = entry; else rows.push(entry);
  return { entry, created: !previous };
}

export function deleteOilDepot(id: string, input: Record<string, unknown>, snapshot: Snapshot, data: OperationsData) {
  if (Object.keys(input).some(key => key !== 'version')) throw new ApiError(400, 'Неизвестное поле удаления.');
  const previous = snapshot.directories?.oilDepots?.find(row => row.id === id);
  if (!previous) throw new ApiError(404, 'Нефтебаза не найдена.');
  if (input.version !== (previous.version ?? 0)) throw new ApiError(409, 'Нефтебаза уже изменена. Обновите справочник.');
  if (snapshot.shipments.some(row => row.fields.oil_depot_id === id)) throw new ApiError(409, 'Нельзя удалить нефтебазу, используемую в отгрузках.');
  data.directories!.oilDepots = (data.directories!.oilDepots ?? []).filter(row => row.id !== id);
  const deleted = (data.directories!.deletedEntries ??= {}).oilDepots ??= [];
  if (!deleted.includes(id)) deleted.push(id);
  return { created: false as const, deleted: true as const, id };
}

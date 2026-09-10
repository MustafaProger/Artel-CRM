import { companyFields } from '../web/src/directory-fields';
import { randomUUID } from 'node:crypto';
import type { Company, Directories, ShipmentAddress, Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { addDirectoryEntry, normalizeName } from './directory-operations';
import { validInn } from './checko';
import { companyRoleUsed } from './directory-deletion';

export type EditableDirectory = 'managers' | 'products' | 'paymentForms' | 'vehicles' | 'drivers' | 'addresses';
export function updateDirectoryEntry(kind: string, id: string, input: Record<string, unknown>, snapshot: Snapshot, data: OperationsData) {
  if (!['managers', 'products', 'paymentForms', 'vehicles', 'drivers', 'addresses'].includes(kind)) throw new ApiError(400, 'Неизвестный справочник.');
  const key = kind as EditableDirectory;
  const previous = snapshot.directories![key].find(row => row.id === id);
  if (!previous) throw new ApiError(404, 'Запись не найдена.');
  if (input.version !== (previous.version ?? 0)) throw new ApiError(409, 'Запись уже изменена. Закройте карточку и откройте её снова.');
  const { version: _version, ...fields } = input;
  if (key === 'addresses' && 'companyId' in previous && (fields.companyId !== previous.companyId || fields.addressKind !== previous.kind) && snapshot.shipments.some(row => [row.fields.loading_address_id, row.fields.unloading_address_id].includes(id))) throw new ApiError(409, 'Адрес используется в отгрузке. Нельзя изменить его компанию или тип.');
  // Reuse creation validation, excluding only the record being edited.
  const catalog = { ...snapshot.directories!, [key]: snapshot.directories![key].filter(row => row.id !== id) };
  const draft = structuredClone(data);
  const result = addDirectoryEntry({ ...fields, kind }, { ...snapshot, directories: catalog }, draft);
  if (!result.created) throw new ApiError(409, 'Такая запись уже есть в справочнике.');
  const entry = { ...result.entry, id, version: (previous.version ?? 0) + 1 } as Directories[typeof key][number];
  const rows = data.directories![key] as (typeof entry)[];
  const index = rows.findIndex(row => row.id === id);
  if (index >= 0) rows[index] = entry;
  else rows.push(entry);
  return { entry, created: false };
}

export function saveCompany(input: Record<string, unknown>, snapshot: Snapshot, data: OperationsData, id?: string) {
  if (Object.keys(input).some(key => !['kind', 'version', 'name', 'inn', 'roles', 'managerId', 'addresses', ...companyFields.map(([key])=>key)].includes(key))) throw new ApiError(400, 'Неизвестное поле компании.');
  const previous = id ? snapshot.companies.find(company => company.id === id) : undefined;
  if (id && !previous) throw new ApiError(404, 'Компания не найдена.');
  if (previous && input.version !== (previous.version ?? 0)) throw new ApiError(409, 'Компания уже изменена. Закройте карточку и откройте её снова.');
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.length > 500) throw new ApiError(400, 'Укажите наименование компании.');
  const name = input.name.normalize('NFKC').trim().replace(/\s+/g, ' ');
  if (input.inn !== undefined && typeof input.inn !== 'string') throw new ApiError(400, 'Проверьте ИНН.');
  const inn = (input.inn as string | undefined)?.trim() || undefined;
  if (inn && !validInn(inn)) throw new ApiError(400, 'Укажите корректный ИНН из 10 или 12 цифр.');
  if (snapshot.companies.some(company => company.id !== id && inn && company.inn === inn)) throw new ApiError(409, 'Компания с таким ИНН уже есть в справочнике.');
  if (!previous && snapshot.companies.some(company => normalizeName(company.name) === normalizeName(name) && (!inn || !company.inn))) throw new ApiError(409, 'Компания с таким названием уже есть. Откройте её карточку.');
  if (!Array.isArray(input.roles) || input.roles.some(role => !['customer', 'supplier'].includes(String(role)) && !(role === 'carrier' && previous?.roles.includes('carrier')))) throw new ApiError(400, 'Выберите тип компании: клиент или поставщик.');
  if (!input.roles.some(role => ['customer', 'supplier'].includes(String(role)))) throw new ApiError(400, 'Выберите тип компании: клиент или поставщик.');
  const roles = [...new Set([...(input.roles as string[]), ...(previous?.roles.filter(role => !['customer', 'supplier'].includes(role)) ?? [])])];
  if (previous?.roles.includes('supplier') && !roles.includes('supplier') && data.china?.days.some(day => day.fuels.some(fuel => fuel.supplierId === previous.id))) throw new ApiError(409, 'Нельзя убрать тип «Поставщик»: компания используется в заправках Китая.');
  if (previous) for (const role of ['customer', 'supplier'] as const) if (previous.roles.includes(role) && !roles.includes(role) && companyRoleUsed(snapshot, previous, role)) throw new ApiError(409, `Нельзя убрать тип «${role === 'customer' ? 'Клиент' : 'Поставщик'}»: компания используется в отгрузках.`);
  const managerId = input.managerId || null;
  if (managerId !== null && (typeof managerId !== 'string' || !snapshot.directories!.managers.some(manager => manager.id === managerId))) throw new ApiError(400, 'Выберите менеджера из справочника.');
  const companyId = id ?? `company-local-${randomUUID()}`;
  if (!Array.isArray(input.addresses) || input.addresses.length > 100) throw new ApiError(400, 'Укажите адреса компании списком.');
  const seen = new Set<string>();
  const oldAddresses = snapshot.directories!.addresses.filter(address => address.companyId === companyId);
  const addresses: ShipmentAddress[] = input.addresses.map(raw => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !['id', 'name', 'kind'].includes(key)) || typeof raw.name !== 'string' || !raw.name.trim() || raw.name.length > 500 || !['loading', 'delivery'].includes(raw.kind)) throw new ApiError(400, 'Проверьте адрес и его тип.');
    if (raw.id && (typeof raw.id !== 'string' || !oldAddresses.some(address => address.id === raw.id && address.kind === raw.kind))) throw new ApiError(400, 'Адрес не принадлежит компании или имеет другой тип.');
    const name = raw.name.normalize('NFKC').trim().replace(/\s+/g, ' ');
    const key = `${raw.kind}:${normalizeName(name)}`;
    if (seen.has(key) || raw.id && seen.has(raw.id)) throw new ApiError(400, 'Адрес указан дважды.');
    seen.add(key); if (raw.id) seen.add(raw.id);
    const previousAddress = oldAddresses.find(row => row.id === raw.id);
    return { id: raw.id || `addresses-${randomUUID()}`, companyId, name, kind: raw.kind, ...(previousAddress ? { version: (previousAddress.version ?? 0) + (previousAddress.name === name ? 0 : 1) } : {}) };
  });
  const removed = oldAddresses.filter(address => !addresses.some(row => row.id === address.id));
  if (snapshot.shipments.some(row => removed.some(address => [row.fields.loading_address_id, row.fields.unloading_address_id].includes(address.id)))) throw new ApiError(409, 'Адрес используется в отгрузке. Его можно изменить, но нельзя удалить.');
  const details = Object.fromEntries(companyFields.filter(([key])=>Object.hasOwn(input,key)).map(([key])=>{
    if (input[key] !== null && (typeof input[key] !== 'string' || (input[key] as string).length > 500)) throw new ApiError(400, 'Проверьте реквизиты компании.');
    return [key, typeof input[key] === 'string' ? (input[key] as string).trim() : null];
  }));
  const company: Company = { ...(previous ?? { managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] }), id: companyId, name, inn, roles, version: (previous?.version ?? 0) + 1 };
  if (previous && (previous.inn !== inn || previous.name !== name)) {
    delete company.registrySource; delete company.registryCheckedAt;
    if (previous.inn !== inn) { delete company.kpp; delete company.ogrn; delete company.fullName; delete company.address; delete company.status; }
  }
  Object.assign(company, details);
  const index = data.companies.findIndex(row => row.id === companyId);
  if (index >= 0) data.companies[index] = company;
  else data.companies.push(company);
  data.directories!.addresses = [...data.directories!.addresses.filter(address => address.companyId !== companyId), ...addresses];
  data.directories!.customerManagers = (data.directories!.customerManagers ?? []).filter(row => row.companyId !== companyId);
  if (managerId) data.directories!.customerManagers.push({ companyId, managerId: managerId as string });
  return { entry: company, created: !previous };
}

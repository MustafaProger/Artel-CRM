import type { Company, Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { directoryEntryId, normalizeName } from './directory-operations';

const kinds = ['companies', 'managers', 'products', 'paymentForms', 'vehicles', 'drivers', 'addresses'] as const;
type DirectoryKind = (typeof kinds)[number];
const sameName = (left: string | null | undefined, right: string) => !!left && normalizeName(left) === normalizeName(right);
const blocked = (name: string, dependency: string): never => { throw new ApiError(409, `Нельзя удалить «${name}»: запись используется ${dependency}. Сначала измените связанные записи.`); };
const rememberDeletion = (data: OperationsData, kind: DirectoryKind, id: string) => {
  const deleted = data.directories!.deletedEntries ??= {};
  const ids = deleted[kind] ??= [];
  if (!ids.includes(id)) ids.push(id);
};

export function companyRoleUsed(snapshot: Snapshot, company: Company, role: 'customer' | 'supplier' | 'carrier') {
  return snapshot.shipments.some(row => row[`${role}Id`] === company.id || row.fields[`${role}_id`] === company.id || !row[`${role}Id`] && sameName(row.fields[`${role}_name`], company.name));
}

/** Called only inside the API storage transaction after its normal authorization check. */
export function deleteDirectoryEntry(kind: string, id: string, input: Record<string, unknown>, snapshot: Snapshot, data: OperationsData) {
  const catalog = snapshot.directories!;
  if (kind === 'customerManagers') {
    if (Object.keys(input).some(key => key !== 'managerId')) throw new ApiError(400, 'Неизвестное поле удаления связи.');
    const previous = catalog.customerManagers?.find(row => row.companyId === id);
    if (!previous) throw new ApiError(404, 'Связь клиента и менеджера не найдена.');
    if (input.managerId !== previous.managerId) throw new ApiError(409, 'Менеджер уже изменён. Обновите справочник и повторите действие.');
    data.directories!.customerManagers = (data.directories!.customerManagers ?? []).filter(row => row.companyId !== id);
    return { created: false as const, deleted: true as const, id };
  }
  if (Object.keys(input).some(key => key !== 'version')) throw new ApiError(400, 'Неизвестное поле удаления.');
  const role = kind === 'customers' ? 'customer' : kind === 'suppliers' ? 'supplier' : undefined;
  const key = role ? 'companies' : kind as DirectoryKind;
  if (!kinds.includes(key)) throw new ApiError(400, 'Неизвестный справочник.');
  const previous = key === 'companies' ? snapshot.companies.find(row => row.id === id) : catalog[key].find(row => row.id === id);
  if (!previous || role && !(previous as Company).roles.includes(role)) throw new ApiError(404, 'Запись не найдена.');
  if (input.version !== (previous.version ?? 0)) throw new ApiError(409, 'Запись уже изменена. Обновите справочник и повторите действие.');
  const name = 'plate' in previous ? previous.name || previous.plate : previous.name;
  if (key === 'companies') {
    const company = previous as Company;
    if (data.china?.days.some(day => day.fuels.some(fuel => fuel.supplierId === id)) && (!role || role === 'supplier')) blocked(name, 'в заправках Китая');
    if (role && companyRoleUsed(snapshot, company, role)) blocked(name, role === 'customer' ? 'в отгрузках клиента' : 'в отгрузках поставщика');
    const roles = role ? company.roles.filter(value => value !== role) : [];
    // One legal entity can remain in the other directory and in historical carrier data.
    if (role && roles.length) {
      const updated = { ...company, roles, version: (company.version ?? 0) + 1 };
      const index = data.companies.findIndex(row => row.id === id);
      if (index < 0) data.companies.push(updated); else data.companies[index] = updated;
      return { created: false as const, deleted: true as const, id, retainedCompany: true };
    }
    if (['customer', 'supplier', 'carrier'].some(role => companyRoleUsed(snapshot, company, role as 'customer' | 'supplier' | 'carrier'))) blocked(name, 'в отгрузках');
    if (snapshot.payments.some(row => row.counterpartyId === id || !row.counterpartyId && sameName(row.counterparty, name))) blocked(name, 'в платежах');
    if (snapshot.stocks.some(row => row.counterpartyId === id)) blocked(name, 'в складских записях');
    if (data.work?.tasks.some(row => row.companyId === id) || data.work?.companyRecords.some(row => row.companyId === id)) blocked(name, 'в рабочем пространстве сотрудников');
    if (catalog.addresses.some(row => row.companyId === id)) blocked(name, 'в справочнике адресов');
    if (catalog.customerManagers?.some(row => row.companyId === id)) blocked(name, 'в назначении менеджера компании');
    data.companies = data.companies.filter(row => row.id !== id);
    rememberDeletion(data, key, id);
  } else {
    const fields: Record<Exclude<DirectoryKind, 'companies'>, [string[], string[]]> = {
      managers: [['manager_id'], ['manager_label']], products: [['product_id'], ['product']], paymentForms: [['payment_form_id'], ['payment_form']],
      vehicles: [['vehicle_id'], ['vehicle_plate']], drivers: [['driver_id'], ['driver_name']], addresses: [['loading_address_id', 'unloading_address_id'], ['loading_address', 'unloading_address']],
    };
    const [ids, labels] = fields[key];
    if (snapshot.shipments.some(row => ids.some(field => row.fields[field] === id) || labels.some(field => sameName(row.fields[field], name) || ['managers', 'products', 'paymentForms'].includes(key) && !!row.fields[field] && directoryEntryId(key, row.fields[field]!) === id))) blocked(name, 'в отгрузках');
    if (key === 'vehicles' && catalog.drivers.some(row => row.vehicleId === id)) blocked(name, 'в карточке водителя');
    if (key === 'managers' && catalog.customerManagers?.some(row => row.managerId === id)) blocked(name, 'в назначении менеджера компании');
    if (key === 'managers' && data.accounts?.users.some(row => row.managerId === id)) blocked(name, 'в учётной записи сотрудника');
    // Materialize the effective list, including imported records, before removing one item.
    data.directories![key] = catalog[key].filter(row => row.id !== id) as never;
    rememberDeletion(data, key, id);
  }
  return { created: false as const, deleted: true as const, id };
}

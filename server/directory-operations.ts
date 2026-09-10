import { driverFields, allVehicleFields } from '../web/src/directory-fields';
import { createHash, randomUUID } from 'node:crypto';
import type { Directories, NamedEntry, Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { validPhone, validVehicleMetadata, withFleetDirectories } from './fleet-directory';
import { TEMPLATE_PROFIT_RULE } from '../web/src/shipment-calculations';

export const normalizeName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
export const normalizePlate = (value: string) => value.normalize('NFKC').toUpperCase().replace(/[\s-]/g, '').replace(/[ABCEHKMOPTXY]/g, c => ({ A:'А',B:'В',C:'С',E:'Е',H:'Н',K:'К',M:'М',O:'О',P:'Р',T:'Т',X:'Х',Y:'У' }[c]!));
export const emptyDirectories = (): Directories => ({ managers: [], products: [], paymentForms: [], vehicles: [], drivers: [], addresses: [], defaults: { profit: TEMPLATE_PROFIT_RULE }, duplicates: [], customerManagers: [] });
const stableId = (kind: string, name: string) => `${kind}-${createHash('sha256').update(normalizeName(name)).digest('hex').slice(0,16)}`;
export function directoriesFor(base: Snapshot, store: OperationsData): Directories {
  const saved = withFleetDirectories(store.directories ?? emptyDirectories());
  const named = (kind: 'managers' | 'products' | 'paymentForms', labels: string[]) => {
    const unique = new Map<string, NamedEntry>();
    for (const name of labels) if (name.trim() && name !== '0' && !saved[kind].some(row => row.id === stableId(kind, name))) unique.set(normalizeName(name), { id: stableId(kind, name), name: name.trim() });
    for (const row of saved[kind]) unique.set(normalizeName(row.name), row);
    return [...unique.values()].sort((a,b) => a.name.localeCompare(b.name, 'ru'));
  };
  const local = Object.values(store.shipments).filter(row => !row.deleted);
  const duplicates = base.quality.aliasCandidates.map(group => ({ kind: 'companies', ...group, reason: 'Сходные названия без подтверждённого общего ИНН. Связи сохранены; требуется проверка.' }));
  const companies = [...base.companies.filter(c => !store.companies.some(s => s.id === c.id)), ...store.companies];
  const names = new Map<string, typeof companies>();
  for (const company of companies) { const key = normalizeName(company.name); names.set(key, [...(names.get(key) ?? []),company]); }
  for (const group of names.values()) if (group.length > 1) duplicates.push({kind:'companies',ids:group.map(c=>c.id),names:group.map(c=>c.name),reason:'Одинаковое название; идентичность юридического лица требует подтверждения по ИНН.'});
  return { ...saved,
    defaults: { profit: TEMPLATE_PROFIT_RULE },
    customerManagers: saved.customerManagers ?? [],
    managers: named('managers', [...base.managers.map(m => m.label), ...local.flatMap(r => r.fields.manager_label ? [r.fields.manager_label] : [])]),
    products: named('products', [...base.shipments.flatMap(r => r.product ? [r.product] : []), ...local.flatMap(r => r.fields.product ? [r.fields.product] : [])]),
    paymentForms: named('paymentForms', ['б/нал', 'нал', 'ф2', ...base.shipments.flatMap(r => r.fields.payment_form ? [r.fields.payment_form] : [])]),
    duplicates: store.sourceOperationsCleared ? [] : duplicates,
  };
}
export function addDirectoryEntry(input: Record<string, unknown>, snapshot: Snapshot, data: OperationsData) {
  const { kind } = input;
  if (kind === 'customerManagers') {
    if (Object.keys(input).some(key => !['kind','companyId','managerId'].includes(key))) throw new ApiError(400, 'Неизвестное поле связи клиента и менеджера.');
    if (typeof input.companyId !== 'string' || !snapshot.companies.some(company => company.id === input.companyId)) throw new ApiError(400, 'Выберите клиента из справочника.');
    if (input.managerId !== null && (typeof input.managerId !== 'string' || !snapshot.directories!.managers.some(manager => manager.id === input.managerId))) throw new ApiError(400, 'Выберите менеджера из справочника.');
    const rows = data.directories!.customerManagers ??= [];
    const index = rows.findIndex(row => row.companyId === input.companyId);
    const entry = { companyId: input.companyId, managerId: input.managerId as string | null };
    if (index < 0 && entry.managerId === null || index >= 0 && rows[index].managerId === entry.managerId) return { entry, created: false };
    if (index >= 0) rows.splice(index, 1);
    if (entry.managerId) rows.push({ companyId: entry.companyId, managerId: entry.managerId });
    return { entry, created: true };
  }
  if (!['managers','products','paymentForms','vehicles','drivers','addresses'].includes(String(kind))) throw new ApiError(400,'Неизвестный справочник.');
  const key = kind as 'managers'|'products'|'paymentForms'|'vehicles'|'drivers'|'addresses';
  const permitted: Record<typeof key, string[]> = {managers:['name'],products:['name'],paymentForms:['name'],vehicles:['plate','name','brand','model','trailer','capacityLitres','compartmentsLitres',...allVehicleFields.map(([key])=>key)],drivers:['name','vehicleId','phone',...driverFields.map(([key])=>key)],addresses:['name','companyId','addressKind']};
  if (Object.keys(input).some(k => k !== 'kind' && !permitted[key].includes(k))) throw new ApiError(400,'Неизвестное поле справочника.');
  const text = (field: string, required = true) => {
    if (typeof input[field] !== 'string' || !(input[field] as string).trim() || (input[field] as string).length > 500) {
      if (!required && (input[field] === undefined || input[field] === '')) return '';
      throw new ApiError(400, `Заполните поле ${field}.`);
    }
    return (input[field] as string).normalize('NFKC').trim().replace(/\s+/g,' ');
  };
  const catalog = snapshot.directories!;
  const id = `${key}-${randomUUID()}`;
  let entry: NamedEntry | Directories['vehicles'][number] | Directories['drivers'][number] | Directories['addresses'][number];
  if (key === 'vehicles') {
    const suppliedLabel = text('plate'), normalizedPlate = normalizePlate(suppliedLabel);
    if (normalizedPlate.length < 4 || normalizedPlate.length > 40 || !/^[\p{L}\d]+$/u.test(normalizedPlate)) throw new ApiError(400,'Проверьте название автомобиля или номер.');
    const plate = /^[АВЕКМНОРСТУХ]\d{3}[АВЕКМНОРСТУХ]{2}\d{2,3}$/.test(normalizedPlate) ? normalizedPlate : suppliedLabel;
    const duplicate = catalog.vehicles.find(v => normalizePlate(v.plate) === normalizedPlate);
    if (duplicate) return { entry: duplicate, created: false };
    const name = text('name', false), capacityLitres = text('capacityLitres', false).replace(/\s/g, '').replace(',', '.');
    let compartmentsLitres: string[] | undefined;
    if (input.compartmentsLitres !== undefined) {
      if (!Array.isArray(input.compartmentsLitres) || input.compartmentsLitres.some(value => typeof value !== 'string')) throw new ApiError(400, 'Укажите объёмы секций списком чисел.');
      compartmentsLitres = (input.compartmentsLitres as string[]).map(value => value.replace(/\s/g, '').replace(',', '.'));
    }
    entry = { ...Object.fromEntries(allVehicleFields.map(([key])=>[key,text(key,false)])), id, plate, brand: text('brand', false), model: text('model', false), trailer: text('trailer', false), ...(name ? { name } : {}), ...(capacityLitres ? { capacityLitres } : {}), ...(compartmentsLitres ? { compartmentsLitres } : {}) };
    if (!validVehicleMetadata({ ...entry })) throw new ApiError(400, 'Укажите положительные объёмы в литрах. Сумма секций должна совпадать с объёмом автомобиля.');
  } else {
    const name = text('name');
    if (key === 'drivers') {
      const vehicleId = text('vehicleId');
      if (!catalog.vehicles.some(v => v.id === vehicleId)) throw new ApiError(400,'Выберите автомобиль из справочника.');
      const duplicate = catalog.drivers.find(d => normalizeName(d.name) === normalizeName(name));
      if (duplicate) {
        if (duplicate.vehicleId !== vehicleId) throw new ApiError(409,'Водитель с таким именем уже связан с другим автомобилем. Уточните запись в справочнике.');
        return { entry: duplicate, created: false };
      }
      const phone = text('phone', false);
      if (phone && !validPhone(phone)) throw new ApiError(400, 'Проверьте телефон водителя.');
      entry = { ...Object.fromEntries(driverFields.map(([key])=>[key,text(key,false)])), id, name, vehicleId, ...(phone ? { phone } : {}) };
    } else if (key === 'addresses') {
      const companyId = text('companyId'), addressKind = text('addressKind');
      if (!snapshot.companies.some(c => c.id === companyId) || !['loading','delivery'].includes(addressKind)) throw new ApiError(400,'Выберите компанию и тип адреса.');
      const duplicate = catalog.addresses.find(a => a.companyId === companyId && a.kind === addressKind && normalizeName(a.name) === normalizeName(name));
      if (duplicate) return { entry: duplicate, created: false };
      entry = { id, name, companyId, kind: addressKind as 'loading'|'delivery' };
    } else {
      const duplicate = catalog[key].find(r => normalizeName(r.name) === normalizeName(name));
      if (duplicate) return { entry: duplicate, created: false };
      entry = { id, name };
    }
  }
  (data.directories![key] as (typeof entry)[]).push(entry);
  return { entry, created: true };
}

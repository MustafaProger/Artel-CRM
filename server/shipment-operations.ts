import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import type { CalculationRules, Company, Metric, Shipment, ShipmentsResponse, Snapshot } from '../web/src/model';
import { calculateShipment, TEMPLATE_PROFIT_RULE } from '../web/src/shipment-calculations';
import { settlementKind } from '../web/src/shipment-settlement';
import { customerManagerId } from '../web/src/customer-manager';
import { directoriesFor } from './directory-operations';
import { parseFilters, matchesColumn, sortShipments } from './shipment-filtering';
import { shipmentColumns, fieldValue } from '../web/src/shipment-templates';
import { ApiError } from './api-error';
import { validInn } from './checko';
import { StoreError, type OperationsData } from './operations-store';

const Exact = Decimal.clone({ precision: 80 });
export const SHIPMENT_FIELDS = [
  'document_number', 'month', 'date', 'customer_name', 'manager_label', 'payment_form', 'product',
  'quantity_tonnes', 'quantity_litres', 'sale_price_per_tonne', 'sale_price_per_litre', 'customer_amount',
  'supplier_name', 'purchase_price_unspecified_unit', 'purchase_amount', 'carrier_name', 'transport_amount',
  'kvp_source', 'profit_source', 'paid_amount_source', 'debt_overpayment_source', 'term_source', 'unlabelled_note',
  'customer_inn', 'supplier_inn', 'loading_address', 'unloading_address', 'additional_costs', 'payment_date',
  // Explicit picker identities, separate from the workbook's visible columns.
  'customer_id', 'supplier_id', 'carrier_id',
  'manager_id', 'product_id', 'payment_form_id', 'driver_id', 'vehicle_id', 'driver_name', 'vehicle_plate',
  'trip_id', 'trip_total_tonnes', 'trip_additional_costs', 'days_since_shipment',
  'opening_payment_date', 'opening_paid_amount', 'loading_address_id', 'unloading_address_id', 'purchase_unit', 'payment_due_date', 'overdue_days', 'calculation_mode', 'profit_rule',
] as const;
const allowedFields = new Set<string>(SHIPMENT_FIELDS);
const amountFields = new Set(['quantity_tonnes', 'quantity_litres', 'sale_price_per_tonne', 'sale_price_per_litre', 'customer_amount', 'purchase_price_unspecified_unit', 'purchase_amount', 'transport_amount', 'kvp_source', 'profit_source', 'paid_amount_source', 'debt_overpayment_source', 'additional_costs']);
export const normalizeName = (value: string) => value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru');
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const numeric = (value: string | null | undefined): string | null => value && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value) && new Exact(value).isFinite() ? value : null;
const day = (value: string | null | undefined): string | null => {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?)?$/.test(value)) return null;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value.slice(0, 10) ? null : value.slice(0, 10);
};
const metric = (values: (string | null)[]): Metric => {
  const numbers = values.map(numeric).filter((value): value is string => value !== null);
  return { total: numbers.length ? numbers.reduce((sum, value) => sum.plus(value), new Exact(0)).toFixed() : null, numericCount: numbers.length, missingCount: values.length - numbers.length };
};
const totals = (rows: Shipment[]) => ({ liters: metric(rows.map(row => row.liters)), revenue: metric(rows.map(row => row.revenue)), cost: metric(rows.map(row => row.cost)) });

function findCompany(value: string | null, companies: Company[], inn?: string | null, id?: string | null): Company | null {
  if (value === null || !value.trim()) {
    if (id) throw new ApiError(400, 'Для выбранного контрагента отсутствует наименование.');
    return null;
  }
  const key = normalizeName(value);
  if (id) {
    const selected = companies.find(company => company.id === id);
    if (!selected) throw new ApiError(400, 'Выбранный контрагент отсутствует в справочнике.');
    if (normalizeName(selected.name) !== key && (!selected.fullName || normalizeName(selected.fullName) !== key)) throw new ApiError(400, 'Наименование не совпадает с выбранным контрагентом.');
    if (inn && selected.inn && selected.inn !== inn) throw new ApiError(400, 'ИНН не совпадает с выбранным контрагентом.');
    return selected;
  }
  const byInn = inn ? companies.find(company => company.inn === inn) : undefined;
  if (byInn) {
    if (normalizeName(byInn.name) !== key && (!byInn.fullName || normalizeName(byInn.fullName) !== key)) throw new ApiError(400, 'Указанный ИНН принадлежит другому контрагенту.');
    return byInn;
  }
  const byName = companies.filter(company => normalizeName(company.name) === key);
  const matches = byName.length ? byName : companies.filter(company => company.fullName && normalizeName(company.fullName) === key);
  if (matches.length !== 1) throw new ApiError(400, matches.length ? 'Название соответствует нескольким контрагентам. Выберите фирму из справочника.' : `Контрагент «${value}» отсутствует в справочнике. Добавьте фирму по ИНН.`);
  return matches[0];
}

export function validateShipmentFields(input: unknown, previous: Shipment | undefined, companies: Company[]): Record<string, string | null> {
  if (!object(input) || !Object.keys(input).length) throw new ApiError(400, 'Укажите поля операции.');
  const fields: Record<string, string | null> = previous ? { ...previous.fields } : Object.fromEntries(SHIPMENT_FIELDS.map(key => [key, null]));
  for (const [key, raw] of Object.entries(input)) {
    if (!allowedFields.has(key)) throw new ApiError(400, `Неизвестное поле: ${key}.`);
    if (raw !== null && typeof raw !== 'string') throw new ApiError(400, `Поле ${key} должно быть строкой или null.`);
    if (typeof raw === 'string' && raw.length > 4000) throw new ApiError(400, `Поле ${key} слишком длинное.`);
    // Unchanged saved Excel errors and historical values are permitted and preserved.
    if (previous && raw === previous.fields[key]) continue;
    let value = raw === null ? null : raw.trim() || null;
    if (value !== null && (key === 'date' || key === 'payment_date' || key === 'payment_due_date')) {
      const parsed = day(value);
      if (!parsed) throw new ApiError(400, `Поле ${key}: укажите корректную дату ГГГГ-ММ-ДД.`);
      value = parsed;
    }
    if (value !== null && amountFields.has(key)) {
      value = value.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value) || value.replace(/[^\d]/g, '').length > 40 || !numeric(value)) throw new ApiError(400, `Поле ${key}: укажите число, например 1234,56.`);
      value = new Exact(value).toFixed();
    }
    if (value !== null && key === 'month' && !/^\d{4}-(0[1-9]|1[0-2])$/.test(value) && (!/^\d{1,2}$/.test(value) || Number(value) < 1 || Number(value) > 12)) throw new ApiError(400, 'Некорректный месяц.');
    if (value !== null && key === 'term_source' && (!/^[+-]?\d+$/.test(value) || Math.abs(Number(value)) > 365000)) throw new ApiError(400, 'Срок указывается целым числом дней.');
    if (value !== null && (key === 'customer_inn' || key === 'supplier_inn') && !validInn(value)) throw new ApiError(400, `Поле ${key}: некорректный ИНН.`);
    fields[key] = value;
  }
  for (const role of ['customer', 'supplier', 'carrier']) {
    const nameKey = `${role}_name`;
    // Verify supplied references; retain untouched ambiguous legacy source names and ids.
    if ([nameKey, `${role}_inn`, `${role}_id`].some(key => Object.hasOwn(input, key) && (!previous || fields[key] !== previous.fields[key]))) {
      const company = findCompany(fields[nameKey], companies, fields[`${role}_inn`], fields[`${role}_id`]);
      fields[nameKey] = company?.name ?? null;
    }
    if (role !== 'carrier' && (Object.hasOwn(input, nameKey) || Object.hasOwn(input, `${role}_inn`))) {
      const matches = companies.filter(company => normalizeName(company.name) === normalizeName(fields[nameKey] ?? ''));
      if (matches.length === 1 && fields[`${role}_inn`] && matches[0].inn && fields[`${role}_inn`] !== matches[0].inn) throw new ApiError(400, `ИНН не совпадает с выбранным контрагентом (${role === 'customer' ? 'покупатель' : 'поставщик'}).`);
    }
  }
  if (!Object.values(fields).some(value => value !== null)) throw new ApiError(400, 'Заполните данные операции.');
  return fields;
}

function composeShipment(id: string, fields: Record<string, string | null>, companies: Company[], original?: Shipment): Shipment {
  const companyId = (role: 'customer' | 'supplier' | 'carrier') => original && fields[`${role}_name`] === original.fields[`${role}_name`] && fields[`${role}_inn`] === original.fields[`${role}_inn`] && fields[`${role}_id`] === original.fields[`${role}_id`] ? original[`${role}Id`] : fields[`${role}_id`] && companies.some(company => company.id === fields[`${role}_id`]) ? fields[`${role}_id`] : findCompany(fields[`${role}_name`], companies, fields[`${role}_inn`], fields[`${role}_id`])?.id ?? null;
  return {
    calculationRules: original?.calculationRules,
    id, date: day(fields.date), customerId: companyId('customer'), customer: fields.customer_name,
    supplierId: companyId('supplier'), supplier: fields.supplier_name, carrierId: companyId('carrier'), carrier: fields.carrier_name,
    product: fields.product, liters: numeric(fields.quantity_litres), revenue: numeric(fields.customer_amount), cost: numeric(fields.purchase_amount),
    manager: fields.manager_label, sourceRow: original?.sourceRow ?? 0, sourceSheet: original?.sourceSheet ?? 'Локальные операции',
    fields, flags: original?.flags ?? [],
  };
}

/** Fail closed if stored trip rows lose their shared truck totals or references. */
function validateStoredTrips(shipments: Shipment[]) {
  const groups = new Map<string, Shipment[]>();
  for (const row of shipments) {
    if (!row.fields.trip_id) {
      if (row.fields.trip_total_tonnes || row.fields.trip_additional_costs) throw new StoreError('Orphan trip metadata');
      continue;
    }
    if (!/^shipment-trip-[a-f0-9-]+$/.test(row.fields.trip_id)) throw new StoreError('Invalid trip identity');
    const members = groups.get(row.fields.trip_id) ?? [];
    members.push(row); groups.set(row.fields.trip_id, members);
  }
  const shared = ['date', 'supplier_id', 'purchase_price_unspecified_unit', 'product_id', 'driver_id', 'vehicle_id', 'loading_address_id', 'trip_total_tonnes', 'trip_additional_costs'];
  for (const rows of groups.values()) {
    const first = rows[0].fields;
    if (!numeric(first.trip_total_tonnes) || !new Exact(first.trip_total_tonnes!).gt(0) || !numeric(first.trip_additional_costs) || new Exact(first.trip_additional_costs!).lt(0)) throw new StoreError('Invalid trip totals');
    if (rows.some(row => row.fields.purchase_unit !== 'tonnes' || row.fields.calculation_mode !== 'automatic' || shared.some(key => (row.fields[key] ?? null) !== (first[key] ?? null)))) throw new StoreError('Inconsistent trip fields');
    for (const [field, total] of [['quantity_tonnes', 'trip_total_tonnes'], ['additional_costs', 'trip_additional_costs']] as const) {
      if (rows.some(row => !numeric(row.fields[field]) || new Exact(row.fields[field]!).lt(0))) throw new StoreError('Invalid trip allocation');
      if (!rows.reduce((sum, row) => sum.plus(row.fields[field]!), new Exact(0)).eq(first[total]!)) throw new StoreError('Trip allocation does not equal total');
    }
    if (rows.some(row => !numeric(row.fields.quantity_litres) || !new Exact(row.fields.quantity_litres!).gt(0) || !new Exact(row.fields.quantity_tonnes!).gt(0))) throw new StoreError('Empty trip allocation');
  }
}

export function currentSnapshot(base: Snapshot, store: OperationsData): Snapshot {
  const directories = directoriesFor(base, store);
  if (store.sourceOperationsCleared) base = {
    ...base, shipments: [], payments: [], stocks: [],
    quality: { status: 'cleared', issueCounts: {}, issues: [], recordFlagCounts: { shipments: {}, payments: {} }, flaggedShipmentCount: 0, flaggedPaymentCount: 0, duplicateCandidates: [], aliasCandidates: [], multipleManagerCompanyIds: [], limitations: [] },
    overview: { ...base.overview, paymentCount: 0, incoming: metric([]), outgoing: metric([]), missingPaymentDates: 0 },
    provenance: { ...base.provenance, counts: { counterparties: base.companies.length, manager_labels: directories.managers.length, shipment_rows: 0, payment_rows: 0, payments_with_amount: 0, incomplete_payment_rows: 0, stock_monthly_rows: 0, company_summary_rows: 0 } },
  };
  const companies = base.companies.map(company => ({ ...company }));
  for (const metadata of store.companies) {
    const index = companies.findIndex(company => company.id === metadata.id);
    if (index >= 0) companies[index] = { ...companies[index], ...metadata };
    else companies.push({ ...metadata });
  }
  const originals = new Map(base.shipments.map(row => [row.id, row]));
  const shipments: Shipment[] = base.shipments.filter(row => !store.shipments[row.id]).map(row => ({ ...row, fields: { ...row.fields }, version: 0 }));
  for (const [id, override] of Object.entries(store.shipments)) {
    if (override.deleted) continue;
    if (!originals.has(id) && !id.startsWith('shipment-local-')) throw new StoreError('Unknown original shipment');
    if (Object.keys(override.fields).some(key => !allowedFields.has(key))) throw new StoreError('Unknown stored field');
    try {
      const row = composeShipment(id, override.fields, companies, originals.get(id));
      shipments.push({ ...row, version: override.version, createdAt: override.createdAt, updatedAt: override.updatedAt });
    } catch { throw new StoreError('Invalid stored company reference'); }
  }
  for (const address of directories.addresses) if (!companies.some(c => c.id === address.companyId)) throw new StoreError('Invalid address company');
  for (const assignment of directories.customerManagers ?? []) {
    if (!companies.some(c => c.id === assignment.companyId) || !directories.managers.some(m => m.id === assignment.managerId)) throw new StoreError('Invalid customer manager reference');
  }
  for (const allocation of store.paymentAllocations ?? []) {
    if (!shipments.some(s => s.id === allocation.shipmentId) || !base.payments.some(p => p.id === allocation.paymentId)) throw new StoreError('Invalid payment allocation reference');
  }
  for (const row of shipments) {
    const fields = { ...row.fields };
    for (const [key,entries] of [['manager_id',directories.managers],['product_id',directories.products],['payment_form_id',directories.paymentForms],['driver_id',directories.drivers],['vehicle_id',directories.vehicles]] as const) {
      if (fields[key] && !entries.some(entry => entry.id === fields[key])) throw new StoreError('Invalid shipment directory reference');
    }
    for (const [key,role,kind] of [['loading_address_id','supplier','loading'],['unloading_address_id','customer','delivery']] as const) {
      if (fields[key] && !directories.addresses.some(a => a.id === fields[key] && a.companyId === row[`${role}Id`] && a.kind === kind)) throw new StoreError('Invalid shipment address');
    }
    const historical = fields.calculation_mode !== 'automatic';
    if (!historical) fields.profit_rule = TEMPLATE_PROFIT_RULE;
    const rules: CalculationRules = { sale: historical ? row.calculationRules?.sale ?? null : 'litres', purchase: ['litres','tonnes'].includes(fields.purchase_unit ?? '') ? fields.purchase_unit as 'litres'|'tonnes' : row.calculationRules?.purchase ?? null, profit: (fields.profit_rule as CalculationRules['profit']) ?? row.calculationRules?.profit ?? directories.defaults.profit, debtSign: 'paid-minus-sale' };
    const calculated = calculateShipment(fields, rules, { historical, allocations: (store.paymentAllocations ?? []).filter(a => a.shipmentId === row.id) });
    row.fields = calculated.fields; row.fields.purchase_unit ??= rules.purchase;
    const canonicalProduct = directories.products.find(p => normalizeName(p.name) === normalizeName(row.product ?? ''));
    if (canonicalProduct) row.product = canonicalProduct.name;
    row.calculationRules = rules; row.calculationWarnings = calculated.warnings;
    for (const role of ['customer','supplier'] as const) {
      const company = companies.find(c => c.id === row[`${role}Id`]);
      if (!row.fields[`${role}_inn`] && company?.inn) row.fields[`${role}_inn`] = company.inn;
    }
    const driver = directories.drivers.find(d => d.id === fields.driver_id);
    const vehicle = directories.vehicles.find(v => v.id === (fields.vehicle_id || driver?.vehicleId));
    if (driver) row.fields.driver_name = driver.name;
    if (vehicle) { row.fields.vehicle_id = vehicle.id; row.fields.vehicle_plate = vehicle.plate; }
    row.liters = numeric(row.fields.quantity_litres); row.revenue = numeric(row.fields.customer_amount); row.cost = numeric(row.fields.purchase_amount);
  }
  validateStoredTrips(shipments);
  // The export groups case/spacing variants of a manager under one source label.
  // Keep the original cell text in fields while using that canonical group in the application.
  const canonicalManagers = new Map(base.managers.map(manager => [normalizeName(manager.label), manager.label]));
  for (const row of shipments) if (row.manager) {
    const key = normalizeName(row.manager);
    if (!canonicalManagers.has(key)) canonicalManagers.set(key, row.manager.trim());
    row.manager = canonicalManagers.get(key)!;
  }
  const companyMap = new Map(companies.map(company => [company.id, company]));
  for (const company of companies) {
    company.roles = [...company.roles];
    company.shipmentIds = []; company.paymentIds = []; company.managerLabels = [];
  }
  for (const row of shipments) {
    for (const role of ['customer', 'supplier', 'carrier'] as const) {
      const company = companyMap.get(row[`${role}Id`] ?? '');
      if (!company) continue;
      if (!company.roles.includes(role)) company.roles.push(role);
      if (!company.shipmentIds.includes(row.id)) company.shipmentIds.push(row.id);
      if (role === 'customer' && row.manager && !company.managerLabels.includes(row.manager)) company.managerLabels.push(row.manager);
    }
  }
  for (const payment of base.payments) {
    const company = companyMap.get(payment.counterpartyId ?? '');
    if (company) {
      company.paymentIds.push(payment.id);
      if (!company.roles.includes('payment_counterparty')) company.roles.push('payment_counterparty');
    }
  }
  const labels = [...new Set(shipments.flatMap(row => row.manager ? [row.manager] : []))].sort();
  const managers = labels.map(label => {
    const rows = shipments.filter(row => row.manager === label);
    return {
      id: base.managers.find(manager => manager.label === label)?.id ?? `manager-${createHash('sha256').update(label).digest('hex').slice(0, 16)}`,
      label, shipmentIds: rows.map(row => row.id), companyIds: companies.filter(company => company.managerLabels.includes(label)).map(company => company.id),
      isUserAccount: false as const, shipmentCount: rows.length, liters: metric(rows.map(row => row.liters)), revenue: metric(rows.map(row => row.revenue)),
    };
  });
  const dates = [...shipments, ...base.payments].flatMap(row => row.date ? [row.date] : []).sort();
  const months = [...new Set(dates.map(date => date.slice(0, 7)))].sort();
  return {
    ...base, companies, shipments, managers, directories,
    provenance: {
      ...base.provenance, dateRange: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
      valueBasis: 'Исторические значения XLSX сохранены. Новые операции рассчитываются автоматически по указанным единицам и подтверждённым правилам. Платежи выписки учитываются только после привязки к операции.',
    },
    overview: { ...base.overview, shipmentCount: shipments.length, companyCount: companies.length, ...totals(shipments), missingShipmentDates: shipments.filter(row => !row.date).length },
    monthly: months.map(month => {
      const rows = shipments.filter(row => row.date?.startsWith(month));
      const payments = base.payments.filter(row => row.date?.startsWith(month));
      return { month, shipmentCount: rows.length, paymentCount: payments.length, ...totals(rows), incoming: metric(payments.map(row => row.incoming)), outgoing: metric(payments.map(row => row.outgoing)) };
    }),
    // Quality is the immutable audit of the source workbook, including original row references.
    quality: base.quality,
  };
}

export function shipmentSettlement(row: Shipment): Exclude<import('../web/src/model').ShipmentSettlement, 'all'> {
  return settlementKind(row.fields.payment_form);
}

export function shipmentPage(snapshot: Snapshot, params: URLSearchParams): ShipmentsResponse & { facetValues?: string[] } {
  const integer = (key: string, fallback: number, max: number) => {
    const raw = params.get(key);
    if (raw === null) return fallback;
    if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw))) throw new ApiError(400, `Некорректный параметр ${key}.`);
    return Math.min(max, Number(raw));
  };
  const limit = Math.max(1, integer('limit', 50, 100));
  const offset = integer('offset', 0, Number.MAX_SAFE_INTEGER);
  const query = normalizeName(params.get('query') ?? '');
  if (query.length > 1000) throw new ApiError(400, 'Поисковый запрос слишком длинный.');
  const period = params.get('period') ?? 'all';
  if (period !== 'all' && !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(period)) throw new ApiError(400, 'Некорректный период.');
  const manager = params.get('manager') ?? 'all';
  const settlement = params.get('settlement') ?? 'all';
  if (!['all', 'cashless', 'cash', 'f2', 'unspecified'].includes(settlement)) throw new ApiError(400, 'Неизвестная форма оплаты.');
  const companyId = params.get('companyId');
  const filters = parseFilters(params);
  const baseRows = snapshot.shipments.filter(row =>
    (period === 'all' || row.date?.startsWith(period)) &&
    (manager === 'all' || (manager === 'none' ? row.manager === null : row.manager !== null && normalizeName(row.manager) === normalizeName(manager))) &&
    (settlement === 'all' || shipmentSettlement(row) === settlement) &&
    (!companyId || row.customerId === companyId || row.supplierId === companyId || row.carrierId === companyId) &&
    (!query || normalizeName([...Object.values(row.fields), row.sourceSheet, row.sourceRow, row.id].join(' ')).includes(query))
  );
  const rows = sortShipments(baseRows.filter(row => Object.entries(filters).every(([key,filter]) => matchesColumn(row,key,filter))), params);
  const facet = params.get('facet');
  if (facet && !shipmentColumns.some(c => c.key === facet)) throw new ApiError(400,'Неизвестная колонка.');
  const facetValues = facet ? [...new Set(baseRows.filter(row => Object.entries(filters).every(([key,filter]) => key === facet || matchesColumn(row,key,filter))).map(row => fieldValue(row,facet) ?? ''))].sort((a,b) => a.localeCompare(b,'ru',{numeric:true})) : undefined;
  const customerRows = new Map<string, Shipment[]>();
  for (const row of rows) if (row.customerId) {
    const values = customerRows.get(row.customerId) ?? [];
    values.push(row); customerRows.set(row.customerId, values);
  }
  const companyById = new Map(snapshot.companies.map(company => [company.id, company]));
  const topCustomers = [...customerRows].map(([id, values]) => ({ id, name: companyById.get(id)?.name ?? values[0].customer ?? id, revenue: metric(values.map(row => row.revenue)).total })).sort((left, right) => {
    if (left.revenue === null) return right.revenue === null ? left.id.localeCompare(right.id) : 1;
    if (right.revenue === null) return -1;
    return new Exact(right.revenue).comparedTo(left.revenue) || left.id.localeCompare(right.id);
  }).slice(0, 4);
  const items = rows.slice(offset, offset + limit);
  return { facetValues, items, total: rows.length, hasMore: offset + items.length < rows.length, nextOffset: Math.min(rows.length, offset + items.length), summary: { ...totals(rows), customerCount: customerRows.size }, topCustomers };
}

/** Recognize only formulas whose references belong to this exact source row. */
export function inferCalculationRules(cells: Record<string, { formula?: string | null }>, row: number): CalculationRules {
  const formula = (col: string) => (cells[`${col}${row}`]?.formula ?? '').replace(/\s/g,'').toUpperCase();
  const saleFormula = formula('L'), purchaseFormula = formula('O'), profitFormula = formula('S');
  const knownProfit = `IF(O${row}>L${row},((O${row}*0.83)-L${row}+Q${row}+R${row})*-1,SUM(L${row}-O${row}-Q${row}-R${row}))`;
  const legacyProfit = `IF(O${row}>L${row},((O${row}*0.83)-L${row}+Q${row})*-1,SUM(L${row}-O${row}-Q${row}-R${row}))`;
  return {
    sale: [`=K${row}*I${row}`,`=I${row}*K${row}`].includes(saleFormula) ? 'litres' : [`=K${row}*H${row}`,`=H${row}*K${row}`].includes(saleFormula) ? 'tonnes' : null,
    purchase: purchaseFormula === `=N${row}*H${row}` ? 'tonnes' : purchaseFormula === `=N${row}*I${row}` ? 'litres' : null,
    profit: profitFormula === `=ROUND(${knownProfit},0)` ? 'excel-rounded' : profitFormula === `=${knownProfit}` ? 'excel-exact' : profitFormula === `=${legacyProfit}` ? 'excel-legacy' : null,
    debtSign: 'paid-minus-sale',
  };
}

export function prepareShipmentFields(input: unknown, previous: Shipment | undefined, snapshot: Snapshot) {
  if (!object(input) || !Object.keys(input).length) throw new ApiError(400,'Укажите поля операции.');
  const data = { ...input }, catalog = snapshot.directories!;
  const automatic = ['days_since_shipment','opening_payment_date', 'opening_paid_amount','document_number','month','customer_inn','supplier_inn','customer_amount','sale_price_per_tonne','purchase_amount','profit_source','paid_amount_source','payment_date','debt_overpayment_source','term_source','overdue_days','kvp_source','unlabelled_note','calculation_mode','profit_rule','vehicle_plate','driver_name','trip_id','trip_total_tonnes','trip_additional_costs'];
  for (const key of automatic) if (Object.hasOwn(data,key)) throw new ApiError(400,`Поле ${key} рассчитывается автоматически или сохранено только для истории.`);
  if (typeof data.customer_id === 'string' && !data.manager_id) {
    const managerId = customerManagerId(catalog, data.customer_id);
    if (managerId && (!previous || data.customer_id !== previous.customerId || Object.hasOwn(data, 'manager_id'))) data.manager_id = managerId;
    else if (previous && data.customer_id !== previous.customerId) throw new ApiError(400, 'Для выбранного клиента укажите менеджера или заполните справочник «Клиенты и менеджеры».');
  }
  for (const role of ['customer','supplier'] as const) {
    const idKey = `${role}_id`, nameKey = `${role}_name`;
    if (Object.hasOwn(data, idKey)) {
      const company = snapshot.companies.find(c => c.id === data[idKey]);
      if (!company) throw new ApiError(400,'Выберите существующего контрагента или поставщика.');
      data[nameKey] = company.name; data[`${role}_inn`] = company.inn ?? null;
    } else if (Object.hasOwn(data,nameKey)) throw new ApiError(400,'Выберите фирму из справочника.');
  }
  for (const [idKey,labelKey,rows] of [['manager_id','manager_label',catalog.managers],['product_id','product',catalog.products],['payment_form_id','payment_form',catalog.paymentForms]] as const) {
    if (Object.hasOwn(data,idKey)) {
      const item = rows.find(r => r.id === data[idKey]);
      if (!item) throw new ApiError(400,`Выберите значение справочника: ${labelKey}.`);
      data[labelKey] = item.name;
    } else if (Object.hasOwn(data,labelKey)) throw new ApiError(400,`Используйте справочник: ${labelKey}.`);
  }
  if (Object.hasOwn(data,'carrier_name') || Object.hasOwn(data,'carrier_id')) throw new ApiError(400,'Выберите водителя из справочника.');
  const changedCompany = (role: 'customer'|'supplier') => Object.hasOwn(data,`${role}_id`) && data[`${role}_id`] !== previous?.[`${role}Id`];
  for (const [key,role,kind] of [['loading_address','supplier','loading'],['unloading_address','customer','delivery']] as const) {
    if (Object.hasOwn(data,key)) throw new ApiError(400,'Выберите адрес из справочника.');
    if (changedCompany(role) && !Object.hasOwn(data,`${key}_id`)) { data[`${key}_id`] = null; data[key] = null; }
    if (data[`${key}_id`]) {
      const address = catalog.addresses.find(a => a.id === data[`${key}_id`]);
      const companyId = data[`${role}_id`] ?? previous?.[`${role}Id`];
      if (!address || address.kind !== kind || address.companyId !== companyId) throw new ApiError(400,'Адрес не принадлежит выбранной компании.');
      data[key] = address.name;
    } else if (Object.hasOwn(data,`${key}_id`)) data[key] = null;
  }
  if (Object.hasOwn(data,'driver_id')) {
    const driver = catalog.drivers.find(d => d.id === data.driver_id);
    if (data.driver_id && !driver) throw new ApiError(400,'Водитель отсутствует в справочнике.');
    data.driver_id = driver?.id ?? null;
    if (data.driver_id !== previous?.fields.driver_id && !Object.hasOwn(data, 'vehicle_id')) data.vehicle_id = driver?.vehicleId ?? null;
  }
  if (Object.hasOwn(data, 'vehicle_id')) {
    const vehicle = catalog.vehicles.find(v => v.id === data.vehicle_id);
    if (data.vehicle_id && !vehicle) throw new ApiError(400, 'Автомобиль отсутствует в справочнике.');
    const driver = catalog.drivers.find(d => d.id === (data.driver_id ?? previous?.fields.driver_id));
    data.vehicle_id = vehicle?.id ?? driver?.vehicleId ?? null;
  }
  const fields = validateShipmentFields(data, previous, snapshot.companies);
  if (!previous || previous.fields.calculation_mode === 'automatic') {
    for (const key of ['date','customer_id','supplier_id','manager_id','product_id','payment_form_id','quantity_litres','quantity_tonnes','sale_price_per_litre','purchase_price_unspecified_unit','purchase_unit']) if (!fields[key]) throw new ApiError(400,`Заполните обязательное поле: ${key}.`);
    fields.calculation_mode = 'automatic';
    fields.profit_rule = TEMPLATE_PROFIT_RULE;
    fields.transport_amount ??= '0'; fields.additional_costs ??= '0';
  }
  if (fields.purchase_unit && !['litres','tonnes'].includes(fields.purchase_unit)) throw new ApiError(400,'Выберите закупочную цену за тонну или за литр.');
  for (const key of ['quantity_litres','quantity_tonnes','sale_price_per_litre','purchase_price_unspecified_unit','transport_amount','additional_costs']) {
    if (Object.hasOwn(data,key) && fields[key] && new Exact(fields[key]).lt(0)) throw new ApiError(400,'Количество, цены и расходы не могут быть отрицательными.');
    if ((!previous || previous.fields.calculation_mode === 'automatic') && ['quantity_litres','quantity_tonnes'].includes(key) && !new Exact(fields[key]!).gt(0)) throw new ApiError(400,'Количество должно быть больше нуля.');
  }
  const historical = !!previous && previous.fields.calculation_mode !== 'automatic';
  const saleChanged = ['quantity_litres','quantity_tonnes','sale_price_per_litre'].some(k => Object.hasOwn(data,k));
  const purchaseChanged = ['quantity_litres','quantity_tonnes','purchase_price_unspecified_unit','purchase_unit'].some(k => Object.hasOwn(data,k));
  const profitChanged = saleChanged || purchaseChanged || ['transport_amount','additional_costs','payment_form_id'].some(k => Object.hasOwn(data,k));
  if (historical && profitChanged) {
    fields.profit_rule = TEMPLATE_PROFIT_RULE;
    fields.additional_costs ??= fields.kvp_source ?? '0';
  }
  const rules: CalculationRules = { sale: historical ? previous.calculationRules?.sale ?? null : 'litres', purchase: fields.purchase_unit as 'litres'|'tonnes' || previous?.calculationRules?.purchase || null, profit: fields.profit_rule as CalculationRules['profit'] || previous?.calculationRules?.profit || catalog.defaults.profit, debtSign:'paid-minus-sale' };
  if (historical && saleChanged && !rules.sale) throw new ApiError(400,'В исходной строке особая формула продажи. Сначала необходимо уточнить её правило.');
  if (historical && purchaseChanged && !rules.purchase) throw new ApiError(400,'Укажите единицу цены закупки для пересчёта этой операции.');
  const result = calculateShipment(fields,rules,{historical,recalculate:!historical || profitChanged,changedFields:Object.keys(data)}).fields;
  // Labels are derived on read; the selected vehicle is a persisted per-shipment override.
  for (const key of ['vehicle_plate','driver_name']) delete result[key];
  return result;
}

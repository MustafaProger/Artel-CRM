import ExcelJS from 'exceljs';
import { availableDirectoryTabs, hasScopedSupplierDirectory, type AccountUser } from '../web/src/auth-model';
import { allVehicleFields, companyFields, driverFields, productTransportFields, vehicleTransportFields } from '../web/src/directory-fields';
import type { Company, DirectoryData, Driver, NamedEntry, OilDepot, OperatorService, Product, ShipmentAddress, Snapshot, Vehicle } from '../web/src/model';
import { readOperatorCatalog } from '../web/src/operator-catalog';
import { validDate } from '../web/src/shipment-calculations';
import { azsShipmentTemplates, fieldValue, shipmentTemplates, type FieldKind } from '../web/src/shipment-templates';
import { descendingDate } from '../web/src/utils';
import { ApiError } from './api-error';

type Cell = string | number | Date | null | undefined;
type Column<Row> = readonly [title: string, value: (row: Row) => Cell];

function fields<Row extends object>(definitions: readonly (readonly [keyof Row, string])[]): Column<Row>[] {
  return definitions.map(([key, title]) => [title, row => row[key] as Cell]);
}

function addSheet<Row>(book: ExcelJS.Workbook, name: string, rows: Iterable<Row>, columns: readonly Column<Row>[]) {
  const sheet = book.addWorksheet(name, { views: [{ state: 'frozen', ySplit: 1 }] });
  sheet.columns = columns.map(([header]) => ({ header, width: Math.max(16, Math.min(48, header.length + 5)) }));
  sheet.getRow(1).font = { bold: true };
  sheet.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: columns.length } };
  for (const row of rows) sheet.addRow(columns.map(([, value]) => value(row))).eachCell(cell => {
    if (cell.value instanceof Date) cell.numFmt = 'dd.mm.yyyy';
  });
}

export async function directoryWorkbook(data: DirectoryData, actor: AccountUser) {
  const book = new ExcelJS.Workbook();
  const catalog = data.directories;
  const tabs = availableDirectoryTabs(actor);
  if (hasScopedSupplierDirectory(data) && !tabs.includes('suppliers')) tabs.push('suppliers');
  const companies = data.companies.filter(row => !row.directoryArchived);
  const nameOfCompany = new Map(companies.map(row => [row.id, row.name]));
  const nameOfManager = new Map(catalog?.managers.map(row => [row.id, row.name]));
  const managerOfCompany = new Map(catalog?.customerManagers?.map(row => [row.companyId, row.managerId]));
  const vehiclePlate = new Map(catalog?.vehicles.map(row => [row.id, row.plate]));
  const depots = catalog?.oilDepots ?? [];
  const companyColumns = fields<Company>([['name', 'Наименование'], ['inn', 'ИНН'], ...companyFields]);

  if (tabs.includes('customers')) addSheet(book, 'Клиенты', companies.filter(row => row.roles.includes('customer')), [
    ...companyColumns, ['Менеджер', row => nameOfManager.get(managerOfCompany.get(row.id) ?? '')],
  ]);
  if (tabs.includes('suppliers')) addSheet(book, 'Поставщики', companies.filter(row => row.roles.includes('supplier')), companyColumns);
  if (tabs.includes('oilDepots')) addSheet(book, 'Нефтебазы', depots, [
    ...fields<OilDepot>([['name', 'Наименование'], ['address', 'Адрес'], ['mapUrl', 'Ссылка на карту'], ['latitude', 'Широта'], ['longitude', 'Долгота']]),
    ['Владелец', row => nameOfCompany.get(row.ownerCompanyId ?? '')],
    ['Организация погрузки', row => nameOfCompany.get(row.loadingActorCompanyId ?? '')],
    ['Владелец инфраструктуры', row => nameOfCompany.get(row.infrastructureOwnerCompanyId ?? '')],
  ]);
  if (tabs.includes('managers')) addSheet(book, 'Сотрудники', catalog?.managers ?? [], fields<NamedEntry>([['name', 'Имя']]));
  if (tabs.includes('products')) addSheet(book, 'Товары', catalog?.products ?? [], fields<Product>([['name', 'Наименование'], ...productTransportFields]));
  if (tabs.includes('vehicles')) addSheet(book, 'Автомобили', catalog?.vehicles ?? [], [
    ...fields<Vehicle>([['plate', 'Госномер'], ['name', 'Наименование'], ['brand', 'Марка'], ['model', 'Модель'], ['trailer', 'Прицеп'], ['capacityLitres', 'Объём, л'], ...allVehicleFields, ...vehicleTransportFields]),
    ['Перевозчик', row => nameOfCompany.get(row.carrierId ?? '')],
    ['Секции, л', row => row.compartmentsLitres?.join(' + ')],
    ['Тарифы за выезд по секциям, ₽', row => row.compartmentDeparturePricesRub?.join(' + ')],
  ]);
  if (tabs.includes('drivers')) addSheet(book, 'Водители', catalog?.drivers ?? [], [
    ...fields<Driver>([['name', 'Имя'], ['phone', 'Телефон'], ...driverFields]),
    ['Автомобиль', row => vehiclePlate.get(row.vehicleId)],
    ['Перевозчик', row => nameOfCompany.get(row.carrierId ?? '')],
  ]);
  if (tabs.includes('addresses')) addSheet(book, 'Места погрузки и доставки', catalog?.addresses ?? [], [
    ...fields<ShipmentAddress>([['name', 'Наименование'], ['address', 'Адрес'], ['mapUrl', 'Ссылка на карту'], ['latitude', 'Широта'], ['longitude', 'Долгота'], ['receiverName', 'Получатель'], ['receiverPhone', 'Телефон получателя']]),
    ['Компания', row => nameOfCompany.get(row.companyId)],
    ['Тип', row => row.kind === 'loading' ? 'Погрузка' : 'Доставка'],
    ['Расстояния до нефтебаз, км', row => depots.filter(depot => row.oilDepotDistancesKm?.[depot.id]).map(depot =>
      `${depot.name}: ${row.oilDepotDistancesKm?.[depot.id]}`).join('\n')],
    ['Дополнительные получатели', row => row.additionalReceivers?.map(({ name, phone }) => [name, phone].filter(Boolean).join(' — ')).join('\n')],
    ['Организация погрузки', row => nameOfCompany.get(row.loadingActorCompanyId ?? '')],
    ['Владелец инфраструктуры', row => nameOfCompany.get(row.infrastructureOwnerCompanyId ?? '')],
  ]);
  if (tabs.includes('operatorServices')) addSheet(book, 'Сервисы операторской', readOperatorCatalog(catalog ?? {}).services,
    fields<OperatorService>([['name', 'Наименование'], ['discountPercent', 'Скидка, %']]));
  if (!book.worksheets.length) throw new ApiError(403, 'Для вашей учётной записи нет доступных справочников.');
  return Buffer.from(await book.xlsx.writeBuffer());
}

export function shipmentExportPeriod(params: URLSearchParams) {
  const from = params.get('from'), to = params.get('to');
  if (!from || !to || from !== validDate(from) || to !== validDate(to) || params.getAll('from').length !== 1 || params.getAll('to').length !== 1) {
    throw new ApiError(400, 'Укажите даты начала и окончания периода.');
  }
  if (from > to) throw new ApiError(400, 'Дата начала должна быть не позже даты окончания.');
  return { from, to };
}

function shipmentCell(value: string | null, kind: FieldKind): Cell {
  if (kind === 'date') {
    const date = validDate(value);
    return date && date >= '1900-01-01' ? new Date(date + 'T00:00:00Z') : value;
  }
  // Keep identifiers and decimals beyond Excel's 15 significant digits as text.
  if (kind === 'number' && value && /^[+-]?\d+(?:\.\d+)?$/.test(value) && value.replace(/[^0-9]/g, '').replace(/^0+/, '').length <= 15) {
    return Number(value);
  }
  return value;
}

export async function shipmentWorkbook(snapshot: Pick<Snapshot, 'shipments'>, { from, to }: ReturnType<typeof shipmentExportPeriod>) {
  const rows = snapshot.shipments.filter(row => row.date && row.date >= from && row.date <= to).sort(descendingDate);
  if (!rows.length) throw new ApiError(404, 'За указанный период нет доступных отгрузок.');
  const book = new ExcelJS.Workbook();
  for (const [type, title, templates] of [
    ['tanker', 'Бензовозы', shipmentTemplates],
    ['azs', 'АЗС', azsShipmentTemplates],
  ] as const) {
    const shipments = rows.filter(row => (row.fields.shipment_type ?? 'tanker') === type);
    for (const template of Object.values(templates)) {
      addSheet(book, `${title} — ${template.title}`, shipments, template.columns.map(column => [
        column.title, row => shipmentCell(fieldValue(row, column.key), column.kind),
      ]));
    }
  }
  return Buffer.from(await book.xlsx.writeBuffer());
}

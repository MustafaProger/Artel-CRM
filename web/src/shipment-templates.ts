import type { Shipment } from './model'

export type TemplateId = 'expanded' | 'standard' | 'reduced'
export type FieldKind = 'text' | 'number' | 'date' | 'company' | 'inn'
export type ColumnGroup = 'operation' | 'sale' | 'purchase' | 'delivery' | 'settlement'
export interface ShipmentColumn { key: string; title: string; group: ColumnGroup; kind: FieldKind; width: number }
const column = (key: string, title: string, group: ColumnGroup, kind: FieldKind = 'text', width = 160): ShipmentColumn => ({ key, title, group, kind, width })
export const shipmentColumns: ShipmentColumn[] = [
  column('document_number', 'УПД', 'operation', 'text', 98),
  column('month', 'Месяц', 'operation', 'text', 132),
  column('date', 'Дата', 'operation', 'date', 114),
  column('customer_name', 'Контрагент', 'operation', 'company', 210),
  column('customer_inn', 'ИНН Контрагент', 'operation', 'inn', 128),
  column('manager_label', 'Менеджер', 'operation', 'text', 114),
  column('payment_form', 'Форма оплаты', 'operation', 'text', 116),
  column('product', 'Товар', 'operation', 'text', 110),
  column('quantity_tonnes', 'Кол-во, т', 'sale', 'number', 130),
  column('quantity_litres', 'Кол-во, л', 'sale', 'number', 145),
  column('sale_price_per_tonne', 'Цена продажи, т', 'sale', 'number', 165),
  column('sale_price_per_litre', 'цена продажи за л', 'sale', 'number', 165),
  column('customer_amount', 'Сумма покупателя', 'sale', 'number', 180),
  column('unloading_address', 'Адрес выгрузки', 'sale', 'text', 260),
  column('supplier_name', 'Поставщик', 'purchase', 'company', 195),
  column('supplier_inn', 'ИНН Поставщика', 'purchase', 'inn', 128),
  column('purchase_price_unspecified_unit', 'Цена закупа', 'purchase', 'number', 145),
  column('purchase_amount', 'Сумма закупки', 'purchase', 'number', 175),
  column('loading_address', 'Адрес загрузки', 'purchase', 'text', 260),
  column('carrier_name', 'Перевозчик / водитель', 'delivery', 'text', 210),
  column('vehicle_plate', 'Автомобиль / госномер', 'delivery', 'text', 180),
  column('transport_amount', 'Сумма перевозки', 'delivery', 'number', 175),
  column('kvp_source', 'КВП', 'delivery', 'number', 140),
  column('additional_costs', 'Доп Затраты', 'delivery', 'number', 160),
  column('costs_breakdown', 'КВП / Допзатраты', 'delivery', 'text', 290),
  column('profit_source', 'Прибыль', 'settlement', 'number', 170),
  column('paid_amount_source', 'Оплата', 'settlement', 'number', 170),
  column('payment_date', 'Дата оплаты', 'settlement', 'date', 145),
  column('debt_overpayment_source', 'Долг/Переплата', 'settlement', 'number', 180),
  column('days_since_shipment', 'Дней с отгрузки', 'settlement', 'number', 175),
  column('unlabelled_note', 'Дата из файла', 'settlement', 'date', 155),
]
/** Separate AZS composition; purchase_amount is the existing supplier purchase total. */
export const azsShipmentColumns: ShipmentColumn[] = [
  column('date', 'Дата', 'operation', 'date', 114),
  column('customer_name', 'Контрагент', 'operation', 'company', 210),
  column('document_number', 'УПД', 'operation', 'text', 98),
  column('month', 'Месяц', 'operation', 'text', 132),
  column('customer_inn', 'ИНН контрагента', 'operation', 'inn', 128),
  column('manager_label', 'Менеджер', 'operation', 'text', 114),
  column('payment_form', 'Форма оплаты', 'operation', 'text', 116),
  column('product', 'Товар', 'operation', 'text', 110),
  column('quantity_litres', 'Количество литров', 'sale', 'number', 138),
  column('customer_amount', 'Сумма покупателя', 'sale', 'number', 162),
  column('purchase_amount', 'Сумма поставщика', 'sale', 'number', 162),
  column('sale_price_per_litre', 'Цена продажи за литр', 'sale', 'number', 146),
  column('supplier_name', 'Поставщик', 'purchase', 'company', 195),
  column('supplier_inn', 'ИНН поставщика', 'purchase', 'inn', 128),
  column('kvp_source', 'КВП', 'settlement', 'number', 112),
  column('profit_source', 'Прибыль', 'settlement', 'number', 145),
  column('paid_amount_source', 'Оплата', 'settlement', 'number', 145),
  column('debt_overpayment_source', 'Долг/переплата', 'settlement', 'number', 160),
  column('days_since_shipment', 'Дней с отгрузки', 'settlement', 'number', 140),
]
const azsSmallKeys = ['date','customer_name','manager_label','payment_form','quantity_litres','customer_amount','purchase_amount','supplier_name','profit_source','paid_amount_source'];
export const azsShipmentTemplates = { medium: { title: 'Средний', columns: azsShipmentColumns }, small: { title: 'Малый', columns: azsSmallKeys.map(key => azsShipmentColumns.find(column => column.key === key)!) } };
const standard = ['date','customer_name','manager_label','payment_form','product','quantity_tonnes','quantity_litres','sale_price_per_tonne','sale_price_per_litre','customer_amount','supplier_name','purchase_price_unspecified_unit','purchase_amount','carrier_name','vehicle_plate','transport_amount','costs_breakdown','profit_source','paid_amount_source','debt_overpayment_source','days_since_shipment']
const reduced = ['date','customer_name','manager_label','product','quantity_litres','customer_amount','supplier_name','purchase_amount','carrier_name','profit_source','days_since_shipment']
export const shipmentTemplates: Record<TemplateId, { title: string; columns: ShipmentColumn[] }> = {
  expanded: { title: 'Расширенный', columns: shipmentColumns.filter(column => !['kvp_source','additional_costs','costs_breakdown'].includes(column.key)).flatMap(column => column.key === 'transport_amount' ? [column, shipmentColumns.find(item => item.key === 'costs_breakdown')!] : [column]) },
  standard: { title: 'Стандарт', columns: standard.map(key => shipmentColumns.find(c => c.key === key)!) },
  reduced: { title: 'Уменьшенный', columns: reduced.map(key => shipmentColumns.find(c => c.key === key)!) },
}
export const groupTitles: Record<ColumnGroup, string> = { operation:'Операция', sale:'Продажа', purchase:'Закупка', delivery:'Доставка и расходы', settlement:'Расчёты' }
export function fieldValue(shipment: Shipment, key: string): string | null {
  if (key === 'costs_breakdown') {
    const kvp = shipment.fields.kvp_source, extra = shipment.fields.additional_costs;
    return kvp == null && extra == null ? null : `КВП: ${kvp ?? '—'} · Допзатраты: ${extra ?? '—'}`;
  }
  if (key === 'date') return shipment.date
  if (key === 'product') return shipment.product
  if (key === 'manager_label') return shipment.manager
  if (key === 'driver_name') return shipment.fields.driver_name || null
  if (key === 'carrier_name') return shipment.fields.driver_name || shipment.fields.carrier_name || shipment.carrier || null
  if (key === 'month') return shipment.date?.slice(0,7) ?? shipment.fields.month ?? null
  if (key === 'payment_date' && shipment.fields[key]) {
    const raw = shipment.fields[key]!
    return /^\d{4}-\d{2}-\d{2}(?:T|$)/.test(raw) ? raw.slice(0,10) : raw
  }
  if (Object.hasOwn(shipment.fields, key)) return shipment.fields[key]
  const fallback: Record<string, string | null> = { date:shipment.date, customer_name:shipment.customer, supplier_name:shipment.supplier, carrier_name:shipment.carrier, manager_label:shipment.manager, product:shipment.product, quantity_litres:shipment.liters, customer_amount:shipment.revenue, purchase_amount:shipment.cost }
  return fallback[key] ?? null
}

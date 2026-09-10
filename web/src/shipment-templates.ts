import type { Shipment } from './model'

export type TemplateId = 'expanded' | 'standard' | 'reduced'
export type FieldKind = 'text' | 'number' | 'date' | 'company' | 'inn'
export type ColumnGroup = 'operation' | 'sale' | 'purchase' | 'delivery' | 'settlement'
export interface ShipmentColumn { key: string; title: string; group: ColumnGroup; kind: FieldKind; width: number }
const column = (key: string, title: string, group: ColumnGroup, kind: FieldKind = 'text', width = 160): ShipmentColumn => ({ key, title, group, kind, width })
export const shipmentColumns: ShipmentColumn[] = [
  column('date', 'Дата', 'operation', 'date', 132),
  column('customer_name', 'Контрагент', 'operation', 'company', 240),
  column('document_number', 'УПД', 'operation', 'text', 110),
  column('month', 'Месяц', 'operation', 'text', 165),
  column('customer_inn', 'ИНН Контрагент', 'operation', 'inn', 150),
  column('manager_label', 'Менеджер', 'operation', 'text', 155),
  column('payment_form', 'Форма оплаты', 'operation', 'text', 150),
  column('product', 'Товар', 'operation', 'text', 155),
  column('quantity_tonnes', 'Кол-во, т', 'sale', 'number', 130),
  column('quantity_litres', 'Кол-во, л', 'sale', 'number', 145),
  column('sale_price_per_tonne', 'Цена продажи, т', 'sale', 'number', 165),
  column('sale_price_per_litre', 'цена продажи за л', 'sale', 'number', 165),
  column('customer_amount', 'Сумма покупателя', 'sale', 'number', 180),
  column('unloading_address', 'Адрес выгрузки', 'sale', 'text', 260),
  column('supplier_name', 'Поставщик', 'purchase', 'company', 220),
  column('supplier_inn', 'ИНН Поставщика', 'purchase', 'inn', 150),
  column('purchase_price_unspecified_unit', 'Цена закупа', 'purchase', 'number', 145),
  column('purchase_unit', 'Единица закупки', 'purchase', 'text', 150),
  column('purchase_amount', 'Сумма закупки', 'purchase', 'number', 175),
  column('loading_address', 'Адрес загрузки', 'purchase', 'text', 260),
  column('carrier_name', 'Перевозчик / водитель', 'delivery', 'text', 210),
  column('vehicle_plate', 'Автомобиль / госномер', 'delivery', 'text', 180),
  column('transport_amount', 'Сумма перевозки', 'delivery', 'number', 175),
  column('kvp_source', 'КВП', 'delivery', 'number', 140),
  column('additional_costs', 'Доп Затраты', 'delivery', 'number', 160),
  column('profit_source', 'Прибыль', 'settlement', 'number', 170),
  column('paid_amount_source', 'Оплата', 'settlement', 'number', 170),
  column('payment_date', 'Дата оплаты', 'settlement', 'date', 145),
  column('debt_overpayment_source', 'Долг/Переплата', 'settlement', 'number', 180),
  column('days_since_shipment', 'Дней с отгрузки', 'settlement', 'number', 175),
  column('unlabelled_note', 'Дата из файла', 'settlement', 'date', 155),
]
const standard = ['date','customer_name','manager_label','payment_form','product','quantity_tonnes','quantity_litres','sale_price_per_tonne','sale_price_per_litre','customer_amount','supplier_name','purchase_price_unspecified_unit','purchase_amount','carrier_name','vehicle_plate','transport_amount','kvp_source','profit_source','paid_amount_source','debt_overpayment_source','days_since_shipment']
const reduced = ['date','customer_name','manager_label','product','quantity_litres','customer_amount','supplier_name','purchase_amount','carrier_name','profit_source','days_since_shipment']
export const shipmentTemplates: Record<TemplateId, { title: string; columns: ShipmentColumn[] }> = {
  expanded: { title: 'Расширенный', columns: shipmentColumns },
  standard: { title: 'Стандарт', columns: standard.map(key => shipmentColumns.find(c => c.key === key)!) },
  reduced: { title: 'Уменьшенный', columns: reduced.map(key => shipmentColumns.find(c => c.key === key)!) },
}
export const groupTitles: Record<ColumnGroup, string> = { operation:'Операция', sale:'Продажа', purchase:'Закупка', delivery:'Доставка и расходы', settlement:'Расчёты' }
export function fieldValue(shipment: Shipment, key: string): string | null {
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

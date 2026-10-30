import assert from 'node:assert/strict'
import test from 'node:test'
import { emptyDirectories } from '../server/directory-operations'
import type { DirectoryData, ShipmentTrip } from '../web/src/model'
import { tripCopyText, tripDriverCopyText } from '../web/src/trip-copy-text'

const data: DirectoryData = {
  companies: ['Комплекс Ойл', 'Ип Киртока', 'ооо спс', 'ао АиФ'].map((name, index) => ({ id: String(index), name, roles: [], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] })),
  directories: { ...emptyDirectories(), products: [{ id: 'product', name: 'ДТ' }], drivers: [{ id: 'driver', name: 'Пётр' }] },
}
const trip: ShipmentTrip = {
  id: 'trip', fields: { date: '2026-10-23', supplier_id: '0', purchase_price_unspecified_unit: '77000', product_id: 'product', driver_id: 'driver' },
  customers: ['4000', '5500', '8000'].map((quantity, i) => ({ id: `delivery-${i}`, version: 1, paidAmount: '0', fields: { customer_id: String(i + 1), quantity_litres: quantity, sale_price_per_litre: ['70', '73', '72'][i], transport_amount: ['8000', '7000', '8000'][i] } })),
}

test('copies the requested multiline format with product and unabridged per-delivery amounts', () => {
  const before = JSON.stringify({ trip, data })
  assert.equal(tripCopyText(trip, data), '23.10\nКомплекс Ойл 77000\nДТ\n4000 л Ип Киртока 70,00\n5500 л ооо спс 73,00\n8000 л ао АиФ 72,00\nПётр 8000+7000+8000')
  assert.equal(JSON.stringify({ trip, data }), before)
})

test('single delivery, decimal precision, zeroes and comma inputs', () => {
  const value = structuredClone(trip)
  value.customers = [value.customers[0]]
  Object.assign(value.customers[0].fields, { quantity_litres: '15048.125', sale_price_per_litre: '69,40', transport_amount: '0' })
  value.fields.purchase_price_unspecified_unit = '78 400,50'
  assert.equal(tripCopyText(value, data), '23.10\nКомплекс Ойл 78400,5\nДТ\n15048,125 л Ип Киртока 69,40\nПётр 0')
})

test('unknown values stay explicit instead of becoming zero or disappearing from the sum', () => {
  const value = structuredClone(trip)
  value.fields = {}
  value.customers[0].fields = { transport_amount: null }
  value.customers[1].fields.transport_amount = 'NaN'
  value.customers[2].fields.transport_amount = '0'
  assert.equal(tripCopyText(value, { companies: [] }), 'Дата не указана\nПоставщик не указан —\nТовар не указан\n— л Контрагент не указан —\n5500 л Контрагент не указан 73,00\n8000 л Контрагент не указан 72,00\nВодитель не указан —+—+0')
})

test('directory line breaks cannot split the message and date does not depend on timezone', () => {
  const value = structuredClone(data)
  value.companies[0].name = ' Комплекс\nОйл\t '
  assert.ok(tripCopyText({ ...trip, fields: { ...trip.fields, date: '2026-10-23T00:00:00+03:00' } }, value).startsWith('23.10\nКомплекс Ойл 77000\nДТ\n'))
})

function driverFixture() {
  const value = structuredClone(trip), directory = structuredClone(data)
  value.fields.oil_depot_id = 'depot'
  directory.directories!.oilDepots = [{ id: 'depot', name: 'ВЛПДС' }]
  directory.companies[0].name = 'ВСК-Трейд'
  directory.companies[1].name = 'Бетон-Крафт'
  directory.companies[2].name = 'джи аш трейд'
  value.customers = value.customers.slice(0, 2)
  directory.directories!.addresses = value.customers.map((row, i) => {
    Object.assign(row.fields, { unloading_address_id: `address-${i}`, unloading_address: `Адрес ${i + 1}`, unloading_map_url: `https://yandex.ru/maps/-/${i ? 'CXbEvClB' : 'CXbEvMOg'}`, quantity_litres: i ? '12000' : '5500' })
    return { id: `address-${i}`, name: `Площадка ${i}`, kind: 'delivery' as const, companyId: String(i + 1), address: 'Позднее изменённый адрес', mapUrl: 'https://yandex.ru/maps/-/different', receiverName: i ? 'Владимир' : '', receiverPhone: i ? '+7 968 757-09-09' : '79919688774' }
  })
  return { value, directory }
}

test('driver message matches destinations, saved links and each site contact, without financial fields', () => {
  const { value, directory } = driverFixture()
  const before = JSON.stringify({ value, directory })
  assert.equal(tripDriverCopyText(value, directory), 'Погрузка на ВЛПДС от ВСК-Трейд\n\nБетон-Крафт 5500 л\nАдрес 1\nhttps://yandex.ru/maps/-/CXbEvMOg\nПриёмщик 79919688774\n\nджи аш трейд 12000 л\nАдрес 2\nhttps://yandex.ru/maps/-/CXbEvClB\nВладимир +7 968 757-09-09')
  assert.equal(JSON.stringify({ value, directory }), before)
})

test('missing driver details are explicit and a mismatched company cannot provide contacts', () => {
  const { value, directory } = driverFixture()
  value.customers = [value.customers[0]]
  directory.directories!.addresses[0].companyId = 'other-customer'
  value.customers[0].fields.unloading_address = null
  value.customers[0].fields.unloading_map_url = null
  const text = tripDriverCopyText(value, directory)
  assert.ok(text.endsWith('Адрес не указан\nСсылка Яндекса не указана\nПриёмщик телефон не указан'))
  assert.ok(!text.includes('79919688774'))
})

test('missing saved links use saved coordinates or an explicitly labelled address search, never a changed directory destination', () => {
  const { value, directory } = driverFixture()
  value.customers = [value.customers[0]]
  const fields = value.customers[0].fields
  fields.unloading_map_url = 'javascript:alert(1)'
  fields.unloading_latitude = '55.75'
  fields.unloading_longitude = '37.61'
  assert.ok(tripDriverCopyText(value, directory).includes('https://yandex.ru/maps/?pt=37.61%2C55.75&z=16'))
  fields.unloading_latitude = fields.unloading_longitude = null
  const text = tripDriverCopyText(value, directory)
  assert.ok(text.includes('Яндекс (поиск адреса): https://yandex.ru/maps/?text='))
  assert.ok(!text.includes('different'))
})

test('legacy destination without saved address uses the matching address directory', () => {
  const { value, directory } = driverFixture()
  value.customers = [value.customers[0]]
  value.customers[0].fields.unloading_address = value.customers[0].fields.unloading_map_url = null
  const text = tripDriverCopyText(value, directory)
  assert.ok(text.includes('Позднее изменённый адрес\nhttps://yandex.ru/maps/-/different\nПриёмщик 79919688774'))
})

 test('driver handoff includes all receiver contacts only for the matched site',()=>{
 const {value,directory}=driverFixture();
 directory.directories!.addresses[0].additionalReceivers=[{name:'Второй приёмщик',phone:'+7 900 111-22-33'}];
 const text=tripDriverCopyText(value,directory);assert.ok(text.includes('Второй приёмщик +7 900 111-22-33'));
 assert.equal(text.split('Второй приёмщик').length-1,1);
 });

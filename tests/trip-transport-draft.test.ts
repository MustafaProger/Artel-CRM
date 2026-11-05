import test from 'node:test'
import assert from 'node:assert/strict'
import type { Directories, ShipmentAddress } from '../web/src/model'
import { changedTransportContext, tripTransportStates, type TransportCustomerDraft } from '../web/src/trip-transport-draft'

const addresses: ShipmentAddress[] = [
  { id: 'full', name: 'Полная машина', companyId: 'a', kind: 'delivery', oilDepotDistancesKm: { depot: '50', second: '100' } },
  { id: 'first', name: 'Первый клиент', companyId: 'a', kind: 'delivery', oilDepotDistancesKm: { depot: '30' } },
  { id: 'last', name: 'Второй клиент', companyId: 'b', kind: 'delivery', oilDepotDistancesKm: { depot: '70' } },
]
const directories: Directories = {
  vehicles: [{ id: 'truck', plate: 'А001АА', compartmentsLitres: ['3000', '4000', '4000'], compartmentDeparturePricesRub: ['3000', '4000', '4000'] }],
  managers: [], products: [], paymentForms: [], drivers: [], addresses, duplicates: [], defaults: { profit: null },
  oilDepots: [{ id: 'depot', name: 'База 1', ownerCompanyId: 'owner' }, { id: 'second', name: 'База 2', ownerCompanyId: 'owner' }],
}
const shared = { vehicle_id: 'truck', oil_depot_id: 'depot' }
const customer = (key = 'a', indexes = [0, 1, 2], litres = '11000', address = 'full'): TransportCustomerDraft => ({ key, pricingLive: true, fields: { customer_id: key, unloading_address_id: address, quantity_litres: litres, transport_pricing_mode: 'auto', transport_section_indexes: JSON.stringify(indexes), transport_amount: '' } })
const state = (row: TransportCustomerDraft, catalog = directories, fields: Record<string, string> = shared) => tripTransportStates(fields, [row], catalog, addresses).get(row.key)!

test('new complete trip derives 15000 without writing the editable draft or inventing sections', () => {
  const row = customer(), before = structuredClone(row)
  assert.equal(state(row).fields.transport_amount, '15000')
  assert.deepEqual(row, before)
  assert.equal(state(customer('a', [])).fields.transport_amount, '')
})

test('each client derives its independently assigned section price and distance', () => {
  const rows = [customer('a', [0, 1], '7000', 'first'), customer('b', [2], '4000', 'last')]
  const states = tripTransportStates(shared, rows, directories, addresses)
  assert.equal(states.get('a')!.fields.transport_amount, '10100')
  assert.equal(states.get('b')!.fields.transport_amount, '8900')
})

test('new auto recalculates selected depot and missing kilometres remain empty', () => {
  assert.equal(state(customer(), directories, { ...shared, oil_depot_id: 'second' }).fields.transport_amount, '17300')
  const missing = state(customer('a', [0, 1], '7000', 'first'), directories, { ...shared, oil_depot_id: 'second' })
  assert.equal(missing.fields.transport_amount, '')
  assert.match(missing.errors.join(' '), /расстояние/)
})

test('manual and historical amounts survive tariff and route changes', () => {
  for (const mode of [undefined, 'manual']) {
    const row: TransportCustomerDraft = { key: 'a', fields: { customer_id: 'a', transport_amount: '4321', ...(mode ? { transport_pricing_mode: mode } : {}) } }
    assert.equal(state(row).fields.transport_amount, '4321')
    assert.equal(state(changedTransportContext(row, true)).fields.transport_amount, '4321')
    assert.equal(state(row).snapshot, null)
  }
})

test('saved auto snapshot preserves exact historic amount when tariffs and distances change', () => {
  const calculated = state(customer())
  const saved: TransportCustomerDraft = { key: 'a', fields: calculated.fields }
  const changed = structuredClone(directories)
  changed.transportPricing = { version: 5, ratePerKmRub: '100', customerSurchargeRub: '9000', rounding: 'ceil100' }
  changed.vehicles[0].compartmentDeparturePricesRub = ['1', '1', '1']
  const frozen = state(saved, changed)
  assert.equal(frozen.frozen, true)
  assert.equal(frozen.fields.transport_amount, '15000')
  assert.equal(frozen.snapshot?.ratePerKmRub, '45')
  const live = state({ ...saved, pricingLive: true }, changed)
  assert.equal(live.fields.transport_amount, '14100')
})

test('changing context of saved auto converts to manual and preserves old amount for review', () => {
  const saved: TransportCustomerDraft = { key: 'a', fields: state(customer()).fields }
  const changed = changedTransportContext(saved, true)
  assert.equal(changed.fields.transport_pricing_mode, 'manual')
  assert.equal(changed.fields.transport_amount, '15000')
  assert.equal(changed.fields.transport_price_snapshot, '')
  assert.equal(changed.fields.transport_section_indexes, '')
  assert.match(changed.pricingNotice!, /Исходные данные изменены/)
})

test('partial sections and shared sections leave automatic amount empty', () => {
  const partial = state(customer('a', [0], '2500'))
  assert.equal(partial.fields.transport_amount, '')
  assert.match(partial.errors.join(' '), /Частичная/)
  const states = tripTransportStates(shared, [customer('a', [2], '4000', 'first'), customer('b', [2], '4000', 'last')], directories, addresses)
  assert.equal(states.get('a')!.fields.transport_amount, '')
  assert.equal(states.get('b')!.fields.transport_amount, '')
  assert.match(states.get('a')!.errors.join(' '), /нескольким доставкам/)
})

test('two stops for same client do not silently charge the per-client surcharge twice', () => {
  const a = customer('a', [0, 1], '7000', 'first'), b = customer('a', [2], '4000', 'full')
  b.key = 'second-row'
  const states = tripTransportStates(shared, [a, b], directories, addresses)
  assert.equal(states.get('a')!.fields.transport_amount, '')
  assert.match(states.get('a')!.errors.join(' '), /Один клиент/)
})

test('same-volume sections retain different manually assigned tariffs by index', () => {
  const changed = structuredClone(directories)
  changed.vehicles[0].compartmentDeparturePricesRub = ['3000', '9000', '4000']
  assert.equal(state(customer('a', [1], '4000', 'first'), changed).fields.transport_amount, '12100')
  assert.equal(state(customer('a', [2], '4000', 'first'), changed).fields.transport_amount, '7100')
})

test('invalid section metadata cannot supply an automatic amount', () => {
  const row = customer()
  row.fields.transport_section_indexes = '[0, 0]'
  assert.equal(state(row).fields.transport_amount, '')
  assert.match(state(row).errors.join(' '), /назначение секций/)
})

test('request address overrides and unknown historical coordinate origins remain manual', () => {
  const row = customer()
  row.pricingLocation = { address: 'Другой адрес' }
  assert.equal(state(row).fields.transport_amount, '')
  assert.match(state(row).errors.join(' '), /Расстояние для этого места/)
  row.pricingLocation = { address: 'Полная машина', latitude: '55', longitude: '37' }
  assert.equal(state(row).fields.transport_amount, '')
  row.pricingLocation.locationSnapshot = { source: 'geocoder' }
  assert.equal(state(row).fields.transport_amount, '15000')
  const historic: TransportCustomerDraft = { key: 'a', pricingLive: true, fields: { ...customer().fields, unloading_address: 'Полная машина', unloading_latitude: '55', unloading_longitude: '37' } }
  assert.equal(state(historic).fields.transport_amount, '')
})

test('frozen saved calculation ignores current address drift until explicitly recalculated', () => {
  const saved: TransportCustomerDraft = { key: 'a', fields: { ...state(customer()).fields, unloading_address: 'Сохранённый старый адрес', unloading_latitude: '55', unloading_longitude: '37' } }
  assert.equal(state(saved).fields.transport_amount, '15000')
  assert.equal(state(saved).errors.length, 0)
  assert.equal(state({ ...saved, pricingLive: true }).fields.transport_amount, '')
})

test('same-ID changed depot location cannot price a route that retains the old loading snapshot', () => {
  const saved: TransportCustomerDraft = { key: 'a', fields: state(customer()).fields }
  const oldRoute = { ...shared, loading_address: 'Старое место погрузки', loading_latitude: '55', loading_longitude: '37' }
  assert.equal(state(saved, directories, oldRoute).fields.transport_amount, '15000')
  const recalculated = state({ ...saved, pricingLive: true }, directories, oldRoute)
  assert.equal(recalculated.fields.transport_amount, '')
  assert.match(recalculated.errors.join(' '), /Сохранённое место погрузки/)
  const newRoute = { ...oldRoute, oil_depot_id: 'second', loading_address: '', loading_latitude: '', loading_longitude: '' }
  assert.equal(state({ ...saved, pricingLive: true }, directories, newRoute).fields.transport_amount, '17300')
})

test('switching saved location away and back still checks immutable route snapshots', () => {
  const row = customer()
  const original = { fields: { ...shared, loading_address: 'Старый адрес нефтебазы' }, customers: [{ ...row, fields: { ...row.fields, unloading_address: 'Старый адрес клиента' } }] }
  const afterToggle = tripTransportStates(shared, [row], directories, addresses, original).get(row.key)!
  assert.equal(afterToggle.fields.transport_amount, '')
  assert.match(afterToggle.errors.join(' '), /Адрес или точка доставки/)
  assert.match(afterToggle.errors.join(' '), /Сохранённое место погрузки/)
})

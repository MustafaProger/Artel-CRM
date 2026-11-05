import assert from 'node:assert/strict';
import test from 'node:test';
import { calculateTransportPrice, readTransportPriceSnapshot, readTransportPricing, readTransportSectionIndexes, validateTransportSectionAssignments } from '../web/src/transport-pricing';
import type { OilDepot, ShipmentAddress, Vehicle } from '../web/src/model';
const vehicle: Vehicle = { id: 'v', plate: 'Тест', compartmentsLitres: ['3000', '4000', '4000'], compartmentDeparturePricesRub: ['3000', '4000', '4000'] };
const oilDepot: OilDepot = { id: 'd', name: 'Нефтебаза', ownerCompanyId: 'supplier' };
const address: ShipmentAddress = { id: 'a', companyId: 'c', name: 'Площадка', kind: 'delivery', oilDepotDistancesKm: { d: '50' } };
const calc = (compartmentIndexes: number[], quantityLitres: string, km = '50', selectedVehicle = vehicle) => calculateTransportPrice({ vehicle: selectedVehicle, oilDepot, address: { ...address, oilDepotDistancesKm: { d: km } }, customerId: 'c', compartmentIndexes, quantityLitres });
test('agreed full truck and distinct client examples use exact prices and single-leg distances', () => {
  for (const [indexes, litres, km, subtotal, total] of [[[0, 1, 2], '11000', '50', '15000', '15000'], [[0, 1], '7000', '30', '10100', '10100'], [[2], '4000', '70', '8900', '8900']] as const) {
    const result = calc([...indexes], litres, km); assert.ok(result.ok); assert.equal(result.snapshot.subtotalRub, subtotal); assert.equal(result.snapshot.totalRub, total); assert.deepEqual(readTransportPriceSnapshot(JSON.stringify(result.snapshot)), result.snapshot);
  }
});
test('round only final client total; half up provisional and ceil are explicit', () => {
  const result = calc([0], '3000', '1'); assert.ok(result.ok); assert.equal(result.snapshot.subtotalRub, '4795'); assert.equal(result.snapshot.totalRub, '4800');
  const half = calc([0], '3000', '0'); assert.ok(half.ok); assert.equal(half.snapshot.totalRub, '4800');
  const nearest = calc([0], '3000', '2.4'); assert.ok(nearest.ok); assert.equal(nearest.snapshot.subtotalRub, '4858'); assert.equal(nearest.snapshot.totalRub, '4900');
  const ceil = calculateTransportPrice({ vehicle, oilDepot, address: { ...address, oilDepotDistancesKm: { d: '1.2' } }, customerId: 'c', compartmentIndexes: [0], quantityLitres: '3000', settings: { ...readTransportPricing(), rounding: 'ceil100' } });
  assert.ok(ceil.ok); assert.equal(ceil.snapshot.subtotalRub, '4804'); assert.equal(ceil.snapshot.totalRub, '4900');
});
test('missing, invalid, partial and unidentified sections never become zero estimates', () => {
  for (const value of [calc([], '3000'), calc([0], '2999'), calc([0, 0], '6000'), calc([8], '3000'), calc([0], '3000', ''), calc([0], '3000', '-1'), calc([0], '3000', '100001'), calc([0], '3000', '30', { ...vehicle, compartmentDeparturePricesRub: undefined }), calc([0], '3000', '30', { ...vehicle, compartmentDeparturePricesRub: ['3000', '4000', '-1'] })]) assert.equal(value.ok, false);
  assert.deepEqual(readTransportSectionIndexes('[2,0]'), [0, 2]); assert.throws(() => readTransportSectionIndexes('[0,0]')); assert.throws(() => readTransportSectionIndexes('[-1]'));
  assert.equal(validateTransportSectionAssignments([{ compartmentIndexes: [0] }, { compartmentIndexes: [0] }]).length, 1);
});
test('saved breakdown checks arithmetic and bounded worst-case 20 sections', () => {
  const result = calculateTransportPrice({ vehicle: { id: 'v', plate: 'X'.repeat(120), compartmentsLitres: Array(20).fill('999999999.999999'), compartmentDeparturePricesRub: Array(20).fill('999999999.99') }, oilDepot, address, customerId: 'c', compartmentIndexes: Array.from({ length: 20 }, (_, index) => index), quantityLitres: '19999999999.99998' });
  assert.ok(result.ok); assert.ok(readTransportPriceSnapshot(JSON.stringify(result.snapshot))); // sum of all twenty supported sections.
  const full = calc(Array.from({ length: 20 }, (_, index) => index), '20', '50', { id: 'v', plate: 'X'.repeat(120), compartmentsLitres: Array(20).fill('1'), compartmentDeparturePricesRub: Array(20).fill('999999999.99') });
  assert.ok(full.ok); const raw = JSON.stringify(full.snapshot); assert.ok(raw.length < 8000); assert.ok(readTransportPriceSnapshot(raw));
  assert.equal(readTransportPriceSnapshot(JSON.stringify({ ...full.snapshot, totalRub: '1' })), null);
  assert.equal(readTransportPriceSnapshot(JSON.stringify({ ...full.snapshot, ratePerKmRub: null })), null);
  assert.equal(readTransportPriceSnapshot('null'), null);
});

import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import test from 'node:test';
import { integrationRuntime } from './helpers/trip-saby-integration';
import { createSnapshotMiddleware } from '../server/local-api';
import { currentSnapshot } from '../server/shipment-operations';
import { OperationsStore } from '../server/operations-store';
import { saveUser } from '../server/auth';
import { calculateTransportPrice, readTransportPricing } from '../web/src/transport-pricing';
import type { ShipmentTrip } from '../web/src/model';
async function fixture(auth = false) {
  const rt = await integrationRuntime(); const token = randomBytes(32).toString('hex'); let userId = '';
  await rt.store.mutate(rt.source, async data => {
    data.directories!.vehicles[0].compartmentsLitres = ['3000', '4000', '4000']; data.directories!.vehicles[0].capacityLitres = '11000'; data.directories!.vehicles[0].compartmentDeparturePricesRub = ['3000', '4000', '4000'];
    data.directories!.addresses.find(row => row.id === 'delivery')!.oilDepotDistancesKm = { depot: '50' };
    data.companies.push({ ...data.companies.find(row => row.id === 'customer')!, id: 'second', inn: '7736050003', name: 'Второй клиент' });
    data.directories!.addresses.push({ id: 'second-address', companyId: 'second', kind: 'delivery', name: 'Вторая площадка', oilDepotDistancesKm: { depot: '70' } });
    if (auth) { const user = await saveUser(data, currentSnapshot(rt.base, data), { name: 'Тест', login: 'pricing-admin', password: randomUUID() }, undefined, true); userId = user.id; data.accounts!.sessions.push({ userId: user.id, hash: createHash('sha256').update(token).digest('hex'), expiresAt: Date.now() + 600000 }); }
    return { changed: true, result: null };
  });
  const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, requireAuthentication: auth, fetcher: async () => { throw new Error('External request forbidden'); } });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); })); await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request = async (path: string, method = 'GET', body?: unknown, cookie = token) => { const response = await fetch(origin + path, { method, headers: { 'Content-Type': 'application/json', ...(cookie ? { Cookie: `artel_session=${cookie}` } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) }); return { status: response.status, body: await response.json() }; };
  const quote = async (indexes = [0, 1, 2], litres = '11000', customerId = 'customer', addressId = 'delivery') => { const snapshot = currentSnapshot(rt.base, await rt.store.read(rt.source)); const result = calculateTransportPrice({ vehicle: snapshot.directories!.vehicles[0], oilDepot: snapshot.directories!.oilDepots![0], address: snapshot.directories!.addresses.find(row => row.id === addressId), customerId, compartmentIndexes: indexes, quantityLitres: litres, settings: readTransportPricing(snapshot.directories!.transportPricing) }); assert.ok(result.ok); return result.snapshot; };
  const input = async (indexes = [0, 1, 2], litres = '11000', customerId = 'customer', addressId = 'delivery') => { const calculated = await quote(indexes, litres, customerId, addressId); return { idempotencyKey: randomUUID(), fields: { organization_id: 'artel', trip_flow_version: 'driver-v1', loading_at: '2026-11-05T12:00', supplier_id: 'supplier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000', driver_id: 'driver', vehicle_id: 'vehicle', additional_costs: '0' }, customers: [{ fields: { customer_id: customerId, manager_id: 'manager', payment_form_id: 'payment', quantity_litres: litres, sale_price_per_litre: '60', transport_amount: calculated.totalRub, unloading_address_id: addressId, transport_pricing_mode: 'auto', transport_section_indexes: JSON.stringify(indexes), transport_price_snapshot: JSON.stringify(calculated) } }] }; };
  const patch = (trip: ShipmentTrip) => ({ fields: Object.fromEntries(Object.entries(trip.fields).filter(([key]) => !['quantity_tonnes', 'quantity_gross_tonnes', 'loading_actual_at', 'loading_address', 'loading_map_url', 'loading_latitude', 'loading_longitude'].includes(key))), customers: trip.customers.map(row => ({ id: row.id, fields: Object.fromEntries(Object.entries(row.fields).filter(([key]) => !['quantity_tonnes', 'quantity_gross_tonnes', 'unloading_actual_at', 'unloading_address', 'unloading_map_url', 'unloading_latitude', 'unloading_longitude', 'source_request_id'].includes(key))) })), versions: Object.fromEntries(trip.customers.map(row => [row.id, row.version])) });
  return { ...rt, request, input, quote, patch, userId, close: async () => { await new Promise<void>(done => server.close(() => done())); await rt.close(); } };
}
test('automatic snapshot survives save/reload, changed directory tariffs, idempotent replay and unrelated edit', async () => {
  const f = await fixture(); try {
    const body = await f.input(); const created = await f.request('/api/shipment-trips', 'POST', body); assert.equal(created.status, 201, JSON.stringify(created.body));
    const original = created.body.trip as ShipmentTrip; assert.equal(original.customers[0].fields.transport_amount, '15000');
    assert.equal((await f.request('/api/transport-pricing', 'PATCH', { version: 0, ratePerKmRub: '90', customerSurchargeRub: '2000', rounding: 'ceil100' })).status, 200);
    const repeated = await f.request('/api/shipment-trips', 'POST', body); assert.equal(repeated.status, 201); assert.deepEqual(repeated.body.trip, original);
    const edit = f.patch(original); edit.fields.trip_notes = 'Комментарий'; const saved = await f.request('/api/shipment-trips/' + original.id, 'PATCH', edit); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.trip.customers[0].fields.transport_price_snapshot, original.customers[0].fields.transport_price_snapshot);
    const reload = currentSnapshot(f.base, await new OperationsStore(f.directory + '/store').read(f.source)); assert.equal(reload.shipments.find(row => row.id === original.customers[0].id)!.fields.transport_amount, '15000');
    const recalc = f.patch(saved.body.trip); const quote = await f.quote(); recalc.customers[0].fields.transport_price_snapshot = JSON.stringify(quote); recalc.customers[0].fields.transport_amount = quote.totalRub;
    const changed = await f.request('/api/shipment-trips/' + original.id, 'PATCH', recalc); assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.trip.customers[0].fields.transport_amount, '17500');
  } finally { await f.close(); }
});
test('server rejects forged/stale quotes, missing or shared sections and duplicate clients without writes; manual remains available', async () => {
  const f = await fixture(); try {
    const before = await f.store.read(f.source);
    for (const kind of ['amount', 'snapshot', 'partial', 'missing', 'shared', 'same-client']) {
      const body = await f.input();
      if (kind === 'amount') body.customers[0].fields.transport_amount = '1';
      if (kind === 'snapshot') body.customers[0].fields.transport_price_snapshot = JSON.stringify({ ...await f.quote(), totalRub: '1' });
      if (kind === 'partial') body.customers[0].fields.quantity_litres = '10000';
      if (kind === 'missing') body.customers[0].fields.transport_section_indexes = '[]';
      if (kind === 'shared') { const other = await f.input([2], '4000', 'second', 'second-address'); body.customers.push(other.customers[0]); }
      if (kind === 'same-client') { const other = await f.input([2], '4000'); body.customers[0] = (await f.input([0, 1], '7000')).customers[0]; body.customers.push(other.customers[0]); }
      const response = await f.request('/api/shipment-trips', 'POST', body); assert.ok([400, 409].includes(response.status), kind + JSON.stringify(response));
    }
    assert.deepEqual(await f.store.read(f.source), before);
    const stale = await f.input(); await f.request('/api/transport-pricing', 'PATCH', { ...readTransportPricing(), ratePerKmRub: '46' }); assert.equal((await f.request('/api/shipment-trips', 'POST', stale)).status, 409);
    const manual = await f.input(); manual.customers[0].fields.transport_pricing_mode = 'manual'; manual.customers[0].fields.transport_price_snapshot = ''; manual.customers[0].fields.transport_section_indexes = ''; manual.customers[0].fields.transport_amount = '12345'; manual.customers[0].fields.quantity_litres = '10000'; assert.equal((await f.request('/api/shipment-trips', 'POST', manual)).status, 201);
  } finally { await f.close(); }
});
test('two clients charge assigned sections once and persist separate distances', async () => {
  const f = await fixture(); try {
    await f.store.mutate(f.source, data => { data.directories!.addresses.find(row => row.id === 'delivery')!.oilDepotDistancesKm = { depot: '30' }; return { changed: true, result: null }; });
    const body = await f.input([0, 1], '7000'); body.customers.push((await f.input([2], '4000', 'second', 'second-address')).customers[0]);
    const saved = await f.request('/api/shipment-trips', 'POST', body); assert.equal(saved.status, 201, JSON.stringify(saved.body)); assert.deepEqual(saved.body.trip.customers.map((row: { fields: Record<string, string> }) => row.fields.transport_amount), ['10100', '8900']);
  } finally { await f.close(); }
});
test('vehicle tariff CRUD validates count/money and legacy edits preserve prices; clear is explicit', async () => {
  const f = await fixture(); try {
    const initial = await f.store.read(f.source); const original = initial.directories!.vehicles[0];
    const edit = { version: 0, plate: original.plate, capacityLitres: original.capacityLitres, compartmentsLitres: original.compartmentsLitres };
    for (const values of [['1'], ['1', '', '3'], ['1', '-2', '3'], ['1', '1e2', '3'], ['1', '2.001', '3']]) assert.equal((await f.request('/api/directories/vehicles/vehicle', 'PATCH', { ...edit, compartmentDeparturePricesRub: values })).status, 400);
    assert.deepEqual(await f.store.read(f.source), initial);
    const legacy = await f.request('/api/directories/vehicles/vehicle', 'PATCH', edit); assert.equal(legacy.status, 200); assert.deepEqual(legacy.body.entry.compartmentDeparturePricesRub, ['3000', '4000', '4000']);
    const clear = await f.request('/api/directories/vehicles/vehicle', 'PATCH', { ...edit, version: 1, compartmentDeparturePricesRub: [] }); assert.equal(clear.status, 200, JSON.stringify(clear.body)); assert.equal(clear.body.entry.compartmentDeparturePricesRub, undefined);
    assert.equal((await f.request('/api/directories', 'POST', { kind: 'vehicles', plate: 'TEST1234', compartmentsLitres: ['10', '20'], compartmentDeparturePricesRub: ['3700', '5000'] })).status, 201);
  } finally { await f.close(); }
});
test('settings enforce vehicles grant, section, optimistic version and preserve unrelated store', async () => {
  const f = await fixture(true); try {
    const body = readTransportPricing(); assert.equal((await f.request('/api/transport-pricing', 'PATCH', body, '')).status, 401);
    const before = await f.store.read(f.source); const saved = await f.request('/api/transport-pricing', 'PATCH', body); assert.equal(saved.status, 200, JSON.stringify(saved.body)); assert.equal(saved.body.transportPricing.version, 1);
    const after = await f.store.read(f.source); delete after.directories!.transportPricing; after.revision = before.revision; assert.deepEqual(after, before);
    assert.equal((await f.request('/api/transport-pricing', 'PATCH', body)).status, 409);
    for (const invalid of [{ ...body, version: 1, ratePerKmRub: '-1' }, { ...body, version: 1, rounding: 'floor100' }, { ...body, version: 1, extra: true }]) assert.equal((await f.request('/api/transport-pricing', 'PATCH', invalid)).status, 400);
    await f.store.mutate(f.source, data => { const original = data.accounts!.users.find(row => row.id === f.userId)!; data.accounts!.users.push({ ...original, id: 'other-admin', login: 'other-admin' }); Object.assign(original, { role: 'employee', managerId: 'manager', sections: ['directories', 'trips'], directoryGrants: [] }); return { changed: true, result: null }; });
    assert.equal((await f.request('/api/transport-pricing', 'PATCH', { ...body, version: 1 })).status, 403);
    await f.store.mutate(f.source, data => { data.accounts!.users.find(row => row.id === f.userId)!.directoryGrants = ['vehicles']; return { changed: true, result: null }; });
    assert.equal((await f.request('/api/transport-pricing', 'PATCH', { ...body, version: 1 })).status, 200);
    await f.store.mutate(f.source, data => { data.accounts!.users.find(row => row.id === f.userId)!.sections = ['trips']; return { changed: true, result: null }; });
    assert.equal((await f.request('/api/transport-pricing', 'PATCH', { ...body, version: 2 })).status, 403);
    const scoped = await f.request('/api/snapshot'); assert.equal(scoped.status, 200); assert.deepEqual(scoped.body.directories.vehicles[0].compartmentDeparturePricesRub, ['3000', '4000', '4000']);
  } finally { await f.close(); }
});
test('old clients preserve snapshots only for unchanged inputs; manual and legacy amounts never reprice', async () => {
  const f = await fixture(); try {
    const created = await f.request('/api/shipment-trips', 'POST', await f.input()); assert.equal(created.status, 201);
    const original = created.body.trip as ShipmentTrip;
    await f.request('/api/transport-pricing', 'PATCH', { ...readTransportPricing(), ratePerKmRub: '90' });
    const edit = f.patch(original); for (const key of ['transport_pricing_mode', 'transport_section_indexes', 'transport_price_snapshot']) delete edit.customers[0].fields[key]; edit.fields.trip_notes = 'Старый клиент';
    const retained = await f.request('/api/shipment-trips/' + original.id, 'PATCH', edit); assert.equal(retained.status, 200); assert.equal(retained.body.trip.customers[0].fields.transport_price_snapshot, original.customers[0].fields.transport_price_snapshot);
    const manual = f.patch(retained.body.trip); for (const key of ['transport_pricing_mode', 'transport_section_indexes', 'transport_price_snapshot']) delete manual.customers[0].fields[key]; manual.customers[0].fields.transport_amount = '12345';
    const changed = await f.request('/api/shipment-trips/' + original.id, 'PATCH', manual); assert.equal(changed.status, 200, JSON.stringify(changed.body)); assert.equal(changed.body.trip.customers[0].fields.transport_pricing_mode, 'manual'); assert.equal(changed.body.trip.customers[0].fields.transport_price_snapshot, null); assert.equal(changed.body.trip.customers[0].fields.transport_amount, '12345');
    const legacy = f.patch(f.trip); legacy.fields.quantity_tonnes = f.trip.fields.quantity_tonnes; const originalValues = f.trip.customers.map(row => row.fields.transport_amount);
    const savedLegacy = await f.request('/api/shipment-trips/' + f.trip.id, 'PATCH', legacy); assert.equal(savedLegacy.status, 200, JSON.stringify(savedLegacy.body)); assert.deepEqual(savedLegacy.body.trip.customers.map((row: { fields: Record<string, string> }) => row.fields.transport_amount), originalValues);
    const before = await f.store.read(f.source); const spoof = await f.request('/api/shipments/' + original.customers[0].id, 'PATCH', { version: changed.body.trip.customers[0].version, fields: { transport_pricing_mode: 'auto', transport_price_snapshot: original.customers[0].fields.transport_price_snapshot } }); assert.ok([400, 409].includes(spoof.status)); assert.deepEqual(await f.store.read(f.source), before);
  } finally { await f.close(); }
});
test('preserved auto row also rejects a duplicate customer added by a legacy client', async () => {
  const f = await fixture(); try {
    const created = await f.request('/api/shipment-trips', 'POST', await f.input([0, 1], '7000')); assert.equal(created.status, 201);
    const edit = f.patch(created.body.trip); for (const key of ['transport_pricing_mode', 'transport_section_indexes', 'transport_price_snapshot']) delete edit.customers[0].fields[key];
    const other = (await f.input([2], '4000')).customers[0]; other.fields.transport_pricing_mode = 'manual'; other.fields.transport_price_snapshot = '';
    const response = await f.request('/api/shipment-trips/' + created.body.trip.id, 'PATCH', { ...edit, customers: [...edit.customers, other] }); assert.equal(response.status, 400); assert.match(response.body.error, /клиент/);
  } finally { await f.close(); }
});
test('changed vehicle/depot/address and missing distance require a new valid quote, never catalog guesses', async () => {
  const f = await fixture(); try {
    const stale = await f.input(); await f.store.mutate(f.source, data => { delete data.directories!.addresses.find(row => row.id === 'delivery')!.oilDepotDistancesKm; return { changed: true, result: null }; });
    assert.equal((await f.request('/api/shipment-trips', 'POST', stale)).status, 400);
    await f.store.mutate(f.source, data => { data.directories!.addresses.find(row => row.id === 'delivery')!.oilDepotDistancesKm = { depot: '40' }; return { changed: true, result: null }; });
    assert.equal((await f.request('/api/shipment-trips', 'POST', stale)).status, 409);
    const correct = await f.input(); assert.equal(correct.customers[0].fields.transport_amount, '14600');
    for (const [key, value] of [['vehicle_id', 'unknown'], ['oil_depot_id', 'unknown']] as const) { const body = structuredClone(correct); body.fields[key] = value; assert.equal((await f.request('/api/shipment-trips', 'POST', body)).status, 400); }
    const wrongAddress = structuredClone(correct); wrongAddress.customers[0].fields.unloading_address_id = 'second-address'; assert.equal((await f.request('/api/shipment-trips', 'POST', wrongAddress)).status, 400);
  } finally { await f.close(); }
});
test('request-specific changed address or explicit point cannot reuse directory kilometres; shared lookup includes only distance inputs', async () => {
  const f = await fixture(); try {
    const catalog = await f.request('/api/trip-requests'); assert.equal(catalog.status, 200); assert.deepEqual(catalog.body.addresses.find((row: { id: string }) => row.id === 'delivery').oilDepotDistancesKm, { depot: '50' });
    for (const overrides of [{ address: 'Другой фактический адрес' }, { latitude: '55.5', longitude: '37.5' }]) {
      const request = await f.request('/api/trip-requests', 'POST', { companyId: 'customer', addressId: 'delivery', quantityLitres: '11000', salePricePerLitre: '60', idempotencyKey: randomUUID(), ...overrides }); assert.equal(request.status, 201, JSON.stringify(request.body));
      const body = await f.input(); const customer = { ...body.customers[0], sourceRequestId: request.body.request.id, sourceRequestVersion: request.body.request.version };
      const rejected = await f.request('/api/shipment-trips', 'POST', { ...body, customers: [customer] }); assert.equal(rejected.status, 400); assert.match(rejected.body.error, /расстояни/);
      customer.fields.transport_pricing_mode = 'manual'; customer.fields.transport_price_snapshot = ''; customer.fields.transport_amount = '16000'; assert.equal((await f.request('/api/shipment-trips', 'POST', { ...body, customers: [customer] })).status, 201);
    }
  } finally { await f.close(); }
});
test('saved auto quotes survive changed section directory and manual blanks cannot create zero charges', async () => {
  const f = await fixture(); try {
    const created = await f.request('/api/shipment-trips', 'POST', await f.input()); assert.equal(created.status, 201);
    await f.store.mutate(f.source, data => { Object.assign(data.directories!.vehicles[0], { compartmentsLitres: ['11000'], compartmentDeparturePricesRub: ['20000'] }); return { changed: true, result: null }; });
    const unchanged = await f.request('/api/shipment-trips/' + created.body.trip.id, 'PATCH', f.patch(created.body.trip)); assert.equal(unchanged.status, 200, JSON.stringify(unchanged.body)); assert.equal(unchanged.body.trip.customers[0].fields.transport_price_snapshot, created.body.trip.customers[0].fields.transport_price_snapshot);
    const blank = f.patch(unchanged.body.trip); Object.assign(blank.customers[0].fields, { transport_pricing_mode: 'manual', transport_price_snapshot: null, transport_section_indexes: null, transport_amount: null });
    const rejected = await f.request('/api/shipment-trips/' + created.body.trip.id, 'PATCH', blank); assert.equal(rejected.status, 400); assert.match(rejected.body.error, /Пустая/);
    const direct = await f.request('/api/shipments', 'POST', { fields: { transport_pricing_mode: 'auto', transport_price_snapshot: created.body.trip.customers[0].fields.transport_price_snapshot } }); assert.equal(direct.status, 400);
  } finally { await f.close(); }
});
test('historical manual assignments survive changed vehicle section structure while new assignments validate', async () => {
  const f = await fixture(); try {
    const created = await f.request('/api/shipment-trips', 'POST', await f.input()); assert.equal(created.status, 201);
    await f.store.mutate(f.source, data => { Object.assign(data.directories!.vehicles[0], { compartmentsLitres: ['11000'], compartmentDeparturePricesRub: ['20000'] }); return { changed: true, result: null }; });
    const manual = f.patch(created.body.trip); Object.assign(manual.customers[0].fields, { transport_pricing_mode: 'manual', transport_price_snapshot: null, transport_amount: '12345' });
    const overridden = await f.request('/api/shipment-trips/' + created.body.trip.id, 'PATCH', manual); assert.equal(overridden.status, 200, JSON.stringify(overridden.body));
    assert.equal(overridden.body.trip.customers[0].fields.transport_section_indexes, '[0,1,2]'); assert.equal(overridden.body.trip.customers[0].fields.transport_amount, '12345');
    const note = f.patch(overridden.body.trip); note.fields.trip_notes = 'Только комментарий';
    const saved = await f.request('/api/shipment-trips/' + created.body.trip.id, 'PATCH', note); assert.equal(saved.status, 200, JSON.stringify(saved.body));
    assert.equal(saved.body.trip.customers[0].fields.transport_section_indexes, '[0,1,2]'); assert.equal(saved.body.trip.customers[0].fields.transport_amount, '12345');
    const reassigned = f.patch(saved.body.trip); reassigned.customers[0].fields.transport_section_indexes = '[0,1]';
    const before = await f.store.read(f.source); assert.equal((await f.request('/api/shipment-trips/' + created.body.trip.id, 'PATCH', reassigned)).status, 400); assert.deepEqual(await f.store.read(f.source), before);
  } finally { await f.close(); }
});
test('fresh calculations cannot replace a frozen direct-trip destination or depot with a changed same-ID catalog location', async () => {
  for (const changedLocation of ['delivery-address', 'delivery-point', 'depot-address', 'depot-point']) {
    const f = await fixture(); try {
      await f.store.mutate(f.source, data => {
        Object.assign(data.directories!.addresses.find(row => row.id === 'delivery')!, { latitude: '55.1', longitude: '37.1' });
        Object.assign(data.directories!.oilDepots![0], { latitude: '55.2', longitude: '37.2' });
        return { changed: true, result: null };
      });
      const created = await f.request('/api/shipment-trips', 'POST', await f.input()); assert.equal(created.status, 201); const original = created.body.trip as ShipmentTrip;
      assert.equal(original.customers[0].fields.source_request_id, null);
      await f.store.mutate(f.source, data => {
        const address = data.directories!.addresses.find(row => row.id === 'delivery')!;
        address.oilDepotDistancesKm = { depot: '70' };
        if (changedLocation === 'delivery-address') address.address = 'Новый адрес той же записи';
        if (changedLocation === 'delivery-point') Object.assign(address, { latitude: '55.3', longitude: '37.3' });
        if (changedLocation === 'depot-address') data.directories!.oilDepots![0].address = 'Новый адрес нефтебазы';
        if (changedLocation === 'depot-point') Object.assign(data.directories!.oilDepots![0], { latitude: '55.4', longitude: '37.4' });
        return { changed: true, result: null };
      });
      const unchanged = f.patch(original); unchanged.fields.trip_notes = 'Сохранить прежний расчёт';
      const retained = await f.request('/api/shipment-trips/' + original.id, 'PATCH', unchanged); assert.equal(retained.status, 200, JSON.stringify(retained.body));
      assert.equal(retained.body.trip.customers[0].fields.transport_price_snapshot, original.customers[0].fields.transport_price_snapshot);
      const quote = await f.quote(); const recalc = f.patch(retained.body.trip);
      Object.assign(recalc.customers[0].fields, { transport_amount: quote.totalRub, transport_price_snapshot: JSON.stringify(quote) });
      const before = await f.store.read(f.source); const rejected = await f.request('/api/shipment-trips/' + original.id, 'PATCH', recalc);
      assert.equal(rejected.status, 400, changedLocation + JSON.stringify(rejected.body)); assert.match(rejected.body.error, /расстояни/); assert.deepEqual(await f.store.read(f.source), before);
      Object.assign(recalc.customers[0].fields, { transport_pricing_mode: 'manual', transport_price_snapshot: null, transport_amount: '12345' });
      const manual = await f.request('/api/shipment-trips/' + original.id, 'PATCH', recalc); assert.equal(manual.status, 200, JSON.stringify(manual.body));
      assert.equal(manual.body.trip.customers[0].fields.unloading_address, original.customers[0].fields.unloading_address); assert.equal(manual.body.trip.fields.loading_address, original.fields.loading_address);
    } finally { await f.close(); }
  }
});
test('legacy metadata normalization cannot hide overlap with the final stored manual assignment', async () => {
  const f = await fixture(); try {
    const body = await f.input([1], '4000'); const other = (await f.input([0], '3000', 'second', 'second-address')).customers[0];
    Object.assign(other.fields, { transport_pricing_mode: 'manual', transport_price_snapshot: '', transport_amount: '1234' }); body.customers.push(other);
    const created = await f.request('/api/shipment-trips', 'POST', body); assert.equal(created.status, 201, JSON.stringify(created.body));
    const edit = f.patch(created.body.trip); const quote = await f.quote([0], '3000');
    Object.assign(edit.customers[0].fields, { transport_section_indexes: '[0]', quantity_litres: '3000', transport_price_snapshot: JSON.stringify(quote), transport_amount: quote.totalRub });
    delete edit.customers[1].fields.transport_pricing_mode; delete edit.customers[1].fields.transport_price_snapshot;
    edit.customers[1].fields.transport_section_indexes = '[2]'; // Resolved by the legacy branch back to its saved [0].
    const before = await f.store.read(f.source); const rejected = await f.request('/api/shipment-trips/' + created.body.trip.id, 'PATCH', edit);
    assert.equal(rejected.status, 400, JSON.stringify(rejected.body)); assert.match(rejected.body.error, /Секция назначена/); assert.deepEqual(await f.store.read(f.source), before);
  } finally { await f.close(); }
});

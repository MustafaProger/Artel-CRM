import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentSnapshot } from '../server/shipment-operations';
import { serializeSabyTransportOrder } from '../server/saby-transport-order';
import { integrationConfig, integrationRuntime } from './helpers/trip-saby-integration';

test('oil depot roles are independent and never fall back to supplier addresses or private address mappings', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const site = source.directories!.oilDepots!.find(row => row.id === 'depot')!;
    site.loadingActorCompanyId = 'customer'; site.infrastructureOwnerCompanyId = 'carrier';
    const vehicle = source.directories!.vehicles.find(row => row.id === 'vehicle')!; vehicle.cargoDistributable = '0';
    const prepared = runtime.prepare(source, data, runtime.trip, integrationConfig());
    assert.equal(prepared.deliveries[0].snapshot.profile.loadingActor.party.inn, source.companies.find(row => row.id === 'customer')!.inn);
    assert.equal(prepared.deliveries[0].snapshot.profile.infrastructureOwner.party.inn, source.companies.find(row => row.id === 'carrier')!.inn);
    assert.equal(prepared.order.fields.loading_address, site.address);
    assert.equal(prepared.order.fields.loading_site_owner_address, source.companies.find(row => row.id === 'supplier')!.address);
    assert.equal(prepared.order.profile!.cargoByProductId.product.distributable, '0');
    assert.equal(prepared.order.fields.organization_id, runtime.trip.fields.organization_id);
    delete site.loadingActorCompanyId; delete site.infrastructureOwnerCompanyId;
    const missing = runtime.prepare(source, data, runtime.trip, integrationConfig());
    assert.equal(missing.deliveries[0].snapshot.profile.loadingActor.party.inn, '');
    assert.equal(missing.deliveries[0].snapshot.profile.infrastructureOwner.party.inn, '');
    assert.ok(missing.blockers.some(message => /осуществляющее погрузку/.test(message)));
    assert.ok(missing.blockers.some(message => /инфраструктуры/.test(message)));
    assert.equal(missing.order.fields.loading_site_owner_address, prepared.order.fields.loading_site_owner_address);
  } finally { await runtime.close(); }
});

test('filled transport fields need no source reconfirmation; owner legal and site physical addresses remain separate in XML', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    delete source.directories!.vehicles[0].payloadSource;
    const prepared = runtime.prepare(source, data, runtime.trip, integrationConfig());
    assert.deepEqual(prepared.blockers, []);
    const xml = new TextDecoder('windows-1251').decode(serializeSabyTransportOrder(prepared.order, '00000000-0000-4000-8000-000000000000', '2025-04-01T10:00:00Z').xml);
    assert.match(xml, /Синтетическая погрузка/);
    assert.match(xml, /Юридический адрес владельца нефтебазы/);
    assert.match(xml, /Синтетический юридический адрес/);
    delete source.directories!.vehicles[0].payloadTonnes;
    assert.ok(runtime.prepare(source, data, runtime.trip, integrationConfig()).blockers.some(message => /грузоподъёмность/i.test(message)));
  } finally { await runtime.close(); }
});

test('preflight rejects another carrier and preserves missing times instead of inventing 09:00', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const prepared = runtime.prepare(source, data, { ...runtime.trip, fields: { ...runtime.trip.fields, carrier_id: 'supplier', loading_planned_at: '2025-04-01' }, customers: runtime.trip.customers.map(row => ({ ...row, fields: { ...row.fields, unloading_planned_at: '2025-04-01' } })) }, integrationConfig());
    assert.ok(prepared.blockers.some(message => /перевозчик не соответствует/.test(message)));
    assert.equal(prepared.order.fields.loading_planned_at, '2025-04-01');
    assert.equal(prepared.deliveries[0].snapshot.fields.unloading_planned_at, '2025-04-01');
    assert.ok(prepared.blockers.some(message => /время/.test(message)));
  } finally { await runtime.close(); }
});

test('later oil depot edits do not replace the saved trip physical loading address', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    source.directories!.oilDepots![0].address = 'Изменённый адрес нефтебазы';
    const prepared = runtime.prepare(source, data, runtime.trip, integrationConfig());
    assert.equal(prepared.order.fields.loading_address, runtime.trip.fields.loading_address);
    assert.notEqual(prepared.order.fields.loading_address, source.directories!.oilDepots![0].address);
  } finally { await runtime.close(); }
});


test('ordinary driver-based trip uses configured legal carrier without requiring a company selection', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const trip = structuredClone(runtime.trip); delete trip.fields.carrier_id;
    delete source.directories!.drivers[0].carrierId; delete source.directories!.vehicles[0].carrierId;
    const before = structuredClone(trip);
    const prepared = runtime.prepare(source, data, trip, integrationConfig());
    assert.deepEqual(prepared.blockers, []);
    assert.equal(prepared.order.carrierOrganization.inn, integrationConfig().carrier.inn);
    assert.equal(prepared.order.carrierOrganization.name, integrationConfig().carrier.name);
    assert.notEqual(prepared.order.carrierOrganization.name, prepared.order.driver.name);
    assert.equal(prepared.deliveries[0].snapshot.carrierOrganization.inn, integrationConfig().carrier.inn);
    assert.deepEqual(trip, before);
    assert.equal(trip.fields.carrier_id, undefined);
  } finally { await runtime.close(); }
});

test('known fleet company links inconsistent with configured Saby carrier block sending without rewriting the legal carrier', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const trip = structuredClone(runtime.trip); delete trip.fields.carrier_id;
    source.directories!.drivers[0].carrierId = 'supplier';
    const prepared = runtime.prepare(source, data, trip, integrationConfig());
    assert.ok(prepared.blockers.some(message => /карточке водителя указан перевозчик/.test(message)));
    assert.equal(prepared.order.carrierOrganization.inn, integrationConfig().carrier.inn);
    assert.equal(trip.fields.carrier_id, undefined);
    source.directories!.drivers[0].carrierId = 'carrier';
    source.directories!.vehicles[0].carrierId = 'supplier';
    assert.ok(runtime.prepare(source, data, trip, integrationConfig()).blockers.some(message => /карточке автомобиля указан перевозчик/.test(message)));
  } finally { await runtime.close(); }
});


test('agreed maximum is accepted in tonnes; unconverted kilograms are blocked in new orders', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const vehicle = source.directories!.vehicles.find(row => row.id === 'vehicle')!;
    vehicle.maxWeight = '27900';
    for (const value of ['27900', '28']) {
      vehicle.payloadTonnes = value;
      assert.ok(runtime.prepare(source, data, runtime.trip, integrationConfig()).blockers.some(message => /Проверьте единицы/.test(message)));
      assert.equal(vehicle.payloadTonnes, value, 'preflight must not rewrite the directory');
    }
    vehicle.payloadTonnes = '27.9';
    assert.deepEqual(runtime.prepare(source, data, runtime.trip, integrationConfig()).blockers, []);
  } finally { await runtime.close(); }
});

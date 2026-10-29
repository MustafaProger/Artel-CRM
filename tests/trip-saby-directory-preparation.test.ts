import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { currentSnapshot } from '../server/shipment-operations';
import { sabyTransportBlockers, serializeSabyTransportOrder } from '../server/saby-transport-order';
import { sabyConsignmentBlockers, serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import type { TripSabyRecord } from '../server/trip-saby-workflow';
import { SABY_VOLUME_ROUNDING_VERSION } from '../server/saby-volume';
import { integrationConfig, integrationRuntime } from './helpers/trip-saby-integration';

test('new order trips use the sender as loader and keep the independent infrastructure owner', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const site = source.directories!.oilDepots!.find(row => row.id === 'depot')!;
    site.loadingActorCompanyId = 'customer'; site.infrastructureOwnerCompanyId = 'carrier';
    const vehicle = source.directories!.vehicles.find(row => row.id === 'vehicle')!; vehicle.cargoDistributable = '0';
    const prepared = runtime.prepare(source, data, runtime.trip, integrationConfig());
    assert.equal(prepared.deliveries[0].snapshot.profile.loadingActor.sameAsConsignor, true);
    assert.equal(prepared.deliveries[0].snapshot.profile.instructions.redirectionMethod, 'Электронное уведомление перевозчика о переадресовке');
    assert.equal(prepared.deliveries[0].snapshot.profile.loadingActor.party.inn, integrationConfig().customer.inn);
    assert.equal(prepared.deliveries[0].snapshot.profile.infrastructureOwner.party.inn, source.companies.find(row => row.id === 'carrier')!.inn);
    assert.equal(prepared.order.fields.loading_address, site.address);
    assert.equal(prepared.order.fields.loading_site_owner_address, source.companies.find(row => row.id === 'supplier')!.address);
    assert.equal(prepared.order.profile!.cargoByProductId.product.distributable, '0');
    assert.equal(prepared.order.fields.organization_id, runtime.trip.fields.organization_id);
    delete site.loadingActorCompanyId; delete site.infrastructureOwnerCompanyId;
    const missing = runtime.prepare(source, data, runtime.trip, integrationConfig());
    assert.deepEqual(missing.deliveries[0].snapshot.profile.loadingActor, prepared.deliveries[0].snapshot.profile.loadingActor);
    assert.equal(missing.deliveries[0].snapshot.profile.infrastructureOwner.party.inn, '');
    assert.ok(!missing.blockers.some(message => /осуществляющее погрузку/.test(message)));
    assert.ok(missing.blockers.some(message => /инфраструктуры/.test(message)));
    assert.equal(missing.order.fields.loading_site_owner_address, prepared.order.fields.loading_site_owner_address);
  } finally { await runtime.close(); }
});

test('new loader XML contains sender identity and preserves the separate owner; saved loader snapshots remain exact', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source);
    const source = currentSnapshot(runtime.base, data);
    const prepared = runtime.prepare(source, data, runtime.trip, integrationConfig());
    const snapshot = prepared.deliveries[0].snapshot;
    snapshot.profile.order = { number: '1', date: '2025-04-01' };
    snapshot.profile.loading = { ...snapshot.profile.loading, arrivedAt: '2025-04-01T09:00:00', departedAt: '2025-04-01T10:00:00', grossMassTonnes: snapshot.profile.deliveryMassTonnes, massMethod: '03' };
    const xml = new TextDecoder('windows-1251').decode(serializeSabyConsignmentNote(snapshot, '00000000-0000-4000-8000-000000000000', '2025-04-01T10:00:00Z', '1').xml);
    assert.match(xml, /<СвЛицПогрГр СовпГОП="1">/);
    assert.doesNotMatch(xml, /<РекЛицПогрГр>/);
    assert.match(xml, /<ВладИнфр СовпГОВ="2">/);
    const historical = structuredClone(snapshot);
    historical.profile.instructions.redirectionMethod = 'По телефону';
    historical.profile.loadingActor = { sameAsConsignor: false, party: { ...snapshot.profile.infrastructureOwner.party } };
    // This pure preflight reads only saved delivery snapshots, not workflow state.
    data.tripSaby = { trips: { [runtime.trip.id]: { deliveries: [{ shipmentId: historical.shipmentId, snapshot: historical }] } as TripSabyRecord } };
    source.directories!.oilDepots![0].loadingActorCompanyId = 'customer';
    const before = structuredClone(data);
    const again = runtime.prepare(source, data, runtime.trip, integrationConfig());
    assert.deepEqual(again.deliveries[0].snapshot.profile.loadingActor, historical.profile.loadingActor);
    assert.equal(again.deliveries[0].snapshot.profile.instructions.redirectionMethod, 'По телефону');
    assert.deepEqual(data, before);
    again.deliveries[0].snapshot.profile.loadingActor.party.name = 'changed outside saved data';
    assert.deepEqual(data, before);
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

for (const [capacityLitres, litres, masses] of [
  ['10228', ['10228'], ['8.583']],
  ['15048', ['5118', '9930'], ['4.291', '8.33']],
] as const) test(`new preparations use the saved ${capacityLitres} litre tank without requiring sections or changing exact facts`, async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const trip = structuredClone(runtime.trip); trip.fields.trip_flow_version = 'driver-v1';
    trip.fields.quantity_tonnes = masses.length === 1 ? '8.583' : '12.621';
    trip.fields.quantity_gross_tonnes = trip.fields.quantity_tonnes;
    trip.customers = trip.customers.slice(0, litres.length).map((row, index) => ({ ...row, fields: { ...row.fields, quantity_litres: litres[index], quantity_tonnes: masses[index], quantity_gross_tonnes: masses[index] } }));
    const vehicle = source.directories!.vehicles.find(row => row.id === 'vehicle')!;
    vehicle.capacityLitres = capacityLitres; delete vehicle.compartmentsLitres;
    const before = structuredClone({ source, trip });
    const prepared = runtime.prepare(source, data, trip, integrationConfig());
    assert.deepEqual(prepared.blockers, []);
    assert.equal(prepared.order.volumeRoundingVersion, SABY_VOLUME_ROUNDING_VERSION);
    assert.equal(prepared.order.fields.quantity_litres, capacityLitres);
    assert.equal(prepared.order.profile!.vehicleById.vehicle.capacityCubicMetres, capacityLitres === '10228' ? '10.228' : '15.048');
    for (const row of prepared.deliveries) assert.equal(row.snapshot.volumeRoundingVersion, SABY_VOLUME_ROUNDING_VERSION);
    const xml = new TextDecoder('windows-1251').decode(serializeSabyTransportOrder(prepared.order, '00000000-0000-4000-8000-000000000000', '2025-04-01T10:00:00Z').xml);
    assert.match(xml, new RegExp(`Вместим="${capacityLitres === '10228' ? '10.23' : '15.05'}"`));
    for (const volume of capacityLitres === '10228' ? ['10.23'] : ['5.12', '9.93']) assert.ok(xml.includes(`Объем="${volume}"`));
    for (const amount of litres) assert.ok(xml.includes(`${amount} л;`));
    const directory = mkdtempSync(resolve(tmpdir(), 'saby-rounded-order-'));
    try {
      const path = resolve(directory, 'order.xml');
      writeFileSync(path, serializeSabyTransportOrder(prepared.order, '00000000-0000-4000-8000-000000000000', '2025-04-01T10:00:00Z').xml);
      execFileSync('xmllint', ['--noout', '--schema', 'tests/fixtures/saby/transport-order-1110361-5.01.xsd', path], { stdio: 'pipe' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
    assert.deepEqual({ source, trip }, before);
    const legacy = structuredClone(prepared.order); delete legacy.volumeRoundingVersion;
    assert.ok(sabyTransportBlockers(legacy).some(message => /вместимость|объём/i.test(message)));
  } finally { await runtime.close(); }
});

test('order diagnostics name the actual missing vehicle field and block a positive amount rounded to zero', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const config = integrationConfig(); delete config.transportProfile!.cargoByProductId.product;
    delete source.directories!.vehicles[0].cargoDistributable;
    const prepared = runtime.prepare(source, data, runtime.trip, config);
    assert.ok(prepared.blockers.some(message => /машины.*распределение груза по платформе/.test(message)));
    assert.ok(!prepared.blockers.some(message => /Для выбранного продукта не подтверждены/.test(message)));
    const order = runtime.prepare(source, data, runtime.trip, integrationConfig()).order;
    order.fields.quantity_litres = '4.999'; order.deliveries = undefined;
    assert.ok(sabyTransportBlockers(order).some(message => /Объём заказа после округления.*нулю/.test(message)));
  } finally { await runtime.close(); }
});

test('legacy order snapshot keeps pre-release XML bytes without the new rounding marker', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const order = runtime.prepare(source, data, runtime.trip, integrationConfig()).order;
    delete order.volumeRoundingVersion;
    order.tripId = order.shipmentId = 'fixture-trip';
    order.deliveries!.forEach((row, index) => { row.shipmentId = `fixture-delivery-${index}`; });
    order.intermediateStops!.forEach(row => { row.afterShipmentId = 'fixture-delivery-0'; });
    const bytes = serializeSabyTransportOrder(order, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2025-04-01T09:20:30.000Z').xml;
    assert.equal(createHash('sha256').update(bytes).digest('hex'), 'afd295f9af0f281dbddc219f57e2558cdce6404731773d2524e5443c7847e8cd');
    order.profile!.vehicleById.vehicle.capacityCubicMetres = '025.0000';
    const padded = serializeSabyTransportOrder(order, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2025-04-01T09:20:30.000Z').xml;
    assert.equal(new TextDecoder('windows-1251').decode(padded), new TextDecoder('windows-1251').decode(bytes).replace('Вместим="25"', 'Вместим="025.0000"'));
  } finally { await runtime.close(); }
});

test('rounded capacity cannot hide overload or falsely reject an exactly full tank rounded down', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const trip = structuredClone(runtime.trip); trip.fields.trip_flow_version = 'driver-v1'; trip.fields.quantity_tonnes = trip.fields.quantity_gross_tonnes = '8.583';
    trip.customers = [{ ...trip.customers[0], fields: { ...trip.customers[0].fields, quantity_litres: '10224', quantity_tonnes: '8.583', quantity_gross_tonnes: '8.583' } }];
    source.directories!.vehicles[0].capacityLitres = '10224';
    const prepared = runtime.prepare(source, data, trip, integrationConfig());
    assert.deepEqual(prepared.blockers, []);
    const order = structuredClone(prepared.order);
    order.fields.quantity_litres = order.deliveries![0].fields.quantity_litres = '10225';
    assert.ok(sabyTransportBlockers(order).some(message => /превышает.*вместимость/i.test(message)));
    const delivery = structuredClone(prepared.deliveries[0].snapshot);
    delivery.fields.quantity_litres = '10225'; delivery.tripTotalLitres = '10225';
    assert.ok(sabyConsignmentBlockers(delivery, { stage: 'preparation' }).some(message => /превышает.*вместимость/i.test(message)));
  } finally { await runtime.close(); }
});

test('driver order rounds each cargo separately without fabricating a duplicated total volume or redistributing litres', async () => {
  const runtime = await integrationRuntime();
  try {
    const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
    const trip = structuredClone(runtime.trip); trip.fields.trip_flow_version = 'driver-v1'; trip.fields.quantity_tonnes = trip.fields.quantity_gross_tonnes = '1.6';
    trip.customers = trip.customers.map(row => ({ ...row, fields: { ...row.fields, quantity_litres: '1005', quantity_tonnes: '0.8', quantity_gross_tonnes: '0.8' } }));
    source.directories!.vehicles[0].capacityLitres = '2010';
    const prepared = runtime.prepare(source, data, trip, integrationConfig());
    assert.deepEqual(prepared.blockers, []);
    assert.equal(prepared.order.fields.quantity_litres, '2010');
    const bytes = serializeSabyTransportOrder(prepared.order, '00000000-0000-4000-8000-000000000000', '2025-04-01T10:00:00Z').xml;
    const xml = new TextDecoder('windows-1251').decode(bytes);
    assert.equal((xml.match(/ Объем=/g) ?? []).length, 2, '1110361 has one volume per cargo, no extra aggregate volume');
    assert.equal((xml.match(/ Объем="1.01"/g) ?? []).length, 2);
    assert.match(xml, /Вместим="2.01"/, 'vehicle capacity is a separate physical fact, not a rounded cargo sum');
    assert.equal((xml.match(/1005 л;/g) ?? []).length, 2);
    const directory = mkdtempSync(resolve(tmpdir(), 'saby-rounded-cargos-'));
    try {
      const path = resolve(directory, 'order.xml'); writeFileSync(path, bytes);
      execFileSync('xmllint', ['--noout', '--schema', 'tests/fixtures/saby/transport-order-1110361-5.01.xsd', path], { stdio: 'pipe' });
    } finally { rmSync(directory, { recursive: true, force: true }); }
  } finally { await runtime.close(); }
});

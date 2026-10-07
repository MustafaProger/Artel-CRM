import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import test from 'node:test';
import { currentSnapshot } from '../server/shipment-operations';
import { sabyConsignmentBlockers, serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { sabyTransportBlockers, sabyTransportDraftBlockers, serializeSabyTransportDraft, serializeSabyTransportOrder } from '../server/saby-transport-order';
import { integrationConfig, integrationRuntime } from './helpers/trip-saby-integration';

const attempt = '11111111-1111-4111-8111-111111111111';
const created = '2025-04-01T10:00:00.000Z';
const decode = (bytes: Buffer) => new TextDecoder('windows-1251').decode(bytes);
function xsd(bytes: Buffer, format: string) {
  const directory = mkdtempSync(resolve(tmpdir(), 'artel-driver-format-'));
  try {
    const path = resolve(directory, 'synthetic.xml'); writeFileSync(path, bytes);
    execFileSync('xmllint', ['--noout', '--schema', resolve(`tests/fixtures/saby/${format}-5.01.xsd`), path], { stdio: 'pipe' });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}
async function driverPreparation() {
  const runtime = await integrationRuntime();
  const data = await runtime.store.read(runtime.source); const source = currentSnapshot(runtime.base, data);
  const trip = structuredClone(runtime.trip);
  Object.assign(trip.fields, { trip_flow_version: 'driver-v1', date: '2025-04-02', loading_planned_at: '2025-04-02T09:00', quantity_tonnes: null, quantity_gross_tonnes: null, loading_actual_at: null });
  for (const row of trip.customers) Object.assign(row.fields, { unloading_planned_at: null, unloading_actual_at: null, quantity_tonnes: null, quantity_gross_tonnes: null });
  // Equal customer/address/product are intentional: stable delivery IDs remain distinct.
  const prepared = runtime.prepare(source, data, trip, integrationConfig());
  return { runtime, source, data, trip, prepared };
}

test('pre-driver draft keeps separate cargo and future pickup while omitting mass, unloading times and route deadline', async () => {
  const { runtime, prepared, source } = await driverPreparation();
  try {
    assert.deepEqual(prepared.blockers, []);
    assert.deepEqual(sabyTransportDraftBlockers(prepared.order), []);
    assert.ok(sabyTransportBlockers(prepared.order).length > 0);
    assert.throws(() => serializeSabyTransportOrder(prepared.order, attempt, created, '041'));
    const xml = decode(serializeSabyTransportDraft(prepared.order, attempt, created, '041').xml);
    assert.equal((xml.match(/<ОпГруз /g) || []).length, 2);
    assert.match(xml, /<Пункт Погр="1" Выгр="2" КолГрМест="1"\/>/);
    assert.match(xml, /<Пункт Погр="1" Выгр="3" КолГрМест="1"\/>/);
    assert.match(xml, /ДатВрПод="02\.04\.2025T09:00:00\+03:00"/);
    assert.doesNotMatch(xml, /МасГруз|МасБрутЗнач|МасНетЗнач|ПредВрПод|ПредВрОпер|Опер="Выгрузка"[^>]*ДатВрОпер/);
    assert.equal(prepared.order.processingDurationMinutes, 600);
    assert.equal(prepared.order.allowedOperationTime, undefined);
    for (const row of prepared.deliveries) {
      assert.equal(row.snapshot.profile.massSource, 'driver');
      assert.equal(row.snapshot.profile.deliveryMassTonnes, '');
      assert.equal(row.snapshot.profile.recipient.phone, source.companies.find(company => company.id === 'customer')!.phone);
      assert.notEqual(row.snapshot.profile.recipient.phone, source.directories!.addresses.find(address => address.id === 'delivery')!.receiverPhone);
      assert.deepEqual(sabyConsignmentBlockers(row.snapshot, { stage: 'driver_draft' }), []);
      assert.throws(() => serializeSabyConsignmentNote(row.snapshot, attempt, created));
    }
  } finally { await runtime.close(); }
});

test('completed driver masses become exact per-delivery cargo with stable IDs and matching net/gross, not litre proportions', async () => {
  const { runtime, source, data, trip } = await driverPreparation();
  try {
    const masses = ['4.123456', '7.234567'];
    trip.fields.quantity_tonnes = '11.358023'; trip.fields.quantity_gross_tonnes = '11.358023';
    trip.customers.forEach((row, index) => Object.assign(row.fields, { quantity_tonnes: masses[index], quantity_gross_tonnes: masses[index] }));
    const { order, deliveries, blockers } = runtime.prepare(source, data, trip, integrationConfig());
    assert.deepEqual(blockers, []);
    const generated = serializeSabyTransportOrder(order, attempt, created, '041'); const xml = decode(generated.xml);
    assert.equal((xml.match(/<ОпГруз /g) || []).length, 2);
    assert.match(xml, /<МасГруз МасБрутЗнач="4123\.456" МасНетЗнач="4123\.456"\/>/);
    assert.match(xml, /<МасГруз МасБрутЗнач="7234\.567" МасНетЗнач="7234\.567"\/>/);
    assert.doesNotMatch(xml, /МасБрутЗнач="11358/);
    xsd(generated.xml, 'transport-order-1110361');
    deliveries.forEach((row, index) => {
      assert.equal(row.snapshot.profile.deliveryMassTonnes, masses[index]);
      assert.equal(row.snapshot.profile.plannedGrossMassTonnes, masses[index]);
      Object.assign(row.snapshot.profile, { order: { number: '041', date: trip.fields.date }, loading: { arrivedAt: '2025-04-02T09:23:01', departedAt: '2025-04-02T10:31:02', grossMassTonnes: masses[index], massMethod: '03' } });
      assert.deepEqual(sabyConsignmentBlockers(row.snapshot), []);
      const note = serializeSabyConsignmentNote(row.snapshot, attempt, created, '101'); const content = decode(note.xml);
      assert.match(content, /МетОпрМасс="03" КолМестПрием="1"/);
      assert.match(content, /ЛицоПА="Грузоотправитель" СпосПерУкПА="По телефону"/);
      assert.match(content, /ФДатВрПриб="02\.04\.2025T09:23:01\+03:00"/);
      assert.match(content, /ФДатВрУбыт="02\.04\.2025T10:31:02\+03:00"/);
      assert.doesNotMatch(content, /ДатВрДостГр=/);
      assert.match(content, /Синтетическая доставка/);
      xsd(note.xml, 'consignment-note-1110339');
    });
  } finally { await runtime.close(); }
});

test('driver draft never hides partial mass, missing pickup, missing company phone or literal ten-o-clock deadline', async () => {
  const { runtime, prepared, source, data, trip } = await driverPreparation();
  try {
    const partial = structuredClone(prepared.order); partial.deliveries![0].fields.quantity_tonnes = '4';
    assert.ok(sabyTransportDraftBlockers(partial).some(value => /частичный/.test(value)));
    const clock = structuredClone(prepared.order); clock.allowedOperationTime = '10:00:00+03:00';
    assert.ok(sabyTransportDraftBlockers(clock).some(value => /интервал обработки/.test(value)));
    const noTime = structuredClone(prepared.order); noTime.fields.loading_planned_at = '2025-04-02';
    assert.ok(sabyTransportDraftBlockers(noTime).some(value => /плановые дату и время/.test(value)));
    source.companies.find(row => row.id === 'customer')!.phone = '';
    assert.ok(runtime.prepare(source, data, trip, integrationConfig()).blockers.some(value => /грузополучателя/.test(value)));
    const legacy = structuredClone(prepared.order); delete legacy.fields.trip_flow_version;
    assert.throws(() => serializeSabyTransportDraft(legacy, attempt, created));
  } finally { await runtime.close(); }
});

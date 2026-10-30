import assert from 'node:assert/strict';
import test from 'node:test';
import { discoverOrderConsignments } from '../server/etrn-order-discovery';
import { SabyClient, SabyError, type SabyObject } from '../server/saby-client';
import { syntheticEtrnFixture, sender, carrier } from './helpers/etrn-fixture';

const order = { id: 'source-order', number: '45', date: '2025-04-01' }, marker = 'ARTEL-CRM:ETRN:synthetic-discovery';
const organization = (inn = sender.inn, kpp = sender.kpp) => ({ СвЮЛ: { ИНН: inn, КПП: kpp } });
const base = (id: string, type = 'TransportOrder') => ({ Документ: { Идентификатор: id, Тип: type } });
const note = (id: string, extra: SabyObject = {}): SabyObject => ({ Идентификатор: id, Тип: 'ConsignmentNote', Дата: '01.04.2025', НашаОрганизация: organization(), Грузоотправитель: organization(), ТранспортнаяКомпания: organization(carrier.inn, carrier.kpp), ...extra });
const page = (documents: SabyObject[], more = 'Нет') => ({ Документ: documents.map(row => ({ Идентификатор: row.Идентификатор, Тип: row.Тип })), Навигация: { ЕстьЕще: more } });
function fixture(pages: unknown[], documents: SabyObject[] = []) {
  const calls: { method: string; params: SabyObject }[] = [], lookup = new Map(documents.map(row => [row.Идентификатор, row]));
  const send: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)); calls.push(request);
    let result: unknown;
    if (request.method === 'СБИС.СписокДокументов') result = pages[Number(request.params.Фильтр.Навигация.Страница)];
    else if (request.method === 'СБИС.ПрочитатьДокумент') result = lookup.get(request.params.Документ.Идентификатор);
    else throw new Error('Discovery must never mutate provider data');
    if (result instanceof Error) throw result;
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  };
  const snapshot = syntheticEtrnFixture().snapshot;
  const client = new SabyClient({ sessionId: 'synthetic-session', customer: sender, carrier }, send);
  return { calls, snapshot, client, run: () => discoverOrderConsignments(client, order, snapshot, marker) };
}

test('complete empty register permits an absence result without marker filtering or provider writes', async () => {
  const f = fixture([page([])]);
  assert.deepEqual(await f.run(), []);
  const filter = f.calls[0].params.Фильтр as SabyObject;
  assert.equal(filter.Тип, 'ConsignmentNote'); assert.equal(filter.Направление, 'Исходящий'); assert.equal(filter.ДатаС, '01.04.2025'); assert.equal(filter.Маска, undefined);
  assert.deepEqual(filter.НашаОрганизация, organization());
  assert.equal(f.calls.length, 1);
});

test('all pages are read and native notes without a CRM marker are found by exact base ID', async () => {
  const foreign = note('foreign', { ДокументОснование: [base('other-order')] });
  const native = note('native', { Примечание: '', ДокументОснование: [base(order.id)] });
  const own = note('own', { Примечание: marker });
  const f = fixture([page([foreign], 'Да'), page([native, own])], [foreign, native, own]);
  assert.deepEqual((await f.run()).map(row => row.Идентификатор), ['native', 'own']);
  assert.deepEqual(f.calls.map(row => row.method), ['СБИС.СписокДокументов', 'СБИС.СписокДокументов', 'СБИС.ПрочитатьДокумент', 'СБИС.ПрочитатьДокумент', 'СБИС.ПрочитатьДокумент']);
});

for (const bases of [undefined, [], [base('invoice', 'СчетИсх')]]) test(`plausible orphan notes fail closed instead of authorizing a duplicate (${JSON.stringify(bases)})`, async () => {
  const orphan = note('orphan', { ДокументОснование: bases }), f = fixture([page([orphan])], [orphan]);
  await assert.rejects(f.run(), /тех же сторон без подтверждённой связи/);
});

test('notes with another exact order or another carrier are excluded', async () => {
  const otherOrder = note('other-order-note', { ДокументОснование: [base('other-order')] });
  const otherCarrier = note('other-carrier', { ТранспортнаяКомпания: organization('7707083893', '770701001') });
  const f = fixture([page([otherOrder, otherCarrier])], [otherOrder, otherCarrier]);
  assert.deepEqual(await f.run(), []);
});

for (const response of [{ Документ: [] }, { Документ: [], Навигация: {} }, { Документ: [], Навигация: { ЕстьЕще: true } }, { Документ: [], Навигация: { ЕстьЕще: 'Да' } }, { Документ: [], Навигация: { ЕстьЕще: 'Нет', Страница: '1' } }, { Документ: [], Навигация: { ЕстьЕще: 'Нет', РазмерСтраницы: '201' } }, { ...page([]), ЧастичныеДанные: 'Да' }]) test(`incomplete navigation cannot prove absence: ${JSON.stringify(response)}`, async () => {
  const f = fixture([response]); await assert.rejects(f.run(), SabyError);
  assert.equal(f.calls.length, 1);
});

test('duplicate IDs across pages stop discovery before reading or writing documents', async () => {
  const repeated = note('repeat'), f = fixture([page([repeated], 'Да'), page([repeated])]);
  await assert.rejects(f.run(), /Список ЭТрН изменился или неполон/);
  assert.equal(f.calls.length, 2);
});

test('a failed later page cannot be interpreted as an empty complete register', async () => {
  const f = fixture([page([note('first')], 'Да'), new Error('synthetic transport loss')]);
  await assert.rejects(f.run(), SabyError);
  assert.ok(f.calls.every(row => row.method === 'СБИС.СписокДокументов'));
});

test('an unbounded register stops after twenty pages without document reads or writes', async () => {
  const f = fixture(Array.from({ length: 20 }, (_, index) => page([note(`note-${index}`)], 'Да')));
  await assert.rejects(f.run(), /превышает предел/); assert.equal(f.calls.length, 20);
});

for (const extra of [{ ЧастичныеДанные: 'Да' }, { Удален: 'Да' }, { Дата: '31.02.2025' }, { Дата: '31.03.2025' }, { НашаОрганизация: organization('7707083893', '770701001') }, { ДокументОснование: [{ Документ: { Тип: 'TransportOrder' } }] }, { Грузоотправитель: undefined }, { Стороны: { Отправитель: organization('7707083893', '770701001') } }]) test(`unsafe full document prevents absence proof: ${JSON.stringify(extra)}`, async () => {
  const value = note('unsafe', extra), f = fixture([page([value])], [value]);
  await assert.rejects(f.run(), SabyError);
});

test('the date window covers a future frozen shipment date and input dates are validated before requests', async () => {
  const f = fixture([page([])]); f.snapshot.fields.date = '2099-01-02';
  assert.deepEqual(await f.run(), []); assert.equal((f.calls[0].params.Фильтр as SabyObject).ДатаПо, '02.01.2099');
  const invalid = fixture([page([])]); invalid.snapshot.fields.date = '2025-02-30';
  await assert.rejects(invalid.run(), SabyError); assert.equal(invalid.calls.length, 0);
});

test('the date window starts at an earlier frozen shipment date so a backdated native note is discovered', async () => {
  const f = fixture([page([])]); f.snapshot.fields.date = '2025-03-31';
  assert.deepEqual(await f.run(), []);
  assert.equal((f.calls[0].params.Фильтр as SabyObject).ДатаС, '31.03.2025');
});

test('request guards still run for discovery and can stop the next read', async () => {
  const value = note('native', { ДокументОснование: [base(order.id)] }), f = fixture([page([value])], [value]);
  let checks = 0;
  const guarded = f.client.withRequestGuard(async () => { if (++checks > 1) throw new SabyError('permission', 'synthetic access revoked'); });
  await assert.rejects(discoverOrderConsignments(guarded, order, f.snapshot, marker), /synthetic access revoked/);
  assert.equal(f.calls.length, 1);
});

test('an empty list from a different configured sender cannot prove absence', async () => {
  const f = fixture([page([])]); f.snapshot.customerOrganization = { ...sender, inn: '7707083893', kpp: '770701001' };
  await assert.rejects(f.run(), /не соответствует отправителю/);
  assert.equal(f.calls.length, 0);
});

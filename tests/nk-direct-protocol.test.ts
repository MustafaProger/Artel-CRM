import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { syntheticEtrnFixture, sender, carrier } from './helpers/etrn-fixture';
import { SabyClient, SabyError, sabyConfigurationBlockers, type SabyObject } from '../server/saby-client';
import { assertSigningBinding, createCarrierDraftBinding, createSigningBinding, signingManifestHash, type SabySigningCertificate } from '../server/saby-signing';
import { buildSabyConsignmentDocument, sabyConsignmentBlockers, serializeSabyConsignmentNote } from '../server/saby-consignment-note';
import { verifyConsignmentSenderBusiness } from '../server/saby-consignment-evidence';
import { encodeWindows1251 } from '../server/saby-transport-order';

const fp = 'b'.repeat(40);
const config = { login: 'synthetic', password: 'synthetic', accountNumber: 'artel-test', carrierAccountNumber: 'nk-test', sessionId: 'artel-test-session', customer: sender, carrier,
  consignmentSigner: { surname: 'АРТЭЛЬ', name: 'Тест', patronymic: '', position: 'Директор' },
  nkConsignmentSigner: { surname: 'НК', name: 'Тест', patronymic: '', position: 'Директор' } };
const certificate: SabySigningCertificate = { thumbprint: fp, organizationInn: carrier.inn, organizationKpp: carrier.kpp, qualified: true, valid: true, notBefore: '2020-01-01T00:00:00Z', notAfter: '2099-01-01T00:00:00Z', type: 'Client', ownerName: 'Синтетический' };
const party = { СвЮЛ: { ИНН: carrier.inn, КПП: carrier.kpp } };
function remote(side: 'sender' | 'carrier'): SabyObject {
  const stage = { Идентификатор: `stage-${side}`, Название: side === 'sender' ? 'Отправка' : 'Получение груза',
    Действие: [{ Название: side === 'sender' ? 'Погружен' : 'Принят', ТребуетПодписания: 'Да', Сертификат: { Отпечаток: fp, Ключ: { Тип: 'Отложенный', Активирован: 'Да' } } }] };
  return { Идентификатор: 'direct-document', Тип: 'ConsignmentNote', Направление: 'Исходящий', НашаОрганизация: party, Грузоотправитель: party, ТранспортнаяКомпания: party,
    Редакция: [{ Идентификатор: 'revision', Актуален: 'Да' }], Состояние: { Код: side === 'sender' ? '0' : '4' },
    Этап: [stage], ТекущиеЭтапы: [{ Идентификатор: stage.Идентификатор }],
    Вложение: [{ Идентификатор: 't1', Подтип: '1110339', ВерсияФормата: '5.01', Направление: 'Исходящий',
      ...(side === 'carrier' ? { Подпись: [{ Сертификат: { Отпечаток: fp, ИНН: carrier.inn } }] } : {}) }] };
}
function fixture() {
  const { snapshot } = syntheticEtrnFixture();
  snapshot.documentMode = 'nk-direct-v1';
  snapshot.fields.organization_id = 'nk-artel';
  snapshot.customerOrganization = { ...carrier };
  snapshot.profile.order = { number: 'Без номера', date: snapshot.fields.date! };
  return snapshot;
}
const serialize = (snapshot = fixture()) => serializeSabyConsignmentNote(snapshot, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2025-04-01T09:20:30Z', '27-1').xml;

test('direct client isolates NK session and scopes both titles without altering ordinary client', async () => {
  const requests: Array<{ method: string; account?: string; session: string | null }> = [];
  let guards = 0, budgets = 0;
  const send: typeof fetch = async (_url, init) => {
    const req = JSON.parse(String(init?.body));
    requests.push({ method: req.method, account: req.params.Параметр?.НомерАккаунта, session: new Headers(init?.headers).get('X-SBISSessionID') });
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result: req.method === 'СБИС.Аутентифицировать' ? 'nk-test-session' : {} }));
  };
  const root = new SabyClient(config, send).withRequestGuard(async () => { guards++; }).withRequestBudget(async action => { budgets++; return action(); });
  const direct = root.forNkDirectEtrn();
  assert.equal(direct.config.customer.inn, carrier.inn);
  assert.equal(direct.config.consignmentSigner?.surname, 'НК');
  assert.equal(root.config.consignmentSigner?.surname, 'АРТЭЛЬ');
  await direct.readSigningCertificate('sender', fp);
  await direct.readSigningCertificate('carrier', fp);
  assert.equal(requests.filter(row => row.method === 'СБИС.Аутентифицировать').length, 1);
  assert.equal(requests[0].account, 'nk-test');
  assert.ok(requests.slice(1).every(row => row.session === 'nk-test-session'));
  assert.equal(guards, 3); assert.equal(budgets, 3);
  await assert.rejects(direct.writeDocument({ Тип: 'TransportOrder' }), SabyError);
  assert.equal(requests.length, 3);
  assert.ok(sabyConfigurationBlockers({ ...config, customer: carrier }).length);
  assert.deepEqual(sabyConfigurationBlockers(direct.config), []);
});

test('same-company direct signing freezes actual provider role and never creates an order binding', () => {
  const scoped = new SabyClient(config).forNkDirectEtrn().config;
  const first = createSigningBinding(remote('sender'), 'sender', certificate, scoped, 'Отложенный', 'ConsignmentNote');
  assert.equal(first.routePolicy, 'nk-direct-v1');
  const second = createCarrierDraftBinding(remote('carrier'), certificate, scoped, 'Отложенный', 'ConsignmentNote');
  assert.equal(second.documentDirection, 'Исходящий');
  assert.equal(second.actionStateCode, '4');
  assert.equal(second.attachmentSubtype, '1110340');
  assert.equal(second.organizationInn, second.counterpartyInn);
  assert.throws(() => createSigningBinding(remote('sender'), 'sender', certificate, scoped, 'Отложенный'), SabyError);
  assert.throws(() => assertSigningBinding({ ...first, routePolicy: undefined, documentDirection: undefined, actionStateCode: undefined }), SabyError);
  const files = [{ id: 't1', name: 't1.xml', subtype: '1110339', sha256: 'a'.repeat(64) }];
  assert.notEqual(signingManifestHash({ binding: first, attachments: files }), signingManifestHash({ binding: { ...first, documentDirection: 'Входящий' }, attachments: files }));
});

test('source signature download selects exact current T2 without weakening the default T1 check', async () => {
  const document = remote('carrier');
  const signature = Buffer.from('synthetic-carrier-signature');
  document.Вложение = [{ Идентификатор: 't2', Подтип: '1110340', ВерсияФормата: '5.01',
    Подпись: [{ Сертификат: { Отпечаток: fp }, Файл: { ДвоичныеДанные: signature.toString('base64') } }] }];
  let reads = 0;
  const send: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body));
    if (request.method !== 'СБИС.Аутентифицировать') {
      assert.equal(request.method, 'СБИС.ПрочитатьДокумент'); reads++;
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id,
      result: request.method === 'СБИС.Аутентифицировать' ? 'synthetic-nk-session' : document }));
  };
  const client = new SabyClient(config, send).forNkDirectEtrn();
  assert.deepEqual(Buffer.from(await client.downloadSigningSignature('carrier', 'direct-document', 't2', 'revision', fp, 'ConsignmentNote', '1110340')), signature);
  await assert.rejects(client.downloadSigningSignature('carrier', 'direct-document', 't2', 'revision', fp, 'ConsignmentNote'), SabyError);
  await assert.rejects(client.downloadSigningSignature('carrier', 'direct-document', 't2', 'old-revision', fp, 'ConsignmentNote', '1110340'), SabyError);
  await assert.rejects(client.downloadSigningSignature('carrier', 'direct-document', 't2', 'revision', 'c'.repeat(40), 'ConsignmentNote', '1110340'), SabyError);
  assert.equal(reads, 4);
  await assert.rejects(client.downloadSigningSignature('carrier', 'direct-document', 't2', 'revision', fp, undefined, '1110340'), SabyError);
  assert.equal(reads, 4);
});

test('missing, historical, service or unsigned-source carrier stages cannot begin direct Prepare', () => {
  const scoped = new SabyClient(config).forNkDirectEtrn().config;
  for (const mutate of [
    (doc: SabyObject) => { delete doc.ТекущиеЭтапы; },
    (doc: SabyObject) => { doc.ТекущиеЭтапы = []; },
    (doc: SabyObject) => { doc.ТекущиеЭтапы = [{ Идентификатор: 'old' }]; },
    (doc: SabyObject) => { (doc.Этап as SabyObject[])[0].Служебный = 'Да'; },
    (doc: SabyObject) => { (doc.Вложение as SabyObject[])[0].Подпись = []; },
    (doc: SabyObject) => { doc.НашаОрганизация = { СвЮЛ: { ИНН: sender.inn, КПП: sender.kpp } }; },
  ]) {
    const doc = remote('carrier'); mutate(doc);
    assert.throws(() => createCarrierDraftBinding(doc, certificate, scoped, 'Отложенный', 'ConsignmentNote'), SabyError);
  }
});

test('direct XML passes FNS 5.01 with mandatory no-number attributes and no order linkage', () => {
  const snapshot = fixture();
  assert.deepEqual(sabyConsignmentBlockers(snapshot), []);
  const xml = serialize(snapshot);
  const text = new TextDecoder('windows-1251').decode(xml);
  assert.match(text, /НомЗак="Без номера" ДатаЗак="01.04.2025"/);
  assert.doesNotMatch(text, /ИдЗак|TransportOrder|SYNTHETIC-ORDER/);
  const request = buildSabyConsignmentDocument(snapshot, 'synthetic-marker', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', '2025-04-01T09:20:30Z', '27-1');
  assert.deepEqual(request.Грузоотправитель, request.ТранспортнаяКомпания);
  assert.notDeepEqual(request.Грузополучатель, request.ТранспортнаяКомпания);
  const folder = mkdtempSync(resolve(tmpdir(), 'nk-direct-xsd-'));
  try {
    writeFileSync(resolve(folder, 'title.xml'), xml);
    execFileSync('xmllint', ['--noout', '--schema', resolve('tests/fixtures/saby/consignment-note-1110339-5.01.xsd'), resolve(folder, 'title.xml')], { stdio: 'pipe' });
  } finally { rmSync(folder, { recursive: true, force: true }); }
  snapshot.profile.order.number = '';
  assert.ok(sabyConsignmentBlockers(snapshot).some(message => message.includes('Без номера')));
});

test('direct address policy tolerates valid changed coordinates only with exact full addresses and masses', () => {
  const snapshot = fixture();
  snapshot.fields.loading_latitude = '55.123'; snapshot.fields.loading_longitude = '37.456';
  snapshot.fields.unloading_latitude = '56.123'; snapshot.fields.unloading_longitude = '38.456';
  const frozen = serialize(snapshot);
  const text = new TextDecoder('windows-1251').decode(frozen);
  const changed = encodeWindows1251(text.replace('Широта="55.123"', 'Широта="55.124"'));
  assert.throws(() => verifyConsignmentSenderBusiness(changed, frozen), SabyError);
  verifyConsignmentSenderBusiness(changed, frozen, 'address-direct-v1');
  for (const mutation of [
    text.replace('Широта="55.123"', 'Широта="95.123"'),
    text.replace('Синтетическая площадка погрузки', 'Другой адрес'),
    text.replace('МасБрутОтгр="5123.125"', 'МасБрутОтгр="5123.126"'),
    text.replace('ИННЮЛ="0261947385"', 'ИННЮЛ="0261947386"'),
  ]) assert.throws(() => verifyConsignmentSenderBusiness(encodeWindows1251(mutation), frozen, 'address-direct-v1'), SabyError);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SabyClient, SabyError, sabyConfigFromEnv, sabyDocumentWorkflow, sabySafeUrl, type SabyObject } from '../server/saby-client';

const config = { sessionId: 'synthetic-session', customer: { inn: '0000000000', kpp: '000000000', name: 'Тест', address: 'Тест' }, carrier: { inn: '1111111111', kpp: '111111111', name: 'Тест перевозчик', address: 'Тест' } };
type Rpc = { method: string; params: Record<string, SabyObject>; id: number };
function transport(result: (request: Rpc) => unknown) {
  const requests: Rpc[] = [];
  const send: typeof fetch = async (_url, init) => {
    const request = JSON.parse(String(init?.body)) as Rpc; requests.push(request);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: result(request) }));
  };
  return { requests, send };
}
const document = (): SabyObject => ({ Идентификатор: 'doc-synthetic', Тип: 'ConsignmentNote', СсылкаДляНашаОрганизация: 'https://online.saby.ru/document/synthetic', Состояние: { Название: 'Черновик' }, Редакция: [{ Идентификатор: 'old', Актуален: 'Нет' }, { Идентификатор: 'new', Актуален: 'Да' }], Вложение: [{ Идентификатор: 'title-synthetic', Подтип: '1110339', Файл: { Имя: 'title.xml', Ссылка: 'https://disk.saby.ru/synthetic/title' }, Подпись: [] }] });

test('certificate signer defaults copy only current name and position, never signing authority or credentials', () => {
  const signer = { surname: 'Тестов', name: 'Тест', patronymic: '', position: 'Директор' };
  const loaded = sabyConfigFromEnv({ SABY_CONSIGNMENT_SIGNER_JSON: JSON.stringify({ ...signer, status: '1', confirmed: true, password: 'secret' }) });
  assert.deepEqual(loaded.consignmentSigner, signer);
  for (const bad of ['{', '{}', 'null', JSON.stringify({ ...signer, surname: '' }), JSON.stringify({ ...signer, position: 'bad\nposition' })]) assert.equal(sabyConfigFromEnv({ SABY_CONSIGNMENT_SIGNER_JSON: bad }).consignmentSigner, undefined);
});

test('ConsignmentNote write/read request the TMS extended participant and workflow fields', async () => {
  const api = transport(() => document()); const client = new SabyClient(config, api.send);
  await client.writeConsignmentNote({ Тип: 'ConsignmentNote', Номер: 'synthetic' });
  const result = await client.readConsignmentNote('doc-synthetic');
  assert.equal(result.Тип, 'ConsignmentNote');
  assert.equal(api.requests[0].method, 'СБИС.ЗаписатьДокумент');
  assert.equal(api.requests[1].params.Документ.ДопПоля, 'Расширение,ЭПД,Стороны,ТекущиеЭтапы');
  await assert.rejects(client.writeConsignmentNote({ Тип: 'TransportOrder' }), error => error instanceof SabyError && error.kind === 'validation');
  assert.equal(api.requests.length, 2);
});
test('ConsignmentNote read rejects wrong identity or document type', async () => {
  for (const replacement of [{ Тип: 'TransportOrder' }, { Идентификатор: 'different' }]) {
    const client = new SabyClient(config, transport(() => ({ ...document(), ...replacement })).send);
    await assert.rejects(client.readConsignmentNote('doc-synthetic'), error => error instanceof SabyError && error.kind === 'protocol');
  }
});
test('ConsignmentNote finder uses exact marker and preserves the TransportOrder default', async () => {
  const api = transport(() => ({ Документ: [{ Идентификатор: 'correct', Примечание: 'marker' }, { Идентификатор: 'wrong', Примечание: 'other' }], Навигация: { ЕстьЕще: 'Нет' } }));
  const client = new SabyClient(config, api.send);
  assert.equal((await client.findDocuments('marker', '29.09.2026', config.customer, 'N1', 'ConsignmentNote')).length, 1);
  assert.equal(api.requests[0].params.Фильтр.Тип, 'ConsignmentNote');
  await client.findDocuments('marker', '29.09.2026');
  assert.equal(api.requests[1].params.Фильтр.Тип, 'TransportOrder');
});
test('workflow separates remote state from signature and GIS evidence', () => {
  const doc = document(); doc.Состояние = { Название: 'Выполнение завершено успешно' };
  assert.equal(sabyDocumentWorkflow(doc).signatureStatus, 'not_signed');
  assert.equal(sabyDocumentWorkflow(doc).gisStatus, null);
  const attachment = (doc.Вложение as SabyObject[])[0];
  attachment.Подпись = [{ Сертификат: { ФИО: 'Не является доказательством подписи' } }];
  assert.equal(sabyDocumentWorkflow(doc).signatureStatus, 'not_signed');
  attachment.Подпись = [{ Файл: { Ссылка: 'https://disk.saby.ru/synthetic/signature' } }];
  doc.ГИС_УИД = 'synthetic-gis-id';
  doc.КодПеревозки = [{ НазваниеФазы: 'Завершен' }];
  doc.ТекущиеЭтапы = [{ Действие: [{ Название: 'Погружен' }] }];
  const workflow = sabyDocumentWorkflow(doc);
  assert.equal(workflow.signatureStatus, 'reported_by_saby');
  assert.match(workflow.gisStatus!, /идентификатор ГИС ЭПД/);
  assert.equal(workflow.revision, 'new');
  assert.deepEqual(workflow.availableActions, ['Погружен']);
  assert.deepEqual(workflow.attachments[0], { id: 'title-synthetic', name: 'title.xml', extension: 'xml' });
  assert.match(workflow.attachments[1].id, /^signature:title-synthetic:0:[a-f0-9]{24}$/);
  assert.equal(workflow.attachments[1].extension, 'sgn');
  assert.ok(!JSON.stringify(workflow).includes('disk.saby.ru'));
  assert.ok(!JSON.stringify(workflow).includes('synthetic-gis-id'));
  doc.ЧастичныеДанные = 'Да'; attachment.Подпись = [];
  assert.equal(sabyDocumentWorkflow(doc).signatureStatus, 'unknown');
});
test('safe URLs reject credentials, lookalike hosts, ports, redirects by syntax and non-HTTPS schemes', () => {
  for (const url of ['https://saby.ru.attacker.example/x', 'https://attacker-saby.ru/x', 'http://disk.saby.ru/x', 'file:///etc/passwd', 'https://user:pass@disk.saby.ru/x', 'https://disk.saby.ru:8443/x', 'https://disk.saby.ru\\@attacker.example/x', 'https://127.0.0.1/x', 'https://online.saby.ru/doc?session_id=private', 'https://online.saby.ru/doc?%70assword=private']) assert.equal(sabySafeUrl(url), null, url);
  assert.equal(sabySafeUrl('https://disk.saby.ru/synthetic'), 'https://disk.saby.ru/synthetic');
  assert.equal(sabySafeUrl('https://online.sbis.ru/synthetic'), 'https://online.sbis.ru/synthetic');
});
test('download resolves an attachment ID through fresh read and uses the account session only on safe origin', async () => {
  const api = transport(() => document()); const gets: { url: string; init: RequestInit }[] = [];
  const send: typeof fetch = async (url, init) => {
    if (init?.method !== 'GET') return api.send(url, init);
    gets.push({ url: String(url), init }); return new Response('<synthetic/>', { headers: { 'content-type': 'application/xml' } });
  };
  const file = await new SabyClient(config, send).downloadAttachment('doc-synthetic', 'title-synthetic');
  assert.equal(new TextDecoder().decode(file.bytes), '<synthetic/>');
  assert.equal(file.name, 'title.xml'); assert.equal(file.mimeType, 'application/xml');
  assert.equal(gets[0].url, 'https://disk.saby.ru/synthetic/title');
  assert.equal(gets[0].init.redirect, 'error');
  assert.equal(new Headers(gets[0].init.headers).get('X-SBISSessionID'), config.sessionId);
  assert.equal(api.requests[0].method, 'СБИС.ПрочитатьДокумент');
});
test('download never calls a provider URL for missing, deleted or hostile attachments', async () => {
  for (const change of [{ Идентификатор: 'other' }, { Удален: 'Да' }, { Файл: { Ссылка: 'https://attacker.example/steal' } }]) {
    const doc = document(); Object.assign((doc.Вложение as SabyObject[])[0], change);
    const api = transport(() => doc); const client = new SabyClient(config, api.send);
    await assert.rejects(client.downloadAttachment('doc-synthetic', 'title-synthetic'), SabyError);
    assert.equal(api.requests.length, 1);
  }
});
test('download rejects a changed revision before fetching bytes', async () => {
  const api = transport(() => document()); const client = new SabyClient(config, api.send);
  await assert.rejects(client.downloadAttachment('doc-synthetic', 'title-synthetic', 'old'), error => error instanceof SabyError && error.kind === 'validation');
  assert.equal(api.requests.length, 1);
});
test('signatures, provider PDF and archive downloads remain bound to the current document revision', async () => {
  const doc = document(); const attachment = (doc.Вложение as SabyObject[])[0];
  attachment.Подпись = [{ Файл: { Имя: 'title.xml.sgn', Ссылка: 'https://disk.saby.ru/synthetic/signature' } }];
  attachment.СсылкаНаPDF = 'https://online.sbis.ru/synthetic/attachment-pdf';
  doc.СсылкаНаPDF = 'https://tms.saby.ru/synthetic/pdf'; doc.СсылкаНаАрхив = 'https://disk.saby.ru/synthetic/archive';
  const api = transport(() => doc); const gets: string[] = [];
  const send: typeof fetch = async (url, init) => { if (init?.method !== 'GET') return api.send(url, init); gets.push(String(url)); return new Response('synthetic'); };
  const client = new SabyClient(config, send);
  const files = sabyDocumentWorkflow(doc).attachments;
  assert.deepEqual(files.map(file => file.extension), ['xml', 'sgn', 'pdf', 'pdf', 'zip']);
  for (const file of files.slice(1)) assert.equal((await client.downloadAttachment('doc-synthetic', file.id, 'new')).name, file.name);
  assert.equal(gets.length, 4);
  assert.ok(!JSON.stringify(files).includes('https://'));
});
test('PDF and archive identities change with new signatures even if document revision does not; expiring URL refresh does not change identities', async () => {
  const doc = document(); const attachment = (doc.Вложение as SabyObject[])[0];
  doc.СсылкаНаPDF = 'https://tms.saby.ru/synthetic/pdf'; doc.СсылкаНаАрхив = 'https://tms.saby.ru/synthetic/archive';
  const before = sabyDocumentWorkflow(doc);
  doc.СсылкаНаPDF = 'https://tms.saby.ru/synthetic/pdf?expire_date=later';
  assert.deepEqual(sabyDocumentWorkflow(doc).attachments, before.attachments);
  attachment.Подпись = [{ Сертификат: { Отпечаток: 'synthetic-certificate' }, Файл: { Имя: 'title.xml.sgn', Ссылка: 'https://disk.saby.ru/synthetic/signature' } }];
  const after = sabyDocumentWorkflow(doc);
  assert.equal(before.revision, after.revision);
  assert.notEqual(before.attachments.find(file => file.extension === 'pdf')!.id, after.attachments.find(file => file.extension === 'pdf')!.id);
  const api = transport(() => doc);
  await assert.rejects(new SabyClient(config, api.send).downloadAttachment('doc-synthetic', before.attachments.find(file => file.extension === 'pdf')!.id, 'new'), error => error instanceof SabyError && error.kind === 'validation');
  assert.equal(api.requests.length, 1);
});
test('download rejects oversized or incomplete files and never follows a redirect', async () => {
  for (const response of [new Response('', { status: 302, headers: { location: 'https://attacker.example' } }), new Response('oversize', { headers: { 'content-length': String(61 * 1024 * 1024) } })]) {
    const api = transport(() => document());
    const send: typeof fetch = (url, init) => init?.method === 'GET' ? Promise.resolve(response) : api.send(url, init);
    await assert.rejects(new SabyClient(config, send).downloadAttachment('doc-synthetic', 'title-synthetic'), SabyError);
  }
});
test('certificate reads do not request activation, signature or write; registered local certificates preserve their type', async () => {
  const certificate = { Certificate: { Type: 'Client', CertificateInfo: { IsQualified: true, IsValid: true } } };
  const api = transport(request => request.method === 'СБИС.СписокСертификатов' ? { Сертификат: [] } : [certificate]);
  const client = new SabyClient(config, api.send);
  assert.deepEqual(await client.listCertificates(), []);
  assert.deepEqual(await client.listRegisteredCertificates(), [certificate]);
  assert.deepEqual(api.requests.map(request => request.method), ['СБИС.СписокСертификатов', 'sabyCertificate.List']);
  assert.equal(api.requests[1].params.Parameter.AddTrustedCertificates, true);
});

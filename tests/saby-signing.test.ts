import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { SabyClient, SabyError, sabyConfigFromEnv, type SabyObject } from '../server/saby-client';
import { captureSignedTitle, createCarrierDraftBinding, createSigningBinding, normalizeSigningCertificate, prepareBoundSigning, prepareCarrierDraft, readSigningEvidence, signingActionRequest, signingCertificateForOrganization, signingManifestHash, type SabyPreparedSigning, type SabySigningKeyType, type SabySigningSide } from '../server/saby-signing';

const fp = 'a'.repeat(40);
const config = { sessionId: 'synthetic-sender-session', login: 'synthetic-login', password: 'synthetic-password', accountNumber: 'synthetic-sender', carrierAccountNumber: 'synthetic-carrier',
  customer: { inn: '0000000000', kpp: '000000000', name: 'Synthetic sender', address: 'Synthetic' }, carrier: { inn: '1111111111', kpp: '111111111', name: 'Synthetic carrier', address: 'Synthetic' } };
const bytes = Buffer.from('<synthetic-final>payload</synthetic-final>');
const digest = (input: Uint8Array) => createHash('sha256').update(input).digest('hex');
const certificateRow = (side: SabySigningSide = 'sender'): SabyObject => {
  const org = side === 'sender' ? config.customer : config.carrier;
  return { Certificate: { Type: 'Client', IsMobile: false, CertificateInfo: { Thumbprint: fp, IsValid: true, IsQualified: true, NotBefore: '2020-01-01 00:00:00 UTC', NotAfter: '2099-01-01 00:00:00 UTC', SubjectName: { '1.2.643.100.4': org.inn, '2.5.4.4': 'Synthetic', '2.5.4.42': 'Owner' } } }, OurCompany: { Inn: org.inn, Kpp: org.kpp } };
};
function document(side: SabySigningSide = 'sender', signed = false): SabyObject {
  const org = side === 'sender' ? config.customer : config.carrier; const other = side === 'sender' ? config.carrier : config.customer;
  const stage = { Идентификатор: 'stage-synthetic', Название: side === 'sender' ? 'Отправка' : 'Утверждение', Действие: [{ Название: side === 'sender' ? 'Отправить' : 'Утвердить', ТребуетПодписания: 'Да' }] };
  return { Идентификатор: 'document-synthetic', Тип: 'TransportOrder', Направление: side === 'sender' ? 'Исходящий' : 'Входящий',
    НашаОрганизация: { СвЮЛ: { ИНН: org.inn, КПП: org.kpp } }, Контрагент: { СвЮЛ: { ИНН: other.inn, КПП: other.kpp } },
    Редакция: [{ Идентификатор: 'revision-synthetic', Актуален: 'Да' }], Этап: [stage], ТекущиеЭтапы: [{ Идентификатор: stage.Идентификатор, Наименование: stage.Название }],
    Состояние: { Код: signed ? '7' : side === 'sender' ? '0' : '10' }, Вложение: [{ Идентификатор: 'title-synthetic', Подтип: side === 'sender' ? '1110361' : '1110362', ВерсияФормата: '5.01', Направление: 'Исходящий',
      Файл: { Имя: 'synthetic.xml', Ссылка: 'https://disk.saby.ru/synthetic/title' }, Подпись: signed ? [{ Сертификат: { Отпечаток: fp, ИНН: org.inn }, Файл: { Имя: 'synthetic.xml.sgn', Ссылка: 'https://disk.saby.ru/synthetic/signature' } }] : [] }] };
}
function preparation(doc: SabyObject): SabyObject {
  const result = structuredClone(doc);
  const stage = (result.Этап as SabyObject[])[0];
  stage.Вложение = (result.Вложение as SabyObject[]).map(file => ({ ...file, ТребуемоеДействие: 'Подписать', Модифицирован: 'Да' }));
  return result;
}
function advertiseAutomaticSigning(doc: SabyObject, asArray = false): SabyObject {
  const action = ((doc.Этап as SabyObject[])[0].Действие as SabyObject[])[0];
  const certificate = { Отпечаток: fp.toUpperCase(), Ключ: { Тип: 'Отложенный', Активирован: 'Да' } };
  action.Сертификат = asArray ? [certificate] : certificate;
  return doc;
}
function prepared(side: SabySigningSide = 'sender', keyType?: SabySigningKeyType): SabyPreparedSigning {
  const doc = keyType === 'Отложенный' ? advertiseAutomaticSigning(document(side)) : document(side);
  const binding = createSigningBinding(doc, side, normalizeSigningCertificate(certificateRow(side))!, config, keyType);
  const attachments = [{ id: 'title-synthetic', name: 'synthetic.xml', subtype: binding.attachmentSubtype, sha256: digest(bytes), bytes }];
  return { binding, attachments, preparedHash: signingManifestHash({ binding, attachments }) };
}
type Request = { method: string; params: Record<string, SabyObject>; id: number; session: string | null };
function api(side: SabySigningSide = 'sender', options: { signed?: boolean; alteredBytes?: boolean; onRequest?: (request: Request) => unknown } = {}) {
  const requests: Request[] = []; const gets: string[] = [];
  const send: typeof fetch = async (url, init) => {
    if (init?.method === 'GET') { gets.push(String(url)); return new Response(options.alteredBytes ? 'modified' : bytes); }
    const request = { ...JSON.parse(String(init?.body)), session: new Headers(init?.headers).get('X-SBISSessionID') } as Request; requests.push(request);
    const override = options.onRequest?.(request);
    const result = override !== undefined ? override : request.method === 'СБИС.Аутентифицировать' ? 'synthetic-carrier-session' : request.method === 'sabyCertificate.Read' ? certificateRow(side) : request.method === 'sabyCertificate.List' ? [certificateRow(side)] : request.method === 'СБИС.ПодготовитьДействие' ? preparation(document(side)) : document(side, options.signed);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }));
  };
  return { client: new SabyClient(config, send), requests, gets };
}

test('certificate normalization ties both certificate subject and account organization, with explicit validity', () => {
  const cert = normalizeSigningCertificate(certificateRow())!;
  assert.equal(cert.ownerName, 'Synthetic Owner'); assert.equal(cert.type, 'Client');
  assert.equal(signingCertificateForOrganization(certificateRow(), config.customer)?.thumbprint, fp);
  assert.equal(signingCertificateForOrganization(certificateRow(), config.carrier), null);
  const invalid = certificateRow(); (invalid.OurCompany as SabyObject).Inn = config.carrier.inn;
  assert.equal(normalizeSigningCertificate(invalid), null);
  const expired = certificateRow(); ((expired.Certificate as SabyObject).CertificateInfo as SabyObject).NotAfter = '2000-01-01 00:00:00 UTC';
  assert.equal(signingCertificateForOrganization(expired, config.customer), null);
  const unqualified = certificateRow(); ((unqualified.Certificate as SabyObject).CertificateInfo as SabyObject).IsQualified = false;
  assert.equal(signingCertificateForOrganization(unqualified, config.customer), null);
});

test('binding uses current stage summary IDs and fails on wrong side, historical stage, ambiguous revision or signed title', () => {
  for (const side of ['sender', 'carrier'] as const) assert.equal(prepared(side).binding.attachmentSubtype, side === 'sender' ? '1110361' : '1110362');
  for (const mutate of [
    (doc: SabyObject) => { doc.ТекущиеЭтапы = [{ Идентификатор: 'another-stage' }]; },
    (doc: SabyObject) => { doc.Редакция = [{ Идентификатор: 'one' }, { Идентификатор: 'two' }]; },
    (doc: SabyObject) => { doc.НашаОрганизация = { СвЮЛ: { ИНН: config.carrier.inn, КПП: config.carrier.kpp } }; },
    (doc: SabyObject) => { doc.Вложение = document('sender', true).Вложение; },
  ]) {
    const doc = document(); mutate(doc);
    assert.throws(() => createSigningBinding(doc, 'sender', normalizeSigningCertificate(certificateRow())!, config), SabyError);
  }
});

test('prepare uses exact revision and stage and returns only explicitly signable final bytes', async () => {
  const fake = api(); const result = await prepareBoundSigning(fake.client, prepared().binding);
  assert.equal(result.preparedHash, prepared().preparedHash);
  const prepare = fake.requests.find(row => row.method === 'СБИС.ПодготовитьДействие')!;
  assert.deepEqual(prepare.params.Документ.Редакция, { Идентификатор: 'revision-synthetic' });
  assert.equal(prepare.params.Документ.Идентификатор, undefined);
  assert.equal((prepare.params.Документ.Этап as SabyObject).Идентификатор, 'stage-synthetic');
  assert.equal(fake.requests.filter(row => row.method === 'СБИС.ВыполнитьДействие').length, 0);
});

test('preparation never guesses absent required-file flags and does not execute', async () => {
  const fake = api('sender', { onRequest: request => request.method === 'СБИС.ПодготовитьДействие' ? document() : undefined });
  await assert.rejects(prepareBoundSigning(fake.client, prepared().binding), (error: unknown) => error instanceof SabyError && error.uncertain);
  assert.equal(fake.requests.filter(row => row.method === 'СБИС.ВыполнитьДействие').length, 0);
});

test('deferred execute sends exact prepared files, requires confirmation, and isolates carrier account', async () => {
  const fake = api('carrier'); await fake.client.executeDeferredSigning(prepared('carrier'));
  const execute = fake.requests.find(row => row.method === 'СБИС.ВыполнитьДействие')!;
  assert.equal(execute.session, 'synthetic-carrier-session');
  const stage = execute.params.Документ.Этап as SabyObject;
  assert.equal(((stage.Действие as SabyObject[])[0].Сертификат as SabyObject).Отпечаток, fp);
  assert.deepEqual(((stage.Действие as SabyObject[])[0].Сертификат as SabyObject).Ключ, { Тип: 'ОтложенныйСПодтверждением' });
  const file = ((stage.Вложение as SabyObject[])[0].Файл as SabyObject);
  assert.equal(file.ДвоичныеДанные, bytes.toString('base64'));
  assert.equal(execute.params.Документ.Идентификатор, undefined);
});

test('changed bytes, invalid manifest or stale stage cannot reach execute', async () => {
  const modified = api('sender', { alteredBytes: true });
  await assert.rejects(modified.client.executeDeferredSigning(prepared()), SabyError);
  assert.equal(modified.requests.filter(row => row.method === 'СБИС.ВыполнитьДействие').length, 0);
  const tampered = prepared(); tampered.attachments[0].bytes = Buffer.from('other');
  assert.throws(() => signingActionRequest(tampered.binding, tampered), SabyError);
  const hashTampered = prepared(); hashTampered.binding.stageId = 'another-stage';
  assert.throws(() => signingActionRequest(hashTampered.binding, hashTampered), SabyError);
});

test('uncertain prepare and execute errors are never blindly retried', async () => {
  for (const method of ['СБИС.ПодготовитьДействие', 'СБИС.ВыполнитьДействие']) {
    const fake = api('sender', { onRequest: request => { if (request.method === method) throw new Error('synthetic timeout'); } });
    await assert.rejects(method === 'СБИС.ПодготовитьДействие' ? prepareBoundSigning(fake.client, prepared().binding) : fake.client.executeDeferredSigning(prepared()), (error: unknown) => error instanceof SabyError && error.uncertain);
    assert.equal(fake.requests.filter(row => row.method === method).length, 1);
  }
});

test('read-back requires final state, the target title, exact content and the chosen organization signature', async () => {
  for (const side of ['sender', 'carrier'] as const) {
    assert.equal((await readSigningEvidence(api(side, { signed: true }).client, prepared(side))).state, 'confirmed');
    assert.equal((await readSigningEvidence(api(side).client, prepared(side))).state, 'unconfirmed');
    assert.equal((await readSigningEvidence(api(side, { signed: true, alteredBytes: true }).client, prepared(side))).state, 'changed');
  }
  for (const change of [
    (doc: SabyObject) => { (((doc.Вложение as SabyObject[])[0].Подпись as SabyObject[])[0].Сертификат as SabyObject).Отпечаток = 'b'.repeat(40); },
    (doc: SabyObject) => { (((doc.Вложение as SabyObject[])[0].Подпись as SabyObject[])[0].Сертификат as SabyObject).ИНН = config.carrier.inn; },
  ]) {
    const fake = api('sender', { onRequest: request => { if (request.method !== 'СБИС.ПрочитатьДокумент') return; const doc = document('sender', true); change(doc); return doc; } });
    assert.equal((await readSigningEvidence(fake.client, prepared())).state, 'changed');
  }
  const pending = api('carrier', { onRequest: request => { if (request.method !== 'СБИС.ПрочитатьДокумент') return; const doc = document('carrier', true); doc.Состояние = { Код: '23' }; return doc; } });
  assert.equal((await readSigningEvidence(pending.client, prepared('carrier'))).state, 'pending');
});

test('unsigned original stages are unconfirmed; only provider state 23 proves a waiting queue', async () => {
  for (const side of ['sender', 'carrier'] as const) {
    for (const code of [side === 'sender' ? '0' : '10', '23']) {
      const fake = api(side, { onRequest: request => {
        if (request.method !== 'СБИС.ПрочитатьДокумент') return;
        const doc = document(side); doc.Состояние = { Код: code }; return doc;
      } });
      const evidence = await readSigningEvidence(fake.client, prepared(side));
      assert.equal(evidence.state, code === '23' ? 'pending' : 'unconfirmed');
      assert.ok(fake.requests.every(row => ['СБИС.Аутентифицировать', 'СБИС.ПрочитатьДокумент'].includes(row.method)));
    }
  }
});

test('explicit automatic mode is immutable in the manifest and appears only in execution wire payload', async () => {
  for (const side of ['sender', 'carrier'] as const) {
    const fake = api(side, { onRequest: request => {
      if (request.method === 'СБИС.ПрочитатьДокумент') return advertiseAutomaticSigning(document(side), true);
      if (request.method === 'СБИС.ПодготовитьДействие') return preparation(advertiseAutomaticSigning(document(side)));
    } });
    const binding = prepared(side, 'Отложенный').binding;
    const result = await prepareBoundSigning(fake.client, binding);
    assert.equal(result.binding.keyType, 'Отложенный');
    const prepare = fake.requests.find(row => row.method === 'СБИС.ПодготовитьДействие')!;
    assert.equal((((prepare.params.Документ.Этап as SabyObject).Действие as SabyObject).Сертификат as SabyObject).Ключ, undefined);
    await fake.client.executeDeferredSigning(result);
    const execute = fake.requests.find(row => row.method === 'СБИС.ВыполнитьДействие')!;
    assert.deepEqual((((execute.params.Документ.Этап as SabyObject).Действие as SabyObject[])[0].Сертификат as SabyObject).Ключ, { Тип: 'Отложенный' });
    assert.equal(fake.requests.filter(row => row.method === 'СБИС.ВыполнитьДействие').length, 1);
    const modified = structuredClone(result); modified.binding.keyType = 'ОтложенныйСПодтверждением';
    assert.throws(() => signingActionRequest(modified.binding, modified), SabyError);
    delete modified.binding.keyType;
    assert.throws(() => signingActionRequest(modified.binding, modified), SabyError);
  }
  const legacy = prepared();
  assert.equal(legacy.preparedHash, 'baeb825f2a843c04f3891c9339ca9b79fcb2295e5211f3a6d6322ba61988e675');
  const explicitConfirmation = prepared('sender', 'ОтложенныйСПодтверждением');
  assert.notEqual(legacy.preparedHash, explicitConfirmation.preparedHash);
  assert.notEqual(legacy.preparedHash, prepared('sender', 'Отложенный').preparedHash);
  const invalid = { ...legacy.binding, keyType: 'Серверный' as SabySigningKeyType };
  assert.throws(() => signingActionRequest(invalid), SabyError);
  // Completed documents no longer advertise actionable certificate capabilities.
  assert.equal((await readSigningEvidence(api('sender', { signed: true }).client, prepared('sender', 'Отложенный'))).state, 'confirmed');
});

test('automatic mode requires advertised selected-certificate capability and stops if it changes before execute', async () => {
  const certificate = normalizeSigningCertificate(certificateRow())!;
  const unsupported: Array<(action: SabyObject) => void> = [
    action => { delete action.Сертификат; },
    action => { action.Сертификат = { Отпечаток: fp }; },
    action => { action.Сертификат = { Отпечаток: 'b'.repeat(40), Ключ: { Тип: 'Отложенный' } }; },
    action => { action.Сертификат = { Отпечаток: fp, Ключ: { Тип: 'ОтложенныйСПодтверждением' } }; },
    action => { action.Сертификат = { Отпечаток: fp, Ключ: { Тип: 'Отложенный', Активирован: 'Нет' } }; },
    action => { action.Сертификат = [action.Сертификат, action.Сертификат]; },
  ];
  for (const mutate of unsupported) {
    const doc = advertiseAutomaticSigning(document()); mutate(((doc.Этап as SabyObject[])[0].Действие as SabyObject[])[0]);
    assert.throws(() => createSigningBinding(doc, 'sender', certificate, config, 'Отложенный'), SabyError);
    // Missing old metadata must not make legacy confirmation intents unreadable or unexecutable.
    assert.equal(createSigningBinding(doc, 'sender', certificate, config).keyType, undefined);
    const fake = api('sender', { onRequest: request => request.method === 'СБИС.ПрочитатьДокумент' ? doc : undefined });
    await assert.rejects(fake.client.executeDeferredSigning(prepared('sender', 'Отложенный')), SabyError);
    assert.equal(fake.requests.filter(row => row.method === 'СБИС.ВыполнитьДействие').length, 0);
  }
  let reads = 0;
  const fake = api('sender', { onRequest: request => {
    if (request.method === 'СБИС.ПрочитатьДокумент') return ++reads === 1 ? advertiseAutomaticSigning(document()) : document();
  } });
  await assert.rejects(fake.client.executeDeferredSigning(prepared('sender', 'Отложенный')), SabyError);
  assert.equal(fake.requests.filter(row => row.method === 'СБИС.ВыполнитьДействие').length, 0);
});

test('automatic carrier draft keeps mode but cannot execute until the real reply has been prepared', () => {
  const binding = createCarrierDraftBinding(advertiseAutomaticSigning(carrierWithoutReply()), normalizeSigningCertificate(certificateRow('carrier'))!, config, 'Отложенный');
  assert.equal(binding.keyType, 'Отложенный');
  assert.equal(binding.attachmentId, 'unprepared-carrier-title');
  const pending = prepared('carrier', 'Отложенный'); pending.binding = binding;
  assert.throws(() => signingActionRequest(binding, pending), SabyError);
});

test('Saby config parses automatic policy without changing legacy default', () => {
  assert.equal(sabyConfigFromEnv({}).automaticSigning, undefined);
  assert.equal(sabyConfigFromEnv({}).automaticSigningError, undefined);
  assert.equal(sabyConfigFromEnv({ SABY_AUTO_SIGNING_JSON: 'invalid' }).automaticSigning, undefined);
  assert.ok(sabyConfigFromEnv({ SABY_AUTO_SIGNING_JSON: 'invalid' }).automaticSigningError);
});

test('a previously signed sender title is capturable by reads and cannot become a write request', async () => {
  const fake = api('sender', { signed: true });
  const manifest = await captureSignedTitle(fake.client, 'sender', document('sender', true), normalizeSigningCertificate(certificateRow())!);
  assert.equal(manifest.binding.stageId, 'observed-signed');
  assert.equal((await readSigningEvidence(fake.client, manifest)).state, 'confirmed');
  assert.throws(() => signingActionRequest(manifest.binding), SabyError);
  assert.ok(fake.requests.every(row => ['sabyCertificate.List', 'sabyCertificate.Read', 'СБИС.ПрочитатьДокумент'].includes(row.method)));
});

test('certificate discovery checks all pages and never changes keys or starts signing', async () => {
  const fake = api('carrier', { onRequest: request => request.method === 'sabyCertificate.List' ? request.params.Parameter.PageNumber === 0 ? Array.from({ length: 20 }, () => certificateRow('carrier')) : [certificateRow('carrier')] : undefined });
  assert.equal((await fake.client.listSigningCertificates('carrier')).length, 21);
  assert.deepEqual(fake.requests.filter(row => row.method === 'sabyCertificate.List').map(row => row.params.Parameter.PageNumber), [0, 1]);
  assert.ok(fake.requests.filter(row => row.method !== 'СБИС.Аутентифицировать').every(row => row.session === 'synthetic-carrier-session'));
});

test('request guard is checked again immediately before execute and refuses revoked access', async () => {
  const fake = api();
  const client = fake.client.withRequestGuard(async () => {
    if (fake.gets.length === 1 && fake.requests.filter(row => row.method === 'СБИС.ПрочитатьДокумент').length === 3) throw new SabyError('permission', 'Synthetic access revoked');
  });
  await assert.rejects(client.executeDeferredSigning(prepared()), (error: unknown) => error instanceof SabyError && error.kind === 'permission' && !error.uncertain);
  assert.equal(fake.requests.filter(row => row.method === 'СБИС.ВыполнитьДействие').length, 0);
});
test('revoked certificate trust blocks execute even if Read still exposes valid public metadata', async () => {
  const fake = api('sender', { onRequest: request => request.method === 'sabyCertificate.List' ? [] : undefined });
  await assert.rejects(fake.client.executeDeferredSigning(prepared()), (error: unknown) => error instanceof SabyError && error.kind === 'permission');
  assert.equal(fake.requests.filter(row => row.method === 'СБИС.ВыполнитьДействие').length, 0);
});

function carrierWithoutReply(): SabyObject {
  const doc = document('carrier'); doc.Состояние = { Код: '10' };
  const sender = structuredClone((document('sender', true).Вложение as SabyObject[])[0]);
  sender.Направление = 'Входящий'; sender.Идентификатор = 'sender-title-synthetic';
  doc.Вложение = [sender]; return doc;
}
test('missing carrier reply uses documented preparation with one durable intent, never execute or invented generator', async () => {
  let generated = false;
  const fake = api('carrier', { onRequest: request => {
    if (request.method === 'СБИС.ПодготовитьДействие') { generated = true; return preparation(document('carrier')); }
    if (request.method === 'СБИС.ПрочитатьДокумент') return generated ? document('carrier') : carrierWithoutReply();
  } });
  const binding = createCarrierDraftBinding(carrierWithoutReply(), normalizeSigningCertificate(certificateRow('carrier'))!, config);
  assert.equal(binding.attachmentId, 'unprepared-carrier-title');
  const result = await prepareCarrierDraft(fake.client, binding);
  assert.equal((result.Вложение as SabyObject[])[0].Подтип, '1110362');
  assert.equal(fake.requests.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 1);
  assert.equal(fake.requests.filter(row => row.method === 'СБИС.ВыполнитьДействие' || row.method === 'СБИС.СгенерироватьВложение').length, 0);
  assert.throws(() => createCarrierDraftBinding(document('carrier'), normalizeSigningCertificate(certificateRow('carrier'))!, config), SabyError);
});
test('missing carrier reply preparation stops on unsigned source or lost response and is never automatically retried', async () => {
  const unsigned = carrierWithoutReply(); (unsigned.Вложение as SabyObject[])[0].Подпись = [];
  assert.throws(() => createCarrierDraftBinding(unsigned, normalizeSigningCertificate(certificateRow('carrier'))!, config), SabyError);
  const binding = createCarrierDraftBinding(carrierWithoutReply(), normalizeSigningCertificate(certificateRow('carrier'))!, config);
  const fake = api('carrier', { onRequest: request => {
    if (request.method === 'СБИС.ПодготовитьДействие') throw new Error('synthetic lost response');
    if (request.method === 'СБИС.ПрочитатьДокумент') return carrierWithoutReply();
  } });
  await assert.rejects(prepareCarrierDraft(fake.client, binding), (error: unknown) => error instanceof SabyError && error.uncertain);
  assert.equal(fake.requests.filter(row => row.method === 'СБИС.ПодготовитьДействие').length, 1);
});
test('read-back rejects signature errors and conflicting structured states, while accepting legacy state shape', async () => {
  for (const mode of ['error', 'conflicting', 'legacy']) {
    const fake = api('sender', { onRequest: request => {
      if (request.method !== 'СБИС.ПрочитатьДокумент') return;
      const doc = document('sender', true);
      if (mode === 'error') (((doc.Вложение as SabyObject[])[0].Подпись as SabyObject[])[0]).КоличествоОшибок = 1;
      if (mode === 'conflicting') doc.Код = { Состояние: '23' };
      if (mode === 'legacy') { delete doc.Состояние; doc.Код = { Состояние: '7' }; }
      return doc;
    } });
    assert.equal((await readSigningEvidence(fake.client, prepared())).state, mode === 'legacy' ? 'confirmed' : 'changed');
  }
});

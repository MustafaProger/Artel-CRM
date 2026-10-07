import assert from 'node:assert/strict';
import test from 'node:test';
import { SabyClient, SabyError, type SabyObject } from '../server/saby-client';

const fingerprint = 'ab'.repeat(20);
const config = { sessionId: 'synthetic-session', customer: { inn: '0000000000', kpp: '000000000', name: 'Тест', address: 'Тест' }, carrier: { inn: '1111111111', kpp: '111111111', name: 'Тест перевозчик', address: 'Тест' } };
function fixture(inline = true) {
  const signature: SabyObject = { Сертификат: { Отпечаток: fingerprint }, Файл: inline ? { ДвоичныеДанные: 'c3ludGhldGlj' } : { Имя: 'title.sgn', Ссылка: 'https://disk.saby.ru/synthetic/source.sgn' } };
  const title: SabyObject = { Идентификатор: 'source-title', Подтип: '1110339', ВерсияФормата: '5.01', Файл: { Имя: 'title.xml' }, Подпись: [signature] };
  const document: SabyObject = { Идентификатор: 'synthetic-document', Тип: 'ConsignmentNote', Редакция: [{ Идентификатор: 'current', Актуален: 'Да' }], Вложение: [title] };
  const requests: string[] = [];
  let returned = Buffer.from('synthetic');
  const send: typeof fetch = async (url, init) => {
    if (init?.method === 'GET') {
      requests.push(String(url)); assert.equal(init.redirect, 'error'); assert.equal(new Headers(init.headers).get('X-SBISSessionID'), 'synthetic-session');
      return new Response(returned);
    }
    const request = JSON.parse(String(init?.body)); requests.push(request.method); assert.equal(request.method, 'СБИС.ПрочитатьДокумент');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result: document }));
  };
  const read = () => new SabyClient(config, send).downloadSigningSignature('sender', 'synthetic-document', 'source-title', 'current', fingerprint, 'ConsignmentNote');
  return { document, title, signature, requests, read, setBytes: (bytes: Buffer) => { returned = bytes; } };
}

test('source signature reads current exact title and canonical inline bytes without a second URL', async () => {
  const f = fixture(); assert.deepEqual(await f.read(), Buffer.from('synthetic'));
  assert.deepEqual(f.requests, ['СБИС.ПрочитатьДокумент']);
});

test('source signature resolves provider link through existing bounded same-account download', async () => {
  const f = fixture(false); assert.deepEqual(Buffer.from(await f.read()), Buffer.from('synthetic'));
  assert.deepEqual(f.requests, ['СБИС.ПрочитатьДокумент', 'https://disk.saby.ru/synthetic/source.sgn']);
});

test('source signature refuses stale, ambiguous, deleted or wrong-source evidence before download', async () => {
  const changes: ((f: ReturnType<typeof fixture>) => void)[] = [
    f => { f.document.Редакция = [{ Идентификатор: 'other', Актуален: 'Да' }]; },
    f => { (f.document.Редакция as SabyObject[]).push({ Идентификатор: 'duplicate', Актуален: 'Да' }); },
    f => { f.document.ЧастичныеДанные = 'Да'; },
    f => { f.document.КоличествоОшибок = 1; },
    f => { f.document.Вложение = [f.title, structuredClone(f.title)]; },
    f => { f.title.Редакция = { Идентификатор: 'other' }; },
    f => { f.title.Подтип = '1110340'; },
    f => { f.title.Удален = 'Да'; },
    f => { f.title.Подпись = [f.signature, structuredClone(f.signature)]; },
    f => { f.signature.Сертификат = { Отпечаток: 'cd'.repeat(20) }; },
    f => { f.signature.Ошибка = { Код: 'synthetic-error' }; },
    f => { f.signature.Актуален = 'Нет'; },
  ];
  for (const change of changes) { const f = fixture(false); change(f); await assert.rejects(f.read(), SabyError); assert.deepEqual(f.requests, ['СБИС.ПрочитатьДокумент']); }
});

test('source signature rejects malformed inline base64 instead of silently falling back to URL', async () => {
  for (const value of ['', 'Zh==', 'c3ludGhldGlj=', 'c3ludGhldGlj\n', 'c3ludGhldGl', null, 12]) {
    const f = fixture(false); (f.signature.Файл as SabyObject).ДвоичныеДанные = value;
    await assert.rejects(f.read(), SabyError); assert.deepEqual(f.requests, ['СБИС.ПрочитатьДокумент']);
  }
});

test('source signature rejects unsafe download origin and empty signature bytes', async () => {
  const hostile = fixture(false); (hostile.signature.Файл as SabyObject).Ссылка = 'https://attacker.example/signature';
  await assert.rejects(hostile.read(), SabyError); assert.deepEqual(hostile.requests, ['СБИС.ПрочитатьДокумент']);
  const empty = fixture(false); empty.setBytes(Buffer.alloc(0)); await assert.rejects(empty.read(), SabyError);
});

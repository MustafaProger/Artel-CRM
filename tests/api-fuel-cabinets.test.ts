import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FuelCabinetClient, fuelMoney, parseNatcarBalances, parseRosneftBalance } from '../server/fuel-cabinet-client';
import { encryptCabinetCredentials, syncCabinetConnection, validateCabinets } from '../server/cabinet-connections';
import { OperationsStore } from '../server/operations-store';
import { loadSnapshot } from '../server/local-api';
const credentials = { login: 'test-only-login', password: 'test-only-password' };
const row = (pk: number, name: string, amount: number | string = '-15.27') => ({ pk, name, contract_name: null, ballance_with_discount: amount });
const rn = (id = '31') => `<select id="contract-list-box"><option ${id === '31' ? 'selected="selected"' : ''} value="31">QA-1</option><option ${id === '32' ? 'selected="selected"' : ''} value="32">QA-2</option></select><div id="balance-widget-container"><h2>Баланс</h2><div class="currency-RUR">1 234,56</div>${['Собственные средства', 'Заблокировано', 'Неснижаемый остаток'].map((label, i) => `<div><div>${label}</div><div>${[1300, 60, 5.44][i]}</div></div>`).join('')}</div><div class="card">Next widget</div>`;
function natcar(sendData: unknown = [row(5, 'ООО ТЕСТ')], failure?: number) {
  let logins = 0;
  const client = new FuelCabinetClient('natcar', async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://lk.natcar.ru'); assert.equal(init?.redirect, 'manual');
    if (url.pathname === '/login/' && init?.method === 'GET') return new Response('<input name="csrfmiddlewaretoken" value="fixture-csrf">', { headers: { 'set-cookie': 'csrftoken=fixture; Path=/; Secure' } });
    if (url.pathname === '/login/' && init?.method === 'POST') {
      logins++; const params = new URLSearchParams(String(init.body)); assert.equal(params.get('password'), credentials.password); assert.equal(params.get('csrfmiddlewaretoken'), 'fixture-csrf');
      return new Response(null, { status: 302, headers: { location: '/company/', 'set-cookie': 'sessionid=fixture; Path=/; Secure' } });
    }
    assert.equal(url.pathname, '/company/api/'); assert.equal(init?.method, 'GET');
    assert.match((init?.headers as Record<string, string>).Cookie, /sessionid=fixture/);
    return failure ? new Response('private upstream payload', { status: failure }) : Response.json(sendData);
  });
  return { client, logins: () => logins };
}
test('natcar selects only explicitly configured own organizations, with exact signed kopecks and no invented contract/date', () => {
  const accounts = parseNatcarBalances([row(1, 'ООО ТЕСТ'), row(2, 'Чужая компания', 987654)], ['Тест']);
  assert.deepEqual(accounts, [{ id: 'natcar:1', supplier: 'natcar', organization: 'ООО ТЕСТ', amountMinor: -1527, currency: 'RUB', balanceLabel: 'Текущий баланс' }]);
  for (const value of [null, 'nan', '1.234', '1e5', Infinity, '9007199254740991']) assert.throws(() => fuelMoney(value, 'natcar'));
  assert.equal(fuelMoney('0,00', 'rosneft'), 0); assert.equal(fuelMoney(12.34, 'natcar'), 1234);
  assert.throws(() => parseNatcarBalances([row(1, 'Тест')], ['Тест', 'Отсутствующая']));
  assert.throws(() => parseNatcarBalances([row(1, 'Тест'), row(1, 'Тест')], ['Тест']));
  assert.throws(() => parseNatcarBalances([row(1, 'Тест')], []));
  assert.throws(() => parseNatcarBalances([row(1, 'Тест')], ['Тест', 'ООО ТЕСТ']));
});
test('natcar uses provider CSRF and isolated cookie session, then reuses it', async () => {
  const t = natcar(); await t.client.balances(credentials, ['ТЕСТ']); await t.client.balances(credentials, ['ТЕСТ']); assert.equal(t.logins(), 1);
});
test('provider challenge stops before credentials and unexpected redirect never forwards credentials', async () => {
  let calls = 0;
  const captcha = new FuelCabinetClient('natcar', async () => { calls++; return new Response('<div class="g-recaptcha"></div>'); });
  await assert.rejects(captcha.balances(credentials, ['ТЕСТ']), /подтверждения/); assert.equal(calls, 1);
  for (const target of ['http://lk.natcar.ru/company/', 'https://other.test/company/', '/login/otp']) {
    let count = 0;
    const client = new FuelCabinetClient('natcar', async () => ++count === 1 ? new Response('<input name="csrfmiddlewaretoken" value="fixture">') : new Response(null, { status: 302, headers: { location: target } }));
    await assert.rejects(client.balances(credentials, ['ТЕСТ']), /подтверждения/); assert.equal(count, 2);
  }
});
test('Роснефть preserves source meanings and refuses wrong contract/currency/incomplete balance', () => {
  const a = parseRosneftBalance(rn(), '31');
  assert.deepEqual(parseRosneftBalance(rn().replace(/[А-Яа-я]/g, c => `&#x${c.charCodeAt(0).toString(16)};`), '31'), a);
  assert.equal(a.amountMinor, 123456); assert.equal(a.sourceUpdatedAt, undefined);
  assert.deepEqual(a.details?.map(d => d.amountMinor), [130000, 6000, 544]);
  assert.throws(() => parseRosneftBalance(rn(), '32'));
  for (const h of [rn().replace('currency-RUR', 'currency-USD'), rn().replace('Собственные средства', 'Другие средства'), rn() + rn()]) assert.throws(() => parseRosneftBalance(h, '31'));
});
test('Роснефть reads every contract via the observed session selector and verifies selection', async () => {
  let id = '31'; const calls: string[] = [];
  const client = new FuelCabinetClient('rosneft', async (input, init) => {
    const url = new URL(String(input)); assert.equal(url.origin, 'https://lk.rn-card.ru'); calls.push(`${init?.method} ${url.pathname}`);
    if (url.pathname === '/Account/Login') {
      if (init?.method === 'GET') return new Response('<input name="__RequestVerificationToken" value="fixture">');
      assert.equal(new URLSearchParams(String(init?.body)).get('Password'), credentials.password);
      return new Response(null, { status: 302, headers: { location: '/' } });
    }
    if (url.pathname === '/api/LK/v1/ChangeContractListBoxItem') { id = String(init?.body); return new Response('{}'); }
    assert.equal(url.pathname, '/'); return new Response(rn(id));
  });
  const accounts = await client.balances(credentials); assert.deepEqual(accounts.map(a => a.id), ['rosneft:31', 'rosneft:32']);
  assert.equal(calls.filter(c => c.startsWith('POST')).length, 2);
});
test('new providers retain snapshots on failure, survive restart and preserve unrelated CRM data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'fuel-sync-')), store = new OperationsStore(directory), source = (await loadSnapshot()).provenance.sourceSha256;
  const env = { ARTEL_CABINET_ENCRYPTION_KEY: 'd'.repeat(64) }, id = `cabinet-${randomUUID()}`;
  try {
    await store.mutate(source, data => { data.cabinets = { version: 1, connections: { [id]: { id, provider: 'natcar', label: 'QA', organizationNames: ['ТЕСТ'], createdAt: new Date().toISOString(), state: 'awaiting_setup', encryptedCredentials: encryptCabinetCredentials(id, 'natcar', credentials, env) } } }; return { changed: true, result: null }; });
    const before = await store.read(source);
    await syncCabinetConnection(store, source, env, id, undefined, natcar().client);
    const good = (await store.read(source)).cabinets!.connections[id]; assert.equal(good.state, 'connected'); validateCabinets({ version: 1, connections: { [id]: good } });
    for (const status of [503, 401]) {
      await store.mutate(source, data => { data.cabinets!.connections[id].lastAttemptAt = '2026-01-01T00:00:00Z'; return { changed: true, result: null }; });
      await syncCabinetConnection(store, source, env, id, undefined, natcar([], status).client);
      const after = await store.read(source), current = after.cabinets!.connections[id];
      assert.equal(current.state, status === 401 ? 'auth_required' : 'error'); assert.deepEqual(current.accounts, good.accounts); assert.equal(current.lastSuccessAt, good.lastSuccessAt); assert.ok(!current.error?.includes('private upstream'));
      assert.deepEqual({ ...after, revision: before.revision, cabinets: before.cabinets }, before);
      assert.deepEqual((await new OperationsStore(directory).read(source)).cabinets, after.cabinets);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

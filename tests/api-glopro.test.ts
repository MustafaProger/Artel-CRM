import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { GloProClient, parseGloProBalance, parseGloProContracts } from '../server/glopro-client';
import { encryptCabinetCredentials, syncCabinetConnection, validateCabinets } from '../server/cabinet-connections';
import { OperationsStore } from '../server/operations-store';
import { loadSnapshot } from '../server/local-api';
const detail = '<h1>Тестовый поставщик &quot;А&quot;</h1><select name="suppliers_contracts_list"><option value="22" data-content="<span>Договор:</span> <b>QA-1</b> от 01.06.2026 ID 22"></option></select>';
const balance = '<b>Баланс р/с:</b><span class="font-20 font-weight-bold">-12 345,67 ₽</span><i class="text-muted">на 01.06.2026 12:30:45</i><script>fake = "999 999,00 ₽"</script>';
function transport(fail = false) {
  const calls: { path: string; body: string }[] = [];
  const send: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname;
    assert.equal(new URL(String(input)).origin, 'https://lk.glopro.ru');
    assert.equal(init?.redirect, 'manual'); calls.push({ path, body: String(init?.body ?? '') });
    if (path === '/') return new Response('<form id="login" action="/login"></form>', { headers: { 'set-cookie': 'session=fixture; Path=/; Secure; HttpOnly' } });
    assert.match(String((init?.headers as Record<string, string>).Cookie), /session=fixture/);
    if (path === '/login') return new Response(null, { status: 302, headers: { location: 'https://lk.glopro.ru/' } });
    if (fail) return new Response('provider failure: DO NOT DISCLOSE', { status: 503 });
    if (path === '/suppliers/suppliers-list/') {
      const params = new URLSearchParams(String(init?.body)); assert.deepEqual(params.getAll('statuses_contract[]'), ['1', '10']);
      return Response.json({ success: true, data: { items: [{ ID: '11' }], more: false } });
    }
    if (path === '/suppliers/11') return new Response(detail);
    if (path === '/suppliers/contract/22') { assert.equal(String(init?.body), 'tab=contract'); return new Response(balance); }
    assert.fail('Unexpected external route ' + path);
  };
  return { calls, client: new GloProClient(send) };
}

test('GloPro reads supplier contracts through a fixed read-only route list and reuses only its own session', async () => {
  const t = transport(), credentials = { login: 'fixture-login', password: 'fixture-password' };
  const accounts = await t.client.balances(credentials);
  assert.deepEqual(accounts, [{ id: '11:22', supplier: 'Тестовый поставщик "А"', contract: 'QA-1 от 01.06.2026 ID 22', amountMinor: -1234567, currency: 'RUB', sourceUpdatedAt: '2026-06-01T09:30:45.000Z' }]);
  await t.client.balances(credentials);
  assert.equal(t.calls.filter(x => x.path === '/login').length, 1);
  assert.equal(t.calls.filter(x => x.body.includes('fixture-password')).length, 1);
});

test('GloPro does not replace missing, ambiguous, other-currency or malformed balances with zero', () => {
  for (const input of ['login', balance.replace('Баланс р/с:', 'Иной баланс:'), balance.replace('₽', '$'), balance + balance, balance.replace('-12 345,67', 'неизвестно')]) assert.throws(() => parseGloProBalance(input));
  assert.equal(parseGloProBalance(balance.replace('-12 345,67', '0,00')).amountMinor, 0);
  assert.throws(() => parseGloProContracts('<h1>Фирма</h1>'));
  assert.throws(() => parseGloProContracts(detail.replace('value="22"', 'value="../../login"')));
});

test('GloPro rejects login challenges and off-origin redirects without forwarding credentials', async () => {
  for (const location of ['https://evil.test/', '/login/otp']) {
    let count = 0;
    const client = new GloProClient(async () => { count++; return count === 1 ? new Response('', { headers: { 'set-cookie': 'session=fixture' } }) : new Response(null, { status: 302, headers: { location } }); });
    await assert.rejects(client.balances({ login: 'secret-user', password: 'secret-password' }), /повторного входа/);
    assert.equal(count, 2);
  }
});

test('cabinet sync persists exact signed amounts, retains last good data on failure and preserves other CRM data', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'cabinet-sync-')), store = new OperationsStore(directory);
  const source = (await loadSnapshot()).provenance.sourceSha256, env = { ARTEL_CABINET_ENCRYPTION_KEY: 'a'.repeat(64) }, id = `cabinet-${randomUUID()}`;
  try {
    await store.mutate(source, data => {
      data.cabinets = { version: 1, connections: { [id]: { id, provider: 'glopro', label: 'QA', createdAt: new Date().toISOString(), state: 'awaiting_setup', encryptedCredentials: encryptCabinetCredentials(id, 'glopro', { login: 'fixture', password: 'fixture' }, env) } } };
      return { changed: true, result: null };
    });
    const before = await store.read(source);
    await syncCabinetConnection(store, source, env, id, undefined, transport().client);
    const good = (await store.read(source)).cabinets!.connections[id];
    assert.equal(good.state, 'connected'); assert.equal(good.accounts![0].amountMinor, -1234567);
    validateCabinets({ version: 1, connections: { [id]: good } });
    await assert.rejects(syncCabinetConnection(store, source, env, id, undefined, transport().client), /через минуту/);
    await store.mutate(source, data => { data.cabinets!.connections[id].lastAttemptAt = '2026-06-01T00:00:00Z'; return { changed: true, result: null }; });
    await syncCabinetConnection(store, source, env, id, undefined, transport(true).client);
    const after = await store.read(source), failed = after.cabinets!.connections[id];
    assert.equal(failed.state, 'error'); assert.deepEqual(failed.accounts, good.accounts); assert.equal(failed.lastSuccessAt, good.lastSuccessAt);
    assert.ok(!failed.error?.includes('DO NOT DISCLOSE'));
    assert.deepEqual({ ...after, revision: before.revision, cabinets: before.cabinets }, before);
    assert.deepEqual((await new OperationsStore(directory).read(source)).cabinets, after.cabinets);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

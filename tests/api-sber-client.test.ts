import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https, { type RequestOptions } from 'node:https';
import { type ClientRequest, type IncomingMessage } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import { test, type TestContext } from 'node:test';
import { ApiError } from '../server/api-error';
import { SBER_PREFIX, SberClient, SberHttpError, sberMissing, sberRequest, type SberRequestOptions, type SberTokens, type SberTokenVault } from '../server/banking/sber-client';

const SUMMARY = '/fintech/api/v2/statement/summary';
const TOKEN = '/ic/sso/api/v2/oauth/token';
const query = { accountNumber: '40702810000000000001', statementDate: '2026-09-15' };
const seed = { accessToken: 'fixture-access', refreshToken: 'fixture-refresh' };
function environment() {
  return {
    [`${SBER_PREFIX}_CLIENT_ID`]: 'fixture-client',
    [`${SBER_PREFIX}_CLIENT_SECRET`]: 'fixture-secret',
    [`${SBER_PREFIX}_ACCESS_TOKEN`]: seed.accessToken,
    [`${SBER_PREFIX}_REFRESH_TOKEN`]: seed.refreshToken,
    [`${SBER_PREFIX}_TLS_PFX_BASE64`]: Buffer.from('fixture-container').toString('base64'),
    [`${SBER_PREFIX}_TLS_PASSPHRASE`]: 'fixture-passphrase',
    [`${SBER_PREFIX}_TLS_CA_BASE64`]: Buffer.from('-----BEGIN CERTIFICATE-----\nfixture-ca\n-----END CERTIFICATE-----').toString('base64'),
    ARTEL_BANK_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'),
  };
}
function memoryVault(initial?: SberTokens) {
  let saved = initial ? { ...initial } : undefined;
  const writes: SberTokens[] = [];
  const vault: SberTokenVault = {
    read: async () => saved ? { ...saved } : undefined,
    save: async tokens => { saved = { ...tokens }; writes.push({ ...tokens }); },
  };
  return { vault, writes, current: () => saved };
}

type WireReply = { status?: number; body?: string; headers?: Record<string, string>; errorCode?: string };
type WireCall = { url: URL; options: RequestOptions; body?: string };
/** Replaces HTTPS before any socket is opened; response fixtures never leave this process. */
function captureHttps(t: TestContext, replies: WireReply[]) {
  const calls: WireCall[] = [];
  t.mock.method(https, 'request', ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    const reply = replies[calls.length];
    assert.ok(reply, 'unexpected bank request');
    const captured: WireCall = { url, options };
    calls.push(captured);
    const request = new EventEmitter() as ClientRequest;
    request.end = ((body?: string) => {
      captured.body = body;
      queueMicrotask(() => {
        if (reply.errorCode) {
          request.emit('error', Object.assign(new Error('fixture-secret fixture-access fixture-passphrase'), { code: reply.errorCode }));
          request.emit('close');
          return;
        }
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = reply.status ?? 200;
        response.headers = reply.headers ?? {};
        response.resume = () => response;
        callback(response);
        response.emit('data', Buffer.from(reply.body ?? '{}'));
        response.emit('end');
        request.emit('close');
      });
      return request;
    }) as ClientRequest['end'];
    return request;
  }) as unknown as typeof https.request);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  return calls;
}

test('Sber transport uses verified mTLS, raw access token, fixed production host and exact decimals', async t => {
  const calls = captureHttps(t, [{ body: '{"openingBalance":{"amount":12345678901234567890.12,"currencyName":"RUB"}}' }]);
  const result = await sberRequest(environment(), { path: SUMMARY, query, accessToken: seed.accessToken });
  assert.deepEqual(result, { openingBalance: { amount: '12345678901234567890.12', currencyName: 'RUB' } });
  assert.equal(calls[0].url.origin, 'https://fintech.sberbank.ru:9443');
  assert.equal(calls[0].url.pathname, SUMMARY);
  assert.deepEqual(Object.fromEntries(calls[0].url.searchParams), query);
  assert.equal(calls[0].options.method, 'GET');
  assert.equal(calls[0].options.rejectUnauthorized, true);
  assert.equal(calls[0].options.minVersion, 'TLSv1.2');
  assert.ok(Buffer.isBuffer(calls[0].options.pfx));
  assert.ok(Array.isArray(calls[0].options.ca));
  assert.ok(calls[0].options.ca.length > 1, 'custom Sber chain complements standard roots');
  assert.equal((calls[0].options.headers as Record<string, string>).Authorization, seed.accessToken);
  assert.equal(calls[0].body, undefined);
});

test('Sber 401 refresh persists the complete pair before retry and never guesses redirect_uri', async t => {
  const calls = captureHttps(t, [
    { status: 401, body: '{"message":"fixture-access"}' },
    { body: '{"access_token":"fixture-rotated-access","refresh_token":"fixture-rotated-refresh","expires_in":3600}' },
    { body: '{"transactions":[],"_links":[]}' },
  ]);
  const memory = memoryVault();
  let persistedBeforeRetry = false;
  const client = new SberClient(environment(), memory.vault, async (env, options) => {
    if (options.accessToken === 'fixture-rotated-access') {
      persistedBeforeRetry = memory.current()?.refreshToken === 'fixture-rotated-refresh';
    }
    return sberRequest(env, options);
  });
  await client.get(SUMMARY, query);
  assert.ok(persistedBeforeRetry);
  assert.equal(calls.length, 3);
  assert.equal(calls[1].url.pathname, TOKEN);
  assert.equal(calls[1].url.origin, 'https://fintech.sberbank.ru:9443');
  assert.equal(calls[1].options.method, 'POST');
  assert.deepEqual(Object.fromEntries(new URLSearchParams(calls[1].body)), {
    grant_type: 'refresh_token', refresh_token: seed.refreshToken, client_id: 'fixture-client', client_secret: 'fixture-secret',
  });
  assert.equal((calls[1].options.headers as Record<string, string>)['Content-Type'], 'application/x-www-form-urlencoded');
  assert.equal((calls[1].options.headers as Record<string, string>).Authorization, undefined);
  assert.equal((calls[2].options.headers as Record<string, string>).Authorization, 'fixture-rotated-access');
  assert.equal(memory.writes.length, 2);
  assert.deepEqual(memory.writes[0], seed);
  assert.ok(memory.current()!.expiresAt! > Date.now() + 3_500_000);
});

test('saved Sber token pair wins over environment seeds and future expiry does not trigger refresh', async () => {
  const saved = { accessToken: 'fixture-saved-access', refreshToken: 'fixture-saved-refresh', expiresAt: Date.now() + 3600_000 };
  const memory = memoryVault(saved);
  const calls: SberRequestOptions[] = [];
  const client = new SberClient(environment(), memory.vault, async (_env, options) => { calls.push(options); return {}; });
  await client.get(SUMMARY, query);
  assert.deepEqual(calls, [{ path: SUMMARY, query, accessToken: saved.accessToken }]);
  assert.equal(memory.writes.length, 0);
});

test('a saved expiring token refreshes first and uses the saved refresh token', async () => {
  const memory = memoryVault({ accessToken: 'fixture-saved-access', refreshToken: 'fixture-saved-refresh', expiresAt: Date.now() + 5000 });
  const calls: SberRequestOptions[] = [];
  const client = new SberClient(environment(), memory.vault, async (_env, options) => {
    calls.push(options);
    if (options.path === TOKEN) return { access_token: 'fixture-next-access', refresh_token: 'fixture-next-refresh', expires_in: '3600' };
    assert.equal(memory.current()?.accessToken, 'fixture-next-access');
    return {};
  });
  await client.get(SUMMARY, query);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].form?.refresh_token, 'fixture-saved-refresh');
  assert.equal(calls[1].accessToken, 'fixture-next-access');
});

test('Sber never retries a statement with a rotated token if saving its pair failed', async () => {
  let calls = 0;
  const vault: SberTokenVault = { read: async () => seed, save: async () => { throw new Error('fixture durable storage unavailable'); } };
  const client = new SberClient(environment(), vault, async (_env, options) => {
    calls++;
    if (options.path === TOKEN) return { access_token: 'fixture-next-access', refresh_token: 'fixture-next-refresh' };
    throw new SberHttpError(401);
  });
  await assert.rejects(client.get(SUMMARY, query), /fixture durable storage unavailable/);
  assert.equal(calls, 2);
});

test('Sber does not send seed credentials if initial durable storage fails', async () => {
  let calls = 0;
  const vault: SberTokenVault = { read: async () => undefined, save: async () => { throw new Error('fixture storage error'); } };
  const client = new SberClient(environment(), vault, async () => { calls++; return {}; });
  await assert.rejects(client.get(SUMMARY, query), /fixture storage error/);
  assert.equal(calls, 0);
});

test('incomplete refresh responses cannot replace the old pair or retry the statement', async () => {
  for (const response of [null, {}, { access_token: 'fixture-only-access' }, { access_token: '', refresh_token: 'fixture-only-refresh' }]) {
    const memory = memoryVault(seed);
    let calls = 0;
    const client = new SberClient(environment(), memory.vault, async (_env, options) => {
      calls++;
      if (options.path === TOKEN) return response;
      throw new SberHttpError(401);
    });
    await assert.rejects(client.get(SUMMARY, query), /Сбер не вернул новую пару ключей/);
    assert.equal(calls, 2);
    assert.deepEqual(memory.current(), seed);
    assert.equal(memory.writes.length, 0);
  }
});

test('Sber refreshes once per 401 and never loops on rejected replacement credentials', async () => {
  const memory = memoryVault(seed);
  let calls = 0;
  const client = new SberClient(environment(), memory.vault, async (_env, options) => {
    calls++;
    if (options.path === TOKEN) return { access_token: 'fixture-next-access', refresh_token: 'fixture-next-refresh' };
    throw new SberHttpError(401);
  });
  await assert.rejects(client.get(SUMMARY, query), (error: unknown) => error instanceof SberHttpError && error.bankStatus === 401);
  assert.equal(calls, 3);
  assert.equal(memory.current()?.refreshToken, 'fixture-next-refresh');
});

test('Sber refuses unrelated endpoints, payment creation, redirects and non-refresh OAuth grants before network or vault access', async () => {
  const forbidden = ['https://external.invalid/steal', '//external.invalid/steal', '/fintech/api/v2/payments', '/fintech/api/v2/statement/summary/../payments', TOKEN];
  let reads = 0, requests = 0;
  const client = new SberClient(environment(), { read: async () => { reads++; return seed; }, save: async () => {} }, async () => { requests++; return {}; });
  for (const path of forbidden) {
    await assert.rejects(client.get(path, query), /Недопустимый метод Сбера/);
    await assert.rejects(sberRequest({}, { path, query }), /Недопустимый метод Сбера/);
  }
  for (const options of [{ path: SUMMARY, form: { grant_type: 'refresh_token' } }, { path: TOKEN, form: { grant_type: 'authorization_code' } }]) {
    await assert.rejects(sberRequest({}, options), /Недопустимый метод Сбера/);
  }
  assert.equal(reads, 0);
  assert.equal(requests, 0);
});

test('bank error bodies, malformed JSON and TLS errors never appear in surfaced messages', async t => {
  const sensitive = 'fixture-secret fixture-access fixture-passphrase';
  captureHttps(t, [
    { status: 400, body: sensitive },
    { status: 401, body: sensitive },
    { status: 403, body: sensitive },
    { status: 404, body: sensitive },
    { status: 429, body: sensitive, headers: { 'retry-after': '999999' } },
    { status: 503, body: sensitive },
    { body: sensitive },
    { errorCode: 'CERT_HAS_EXPIRED' },
    { errorCode: 'ECONNRESET' },
  ]);
  for (let i = 0; i < 9; i++) {
    await assert.rejects(sberRequest(environment(), { path: SUMMARY, query, accessToken: seed.accessToken }), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.ok(!error.message.includes('fixture-'));
      assert.ok(!JSON.stringify(error).includes('fixture-'));
      if (i === 4) assert.equal((error as SberHttpError).retryAfterSeconds, 3600);
      if (i === 7) assert.equal((error as SberHttpError).bankStatus, 495);
      if (i === 8) assert.equal((error as SberHttpError).bankStatus, 503);
      return true;
    });
  }
});

test('Sber checks server encryption and connection credentials without exposing their values', () => {
  assert.deepEqual(sberMissing(environment()), []);
  const env: Record<string, string | undefined> = environment();
  delete env[`${SBER_PREFIX}_ACCESS_TOKEN`]; delete env[`${SBER_PREFIX}_REFRESH_TOKEN`];
  assert.deepEqual(sberMissing(env, true), []);
  assert.deepEqual(sberMissing(env, false), ['Ключи доступа к выпискам']);
  env.ARTEL_BANK_ENCRYPTION_KEY = Buffer.alloc(31).toString('base64');
  assert.ok(sberMissing(env, true).includes('Ключ защиты банковского доступа на сервере'));
});

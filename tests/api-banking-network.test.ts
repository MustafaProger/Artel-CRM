import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import https, { type RequestOptions } from 'node:https';
import type { ClientRequest, IncomingMessage } from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { rootCertificates } from 'node:tls';
import { bankNetworkOptions, bankRequest, bankTlsOptions, BankTransportError } from '../server/banking/transport';
import { fixtureConfig } from './banking-fixtures';

const address = (ip: string, family: 'IPv4' | 'IPv6' = 'IPv4', internal = false): NetworkInterfaceInfo => ({ address: ip, family, internal, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: null, ...(family === 'IPv6' ? { scopeid: 0 } : {}) }) as NetworkInterfaceInfo;
const config = () => ({ ...fixtureConfig(), env: { ...fixtureConfig().env, ARTEL_BANK_TBANK_NK_INTERFACE: 'en0' } });

test('T-Bank uses the default route unless an interface is explicitly configured', () => {
  assert.deepEqual(bankNetworkOptions(fixtureConfig(), {}), {});
});

test('T-Bank selects the current external IPv4 address of the configured interface', () => {
  const interfaces = { en0: [address('::1', 'IPv6'), address('127.0.0.1', 'IPv4', true), address('192.168.1.20')], utun6: [address('198.18.0.1')] };
  assert.deepEqual(bankNetworkOptions(config(), interfaces), { localAddress: '192.168.1.20', family: 4 });
  interfaces.en0 = [address('192.168.1.21')];
  assert.deepEqual(bankNetworkOptions(config(), interfaces), { localAddress: '192.168.1.21', family: 4 });
});

test('A missing or IPv6-only T-Bank interface fails without falling back to the VPN', async () => {
  for (const interfaces of [{}, { en0: [address('fe80::1', 'IPv6')] }, { en0: [address('127.0.0.1', 'IPv4', true)] }]) {
    assert.throws(() => bankNetworkOptions(config(), interfaces), /Сетевой интерфейс Т-Банка недоступен/);
  }
  const missing = config(); missing.env.ARTEL_BANK_TBANK_NK_INTERFACE = '__artel_missing_interface__';
  await assert.rejects(bankRequest(missing, '/openapi/api/v4/bank-accounts', 'fixture-token'), /Сетевой интерфейс Т-Банка недоступен/);
});

test('T-Bank adds a per-connection CA bundle to standard roots and rejects invalid configuration before sending credentials', async t => {
  let calls = 0;
  t.mock.method(https, 'request', ((url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void) => {
    calls++;
    assert.equal(url.origin, 'https://business.tbank.ru');
    assert.equal(options.method, 'GET');
    assert.equal(options.rejectUnauthorized, true);
    assert.equal(options.minVersion, 'TLSv1.2');
    assert.deepEqual(options.ca, [...rootCertificates, rootCertificates[0]]);
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      queueMicrotask(() => {
        const response = new EventEmitter() as IncomingMessage;
        response.statusCode = 200;
        callback(response);
        response.emit('data', Buffer.from('{"amount":12345678901234567890.12}'));
        response.emit('end');
        req.emit('close');
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  }) as unknown as typeof https.request);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  const connection = { ...fixtureConfig(), env: { ...fixtureConfig().env } };
  assert.deepEqual(bankTlsOptions(connection), {});
  connection.env.ARTEL_BANK_TBANK_NK_TLS_CA_BASE64 = Buffer.from(rootCertificates[0]).toString('base64');
  assert.deepEqual(await bankRequest(connection, '/openapi/api/v4/bank-accounts', 'fixture-token'), { amount: '12345678901234567890.12' });
  assert.deepEqual(bankTlsOptions(fixtureConfig()), {}, 'extra roots are not shared with other configurations');
  for (const invalid of ['%%%fixture-secret', Buffer.from('fixture-secret').toString('base64'), Buffer.from(rootCertificates[0] + '\n-----BEGIN PRIVATE KEY-----\nfixture-secret').toString('base64')]) {
    connection.env.ARTEL_BANK_TBANK_NK_TLS_CA_BASE64 = invalid;
    await assert.rejects(bankRequest(connection, '/openapi/api/v4/bank-accounts', 'fixture-token'), /Некорректная доверенная цепочка/);
  }
  assert.equal(calls, 1, 'invalid bundles must fail before a network request');
});

test('T-Bank reports safe TLS and network diagnostics without raw errors or secrets', async t => {
  const codes = ['SELF_SIGNED_CERT_IN_CHAIN', 'CERT_HAS_EXPIRED', 'ERR_TLS_CERT_ALTNAME_INVALID', 'ENOTFOUND', 'ENETUNREACH', 'ETIMEDOUT', 'ECONNRESET', 'fixture-secret'];
  let index = 0;
  t.mock.method(https, 'request', (() => {
    const req = new EventEmitter() as ClientRequest;
    req.end = (() => {
      queueMicrotask(() => {
        req.emit('error', Object.assign(new Error('fixture-token fixture-account fixture-secret'), { code: codes[index++] }));
        req.emit('close');
      });
      return req;
    }) as ClientRequest['end'];
    return req;
  }) as unknown as typeof https.request);
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });

  for (let i = 0; i < codes.length; i++) {
    await assert.rejects(bankRequest(fixtureConfig(), '/openapi/api/v4/bank-accounts', 'fixture-token'), (error: unknown) => {
      assert.ok(error instanceof BankTransportError);
      assert.ok(!error.message.includes('fixture-'));
      assert.ok(!JSON.stringify(error).includes('fixture-'));
      assert.equal(error.transient, i >= 3, 'certificate errors need configuration correction, not repeated retries');
      if (i < 3) assert.match(error.message, /TLS-сертификат/);
      if (i === 3) assert.match(error.message, /DNS/);
      if (i === 4) assert.match(error.message, /маршрут/);
      if (i === 5) assert.match(error.message, /отведённое время/);
      return true;
    });
  }
});

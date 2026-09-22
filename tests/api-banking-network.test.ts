import assert from 'node:assert/strict';
import test from 'node:test';
import type { NetworkInterfaceInfo } from 'node:os';
import { bankNetworkOptions, bankRequest } from '../server/banking/transport';
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

import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticSigningPolicyMatchesOrganizations, readAutomaticSigningPolicy } from '../server/saby-auto-policy';

const policy = { id: 'synthetic-policy-01', enabled: true, approvedAt: '2026-10-06T12:00:00.000Z', mode: 'deferred', sender: { inn: '0148372956', kpp: '010101001', thumbprint: 'AB'.repeat(20) }, carrier: { inn: '0392816475', kpp: '030101001', thumbprint: 'CD'.repeat(20) } };
test('automatic signing policy pins two distinct organizations and certificates, retaining disabled settings', () => {
  const active = readAutomaticSigningPolicy(JSON.stringify(policy)).policy!;
  assert.equal(active.sender.thumbprint, policy.sender.thumbprint.toLowerCase());
  assert.equal(active.mode, 'deferred');
  assert.equal(readAutomaticSigningPolicy(JSON.stringify({ ...policy, enabled: false })).policy?.enabled, false);
  assert.equal(automaticSigningPolicyMatchesOrganizations(active, { customer: active.sender, carrier: active.carrier }), true);
  assert.equal(automaticSigningPolicyMatchesOrganizations(active, { customer: active.carrier, carrier: active.sender }), false);
  assert.equal(automaticSigningPolicyMatchesOrganizations(active, { customer: { ...active.sender, kpp: '010101002' }, carrier: active.carrier }), false);
});
test('missing policy stays disabled and malformed or overbroad policy never silently authorizes a save', () => {
  assert.deepEqual(readAutomaticSigningPolicy(undefined), {});
  assert.deepEqual(readAutomaticSigningPolicy(' '), {});
  for (const invalid of [
    '{}', 'null', '[]', '{', 'x'.repeat(4097),
    ...[{ ...policy, mode: 'with_confirmation' }, { ...policy, enabled: 'true' }, { ...policy, extra: true },
      { ...policy, approvedAt: 'bad' }, { ...policy, id: '../policy' },
      { ...policy, carrier: policy.sender }, { ...policy, carrier: { ...policy.carrier, thumbprint: policy.sender.thumbprint } },
      { ...policy, sender: { ...policy.sender, inn: '' } }, { ...policy, sender: { ...policy.sender, thumbprint: 'unknown' } },
    ].map(value => JSON.stringify(value)),
  ]) {
    const result = readAutomaticSigningPolicy(invalid);
    assert.equal(result.policy, undefined); assert.ok(result.error);
    assert.doesNotMatch(result.error, /synthetic-policy|ABAB|CDCD/);
  }
});

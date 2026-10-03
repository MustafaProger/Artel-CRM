import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { integrationRuntime } from './helpers/trip-saby-integration';
import { saveUser } from '../server/auth';
import { currentSnapshot } from '../server/shipment-operations';

const run = promisify(execFile);
test('driver provisioning CLI checks the reviewed plan, preserves existing data, privately delivers new passwords and repeats without duplicates', async () => {
  const rt = await integrationRuntime();
  try {
    await rt.store.mutate(rt.source, async data => {
      await saveUser(data, currentSnapshot(rt.base, data, false), { name: 'Synthetic owner', login: 'synthetic.owner', password: randomUUID() }, undefined, true);
      return { result: null, changed: true };
    });
    const directory = dirname(rt.store.path);
    const invoke = (...args: string[]) => run(process.execPath, ['--import', 'tsx', 'scripts/provision-driver-accounts.ts', ...args], {
      cwd: resolve('.'), env: { ...process.env, ARTEL_SNAPSHOT_DIR: rt.snapshotDirectory, ARTEL_STORE_DIR: directory },
    });
    const initialRaw = await readFile(rt.store.path, 'utf8');
    const plan = JSON.parse((await invoke()).stdout);
    assert.equal(plan.employees, 1); assert.ok(plan.missing > 0);
    const rejectedFile = resolve(directory, 'stale-credentials.json');
    await assert.rejects(invoke('--apply', '--expect', '0'.repeat(64), '--output', rejectedFile));
    assert.equal(await readFile(rt.store.path, 'utf8'), initialRaw);
    await assert.rejects(stat(rejectedFile));
    const existingPending = resolve(directory, 'reserved-credentials.json');
    await writeFile(`${existingPending}.pending`, 'existing private recovery material', { mode: 0o600 });
    await assert.rejects(invoke('--apply', '--expect', plan.fingerprint, '--output', existingPending));
    assert.equal(await readFile(`${existingPending}.pending`, 'utf8'), 'existing private recovery material');
    await assert.rejects(stat(existingPending));
    assert.equal(await readFile(rt.store.path, 'utf8'), initialRaw);
    const credentialsFile = resolve(directory, 'credentials.json');
    const result = JSON.parse((await invoke('--apply', '--expect', plan.fingerprint, '--output', credentialsFile)).stdout);
    assert.equal(result.created, plan.missing); assert.equal(result.repeatCreated, 0); assert.equal(result.readBackVerified, true);
    const credentials = JSON.parse(await readFile(credentialsFile, 'utf8'));
    assert.equal((await stat(credentialsFile)).mode & 0o777, 0o600);
    assert.equal(credentials.accounts.length, plan.missing);
    const stored = await readFile(rt.store.path, 'utf8');
    for (const account of credentials.accounts) {
      assert.ok(account.temporaryPassword.length >= 24);
      assert.equal(stored.includes(account.temporaryPassword), false);
      assert.equal(JSON.stringify(result).includes(account.temporaryPassword), false);
    }
    const nextPlan = JSON.parse((await invoke()).stdout);
    assert.equal(nextPlan.missing, 0);
    const repeat = JSON.parse((await invoke('--apply', '--expect', nextPlan.fingerprint, '--output', resolve(directory, 'repeat.json'))).stdout);
    assert.equal(repeat.created, 0);
    assert.equal(await readFile(rt.store.path, 'utf8'), stored);
    await assert.rejects(invoke('--apply', '--expect', nextPlan.fingerprint, '--output', credentialsFile));
    assert.equal(await readFile(rt.store.path, 'utf8'), stored);
  } finally { await rt.close(); }
});

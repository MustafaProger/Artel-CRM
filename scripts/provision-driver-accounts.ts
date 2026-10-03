/** Run in the active runtime container, never against a second mounted writer.
 * Plan output contains counts/fingerprints only. One-time credentials go to a
 * private exclusive file, never stdout, application data or an HTTP GET.
 */
import assert from 'node:assert/strict';
import { createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { open, rename, unlink } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore, type OperationsData } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { createMissingDriverAccounts } from '../server/driver-access';

process.umask(0o077);
const args = process.argv.slice(2);
const option = (name: string) => args[args.indexOf(name) + 1];
const apply = args.includes('--apply');
const snapshotDirectory = process.env.ARTEL_SNAPSHOT_DIR;
const storeDirectory = process.env.ARTEL_STORE_DIR;
assert(snapshotDirectory && storeDirectory, 'Explicit runtime snapshot/store paths required');
const base = await loadSnapshot(snapshotDirectory);
const store = new OperationsStore(storeDirectory);
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const plan = (data: OperationsData) => {
  const snapshot = currentSnapshot(base, data, false);
  const deleted = new Set(snapshot.directories?.deletedEntries?.drivers ?? []);
  const drivers = (snapshot.directories?.drivers ?? []).filter(row => {
    const flags = row as typeof row & { archived?: boolean; directoryArchived?: boolean; deletedAt?: string };
    return !deleted.has(row.id) && !flags.archived && !flags.directoryArchived && !flags.deletedAt;
  });
  const existing = data.accounts?.users ?? [];
  assert(drivers.every(row => !!row.name?.trim()), 'Driver identity missing; no values will be invented');
  return {
    eligible: drivers.length,
    missing: drivers.filter(row => !existing.some(user => user.role === 'driver' && user.driverId === row.id)).length,
    existingDrivers: existing.filter(user => user.role === 'driver').length,
    employees: existing.filter(user => user.role !== 'driver').length,
    fingerprint: hash({ drivers, deleted: [...deleted], users: existing }),
  };
};
if (!apply) {
  console.log(JSON.stringify({ mode: 'plan', ...plan(await store.read(base.provenance.sourceSha256)) }));
} else {
  const expected = args.includes('--expect') ? option('--expect') : '';
  const output = args.includes('--output') ? option('--output') : '';
  assert(/^[a-f0-9]{64}$/.test(expected), 'Reviewed plan fingerprint required');
  assert(isAbsolute(output), 'An absolute private credential delivery path is required');
  // Reserve the final path before the transaction; refuse overwriting prior credentials.
  const reserved = await open(output, 'wx', 0o600);
  await reserved.close();
  const pending = `${output}.pending`;
  let committed = false;
  let pendingOwned = false;
  let deliveryDurable = false;
  try {
    const result = await store.mutate(base.provenance.sourceSha256, async data => {
      assert.equal(plan(data).fingerprint, expected, 'Drivers/accounts changed; review a fresh plan');
      const before = structuredClone(data);
      const backup = await store.backup(data);
      const issued = await createMissingDriverAccounts(data, currentSnapshot(base, data, false));
      const oldAccounts = before.accounts!;
      assert.equal(hash(data.accounts!.users.slice(0, oldAccounts.users.length)), hash(oldAccounts.users), 'Existing accounts changed');
      assert.equal(hash({ ...data.accounts, users: undefined }), hash({ ...oldAccounts, users: undefined }), 'Existing sessions/attempts changed');
      assert.equal(hash({ ...data, accounts: undefined }), hash({ ...before, accounts: undefined }), 'Business data changed');
      const entries = issued.created.map(row => ({ ...row, phone: data.directories?.drivers.find(driver => driver.id === row.driverId)?.phone ?? null }));
      const delivery = await open(pending, 'wx', 0o600);
      pendingOwned = true;
      try {
        await delivery.writeFile(JSON.stringify({ issuedAt: new Date().toISOString(), loginUrl: 'https://artel-crm.online/', accounts: entries }, null, 2) + '\n');
        await delivery.sync();
        deliveryDurable = true;
      } finally { await delivery.close(); }
      return { result: { issued, backup }, changed: issued.changed };
    });
    committed = true;
    await rename(pending, output);
    const after = await store.read(base.provenance.sourceSha256);
    for (const credential of result.issued.created) {
      const user = after.accounts!.users.find(row => row.role === 'driver' && row.driverId === credential.driverId)!;
      assert(user && user.active && user.login === credential.login, 'Created account read-back failed');
      assert(timingSafeEqual(scryptSync(credential.temporaryPassword, user.salt, 64), Buffer.from(user.passwordHash, 'hex')), 'Password hash read-back failed');
    }
    const second = await createMissingDriverAccounts(structuredClone(after), currentSnapshot(base, after, false));
    assert.equal(second.changed, false, 'Provisioning is not idempotent');
    assert.equal(second.created.length, 0);
    console.log(JSON.stringify({ mode: 'applied', created: result.issued.created.length, skipped: result.issued.skipped, readBackVerified: true, repeatCreated: 0, backup: result.backup, credentialsFile: output, ...plan(after) }));
  } catch (error) {
    // Store cleanup can fail AFTER its atomic rename. Once credentials are durable,
    // an uncertain transaction must preserve them for independent read-back.
    if (!committed && !deliveryDurable) {
      await unlink(output).catch(() => undefined);
      if (pendingOwned) await unlink(pending).catch(() => undefined);
    }
    throw error;
  }
}

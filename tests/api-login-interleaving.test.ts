import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolve } from 'node:path';
import { test } from 'node:test';

for (const partitioned of [false, true]) test(`HTTP login derives outside the global write queue and rejects every stale credential/permission proof (${partitioned ? 'partitioned' : 'legacy'})`, async () => {
  // A fresh process captures the held crypto implementation before auth is imported.
  // No test hooks, credentials or timing-dependent sleeps enter production code.
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', resolve('scripts/profile_backend_login_interleaving.mjs'), ...(partitioned ? ['--partitioned'] : [])], { timeout: 45000, maxBuffer: 1024 * 1024 });
  const result = JSON.parse(stdout.trim());
  assert.equal(result.passed, true);
  assert.equal(result.syntheticOnly, true);
  assert.equal(result.storage, partitioned ? 'partitioned' : 'legacy');
  assert.equal(result.checks.length, 19);
  assert.ok(result.checks.includes('fresh directoryGrants revocation rejects stale proof'));
});

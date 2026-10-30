import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';

// Read-only verification of the explicitly authorized two-account grant.
// Any other concurrent business change remains visible and requires separate classification.
const [beforePath, afterPath, mappingPath] = process.argv.slice(2);
if (!beforePath || !afterPath || !mappingPath) throw new Error('Pass before/after private envelopes and reviewed mapping');
const load = async path => {
  const value = JSON.parse(await readFile(path, 'utf8'));
  if (createHash('sha256').update(JSON.stringify(value.data)).digest('hex') !== value.sha256) throw new Error('Invalid operations envelope');
  return value.data;
};
const before = await load(beforePath), after = await load(afterPath);
const mapping = JSON.parse(await readFile(mappingPath, 'utf8'));
if (mapping.version !== 1 || mapping.users?.length !== 2 || new Set(mapping.users.map(row => row.crmUserId)).size !== 2) throw new Error('Invalid reviewed mapping');
const expected = structuredClone(before);
let grants = 0;
for (const row of mapping.users) {
  const user = expected.accounts.users.find(value => value.id === row.crmUserId);
  const actual = after.accounts.users.find(value => value.id === row.crmUserId);
  if (!user || !actual || !user.active || user.deletedAt) throw new Error('Mapped account unavailable');
  if (!user.sections?.includes('invoices')) {
    // Existing users have explicit sections in the reviewed production snapshot.
    if (!Array.isArray(user.sections)) throw new Error('Legacy grants require an explicit review');
    user.sections.push('invoices'); user.version++; grants++;
  }
}
const changedTopLevelKeys = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !isDeepStrictEqual(before[key], after[key]));
// Revision and the existing notification scheduler heartbeat are technical changes.
expected.revision = after.revision;
if (expected.push && after.push) expected.push.lastRunAt = after.push.lastRunAt;
const checks = {
  sourceUnchanged: before.sourceSha256 === after.sourceSha256,
  revisionNotRewound: after.revision >= before.revision,
  sessionsUnchanged: isDeepStrictEqual(before.accounts.sessions, after.accounts.sessions),
  onlyReviewedAccountGrants: isDeepStrictEqual(expected.accounts, after.accounts),
  allOtherDataUnchanged: isDeepStrictEqual(expected, after),
};
console.log(JSON.stringify({
  checks, reviewedGrantCount: grants, dataPreservationPassed: Object.values(checks).every(Boolean),
  strictByteContentUnchanged: isDeepStrictEqual(before, after),
  changedTopLevelKeys,
  note: 'False flags are preserved; classify concurrent provider/workflow changes separately. No data was modified.',
}, null, 2));
if (!Object.values(checks).every(Boolean)) process.exitCode = 2;

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

// Inspect a stopped snapshot only. Never clear leases or change business state.
const raw = readFileSync(process.argv[2] ?? 0, 'utf8');
const envelope = JSON.parse(raw);
if (createHash('sha256').update(JSON.stringify(envelope.data)).digest('hex') !== envelope.sha256) throw Error('Store checksum mismatch');
const counts = { bank: 0, saby: 0, etrn: 0 };
const inspect = (value, kind) => {
  if (!value || typeof value !== 'object') return;
  // Even expired persisted leases require inspection after a clean stop.
  if (value.leaseId != null || value.leaseUntil != null || value.lease != null) counts[kind]++;
  for (const [key, child] of Object.entries(value)) if (!['lease', 'leaseId', 'leaseUntil'].includes(key)) inspect(child, kind);
};
for (const key of ['sber', 'sberArtel', 'banking']) inspect(envelope.data[key], 'bank');
for (const key of ['saby', 'tripSaby']) inspect(envelope.data[key], 'saby');
inspect(envelope.data.etrn, 'etrn');
const passed = Object.values(counts).every(count => count === 0);
console.log(JSON.stringify({ passed, checksumVerified: true, stoppedSnapshotSha256: createHash('sha256').update(raw).digest('hex'), outstandingWorkflowLeaseCounts: counts }));
if (!passed) process.exitCode = 2;

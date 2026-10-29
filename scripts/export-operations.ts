// Consistent private snapshot for backups/audits; stdout contains sensitive data.
// Pipe directly into protected storage. Never log this output or pass it in argv.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { OperationsStore, encodeOperations } from '../server/operations-store';
const directory = process.env.ARTEL_STORE_DIR;
const snapshot = process.env.ARTEL_SNAPSHOT_DIR;
if (!directory || !snapshot) throw new Error('Explicit store and snapshot directories required');
const manifest = JSON.parse(await readFile(resolve(snapshot, 'manifest.json'), 'utf8'));
const source = manifest.meta?.source_sha256;
if (typeof source !== 'string' || !/^[a-f0-9]{64}$/.test(source)) throw new Error('Invalid source manifest');
process.stdout.write(encodeOperations(await new OperationsStore(resolve(directory)).read(source), source));

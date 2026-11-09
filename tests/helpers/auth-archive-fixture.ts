import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { OperationsStore } from '../../server/operations-store';
import { AuthPartition, migrateAuthStorage, migrateArchiveStorage } from '../../server/auth-partition';
import { emptyWork } from '../../web/src/work-model';
const source = 'a'.repeat(64), stamp = '2026-11-09T00:00:00Z';
export async function archiveFixture(v2 = true) {
  const directory = await mkdtemp(resolve(tmpdir(), 'archive-partition-')), store = new OperationsStore(directory);
  await store.mutate(source, data => {
    data.accounts = { users: ['owner', 'reserve'].map(id => ({ id, login: id, name: 'Synthetic owner', role: 'director' as const, active: true, version: 1, managerId: null, salt: 'a'.repeat(32), passwordHash: 'b'.repeat(128) })), sessions: [], attempts: {} };
    data.work = emptyWork(); data.push = { devices: [], deliveries: {} };
    data.shipments.example = { version: 1, fields: { note: 'preserve business data' }, createdAt: stamp, updatedAt: stamp };
    data.documentArchive = { categories: [{ id: 'c', name: 'Synthetic', createdAt: stamp, createdBy: 'owner' }], documents: [{ id: 'd', categoryId: 'c', title: 'Synthetic', expiresOn: null, fileName: 'file.txt', size: 3, data: 'YWJj', createdAt: stamp, createdBy: 'owner' }] };
    return { changed: true, result: null };
  });
  await migrateAuthStorage(directory, source);
  if (v2) await migrateArchiveStorage(directory, source);
  return { directory, store, part: new AuthPartition(store.path, 2), close: () => rm(directory, { recursive: true, force: true }) };
}

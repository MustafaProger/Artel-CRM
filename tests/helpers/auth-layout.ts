import { migrateAuthStorage, migrateArchiveStorage } from '../../server/auth-partition';

/** Explicit synthetic-fixture selection; never consulted by production. */
export const authLayoutVersion: 1 | 2 | null = process.env.ARTEL_TEST_AUTH_PARTITION === '2' ? 2 : process.env.ARTEL_TEST_AUTH_PARTITION === '1' ? 1 : null;
export async function migrateTestAuthStorage(directory: string, source: string) {
  await migrateAuthStorage(directory, source);
  if (authLayoutVersion === 2) await migrateArchiveStorage(directory, source);
}

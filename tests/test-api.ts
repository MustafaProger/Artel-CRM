// Domain tests have isolated temporary stores. Auth is exercised by api-auth.test.ts.
export * from '../server/local-api';
import { createSnapshotMiddleware as middleware, type LocalApiOptions } from '../server/local-api';
export function createSnapshotMiddleware(directory?: string, options: LocalApiOptions = {}) {
  return middleware(directory, { requireAuthentication: false, ...options });
}

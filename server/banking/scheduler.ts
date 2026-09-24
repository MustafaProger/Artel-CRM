import type { OperationsStorage } from '../operations-store';
import { BankingService } from './service';
import { sberConnections } from './sber-connections';
import { SberService } from './sber-service';
import type { BankRequest } from './transport';
import type { SberRequest } from './sber-client';

/** One page per connected bank; failures and retry delays never block the other bank. */
export async function dispatchBanks(store: OperationsStorage, source: string, env: Record<string, string | undefined> = process.env, bankRequest?: BankRequest, sberRequest?: SberRequest, now = Date.now()) {
  if (env.ARTEL_BANK_SYNC_ENABLED !== 'true') return { enabled: false, pending: false, failed: false, connections: [] };
  const results = await Promise.allSettled([
    new BankingService(store, source, env, bankRequest).dispatch(now),
    ...Object.values(sberConnections).map(connection => new SberService(store, source, env, sberRequest, connection).dispatch(now)),
  ]);
  const connections = results.map((result, index) => ({
    id: ['tbank-nk-artel', ...Object.keys(sberConnections)][index],
    pending: result.status === 'fulfilled' && !!result.value.pending,
    failed: result.status === 'rejected' || !!('failed' in result.value && result.value.failed),
  }));
  return { enabled: true, pending: connections.some(row => row.pending), failed: connections.some(row => row.failed), connections };
}

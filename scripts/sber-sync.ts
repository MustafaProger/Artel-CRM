import { loadEnv } from 'vite';
import { resolve } from 'node:path';
import { loadSnapshot } from '../server/local-api';
import { OperationsStore } from '../server/operations-store';
import { SberService } from '../server/banking/sber-service';
import { sberPeriod } from '../server/banking/sber-domain';
import { today } from '../server/banking/domain';

// Local operator utility. Credentials are read only from server configuration.
// Usage: node --import tsx scripts/sber-sync.ts 2026-09-01 2026-09-16
const env = loadEnv('development', process.cwd(), 'ARTEL_');
const { from, to } = sberPeriod(process.argv[2] ?? '2026-09-01', process.argv[3] ?? today());
const store = new OperationsStore(env.ARTEL_STORE_DIR ?? resolve('data/local-operations'));
const source = (await loadSnapshot()).provenance.sourceSha256;
const service = new SberService(store, source, env);
try {
  await service.start(from, to);
  for (;;) {
    const result = await service.tick();
    const state = await service.list(new URLSearchParams({ from, to }));
    if (state.lastError) throw new Error(state.lastError);
    console.log(JSON.stringify({ completedDays: state.days.length, operations: state.operations.length, nextDay: state.progress?.day ?? null }));
    if (!result.pending) break;
    const wait = state.progress?.nextAttemptAt ? Math.max(0, Date.parse(state.progress.nextAttemptAt) - Date.now()) : 350;
    await new Promise(resolve => setTimeout(resolve, Math.min(wait, 60000)));
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : 'Не удалось завершить обновление Сбера.');
  process.exitCode = 1;
}

export const BANK_SYNC_INTERVAL_MS = 5 * 60_000;
export const BANK_SYNC_TICK_MS = 5_000;

export function syncDue(lastScheduledAt: string | undefined, lastSuccessAt: string | undefined, now = Date.now()) {
  if (!lastSuccessAt) return false;
  const previous = Date.parse(lastScheduledAt ?? lastSuccessAt);
  return Number.isFinite(previous) && now - previous >= BANK_SYNC_INTERVAL_MS;
}

export const BANK_SYNC_INTERVAL_MS = 5 * 60_000;
export const BANK_SYNC_TICK_MS = 5_000;
export const BANK_SYNC_RETRY_LIMIT = 5;
export const BANK_SYNC_RETRY_COOLDOWN_MS = 15 * 60_000;

/** A saved retry time also distinguishes a recoverable outage from a stopped job. */
export function bankJobDue(job: { attempts: number; nextAttemptAt?: string }, now = Date.now()) {
  if (job.attempts >= BANK_SYNC_RETRY_LIMIT && !job.nextAttemptAt) return false;
  return !job.nextAttemptAt || Date.parse(job.nextAttemptAt) <= now;
}

export function bankRetryDelay(attempts: number, transient: boolean, retryAfterSeconds = 0): number | undefined {
  if (attempts >= BANK_SYNC_RETRY_LIMIT && !transient) return undefined;
  return Math.max(retryAfterSeconds * 1000, attempts >= BANK_SYNC_RETRY_LIMIT ? BANK_SYNC_RETRY_COOLDOWN_MS : 5_000 * 2 ** attempts);
}

export function syncDue(lastScheduledAt: string | undefined, lastSuccessAt: string | undefined, now = Date.now()) {
  if (!lastSuccessAt) return false;
  const previous = Date.parse(lastScheduledAt ?? lastSuccessAt);
  return Number.isFinite(previous) && now - previous >= BANK_SYNC_INTERVAL_MS;
}

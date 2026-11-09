import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';

export interface PerformanceTrace {
  id: string;
  label: string;
  totalMs: number;
  failed: boolean;
  spans: { name: string; startMs: number; durationMs: number }[];
  eventLoop: { activeMs: number; idleMs: number; utilization: number; delayMeanMs: number | null; delayMaxMs: number };
}
export type PerformanceSink = (trace: PerformanceTrace) => void;
const context = new AsyncLocalStorage<{ start: number; spans: PerformanceTrace['spans']; closed: boolean }>();
/** Only static stage names and timings: never accept request data as span names. */
export function performanceSpan<T>(name: string, action: () => T): T {
  const current = context.getStore();
  if (!current || current.closed) return action();
  const start = performance.now();
  const end = () => { if (!current.closed && current.spans.length < 2048) current.spans.push({ name, startMs: start - current.start, durationMs: performance.now() - start }); };
  try {
    const result = action();
    if (result instanceof Promise) return result.finally(end) as T;
    end(); return result;
  } catch (error) { end(); throw error; }
}
/** Opt-in diagnostics. Disabled requests allocate no trace and start no monitor.
 * Event-loop values concern the whole process during this interval, not request CPU.
 * Spans nest and overlap; their durations must not be summed as exclusive costs. */
export async function withPerformanceTrace<T>(label: string, action: () => Promise<T>, sink?: PerformanceSink): Promise<T> {
  if (!sink) return action();
  const current = { start: performance.now(), spans: [] as PerformanceTrace['spans'], closed: false };
  const elu = performance.eventLoopUtilization();
  const delay = monitorEventLoopDelay({ resolution: 10 });
  delay.enable();
  let failed = false;
  try { return await context.run(current, action); }
  catch (error) { failed = true; throw error; }
  finally {
    const totalMs = performance.now() - current.start;
    current.closed = true; delay.disable();
    const sample = performance.eventLoopUtilization(elu);
    try { sink({ id: randomUUID(), label, totalMs, failed, spans: current.spans,
      eventLoop: { activeMs: sample.active, idleMs: sample.idle, utilization: sample.utilization,
        delayMeanMs: Number.isFinite(delay.mean) ? delay.mean / 1e6 : null, delayMaxMs: delay.max / 1e6 } }); }
    catch { /* Diagnostics must never change request success or error behavior. */ }
  }
}

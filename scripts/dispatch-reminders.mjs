#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as wait } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

const localEndpoint = 'http://127.0.0.1:5173/api/push/dispatch';
const fields = ['checked', 'sent', 'failed', 'expired'];

export async function readRunnerConfig(env = process.env) {
  const address = env.ARTEL_REMINDERS_URL ?? localEndpoint;
  let endpoint;
  try { endpoint = new URL(address); } catch { throw new Error('ARTEL_REMINDERS_URL: укажите полный URL обработчика напоминаний.'); }
  const loopback = ['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname);
  if (/\s/.test(address) || !/^https?:\/\//.test(address) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash || endpoint.pathname !== '/api/push/dispatch' || endpoint.protocol !== 'https:' && !(endpoint.protocol === 'http:' && loopback)) {
    throw new Error('ARTEL_REMINDERS_URL: только /api/push/dispatch без логина, параметров и фрагмента; HTTP разрешён только для localhost.');
  }
  const intervalSeconds = Number(env.ARTEL_REMINDERS_INTERVAL_SECONDS ?? '60');
  if (![30, 60].includes(intervalSeconds)) throw new Error('ARTEL_REMINDERS_INTERVAL_SECONDS: допустимо 30 или 60.');
  const timeoutSeconds = Number(env.ARTEL_REMINDERS_TIMEOUT_SECONDS ?? '65');
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 65) throw new Error('ARTEL_REMINDERS_TIMEOUT_SECONDS: целое число от 1 до 65.');

  if (env.ARTEL_REMINDERS_SECRET_FILE && env.CRON_SECRET) throw new Error('Задайте CRON_SECRET либо ARTEL_REMINDERS_SECRET_FILE, но не оба.');
  const secretFile = env.ARTEL_REMINDERS_SECRET_FILE || (!env.CRON_SECRET && env.CREDENTIALS_DIRECTORY ? resolve(env.CREDENTIALS_DIRECTORY, 'cron-secret') : undefined);
  let secret = env.CRON_SECRET;
  if (secretFile) {
    try { secret = (await readFile(secretFile, 'utf8')).trim(); }
    catch { throw new Error('Не удалось прочитать файл секрета планировщика.'); }
  }
  if (typeof secret !== 'string' || !/^[\x21-\x7e]{32,512}$/.test(secret)) throw new Error('Задайте CRON_SECRET либо файл секрета: от 32 до 512 печатных ASCII-символов без пробелов.');
  return { endpoint: endpoint.href, secret, intervalSeconds, timeoutSeconds };
}

export async function dispatchOnce(config, { fetchImpl = fetch, signal } = {}) {
  const controller = new AbortController();
  const stop = () => controller.abort();
  if (signal?.aborted) stop();
  else signal?.addEventListener('abort', stop, { once: true });
  const timeout = setTimeout(stop, config.timeoutSeconds * 1000);
  try {
    let response;
    try {
      response = await fetchImpl(config.endpoint, {
        method: 'GET', headers: { Authorization: `Bearer ${config.secret}`, Accept: 'application/json' },
        redirect: 'error', signal: controller.signal,
      });
    } catch { throw new Error('Запрос не завершён: ошибка сети, перенаправление или тайм-аут.'); }
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error(`Обработчик напоминаний вернул HTTP ${response.status}.`);
    }
    let content = '';
    let bytes = 0;
    const decoder = new TextDecoder();
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Обработчик напоминаний вернул пустой ответ.');
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > 16384) {
          await reader.cancel();
          throw new Error('Ответ обработчика напоминаний превышает допустимый размер.');
        }
        content += decoder.decode(value, { stream: true });
      }
      content += decoder.decode();
    } finally { reader.releaseLock(); }
    let result;
    try { result = JSON.parse(content); } catch { throw new Error('Обработчик напоминаний вернул некорректный JSON.'); }
    if (!result || Array.isArray(result) || fields.some(key => !Number.isSafeInteger(result[key]) || result[key] < 0) || result.sent + result.failed + result.expired > result.checked) {
      throw new Error('В ответе обработчика отсутствуют корректные счётчики checked/sent/failed/expired.');
    }
    const counts = Object.fromEntries(fields.map(key => [key, result[key]]));
    if (counts.failed) throw new Error(`Есть неудачные отправки: ${JSON.stringify(counts)}. Сервер повторит их после истечения своего интервала ожидания.`);
    return counts;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', stop);
  }
}

export async function runScheduler(config, { once = false, signal, dispatch = dispatchOnce, log = console.log, logError = console.error } = {}) {
  while (!signal?.aborted) {
    const started = Date.now();
    try {
      const counts = await dispatch(config, { signal });
      log(JSON.stringify({ at: new Date().toISOString(), status: 'ok', durationMs: Date.now() - started, ...counts }));
      if (once) return 0;
    } catch (error) {
      if (signal?.aborted) return 0;
      logError(JSON.stringify({ at: new Date().toISOString(), status: 'error', durationMs: Date.now() - started, error: error instanceof Error ? error.message : 'Ошибка выполнения проверки.' }));
      if (once) return 1;
    }
    // Await both the request and the remaining interval; a slow request never overlaps the next one.
    try { await wait(Math.max(0, config.intervalSeconds * 1000 - (Date.now() - started)), undefined, { signal }); }
    catch (error) { if (!signal?.aborted) throw error; }
  }
  return 0;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === '--help') {
    console.log('node scripts/dispatch-reminders.mjs [--once]\nПо умолчанию: localhost:5173, каждые 60 секунд. Нужен CRON_SECRET или ARTEL_REMINDERS_SECRET_FILE. Настройки: ops/reminders/README.md.');
    return;
  }
  if (args.some(arg => arg !== '--once') || args.length > 1) throw new Error('Допустимы только --once или --help.');
  const config = await readRunnerConfig();
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  try { process.exitCode = await runScheduler(config, { once: args.includes('--once'), signal: controller.signal }); }
  finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error instanceof Error ? error.message : 'Ошибка запуска планировщика.'); process.exitCode = 1; });
}

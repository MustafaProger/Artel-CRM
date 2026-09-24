import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import { extname, isAbsolute, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ApiError } from './api-error';
import { createSnapshotMiddleware, loadSnapshot } from './local-api';
import { OperationsStore } from './operations-store';
import { bankRequest, type BankRequest } from './banking/transport';
import { sberRequest, type SberRequest } from './banking/sber-client';
import { dispatchBanks } from './banking/scheduler';
import { BANK_SYNC_TICK_MS } from './banking/schedule';
import { dispatchReminders, pushReady, type PushConfig } from './push';

type Environment = Record<string, string | undefined>;
const pausedBankMessage = 'Обновление банков на этом сервере пока выключено. Сохранённые данные доступны.';
const contentTypes: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json; charset=utf-8', '.woff': 'font/woff', '.woff2': 'font/woff2',
};

function required(env: Environment, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} must be configured`);
  return value;
}

export function productionConfiguration(env: Environment) {
  const origin = new URL(required(env, 'ARTEL_PUBLIC_ORIGIN'));
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.pathname !== '/' || origin.search || origin.hash) {
    throw new Error('ARTEL_PUBLIC_ORIGIN must be an HTTPS origin without a path');
  }
  const port = Number(env.PORT ?? '3000');
  if (!Number.isSafeInteger(port) || port < 0 || port > 65535) throw new Error('PORT must be a valid TCP port');
  return {
    origin: origin.origin, host: origin.host, port,
    listenHost: env.ARTEL_LISTEN_HOST?.trim() || '127.0.0.1',
    snapshotDirectory: resolve(required(env, 'ARTEL_SNAPSHOT_DIR')),
    storeDirectory: resolve(required(env, 'ARTEL_STORE_DIR')),
    // The working directory is the release root; only its compiled app is public.
    staticDirectory: resolve('app-dist'),
    bankRequestsEnabled: env.ARTEL_BANK_REQUESTS_ENABLED === 'true',
  };
}

/** Forwarded headers never establish trust: the proxy must preserve the configured Host. */
export function productionRequestAllowed(request: Pick<IncomingMessage, 'headers' | 'method'>, publicOrigin: string) {
  const origin = new URL(publicOrigin);
  if (request.headers.host !== origin.host || request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (request.headers.origin !== undefined) return request.headers.origin === origin.origin;
  return request.method === 'GET' || request.method === 'HEAD';
}

/** The guard covers manual requests, background jobs and Sber token refresh alike. */
export function productionBankTransports(env: Environment, requests: { bankRequest?: BankRequest; sberRequest?: SberRequest } = {}) {
  const enabled = env.ARTEL_BANK_REQUESTS_ENABLED === 'true';
  const blocked = async (): Promise<never> => { throw new ApiError(503, pausedBankMessage); };
  return {
    bankRequest: enabled ? requests.bankRequest ?? bankRequest : blocked as BankRequest,
    sberRequest: enabled ? requests.sberRequest ?? sberRequest : blocked as SberRequest,
  };
}

const within = (root: string, file: string) => {
  const path = relative(root, file);
  return path !== '..' && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

function json(response: ServerResponse, status: number, value: unknown) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

/** Inspect the original path before URL normalization can erase traversal segments. */
function requestPath(request: IncomingMessage): string | undefined {
  const raw = request.url?.split('?')[0];
  if (!raw?.startsWith('/') || raw.startsWith('//')) return;
  let path: string;
  try { path = decodeURIComponent(raw); } catch { return; }
  if (path.includes('\\') || [...path].some(char => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
      || path.startsWith('//') || path.includes('%')) return;
  const segments = path.split('/');
  if (segments.some(segment => segment.startsWith('.'))) return;
  if (['data', 'server', 'server-render', 'scripts', 'node_modules', 'src', 'config', 'ops', 'tests', 'qa'].includes(segments[1])) return;
  return path;
}

/** External links may open the public shell, but cannot relax API or asset access. */
function publicShellNavigationAllowed(request: IncomingMessage, publicOrigin: string, pathname: string | undefined) {
  if (!pathname || pathname === '/api' || pathname.startsWith('/api/') || pathname === '/healthz'
      || pathname === '/assets' || pathname.startsWith('/assets/')
      || (pathname !== '/index.html' && extname(pathname))) return false;
  const origin = new URL(publicOrigin);
  return request.headers.host === origin.host && request.method === 'GET'
    && request.headers['sec-fetch-site'] === 'cross-site'
    && request.headers['sec-fetch-mode'] === 'navigate'
    && request.headers['sec-fetch-dest'] === 'document'
    && (request.headers.origin === undefined || request.headers.origin === origin.origin);
}

async function serveStatic(request: IncomingMessage, response: ServerResponse, root: string, pathname: string) {
  if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Метод не поддерживается.' });
  const extension = extname(pathname);
  // Client-side navigation receives the shell; unknown file types never do.
  const assetPath = extension ? pathname : '/index.html';
  if (!contentTypes[extname(assetPath)]) return json(response, 404, { error: 'Файл не найден.' });
  let file: string;
  try {
    file = await realpath(resolve(root, `.${assetPath}`));
    if (!within(root, file) || !(await stat(file)).isFile()) return json(response, 404, { error: 'Файл не найден.' });
    const bytes = await readFile(file);
    const immutable = /^\/assets\/.+-[A-Za-z0-9_-]{8,}\.(js|css|woff2?|png|jpe?g|svg|webp)$/.test(assetPath);
    response.writeHead(200, {
      'Content-Type': contentTypes[extname(assetPath)], 'Content-Length': bytes.length,
      'Cache-Control': immutable ? 'public, max-age=31536000, immutable' : 'no-cache',
    });
    response.end(request.method === 'HEAD' ? undefined : bytes);
  } catch { json(response, 404, { error: 'Файл не найден.' }); }
}

export async function createProductionRuntime(env: Environment = process.env) {
  const configuration = productionConfiguration(env);
  const staticDirectory = await realpath(configuration.staticDirectory);
  const snapshotDirectory = await realpath(configuration.snapshotDirectory);
  const storeDirectory = await realpath(configuration.storeDirectory);
  if (within(staticDirectory, snapshotDirectory) || within(staticDirectory, storeDirectory)
      || within(snapshotDirectory, storeDirectory) || within(storeDirectory, snapshotDirectory)) {
    throw new Error('Snapshot, store and public directories must be separate');
  }
  if (!(await stat(resolve(staticDirectory, 'index.html'))).isFile()) throw new Error('Compiled application is missing');
  const base = await loadSnapshot(snapshotDirectory);
  const store = new OperationsStore(storeDirectory);
  // Never silently bootstrap an empty CRM when a persistent volume is missing.
  if (!(await stat(store.path)).isFile()) throw new Error('Persistent operations store is missing');
  await store.read(base.provenance.sourceSha256);
  const bankEnvironment = { ...env, ARTEL_BANK_SYNC_ENABLED: configuration.bankRequestsEnabled ? env.ARTEL_BANK_SYNC_ENABLED : 'false' };
  const transports = productionBankTransports(env);
  const push: PushConfig = {
    publicKey: env.VAPID_PUBLIC_KEY ?? '', privateKey: env.VAPID_PRIVATE_KEY ?? '',
    subject: env.VAPID_SUBJECT ?? '', schedule: env.PUSH_SCHEDULE_ENABLED === 'true',
  };
  const middleware = createSnapshotMiddleware(snapshotDirectory, {
    operationsStore: store, secureCookies: true, requireAuthentication: true,
    authorizeRequest: request => productionRequestAllowed(request, configuration.origin),
    bankEnvironment, ...transports, pushConfig: push, pushIntervalSeconds: 30,
    setupToken: env.ARTEL_SETUP_TOKEN, cronSecret: env.CRON_SECRET, checkoApiKey: env.CHECKO_API_KEY,
  });
  const server = createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
    response.setHeader('Referrer-Policy', 'same-origin');
    response.setHeader('X-Frame-Options', 'DENY');
    const pathname = requestPath(request);
    if (!productionRequestAllowed(request, configuration.origin)
        && !publicShellNavigationAllowed(request, configuration.origin, pathname)) return json(response, 403, { error: 'Доступ запрещён.' });
    if (!pathname) return json(response, 404, { error: 'Маршрут не найден.' });
    if (pathname === '/healthz') {
      if (request.method !== 'GET' && request.method !== 'HEAD') return json(response, 405, { error: 'Метод не поддерживается.' });
      response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      response.end(request.method === 'HEAD' ? undefined : '{"status":"ok"}');
      return;
    }
    if (!configuration.bankRequestsEnabled && pathname.startsWith('/api/banking/')
        && (request.method !== 'GET' || /\/(print|dispatch)$/.test(pathname))) return json(response, 503, { error: pausedBankMessage });
    if (pathname.startsWith('/api/')) {
      middleware(request, response, () => json(response, 404, { error: 'Маршрут не найден.' }));
      return;
    }
    void serveStatic(request, response, staticDirectory, pathname).catch(() => {
      if (!response.headersSent) json(response, 500, { error: 'Не удалось прочитать приложение.' });
      else response.destroy();
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 15_000;
  server.keepAliveTimeout = 5_000;
  const timers: ReturnType<typeof setInterval>[] = [];
  const pending = new Set<Promise<void>>();
  let stopping = false;
  function schedule(interval: number, action: () => Promise<unknown>, immediate = false) {
    let running = false;
    const tick = () => {
      if (stopping || running) return;
      running = true;
      const operation = Promise.resolve().then(action).then(() => undefined).catch(() => {
        // Responses and credentials must never be written to process logs.
        console.error('Плановая проверка не завершена; следующая попытка по расписанию.');
      }).finally(() => { running = false; pending.delete(operation); });
      pending.add(operation);
    };
    const timer = setInterval(tick, interval);
    timer.unref(); timers.push(timer);
    if (immediate) tick();
  }
  let stopPromise: Promise<void> | undefined;
  return {
    server,
    async start() {
      await new Promise<void>((done, reject) => {
        const onError = (error: Error) => { server.off('listening', onListen); reject(error); };
        const onListen = () => { server.off('error', onError); done(); };
        server.once('error', onError); server.once('listening', onListen);
        server.listen(configuration.port, configuration.listenHost);
      });
      if (configuration.bankRequestsEnabled && bankEnvironment.ARTEL_BANK_SYNC_ENABLED === 'true') {
        schedule(BANK_SYNC_TICK_MS, () => dispatchBanks(store, base.provenance.sourceSha256, bankEnvironment, transports.bankRequest, transports.sberRequest), true);
      }
      if (pushReady(push)) schedule(30_000, () => dispatchReminders(store, base.provenance.sourceSha256, push));
    },
    stop() {
      return stopPromise ??= (async () => {
        stopping = true;
        for (const timer of timers) clearInterval(timer);
        const close = new Promise<void>((done, reject) => {
          if (!server.listening) return done();
          server.close(error => error ? reject(error) : done());
          server.closeIdleConnections();
        });
        await Promise.all([close, ...pending]);
      })();
    },
  };
}

async function main() {
  const runtime = await createProductionRuntime();
  await runtime.start();
  console.info('Artel CRM production server is ready.');
  const shutdown = () => {
    const timeout = setTimeout(() => { console.error('Shutdown timed out.'); process.exit(1); }, 45_000);
    timeout.unref();
    void runtime.stop().then(() => { clearTimeout(timeout); }, () => { console.error('Shutdown failed.'); process.exitCode = 1; });
  };
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void main().catch(() => { console.error('Artel CRM startup failed: check configuration and persistent files.'); process.exitCode = 1; });
}

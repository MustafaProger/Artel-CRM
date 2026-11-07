#!/usr/bin/env node
// Read-only page/API timings. No login, writes, refreshes, dispatches, or provider calls.
// Endpoint allowlist follows web/src/{App,AuthGate,OverviewPage,WorkPage,ShipmentsPage,
// TripsPage,TripRequestsMap,BankingPage,CabinetBalances,ChinaPage,AccountManagement,
// DirectoriesPage,PushSettings}.tsx. Bank/cabinet GET handlers read saved local data.
import http from 'node:http';
import https from 'node:https';
import { lstat, readFile, writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';

const day = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
const bankPeriod = new URLSearchParams({ from: `${day.slice(0, 7)}-01`, to: day });
const shipmentQuery = type => new URLSearchParams({ type, organization: 'all', period: 'all', query: '', manager: 'all', settlement: 'all', sort: 'date', direction: 'desc', filters: '{}', limit: '50', offset: '0' });
const endpoints = [
  { id: 'health', path: '/healthz', public: true },
  { id: 'shell', path: '/', public: true },
  { id: 'session', path: '/api/auth/session', public: true },
  { id: 'snapshot', path: '/api/snapshot?shipments=omit' },
  { id: 'overview', path: '/api/settlements' },
  { id: 'work', path: '/api/work' },
  { id: 'shipments', path: `/api/shipments?${shipmentQuery('tanker')}` },
  { id: 'azs', path: `/api/shipments?${shipmentQuery('azs')}` },
  { id: 'trips', path: '/api/shipment-trips' },
  { id: 'trip-requests', path: '/api/trip-requests' },
  { id: 'trip-map-config', path: '/api/trip-requests/map-config' },
  { id: 'banking', path: `/api/banking?${bankPeriod}&q=&direction=&account=&status=&connection=&page=1&pageSize=25` },
  { id: 'sber-artel', path: `/api/banking/sber/sber-artel/statements?${bankPeriod}` },
  { id: 'sber-nk-artel', path: `/api/banking/sber/sber-nk-artel/statements?${bankPeriod}` },
  { id: 'cabinets', path: '/api/cabinets' },
  { id: 'china', path: '/api/china' },
  { id: 'accounts', path: '/api/auth/users' },
  { id: 'directories', path: '/api/directories' },
  { id: 'push-config', path: '/api/push/config' },
];

function usage() {
  console.log(`Read-only Artel CRM HTTP benchmark (Node keep-alive; milliseconds).
Usage: node scripts/verify_page_latency.mjs [options]
  --base-url URL      Default: http://127.0.0.1:18083 (origin only)
  --host HOST         Default: artel-crm.online
  --samples N         5–10 sequential samples per endpoint; default 7
  --burst             Also measure the same sample count with 4 concurrent workers
  --only IDS          Comma-separated endpoint IDs from the allowlist below
  --public-only       Measure health and shell only; no session or private data
  --timeout-ms N      Per-request deadline, default 15000 (1000–60000)
  --output FILE       Save summary JSON to a NEW file, mode 0600
  --list              List endpoint IDs and paths; make no requests
  --help              Show this help; make no requests
Environment: ARTEL_PERF_COOKIE_FILE is a private regular file (0600) containing
the raw Cookie request-header value only. No cookie is accepted on the CLI.
Protected reads require a session with user != null. 401/403 and HTML returned
for an API are failures, never successful authenticated latency measurements.
No response bodies, cookies, user identities, or provider credentials are saved.
Transfers use Accept-Encoding: identity. First samples include connection setup;
these are HTTP timings, not browser rendering or full page-load measurements.
Endpoint IDs: ${endpoints.map(row => row.id).join(', ')}`);
}

function configFromArgs() {
  const config = { baseUrl: 'http://127.0.0.1:18083', host: 'artel-crm.online', samples: 7, timeoutMs: 15000, burst: false, publicOnly: false, only: null, output: null, list: false, help: false };
  const names = { '--base-url': 'baseUrl', '--host': 'host', '--samples': 'samples', '--timeout-ms': 'timeoutMs', '--only': 'only', '--output': 'output' };
  const flags = { '--burst': 'burst', '--public-only': 'publicOnly', '--list': 'list', '--help': 'help' };
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (Object.hasOwn(flags, arg)) config[flags[arg]] = true;
    else if (Object.hasOwn(names, arg) && args[index + 1] && !args[index + 1].startsWith('--')) config[names[arg]] = args[++index];
    else throw new Error('Unknown option or missing value. Use --help.');
  }
  const base = new URL(config.baseUrl);
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || base.pathname !== '/') throw new Error('--base-url must be an HTTP(S) origin without credentials, a path, query, or fragment.');
  if (!/^[A-Za-z0-9.-]+(?::[0-9]+)?$/.test(config.host)) throw new Error('Invalid --host header.');
  for (const [key, low, high] of [['samples', 5, 10], ['timeoutMs', 1000, 60000]]) {
    config[key] = Number(config[key]);
    if (!Number.isSafeInteger(config[key]) || config[key] < low || config[key] > high) throw new Error(`Invalid ${key}: expected an integer from ${low} to ${high}.`);
  }
  if (config.publicOnly && config.only) throw new Error('Choose --public-only or --only, not both.');
  const ids = config.only?.split(',');
  if (ids?.some(id => !endpoints.some(endpoint => endpoint.id === id))) throw new Error('Unknown endpoint ID. Use --list.');
  config.selected = endpoints.filter(endpoint => config.publicOnly ? ['health', 'shell'].includes(endpoint.id) : !ids || ids.includes(endpoint.id));
  config.baseUrl = base.origin;
  return config;
}

async function readCookie() {
  const file = process.env.ARTEL_PERF_COOKIE_FILE;
  if (!file) return null;
  // Refuse symlinks and shared files; never include the path/content in errors.
  let info;
  try { info = await lstat(file); } catch { throw new Error('Cannot read ARTEL_PERF_COOKIE_FILE metadata.'); }
  if (!info.isFile() || (info.mode & 0o077) || info.size > 16384) throw new Error('ARTEL_PERF_COOKIE_FILE must be a private regular file (0600), at most 16 KiB.');
  let value;
  try { value = (await readFile(file, 'utf8')).trim(); } catch { throw new Error('Cannot read ARTEL_PERF_COOKIE_FILE.'); }
  if (!value || /[\r\n\x00-\x1f\x7f]/.test(value) || value.startsWith('Cookie:') || !value.includes('=')) throw new Error('ARTEL_PERF_COOKIE_FILE must contain one raw Cookie header value.');
  return value;
}

const rounded = value => Math.round(value * 100) / 100;
function stats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), middle = Math.floor(sorted.length / 2);
  return { min: rounded(sorted[0]), median: rounded(sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2), p95: rounded(sorted[Math.ceil(sorted.length * .95) - 1]), max: rounded(sorted.at(-1)) };
}

function summarize(samples) {
  const successful = samples.filter(sample => sample.ok);
  const statuses = {}, errors = {};
  for (const sample of samples) {
    const status = sample.status ?? 'network-error';
    statuses[status] = (statuses[status] ?? 0) + 1;
    if (sample.error) errors[sample.error] = (errors[sample.error] ?? 0) + 1;
  }
  return { requests: samples.length, successful: successful.length, failed: samples.length - successful.length, statuses, errors,
    bytes: { total: samples.reduce((sum, row) => sum + row.bytes, 0), min: Math.min(...samples.map(row => row.bytes)), max: Math.max(...samples.map(row => row.bytes)) },
    latencyMs: stats(successful.map(row => row.elapsedMs)), ttfbMs: stats(successful.map(row => row.ttfbMs)),
    failureLatencyMs: stats(samples.filter(row => !row.ok).map(row => row.elapsedMs)), firstMs: samples[0]?.elapsedMs ?? null };
}

function requestOnce(config, agent, cookie, endpoint) {
  return new Promise(resolve => {
    const started = performance.now();
    let bytes = 0, status = null, ttfbMs = null, done = false, timer, authenticated = false;
    const finish = (ok, error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ok, status, bytes, elapsedMs: rounded(performance.now() - started), ttfbMs, ...(error ? { error } : {}), ...(endpoint.id === 'session' ? { authenticated } : {}) });
    };
    const headers = { Host: config.host, Accept: endpoint.id === 'shell' ? 'text/html' : 'application/json', 'Accept-Encoding': 'identity', 'Cache-Control': 'no-cache', 'User-Agent': 'Artel-CRM-read-only-latency-check/1' };
    if (cookie) headers.Cookie = cookie;
    const url = new URL(endpoint.path, config.baseUrl);
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method: 'GET', headers, agent }, response => {
      status = response.statusCode ?? 0;
      ttfbMs = rounded(performance.now() - started);
      const chunks = [];
      response.on('data', chunk => {
        bytes += chunk.length;
        if (bytes > (endpoint.id === 'session' ? 262144 : 33554432)) {
          finish(false, 'RESPONSE_TOO_LARGE');
          req.destroy();
          return;
        }
        if (endpoint.id === 'session') chunks.push(chunk);
      });
      response.on('error', () => finish(false, 'RESPONSE_STREAM_ERROR'));
      response.on('aborted', () => finish(false, 'RESPONSE_ABORTED'));
      response.on('end', () => {
        if (status < 200 || status >= 300) return finish(false, status === 401 ? 'UNAUTHORIZED' : status === 403 ? 'FORBIDDEN' : `HTTP_${status}`);
        const contentType = String(response.headers['content-type'] ?? '');
        if (!(endpoint.id === 'shell' ? /text\/html/i : /application\/json/i).test(contentType)) return finish(false, 'UNEXPECTED_CONTENT_TYPE');
        if (endpoint.id === 'session') {
          try {
            const session = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            authenticated = !!session?.user?.id && session.user.active === true && !session.user.deletedAt;
          } catch { return finish(false, 'INVALID_SESSION_JSON'); }
          if (!authenticated) return finish(false, 'UNAUTHENTICATED_SESSION');
        }
        finish(true);
      });
    });
    req.on('error', error => finish(false, /^[A-Z0-9_]+$/.test(error.code ?? '') ? error.code : 'REQUEST_ERROR'));
    timer = setTimeout(() => { finish(false, 'REQUEST_TIMEOUT'); req.destroy(); }, config.timeoutMs);
    req.end();
  });
}

async function run() {
  const config = configFromArgs();
  if (config.help) { usage(); return; }
  if (config.list) { for (const endpoint of endpoints) console.log(`${endpoint.id.padEnd(18)} ${endpoint.path}`); return; }
  const cookie = await readCookie();
  const transport = config.baseUrl.startsWith('https:') ? https : http;
  const agent = new transport.Agent({ keepAlive: true, maxSockets: 4, maxFreeSockets: 4 });
  const started = new Date(), runStart = performance.now();
  const summary = { startedAt: started.toISOString(), baseUrl: config.baseUrl, host: config.host, samplesPerEndpoint: config.samples,
    transferEncoding: 'identity', keepAlive: true, cookieSupplied: !!cookie, authenticated: false, allPassed: false,
    scope: config.publicOnly ? 'public-only' : 'selected-authenticated-pages', preflight: null, sequential: [], burst: null, skipped: [] };
  const measured = [];
  try {
    const needsAuth = config.selected.some(endpoint => !endpoint.public || endpoint.id === 'session');
    if (needsAuth) {
      const preflight = await requestOnce(config, agent, cookie, endpoints.find(endpoint => endpoint.id === 'session'));
      summary.preflight = preflight;
      summary.authenticated = preflight.ok && preflight.authenticated;
      if (!summary.authenticated) console.error(`Authenticated benchmark unavailable: /api/auth/session returned ${preflight.status ?? 'no HTTP response'} (${preflight.error}). Protected endpoints will be skipped. Supply a valid private ARTEL_PERF_COOKIE_FILE; a fast authorization refusal is not a page-load result.`);
    }
    for (const endpoint of config.selected) {
      if (!endpoint.public && !summary.authenticated) { summary.skipped.push({ id: endpoint.id, reason: 'AUTHENTICATION_NOT_CONFIRMED' }); continue; }
      const samples = [];
      for (let index = 0; index < config.samples; index++) samples.push(await requestOnce(config, agent, cookie, endpoint));
      measured.push(...samples);
      const row = { id: endpoint.id, path: endpoint.path, ...summarize(samples), samples };
      summary.sequential.push(row);
      console.log(`${endpoint.id.padEnd(18)} ${row.successful}/${row.requests} OK  bytes=${row.bytes.min}–${row.bytes.max}  min/median/p95/max=${row.latencyMs ? Object.values(row.latencyMs).join('/') : 'not measured'} ms  status=${JSON.stringify(row.statuses)}${row.failed ? ` errors=${JSON.stringify(row.errors)}` : ''}`);
    }
    if (config.burst) {
      const candidates = config.selected.filter(endpoint => endpoint.public ? endpoint.id !== 'session' || summary.authenticated : summary.authenticated);
      const jobs = Array.from({ length: config.samples }, () => candidates).flat();
      const results = [];
      let next = 0;
      const burstStart = performance.now();
      await Promise.all(Array.from({ length: Math.min(4, jobs.length) }, async () => {
        while (next < jobs.length) {
          const index = next++, endpoint = jobs[index];
          results[index] = { id: endpoint.id, ...await requestOnce(config, agent, cookie, endpoint) };
        }
      }));
      measured.push(...results);
      summary.burst = { concurrency: 4, wallMs: rounded(performance.now() - burstStart), endpoints: candidates.map(endpoint => ({ id: endpoint.id, path: endpoint.path, ...summarize(results.filter(row => row.id === endpoint.id)) })), total: results.length ? summarize(results) : null };
      console.log(`Burst: ${results.length} GETs, at most 4 concurrent, ${summary.burst.wallMs} ms wall time, ${summary.burst.total?.failed ?? 0} failed.`);
    }
    summary.total = measured.length ? summarize(measured) : null;
    summary.wallMs = rounded(performance.now() - runStart);
    summary.completedAt = new Date().toISOString();
    summary.allPassed = !!measured.length && measured.every(row => row.ok) && !summary.skipped.length && (!needsAuth || summary.authenticated);
    console.log(`Total: ${summary.total?.requests ?? 0} measured requests; ${summary.total?.failed ?? 0} failures; ${summary.skipped.length} skipped; ${summary.wallMs} ms wall; authenticated=${summary.authenticated}; allPassed=${summary.allPassed}.`);
    console.log('Timings exclude browser rendering. Successful and failed response timings are reported separately; first requests include connection setup.');
    if (config.output) await writeFile(config.output, `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    if (!summary.allPassed) process.exitCode = 1;
  } finally { agent.destroy(); }
}

run().catch(error => {
  // Our fixed validation messages are safe; filesystem/network exception text is not.
  const message = error?.code ? `Benchmark failed (${/^[A-Z0-9_]+$/.test(error.code) ? error.code : 'ERROR'}).` : error instanceof TypeError ? 'Invalid benchmark configuration.' : error.message;
  console.error(message);
  process.exitCode = 1;
});

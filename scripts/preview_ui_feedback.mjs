// Disposable local UI review with deliberately slow API responses. No live store/provider access.
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, extname, sep } from 'node:path';
import { createServer, request as httpRequest } from 'node:http';
import { randomUUID } from 'node:crypto';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
const root = resolve(import.meta.dirname, '..'), port = Number(process.env.ARTEL_UI_PREVIEW_PORT || 5261), built = process.argv.includes('--built');
for (const key of Object.keys(process.env)) if (/^(ARTEL_|SABY_|SBER_|BANK_|VAPID_|PUSH_|CHECKO_|CRON_|BLOB_|VERCEL_)/.test(key)) delete process.env[key];
Object.assign(process.env, { ARTEL_OPERATOR_QA_BUILT: built ? '1' : '0', SABY_WORKFLOW_ENABLED: 'false', ARTEL_CABINET_SYNC_ENABLED: 'false', ARTEL_GEOCODER_ENABLED: 'false', ARTEL_BANK_SYNC_ENABLED: 'false', ARTEL_BANK_REQUESTS_ENABLED: 'false', PUSH_SCHEDULE_ENABLED: 'false' });
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => { const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1') return Promise.reject(new Error('External providers disabled in local review')); return originalFetch(input, init); };
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-ui-review-')), snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store');
await writeTripsQaSnapshot(snapshotDirectory);
const runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
const { cookie } = await runtime.bootstrap();
const api = async (path, body) => { const response = await fetch(runtime.base + path, { method: body ? 'POST' : 'GET', headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const value = await response.json(); if (!response.ok) throw new Error(JSON.stringify(value)); return value; };
await api('/api/directories', { kind: 'products', name: 'Дизельное топливо межсезонное для Северо-Западного транспортного подразделения' });
const vehicle = await api('/api/directories', { kind: 'vehicles', plate: 'УЧЕБНЫЙ-001', capacityLitres: '10000' });
await api('/api/directories', { vehicleId: vehicle.entry.id, kind: 'drivers', name: 'Учебный водитель', fullName: 'Александр Константинович Северо-Западный', phone: '+70000000000' });
await api('/api/work/tasks', { requestId: randomUUID(), title: 'Проверить отступы, сохранение и сообщения об ошибках', description: 'Это учебная запись локального стенда. Можно редактировать и удалять.', assigneeId: (await api('/api/auth/session')).user.id });
await api('/api/documents/categories', { name: 'Учебные документы' });
const archive = await api('/api/documents');
await api('/api/documents/cards', { categoryId: archive.categories.find(item => item.name === 'Учебные документы').id, name: 'Договор поставки топлива — учебный образец', version: 1, files: [] });
await api('/api/operator/plans', { clientName: 'Учебное задание для проверки интерфейса', idempotencyKey: randomUUID(), recipients: [{ id: randomUUID(), name: 'Учебный получатель', bank: 'Учебный банк', card: '0000 0000 0000 0001', phone: '+70000000000', details: '', limit: '10000' }] });
const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://127.0.0.1:${port}`);
  if (url.pathname === '/__loading-audit') { response.writeHead(302, { Location: '/__loading-audit/' }); return response.end(); }
  if (url.pathname.startsWith('/__loading-audit/')) {
    const auditRoot = resolve(root, '../reaudit-20261105');
    let relative;
    try { relative = decodeURIComponent(url.pathname.replace(/^\/__loading-audit\/?/, '')) || 'gallery.html'; }
    catch { response.writeHead(400); return response.end('Invalid path'); }
    const file = resolve(auditRoot, relative);
    const allowed = ['gallery.html', 'subviews.html'].includes(relative) || /^(before-evidence|before-evidence-final|after-evidence|after-initial-evidence|normal-evidence|subview-evidence|after-populated-evidence)\/.*\.(png|webm|json|html)$/.test(relative);
    if (!allowed || relative.split('/').some(segment => segment === '..' || segment === '.') || !file.startsWith(auditRoot + sep)) { response.writeHead(404); return response.end('Not found'); }
    try {
      const bytes = await readFile(file);
      const type = { '.html': 'text/html; charset=utf-8', '.json': 'application/json; charset=utf-8', '.png': 'image/png', '.webm': 'video/webm' }[extname(file)];
      const headers = { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Accept-Ranges': 'bytes' };
      if (request.headers.range) {
        const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
        const start = range?.[1] ? Number(range[1]) : Math.max(0, bytes.length - Number(range?.[2]));
        const end = range?.[1] && range[2] ? Math.min(Number(range[2]), bytes.length - 1) : bytes.length - 1;
        if (!range || (!range[1] && !range[2]) || !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= bytes.length) {
          response.writeHead(416, { ...headers, 'Content-Range': `bytes */${bytes.length}` }); return response.end();
        }
        response.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${bytes.length}`, 'Content-Length': end - start + 1 }); return response.end(bytes.subarray(start, end + 1));
      }
      response.writeHead(200, { ...headers, 'Content-Length': bytes.length }); return response.end(bytes);
    } catch { response.writeHead(404); return response.end('Audit is not available yet'); }
  }
  if (url.pathname === '/__preview') { response.writeHead(302, { 'Set-Cookie': cookie + '; Path=/; HttpOnly; SameSite=Strict', Location: '/?ui-preview=synthetic#' + (url.searchParams.get('page') || 'overview') }); return response.end(); }
  const forward = () => {
    const headers = { ...request.headers, host: new URL(runtime.base).host }; if (headers.origin) headers.origin = runtime.base;
    const upstream = httpRequest(runtime.base + request.url, { method: request.method, headers }, result => { response.writeHead(result.statusCode, { ...result.headers, 'content-security-policy': "connect-src 'self' ws://127.0.0.1:*; img-src 'self' data: blob:; frame-src 'none'" }); result.pipe(response); });
    upstream.on('error', () => { response.writeHead(502); response.end('Local preview unavailable'); }); request.pipe(upstream);
  };
  if (url.pathname.startsWith('/api/') && !['/api/auth/session', '/api/navigation'].includes(url.pathname)) setTimeout(forward, 800); else forward();
});
await new Promise(done => server.listen(port, '127.0.0.1', done));
console.log(JSON.stringify({ url: `http://127.0.0.1:${port}/__preview`, syntheticOnly: true, delayMs: 800, mode: runtime.mode, temporaryStore: temporary }));
const close = async () => { await new Promise(done => server.close(done)); await runtime.server.close(); await rm(temporary, { recursive: true, force: true }); process.exit(); };
process.on('SIGTERM', close); process.on('SIGINT', close);

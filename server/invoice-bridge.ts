import { createHash, createHmac, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { ApiError } from './api-error';
import { hasSection, type AccountUser } from '../web/src/auth-model';
import type { OperationsData, OperationsStorage } from './operations-store';

const digest = (body: Uint8Array) => createHash('sha256').update(body).digest('hex');
const uuid = '[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}';
const jobRoute = new RegExp(`^/api/invoices/jobs/${uuid}(?:/(retry|file))?$`);
export function invoiceRouteAllowed(path: string, method: string) {
  const url = new URL(path, 'http://bridge.invalid');
  if (path.length > 4096 || url.origin !== 'http://bridge.invalid' || url.hash || url.pathname !== path.split('?')[0]) return false;
  if (url.pathname === '/api/invoices') return method === 'GET' || method === 'POST';
  if (url.pathname === '/api/invoices/prepare') return method === 'POST';
  if (url.pathname === '/api/invoices/settings') return method === 'PATCH';
  const match = url.pathname.match(jobRoute);
  return !!match && method === (match[1] === 'retry' ? 'POST' : 'GET');
}
export interface BridgeReply { status: number; body: Buffer; contentType: string; disposition?: string }
export interface InvoiceEvent { id: string; type: 'invoice.ready'; crmUserId: string; jobId: string; occurredAt: string }

/** The destination and credential are server configuration, never browser input. */
export class InvoiceBridge {
  private userRequests = 0;
  private serviceRequests = 0;
  constructor(private readonly origin: string, private readonly key: Buffer, private readonly fetcher: typeof fetch = fetch) {
    const url = new URL(origin);
    if (!['invoices', '127.0.0.1', 'localhost'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash || key.length !== 32) throw new Error('Invalid invoice bridge configuration');
  }
  async request(path: string, method = 'GET', body = Buffer.alloc(0), identity?: { crmUserId: string; sessionHash: string; displayName?: string }, refreshCatalogs = false): Promise<BridgeReply> {
    if (identity ? this.userRequests >= 4 : this.serviceRequests >= 1) throw new ApiError(503, 'Обработчик счетов занят. Повторите проверку по прежнему ключу.');
    if (identity) this.userRequests++; else this.serviceRequests++;
    const now = Date.now();
    const context = Buffer.from(JSON.stringify({
      v: 1, aud: 'artel-invoices', kind: identity ? 'user' : 'service', ...identity,
      iat: now, exp: now + 30000, nonce: randomUUID(), method, path, bodySha256: digest(body),
    })).toString('base64url');
    const signature = createHmac('sha256', this.key).update(`artel-invoices-v1\n${context}`).digest('base64url');
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), identity ? 360000 : 15000);
    timeout.unref();
    try {
      const response = await this.fetcher(this.origin + path, {
        method, redirect: 'error', signal: controller.signal,
        headers: {
          'X-Artel-Bridge-Context': context, 'X-Artel-Bridge-Signature': signature,
          ...(body.length ? { 'Content-Type': 'application/json' } : {}),
          ...(identity && refreshCatalogs && method === 'GET' && path === '/api/invoices' ? { 'X-Artel-Catalog-Refresh': '1' } : {}),
        },
        ...(body.length ? { body: new Uint8Array(body) } : {}),
      });
      if (response.status >= 300 && response.status < 400) throw new Error('Unexpected redirect');
      const maximum = path.endsWith('/file') ? 10 * 1024 * 1024 : 16 * 1024 * 1024;
      if (Number(response.headers.get('content-length') ?? 0) > maximum) throw new Error('Oversized reply');
      const chunks: Uint8Array[] = [];
      let size = 0;
      if (response.body) {
        const reader = response.body.getReader();
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.length;
            if (size > maximum) { controller.abort(); throw new Error('Oversized reply'); }
            chunks.push(chunk.value);
          }
        } finally { reader.releaseLock(); }
      }
      return { status: response.status, body: Buffer.concat(chunks), contentType: response.headers.get('content-type') ?? 'application/json', disposition: response.headers.get('content-disposition') ?? undefined };
    } catch {
      // A failed POST response is not proof that its durable invoice was rejected.
      throw new ApiError(502, 'Связь с обработчиком счетов прервалась. Состояние запроса проверяется по прежнему ключу.');
    } finally { clearTimeout(timeout); if (identity) this.userRequests--; else this.serviceRequests--; }
  }
  async service(path: string, value?: unknown) {
    const response = await this.request(path, value === undefined ? 'GET' : 'POST', value === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(value)));
    if (response.status !== 200) throw new Error('Invoice service request failed');
    try { return JSON.parse(response.body.toString('utf8')) as unknown; } catch { throw new Error('Invalid invoice service response'); }
  }
}

export async function configuredInvoiceBridge(env: Record<string, string | undefined>) {
  if (!env.ARTEL_INVOICES_URL && !env.ARTEL_INVOICES_BRIDGE_KEY_FILE) return undefined;
  if (!env.ARTEL_INVOICES_URL || !env.ARTEL_INVOICES_BRIDGE_KEY_FILE) throw new Error('Incomplete invoice bridge configuration');
  const key = await readFile(env.ARTEL_INVOICES_BRIDGE_KEY_FILE, 'utf8');
  if (!/^[a-f0-9]{64}\n?$/.test(key)) throw new Error('Invalid invoice bridge key file');
  return new InvoiceBridge(env.ARTEL_INVOICES_URL.replace(/\/$/, ''), Buffer.from(key.trim(), 'hex'));
}

export async function invoiceRequestBody(request: IncomingMessage) {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    length += Buffer.byteLength(chunk);
    if (length > 128 * 1024) throw new ApiError(413, 'Размер запроса превышает допустимый предел.');
    chunks.push(Buffer.from(chunk));
  }
  const body = Buffer.concat(chunks);
  if (request.method === 'GET') {
    if (body.length) throw new ApiError(400, 'GET не должен содержать тело.');
  } else {
    if (request.headers['content-type']?.split(';')[0] !== 'application/json') throw new ApiError(415, 'Передайте данные в формате application/json.');
    try {
      const value: unknown = JSON.parse(body.toString('utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    } catch { throw new ApiError(400, 'Некорректный JSON запроса.'); }
  }
  return body;
}
export function requireInvoiceAccount(actor: AccountUser, request: IncomingMessage) {
  if (!hasSection(actor, 'invoices')) throw new ApiError(403, 'Раздел недоступен. Обратитесь к администратору.');
  if (request.headers['x-artel-account'] !== actor.id) throw new ApiError(401, 'Пользователь изменился. Обновите страницу.');
}

/** Queue revocation in the same transaction that invalidates the CRM session. */
export function queueInvoiceRevocations(data: OperationsData, hashes: string[]) {
  if (!hashes.length) return;
  const push = data.push ??= { devices: [], deliveries: {} };
  const queue = push.invoiceRevocations ??= {};
  for (const hash of hashes) if (/^[a-f0-9]{64}$/.test(hash)) queue[hash] = Date.now();
}

export async function syncInvoiceEvents(bridge: InvoiceBridge, store: OperationsStorage, source: string) {
  const current = await store.read(source);
  for (const sessionHash of Object.keys(current.push?.invoiceRevocations ?? {}).slice(0, 20)) {
    await bridge.service('/internal/crm/sessions/revoke', { sessionHash });
    await store.mutate(source, data => {
      const changed = !!data.push?.invoiceRevocations?.[sessionHash];
      if (changed) delete data.push!.invoiceRevocations![sessionHash];
      return { result: null, changed };
    });
  }
  const value = await bridge.service('/internal/crm/events') as { events?: InvoiceEvent[]; hasMore?: boolean };
  if (!value || !Array.isArray(value.events) || value.events.length > 100 || typeof value.hasMore !== 'boolean') throw new Error('Invalid invoice event feed');
  const events = value.events;
  for (const event of events) if (!event || event.type !== 'invoice.ready' || !new RegExp(`^${uuid}$`).test(event.jobId) || event.id !== `invoice-ready:${event.jobId}` || typeof event.crmUserId !== 'string' || !event.crmUserId || !Number.isFinite(Date.parse(event.occurredAt))) throw new Error('Invalid invoice event');
  if (!events.length) return;
  await store.mutate(source, data => {
    const push = data.push ??= { devices: [], deliveries: {} };
    const saved = push.invoiceEvents ??= {};
    let changed = false;
    for (const event of events) {
      const row = { userId: event.crmUserId, jobId: event.jobId, occurredAt: Date.parse(event.occurredAt) };
      const previous = saved[event.id];
      if (previous && JSON.stringify(previous) !== JSON.stringify(row)) throw new Error('Conflicting invoice event');
      if (!previous) { saved[event.id] = row; changed = true; }
    }
    return { result: null, changed };
  });
  // A crash before this acknowledgement merely repeats the deduplicated import.
  await bridge.service('/internal/crm/events/ack', { ids: events.map(event => event.id) });
}

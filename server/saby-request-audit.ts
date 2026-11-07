import { createHash } from 'node:crypto';

/** Safe persistence boundary. Neither object contains request parameters, headers or raw response text. */
export interface SabyRequestIntent {
  version: 1; method: string; requestId: number; requestedAt: string;
  bodySha256?: string; bodyBytes?: number;
}
export interface SabyResponseDiagnostic {
  receivedAt: string; httpStatus: number;
  bodyState: 'complete' | 'truncated' | 'timeout' | 'unavailable';
  bodySha256?: string; bodyBytes?: number;
  rpcCode?: number; rpcIdMatches?: boolean; message?: string;
}
export type SabyBeforeDispatch = (intent: SabyRequestIntent) => Promise<void>;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const digest = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const dated = (value: unknown) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value));
const size = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= 512 * 1024 * 1024;
const rpcCode = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= 2_147_483_647;
export function isSabyRequestIntent(value: unknown): value is SabyRequestIntent {
  return object(value) && !Object.keys(value).some(key => !['version', 'method', 'requestId', 'requestedAt', 'bodySha256', 'bodyBytes'].includes(key))
    && value.version === 1 && typeof value.method === 'string' && /^[A-Za-zА-Яа-яЁё0-9_.]{1,96}$/.test(value.method)
    && Number.isSafeInteger(value.requestId) && Number(value.requestId) > 0 && dated(value.requestedAt)
    && (value.bodySha256 === undefined && value.bodyBytes === undefined || digest(value.bodySha256) && size(value.bodyBytes))
    && (value.method !== 'СБИС.Аутентифицировать' || value.bodySha256 === undefined);
}
export function isSabyResponseDiagnostic(value: unknown): value is SabyResponseDiagnostic {
  return object(value) && !Object.keys(value).some(key => !['receivedAt', 'httpStatus', 'bodyState', 'bodySha256', 'bodyBytes', 'rpcCode', 'rpcIdMatches', 'message'].includes(key))
    && dated(value.receivedAt) && Number.isInteger(value.httpStatus) && Number(value.httpStatus) >= 100 && Number(value.httpStatus) <= 599
    && ['complete', 'truncated', 'timeout', 'unavailable'].includes(String(value.bodyState))
    && (value.bodySha256 === undefined && value.bodyBytes === undefined || digest(value.bodySha256) && size(value.bodyBytes))
    && (value.rpcCode === undefined || rpcCode(value.rpcCode)) && (value.rpcIdMatches === undefined || typeof value.rpcIdMatches === 'boolean')
    && (value.message === undefined || typeof value.message === 'string' && value.message.length > 0 && value.message.length <= 512 && ![...value.message].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || '<>'.includes(character)));
}
export function sabyRequestIntent(method: string, requestId: number, body: string): SabyRequestIntent {
  return { version: 1, method, requestId, requestedAt: new Date().toISOString(),
    ...(method === 'СБИС.Аутентифицировать' ? {} : { bodySha256: createHash('sha256').update(body).digest('hex'), bodyBytes: Buffer.byteLength(body) }) };
}
/** Retain only the first bounded message, excluding nested data, payloads and traces. */
function safeMessage(raw: unknown, secrets: readonly (string | undefined)[]): string | undefined {
  if (typeof raw !== 'string') return undefined;
  let message = raw.slice(0, 4096);
  for (const secret of secrets) if (secret) message = message.split(secret).join('[скрыто]');
  message = message.split(/[\r\n]/, 1)[0]
    .replace(/(?:https?:\/\/|www\.)\S+/gi, '[ссылка скрыта]')
    .replace(/(?:[<{[]|&lt;).*$/s, '[содержимое скрыто]')
    .replace(/(?:password|passwd|пароль|логин|login|token|токен|session(?:id)?|сесси[яи]|cookie|authorization|bearer|secret|секрет|pin|пин|otp|private.?key|закрыт\w*\s+ключ|двоичныеданные|подпись)\s*["']?\s*(?:[=:]|\s)\s*.*$/i, '[секрет скрыт]')
    .replace(/\b(?:Bearer|Basic)\s+\S+/gi, '[секрет скрыт]')
    .replace(/[A-Z0-9_+/=-]{24,}/gi, '[данные скрыты]')
    .replace(/\b\d{7,}\b/g, '[номер скрыт]')
    .split('').map(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 || '<>'.includes(character) ? ' ' : character).join('').trim();
  return message ? message.slice(0, 512) : undefined;
}
export function sabyResponseDiagnostic(intent: SabyRequestIntent, status: number, bytes: Uint8Array, bodyState: SabyResponseDiagnostic['bodyState'], body: unknown, secrets: readonly (string | undefined)[]): SabyResponseDiagnostic {
  const auth = intent.method === 'СБИС.Аутентифицировать';
  const error = object(body) && object(body.error) ? body.error : undefined;
  const message = !auth && error ? safeMessage(error.message, secrets) : undefined;
  return { receivedAt: new Date().toISOString(), httpStatus: status, bodyState,
    ...(!auth ? { bodySha256: createHash('sha256').update(bytes).digest('hex'), bodyBytes: bytes.byteLength } : {}),
    ...(object(body) ? { rpcIdMatches: body.jsonrpc === '2.0' && body.id === intent.requestId } : {}),
    ...(error && rpcCode(error.code) ? { rpcCode: error.code } : {}), ...(message ? { message } : {}) };
}

/** One timeout includes headers and body. Error bodies have a smaller diagnostic-only limit. */
export async function readSabyResponseBody(response: Response, signal: AbortSignal): Promise<{ bytes: Buffer; bodyState: SabyResponseDiagnostic['bodyState'] }> {
  const maximum = response.ok ? 64 * 1024 * 1024 : 64 * 1024;
  const reader = response.body?.getReader();
  if (!reader) return { bytes: Buffer.alloc(0), bodyState: 'complete' };
  const chunks: Buffer[] = []; let length = 0;
  let state: SabyResponseDiagnostic['bodyState'] = 'complete';
  let rejectAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = () => reject(new Error('Saby response timed out')); });
  const abort = () => rejectAbort?.();
  signal.addEventListener('abort', abort, { once: true });
  try {
    if (signal.aborted) { state = 'timeout'; return { bytes: Buffer.alloc(0), bodyState: state }; }
    while (true) {
      const part = await Promise.race([reader.read(), aborted]);
      if (part.done) break;
      const remaining = maximum - length;
      if (part.value.byteLength > remaining) { chunks.push(Buffer.from(part.value.subarray(0, remaining))); length += remaining; state = 'truncated'; break; }
      chunks.push(Buffer.from(part.value)); length += part.value.byteLength;
    }
  } catch { state = signal.aborted ? 'timeout' : 'unavailable'; }
  finally {
    signal.removeEventListener('abort', abort);
    // Do not let a broken provider's cancellation promise retain the runtime request slot.
    if (state !== 'complete') void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
  return { bytes: Buffer.concat(chunks, length), bodyState: state };
}

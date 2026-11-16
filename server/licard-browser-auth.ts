import { request } from 'node:http';
import { ApiError } from './api-error';

export async function authorizeLicard(
  socketPath: string,
  fields: Record<string, string>,
): Promise<{ state: 'connected' } | { state: 'code_required'; challenge: string; retryAfterSeconds: number }> {
  const body = JSON.stringify(fields);
  const output = await new Promise<string>((resolve, reject) => {
    const outgoing = request({
      socketPath, path: '/authorize', method: 'POST', signal: AbortSignal.timeout(34_000),
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    }, response => {
      if (response.statusCode !== 200) {
        response.resume();
        reject(new Error('Licard bridge failed'));
        return;
      }
      response.setEncoding('utf8');
      let raw = '';
      response.on('data', chunk => {
        raw += chunk;
        if (raw.length > 2048) outgoing.destroy(new Error('Invalid Licard bridge response'));
      });
      response.on('error', reject);
      response.on('end', () => resolve(raw));
    });
    outgoing.on('error', reject);
    outgoing.end(body);
  }).catch(() => {
    throw new ApiError(503, 'Сервер входа в ЛИКАРД временно недоступен.');
  });

  let result: { state?: string; challenge?: string; retryAfterSeconds?: number };
  try { result = JSON.parse(output); }
  catch { throw new ApiError(502, 'Не удалось получить ответ ЛИКАРД.'); }
  if (result?.state === 'connected') return { state: 'connected' };
  if (result?.state === 'code_required' && typeof result.challenge === 'string' && /^[a-zA-Z0-9_-]{32}$/.test(result.challenge)) {
    const retryAfterSeconds = result.retryAfterSeconds ?? 60;
    return { state: 'code_required', challenge: result.challenge,
      retryAfterSeconds: Number.isInteger(retryAfterSeconds) ? Math.max(0, Math.min(60, retryAfterSeconds)) : 60 };
  }
  if (result?.state === 'retry_later') throw new ApiError(429, 'Повторный запрос доступен не раньше чем через 60 секунд после предыдущего.');
  if (result?.state === 'credentials_required') throw new ApiError(503, 'Данные для входа в ЛИКАРД не настроены на сервере.');
  if (result?.state === 'busy') throw new ApiError(409, 'Другой администратор уже подтверждает вход в ЛИКАРД.');
  if (result?.state === 'expired') throw new ApiError(410, 'Срок действия запроса истёк. Запросите новый код.');
  if (result?.state === 'invalid_code') throw new ApiError(422, 'ЛИКАРД не принял код. Проверьте код из последнего письма.');
  if (result?.state === 'login_failed') throw new ApiError(422, 'ЛИКАРД не подтвердил сохранённые данные для входа. Обратитесь к администратору.');
  throw new ApiError(502, 'Не удалось подтвердить вход в ЛИКАРД.');
}

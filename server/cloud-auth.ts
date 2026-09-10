import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';

export function authenticated(request: Pick<IncomingMessage, 'headers'>, username = process.env.ARTEL_AUTH_USER, password = process.env.ARTEL_AUTH_PASSWORD): boolean {
  if (!username || !password || !request.headers.authorization?.startsWith('Basic ')) return false;
  const supplied = Buffer.from(request.headers.authorization.slice(6), 'base64');
  const digest = (value: Buffer | string) => createHash('sha256').update(value).digest();
  return timingSafeEqual(digest(supplied), digest(`${username}:${password}`));
}

export function sameOrigin(request: Pick<IncomingMessage, 'headers' | 'method'>): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return request.method === 'GET' || request.method === 'HEAD';
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.host === request.headers.host;
  } catch { return false; }
}

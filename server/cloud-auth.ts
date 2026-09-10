import type { IncomingMessage } from 'node:http';

export function sameOrigin(request: Pick<IncomingMessage, 'headers' | 'method'>): boolean {
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (!origin) return request.method === 'GET' || request.method === 'HEAD';
  try {
    const url = new URL(origin);
    return url.protocol === 'https:' && url.host === request.headers.host;
  } catch { return false; }
}

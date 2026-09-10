import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createSnapshotMiddleware } from './local-api';
import { BlobOperationsStore } from './blob-operations-store';
import { authenticated, sameOrigin } from './cloud-auth';

const middleware = createSnapshotMiddleware(resolve(process.cwd(), 'data/local-xlsx-final'), {
  operationsStore: new BlobOperationsStore(),
  authorizeRequest: request => authenticated(request) && sameOrigin(request),
  checkoApiKey: process.env.CHECKO_API_KEY,
});

export default async function handler(request: IncomingMessage, response: ServerResponse) {
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('X-Frame-Options', 'DENY');
  if (!process.env.ARTEL_AUTH_USER || !process.env.ARTEL_AUTH_PASSWORD) {
    response.writeHead(503); response.end('Access is not configured'); return;
  }
  if (!authenticated(request)) {
    response.setHeader('WWW-Authenticate', 'Basic realm="Artel CRM", charset="UTF-8"');
    response.writeHead(401); response.end('Authentication required'); return;
  }
  const path = request.url?.split('?')[0];
  if (path?.startsWith('/api/') && path !== '/api/index') {
    await new Promise<void>(done => {
      response.once('finish', done);
      response.once('close', done);
      middleware(request, response, () => { response.writeHead(404); response.end(); });
    });
    return;
  }
  if ((path === '/' || path === '/index.html') && ['GET', 'HEAD'].includes(request.method ?? '')) {
    response.setHeader('Content-Type', 'text/html; charset=utf-8');
    response.end(request.method === 'HEAD' ? undefined : await readFile(resolve(process.cwd(), 'server-render/index.html')));
    return;
  }
  response.writeHead(404); response.end('Not found');
}

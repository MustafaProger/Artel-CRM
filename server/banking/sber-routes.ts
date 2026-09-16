import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireManage, requireUser } from '../auth';
import { requireSection } from '../permissions';
import { ApiError } from '../api-error';
import { SberService } from './sber-service';

export async function sberRoutes(service: SberService, request: IncomingMessage, response: ServerResponse, url: URL, readBody: () => Promise<Record<string, unknown>>) {
  requireManage(requireSection(requireUser(await service.store.read(service.source), request), 'payments'));
  const path = url.pathname, method = request.method;
  const send = (value: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
  };
  if (path === '/api/banking/sber/statements' && method === 'GET') return send(await service.list(url.searchParams));
  if (path === '/api/banking/sber/sync' && method === 'POST') { const body = await readBody(); return send(await service.start(body.from, body.to)); }
  if (path === '/api/banking/sber/continue' && method === 'POST') { await readBody(); return send(await service.tick()); }
  const operation = path.match(/^\/api\/banking\/sber\/operations\/([a-f0-9]{64})(\/refresh)?$/);
  if (operation && !operation[2] && method === 'GET') return send({ operation: await service.operation(operation[1]) });
  if (operation && operation[2] && method === 'POST') { await readBody(); return send({ operation: await service.enrich(operation[1]) }); }
  throw new ApiError(404, 'Маршрут выписки Сбера не найден.');
}

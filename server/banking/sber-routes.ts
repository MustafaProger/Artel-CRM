import { readAuthority } from '../request-views';
import type { OperationsData } from '../operations-store';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireManage, requireUser } from '../auth';
import { requireSection } from '../permissions';
import { ApiError } from '../api-error';
import { SberService } from './sber-service';

export async function sberRoutes(service: SberService, request: IncomingMessage, response: ServerResponse, url: URL, readBody: () => Promise<Record<string, unknown>>, guardDriver?: (data: OperationsData) => void) {
  const path = url.pathname.replace('/api/banking/sber/sber-artel/', '/api/banking/sber/').replace('/api/banking/sber/sber-nk-artel/', '/api/banking/sber/'), method = request.method;
  const operation = path.match(/^\/api\/banking\/sber\/operations\/([a-f0-9]{64})(\/refresh)?$/);
  const listRequest = method === 'GET' && path === '/api/banking/sber/statements';
  const detailRequest = method === 'GET' && operation && !operation[2];
  const requireBankAccess = (data: OperationsData) => requireManage(requireSection(requireUser(data, request), 'payments'));
  const data = listRequest || detailRequest ? await service.read() : await readAuthority(service.store, service.source);
  guardDriver?.(data);
  requireBankAccess(data);
  const write = (value: unknown) => {
    response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    response.end(JSON.stringify(value));
  };
  if (listRequest) return write(service.listFromData(data, url.searchParams));
  if (detailRequest) return write({ operation: service.operationFromData(data, operation[1]) });
  const authorize = async () => requireBankAccess(await readAuthority(service.store, service.source));
  const send = async (value: unknown) => { await authorize(); write(value); };
  if (path === '/api/banking/sber/sync' && method === 'POST') { const body = await readBody(); await authorize(); return send(await service.start(body.from, body.to)); }
  if (path === '/api/banking/sber/continue' && method === 'POST') { await readBody(); await authorize(); return send(await service.tick()); }
  if (operation && operation[2] && method === 'POST') { await readBody(); await authorize(); return send({ operation: await service.enrich(operation[1]) }); }
  throw new ApiError(404, 'Маршрут выписки Сбера не найден.');
}

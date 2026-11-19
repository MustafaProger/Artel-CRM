import { readAuthority, readCore } from '../request-views';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireManage, requireUser } from '../auth';
import { requireSection } from '../permissions';
import { ApiError } from '../api-error';
import type { OperationsData } from '../operations-store';
import { csv } from './domain';
import { BankingService } from './service';

export async function bankingRoutes(service: BankingService, request: IncomingMessage, response: ServerResponse, url: URL, readBody: () => Promise<Record<string, unknown>>, requestData?: OperationsData, guardDriver?: (data: OperationsData) => void) {
  const method = request.method, path = url.pathname;
  const listRequest = path === '/api/banking' && method === 'GET';
  const operation = path.match(/^\/api\/banking\/operations\/([a-f0-9]{64})(?:\/(refresh|print))?$/);
  const requireBankAccess = (data: OperationsData) => {
    guardDriver?.(data);
    requireManage(requireSection(requireUser(data, request), 'payments'));
  };
  const authorize = async () => requireBankAccess(await readAuthority(service.store, service.source));
  const send = (value: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
  if (listRequest) {
    const data = requestData ?? await readCore(service.store, service.source, ['banking']);
    requireBankAccess(data);
    return send(service.listFromData(data, url.searchParams));
  }
  await authorize();
  const sendAuthorized = async (value: unknown) => { await authorize(); send(value); };
  if (method === 'GET' && path === '/api/banking/export') {
    const output = csv(await service.rows(url.searchParams));
    await authorize();
    response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="artel-bank-operations.csv"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(output); return;
  }
  const sync = path.match(/^\/api\/banking\/connections\/([a-z-]+)\/(sync|continue)$/);
  if (sync && method === 'POST') {
    const body = await readBody();
    await authorize();
    if (sync[2] === 'sync') { await service.start(sync[1], body.from, body.to); await authorize(); }
    return sendAuthorized(await service.tick(sync[1]) ?? { pending: true });
  }
  if (operation) {
    if (!operation[2] && method === 'GET') return sendAuthorized({ operation: await service.operation(operation[1]) });
    if (operation[2] === 'refresh' && method === 'POST') { await readBody(); await authorize(); return sendAuthorized({ operation: await service.enrich(operation[1]) }); }
    if (operation[2] === 'print' && method === 'GET') {
      const buffer = await service.print(operation[1]);
      await authorize();
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="bank-payment-${operation[1].slice(0, 12)}.pdf"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(buffer); return;
    }
  }
  throw new ApiError(404, 'Банковский маршрут не найден.');
}

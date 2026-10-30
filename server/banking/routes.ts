import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireManage, requireUser } from '../auth';
import { requireSection } from '../permissions';
import { ApiError } from '../api-error';
import type { OperationsData } from '../operations-store';
import { csv } from './domain';
import { BankingService } from './service';

export async function bankingRoutes(service: BankingService, request: IncomingMessage, response: ServerResponse, url: URL, readBody: () => Promise<Record<string, unknown>>, requestData?: OperationsData) {
  const method = request.method, path = url.pathname;
  const listRequest = path === '/api/banking' && method === 'GET';
  // Only the list GET has no body/provider await between authorization and output.
  // Other routes must not inherit the earlier middleware view.
  const data = listRequest && requestData ? requestData : await service.store.read(service.source);
  requireManage(requireSection(requireUser(data, request), 'payments'));
  const send = (value: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
  if (listRequest) return send(service.listFromData(data, url.searchParams));
  // Every remaining route can yield while reading a body or awaiting a provider.
  // Recheck the current session before protected work and before releasing data.
  const authorize = async () => requireManage(requireSection(requireUser(await service.store.read(service.source), request), 'payments'));
  const sendAuthorized = async (value: unknown) => { await authorize(); send(value); };
  if (path === '/api/banking/export' && method === 'GET') {
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
  const operation = path.match(/^\/api\/banking\/operations\/([a-f0-9]{64})(?:\/(refresh|print))?$/);
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

import type { IncomingMessage, ServerResponse } from 'node:http';
import { requireManage, requireUser } from '../auth';
import { ApiError } from '../api-error';
import { csv } from './domain';
import { BankingService } from './service';
import { sberNetworkCheck } from './diagnostics';
import { startSberOAuth } from './oauth';

export async function bankingRoutes(service: BankingService, request: IncomingMessage, response: ServerResponse, url: URL, readBody: () => Promise<Record<string, unknown>>) {
  requireManage(requireUser(await service.store.read(service.source), request));
  const method = request.method, path = url.pathname;
  const send = (value: unknown) => { response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(JSON.stringify(value)); };
  if (path === '/api/banking' && method === 'GET') return send(await service.list(url.searchParams));
  if (path === '/api/banking/network-check' && method === 'GET') return send(await sberNetworkCheck(service.config(url.searchParams.get('connection') ?? 'sber-nk-artel')));
  const oauth = path.match(/^\/api\/banking\/connections\/([a-z-]+)\/authorize$/);
  if (oauth && method === 'POST') { await readBody(); return send(await startSberOAuth(service, oauth[1], request, response)); }
  if (path === '/api/banking/export' && method === 'GET') {
    const output = csv(await service.rows(url.searchParams));
    response.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="artel-bank-operations.csv"', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(output); return;
  }
  const sync = path.match(/^\/api\/banking\/connections\/([a-z-]+)\/(sync|continue)$/);
  if (sync && method === 'POST') {
    const body = await readBody();
    if (sync[2] === 'sync') await service.start(sync[1], body.from, body.to);
    return send(await service.tick(sync[1]) ?? { pending: true });
  }
  const operation = path.match(/^\/api\/banking\/operations\/([a-f0-9]{64})(?:\/(refresh|print))?$/);
  if (operation) {
    if (!operation[2] && method === 'GET') return send({ operation: await service.operation(operation[1]) });
    if (operation[2] === 'refresh' && method === 'POST') { await readBody(); return send({ operation: await service.enrich(operation[1]) }); }
    if (operation[2] === 'print' && method === 'GET') {
      const buffer = await service.print(operation[1]);
      response.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="bank-payment-${operation[1].slice(0, 12)}.pdf"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); response.end(buffer); return;
    }
  }
  throw new ApiError(404, 'Банковский маршрут не найден.');
}

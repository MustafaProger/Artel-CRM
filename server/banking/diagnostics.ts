import { request } from 'node:https';
import type { TLSSocket } from 'node:tls';
import { ApiError } from '../api-error';
import { bankTlsMaterial, type BankConfig } from './transport';

/** Fixed bank host, no OAuth credentials or account data, no persistence. */
export async function sberNetworkCheck(config: BankConfig) {
  if (config.definition.provider !== 'sber') throw new ApiError(400, 'Проверка доступна только для СберБизнеса.');
  const material = await bankTlsMaterial(config);
  const result = {
    checkedAt: new Date().toISOString(), host: 'fintech.sberbank.ru', port: 9443,
    environment: config.env.VERCEL_ENV ?? 'local', region: config.env.VERCEL_REGION ?? null,
    tcpConnected: false, serverTlsVerified: false,
    clientCertificateConfigured: !!(material.pfx || material.cert && material.key),
    bankAccessVerified: false, httpStatus: null as number | null, errorCode: null as string | null,
  };
  return new Promise<typeof result>(resolve => {
    // Missing token/account is intentional: only prove network and TLS reachability.
    const req = request('https://fintech.sberbank.ru:9443/fintech/api/v2/statement/transactions', {
      ...material, method: 'GET', minVersion: 'TLSv1.2', rejectUnauthorized: true,
      headers: { Accept: 'application/json' }, agent: false,
    }, res => {
      result.serverTlsVerified = (res.socket as TLSSocket).authorized === true;
      result.httpStatus = res.statusCode ?? null;
      res.resume(); req.destroy(); resolve(result);
    });
    req.on('socket', socket => {
      socket.once('connect', () => { result.tcpConnected = true; });
      socket.once('secureConnect', () => { result.serverTlsVerified = (socket as TLSSocket).authorized === true; });
    });
    const timer = setTimeout(() => { result.errorCode = 'TIMEOUT'; req.destroy(); resolve(result); }, 10000);
    req.once('close', () => clearTimeout(timer));
    req.once('error', (error: NodeJS.ErrnoException) => {
      // Never expose exception messages, TLS material, bank response bodies or headers.
      result.errorCode ??= /^[A-Z0-9_]{1,80}$/.test(error.code ?? '') ? error.code! : 'TLS_OR_NETWORK_ERROR';
      resolve(result);
    });
    req.end();
  });
}

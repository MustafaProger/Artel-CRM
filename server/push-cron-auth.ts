import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { IncomingMessage } from 'node:http';

const issuer = 'https://token.actions.githubusercontent.com';
const keys = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks`), { timeoutDuration: 5000 });
export async function validPushWorkflow(request: IncomingMessage, key: JWTVerifyGetKey = keys) {
  const token = request.headers.authorization?.match(/^Bearer ([\w.-]+)$/)?.[1];
  if (!token || token.length > 16000) return false;
  try {
    const { payload } = await jwtVerify(token, key, { issuer, audience: 'https://artel-crm.vercel.app/api/push/dispatch', algorithms: ['RS256'], maxTokenAge: '10m', requiredClaims: ['exp', 'iat', 'sub'] });
    return payload.repository_id === '1362863740' && payload.repository_owner_id === '74742979' && payload.repository === 'MustafaProger/Artel-CRM' && payload.ref === 'refs/heads/main' && payload.workflow_ref === 'MustafaProger/Artel-CRM/.github/workflows/reminders.yml@refs/heads/main' && ['schedule', 'workflow_dispatch', 'push'].includes(String(payload.event_name));
  } catch { return false; }
}

/** Explicit acceptance of already-issued credentials. No business writes or password changes.
 * Credentials, cookies and returned business records remain only in memory.
 */
import assert from 'node:assert/strict';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { networkInterfaces } from 'node:os';
import { readFile, writeFile } from 'node:fs/promises';

const args = process.argv.slice(2);
assert(args.includes('--verify') && args.includes('--credentials') && args.includes('--report'), 'Explicit --verify, --credentials and --report required');
const credentials = JSON.parse(await readFile(args[args.indexOf('--credentials') + 1], 'utf8')).accounts;
assert(Array.isArray(credentials) && credentials.length > 0);
const address = networkInterfaces().en0?.find(row => row.family === 'IPv4' && !row.internal)?.address;
assert(address, 'The configured en0 IPv4 interface is unavailable');
const environments = [
  { name: 'https-crm', origin: 'https://artel-crm.online', prefix: '/api', cookie: 'artel_session' },
  { name: 'actual-local-proxy', origin: 'http://127.0.0.1:5186', prefix: '/api/logistics', cookie: 'artel_logistics_live_session' },
];
function request(environment, path, method = 'GET', payload, cookie) {
  const secure = environment.origin.startsWith('https:');
  const url = new URL(environment.prefix + path, environment.origin);
  const body = payload === undefined ? undefined : JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = (secure ? httpsRequest : httpRequest)(url, {
      method, ...(secure ? { localAddress: address, rejectUnauthorized: true } : {}),
      headers: { Origin: environment.origin, 'Sec-Fetch-Site': 'same-origin', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}), ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}) },
    }, response => {
      const chunks = []; let size = 0;
      response.on('data', chunk => { size += chunk.length; if (size > 4 * 1024 * 1024) req.destroy(new Error('Response too large')); else chunks.push(chunk); });
      response.on('end', () => {
        let value; try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return reject(new Error('Expected JSON API response')); }
        resolve({ status: response.statusCode, body: value, cookie: response.headers['set-cookie']?.find(value => value.startsWith(environment.cookie + '='))?.split(';')[0] });
      });
    });
    req.setTimeout(25000, () => req.destroy(new Error('API request timed out')));
    req.on('error', reject); req.end(body);
  });
}
const report = { verifiedAt: new Date().toISOString(), accounts: credentials.length, passwordChanges: 0, businessWrites: 0, environments: [], passed: false };
try {
  for (const environment of environments) {
    const sessions = [];
    const result = { environment: environment.name, logins: 0, ownTripDetails: 0, foreignTripDenials: 0, protectedRouteDenials: 0, logouts: 0 };
    try {
      for (const credential of credentials) {
        const signed = await request(environment, '/auth/login', 'POST', { login: credential.login, password: credential.temporaryPassword });
        assert.equal(signed.status, 200, 'Issued driver login failed'); assert(signed.cookie, 'Session cookie missing');
        const session = { credential, cookie: signed.cookie, trips: [] }; sessions.push(session);
        assert.equal(signed.body.user.role, 'driver'); assert.equal(signed.body.user.driverId === credential.driverId, true);
        const current = await request(environment, '/auth/session', 'GET', undefined, session.cookie);
        assert.equal(current.status, 200); assert.equal(current.body.user.role, 'driver'); assert.equal(current.body.user.driverId === credential.driverId, true);
        const listed = await request(environment, '/driver/trips', 'GET', undefined, session.cookie);
        assert.equal(listed.status, 200); assert(Array.isArray(listed.body.trips)); assert.equal(listed.body.total, listed.body.trips.length);
        for (const trip of listed.body.trips) {
          assert.deepEqual(Object.keys(trip).sort(), ['id','date','driverName','vehiclePlate','supplier','loadingAddress','loadingMapUrl','loadingPlannedAt','loadingActualAt','notes','deliveries'].sort());
          const own = await request(environment, '/driver/trips/' + encodeURIComponent(trip.id), 'GET', undefined, session.cookie);
          assert.equal(own.status, 200); assert.equal(own.body.trip.id === trip.id, true); result.ownTripDetails++;
          for (const delivery of trip.deliveries) assert.deepEqual(Object.keys(delivery).sort(), ['id','number','customer','product','liters','address','mapUrl','plannedAt','actualAt','notes'].sort());
        }
        session.trips = listed.body.trips;
        for (const path of ['/snapshot', '/directories', '/banking', '/auth/users', '/shipment-trips']) {
          assert.equal((await request(environment, path, 'GET', undefined, session.cookie)).status, 403); result.protectedRouteDenials++;
        }
        result.logins++;
      }
      for (const session of sessions) {
        const foreign = sessions.find(other => other.credential.driverId !== session.credential.driverId && other.trips.length)?.trips[0];
        if (foreign) {
          assert.equal((await request(environment, '/driver/trips/' + encodeURIComponent(foreign.id), 'GET', undefined, session.cookie)).status, 404);
          assert.equal((await request(environment, '/shipment-trips/' + encodeURIComponent(foreign.id) + '/etrn', 'GET', undefined, session.cookie)).status, 403);
          result.foreignTripDenials++;
        }
      }
    } finally {
      for (const session of sessions) {
        const loggedOut = await request(environment, '/auth/logout', 'POST', {}, session.cookie);
        assert.equal(loggedOut.status, 200); result.logouts++;
      }
      report.environments.push(result);
    }
  }
  report.passed = true;
} catch {
  // Intentionally do not print an exception that could contain request/response data.
  report.passed = false;
} finally {
  await writeFile(args[args.indexOf('--report') + 1], JSON.stringify(report, null, 2) + '\n', { mode: 0o600 });
  console.log(JSON.stringify(report));
}
if (!report.passed) process.exitCode = 1;

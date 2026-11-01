import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { integrationRuntime } from '../tests/helpers/trip-saby-integration.ts';
import { currentSnapshot } from '../server/shipment-operations.ts';
import { readTripWorkflowIssues } from '../server/trip-workflow-issues.ts';
import { getShipmentTrip } from '../server/shipment-trips.ts';
import { getTripSabyWorkflow } from '../server/trip-saby-workflow.ts';
import { integrationConfig, integrationSettings } from '../tests/helpers/trip-saby-integration.ts';
const root = resolve(import.meta.dirname, '..');
process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
const rt = await integrationRuntime();
const original = await rt.store.read(rt.source);
const config = integrationConfig();
config.automaticSigning = { id: 'synthetic-preview-policy', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z', sender: { ...config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...config.carrier, thumbprint: 'cd'.repeat(20) } };
let saved;
function reset(ready) {
  saved = structuredClone(original);
  if (!ready) {
    saved.directories.products[0].documentName = '';
    for (const row of Object.values(saved.shipments)) Object.assign(row.fields, { trip_flow_version: 'driver-v1', quantity_tonnes: null, quantity_gross_tonnes: null, trip_total_tonnes: null });
  }
}
reset(false);
const snapshot = currentSnapshot(rt.base, original);
function summary(data, number) {
  const snapshot = currentSnapshot(rt.base, data), trip = getShipmentTrip(snapshot, rt.tripId);
  return { ...trip, number, workflowIssues: readTripWorkflowIssues(data, rt.tripId, { snapshot, trip, config }) };
}
const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'web'), cacheDir: resolve(rt.directory, 'vite'), plugins: [react(), { name: 'synthetic-preview', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    const path = req.url.split('?')[0];
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (path === '/__fixture') { reset(req.url.includes('ready=1')); return json({ syntheticOnly: true }); }
    if (path.startsWith('/api/')) {
      if (req.method !== 'GET') { res.statusCode = 405; return json({ error: 'Локальный пример: изменения отключены.' }); }
      if (path === '/api/shipment-trips') return json({ trips: [summary(saved, 52), { ...summary(original, 51), id: 'healthy-trip' }], automation: { enabled: false } });
      if (path === '/api/trip-requests') return json({ requests: [], companies: snapshot.companies, addresses: snapshot.directories.addresses });
      if (path.endsWith('/saby-workflow')) return json({ ...getTripSabyWorkflow({ base: rt.base, data: saved, tripId: rt.tripId, config, prepare: rt.prepare }), workflowIssues: summary(saved, 52).workflowIssues, loadingFacts: null });
      if (path.endsWith('/etrn')) return json({ deliveries: [] });
      if (path.endsWith('/saby')) return json({ saby: { documents: [] } });
      return json({});
    }
    if (path !== '/__preview') return next();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(await server.transformIndexHtml('/__preview', `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Ошибки ЭТрН — локальный пример</title></head><body><div style="padding:16px;max-width:1200px;margin:auto"><p>Локальный пример · синтетические данные</p><div id="root"></div></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import TripsPage from '/src/TripsPage.tsx';import '/src/styles.css';import '/src/apple-theme.css';import '/src/design-system.css';createRoot(document.getElementById('root')).render(React.createElement(TripsPage,{data:${JSON.stringify({ companies: snapshot.companies, directories: snapshot.directories })},canManagePlaces:false,onChanged:()=>{}}));</script></body></html>`));
  });
} }], server: { host: '127.0.0.1', port: 5197, strictPort: true, fs: { allow: [root] } } });
await server.listen();
console.log('http://127.0.0.1:5197/__preview');
const close = async () => { await server.close(); await rt.close(); process.exit(); };
process.on('SIGTERM', close); process.on('SIGINT', close);

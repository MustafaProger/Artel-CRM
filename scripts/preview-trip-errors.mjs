import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { integrationRuntime } from '../tests/helpers/trip-saby-integration.ts';
import { currentSnapshot } from '../server/shipment-operations.ts';
import { tripWorkflowIssues } from '../web/src/trip-workflow-issues.ts';
const root = resolve(import.meta.dirname, '..');
const rt = await integrationRuntime();
const saved = await rt.store.read(rt.source);
const snapshot = currentSnapshot(rt.base, saved);
const state = { status: 'error', phase: 'sending_etrn', ready: true, blockers: [], locked: true, updatedAt: null, lastError: null, order: null, carrierConfirmed: true, lastCheckedAt: null, lastCheckAttemptAt: null, monitoring: { enabled: false, intervalSeconds: null }, history: [], deliveries: [{ shipmentId: rt.trip.customers[0].id, id: 'synthetic-doc', status: 'draft', lastError: 'Не заполнены сведения титула перевозчика. Проверьте данные автомобиля.', dispatch: { sender: { state: 'confirmed' }, carrier: { state: 'blocked' }, completedAt: null } }], loadingFacts: null };
const trips = [ { ...rt.trip, number: 52, workflowIssues: tripWorkflowIssues(state) }, { ...rt.trip, id: 'healthy-trip', number: 51, workflowIssues: [] } ];
const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'web'), cacheDir: resolve(rt.directory, 'vite'), plugins: [react(), { name: 'synthetic-preview', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    const path = req.url.split('?')[0];
    const json = data => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(data)); };
    if (path.startsWith('/api/')) {
      if (req.method !== 'GET') { res.statusCode = 405; return json({ error: 'Локальный пример: изменения отключены.' }); }
      if (path === '/api/shipment-trips') return json({ trips, automation: { enabled: false } });
      if (path === '/api/trip-requests') return json({ requests: [], companies: snapshot.companies, addresses: snapshot.directories.addresses });
      if (path.endsWith('/saby-workflow')) return json(state);
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

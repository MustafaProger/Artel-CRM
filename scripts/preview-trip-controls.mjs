import { createServer as createVite } from 'vite';
import react from '@vitejs/plugin-react';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { integrationRuntime, integrationApi, integrationConfig, integrationSettings, integrationPrepare } from '../tests/helpers/trip-saby-integration.ts';
import { createSnapshotMiddleware } from '../server/local-api.ts';
import { currentSnapshot } from '../server/shipment-operations.ts';
import { saveShipmentTrip } from '../server/shipment-trips.ts';
import { enqueueAutomaticTripSaby, runTripSabyWorkflow } from '../server/trip-saby-workflow.ts';
import { SabyClient } from '../server/saby-client.ts';

const root = resolve(import.meta.dirname, '..'), port = Number(process.env.TRIP_CONTROLS_PORT || 5199);
const rt = await integrationRuntime(), api = integrationApi(), config = integrationConfig();
process.env.SABY_AUTOFILL_PROFILE_JSON = JSON.stringify(integrationSettings);
config.automaticSigning = { id: 'synthetic-controls', enabled: true, mode: 'deferred', approvedAt: '2026-10-01T00:00:00.000Z', sender: { ...config.customer, thumbprint: 'ab'.repeat(20) }, carrier: { ...config.carrier, thumbprint: 'cd'.repeat(20) } };
const middleware = createSnapshotMiddleware(rt.snapshotDirectory, { operationsStore: rt.store, sabyClient: new SabyClient(config, api.send), sabyWorkflowMonitoringEnabled: false });
const bootstrap = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
await new Promise(resolve => bootstrap.listen(0, '127.0.0.1', resolve));
const setup = await fetch(`http://127.0.0.1:${bootstrap.address().port}/api/auth/setup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Локальный пример', login: 'synthetic-controls', password: randomUUID() }) });
if (!setup.ok) throw new Error('Synthetic setup failed');
const cookie = setup.headers.get('set-cookie').split(';')[0]; await setup.arrayBuffer();
await new Promise(resolve => bootstrap.close(resolve));
const created = await rt.store.mutate(rt.source, data => {
  const actorId = data.accounts.users[0].id;
  const fields = Object.fromEntries(['organization_id', 'supplier_id', 'carrier_id', 'oil_depot_id', 'product_id', 'purchase_price_unspecified_unit', 'driver_id', 'vehicle_id', 'additional_costs'].map(key => [key, rt.trip.fields[key]]));
  Object.assign(fields, { trip_flow_version: 'driver-v1', loading_at: '2027-02-03T09:15' });
  const customers = rt.trip.customers.map(row => ({ fields: Object.fromEntries(['customer_id', 'manager_id', 'payment_form_id', 'quantity_litres', 'sale_price_per_litre', 'transport_amount', 'unloading_address_id'].map(key => [key, row.fields[key]])) }));
  const waiting = saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }, undefined, actorId);
  const queued = enqueueAutomaticTripSaby({ base: rt.base, data, tripId: waiting.trip.id, actorId, config, prepare: integrationPrepare });
  if (!queued.enqueued) throw new Error(JSON.stringify(queued.blockers));
  const invalid = saveShipmentTrip(rt.base, data, { fields, customers, idempotencyKey: randomUUID() }, undefined, actorId);
  for (const row of invalid.trip.customers) data.shipments[row.id].fields.oil_depot_id = null;
  data.tripNumbers = { [rt.tripId]: 58, [waiting.trip.id]: 55, [invalid.trip.id]: 57 };
  return { result: { waiting: waiting.trip.id, invalid: invalid.trip.id, deletable: rt.tripId }, changed: true };
});
await runTripSabyWorkflow({ ...rt, tripId: created.waiting, client: new SabyClient(config, api.send), createDelivery: async () => { throw new Error('Synthetic preview does not send deliveries'); } });
const initial = await rt.store.read(rt.source), snapshot = currentSnapshot(rt.base, initial);
const server = await createVite({ configFile: false, envDir: false, root: resolve(root, 'web'), cacheDir: resolve(rt.directory, 'vite'), plugins: [react(), { name: 'trip-controls-preview', configureServer(server) {
  server.middlewares.use(async (req, res, next) => {
    const path = req.url.split('?')[0];
    if (path === '/__fixture') {
      await rt.store.mutate(rt.source, data => { for (const key of Object.keys(data)) delete data[key]; Object.assign(data, structuredClone(initial)); return { result: null, changed: true }; });
      res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ ...created, syntheticOnly: true }));
    }
    if (path.startsWith('/api/')) { req.headers.cookie = cookie; return middleware(req, res, next); }
    if (path !== '/__preview') return next();
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.end(await server.transformIndexHtml('/__preview', `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Управление рейсами — локальный пример</title></head><body><div style="padding:16px;max-width:1200px;margin:auto"><p>Локальный пример · вымышленные данные · №55 ожидает водителя, №57 требует данных, №58 можно удалить</p><div id="root"></div></div><script type="module">import React from 'react';import {createRoot} from 'react-dom/client';import TripsPage from '/src/TripsPage.tsx';import '/src/styles.css';import '/src/apple-theme.css';import '/src/design-system.css';createRoot(document.getElementById('root')).render(React.createElement(TripsPage,{data:${JSON.stringify({ companies: snapshot.companies, directories: snapshot.directories })},canManagePlaces:true,allowDelete:true,onChanged:()=>{}}));</script></body></html>`));
  });
} }], server: { host: '127.0.0.1', port, strictPort: true, fs: { allow: [root] } } });
await server.listen(); console.log(`http://127.0.0.1:${port}/__preview`);
const close = async () => { await server.close(); await rt.close(); process.exit(); };
process.on('SIGTERM', close); process.on('SIGINT', close);

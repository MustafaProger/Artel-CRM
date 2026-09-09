import assert from 'node:assert/strict';
import { createServer, get } from 'node:http';
import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { after, before, test } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Snapshot } from '../web/src/model';
import { createSnapshotMiddleware, decimalValue, exactMetric, loadSnapshot, sourceDate } from '../server/local-api';

const dataDirectory = resolve('data/local-xlsx-final');
let snapshot: Snapshot;
before(async () => { snapshot = await loadSnapshot(dataDirectory); });

test('decimal arithmetic preserves precision, blanks and zero', () => {
  assert.deepEqual(exactMetric(['0.1', '0.2', null]), { total: '0.3', numericCount: 2, missingCount: 1 });
  assert.deepEqual(exactMetric([null, '#DIV/0!']), { total: null, numericCount: 0, missingCount: 2 });
  assert.deepEqual(exactMetric(['0', null]), { total: '0', numericCount: 1, missingCount: 1 });
  assert.equal(decimalValue('50 000,00'), null);
  assert.equal(sourceDate('0'), null);
  assert.equal(sourceDate('2026-02-30T00:00:00'), null);
  assert.equal(sourceDate('2026-02-28T00:00:00'), '2026-02-28');
});

test('snapshot reconciles all exported records and exact source totals', async () => {
  const manifest = JSON.parse(await readFile(resolve(dataDirectory, 'manifest.json'), 'utf8'));
  const validation = JSON.parse(await readFile(resolve(dataDirectory, 'validation_report.json'), 'utf8')).data;
  assert.equal(snapshot.companies.length, manifest.counts.counterparties);
  assert.equal(snapshot.shipments.length, manifest.counts.shipment_rows);
  assert.equal(snapshot.payments.length, manifest.counts.payment_rows);
  assert.equal(snapshot.stocks.length, manifest.counts.stock_monthly_rows);
  assert.equal(snapshot.managers.length, manifest.counts.manager_labels);
  for (const [key, sourceKey] of [['liters', 'quantity_litres'], ['revenue', 'customer_amount'], ['cost', 'purchase_amount']] as const) {
    assert.equal(snapshot.overview[key].total, validation.source_totals.shipments[sourceKey].total);
    assert.equal(snapshot.overview[key].numericCount, validation.source_totals.shipments[sourceKey].numeric_cells);
  }
  assert.equal(snapshot.overview.incoming.total, validation.normalized_payment_totals.incoming_amount);
  assert.equal(snapshot.overview.outgoing.total, validation.normalized_payment_totals.outgoing_amount);
  assert.equal(snapshot.quality.issues.length, Object.values<number>(validation.issue_counts).reduce((a, b) => a + b, 0));
  assert.equal(snapshot.provenance.sourceFilesVerified, true);
});

test('months use valid dates, leave undated payments out, and reconcile to overview', () => {
  assert.equal(snapshot.overview.missingPaymentDates, 70);
  assert.equal(snapshot.monthly.reduce((sum, month) => sum + month.paymentCount, 0), snapshot.payments.length - 70);
  assert.equal(snapshot.monthly.reduce((sum, month) => sum + month.shipmentCount, 0), snapshot.shipments.length);
  assert.equal(exactMetric(snapshot.monthly.map(month => month.revenue.total)).total, snapshot.overview.revenue.total);
  const undated = snapshot.payments.filter(payment => payment.date === null);
  assert.equal(exactMetric([...snapshot.monthly.map(month => month.incoming.total), ...undated.map(payment => payment.incoming)]).total, snapshot.overview.incoming.total);
  assert.equal(exactMetric([...snapshot.monthly.map(month => month.outgoing.total), ...undated.map(payment => payment.outgoing)]).total, snapshot.overview.outgoing.total);
  assert.equal(undated[0].fields.date, '0');
  assert.equal(snapshot.payments.filter(payment => payment.incoming === null && payment.outgoing === null).length, 2);
});

test('source nulls, independent payment directions, labels and source references are retained', () => {
  const first = snapshot.shipments[0];
  assert.equal(first.revenue, '0');
  assert.equal(first.manager, null);
  assert.equal(first.sourceRow, 15);
  assert.equal(first.sourceSheet, 'Бензовозы');
  assert.ok(first.flags.includes('manager_formula_broken'));
  assert.equal(snapshot.payments.filter(payment => payment.incoming !== null && payment.outgoing !== null).length, 2);
  assert.ok(snapshot.managers.every(manager => manager.isUserAccount === false));
  const issue = snapshot.quality.issues.find(row => row.sheet === first.sourceSheet && row.cell === 'E15');
  assert.equal(issue?.recordId, first.id);
  assert.equal(issue?.dataset, 'shipments');
  assert.ok(snapshot.quality.issues.some(row => row.value === '#DIV/0!'));
});

test('corrupt exported data fails integrity validation instead of returning a partial snapshot', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-api-integrity-'));
  try {
    const names = ['manifest', 'companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report'];
    await Promise.all(names.map(name => copyFile(resolve(dataDirectory, `${name}.json`), resolve(directory, `${name}.json`))));
    await writeFile(resolve(directory, 'companies.json'), `${await readFile(resolve(directory, 'companies.json'), 'utf8')} `);
    await assert.rejects(loadSnapshot(directory), /Export integrity mismatch: companies.json/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

const readOnlyStore = await mkdtemp(resolve(tmpdir(), 'artel-api-read-'));
const middleware = createSnapshotMiddleware(dataDirectory, { operationsDirectory: readOnlyStore });
const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
let baseUrl = '';
before(async () => {
  await new Promise<void>(resolveListen => server.listen(0, '127.0.0.1', resolveListen));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(async () => { await new Promise<void>((resolveClose, reject) => server.close(error => error ? reject(error) : resolveClose())); await rm(readOnlyStore, { recursive: true, force: true }); });

test('snapshot endpoint is GET-only, local, uncached and does not serve raw files', async () => {
  const response = await fetch(`${baseUrl}/api/snapshot`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('access-control-allow-origin'), null);
  const data = await response.json() as Snapshot;
  assert.equal(data.overview.revenue.total, snapshot.overview.revenue.total);
  assert.equal((await fetch(`${baseUrl}/api/snapshot`, { method: 'POST' })).status, 405);
  assert.equal((await fetch(`${baseUrl}/api/snapshot`, { headers: { Origin: 'https://example.com' } })).status, 403);
  const foreignHostStatus = await new Promise<number | undefined>((resolveStatus, reject) => {
    get(`${baseUrl}/api/snapshot`, { headers: { Host: 'example.com' } }, response => {
      response.resume();
      resolveStatus(response.statusCode);
    }).on('error', reject);
  });
  assert.equal(foreignHostStatus, 403);
  assert.equal((await fetch(`${baseUrl}/api/snapshot`, { headers: { 'Sec-Fetch-Site': 'cross-site' } })).status, 403);
  assert.equal((await fetch(`${baseUrl}/api/raw_workbook.json`)).status, 404);
  assert.equal((await fetch(`${baseUrl}/data/local-xlsx-final/raw_workbook.json`)).status, 404);
});

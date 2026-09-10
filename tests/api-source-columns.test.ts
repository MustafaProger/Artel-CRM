import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { test } from 'node:test';
import Decimal from 'decimal.js';
import { loadSnapshot } from '../server/local-api';
import { currentSnapshot, prepareShipmentFields, shipmentPage } from '../server/shipment-operations';
import type { OperationsData } from '../server/operations-store';
import { fieldValue, shipmentColumns } from '../web/src/shipment-templates';
import { unpaidShipmentDays } from '../web/src/shipment-calculations';
import type { ColumnFilter } from '../web/src/shipment-filters';

interface SourceRow {
  id: string;
  source: { row: number; sheet: string };
  fields: Record<string, string | null>;
  cells: Record<string, { value: string | null }>;
}
const rawSource = JSON.parse(await readFile(resolve('data/local-xlsx-final/shipments.json'), 'utf8')) as { data: SourceRow[] };
const source = await loadSnapshot();
const empty = (): OperationsData => ({ schemaVersion: 1, sourceSha256: source.provenance.sourceSha256, revision: 0, shipments: {}, companies: [] });
const snapshot = currentSnapshot(source, empty());
const byId = new Map(snapshot.shipments.map(row => [row.id, row]));
const sortedIds = (rows: { id: string }[]) => rows.map(row => row.id).sort();
const page = (filters: Record<string, ColumnFilter>, extra: Record<string, string> = {}) => shipmentPage(snapshot, new URLSearchParams({ filters: JSON.stringify(filters), limit: '100', ...extra }));
const present = (key: string) => rawSource.data.filter(row => row.fields[key] !== null && row.fields[key] !== '');

// Use the verified export's field schema and original cell values as the oracle,
// independent of the shared table configuration being checked.
test('shipment columns hide legacy terms while preserving every original source value', () => {
  const keys = Object.keys(rawSource.data[0].fields);
  assert.equal(keys.length, 23);
  assert.equal(rawSource.data.length, 2092);
  const visible = new Set(shipmentColumns.map(column => column.key));
  for (const key of keys.filter(key => key !== 'term_source')) assert.ok(visible.has(key), `Source field is hidden: ${key}`);
  const canonical = new Set(['date', 'month', 'manager_label', 'product']);
  for (const raw of rawSource.data) {
    const row = byId.get(raw.id)!;
    assert.ok(row, `Missing source row ${raw.source.row}`);
    for (const key of keys) if (!canonical.has(key)) {
      assert.equal(fieldValue(row, key), raw.fields[key], `${raw.source.sheet}!${raw.source.row}: ${key}`);
    }
    assert.equal(fieldValue(row, 'date'), row.date);
    if (row.date) assert.equal(fieldValue(row, 'month'), row.date.slice(0, 7));
    const normalized = (value: string | null) => value?.normalize('NFKC').trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru') ?? null;
    assert.equal(normalized(fieldValue(row, 'manager_label')), normalized(raw.fields.manager_label));
    assert.equal(normalized(fieldValue(row, 'product')), normalized(raw.fields.product));
  }
});

test('source KVP is visible for all 80 rows, totals 879340, and supports exact ranges, facets and sorting', () => {
  const rows = present('kvp_source');
  assert.equal(rows.length, 80);
  assert.ok(rows.every(row => new Decimal(row.fields.kvp_source!).gt(0)));
  assert.equal(rows.reduce((sum, row) => sum.plus(row.fields.kvp_source!), new Decimal(0)).toFixed(), '879340');
  for (const raw of rows) {
    assert.equal(raw.cells[`R${raw.source.row}`].value, raw.fields.kvp_source);
    assert.equal(byId.get(raw.id)!.fields.kvp_source, raw.cells[`R${raw.source.row}`].value);
  }
  const result = page({ kvp_source: { op: 'notEmpty' } }, { sort: 'kvp_source', direction: 'asc', facet: 'kvp_source' });
  assert.equal(result.total, 80);
  assert.deepEqual(sortedIds(result.items), sortedIds(rows));
  const ascending = [...rows].sort((a, b) => new Decimal(a.fields.kvp_source!).cmp(b.fields.kvp_source!) || a.id.localeCompare(b.id));
  assert.deepEqual(result.items.map(row => row.id), ascending.map(row => row.id));
  assert.deepEqual(new Set(result.facetValues), new Set(['', ...rows.map(row => row.fields.kvp_source!)]));
  const expected = rows.filter(row => new Decimal(row.fields.kvp_source!).gte(4000) && new Decimal(row.fields.kvp_source!).lte(10000));
  assert.equal(expected.length, 25);
  const range = page({ kvp_source: { op: 'range', value: '4 000', to: '10 000' } }, { sort: 'kvp_source', direction: 'desc' });
  assert.equal(range.total, expected.length);
  assert.deepEqual(sortedIds(range.items), sortedIds(expected));
  assert.equal(range.items[0].fields.kvp_source, '10000');
});

test('saved terms remain in source data while elapsed shipment days filter and sort', () => {
  const rows = present('term_source');
  assert.equal(rows.length, 1996);
  for (const raw of rows) {
    assert.equal(raw.cells[`V${raw.source.row}`].value, raw.fields.term_source);
    assert.equal(fieldValue(byId.get(raw.id)!, 'term_source'), raw.fields.term_source);
  }
  assert.ok(!shipmentColumns.some(column => ['term_source', 'payment_due_date', 'overdue_days'].includes(column.key)));
  for (const row of snapshot.shipments) assert.equal(row.fields.days_since_shipment, unpaidShipmentDays(row.date, row.fields.customer_amount, row.fields.paid_amount_source));
  const expected = snapshot.shipments.filter(row => Number(row.fields.days_since_shipment) >= 4 && Number(row.fields.days_since_shipment) <= 8);
  const result = page({ days_since_shipment: { op: 'range', value: '4', to: '8' } }, { sort: 'days_since_shipment', direction: 'asc' });
  assert.equal(result.total, expected.length);
  const expectedIds = [...expected].sort((a, b) => Number(a.fields.days_since_shipment) - Number(b.fields.days_since_shipment) || a.id.localeCompare(b.id)).slice(0, 100).map(row => row.id);
  assert.deepEqual(result.items.map(row => row.id), expectedIds);
});

test('Дата из файла preserves all 25 raw W dates and same-day range finds timestamps at both inclusive bounds', () => {
  assert.equal(shipmentColumns.find(column => column.key === 'unlabelled_note')?.title, 'Дата из файла');
  const rows = present('unlabelled_note');
  assert.equal(rows.length, 25);
  for (const raw of rows) {
    const stored = raw.cells[`W${raw.source.row}`].value;
    assert.match(stored!, /^2025-12-\d{2}T00:00:00$/);
    assert.equal(byId.get(raw.id)!.fields.unlabelled_note, stored);
    assert.equal(fieldValue(byId.get(raw.id)!, 'unlabelled_note'), stored);
  }
  const all = page({ unlabelled_note: { op: 'notEmpty' } }, { facet: 'unlabelled_note', sort: 'unlabelled_note', direction: 'asc' });
  assert.equal(all.total, 25);
  assert.deepEqual(sortedIds(all.items), sortedIds(rows));
  assert.deepEqual(new Set(all.facetValues), new Set(['', ...rows.map(row => row.fields.unlabelled_note!)]));
  assert.equal(all.items[0].fields.unlabelled_note, '2025-12-23T00:00:00');
  assert.equal(all.items.at(-1)!.fields.unlabelled_note, '2025-12-31T00:00:00');
  const expected = rows.filter(row => row.fields.unlabelled_note === '2025-12-26T00:00:00');
  assert.equal(expected.length, 4);
  const sameDay = page({ unlabelled_note: { op: 'range', value: '2025-12-26', to: '2025-12-26' } });
  assert.deepEqual(sortedIds(sameDay.items), sortedIds(expected));
  const oneValue = page({ unlabelled_note: { op: 'values', values: ['2025-12-26T00:00:00'] } });
  assert.deepEqual(sortedIds(oneValue.items), sortedIds(expected));
});

test('one carrier / driver column uses the selected driver while retaining the original carrier in source data', () => {
  const carriers = present('carrier_name');
  assert.equal(carriers.length, 1299);
  for (const raw of carriers) {
    assert.equal(fieldValue(byId.get(raw.id)!, 'carrier_name'), raw.cells[`P${raw.source.row}`].value);
    assert.equal(fieldValue(byId.get(raw.id)!, 'driver_name'), null);
  }
  const previous = snapshot.shipments.find(row => row.fields.carrier_name === 'Олег')!;
  const driver = snapshot.directories!.drivers.find(row => row.name === 'Вова')!;
  const data = empty();
  const fields = prepareShipmentFields({ driver_id: driver.id }, previous, snapshot);
  data.shipments[previous.id] = { fields, version: 1, createdAt: '2026-09-09T12:00:00Z', updatedAt: '2026-09-09T12:00:00Z' };
  const assigned = currentSnapshot(source, data);
  const row = assigned.shipments.find(row => row.id === previous.id)!;
  assert.equal(fieldValue(row, 'driver_name'), 'Вова');
  assert.equal(fieldValue(row, 'carrier_name'), 'Вова');
  assert.equal(row.fields.carrier_name, 'Олег');
  assert.ok(!shipmentColumns.some(column => column.key === 'driver_name'));
  const byDriver = shipmentPage(assigned, new URLSearchParams({ filters: JSON.stringify({ carrier_name: { op: 'values', values: ['Вова'] } }) }));
  assert.equal(byDriver.total, assigned.shipments.filter(row => fieldValue(row, 'carrier_name') === 'Вова').length);
  const selected = shipmentPage(assigned, new URLSearchParams({ query: previous.id, filters: JSON.stringify({ carrier_name: { op: 'values', values: ['Вова'] } }) }));
  assert.deepEqual(selected.items.map(row => row.id), [previous.id]);
  assert.ok(byDriver.items.every(row => fieldValue(row, 'carrier_name') === 'Вова'));
  const byCarrier = shipmentPage(assigned, new URLSearchParams({ filters: JSON.stringify({ carrier_name: { op: 'values', values: ['Олег'] } }), facet: 'carrier_name' }));
  assert.equal(byCarrier.total, carriers.filter(row => row.fields.carrier_name === 'Олег').length - 1);
  assert.ok(byCarrier.facetValues!.includes('Олег'));
  assert.equal(assigned.shipments.find(row => row.id === previous.id)!.fields.carrier_name, previous.fields.carrier_name);
});

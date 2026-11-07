import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolve } from 'node:path';
import { directoriesFor, directoryEntryId, emptyDirectories, normalizeName } from '../server/directory-operations';
import { loadSnapshot } from '../server/local-api';
import type { OperationsData } from '../server/operations-store';
import type { Directories, NamedEntry, Snapshot } from '../web/src/model';

const template = await loadSnapshot(resolve('data/local-xlsx-final'));
type NamedKind = 'managers' | 'products' | 'paymentForms';

// Frozen pre-optimization behavior: spelling order and saved IDs are intentional.
function originalNamed(kind: NamedKind, labels: string[], saved: Directories) {
  const unique = new Map<string, NamedEntry>();
  for (const name of labels) if (name.trim() && name !== '0' && !saved.deletedEntries?.[kind]?.includes(directoryEntryId(kind, name)) && !saved[kind].some(row => row.id === directoryEntryId(kind, name))) unique.set(normalizeName(name), { id: directoryEntryId(kind, name), name: name.trim() });
  for (const row of saved[kind]) if (!saved.deletedEntries?.[kind]?.includes(row.id)) unique.set(kind === 'managers' ? row.id : normalizeName(row.name), row);
  return [...unique.values()].sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

function fixture(labels: string[]) {
  const base: Snapshot = {
    ...template,
    companies: [],
    shipments: labels.map((label, index) => ({ ...template.shipments[0], id: `source-${index}`, product: label, fields: { payment_form: label } })),
    managers: labels.map((label, index) => ({ ...template.managers[0], id: `manager-${index}`, label })),
    quality: { ...template.quality, aliasCandidates: [] },
  };
  const store: OperationsData = {
    schemaVersion: 2, sourceSha256: template.provenance.sourceSha256, revision: 0,
    shipments: {}, companies: [], paymentAllocations: [],
    directories: { ...emptyDirectories(), fleetSeedApplied: true },
  };
  return { base, store };
}

function compareNamed(base: Snapshot, store: OperationsData) {
  const result = directoriesFor(base, store);
  const local = Object.values(store.shipments).filter(row => !row.deleted);
  const labels: Record<NamedKind, string[]> = {
    managers: [...base.managers.map(row => row.label), ...local.flatMap(row => row.fields.manager_label ? [row.fields.manager_label] : [])],
    products: [...base.shipments.flatMap(row => row.product ? [row.product] : []), ...local.flatMap(row => row.fields.product ? [row.fields.product] : [])],
    paymentForms: ['б/нал', 'нал', 'ф2', ...base.shipments.flatMap(row => row.fields.payment_form ? [row.fields.payment_form] : [])],
  };
  for (const kind of ['managers', 'products', 'paymentForms'] as const) assert.deepEqual(result[kind], originalNamed(kind, labels[kind], store.directories!), kind);
  return result;
}

test('repeated exact spellings retain the last normalized spelling, whitespace and Unicode distinctions', () => {
  const labels = [' ДТ  зимнее ', 'дт зимнее', ' ДТ  зимнее ', 'Ёлка', 'ЕЛКА', 'е\u0308лка', 'Ａ', 'a', 'Ａ', '', ' ', '0', ' 0 '];
  const { base, store } = fixture(labels);
  const before = structuredClone({ base, store });
  const result = compareNamed(base, store);
  const product = (name: string) => result.products.find(row => row.id === directoryEntryId('products', name));
  assert.equal(product('дт зимнее')?.name, 'ДТ  зимнее');
  assert.equal(product('ёлка')?.name, 'е\u0308лка');
  assert.equal(product('елка')?.name, 'ЕЛКА');
  assert.notEqual(product('ёлка')?.id, product('елка')?.id);
  assert.equal(product('a')?.name, 'Ａ');
  assert.equal(product('0')?.name, '0'); // Exact "0" is excluded; padded " 0 " is historical input.
  assert.deepEqual({ base, store }, before);
  result.products[0].name = 'Changed caller result';
  assert.deepEqual(directoriesFor(base, store).products, originalNamed('products', labels, store.directories!));
});

test('saved IDs, custom overrides and deletions preserve catalog precedence and metadata', () => {
  const { base, store } = fixture(['Источник', 'Кастом', 'Удалённый источник', 'Удалённый кастом', 'Менеджер', 'Менеджер']);
  const saved = store.directories!;
  saved.products = [
    { id: directoryEntryId('products', 'Источник'), name: 'Переименованный источник', version: 7, documentName: 'Полное наименование' },
    { id: 'custom-product', name: 'КАСТОМ', version: 3 },
    { id: 'deleted-custom-product', name: 'Удалённый кастом', version: 4 },
  ];
  saved.managers = [
    { id: directoryEntryId('managers', 'Источник'), name: 'Переименованный сотрудник', version: 2 },
    { id: 'custom-manager', name: 'Менеджер', version: 9 },
    { id: 'deleted-manager', name: 'Удалённый менеджер' },
  ];
  saved.paymentForms = [{ id: 'custom-payment-form', name: 'Б/НАЛ', version: 5 }];
  saved.deletedEntries = {
    products: [directoryEntryId('products', 'Удалённый источник'), 'deleted-custom-product'],
    managers: ['deleted-manager'],
    paymentForms: [directoryEntryId('paymentForms', 'нал')],
  };
  const result = compareNamed(base, store);
  assert.deepEqual(result.products.find(row => row.id === saved.products[0].id), saved.products[0]);
  assert.equal(result.products.find(row => normalizeName(row.name) === 'кастом')?.id, 'custom-product');
  assert.equal(result.products.some(row => row.id === directoryEntryId('products', 'Удалённый источник')), false);
  assert.equal(result.products.find(row => row.name === 'Удалённый кастом')?.id, directoryEntryId('products', 'Удалённый кастом'));
  assert.equal(result.managers.filter(row => row.name === 'Менеджер').length, 2);
  assert.equal(result.paymentForms.find(row => normalizeName(row.name) === 'б/нал')?.id, 'custom-payment-form');
  assert.equal(result.paymentForms.some(row => row.name === 'нал'), false);
});

test('large repeated histories and later edits retain local deletion and archived-company behavior', () => {
  const repeated = Array.from({ length: 2100 }, (_, index) => [' ДТ ', 'дт', 'Ёж', 'Еж', ' ДТ '][index % 5]);
  const { base, store } = fixture(repeated);
  store.shipments = {
    live: { fields: { product: 'Локальный', manager_label: 'Диспетчер' }, version: 1, createdAt: '', updatedAt: '' },
    deleted: { fields: { product: 'Удалённая строка', manager_label: 'Удалённый сотрудник' }, deleted: true, version: 1, createdAt: '', updatedAt: '' },
  };
  const company = { id: 'active-company', name: 'Компания', roles: [], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] };
  base.companies = [company, { ...company, id: 'archived-company', name: ' КОМПАНИЯ ', directoryArchived: true }];
  const before = structuredClone({ base, store });
  const first = compareNamed(base, store);
  assert.equal(first.products.some(row => row.name === 'Удалённая строка'), false);
  assert.deepEqual(first.duplicates[0].ids, ['active-company', 'archived-company']);
  assert.deepEqual({ base, store }, before);

  store.directories!.deletedEntries = { products: [directoryEntryId('products', 'Локальный')] };
  store.directories!.products.push({ id: 'new-product', name: 'Новое название', version: 1 });
  store.shipments.live.fields.manager_label = 'Новый диспетчер';
  store.sourceOperationsCleared = true;
  const edited = compareNamed(base, store);
  assert.equal(edited.products.some(row => row.name === 'Локальный'), false);
  assert.equal(edited.managers.some(row => row.name === 'Диспетчер'), false);
  assert.equal(edited.managers.some(row => row.name === 'Новый диспетчер'), true);
  assert.equal(edited.products.some(row => row.id === 'new-product'), true);
  assert.deepEqual(edited.duplicates, []);
});

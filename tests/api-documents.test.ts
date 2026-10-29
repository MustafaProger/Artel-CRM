import { archiveView, createArchiveEntry, validateDocumentArchive, deleteArchiveEntry } from '../server/document-archive';
import type { OperationsData } from '../server/operations-store';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createSnapshotMiddleware } from '../server/local-api';
import { documentExpired } from '../web/src/documents-model';

test('document expiry is inclusive and optional', () => {
  assert.equal(documentExpired(null, '2026-10-29'), false);
  assert.equal(documentExpired('2026-10-29', '2026-10-29'), false);
  assert.equal(documentExpired('2026-10-28', '2026-10-29'), true);
  assert.equal(documentExpired('2026-10-30', '2026-10-29'), false);
});
test('archive permissions, upload validation, persistence and protected downloads', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-documents-'));
  const middleware = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { operationsDirectory: directory });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  function client() {
    let cookie = '';
    return async (path: string, body?: unknown, method = body ? 'POST' : 'GET') => {
      const r = await fetch(base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (r.headers.get('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
      return r;
    };
  }
  const admin = client(), employee = client(), anonymous = client();
  try {
    assert.equal((await admin('/api/auth/setup', { login: 'archive-admin', name: 'Архив тест', password: 'Local-test-archive-2026!' })).status, 200);
    const manager = (await (await admin('/api/directories', { kind: 'managers', name: 'Сотрудник архива' })).json()).entry;
    let user = (await (await admin('/api/auth/users', { login: 'archive-employee', name: 'Сотрудник', password: 'Local-test-archive-2026!', role: 'employee', managerId: manager.id, sections: [] })).json()).user;
    assert.ok(user?.id);
    assert.equal((await employee('/api/auth/login', { login: 'archive-employee', password: 'Local-test-archive-2026!' })).status, 200);
    assert.equal((await anonymous('/api/documents')).status, 401);
    assert.equal((await employee('/api/documents')).status, 403);
    assert.equal((await employee('/api/documents/categories', { name: 'Чужая' })).status, 403);
    const category = (await (await admin('/api/documents/categories', { name: 'Договоры' })).json()).entry;
    assert.ok(category.id);
    assert.equal((await admin('/api/documents/categories', { name: 'договоры' })).status, 409);
    const item = (await (await admin('/api/documents/items', { categoryId: category.id, name: 'Гена' })).json()).entry;
    assert.ok(item.id);
    assert.equal((await admin('/api/documents/items', { categoryId: category.id, name: 'гена' })).status, 409);
    assert.equal((await employee('/api/documents/items', { categoryId: category.id, name: 'Нет доступа' })).status, 403);
    const secondCategory = (await (await admin('/api/documents/categories', { name: 'Автомобили' })).json()).entry;
    const payload = { categoryId: category.id, itemId: item.id, title: 'Тестовый договор', fileName: 'договор.txt', data: Buffer.from('Проверка точного файла').toString('base64'), expiresOn: '2026-10-28' };
    assert.equal((await admin('/api/documents/entries', { ...payload, expiresOn: '2026-02-30' })).status, 400);
    assert.equal((await admin('/api/documents/entries', { ...payload, data: '!!' })).status, 400);
    assert.equal((await admin('/api/documents/entries', { ...payload, categoryId: 'missing' })).status, 400);
    assert.equal((await admin('/api/documents/entries', { ...payload, itemId: 'missing' })).status, 400);
    assert.equal((await admin('/api/documents/entries', { ...payload, categoryId: secondCategory.id })).status, 400);
    const doc = (await (await admin('/api/documents/entries', payload)).json()).entry;
    assert.ok(doc.id); assert.equal(doc.data, undefined);
    const url = `/api/documents/entries/${doc.id}/file`;
    assert.equal((await anonymous(url)).status, 401); assert.equal((await employee(url)).status, 403);
    const downloaded = await admin(url); assert.equal(await downloaded.text(), 'Проверка точного файла'); assert.match(downloaded.headers.get('content-disposition')!, /^attachment/);
    user = (await (await admin(`/api/auth/users/${user.id}`, { name: user.name, login: user.login, role: user.role, managerId: user.managerId, version: user.version, sections: ['documents'] }, 'PATCH')).json()).user;
    assert.ok(user?.sections.includes('documents'));
    await employee('/api/auth/login', { login: 'archive-employee', password: 'Local-test-archive-2026!' });
    assert.equal((await employee('/api/documents')).status, 200);
    assert.equal((await employee('/api/documents/entries', { ...payload, expiresOn: null })).status, 201);
    const fresh = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { operationsDirectory: directory });
    const restart = createServer((req, res) => fresh(req, res, () => res.end()));
    await new Promise<void>(done => restart.listen(0, '127.0.0.1', done));
    try {
      const login = await fetch(`http://127.0.0.1:${(restart.address() as AddressInfo).port}/api/auth/login`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ login: 'archive-admin', password: 'Local-test-archive-2026!' }) });
      const saved = await fetch(`http://127.0.0.1:${(restart.address() as AddressInfo).port}/api/documents`, { headers: { Cookie: login.headers.get('set-cookie')!.split(';')[0] } });
      const a = await saved.json(); assert.equal(a.documents.length, 2); assert.equal(a.categories.length, 2); assert.equal(a.items.length, 1); assert.equal(a.items[0].name, 'Гена'); assert.ok(a.documents.every((d: { itemId: string }) => d.itemId === item.id)); assert.ok(a.documents.every((d: { data?: string }) => d.data === undefined));
    } finally { await new Promise<void>(done => restart.close(() => done())); }
    const cardBody = { name: 'Гена — карточка', categoryId: category.id, files: [
      { title: 'Паспорт', fileName: 'passport.txt', data: 'YWJj', expiresOn: '2020-01-01' },
      { title: 'СНИЛС', fileName: 'snils.txt', data: 'ZGVm', expiresOn: null }
    ] };
    const createdResponse = await employee('/api/documents/cards', cardBody);
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    const cardId = created.entry.id, cardFiles = created.archive.documents.filter((d: { itemId: string }) => d.itemId === cardId);
    assert.equal(cardFiles.length, 2); assert.equal(created.entry.version, 1);
    const cardPath = `/api/documents/cards/${cardId}`;
    const beforeInvalid = await (await admin('/api/documents')).json();
    assert.equal((await employee(cardPath, { ...cardBody, version: 1, files: [{ ...cardBody.files[0], title: 'Не записывать' }, { ...cardBody.files[1], data: 'bad!' }] }, 'PATCH')).status, 400);
    assert.deepEqual(await (await admin('/api/documents')).json(), beforeInvalid);
    assert.equal((await employee(cardPath, { ...cardBody, version: 1, files: [{ id: doc.id, title: 'Чужой файл' }] }, 'PATCH')).status, 400);
    const changed = await employee(cardPath, { ...cardBody, name: 'Геннадий', version: 1, files: [{ id: cardFiles[0].id, title: 'Новый паспорт', expiresOn: null, data: 'bmV3', fileName: 'new.txt' }] }, 'PATCH');
    assert.equal(changed.status, 200); assert.equal((await changed.json()).entry.version, 2);
    assert.equal((await employee(cardPath, { ...cardBody, version: 1 }, 'PATCH')).status, 409);
    assert.equal((await admin(`/api/documents/entries/${cardFiles[1].id}/file`)).status, 404);
    assert.equal(await (await admin(`/api/documents/entries/${cardFiles[0].id}/file`)).text(), 'new');
    assert.equal((await employee('/api/documents/cards', cardBody)).status, 201);
    const beforeDelete = await (await admin('/api/documents')).json();
    assert.equal((await anonymous(cardPath, { version: 2 }, 'DELETE')).status, 401);
    assert.equal((await employee(cardPath, { version: 1 }, 'DELETE')).status, 409);
    assert.deepEqual(await (await admin('/api/documents')).json(), beforeDelete);
    assert.equal((await employee(cardPath, { version: 2 }, 'DELETE')).status, 200);
    assert.equal((await admin(`/api/documents/entries/${cardFiles[0].id}/file`)).status, 404);
    assert.equal((await employee(cardPath, { version: 2 }, 'DELETE')).status, 404);
    const survivor = (await (await admin('/api/documents/cards', { name: 'Сохранить', categoryId: secondCategory.id, files: cardBody.files })).json()).entry;
    const beforeCategoryDelete = await (await admin('/api/documents')).json();
    assert.equal((await employee(`/api/documents/categories/${category.id}`, {}, 'DELETE')).status, 200);
    const afterCategoryDelete = await (await admin('/api/documents')).json();
    assert.deepEqual(afterCategoryDelete.categories, beforeCategoryDelete.categories.filter((c: { id: string }) => c.id !== category.id));
    assert.deepEqual(afterCategoryDelete.items, beforeCategoryDelete.items.filter((i: { categoryId: string }) => i.categoryId !== category.id));
    assert.deepEqual(afterCategoryDelete.documents, beforeCategoryDelete.documents.filter((d: { categoryId: string }) => d.categoryId !== category.id));
    assert.equal((await admin(url)).status, 404);
    assert.equal((await admin(`/api/documents/categories/${category.id}`, {}, 'DELETE')).status, 404);
    assert.equal((await employee(cardPath, { ...cardBody, version: 2 }, 'PATCH')).status, 404);
    await admin(`/api/auth/users/${user.id}`, { name: user.name, login: user.login, role: user.role, managerId: user.managerId, version: user.version, sections: [] }, 'PATCH');
    assert.equal((await employee(url)).status, 401);
    await employee('/api/auth/login', { login: 'archive-employee', password: 'Local-test-archive-2026!' });
    assert.equal((await employee(url)).status, 403);
    assert.equal((await employee(cardPath, { ...cardBody, version: 2 }, 'PATCH')).status, 403);
    assert.equal((await employee('/api/documents/cards', cardBody)).status, 403);
    assert.equal((await employee(`/api/documents/categories/${secondCategory.id}`, {}, 'DELETE')).status, 403);
    assert.equal((await employee(`/api/documents/cards/${survivor.id}`, { version: 1 }, 'DELETE')).status, 403);
    assert.deepEqual(await (await admin('/api/documents')).json(), afterCategoryDelete);
    assert.equal((await admin(`/api/documents/categories/${secondCategory.id}`, {}, 'DELETE')).status, 200);
    assert.deepEqual(await (await admin('/api/documents')).json(), { categories: [], items: [], documents: [] });
  } finally { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); }
});


test('legacy documents keep bytes and become accessible through a stable item without a read-time write', () => {
  const data: OperationsData = { schemaVersion: 1, sourceSha256: 'test', revision: 1, shipments: {}, companies: [], documentArchive: {
    categories: [{ id: 'c', name: 'Прежняя категория', createdAt: '2026-10-29T07:00:00Z', createdBy: 'test' }],
    documents: [{ id: 'd', categoryId: 'c', title: 'Прежний файл', expiresOn: null, fileName: 'old.txt', size: 3, data: 'YWJj', createdAt: '2026-10-29T07:00:00Z', createdBy: 'test' }]
  } };
  const before = JSON.stringify(data);
  validateDocumentArchive(data.documentArchive);
  const view = archiveView(data.documentArchive);
  assert.equal(JSON.stringify(data), before);
  assert.equal(view.items[0].id, view.documents[0].itemId);
  assert.equal(view.items[0].name, 'Документы категории');
  createArchiveEntry(data, 'items', { categoryId: 'c', name: 'Гена' }, 'test');
  validateDocumentArchive(data.documentArchive);
  assert.equal(data.documentArchive!.documents[0].data, 'YWJj');
  assert.equal(data.documentArchive!.documents[0].itemId, view.items[0].id);
  assert.equal(data.documentArchive!.items!.length, 2);
  deleteArchiveEntry(data, 'cards', view.items[0].id, { version: 1 });
  validateDocumentArchive(data.documentArchive);
  assert.equal(data.documentArchive!.documents.length, 0);
  assert.equal(data.documentArchive!.items!.length, 1);
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createArchiveEntry, saveArchiveCard, validateDocumentArchive } from '../server/document-archive';
import type { OperationsData } from '../server/operations-store';

test('reusing exact document payload validation never reuses metadata or trusts changed bytes/size', () => {
  const metadata = {createdBy:'owner',createdAt:'2026-11-09T00:00:00Z'};
  const archive = {categories:[{...metadata,id:'category',name:'Test'}],documents:[{...metadata,id:'document',categoryId:'category',title:'Test',fileName:'test.txt',expiresOn:null,size:3,data:'YWJj'}]};
  validateDocumentArchive(archive);
  validateDocumentArchive(structuredClone(archive));
  for (const patch of [{size:2},{data:'YWJj!'}, {data:'YWJ='}, {categoryId:'missing'}, {title:''}, {createdBy:null}]) {
    const changed = structuredClone(archive);
    Object.assign(changed.documents[0],patch);
    assert.throws(()=>validateDocumentArchive(changed));
    validateDocumentArchive(archive);
  }
  archive.documents[0].data = 'ZGVm';
  validateDocumentArchive(archive);
  archive.documents[0].data = 'ZGVm!';
  assert.throws(()=>validateDocumentArchive(archive));
});

test('both document upload paths allow 64 MiB total and reject one byte more', () => {
  const metadata = { createdBy: 'owner', createdAt: '2026-11-09T00:00:00Z' };
  const makeData = (): OperationsData => ({
    schemaVersion: 1, sourceSha256: 'test', revision: 0, shipments: {}, companies: [],
    documentArchive: {
      categories: [{ ...metadata, id: 'category', name: 'Drivers' }],
      items: [{ ...metadata, id: 'item', categoryId: 'category', name: 'Driver', version: 1 }],
      // Only the size matters to the quota check; payload validation is covered above.
      documents: [{ ...metadata, id: 'existing', categoryId: 'category', itemId: 'item', title: 'Existing', fileName: 'existing.txt', expiresOn: null, size: 64 * 1024 * 1024 - 3, data: 'YQ==' }]
    }
  });
  const entry = { categoryId: 'category', itemId: 'item', title: 'New', fileName: 'new.txt', expiresOn: null, data: 'YWJj' };
  createArchiveEntry(makeData(), 'entries', entry, 'owner');
  assert.throws(() => createArchiveEntry(makeData(), 'entries', { ...entry, data: 'YWJjZA==' }, 'owner'), /64 МБ/);
  const card = { categoryId: 'category', name: 'Other driver', files: [{ title: 'New', fileName: 'new.txt', expiresOn: null, data: 'YWJj' }] };
  saveArchiveCard(makeData(), card, 'owner');
  assert.throws(() => saveArchiveCard(makeData(), { ...card, files: [{ ...card.files[0], data: 'YWJjZA==' }] }, 'owner'), /64 МБ/);
});

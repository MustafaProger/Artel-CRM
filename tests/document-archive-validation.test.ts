import assert from 'node:assert/strict';
import { test } from 'node:test';
import { validateDocumentArchive } from '../server/document-archive';

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

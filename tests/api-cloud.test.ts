import assert from 'node:assert/strict';
import { test } from 'node:test';
import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { sameOrigin } from '../server/cloud-auth';
import { BlobOperationsStore } from '../server/blob-operations-store';
import { encodeOperations, StoreError, type OperationsData } from '../server/operations-store';
import { ApiError } from '../server/api-error';

test('cloud API accepts same-origin requests and rejects cross-origin mutations', () => {
  assert.equal(sameOrigin({ method: 'POST', headers: { host: 'crm.example', origin: 'https://crm.example' } }), true);
  for (const headers of [{ host: 'crm.example' }, { host: 'crm.example', origin: 'https://other.example' }, { host: 'crm.example', origin: 'http://crm.example' }, { host: 'crm.example', origin: 'https://crm.example', 'sec-fetch-site': 'cross-site' }]) {
    assert.equal(sameOrigin({ method: 'POST', headers }), false);
  }
});

function memoryBlob() {
  let raw = encodeOperations({ schemaVersion: 1, sourceSha256: 'source', revision: 0, shipments: {}, companies: [] });
  let version = 1;
  const client = {
    get: (async (_path, options) => {
      assert.equal(options.useCache, false);
      assert.equal(options.headers?.['Accept-Encoding'], 'identity');
      return { statusCode: 200, stream: new Response(raw).body!, blob: { etag: String(version) } } as Awaited<ReturnType<typeof get>>;
    }) as typeof get,
    put: (async (_path, body, options) => {
      assert.equal(options.access, 'private');
      assert.equal(options.addRandomSuffix, false);
      if (options.ifMatch !== String(version)) throw new BlobPreconditionFailedError();
      raw = String(body); version++;
      return { etag: String(version) } as Awaited<ReturnType<typeof put>>;
    }) as typeof put,
  };
  return { client, corrupt: () => { raw = '{}'; } };
}

test('cloud writes survive new store instances and preserve source checksums', async () => {
  const { client, corrupt } = memoryBlob();
  const first = new BlobOperationsStore('test', client);
  await first.mutate('source', data => { data.directories!.defaults.profit = 'simple'; return { changed: true, result: true }; });
  const data = await new BlobOperationsStore('test', client).read('source');
  assert.equal(data.revision, 1);
  assert.equal(data.directories!.defaults.profit, 'simple');
  await assert.rejects(first.read('other-source'), StoreError);
  corrupt();
  await assert.rejects(first.mutate('source', () => ({ changed: true, result: true })), StoreError);
});

test('two cloud writers cannot overwrite each other', async () => {
  const { client } = memoryBlob();
  const first = new BlobOperationsStore('test', client);
  const second = new BlobOperationsStore('test', client);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let entered = 0;
  const update = async (data: OperationsData) => {
    if (++entered === 2) release();
    await gate;
    data.directories!.defaults.profit = 'simple';
    return { changed: true, result: true };
  };
  const results = await Promise.allSettled([first.mutate('source', update), second.mutate('source', update)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  const rejected = results.find(result => result.status === 'rejected') as PromiseRejectedResult;
  assert.ok(rejected.reason instanceof ApiError);
  assert.equal(rejected.reason.status, 409);
  assert.equal((await first.read('source')).revision, 1);
});

test('missing cloud state never starts an empty CRM', async () => {
  const { client } = memoryBlob();
  client.get = (async () => null) as typeof get;
  await assert.rejects(new BlobOperationsStore('test', client).read('source'), StoreError);
});

test('weak compression ETags fail closed instead of issuing an invalid conditional write', async () => {
  const { client } = memoryBlob();
  const read = client.get;
  let writes = 0;
  client.get = (async (...args: Parameters<typeof get>) => {
    const result = await read(...args);
    if (result) result.blob.etag = 'W/"compressed"';
    return result;
  }) as typeof get;
  client.put = (async () => { writes++; throw new Error('Unexpected write'); }) as typeof put;
  await assert.rejects(new BlobOperationsStore('test', client).mutate('source', () => ({ changed: true, result: true })), StoreError);
  assert.equal(writes, 0);
});

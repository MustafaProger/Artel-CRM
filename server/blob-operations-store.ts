import { get, put, BlobPreconditionFailedError } from '@vercel/blob';
import { ApiError } from './api-error';
import { decodeOperations, encodeOperations, StoreError, type OperationsData, type OperationsStorage } from './operations-store';

export class BlobOperationsStore implements OperationsStorage {
  constructor(private readonly pathname = 'artel/operations.json', private readonly client = { get, put }) {}

  private async load(sourceSha256: string) {
    const result = await this.client.get(this.pathname, { access: 'private', useCache: false });
    // Missing remote data is a deployment error; never silently start an empty CRM.
    if (!result || result.statusCode !== 200 || !result.stream) throw new StoreError('Cloud operations store is missing');
    const raw = await new Response(result.stream).text();
    if (Buffer.byteLength(raw) > 64 * 1024 * 1024) throw new StoreError('Operations store too large');
    return { data: decodeOperations(raw, sourceSha256), etag: result.blob.etag };
  }

  async read(sourceSha256: string) { return (await this.load(sourceSha256)).data; }

  async mutate<T>(sourceSha256: string, update: (data: OperationsData) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean }): Promise<T> {
    const { data, etag } = await this.load(sourceSha256);
    const { result, changed } = await update(data);
    if (changed) {
      data.revision++;
      try {
        await this.client.put(this.pathname, encodeOperations(data), {
          access: 'private', addRandomSuffix: false, allowOverwrite: true,
          ifMatch: etag, contentType: 'application/json',
        });
      } catch (error) {
        if (error instanceof BlobPreconditionFailedError) throw new ApiError(409, 'Данные изменены в другом окне. Обновите страницу и повторите действие.');
        throw error;
      }
    }
    return result;
  }
}

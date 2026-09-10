import { mkdir, rename, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { get } from '@vercel/blob';
import { build } from 'esbuild';
// Git contains code only. Production builds fetch the pinned, immutable source snapshot.
if (process.env.VERCEL) {
  const sha = process.env.ARTEL_SOURCE_SHA256;
  if (!sha || !/^[a-f0-9]{64}$/.test(sha)) throw new Error('ARTEL_SOURCE_SHA256 must identify the source snapshot');
  const names = ['manifest', 'companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report'];
  const files = new Map();
  for (const name of names) {
    const result = await get(`artel/source/${sha}/${name}.json`, { access: 'private', useCache: false });
    if (!result || result.statusCode !== 200) throw new Error(`Source snapshot missing: ${name}`);
    files.set(name, Buffer.from(await new Response(result.stream).arrayBuffer()));
  }
  const manifest = JSON.parse(files.get('manifest').toString());
  if (manifest.meta.source_sha256 !== sha) throw new Error('Source identity mismatch');
  for (const name of names.slice(1)) {
    const bytes = files.get(name);
    if (createHash('sha256').update(bytes).digest('hex') !== manifest.files[`${name}.json`]?.sha256) throw new Error(`Source checksum mismatch: ${name}`);
    if (JSON.parse(bytes.toString()).meta.source_sha256 !== sha) throw new Error(`Source identity mismatch: ${name}`);
  }
  await mkdir('data/local-xlsx-final', { recursive: true });
  for (const [name, bytes] of files) await writeFile(`data/local-xlsx-final/${name}.json`, bytes);
}
await mkdir('server-render', { recursive: true });
await rename('app-dist/index.html', 'server-render/index.html');
await build({ entryPoints: ['server/cloud-handler.ts'], outfile: 'server-render/handler.mjs', bundle: true, platform: 'node', target: 'node24', format: 'esm', packages: 'external' });

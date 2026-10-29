import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFile as execFileCallback } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { OperationsStore, decodeOperations } from '../server/operations-store';
import { emptyWork } from '../web/src/work-model';
const execFile = promisify(execFileCallback);
const source = 'c'.repeat(64);
const cli = resolve('server-render/work-storage.mjs');
const exporter = resolve('server-render/export-operations.mjs');
async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'work-tools-'));
  const directory = resolve(root, 'data/operations');
  const snapshot = resolve(root, 'data/snapshot');
  await mkdir(snapshot, { recursive: true });
  await writeFile(resolve(snapshot, 'manifest.json'), JSON.stringify({ meta: { source_sha256: source } }));
  const store = new OperationsStore(directory);
  await store.mutate(source, d => { d.work = emptyWork(); return { result: null, changed: true }; });
  const env = { ...process.env, ARTEL_STORE_DIR: directory, ARTEL_SNAPSHOT_DIR: snapshot };
  return { root, directory, snapshot, store, env, close: () => rm(root, { recursive: true, force: true }) };
}
test('built migration/export/merge tools preserve current state and refuse missing stop confirmation', async () => {
  const f = await fixture(); try {
    const original = await readFile(f.store.path);
    await assert.rejects(execFile(process.execPath, [cli, 'split', f.directory, source]));
    assert.deepEqual(await readFile(f.store.path), original);
    await execFile(process.execPath, [cli, 'split', f.directory, source, '--writers-stopped']);
    await f.store.mutateWork(source, d => { d.work!.notes.push({ id: 'new-note', title: 'После переноса', content: 'Сохранить при возврате', assigneeId: 'employee', createdBy: 'employee', updatedBy: 'employee', createdAt: '2026-10-29T10:00:00Z', updatedAt: '2026-10-29T10:00:00Z', version: 1, attachments: [], comments: [] }); return { result: null, changed: true }; });
    const current = await f.store.read(source);
    const exported = await execFile(process.execPath, [exporter], { env: f.env });
    assert.deepEqual(decodeOperations(exported.stdout, source), current);
    const output = resolve(f.root, 'export.json');
    await execFile(process.execPath, [cli, 'export', f.directory, source, '--writers-stopped', output]);
    assert.deepEqual(decodeOperations(await readFile(output, 'utf8'), source), current);
    await assert.rejects(execFile(process.execPath, [cli, 'export', f.directory, source, '--writers-stopped', output]));
    await execFile(process.execPath, [cli, 'merge', f.directory, source, '--writers-stopped']);
    assert.deepEqual(decodeOperations(await readFile(f.store.path, 'utf8'), source), current);
  } finally { await f.close(); }
});
test('backup script exports a valid flat snapshot for either layout and refuses damaged Work', async () => {
  const f = await fixture(); try {
    const binary = resolve(f.root, 'bin'); await mkdir(binary);
    // Replace Docker transport with actual local Node tools; no daemon or network.
    await writeFile(resolve(binary, 'docker'), `#!/usr/bin/env python3\nimport os,sys,subprocess\na=sys.argv[1:]\ni=a.index('node')\nargs=a[i+1:]\nif args and args[0]=='/app/server-render/export-operations.mjs': args[0]=os.environ['TEST_EXPORTER']\nsys.exit(subprocess.call([os.environ['TEST_NODE']]+args))\n`, { mode: 0o700 });
    const backup = (await readFile('ops/production/backup.py', 'utf8')).replace("ROOT = Path('/opt/artel-crm')", `ROOT = Path(${JSON.stringify(f.root)})`);
    const script = resolve(f.root, 'backup.py'); await writeFile(script, backup);
    const env = { ...f.env, PATH: `${binary}:${process.env.PATH}`, TEST_NODE: process.execPath, TEST_EXPORTER: exporter };
    for (const mode of ['legacy', 'partitioned-flattened']) {
      if (mode !== 'legacy') await execFile(process.execPath, [cli, 'split', f.directory, source, '--writers-stopped']);
      await execFile('python3', [script], { env });
      const archive = (await readdir(resolve(f.root, 'backups'))).filter(n => n.endsWith('.tar.gz')).sort().at(-1)!;
      const extraction = await execFile('python3', ['-c', "import sys,tarfile,json; t=tarfile.open(sys.argv[1]); print(json.dumps({'manifest':json.load(t.extractfile('backup-manifest.json')),'raw':t.extractfile('data/operations/operations.json').read().decode()}))", resolve(f.root, 'backups', archive)]);
      const result = JSON.parse(extraction.stdout);
      assert.equal(result.manifest.storageLayout, mode);
      assert.deepEqual(decodeOperations(result.raw, source), await f.store.read(source));
    }
    const before = (await readdir(resolve(f.root, 'backups'))).sort();
    await writeFile(resolve(f.directory, 'work-storage/work.json'), '{}');
    await assert.rejects(execFile('python3', [script], { env }));
    assert.deepEqual((await readdir(resolve(f.root, 'backups'))).sort(), before);
  } finally { await f.close(); }
});

test('three separate Node processes commit 30 updates without lost revisions', async () => {
  const f = await fixture(); try {
    await execFile(process.execPath, [cli, 'split', f.directory, source, '--writers-stopped']);
    const before = (await f.store.read(source)).revision;
    const code = `import {OperationsStore} from ${JSON.stringify(resolve('server/operations-store.ts'))};
      const store=new OperationsStore(process.env.ARTEL_STORE_DIR);
      for(let i=0;i<10;i++)await store.mutateWork('${source}',d=>{
        d.work.notes.push({id:process.pid+'-'+i,title:'Parallel',content:'Synthetic',assigneeId:'employee',createdBy:'employee',updatedBy:'employee',createdAt:'2026-10-29T10:00:00Z',updatedAt:'2026-10-29T10:00:00Z',version:1});
        return {result:null,changed:true};
      });`;
    await Promise.all(Array.from({ length: 3 }, () => execFile(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], { env: f.env })));
    const after = await f.store.read(source);
    assert.equal(after.work!.notes.length, 30);
    assert.equal(new Set(after.work!.notes.map(n => n.id)).size, 30);
    assert.equal(after.revision, before + 30);
  } finally { await f.close(); }
});

"""Server-only capture; raw CRM evidence stays private on this server."""
import hashlib,importlib.util,json,os,subprocess
from pathlib import Path
os.umask(0o077)
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
def save(path,value):
    with path.open('x') as f:json.dump(value,f,indent=2)
def capture(release,label):
    root=Path('/opt/artel-crm');worker=Path('/opt/artel-invoices')
    spec=importlib.util.spec_from_file_location('storage_snapshot',release/'storage-snapshot.py');snapshot=importlib.util.module_from_spec(spec);spec.loader.exec_module(snapshot)
    config=json.loads((release/'config.json').read_text())
    raw=snapshot.read_operations(root,config['image'])
    with (release/(label+'-operations.private.json')).open('xb') as f:f.write(raw)
    files=[root/'compose.yaml',worker/'compose.yaml',Path('/etc/caddy/Caddyfile')]
    for d in [root/'secrets',worker/'secrets',root/'data/snapshot',Path('/etc/caddy/sites-enabled')]:
        files.extend(p for p in d.rglob('*') if p.is_file() and not p.name.endswith('.lock'))
    # Keep the independent Yandex timer and collector intact; never read/copy browser profile or cookies.
    files.extend(Path(n) for n in [
      '/etc/systemd/system/artel-yandex-balance.service',
      '/etc/systemd/system/artel-yandex-balance.timer',
      '/opt/artel-crm/private/yandex-browser-20261027/publish-snapshot.py',
      '/opt/artel-crm/private/yandex-browser-20261027/state/worker/collect.mjs',
      '/opt/artel-crm/private/yandex-browser-20261027/state/worker/balance.mjs',
    ])
    out=lambda args:subprocess.check_output(args,text=True).strip()
    ids=out(['docker','ps','-q']).splitlines()
    containers={}
    for i in ids:
        name,image,imageid,started=out(['docker','inspect','--format','{{.Name}}|{{.Config.Image}}|{{.Image}}|{{.State.StartedAt}}',i]).split('|')
        containers[name]={'id':i,'image':image,'imageId':imageid,'startedAt':started}
    worker_files={}
    bridge_raw=None
    for path in (worker/'data').rglob('*'):
        if not path.is_file():continue
        relative=str(path.relative_to(worker/'data'))
        raw_file=path.read_bytes()
        worker_files[relative]=hashlib.sha256(raw_file).hexdigest()
        if relative=='crm-bridge/auth.json':bridge_raw=raw_file
    if bridge_raw is not None:
        with (release/(label+'-worker-bridge-auth.private.json')).open('xb') as f:f.write(bridge_raw)
    result={'at':out(['date','-u','+%Y-%m-%dT%H:%M:%SZ']),
      'rawStoreSha256':hashlib.sha256(raw).hexdigest(),
      'protectedFiles':{str(p):sha(p) for p in files},
      'workerFiles':worker_files,
      'workerBridgeAuth':{'present':bridge_raw is not None,'sha256':hashlib.sha256(bridge_raw).hexdigest() if bridge_raw is not None else None},
      'containers':containers,'caddyPid':out(['systemctl','show','caddy','-p','MainPID','--value'])}
    save(release/(label+'-state.json'),result);return result
def compare(release,label):
    before=json.loads((release/'before-state.json').read_text());after=json.loads((release/(label+'-state.json')).read_text())
    raw={k:json.loads((release/(v+'-operations.private.json')).read_text()) for k,v in [('before','before'),('after',label)]}
    audit=json.loads(subprocess.check_output(['docker','exec','-i','artel-crm-crm-1','node','--input-type=module','--eval',(release/'audit-data.mjs').read_text()],input=json.dumps(raw),text=True))
    audit['protectedFilesUnchanged']=before['protectedFiles']==after['protectedFiles']
    audit['workerFilesUnchanged']=before['workerFiles']==after['workerFiles']
    audit['workerFileChanges']=[n for n in set(before['workerFiles'])|set(after['workerFiles']) if before['workerFiles'].get(n)!=after['workerFiles'].get(n)]
    bridge_states=[before.get('workerBridgeAuth',{}),after.get('workerBridgeAuth',{})]
    if all(v.get('present') for v in bridge_states):
        bridge_bytes=[(release/(phase+'-worker-bridge-auth.private.json')).read_bytes() for phase in ['before',label]]
        for raw_bytes,phase,state in zip(bridge_bytes,['before',label],[before,after]):
            assert hashlib.sha256(raw_bytes).hexdigest()==state['workerBridgeAuth']['sha256']==state['workerFiles']['crm-bridge/auth.json'], 'Worker bridge evidence checksum mismatch'
        spec=importlib.util.spec_from_file_location('worker_bridge_audit',release/'worker-bridge-audit.py')
        module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
        audit['workerBridgeAuth']=module.compare_bridge(*bridge_bytes,after['at'])
    else:
        audit['workerBridgeAuth']={'available':False,'unexplainedChanges':1,'classification':'requires_review_missing_private_snapshot'}
    audit['workerNonBridgeFilesUnchanged']=all(n=='crm-bridge/auth.json' for n in audit['workerFileChanges'])
    neighbors=lambda v:{k:x for k,x in v['containers'].items() if k not in ['/artel-crm-crm-1','/artel-invoices-invoices-1']}
    audit['otherServicesUnchanged']=neighbors(before)==neighbors(after) and before['caddyPid']==after['caddyPid']
    save(release/(label+'-preservation.json'),audit)
    return audit
if __name__=='__main__':
    import argparse
    p=argparse.ArgumentParser();p.add_argument('release',type=Path);p.add_argument('label',choices=['before','after','after-ui']);a=p.parse_args()
    assert a.release.resolve().parent==Path('/opt/artel-crm/releases')
    capture(a.release,a.label)
    if a.label!='before':
        v=compare(a.release,a.label);print(json.dumps({k:v[k] for k in ['strictDataEqual','unexplainedChanges','protectedFilesUnchanged','workerFilesUnchanged','otherServicesUnchanged']}))

#!/usr/bin/env python3
"""Publish scoped operator changes over verified current CRM; preserve worker and business data."""
import argparse,datetime,fcntl,hashlib,importlib.util,json,os,subprocess,tarfile,time,traceback
from pathlib import Path
os.umask(0o077)
p=argparse.ArgumentParser();p.add_argument('release',type=Path);p.add_argument('--config-sha256',required=True);a=p.parse_args()
r=a.release.resolve();assert r.parent==Path('/opt/artel-crm/releases')
assert not (r/'intermediate-no-switch.json').exists(), 'Intermediate package blocked; use the newly verified candidate'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
out=lambda args:subprocess.check_output(args,text=True).strip()
run=lambda args:subprocess.run(args,check=True)
assert sha(r/'config.json')==a.config_sha256
c=json.loads((r/'config.json').read_text())
spec=importlib.util.spec_from_file_location('verify_package',r/'verify-package.py');verify=importlib.util.module_from_spec(spec);spec.loader.exec_module(verify)
verify.verify(r,a.config_sha256)
for name,digest in c['deployHelperHashes'].items():assert sha(r/name)==digest,'Deployment helper drift'
compat=json.loads((r/'compatibility-proof.json').read_text());assert compat['passed'] and compat['fullDataExact'] and compat['externalRequests']==0 and compat['configSha256']==a.config_sha256
proof=json.loads((r/'image-proof.json').read_text())
assert proof['configSha256']==a.config_sha256 and all(all(i['checks'].values()) for i in proof['images'].values())
sp=json.loads((r/'static-read-proof.json').read_text());assert sp['passed'] and sp['configSha256']==a.config_sha256
for key in ['image','recoveryImage']:assert sp['images'][key]['imageId']==proof['images'][key]['id'] and sp['images'][key]['tag']==c[key]
assert proof['images']['image']['id']==proof['images']['recoveryImage']['id']
assert c['rollbackScope']=='same_candidate_code_only_no_old_backend_or_data_restore'
assert not (r/'switch-started.json').exists(),'Do not repeat an ambiguous switch'
root=Path('/opt/artel-crm');locks=[]
for path in [root/'.runtime-env.lock',root/'secrets/.runtime-env.lock',root/'.workflow-release.lock']:
    lock=path.open('a');fcntl.flock(lock,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(lock)
container='artel-crm-crm-1'
assert out(['docker','inspect','--format','{{.Config.Image}}',container])==c['previousImage']
assert out(['docker','inspect','--format','{{.Image}}',container])==c['previousImageId']
assert out(['docker','exec',container,'sha256sum','/app/server-render/production.mjs']).split()[0]==c['previousServerSha256']
baseline=root/'releases'/c['previousImage'].split(':',1)[1]
assert sha(baseline/'source-manifest.json')==c['baselineSourceManifestSha256']
assert sha(baseline/'source.tar.gz')==c['baselineSourceArchiveSha256']
assert out(['docker','image','inspect','--format','{{.Id}}',c['image']])==proof['images']['image']['id']
original_container_id=out(['docker','inspect','--format','{{.Id}}',container])
worker_image=out(['docker','inspect','--format','{{.Image}}','artel-invoices-invoices-1'])
assert worker_image==c['workerImageId']
run(['systemctl','start','artel-crm-backup.service'])
assert out(['systemctl','show','artel-crm-backup.service','-p','Result','--value'])=='success'
spec=importlib.util.spec_from_file_location('state',r/'release-state.py');state=importlib.util.module_from_spec(spec);spec.loader.exec_module(state)
spec=importlib.util.spec_from_file_location('classification',r/'classify-release.py');classification=importlib.util.module_from_spec(spec);spec.loader.exec_module(classification)
state.save(r/'switch-started.json',{'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'configSha256':a.config_sha256})
try:
    run(['docker','compose','--project-directory',str(root),'stop','--timeout','600','crm'])
    s=json.loads(out(['docker','inspect','--format','{{json .State}}',container]))
    assert s['Status']=='exited' and s['ExitCode']==0 and not s['OOMKilled']
    state.capture(r,'before')
    paths=[f for d in ['data','secrets'] for f in (root/d).rglob('*') if f.is_file() and not f.name.endswith('.lock')]
    paths.extend(root/n for n in ['.env','compose.yaml','release.json'])
    manifest={str(f.relative_to(root)):sha(f) for f in paths}
    archive=r/'crm-stopped-backup.private.tar.gz'
    with tarfile.open(archive,'x:gz') as t:
        for name in manifest:t.add(root/name,arcname=name,recursive=False)
    with tarfile.open(archive) as t:
        assert {m.name:hashlib.sha256(t.extractfile(m).read()).hexdigest() for m in t.getmembers() if m.isfile()}==manifest
    assert {n:sha(root/n) for n in manifest}==manifest
    state.save(r/'stopped-backup-proof.json',{'sha256':sha(archive),'restoredFilesVerified':True,'files':len(manifest)})
    env=(root/'.env').read_text();old='ARTEL_IMAGE='+c['previousImage'];new='ARTEL_IMAGE='+c['image']
    assert env.splitlines().count(old)==1
    tmp=root/('.env.direct-safety-'+str(os.getpid()))
    with tmp.open('x') as f:
        f.write('\n'.join(new if l==old else l for l in env.splitlines())+'\n');f.flush();os.fsync(f.fileno())
    os.replace(tmp,root/'.env')
    run(['docker','compose','--project-directory',str(root),'up','-d','--no-build','--pull','never','crm'])
    for _ in range(35):
        if out(['docker','inspect','--format','{{.State.Health.Status}}',container])=='healthy':break
        time.sleep(2)
    else:raise RuntimeError('CRM not healthy')
    assert out(['docker','inspect','--format','{{.Image}}',container])==proof['images']['image']['id']
    assert out(['docker','inspect','--format','{{.Image}}','artel-invoices-invoices-1'])==worker_image
    assert out(['docker','exec',container,'sha256sum','/app/server-render/production.mjs']).split()[0]==c['serverBundleSha256']
    run(['python3',str(r/'verify-public.py'),str(r)])
    state.capture(r,'after');audit=state.compare(r,'after')
    classified=classification.compare_phase(r,'after',container)
    state.save(r/'after-independent-classification.json',classified)
    run(['systemctl','start','artel-crm-backup.service'])
    assert out(['systemctl','show','artel-crm-backup.service','-p','Result','--value'])=='success'
    assert classified['allReviewedInvariantsPassed'], 'Preservation requires review; saved evidence retained, no data rollback'
    metadata={**c,'imageId':proof['images']['image']['id'],'updatedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'preservationAudit':str(r/'after-preservation.json'),'strictDataEqual':audit['strictDataEqual'],'unexplainedChanges':audit['unexplainedChanges'],'authenticatedProductionUiVerified':False,'independentClassification':str(r/'after-independent-classification.json'),'finalClassificationPending':True,'providerCompletionClaimed':False}
    state.save(r/'release.json',metadata)
    tmp=root/('release.direct-safety-'+str(os.getpid())+'.json');tmp.write_text(json.dumps(metadata,indent=2));os.replace(tmp,root/'release.json')
    state.save(r/'switch-service-result.json',{'healthy':True,'publicFilesVerified':True,'strictDataEqual':audit['strictDataEqual'],'unexplainedChanges':audit['unexplainedChanges'],'workerFilesUnchanged':audit['workerFilesUnchanged'],'reviewedBusinessInvariantsPreserved':classified['allReviewedInvariantsPassed'],'finalClassificationPending':True,'providerCompletionClaimed':False})
    print(json.dumps({'healthy':True,'publicFilesVerified':True,'image':c['image'],'classificationPending':True}))
except BaseException:
    # Preserve the original failure privately; never erase the switch marker.
    with (r/'switch-error.private.log').open('x') as failure:
        failure.write(traceback.format_exc());failure.flush();os.fsync(failure.fileno())
    recovery={'attempted':False,'healthy':False,'scope':None,'dataRestored':False,'oldBackendRestored':False}
    try:
        image_lines=[line.split('=',1)[1] for line in (root/'.env').read_text().splitlines() if line.startswith('ARTEL_IMAGE=')]
        assert len(image_lines)==1,'Runtime image setting is ambiguous; inspect manually'
        selected=image_lines[0]
        if selected==c['previousImage']:
            # No candidate env was committed. Restart only the exact container
            # that was stopped above, with the same compatible persisted store.
            assert out(['docker','inspect','--format','{{.Id}}',container])==original_container_id
            assert out(['docker','inspect','--format','{{.Image}}',container])==c['previousImageId']
            recovery.update(attempted=True,scope='restart_same_original_container_before_candidate_activation')
            run(['docker','start',original_container_id])
            expected_id=c['previousImageId']
        elif selected==c['image']:
            # Once candidate env is committed, recovery stays on this candidate.
            # Never put the previous backend over data touched by the candidate.
            expected_id=proof['images']['image']['id']
            assert out(['docker','image','inspect','--format','{{.Id}}',c['image']])==expected_id
            recovery.update(attempted=True,scope='same_candidate_code_only')
            run(['docker','compose','--project-directory',str(root),'up','-d','--no-build','--pull','never','crm'])
        else:
            raise RuntimeError('Runtime image was changed externally; manual reconciliation required')
        for _ in range(35):
            if out(['docker','inspect','--format','{{.State.Health.Status}}',container])=='healthy':break
            time.sleep(2)
        else:raise RuntimeError('Recovery image did not become healthy')
        assert out(['docker','inspect','--format','{{.Image}}',container])==expected_id
        recovery['healthy']=True
    except BaseException:
        with (r/'switch-recovery-error.private.log').open('x') as failure:failure.write(traceback.format_exc())
    state.save(r/'switch-recovery-result.json',recovery)
    print(json.dumps({'switchFailed':True,'recovery':recovery,'automaticRetryForbidden':True,'privateErrorLog':str(r/'switch-error.private.log')}))
    raise SystemExit(1)

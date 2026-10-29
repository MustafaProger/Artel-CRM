#!/usr/bin/env python3
"""Build and test the frozen CRM package with no production mounts or network."""
import argparse, hashlib, importlib.util, json, os, subprocess
from pathlib import Path
os.umask(0o077)
p=argparse.ArgumentParser();p.add_argument('release',type=Path);p.add_argument('--config-sha256',required=True);a=p.parse_args()
r=a.release.resolve(); assert r.parent==Path('/opt/artel-crm/releases')
assert not (r/'intermediate-no-switch.json').exists(), 'Intermediate package blocked; use the newly verified candidate'
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
assert sha(r/'config.json')==a.config_sha256
c=json.loads((r/'config.json').read_text()); assert r.name==c['releaseName']
spec=importlib.util.spec_from_file_location('verify_package',r/'verify-package.py');module=importlib.util.module_from_spec(spec);spec.loader.exec_module(module)
module.verify(r,a.config_sha256)
out=lambda args:subprocess.check_output(args,text=True).strip()
for key,name in [('sourceArchiveSha256','source.tar.gz'),('sourceManifestSha256','source-manifest.json'),
 ('sourceProofSha256','source-proof.json'),('bundleManifestSha256','bundle-manifest.json'),
 ('candidateUiManifestSha256','candidate-ui-manifest.json')]: assert sha(r/name)==c[key]
assert out(['docker','inspect','--format','{{.Config.Image}}','artel-crm-crm-1'])==c['previousImage']
assert out(['docker','inspect','--format','{{.Image}}','artel-crm-crm-1'])==c['previousImageId']
assert out(['docker','exec','artel-crm-crm-1','sha256sum','/app/server-render/production.mjs']).split()[0]==c['previousServerSha256']
baseline=Path('/opt/artel-crm/releases')/c['previousImage'].split(':',1)[1]
assert sha(baseline/'source-manifest.json')==c['baselineSourceManifestSha256']
assert sha(baseline/'source.tar.gz')==c['baselineSourceArchiveSha256']
actual={str(f.relative_to(r/'context')):sha(f) for f in (r/'context').rglob('*') if f.is_file()}
assert actual==json.loads((r/'bundle-manifest.json').read_text())
assert sha(r/'evidence-manifest.json')==c['evidenceManifestSha256']
for n,h in json.loads((r/'evidence-manifest.json').read_text()).items():assert sha(r/'evidence'/n)==h
for n,h in c['smokeScriptHashes'].items():assert sha(r/n)==h
assert c['rollbackScope']=='same_candidate_code_only_no_old_backend_or_data_restore'
assert out(['docker','inspect','--format','{{.Image}}','artel-invoices-invoices-1'])==c['workerImageId']
assert not (r/'image-proof.json').exists()
for tag in [c['image'],c['recoveryImage']]:
    assert subprocess.run(['docker','image','inspect',tag],stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL).returncode!=0
subprocess.run(['docker','build','--network','none','-t',c['image'],str(r/'context')],check=True)
subprocess.run(['docker','tag',c['image'],c['recoveryImage']],check=True)
proof={'configSha256':a.config_sha256,'smokeScriptHashes':c['smokeScriptHashes'],'evidenceManifestSha256':c['evidenceManifestSha256'],'productionMountsUsed':False,'network':'none','images':{}}
for key in ['image','recoveryImage']:
    image=c[key]; checks={}
    assert out(['docker','run','--rm','--network','none','--entrypoint','sha256sum',image,'/app/server-render/production.mjs']).split()[0]==c['serverBundleSha256']
    for script in ['image-smoke.mjs','invoice-image-smoke.mjs','nk-direct-autostart-image-smoke.mjs','saby-direct-protocol-image-smoke.mjs','operator-cases-image-smoke.mjs','production-entrypoint.sh','static-image-smoke.mjs']:
        cmd=['docker','run','--rm','-i','--network','none','--cap-drop','ALL','--security-opt','no-new-privileges:true']
        if script.endswith('.mjs'):
            cmd+=['--user','1000:1000','--workdir','/app','--read-only','--tmpfs','/tmp:size=64m,mode=1777','-e','ARTEL_RELEASE_NETWORK_NONE=true','-e','ARTEL_GEOCODER_ENABLED=false','--entrypoint','node',image,'--input-type=module']
        else: cmd+=['--entrypoint','sh',image,'-s']
        result=subprocess.run(cmd,input=(r/script).read_text(),text=True,capture_output=True)
        (r/(key+'-'+script+'.log')).write_text(result.stdout+result.stderr)
        assert result.returncode==0,key+' '+script+' failed; inspect saved log'
        checks[script]=True
    proof['images'][key]={'tag':image,'id':out(['docker','image','inspect','--format','{{.Id}}',image]),'checks':checks}
assert proof['images']['image']['id']==proof['images']['recoveryImage']['id'], 'Recovery must contain the exact same new code'
staticProof={'passed':True,'configSha256':a.config_sha256,'images':{key:{'imageId':proof['images'][key]['id'],'tag':c[key]} for key in ['image','recoveryImage']}}
with (r/'static-read-proof.json').open('x') as f:json.dump(staticProof,f,indent=2)
with (r/'image-proof.json').open('x') as f:json.dump(proof,f,indent=2)
print(json.dumps(proof))

subprocess.run(['python3',str(r/'compatibility-check.py'),str(r)],check=True)

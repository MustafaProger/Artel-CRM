#!/usr/bin/env python3
"""Verify this frozen performance release without network, Docker or data writes."""
import argparse, hashlib, json, re, tarfile
from collections import Counter
from pathlib import Path, PurePosixPath
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
canonical=lambda v:json.dumps(v,sort_keys=True,ensure_ascii=False,separators=(',',':')).encode()
CHECK_NAMES={'api','target','unit','lint','build','bank-period','work-source','work-built','security-source','security-built','navigation-chromium','navigation-webkit'}
UI_REPORTS={'work-source':'work-source.json','work-built':'work-built.json','security-source':'source-report.json','security-built':'built-report.json','navigation-chromium':'navigation-chromium.json','navigation-webkit':'navigation-webkit.json'}
EXPECTED_FILES={'tests/api-push.test.ts', 'tests/work-partition.test.ts', 'tests/api-work.test.ts', 'scripts/export-operations.ts', 'scripts/build-server.mjs', 'server/work-partition.ts', 'ops/production/Dockerfile', 'server/operations-store.ts', 'tests/work-partition-tools.test.ts', 'ops/production/deploy-invoices.py', 'tests/api-directory-deletion.test.ts', 'scripts/work-storage.ts', 'tests/production-entrypoint.sh', 'ops/production/storage-invariants.md', 'scripts/grant-invoice-access.ts', 'scripts/check-work-response.mjs', 'web/src/WorkPage.tsx', 'server/production.ts', 'tests/api-permissions.test.ts', 'ops/production/entrypoint.sh', 'server/local-api.ts', 'scripts/profile-work-partition.mjs', 'ops/production/backup.py'}
def code_manifest(v):return {n:h for n,h in v.items() if not n.startswith(('docs/','ops/','.github/')) and n not in ['AGENTS.md','PROJECT_STATUS.md','README.md']}
def qa_fingerprint(manifest):
 # The runner fingerprints every source file with json.dumps' default ASCII
 # escaping. This is deliberately different from the filtered package code hash.
 return hashlib.sha256(json.dumps(manifest,sort_keys=True,separators=(',',':')).encode()).hexdigest()
def qa_receipts(raw,before,after,manifest,baseline,own,baseline_image):
 assert raw['passed'] is True and raw['finishedAt'] and raw['startedAt'],'QA is incomplete'
 assert raw['sourceUnchanged'] is True and raw['providerEnvironmentCleared'] is True
 assert before==after==manifest,'QA full source manifest differs from packaged source'
 fingerprint=qa_fingerprint(manifest)
 assert raw['sourceCodeSha256']==fingerprint,'Raw QA full-source fingerprint mismatch'
 assert raw['baselineImage']==baseline_image and raw['baselineSourceFiles']==len(baseline)
 assert raw['sourceFiles']==len(manifest) and raw['changedFiles']==len(own)
 codehash=hashlib.sha256(canonical(code_manifest(manifest))).hexdigest()
 steps=raw['steps'];assert isinstance(steps,list) and steps
 latest={};successes=Counter();logs=set()
 for index,step in enumerate(steps):
  name=step['name'];assert name in CHECK_NAMES,'Unexpected QA stage: '+name
  assert step['sourceUnchanged'] is True and step['sourceCodeBefore']==step['sourceCodeAfter']==fingerprint,'QA source drift: '+name
  assert type(step['exitCode']) is int and step['startedAt'] and step['finishedAt']
  path=PurePosixPath(step['log']);assert path.is_absolute()
  assert re.fullmatch(re.escape(name)+r'-[1-9]\d*\.log',path.name),'Invalid raw QA log: '+name
  assert path.name not in logs,'Duplicate raw QA log';logs.add(path.name)
  assert re.fullmatch(r'[a-f0-9]{64}',step['logSha256'])
  if step['exitCode']==0:successes[name]+=1
  latest[name]=(index,step)
 assert set(latest)==CHECK_NAMES,'Missing final QA stage'
 # Failed attempts remain in raw evidence. The runner skips successful stages,
 # so exactly one successful final attempt is required for every stage.
 assert all(successes[name]==1 and latest[name][1]['exitCode']==0 for name in CHECK_NAMES),'Missing successful final QA'
 return {name:{'exitCode':0,'sourceCodeSha256':codehash,'logSha256':step['logSha256'],
  'rawSourceFingerprint':fingerprint,'rawStepIndex':index,'rawLogName':PurePosixPath(step['log']).name}
  for name,(index,step) in latest.items()}
def verify_raw_build(proof,fingerprint,server,frontend,logsha):
 assert proof['sourceCodeSha256']==fingerprint and proof['sourceUnchanged'] is True
 assert proof['buildExitCode']==0 and proof['buildLogSha256']==logsha
 assert proof['serverBundleSha256']==server and proof['frontend']==frontend
 assert proof['frontendFiles']==len(frontend),'QA build artifacts changed'
def verify_raw_ui(proof,fingerprint,server,reports):
 assert proof['passed'] is True and proof['sourceUnchanged'] is True and proof['builtArtifactsUnchanged'] is True
 assert proof['sourceCodeSha256']==fingerprint and proof['serverBundleSha256']==server
 assert set(proof['reports'])==set(reports)==set(UI_REPORTS),'QA UI report set mismatch'
 for name,(content,digest) in reports.items():
  row=proof['reports'][name]
  assert row['passed'] is True and row['sha256']==digest,'QA UI report drift: '+name
  assert PurePosixPath(row['report']).is_absolute()
  for key in ['checks','axe','pages','forms','errors']:assert row[key]==len(content.get(key,[])),name+' '+key
def tree(p):
 assert not any(f.is_symlink() for f in p.rglob('*'))
 return {str(f.relative_to(p)):sha(f) for f in p.rglob('*') if f.is_file()}
def verify_ui(ui,mode):
 assert ui['passed'] is True and ui['syntheticOnly'] is True and ui['mode']==mode
 assert ui['workingStoreAccessed'] is False and ui['invoiceWorkerMocked'] is True
 for k in ['errors','consoleErrors','failedAssets','deniedResponses','externalRequests']:assert ui[k]==[],k
 assert len(ui['checks'])==(12 if mode=='source' else 14)
 assert len(ui['pages'])==184 and len(ui['forms'])==16
 assert len({tuple(p[k] for k in ['engine','role','id','width']) for p in ui['pages']})==184
 assert {p['engine'] for p in ui['pages']}=={'chromium','webkit'}
 assert {p['width'] for p in ui['pages']}=={1440,390}
 assert Counter(p['role'] for p in ui['pages'])=={'director':48,'admin':48,'employee':28,'manager':28,'logistician':28,'driver':4}
 pages={'documents','overview','work','shipments','trips','payments','cabinet-balances','china','invoices','operator','accounts','directories'}
 for engine in ['chromium','webkit']:
  assert {p['id'] for p in ui['pages'] if p['engine']==engine and p['role']=='director'}==pages
  assert sum(f['engine']==engine for f in ui['forms'])==8
  if mode=='built':assert f'{engine}: CSP blocks inline scripts/base replacement; PDF blob download remains available' in ui['checks']
def verify(release,expected):
 r=release.resolve();c=json.loads((r/'config.json').read_text())
 assert sha(r/'config.json')==expected,'Config checksum mismatch'
 assert r.name==c['releaseName'] and c['image']=='artel-crm:'+r.name and c['recoveryImage']==c['image']+'-recovery'
 assert c['rollbackScope']=='same_candidate_code_only_no_old_backend_or_data_restore'
 assert c['backendReusedExactly'] is False and c['realProviderCompletionClaimed'] is False
 assert c['previousServerSha256']!=c['serverBundleSha256']
 for key,name in [('sourceArchiveSha256','source.tar.gz'),('sourceManifestSha256','source-manifest.json'),
  ('sourceProofSha256','source-proof.json'),('bundleManifestSha256','bundle-manifest.json'),
  ('candidateUiManifestSha256','candidate-ui-manifest.json'),('evidenceManifestSha256','evidence-manifest.json'),
  ('baselineSourceManifestSha256','baseline-source-manifest.json'),('taskFilesSha256','task-files.json'),
  ('performancePatchSha256','performance.patch'),('patchProofSha256','patch-proof.json')]:assert sha(r/name)==c[key],'Manifest drift: '+name
 for group in ['smokeScriptHashes','deployHelperHashes','testHelperHashes']:
  for name,digest in c[group].items():assert PurePosixPath(name).name==name and sha(r/name)==digest,'Helper drift: '+name
 evidence=json.loads((r/'evidence-manifest.json').read_text())
 assert tree(r/'evidence')==evidence,'Evidence set/hash drift'
 assert all(PurePosixPath(n).name==n for n in evidence)
 ui_manifest=json.loads((r/'candidate-ui-manifest.json').read_text())
 assert tree(r/'context')==json.loads((r/'bundle-manifest.json').read_text())
 assert tree(r/'context/app-dist')==ui_manifest
 assert sha(r/'context/server-render/production.mjs')==c['serverBundleSha256']
 assert (r/'context/Dockerfile').read_text()==f"FROM {c['previousImageId']}\nCOPY --chown=node:node app-dist /app/app-dist\nCOPY --chown=node:node server-render /app/server-render\nCOPY --chmod=0555 entrypoint.sh /usr/local/bin/artel-entrypoint\n"
 archive={}
 with tarfile.open(r/'source.tar.gz') as tar:
  for member in tar.getmembers():
   p=PurePosixPath(member.name)
   assert member.isfile() and not p.is_absolute() and '..' not in p.parts and member.name not in archive
   assert p.parts[0] not in ['.local','data','node_modules','.git','app-dist','server-render']
   assert p.name not in ['.env','.env.local','.env.production']
   archive[member.name]=hashlib.sha256(tar.extractfile(member).read()).hexdigest()
 assert archive==json.loads((r/'source-manifest.json').read_text())
 baseline=json.loads((r/'baseline-source-manifest.json').read_text())
 assert set(baseline)<=set(archive),'Baseline file removed'
 own=json.loads((r/'task-files.json').read_text());assert own==sorted(set(own))
 assert set(own)==EXPECTED_FILES
 changed=sorted(n for n in archive if archive[n]!=baseline.get(n))
 assert changed==own==sorted(c['allowedChangedFiles']),'Reviewed file set drift'
 assert all(archive[n]==baseline[n] for n in baseline if n not in own),'Unrelated source changed'
 proof=json.loads((r/'source-proof.json').read_text())
 assert proof['changedFiles']==own and proof['baseArchiveSha256']==c['baselineSourceArchiveSha256']
 assert proof['baselineImage']==c['previousImage'] and proof['noBusinessDataIncluded'] is True
 assert proof['sourceFiles']==len(archive),'Source proof count mismatch'
 assert proof['backendSourceUnchanged'] is False and proof['backendBytesUnchanged'] is False
 assert hashlib.sha256(canonical(code_manifest(archive))).hexdigest()==c['sourceCodeSha256']
 proof=json.loads((r/'patch-proof.json').read_text())
 assert proof['exact'] is True and proof['gitApplyCheckExitCode']==proof['gitApplyExitCode']==0
 assert proof['baselineSourceArchiveSha256']==c['baselineSourceArchiveSha256'] and proof['patchSha256']==c['performancePatchSha256']
 assert proof['sourceManifestSha256']==c['sourceManifestSha256']
 assert proof['changedFiles']=={n:archive[n] for n in own} and proof['allSourceFilesChecked']==len(archive)
 checks=json.loads((r/'evidence/checks.json').read_text());receipts=json.loads((r/'evidence/qa-results.json').read_text())
 raw=json.loads((r/'evidence/qa-results-raw.json').read_text())
 before=json.loads((r/'evidence/qa-source-manifest-before.json').read_text());after=json.loads((r/'evidence/qa-source-manifest-after.json').read_text())
 assert receipts==qa_receipts(raw,before,after,archive,baseline,own,c['previousImage']),'Normalized QA receipts differ from raw evidence'
 assert set(checks)==set(receipts)==CHECK_NAMES
 for step in raw['steps']:
  assert sha(r/'evidence'/PurePosixPath(step['log']).name)==step['logSha256'],'Raw QA log drift: '+step['name']
 for name,check in checks.items():
  receipt=receipts[name]
  assert check['exitCode']==receipt['exitCode']==0,name
  assert check['sourceCodeSha256']==receipt['sourceCodeSha256']==c['sourceCodeSha256'],'QA source drift: '+name
  assert check['log']==name+'.log'
  assert sha(r/'evidence'/check['log'])==check['sha256']==receipt['logSha256'],'QA log drift: '+name
  if name in ['api','target','unit','bank-period']:
   log=(r/'evidence'/check['log']).read_text()
   totals={key:[int(n) for n in re.findall(r'^(?:#|ℹ) '+key+r' (\d+)\s*$',log,re.M)] for key in ['tests','pass','fail','cancelled']}
   assert totals['tests'] and all(n>0 for n in totals['tests']),'Missing test summary: '+name
   assert totals['tests']==totals['pass'] and all(n==0 for n in totals['fail']+totals['cancelled'])
   assert len(totals['fail'])==len(totals['tests'])==len(totals['cancelled'])
  elif name=='python':
   log=(r/'evidence'/check['log']).read_text()
   assert re.search(r'^Ran [1-9]\d* tests? in ',log,re.M) and re.search(r'^OK\s*$',log,re.M)
 assert archive['package.json']==baseline['package.json'] and archive['package-lock.json']==baseline['package-lock.json'],'Dependency drift'
 for mode in ['source','built']:verify_ui(json.loads((r/'evidence'/(mode+'-report.json')).read_text()),mode)
 for mode in ['source','built']:
  work=json.loads((r/'evidence'/('work-'+mode+'.json')).read_text());assert work['passed'] and work['synthetic'] and len(work['checks'])==20 and len(work['axe'])==8 and not work['errors'] and not work['externalRequests']
  assert all(not item['violations'] for item in work['axe'])
 for engine in ['chromium','webkit']:
  nav=json.loads((r/'evidence'/('navigation-'+engine+'.json')).read_text());assert len(nav['checks'])==14 and not nav['errors']

 fingerprint=qa_fingerprint(archive)
 verify_raw_build(json.loads((r/'evidence/qa-build-proof-raw.json').read_text()),fingerprint,c['serverBundleSha256'],ui_manifest,receipts['build']['logSha256'])
 verify_raw_ui(json.loads((r/'evidence/qa-ui-proof-raw.json').read_text()),fingerprint,c['serverBundleSha256'],{name:(json.loads((r/'evidence'/file).read_text()),sha(r/'evidence'/file)) for name,file in UI_REPORTS.items()})
 build=json.loads((r/'evidence/build-proof.json').read_text())
 assert build['sourceCodeSha256']==c['sourceCodeSha256'] and build['frontendAndBackendSourceMatchedBaselinePlusReviewedFiles'] is True
 assert build['serverBundleSha256']==c['serverBundleSha256'] and build['lintExitCode']==build['buildExitCode']==0
 assert build['lintLogSha256']==sha(r/'evidence/lint.log') and build['buildLogSha256']==sha(r/'evidence/build.log')
 return {'passed':True,'releaseName':r.name,'configSha256':expected,'sourceFiles':len(archive),'publicFiles':len(ui_manifest),
  'performancePatchExact':True,'backendReusedExactly':False,'realProviderCompletionClaimed':False,'serverOperationsPerformed':False}
if __name__=='__main__':
 p=argparse.ArgumentParser();p.add_argument('release',type=Path);p.add_argument('--config-sha256',required=True);a=p.parse_args()
 print(json.dumps(verify(a.release,a.config_sha256),indent=2))

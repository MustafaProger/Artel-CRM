"""Capture one final production audit; never mutate business data or retry a switch."""
from pathlib import Path
import hashlib
import json
import re
import subprocess


REMOTE_COMMON = r'''
from pathlib import Path
import datetime,fcntl,hashlib,importlib.util,json,os,subprocess
os.umask(0o077)
r=Path('/opt/artel-crm/releases')/EXPECTED['releaseName'];root=r.parent.parent
assert r.resolve().parent==Path('/opt/artel-crm/releases')
out=lambda args:subprocess.check_output(args,text=True,timeout=60).strip()
sha=lambda path:hashlib.sha256(path.read_bytes()).hexdigest()
def read(name):return json.loads((r/name).read_text())
def save(path,value):
    with path.open('x') as f:
        json.dump(value,f,ensure_ascii=False,indent=2);f.write('\n');f.flush();os.fsync(f.fileno())
locks=[]
for path in [root/'.runtime-env.lock',root/'secrets/.runtime-env.lock',root/'.workflow-release.lock']:
    handle=path.open('a');fcntl.flock(handle,fcntl.LOCK_EX|fcntl.LOCK_NB);locks.append(handle)
assert sha(r/'config.json')==EXPECTED['configSha256'],'Frozen config changed'
c=read('config.json');image_proof=read('image-proof.json')
assert c['releaseName']==EXPECTED['releaseName'] and c['image']=='artel-crm:'+EXPECTED['releaseName']
assert image_proof['configSha256']==EXPECTED['configSha256']
expected_image_id=image_proof['images']['image']['id']
assert image_proof['images']['recoveryImage']['id']==expected_image_id
assert c['rollbackScope']=='same_candidate_code_only_no_old_backend_or_data_restore'
assert read('switch-started.json')['configSha256']==EXPECTED['configSha256']
for name,digest in c['deployHelperHashes'].items():assert sha(r/name)==digest,'Frozen helper drift: '+name
def guard():
    assert sha(r/'config.json')==EXPECTED['configSha256']
    lines=[line.split('=',1)[1] for line in (root/'.env').read_text().splitlines() if line.startswith('ARTEL_IMAGE=')]
    assert lines==[c['image']],'Runtime image setting changed'
    container='artel-crm-crm-1'
    assert out(['docker','inspect','--format','{{.Config.Image}}',container])==c['image']
    assert out(['docker','inspect','--format','{{.Image}}',container])==expected_image_id
    assert out(['docker','image','inspect','--format','{{.Id}}',c['image']])==expected_image_id
    assert out(['docker','exec',container,'sha256sum','/app/server-render/production.mjs']).split()[0]==c['serverBundleSha256']
    assert out(['docker','inspect','--format','{{.State.Health.Status}}',container])=='healthy'
    return {'image':c['image'],'imageId':expected_image_id,'containerId':out(['docker','inspect','--format','{{.Id}}',container]),'healthy':True,'restarts':int(out(['docker','inspect','--format','{{.RestartCount}}',container])),'serverBundleSha256':c['serverBundleSha256']}
runtime=guard()
def module(name):
    spec=importlib.util.spec_from_file_location(name,r/(name+'.py'));value=importlib.util.module_from_spec(spec);spec.loader.exec_module(value);return value
def evidence_hashes():
    names=['config.json','before-state.json','before-operations.private.json','after-ui-state.json','after-ui-operations.private.json','after-ui-preservation.json','after-ui-independent-classification.json','performance-production-ui-proof.json','image-proof.json','compatibility-proof.json','static-read-proof.json','public-proof.json']
    # Preserve the first switch audit as evidence even when it failed before
    # metadata was written. The final capture must never silently replace it.
    names+=['switch-started.json']
    names += [name for name in ['after-state.json','after-operations.private.json','after-preservation.json','after-independent-classification.json','switch-service-result.json','switch-recovery-result.json'] if (r/name).exists()]
    for phase in ['before','after','after-ui']:
        name=phase+'-worker-bridge-auth.private.json'
        if (r/name).exists():names.append(name)
    return {name:sha(r/name) for name in names}
def preservation_result(classified):
    before=read('before-operations.private.json')['data'];after=read('after-ui-operations.private.json')['data']
    keys={'snapshot','manifest','prepared','binding','grant','history','previousBinding','observedSignature','vehicleCorrection','autoAuthorization','authorization','signing','executeAttempted','executeAttemptedAt','writeAttempts','directDraftCreation','filenameCorrection','nativeAdoptionEvidence','nativeSenderAmendment'}
    def protected(value,path=()):
        result={}
        if isinstance(value,dict):
            for key,child in value.items():
                if key in keys:result[path+(key,)]=child
                else:result.update(protected(child,path+(key,)))
        elif isinstance(value,list):
            for index,child in enumerate(value):result.update(protected(child,path+(str(index),)))
        return result
    old=protected({k:before.get(k) for k in ['saby','etrn','tripSaby']});new=protected({k:after.get(k) for k in ['saby','etrn','tripSaby']})
    changed=[key for key,value in old.items() if key not in new or new[key]!=value]
    added=set(new)-set(old)
    protected_result={'checkedProtectedRecords':len(old),'oldProtectedRecordsExact':not changed,'changedCount':len(changed),'addedCount':len(added),'allProtectedRecordsExact':not changed and not added}
    # Compare old bank rows exactly, retaining additions as separate evidence.
    # Do not hide changed timestamps or other properties inside existing rows.
    bank_arrays=[];bank_issues=[]
    def banks(left,right,path):
        if isinstance(left,dict):
            other=right if isinstance(right,dict) else {}
            for key,value in left.items():banks(value,other.get(key),path+'/'+key)
        elif isinstance(left,list):
            if not left:return
            stable=next((key for key in ['id','date'] if all(isinstance(row,dict) and isinstance(row.get(key),str) and row[key] for row in left)),None)
            if not stable:return
            other=right if isinstance(right,list) else []
            if not all(isinstance(row,dict) and isinstance(row.get(stable),str) for row in other):
                bank_issues.append({'pathHash':hashlib.sha256(path.encode()).hexdigest(),'reason':'changed_record_shape'});return
            old_rows={row[stable]:row for row in left};new_rows={row[stable]:row for row in other}
            if len(old_rows)!=len(left) or len(new_rows)!=len(other):
                bank_issues.append({'pathHash':hashlib.sha256(path.encode()).hexdigest(),'reason':'duplicate_stable_identifier'});return
            removed=set(old_rows)-set(new_rows);modified={key for key in set(old_rows)&set(new_rows) if old_rows[key]!=new_rows[key]}
            bank_arrays.append({'pathHash':hashlib.sha256(path.encode()).hexdigest(),'stableKey':stable,'beforeCount':len(left),'afterCount':len(other),'removed':len(removed),'modified':len(modified),'added':len(set(new_rows)-set(old_rows))})
    for key in ['banking','sber','sberArtel']:banks(before.get(key),after.get(key),key)
    bank_exact=not bank_issues and all(row['removed']==0 and row['modified']==0 for row in bank_arrays)
    facts=classified['exactFacts'];accounts_exact=classified['accountsBusinessFactsExcludingSessionActivityUnchanged']
    fact_drift=[key for key,value in facts.items() if not value and not (key=='accounts' and accounts_exact)]
    b=read('before-state.json');a=read('after-ui-state.json')
    worker_changes=sorted(name for name in set(b['workerFiles'])|set(a['workerFiles']) if b['workerFiles'].get(name)!=a['workerFiles'].get(name))
    journal='one-c-browser-print/executor-coordination.sqlite-journal';database=journal.removesuffix('-journal')
    database_present=database in b['workerFiles'] and database in a['workerFiles']
    database_exact=database_present and b['workerFiles'][database]==a['workerFiles'][database]
    persistent_exact=all(name in ['crm-bridge/auth.json',journal] for name in worker_changes) and (journal not in worker_changes or database_exact)
    worker={'workerFilesExact':not worker_changes,'workerNonBridgeFilesUnchanged':classified['workerNonBridgeFilesUnchanged'],'workerPersistentFilesExact':persistent_exact,'sqliteJournalChanged':journal in worker_changes,'sqliteDatabaseExact':database_exact,'journalExceptionApplied':journal in worker_changes and persistent_exact,'changedFileCount':len(worker_changes),'note':'A changed transient SQLite journal is reported separately; this does not establish byte-for-byte preservation of all worker runtime files.'}
    y=json.loads((root/'data/operations/yandex-balance.json').read_text())
    yandex={'timerActive':out(['systemctl','is-active','artel-yandex-balance.timer'])=='active','browserHealthy':out(['docker','inspect','--format','{{.State.Health.Status}}','artel-yandex-browser'])=='healthy','browserRestarts':int(out(['docker','inspect','--format','{{.RestartCount}}','artel-yandex-browser'])),'state':y.get('state'),'lastSuccessAt':y.get('lastSuccessAt')}
    ui=read('performance-production-ui-proof.json')
    ui_verified=ui.get('verified') is True
    compat=read('compatibility-proof.json');static=read('static-read-proof.json');public=read('public-proof.json')
    deployment_checks=compat['passed'] and compat['fullDataExact'] and compat['externalRequests']==0 and compat['configSha256']==EXPECTED['configSha256'] and static['passed'] and static['configSha256']==EXPECTED['configSha256'] and all(all(item['checks'].values()) for item in image_proof['images'].values()) and public['image']==c['image'] and public['securityHeadersVerifiedForEveryResponse'] and public['privateValueScanPassed']
    invariants={'documentArchiveExact':before.get('documentArchive')==after.get('documentArchive'),'businessFactsExact':not fact_drift,'oldBankRecordsExact':bank_exact,'protectedSabyExact':protected_result['allProtectedRecordsExact'],'revisionNotRewound':classified['revisionNotRewound'],'protectedFilesUnchanged':classified['protectedFilesUnchanged'],'otherServicesUnchanged':classified['otherServicesUnchanged'],'workerContainerUnchanged':classified['workerContainerUnchanged'],'workerPersistentFilesExact':persistent_exact,'workerBridgeReviewed':classified['workerBridgeAuth'].get('available') is True and classified['workerBridgeAuth']['unexplainedChanges']==0,'yandexTimerActive':yandex['timerActive'],'yandexBrowserHealthy':yandex['browserHealthy'],'yandexConnected':yandex['state']=='connected','runtimeNoRestarts':runtime['restarts']==0,'deploymentChecksPassed':bool(deployment_checks),'authenticatedProductionUiVerified':ui_verified}
    task_passed=all(invariants.values())
    raw=read('after-ui-preservation.json')
    global_reviewed=bool(classified['allReviewedInvariantsPassed'] and raw['unexplainedChanges']==0 and classified['classifiedCrmUnexplainedChanges']==0 and not worker['journalExceptionApplied'] and task_passed)
    prior={}
    for name in ['after-preservation.json','after-independent-classification.json','switch-service-result.json','switch-recovery-result.json']:
        if (r/name).exists():
            value=read(name)
            keys=['strictDataEqual','rawStrictDataEqual','unexplainedChanges','rawUnexplainedChanges','checks','protectedFilesUnchanged','workerFilesUnchanged','workerNonBridgeFilesUnchanged','otherServicesUnchanged','workflowDocumentsAndAuthorizationUnchanged','revisionNotRewound','classifiedCrmUnexplainedChanges','crmBusinessFactsPreserved','allReviewedInvariantsPassed','reviewedBusinessInvariantsPreserved','taskPassed','globalReviewed','dataRestored','oldBackendRestored','automaticRetryForbidden']
            prior[name]={key:value[key] for key in keys if key in value}
    raw_flags={key:value for key,value in raw.items() if isinstance(value,bool)}
    return {'rawBooleanFlags':raw_flags,'rawChecks':raw['checks'],'classifiedAllReviewedInvariantsPassed':classified['allReviewedInvariantsPassed'],'priorAuditResults':prior,'taskPassed':task_passed,'globalReviewed':global_reviewed,'preservationReviewRequired':not all(value for key,value in invariants.items() if key not in ['authenticatedProductionUiVerified','deploymentChecksPassed','runtimeNoRestarts']) or not global_reviewed,'targetInvariants':invariants,'failedTargetInvariants':[key for key,value in invariants.items() if not value],'factCollections':facts,'businessFactDrift':fact_drift,'accountsBusinessExact':accounts_exact,'oldBankRecordsExact':bank_exact,'bankArrays':bank_arrays,'bankIssues':bank_issues,'protectedSaby':protected_result,'protectedFilesUnchanged':classified['protectedFilesUnchanged'],'otherServicesUnchanged':classified['otherServicesUnchanged'],'workerContainerUnchanged':classified['workerContainerUnchanged'],'workerNonBridgeFilesUnchanged':classified['workerNonBridgeFilesUnchanged'],'workerFileReview':worker,'workerBridge':classified['workerBridgeAuth'],'yandex':yandex,'authenticatedProductionUiVerified':ui_verified,'deploymentChecksPassed':bool(deployment_checks),'rawStrictDataEqual':raw['strictDataEqual'],'rawUnexplainedChanges':raw['unexplainedChanges'],'classifiedUnexplainedChanges':classified['classifiedCrmUnexplainedChanges'],'businessChangeAttribution':'No business-fact changes are automatically attributed or excused.'}
'''


def context():
    home=Path(__file__).resolve().parent
    prepared=json.loads((home/'prepared.json').read_text())
    assert re.fullmatch(r'20261029-documents-[a-z0-9-]+',prepared['releaseName']), 'Unexpected release name'
    assert re.fullmatch(r'[0-9a-f]{64}',prepared['configSha256'])
    expected={key:prepared[key] for key in ['releaseName','configSha256']}
    expected['auditImplementationSha256']={name:hashlib.sha256((home/name).read_bytes()).hexdigest() for name in ['final-audit.py','finalize.py']}
    return home,expected


def prefix(expected):
    return 'EXPECTED='+repr(expected)+'\n'+REMOTE_COMMON


def run_remote(home,code,stem):
    # Re-running can never overwrite previously captured local evidence.
    assert not (home/(stem+'.log')).exists(),'Audit was already attempted; inspect existing evidence'
    # Create the attempt log before SSH so an interrupted connection cannot be
    # mistaken for an unattempted remote action. Inspect, never retry blindly.
    with (home/(stem+'.log')).open('x') as f:
        f.write('Attempt started; remote outcome may be unknown until reconciled.\n');f.flush()
        result=subprocess.run(['ssh','-B','en0','-o','BatchMode=yes','-o','ConnectTimeout=12','root@130.49.151.239','python3 -'],input=code,text=True,capture_output=True)
        f.write(result.stdout+result.stderr)
    if result.returncode:
        print(result.stderr[-3000:]);raise SystemExit(result.returncode)
    return json.loads(result.stdout)


def main():
    home,expected=context()
    proof_path=home/'production-ui-proof.json'
    assert proof_path.exists(),'Supply the current activation UI proof before attempting final capture'
    ui=json.loads(proof_path.read_text())
    assert ui.get('releaseName')==expected['releaseName'] and ui.get('configSha256')==expected['configSha256'],'UI proof belongs to another package'
    assert ui.get('image')=='artel-crm:'+expected['releaseName'],'UI image differs from this candidate'
    assert isinstance(ui.get('verified'),bool),'UI verified must be an explicit boolean'
    if ui['verified']:
        assert ui.get('readOnly') is True and ui.get('reloadAuthenticated') is True
        assert type(ui.get('businessActionsByAgent')) is int and ui['businessActionsByAgent']==0 and ui.get('consoleErrors')==[]
        assert isinstance(ui.get('at'),str) and ui['at'] and isinstance(ui.get('browser'),str) and ui['browser']
        assert isinstance(ui.get('pages'),list) and ui['pages'] and all(isinstance(page,str) and page for page in ui['pages'])
    else:
        assert isinstance(ui.get('reason'),str) and ui['reason'],'An unverified UI result needs an explicit reason'
    code=prefix(expected)+'\nUI='+repr(ui)+r'''
assert not any((r/name).exists() for name in ['after-ui-state.json','after-ui-operations.private.json','after-ui-preservation.json','after-ui-independent-classification.json','final-result.json','performance-production-ui-proof.json','performance-worker-file-review.json']),'After-UI capture already exists; do not capture twice or overwrite evidence'
assert UI['releaseName']==c['releaseName'] and UI['configSha256']==EXPECTED['configSha256'] and UI['image']==c['image']
if UI.get('verified') is True:
    at=datetime.datetime.fromisoformat(UI['at'].replace('Z','+00:00'))
    switched=datetime.datetime.fromisoformat(read('switch-started.json')['at'].replace('Z','+00:00'))
    assert at.tzinfo is not None and switched.tzinfo is not None,'UI timestamps must include timezone'
    assert switched<=at<=datetime.datetime.now(datetime.timezone.utc),'UI proof does not belong to this activation'
save(r/'performance-production-ui-proof.json',UI)
state=module('release-state');classification=module('classify-release')
state.capture(r,'after-ui');state.compare(r,'after-ui')
classified=classification.compare_phase(r,'after-ui','artel-crm-crm-1')
save(r/'after-ui-independent-classification.json',classified)
summary={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'releaseName':c['releaseName'],'configSha256':EXPECTED['configSha256'],**runtime,**preservation_result(classified),'inputSha256':evidence_hashes(),'rawEvidenceRetained':True,'auditImplementationSha256':EXPECTED['auditImplementationSha256']}
assert guard()==runtime,'Runtime changed during final capture'
save(r/'performance-worker-file-review.json',summary['workerFileReview'])
save(r/'final-result.json',summary)
print(json.dumps(summary,ensure_ascii=False))
'''
    summary=run_remote(home,code,'final-audit')
    with (home/'final-result.json').open('x') as f:json.dump(summary,f,ensure_ascii=False,indent=2)
    print(json.dumps({key:value for key,value in summary.items() if key not in ['bankArrays','workerBridge','inputSha256']},ensure_ascii=False,indent=2))


if __name__=='__main__':main()

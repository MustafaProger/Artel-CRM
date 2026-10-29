"""Finalize only release metadata for the exact running candidate; never switch or restore."""
from pathlib import Path
import importlib.util
import json


def main():
    home=Path(__file__).resolve().parent
    spec=importlib.util.spec_from_file_location('performance_final_audit',home/'final-audit.py')
    audit=importlib.util.module_from_spec(spec);spec.loader.exec_module(audit)
    _,expected=audit.context()
    code=audit.prefix(expected)+r'''
summary=read('final-result.json');classified=read('after-ui-independent-classification.json')
assert summary['releaseName']==c['releaseName'] and summary['configSha256']==EXPECTED['configSha256']
assert all(summary[key]==runtime[key] for key in runtime),'Running candidate differs from final audit'
assert evidence_hashes()==summary['inputSha256'],'Saved final audit evidence changed'
assert summary['rawEvidenceRetained'] is True
assert summary['auditImplementationSha256']==EXPECTED['auditImplementationSha256'],'Audit implementation changed since final capture'
assert read('performance-worker-file-review.json')==summary['workerFileReview'],'Worker review evidence changed'
# Re-evaluate the saved invariants and current Yandex availability. Never upgrade
# a failed audit or explain business changes through an unrelated old supplement.
fresh=preservation_result(classified)
for key in ['testTaskScope','taskPassed','globalReviewed','preservationReviewRequired','targetInvariants','factCollections','businessFactDrift','accountsBusinessExact','oldBankRecordsExact','protectedSaby','workerFileReview','rawUnexplainedChanges','classifiedUnexplainedChanges','rawStrictDataEqual','rawBooleanFlags','rawChecks','classifiedAllReviewedInvariantsPassed','priorAuditResults']:
    assert fresh[key]==summary[key],'Final audit conditions changed: '+key
assert not summary['businessFactDrift'] or (not summary['taskPassed'] and summary['preservationReviewRequired'])
assert not (r/'performance-finalization.json').exists(),'Finalization already attempted; inspect metadata without overwriting evidence'
metadata_paths=[r/'release.json',root/'release.json'];metadata=[]
for path in metadata_paths:
    current=json.loads(path.read_text()) if path.exists() else c.copy()
    if current.get('image')==c['previousImage']:
        assert path==root/'release.json' and (r/'switch-started.json').exists()
        current=c.copy()
    assert current.get('image')==c['image'],'Metadata belongs to another release'
    if 'releaseName' in current:assert current['releaseName']==c['releaseName']
    current.update(imageId=expected_image_id,updatedAt=datetime.datetime.now(datetime.timezone.utc).isoformat(),finalClassificationPending=False,authenticatedProductionUiVerified=summary['authenticatedProductionUiVerified'],finalResult=str(r/'final-result.json'),finalResultSha256=sha(r/'final-result.json'),preservationAudit=str(r/'after-ui-preservation.json'),strictDataEqual=summary['rawStrictDataEqual'],unexplainedChanges=summary['rawUnexplainedChanges'],independentClassification=str(r/'after-ui-independent-classification.json'),taskPassed=summary['taskPassed'],globalReviewed=summary['globalReviewed'],preservationReviewRequired=summary['preservationReviewRequired'],deploymentChecksPassed=summary['deploymentChecksPassed'],providerCompletionClaimed=False,rawEvidenceRetained=True,rawBooleanFlags=summary['rawBooleanFlags'],rawChecks=summary['rawChecks'],classifiedAllReviewedInvariantsPassed=summary['classifiedAllReviewedInvariantsPassed'],workerFileReview=str(r/'performance-worker-file-review.json'))
    metadata.append((path,current))
assert guard()==runtime
receipt={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'image':c['image'],'imageId':expected_image_id,'configSha256':EXPECTED['configSha256'],'finalResultSha256':sha(r/'final-result.json'),'taskPassed':summary['taskPassed'],'globalReviewed':summary['globalReviewed'],'preservationReviewRequired':summary['preservationReviewRequired'],'authenticatedProductionUiVerified':summary['authenticatedProductionUiVerified'],'metadataOnly':True,'dataRestored':False,'oldBackendRestored':False,'switchRepeated':False,'rawEvidenceRetained':True,'writeIntent':True}
save(r/'performance-finalization.json',receipt)
# Atomic per-file writes, with a saved write intent. Any partial failure requires
# reconciliation; this script deliberately refuses an automatic repeat.
for path,value in metadata:
    temporary=path.with_name(path.name+'.performance-final-'+str(os.getpid())+'.tmp')
    save(temporary,value);os.replace(temporary,path)
    directory=os.open(str(path.parent),os.O_DIRECTORY)
    try:os.fsync(directory)
    finally:os.close(directory)
assert guard()==runtime
save(r/'performance-finalization-completed.json',{**receipt,'writeIntent':False,'metadataWritten':True})
print(json.dumps({**receipt,'writeIntent':False,'metadataWritten':True},ensure_ascii=False))
'''
    result=audit.run_remote(home,code,'finalize')
    with (home/'performance-finalization-completed.json').open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2)
    print(json.dumps(result,ensure_ascii=False,indent=2))


if __name__=='__main__':main()

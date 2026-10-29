"""Review the frozen before/after-UI evidence without replacing any audit flags."""
from pathlib import Path
import json,hashlib,os,datetime
r=Path('/opt/artel-crm/releases/20261029-work-storage-56e53136')
sha=lambda p:hashlib.sha256(p.read_bytes()).hexdigest()
b=json.loads((r/'before-operations.private.json').read_text())['data'];a=json.loads((r/'after-ui-operations.private.json').read_text())['data']
result={'at':datetime.datetime.now(datetime.timezone.utc).isoformat(),'sourceHashes':{n:sha(r/n) for n in ['before-operations.private.json','after-ui-operations.private.json','final-result.json']},'rawFlagsUnchanged':True,'globalReviewed':False,'businessInitiatorEstablished':False,'records':{}}
for key in ['tripRequests','tripRequestCreates','driverTripProgress']:
 left=b[key];right=a[key]
 result['records'][key]={'oldCount':len(left),'newCount':len(right),'removed':len(set(left)-set(right)),'modified':sum(v!=right.get(k) for k,v in left.items() if k in right),'added':len(set(right)-set(left)),'oldRecordsExact':all(k in right and v==right[k] for k,v in left.items())}
banks=[]
def compare(left,right,path):
 if isinstance(left,dict):
  for k,v in left.items():compare(v,(right or {}).get(k),path+'/'+k)
 elif isinstance(left,list) and left:
  stable=next((k for k in ['id','date'] if all(isinstance(v,dict) and isinstance(v.get(k),str) for v in left)),None)
  if not stable:return
  old={v[stable]:v for v in left};new={v[stable]:v for v in (right or [])}
  assert len(old)==len(left) and len(new)==len(right or [])
  changes={}
  for k in set(old)&set(new):
   for field in set(old[k])|set(new[k]):
    if old[k].get(field)!=new[k].get(field):changes[field]=changes.get(field,0)+1
  banks.append({'path':path,'oldCount':len(old),'newCount':len(new),'removed':len(set(old)-set(new)),'added':len(set(new)-set(old)),'changedFieldCounts':changes,'oldPayloadExactExcludingSyncTimes':not(set(old)-set(new)) and set(changes)<={'updatedAt','syncedAt'}})
for key in ['banking','sber','sberArtel']:compare(b[key],a[key],key)
result['banks']=banks
result['allOldBankPayloadExactExcludingSyncTimes']=all(x['oldPayloadExactExcludingSyncTimes'] for x in banks)
result['documentArchiveExact']=b.get('documentArchive')==a.get('documentArchive')
result['remainingReview']=['Work: new note and existing task version/update time changed; do not infer physical actor from account identity.','Worker: jobs.json changed and one revoked session was added; old revocations retained, identity material unchanged per classifier. Full worker runtime preservation not established.','Other runtime/Saby observations remain in raw audit; protected Saby records are exact.']
os.umask(0o077)
p=r/'post-ui-review-supplement.json'
with p.open('x') as f:json.dump(result,f,ensure_ascii=False,indent=2);f.flush();os.fsync(f.fileno())
print(json.dumps(result,ensure_ascii=False))

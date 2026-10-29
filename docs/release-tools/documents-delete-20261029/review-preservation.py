from pathlib import Path
import subprocess,json
h=Path(__file__).resolve().parent;m=json.load(open(h/'prepared.json'))
code='release='+repr(m['releaseName'])+r'''
from pathlib import Path
import json,hashlib
r=Path('/opt/artel-crm/releases')/release
b=json.loads((r/'before-operations.private.json').read_text())['data'];a=json.loads((r/'after-ui-operations.private.json').read_text())['data']
def differences(x,y,path=''):
 if type(x)!=type(y):return [path]
 if isinstance(x,dict):return [p for k in set(x)|set(y) for p in (differences(x[k],y[k],path+'/'+k) if k in x and k in y else [path+'/'+k])]
 if isinstance(x,list):return [] if x==y else [path+'[]']
 return [] if x==y else [path]
result={}
def index(v):return {x['id']:x for x in v} if isinstance(v,list) else v
for name in ['shipments','work','driverTripProgress']:
 left=b.get(name,{});right=a.get(name,{})
 if name=='work':
  left={k:index(v) for k,v in left.items()};right={k:index(v) for k,v in right.items()}
  result[name]={key:{'removed':len(set(left.get(key,{}))-set(right.get(key,{}))),'added':len(set(right.get(key,{}))-set(left.get(key,{}))),'changed':[{'idHash':hashlib.sha256(i.encode()).hexdigest()[:12],'fields':differences(left[key][i],right[key][i])} for i in set(left.get(key,{}))&set(right.get(key,{})) if left[key][i]!=right[key][i]]} for key in ['tasks','companyRecords','notes']}
 else:
  result[name]={'removed':len(set(left)-set(right)),'added':len(set(right)-set(left)),'changed':[{'idHash':hashlib.sha256(i.encode()).hexdigest()[:12],'fields':differences(left[i],right[i])} for i in set(left)&set(right) if left[i]!=right[i]]}
arrays=[]
def walk(x,y,path=''):
 if isinstance(x,dict):
  for k,v in x.items():walk(v,y.get(k) if isinstance(y,dict) else None,path+'/'+k)
 elif isinstance(x,list) and x and all(isinstance(v,dict) for v in x):
  stable='id' if all('id' in v for v in x) else 'date' if all('date' in v for v in x) else None
  if not stable:return
  yy={v[stable]:v for v in (y or [])};changed=[]
  for row in x:
   if row[stable] in yy and row!=yy[row[stable]]:changed.append(differences(row,yy[row[stable]]))
  clean=lambda v:{k:w for k,w in v.items() if k not in ['updatedAt','syncedAt']}
  arrays.append({'key':stable,'before':len(x),'after':len(y or []),'removed':sum(v[stable] not in yy for v in x),'businessModified':sum(v[stable] in yy and clean(v)!=clean(yy[v[stable]]) for v in x),'modifiedFields':changed})
for key in ['banking','sber','sberArtel']:walk(b.get(key),a.get(key),key)
result['banks']=arrays;result['documentArchiveExact']=b.get('documentArchive')==a.get('documentArchive')
result['scope']='Read-only comparison of saved before and after-UI snapshots; no attribution of external actions'
print(json.dumps(result))
'''
r=subprocess.run(['ssh','-B','en0','root@130.49.151.239','python3 -'],input=code,text=True,capture_output=True);
if r.returncode:print(r.stderr[-1200:]);raise SystemExit(r.returncode)
v=json.loads(r.stdout);(h/'preservation-detail.json').write_text(json.dumps(v,indent=2));print(json.dumps(v,indent=2))

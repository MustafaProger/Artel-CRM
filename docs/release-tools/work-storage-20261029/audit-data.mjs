// Exact saved snapshots; no network, store writes, credentials or raw values in output.
import fs from 'node:fs';
import crypto from 'node:crypto';
const {before,after}=JSON.parse(fs.readFileSync(0,'utf8'));
const sha=v=>crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');
for(const e of [before,after])if(sha(e.data)!==e.sha256)throw Error('Store checksum mismatch');
const canonical=v=>Array.isArray(v)?v.map(canonical):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,canonical(v[k])])):v;
const eq=(a,b)=>JSON.stringify(canonical(a))===JSON.stringify(canonical(b));
const hash=v=>v===undefined?null:sha(canonical(v));
const keys=['shipments','companies','directories','paymentAllocations','accounts','china','work','operator','tripNumbers','tripCreateRequests','tripRequests','tripRequestCreates','driverTripProgress','tripExecutions'];
const facts=Object.fromEntries(keys.map(k=>[k,eq(before.data[k],after.data[k])]));
const protectedWorkflows=d=>{
 const x=structuredClone({tripSaby:d.tripSaby,etrn:d.etrn});
 const omit=(v,keys)=>{if(v)for(const key of keys)delete v[key];};
 for(const r of Object.values(x.tripSaby?.trips??{})){
  omit(r,['updatedAt','lastCheckedAt','lastCheckAttemptAt','leaseId','leaseUntil']);
  omit(r.carrierFill,['checkedAt']);omit(r.carrierEvidence,['confirmedAt']);
 }
 for(const r of Object.values(x.etrn?.trips??{})){
  omit(r,['updatedAt']);omit(r.direct,['updatedAt','lastCheckAttemptAt','lastCheckedAt','leaseId','leaseUntil']);
  for(const row of Object.values(r.deliveries??{})){
   omit(row,['updatedAt']);omit(row.document,['updatedAt','leaseId','leaseUntil']);
  }
 }
 return x;
};
const normalizedBanks=d=>{
 const result=structuredClone({banking:d.banking,sber:d.sber,sberArtel:d.sberArtel});
 const walk=(v)=>{
  if(!v||typeof v!=='object')return;
  for(const key of ['updatedAt','syncedAt','lastSuccessAt','lastScheduledAt','lastAttemptAt','requestNotBefore','lastCompletedPeriod','lease','job'])delete v[key];
  if(Array.isArray(v)&&v.every(x=>x&&typeof x.id==='string'))v.sort((a,b)=>a.id.localeCompare(b.id));
  for(const child of Object.values(v))walk(child);
 };walk(result);return result;
};
const diffs=[];
const safe=k=>/^[a-zA-Z][a-zA-Z0-9_]{0,35}$/.test(k)||/^\d+$/.test(k)?k:'#'+sha(k).slice(0,12);
function classify(path) {
 if(path==='revision')return 'revision';
 if(path==='push/lastRunAt')return 'scheduler';
 if(/^accounts\/(sessions|attempts)(\/|$)/.test(path))return 'auth_session_activity';
 if(/^(banking|sber|sberArtel)\//.test(path)&&/\/(updatedAt|syncedAt|lastSuccessAt|lastScheduledAt|lastAttemptAt|requestNotBefore|lastCompletedPeriod)$/.test(path))return 'bank_poll';
 if(/^tripSaby\/trips\/[^/]+\/(updatedAt|lastCheckedAt|lastCheckAttemptAt|leaseId|leaseUntil|carrierFill\/checkedAt|carrierEvidence\/confirmedAt)$/.test(path))return 'workflow_poll';
 if(/^etrn\/trips\/[^/]+\/(updatedAt|direct\/(updatedAt|lastCheckAttemptAt|lastCheckedAt|leaseId|leaseUntil)|deliveries\/[^/]+\/(updatedAt|document\/(updatedAt|leaseId|leaseUntil)))$/.test(path))return 'workflow_poll';
 if(/^cabinets\/connections\//.test(path)&&/\/(lastAttemptAt|lastSuccessAt|sourceUpdatedAt)$/.test(path))return 'cabinet_poll';
 return 'requires_review';
}
function walk(a,b,p=''){
 if(eq(a,b))return;
 if(a&&b&&typeof a==='object'&&typeof b==='object'&&Array.isArray(a)===Array.isArray(b)){
  if(/^(banking|sber|sberArtel)\//.test(p)&&Array.isArray(a)&&Array.isArray(b)&&[...a,...b].every(x=>x&&typeof x.id==='string')){
   const aa=Object.fromEntries(a.map(x=>[x.id,x])),bb=Object.fromEntries(b.map(x=>[x.id,x]));return walk(aa,bb,p);
  }
  for(const k of new Set([...Object.keys(a),...Object.keys(b)]))walk(a[k],b[k],p?p+'/'+safe(k):safe(k));
 }else diffs.push({path:p,beforeHash:hash(a),afterHash:hash(b),classification:classify(p)});
}
walk(before.data,after.data);
const checks={facts,workflowDocumentsAndAuthorizationUnchanged:eq(protectedWorkflows(before.data),protectedWorkflows(after.data)),bankDataExceptPollingUnchanged:eq(normalizedBanks(before.data),normalizedBanks(after.data)),revisionNotRewound:after.data.revision>=before.data.revision};
const protectedTripId='shipment-trip-20d93bd0-7538-4160-a468-e3393f31b9f0';
checks.trip27PresentInBaseline=Boolean(before.data.etrn?.trips?.[protectedTripId]);
checks.trip27EtrnExact=eq(before.data.etrn?.trips?.[protectedTripId],after.data.etrn?.trips?.[protectedTripId]);
checks.trip27SabyExact=eq(before.data.tripSaby?.trips?.[protectedTripId],after.data.tripSaby?.trips?.[protectedTripId]);
console.log(JSON.stringify({checksumVerified:true,strictDataEqual:eq(before.data,after.data),checks,differences:diffs,unexplainedChanges:diffs.filter(x=>x.classification==='requires_review').length},null,2));

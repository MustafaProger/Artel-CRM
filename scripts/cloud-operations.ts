/** One-off maintenance. Never imported by application startup or build. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { get, put } from '@vercel/blob';
import { loadSnapshot } from '../server/local-api';
import { decodeOperations, encodeOperations } from '../server/operations-store';
import { currentSnapshot } from '../server/shipment-operations';
import { clearOperations } from '../server/reset-operations';

const [mode,folder]=process.argv.slice(2);
const target=process.env.ARTEL_MAINTENANCE_TARGET;
if(!target || new URL(target).origin!==target || !target.startsWith('https://') || process.env.VERCEL_ENV!=='production')throw new Error('Set ARTEL_MAINTENANCE_TARGET to the verified HTTPS production origin and VERCEL_ENV=production.');
if(!['plan','apply','restore','restore-check','verify'].includes(mode))throw new Error('Choose plan, apply, verify, restore-check or restore.');
if(!process.env.BLOB_READ_WRITE_TOKEN)throw new Error('The production Blob credential is required.');
const pathname='artel/operations.json';
const base=await loadSnapshot(resolve('data/local-xlsx-final'));
const sha=(value:string)=>createHash('sha256').update(value).digest('hex');
const load=async()=>{const r=await get(pathname,{access:'private',useCache:false,headers:{'Accept-Encoding':'identity'}});if(!r || r.statusCode!==200 || !r.stream || !r.blob.etag || r.blob.etag.startsWith('W/'))throw new Error('Expected existing private operations Blob.');return {raw:await new Response(r.stream).text(),etag:r.blob.etag};};
const projection=(snapshot:ReturnType<typeof currentSnapshot>)=>({
  shipments:snapshot.shipments.map(s=>[s.id,s.date,s.customerId,s.supplierId,s.liters,s.revenue,s.cost]).sort(),
  payments:snapshot.payments.map(p=>[p.id,p.date,p.counterpartyId,p.incoming,p.outgoing]).sort(),
  stocks:snapshot.stocks.map(s=>[s.id,s.balanceLiters,s.balanceAmount]).sort(),
});
const retained=(data:ReturnType<typeof decodeOperations>)=>({
  accounts:data.accounts,work:data.work,
  companies:currentSnapshot(base,data).companies.map(({shipmentIds:_s,paymentIds:_p,managerLabels:_m,flags:_f,...company})=>company).sort((a,b)=>a.id.localeCompare(b.id)),
  directories:(({duplicates:_d,...directories})=>directories)(currentSnapshot(base,data).directories!),
});
const directory=resolve(folder||`qa/cloud-reset-${new Date().toISOString().replace(/[:.]/g,'-')}`);
await mkdir(directory,{recursive:true,mode:0o700});
const state=await load(), data=decodeOperations(state.raw,base.provenance.sourceSha256);
if(mode==='plan'){
  const response=await fetch(target+'/api/snapshot',{cache:'no-store'});
  if(!response.ok)throw new Error('Cannot verify target snapshot. Supply a verified maintenance workflow for an authenticated deployment.');
  const deployed=await response.json();
  if(deployed.provenance.sourceSha256!==base.provenance.sourceSha256 || JSON.stringify(projection(deployed))!==JSON.stringify(projection(currentSnapshot(base,data))))throw new Error('The target data does not match this Blob. No mutation performed.');
  await writeFile(resolve(directory,'operations-before.json'),state.raw,{mode:0o600,flag:'wx'});
  const backup=await readFile(resolve(directory,'operations-before.json'),'utf8');
  decodeOperations(backup,base.provenance.sourceSha256);
  if(sha(backup)!==sha(state.raw))throw new Error('Backup verification failed.');
  const snapshot=currentSnapshot(base,data);
  const plan={environment:'production',target,pathname,etag:state.etag,backupSha256:sha(backup),sourceSha256:base.provenance.sourceSha256,revision:data.revision,counts:{shipments:snapshot.shipments.length,payments:snapshot.payments.length,stocks:snapshot.stocks.length,paymentAllocations:data.paymentAllocations?.length??0},preservedSha256:sha(JSON.stringify(retained(data)))};
  await writeFile(resolve(directory,'plan.json'),JSON.stringify(plan,null,2),{mode:0o600,flag:'wx'});
  console.log(JSON.stringify({status:'backup_verified',directory,...plan},null,2));
}else{
  const plan=JSON.parse(await readFile(resolve(directory,'plan.json'),'utf8'));
  const raw=await readFile(resolve(directory,'operations-before.json'),'utf8');
  if(plan.target!==target || plan.sourceSha256!==base.provenance.sourceSha256 || plan.backupSha256!==sha(raw))throw new Error('Backup or target mismatch.');
  const original=decodeOperations(raw,base.provenance.sourceSha256);
  if(mode==='apply'){
    if(state.etag!==plan.etag || sha(state.raw)!==plan.backupSha256)throw new Error('Cloud data changed after backup. Make a new plan.');
    const cleared=clearOperations(base,data);
    if(sha(JSON.stringify(retained(data)))!==plan.preservedSha256)throw new Error('A retained collection changed. No cloud write performed.');
    data.revision++;
    const encoded=encodeOperations(data);
    // Also validate the effective state before sending the conditional write.
    const empty=currentSnapshot(base,decodeOperations(encoded,base.provenance.sourceSha256));
    if(empty.shipments.length || empty.payments.length || empty.stocks.length)throw new Error('Reset verification failed.');
    await put(pathname,encoded,{access:'private',allowOverwrite:true,addRandomSuffix:false,ifMatch:state.etag,contentType:'application/json'});
    const after=await load();
    if(sha(after.raw)!==sha(encoded))throw new Error('Post-write verification failed. Inspect state; do not repeat apply.');
    await writeFile(resolve(directory,'applied.json'),JSON.stringify({target,environment:'production',removed:cleared.removed,afterSha256:sha(after.raw),afterEtag:after.etag,revision:data.revision,retainedVerified:true,verifiedAt:new Date().toISOString()},null,2),{mode:0o600,flag:'wx'});
    console.log(JSON.stringify({status:'cleared_and_blob_verified',removed:cleared.removed,directory}));
  }else if(mode==='restore' || mode==='restore-check'){
    const applied=JSON.parse(await readFile(resolve(directory,'applied.json'),'utf8'));
    if(sha(state.raw)!==applied.afterSha256){
      // The explicitly recorded create/read/delete verification may leave one tombstone.
      // Allow exactly that change; never discard subsequent users, settings or new work.
      const qa=JSON.parse(await readFile(resolve(directory,'live-create-check.json'),'utf8'));
      const clean=structuredClone(data), expected=structuredClone(original);
      if(qa.target!==target || qa.createStatus!==201 || qa.deleteStatus!==200 || !qa.reloadFound || typeof qa.createdId!=='string' || Object.keys(clean.shipments).length!==1 || !clean.shipments[qa.createdId]?.deleted)throw new Error('New data exists since cleanup; use a reviewed merge.');
      clean.shipments={};clearOperations(base,expected);expected.revision=clean.revision;
      if(!isDeepStrictEqual(clean,expected))throw new Error('Retained data changed since cleanup; use a reviewed merge.');
    }
    if(mode==='restore-check'){
      console.log(JSON.stringify({status:'restoration_verified_without_writing',directory,restoredCounts:projection(currentSnapshot(base,original)).shipments.length,backupSha256:sha(raw)}));
      process.exit(0);
    }
    original.revision=data.revision+1;
    await put(pathname,encodeOperations(original),{access:'private',allowOverwrite:true,addRandomSuffix:false,ifMatch:state.etag,contentType:'application/json'});
    const restored=decodeOperations((await load()).raw,base.provenance.sourceSha256);
    if(JSON.stringify(projection(currentSnapshot(base,restored)))!==JSON.stringify(projection(currentSnapshot(base,original))))throw new Error('Restoration verification failed.');
    console.log(JSON.stringify({status:'restored_and_verified',directory}));
  }else{
    const snapshot=currentSnapshot(base,data);
    console.log(JSON.stringify({target,sourceOperationsCleared:data.sourceOperationsCleared,counts:{shipments:snapshot.shipments.length,payments:snapshot.payments.length,stocks:snapshot.stocks.length},oldShipmentIdsPresent:snapshot.shipments.filter(s=>currentSnapshot(base,original).shipments.some(o=>o.id===s.id)).length,retainedVerified:sha(JSON.stringify(retained(data)))===plan.preservedSha256}));
  }
}

import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import Decimal from 'decimal.js';
import { operatorUsageIndex } from '../server/operator-plans';
import type { OperatorData, OperatorRefuellingV3, OperatorRefuelling } from '../web/src/operator-model';
const state:OperatorData={recipients:{},refuellings:{},requests:{}};
for(let n=0;n<10000;n++) state.refuellings[String(n)]={id:String(n),schemaVersion:3,planId:String(n%200),...(n%17===0?{deletedAt:'2026-10-21'}:{}),allocations:[{kind:'recipient',recipientId:'r',amount:'10.01'},n%3===0?{kind:'manager',managerId:'aidar',planId:String((n+1)%200),amount:'0.99'}:{kind:'recipient',recipientId:'s',planId:String((n+1)%200),amount:'0.99'}]} as OperatorRefuellingV3;
state.refuellings.legacy={id:'legacy',amount:'999999'} as OperatorRefuelling;
state.refuellings.v2={id:'v2',schemaVersion:2,amount:'999999'} as OperatorRefuelling;
function reference(exclude?:string){
 const result=new Map<string,{amounts:Map<string,Decimal>;managerAmount:Decimal}>();
 for(let p=0;p<200;p++)for(const row of Object.values(state.refuellings)) {
  if(row.schemaVersion!==3||row.deletedAt||row.id===exclude)continue;
  for(const a of row.allocations){if((a.planId??row.planId)!==String(p))continue;const e=result.get(String(p))??{amounts:new Map<string,Decimal>(),managerAmount:new Decimal(0)};result.set(String(p),e);if(a.kind==='manager')e.managerAmount=e.managerAmount.plus(a.amount);else e.amounts.set(a.recipientId,(e.amounts.get(a.recipientId)??new Decimal(0)).plus(a.amount));}
 }return result;
}
const normalize=(m:ReturnType<typeof operatorUsageIndex>)=>[...m].map(([k,v])=>[k,[...v.amounts].map(([id,n])=>[id,n.toFixed(2)]).sort(),v.managerAmount.toFixed(2)]).sort();
const runs=[];
for(let pass=0;pass<5;pass++){
 const start=performance.now(),index=operatorUsageIndex(state),optimizedMs=performance.now()-start;
 const simple=performance.now(),ref=reference(),referenceMs=performance.now()-simple;
 assert.deepEqual(normalize(index),normalize(ref));runs.push({optimizedMs,referenceMs});
}
(state.refuellings['1'] as OperatorRefuellingV3).allocations[0].amount='42.17';state.refuellings['2'].deletedAt='2026-10-21';
assert.deepEqual(normalize(operatorUsageIndex(state,'3')),normalize(reference('3')));
console.log(JSON.stringify({passed:true,synthetic:true,plans:200,operations:10002,allocations:20000,managers:true,legacy:true,editedDeletedExcluded:true,runs,scope:'only plan usage calculation; not production CRM performance'},null,2));

import assert from 'node:assert/strict';
import test from 'node:test';
import { directWorkflowSteps } from '../web/src/trip-workflow-view';
import type { TripSabyResponse } from '../web/src/trip-saby-model';
const base = (): TripSabyResponse => ({documentMode:'nk_direct_etrn',status:'not_sent',phase:'preparation',ready:false,locked:false,blockers:[],updatedAt:null,lastError:null,order:null,deliveries:[],carrierConfirmed:false,lastCheckedAt:null,lastCheckAttemptAt:null,monitoring:{enabled:false,intervalSeconds:null},history:[]});
const time = '2026-10-22T07:00:00Z';
test('rebuilt blocked draft keeps actual driver confirmation without inventing external progress', () => {
  const result=base(); result.driverConfirmation={arrivedAt:time,confirmedAt:time}; result.previousExchanges=[{at:time,documents:[{number:'3',url:null,status:'sent'}]}];
  const steps=directWorkflowSteps(result,['a','b']);
  assert.deepEqual(steps.map(s=>s.state),['current','done','pending','pending','pending','pending','pending']);
  assert.equal(steps[2].note,'0 из 2');
  assert.ok(steps.every(s=>!s.label.includes('АРТЭЛЬ') && !s.label.includes('заявк')));
});
test('partial delivery evidence and unrelated documents cannot complete a shared stage', () => {
  const result=base(); result.ready=true;result.locked=true;
  result.deliveries=[{shipmentId:'a',id:'doc-a',status:'draft',lastError:null,dispatch:{sender:{state:'confirmed'},carrier:{state:'confirmed'},completedAt:time,recipientAcceptedAt:time}},{shipmentId:'excluded',id:'doc-x',status:'draft',lastError:null}];
  const steps=directWorkflowSteps(result,['a','b']);
  assert.equal(steps[1].state,'unconfirmed');
  assert.equal(steps[2].state,'current');
  assert.equal(steps[2].note,'1 из 2');
  assert.ok(steps.slice(3).every(s=>s.state==='pending'));
});
test('dispatch and recipient acceptance remain separate even with completed aggregate phase', () => {
  const result=base();result.ready=true;result.locked=true;result.phase='completed';result.stage6CompletedAt=time;
  result.driverConfirmation={arrivedAt:time,confirmedAt:time};
  result.deliveries=['a','b'].map(shipmentId=>({shipmentId,id:shipmentId,status:'draft',lastError:null,dispatch:{sender:{state:'confirmed'},carrier:{state:'confirmed'},completedAt:time}}));
  assert.deepEqual(directWorkflowSteps(result,['a','b']).map(s=>s.state),['done','done','done','done','done','done','current']);
  result.deliveries[0].dispatch!.recipientAcceptedAt=time;
  assert.equal(directWorkflowSteps(result,['a','b'])[6].note,'1 из 2');
  result.deliveries[1].dispatch!.recipientAcceptedAt='invalid';
  assert.equal(directWorkflowSteps(result,['a','b'])[6].state,'current');
  result.deliveries[1].dispatch!.recipientAcceptedAt=time;
  assert.ok(directWorkflowSteps(result,['a','b']).every(s=>s.state==='done'));
});
test('known creation survives reconciliation while blocked signatures remain incomplete',()=>{
 const result=base();result.locked=true;result.phase='sending_etrn';
 result.deliveries=[{shipmentId:'a',id:'a',status:'unknown',lastError:'unknown',dispatch:{sender:{state:'blocked'},carrier:{state:'unknown'},completedAt:null}}];
 const steps=directWorkflowSteps(result,['a']);assert.equal(steps[2].state,'done');assert.equal(steps[3].state,'current');assert.ok(steps.slice(4).every(s=>s.state==='pending'));
 result.deliveries[0].id=null;assert.equal(directWorkflowSteps(result,['a'])[2].note,'0 из 1');assert.notEqual(directWorkflowSteps(result,['a'])[2].state,'done');
 assert.deepEqual(directWorkflowSteps({...result,notRequired:true},['a']),[]);assert.deepEqual(directWorkflowSteps(result,[]),[]);
});

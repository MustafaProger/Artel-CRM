import assert from 'node:assert/strict';
import test from 'node:test';
import { mergeDirectoryPayload, withCurrentAddressVersions } from '../web/src/directory-editor-data';

test('merges unrelated edits and preserves hidden fields from the server',()=>{
  const base={plate:'QA',leaseContractNumber:'1',payloadCapacityTonnes:'8',carrierId:'old'};
  assert.deepEqual(mergeDirectoryPayload(base,{...base,leaseContractNumber:'2'},{...base,payloadCapacityTonnes:'9',carrierId:'new'}),{merged:{plate:'QA',leaseContractNumber:'2',payloadCapacityTonnes:'9',carrierId:'new'},conflicts:[]});
});
test('reports only overlapping fields, including clearing a value',()=>{
  const result=mergeDirectoryPayload({name:'QA',phone:'1'},{name:'QA',phone:''},{name:'QA',phone:'2'});
  assert.deepEqual(result.conflicts,['phone']);assert.equal(result.merged.phone,'');
});
test('same concurrent change does not require a choice',()=>{
  assert.deepEqual(mergeDirectoryPayload({name:'A'},{name:'B'},{name:'B'}).conflicts,[]);
});
test('address versions alone are not edits; latest token is used',()=>{
  const base={addresses:[{id:'a',name:'old',kind:'delivery',version:1}]};
  const local={addresses:[{id:'a',name:'new',kind:'delivery',version:1}]};
  const latest={addresses:[{id:'a',name:'old',kind:'delivery',version:2}]};
  const result=mergeDirectoryPayload(base,local,latest);
  assert.deepEqual(result.conflicts,[]);assert.deepEqual(result.merged.addresses,[{id:'a',name:'new',kind:'delivery',version:2}]);
});
test('address lists are treated as one group to avoid guessing deletions and additions',()=>{
  const result=mergeDirectoryPayload({addresses:[{id:'a',name:'A'}]},{addresses:[]},{addresses:[{id:'a',name:'B'}]});
  assert.deepEqual(result.conflicts,['addresses']);
});
test('explicit address choice still uses latest versions',()=>{
  assert.deepEqual(withCurrentAddressVersions({addresses:[{id:'a',name:'mine',version:1}]},{addresses:[{id:'a',name:'saved',version:3}]}),{addresses:[{id:'a',name:'mine',version:3}]});
});
test('missing and empty optional fields compare alike',()=>{
  assert.deepEqual(mergeDirectoryPayload({phone:''},{phone:''},{phone:undefined}).conflicts,[]);
});
test('clearing vehicle compartments remains an intentional edit',()=>{
  const result=mergeDirectoryPayload({compartmentsLitres:['5','5']},{compartmentsLitres:undefined},{compartmentsLitres:['5','5']});
  assert.equal(result.merged.compartmentsLitres,undefined);assert.deepEqual(result.conflicts,[]);
});

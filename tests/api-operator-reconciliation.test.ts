import test from 'node:test'
import assert from 'node:assert/strict'
import {randomUUID} from 'node:crypto'
import {operatorFixture} from './api-operator.test'
import {reconciliationRows} from '../web/src/operator-reconciliation'
import {availableDirectoryTabs, type AccountUser} from '../web/src/auth-model'
import {OperationsStore} from '../server/operations-store'
import {dirname} from 'node:path'
import type {OperatorWorkspace} from '../web/src/operator-model'

test('daily reconciliation persists zero, protects versions, replay ownership and unrelated business facts',async()=>{
 const f=await operatorFixture();try {
  const base={date:'2026-10-28',serviceId:'operator-service-rosneft',litres:'0',amount:'0',idempotencyKey:randomUUID()}
  const before=await f.store.read(f.source)
  assert.equal((await f.request('/api/operator/reconciliations','POST',base,f.denied.cookie)).status,403)
  assert.equal((await f.request('/api/operator/reconciliations','POST',{...base,amount:'-1'},f.operator.cookie)).status,400)
  assert.equal((await f.request('/api/operator/reconciliations','POST',{...base,date:'2026-02-30'},f.operator.cookie)).status,400)
  assert.equal((await f.request('/api/operator/reconciliations','POST',{...base,serviceId:'unknown'},f.operator.cookie)).status,400)
  const created=await f.request('/api/operator/reconciliations','POST',base,f.operator.cookie)
  assert.equal(created.status,201)
  assert.equal((await f.request('/api/operator/reconciliations','POST',base,f.operator.cookie)).body.replayed,true)
  assert.equal((await f.request('/api/operator/reconciliations','POST',base,f.admin)).status,409)
  assert.equal((await f.request('/api/operator/reconciliations','POST',{...base,idempotencyKey:randomUUID()},f.operator.cookie)).status,409)
  const path=`/api/operator/reconciliations/${created.body.id}`
  assert.equal((await f.request(path,'PATCH',{...base,version:0,idempotencyKey:randomUUID()},f.operator.cookie)).status,409)
  const edit={...base,litres:'450,5',amount:'34650',version:1,idempotencyKey:randomUUID()}
  assert.equal((await f.request(path,'PATCH',edit,f.operator.cookie)).status,200)
  assert.equal((await f.request(path,'PATCH',edit,f.operator.cookie)).body.replayed,true)
  const after=await new OperationsStore(dirname(f.store.path)).read(f.source)
  assert.equal(after.operator!.reconciliations![created.body.id].history.length,2)
  assert.equal(after.operator!.reconciliations![created.body.id].history[1].actorId,f.operator.user.id)
  assert.deepEqual(after.operator!.refuellings,before.operator!.refuellings)
  assert.deepEqual(after.operator!.recipients,before.operator!.recipients)
  const {operator:unused,revision:unused2,...rest}=after;void unused;void unused2
  const {operator:unused3,revision:unused4,...prior}=before;void unused3;void unused4
  assert.deepEqual(rest,prior)
 }finally{await f.close()}
})

test('daily totals use operation date, exact addition, historical discount, include unpaid and exclude deleted',async()=>{
 const f=await operatorFixture();try{
  for(const discountPercent of ['10','8']) assert.equal((await f.request('/api/operator/refuellings','POST',{...f.fuelBody(),date:'2026-10-28',service:'Роснефть',amount:'31500',discountPercent},f.operator.cookie)).status,201)
  assert.equal((await f.request('/api/operator/refuellings','POST',{...f.fuelBody(),date:'2026-10-27',service:'Роснефть',amount:'100'},f.operator.cookie)).status,201)
  const work=(await f.request('/api/operator','GET',undefined,f.operator.cookie)).body as OperatorWorkspace
  const row=reconciliationRows(work,'2026-10-28').find(row=>row.id==='operator-service-rosneft')!
  assert.equal(row.rows.length,2);assert.equal(row.litres,'201');assert.equal(row.amount,'68670.00');assert.equal(row.deltaAmount,null)
  work.services.find(service=>service.id===row.id)!.discountPercent='99'
  assert.equal(reconciliationRows(work,'2026-10-28').find(item=>item.id===row.id)!.amount,row.amount)
  work.refuellings.find(item=>item.date==='2026-10-28')!.deletedAt=new Date().toISOString()
  assert.equal(reconciliationRows(work,'2026-10-28').find(item=>item.id===row.id)!.rows.length,1)
 }finally{await f.close()}
})

test('operator-only employee sees only explicitly granted service directory',()=>{
 const user:AccountUser={id:'staff',name:'Staff',login:'staff',role:'employee',managerId:'staff',active:true,version:1,sections:['work','operator','directories'],directoryGrants:['operatorServices']}
 assert.deepEqual(availableDirectoryTabs(user),['operatorServices'])
 assert.deepEqual(availableDirectoryTabs({...user,directoryGrants:[]}),[])
 assert.ok(availableDirectoryTabs({...user,role:'admin'}).includes('customers'))
 assert.deepEqual(availableDirectoryTabs({...user,active:false}),[])
})

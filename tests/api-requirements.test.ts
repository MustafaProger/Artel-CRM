import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore, decodeOperations, encodeOperations } from '../server/operations-store';
import { saveCompany } from '../server/directory-editing';
import { clearOperations } from '../server/reset-operations';
import { prepareDirectoryCleanup } from '../server/directory-cleanup';
import { currentSnapshot } from '../server/shipment-operations';
import type { Snapshot } from '../web/src/model';
import { azsShipmentTemplates, fieldValue, shipmentTemplates } from '../web/src/shipment-templates';
const base = await loadSnapshot(resolve('data/local-xlsx-final'));
async function setup(clear = false, backupFails = false) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-requirements-'));
  const store = new OperationsStore(directory);
  if (clear) await store.mutate(base.provenance.sourceSha256, data => ({ result: clearOperations(base, data), changed: true }));
  if (backupFails) store.backup = async () => { throw new Error('Backup unavailable'); };
  const middleware = createSnapshotMiddleware(resolve('data/local-xlsx-final'), { operationsStore: store });
  const server = createServer((request, response) => middleware(request, response, () => { response.writeHead(404); response.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = () => { let cookie = ''; return async (path: string, method = 'GET', body?: unknown) => {
    const response = await fetch(url + path, { method, headers: { Cookie: cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (response.headers.get('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
    return { status: response.status, body: response.headers.get('content-type')?.includes('application/json') ? await response.json() : await response.text() };
  }; };
  const director = client(), password = randomUUID();
  const user = (await director('/api/auth/setup', 'POST', { name: 'Директор QA', login: 'req-director', password })).body.user;
  return { directory, store, director, client, password, user, snapshot: async () => (await director('/api/snapshot')).body as Snapshot, close: async () => { await new Promise<void>(done => server.close(() => done())); await rm(directory, { recursive: true, force: true }); } };
}

test('task comments, private downloadable files, handoff, archive and restoration retain the complete card', async () => {
  const r = await setup();
  try {
    const companyId = (await r.snapshot()).companies[0].id;
    const employee = (await r.director('/api/auth/users','POST',{ name:'Получатель', login:'req-recipient', password:r.password, role:'manager', managerId:null })).body.user;
    const employeeApi = r.client(); await employeeApi('/api/auth/login','POST',{login:employee.login,password:r.password});
    const payload = { requestId:randomUUID(), title:'Договор', description:'Проверить договор', companyId, dueDate:'2026-09-11', reminderAt:'2026-09-10T12:00:00.000Z', comment:'Первый комментарий', addAttachments:[{name:'договор.txt',data:Buffer.from('Договор для сотрудника').toString('base64')}] };
    const created = await r.director('/api/work/tasks','POST',payload); assert.equal(created.status,201); const task=created.body.entry;
    assert.equal(task.attachments[0].data,undefined); assert.equal((await r.director('/api/work/tasks','POST',payload)).status,200);
    const path=`/api/work/tasks/${task.id}/files/${task.attachments[0].id}`;
    assert.equal((await employeeApi(path)).status,404); assert.equal((await r.client()(path)).status,401);
    assert.equal((await r.director(path)).body,'Договор для сотрудника');
    const update = await r.director(`/api/work/tasks/${task.id}`,'PATCH',{version:1,comment:'Передаю коллеге',assigneeId:employee.id,status:'done',archived:true}); assert.equal(update.status,200);
    assert.equal((await employeeApi(path)).body,'Договор для сотрудника');
    const archived = (await employeeApi('/api/work')).body.work.tasks[0]; assert.ok(archived.archivedAt); assert.equal(archived.comments.length,2); assert.equal(archived.dueDate,payload.dueDate); assert.equal(archived.reminderAt,payload.reminderAt); assert.equal(archived.companyId,companyId);
    assert.equal((await employeeApi(`/api/work/tasks/${task.id}`,'PATCH',{version:2,archived:false,title:'Договор получен'})).status,200);
    const stored = await new OperationsStore(r.directory).read(base.provenance.sourceSha256); assert.equal(stored.work!.tasks[0].archivedAt,null); assert.equal(stored.work!.tasks[0].attachments![0].data,payload.addAttachments[0].data);
    const companyRecord=await r.director('/api/work/companies','POST',{companyId,question:'Документы',addAttachments:payload.addAttachments}); assert.equal(companyRecord.status,201);
    assert.equal((await r.director(`/api/work/companies/${companyRecord.body.entry.id}/files/${companyRecord.body.entry.attachments[0].id}`)).body,'Договор для сотрудника');
    const previous=encodeOperations(await r.store.read(base.provenance.sourceSha256));
    for (const fields of [{comments:[]},{addAttachments:[{name:'../bad.txt',data:'YQ=='}]},{addAttachments:[{name:'bad.txt',data:'invalid'}]},{addAttachments:[{name:'large.txt',data:Buffer.alloc(1024*1024+1).toString('base64')}]}]) assert.equal((await employeeApi(`/api/work/tasks/${task.id}`,'PATCH',{version:3,...fields})).status,400);
    assert.equal(encodeOperations(await r.store.read(base.provenance.sourceSha256)),previous);
    assert.equal((await employeeApi(`/api/work/tasks/${task.id}`,'DELETE',{version:3})).status,405);
  } finally { await r.close(); }
});

test('China stores multiple suppliers per day, independent payments, exact decimals and no balance formula', async () => {
  const r = await setup();
  try {
    const suppliers = (await r.snapshot()).companies.filter(c=>c.roles.includes('supplier')).slice(0,2);
    const payload={requestId:randomUUID(),date:'2026-09-10',fuels:[{supplierId:suppliers[0].id,litres:'100.1',amount:'200.25'},{supplierId:suppliers[1].id,litres:'300.2',amount:'500.75'}]};
    const first = await r.director('/api/china/days','POST',payload); assert.equal(first.status,201);
    assert.equal((await r.director('/api/china/days','POST',payload)).status,200);
    assert.equal((await r.director('/api/china/days','POST',{...payload,requestId:randomUUID()})).status,409);
    const payment={requestId:randomUUID(),date:payload.date,amount:'900.35'};
    assert.equal((await r.director('/api/china/payments','POST',payment)).status,201); assert.equal((await r.director('/api/china/payments','POST',payment)).status,200);
    assert.equal((await r.director('/api/china/payments','POST',{date:'2026-09-12',amount:'10'})).status,201);
    const all=(await r.director('/api/china')).body.china; assert.deepEqual(all.days[0].fuels,payload.fuels); assert.equal(all.payments.length,2); assert.ok(!('balance' in all));
    const more=[...payload.fuels,{supplierId:suppliers[0].id,litres:'0.25',amount:'0'}];
    assert.equal((await r.director(`/api/china/days/${first.body.entry.id}`,'PATCH',{version:1,date:payload.date,fuels:more})).status,200);
    assert.equal((await r.director(`/api/china/days/${first.body.entry.id}`,'PATCH',{version:1,date:payload.date,fuels:more})).status,409);
    for (const invalid of [{date:'2026-02-30',fuels:more},{date:payload.date,fuels:[]},{date:payload.date,fuels:[{supplierId:'missing',litres:'1',amount:'2'}]},{date:payload.date,fuels:[{supplierId:suppliers[0].id,litres:'-1',amount:'2'}]}]) assert.equal((await r.director('/api/china/days','POST',invalid)).status,400);
    assert.equal((await r.director(`/api/directories/companies/${suppliers[0].id}`,'PATCH',{version:suppliers[0].version??0,name:suppliers[0].name,roles:['customer'],addresses:[]})).status,409);
    const stored=await new OperationsStore(r.directory).read(base.provenance.sourceSha256); assert.equal(stored.china!.days[0].fuels.length,3); assert.equal(stored.china!.payments[0].amount,'900.35');
    assert.equal((await r.director(`/api/directories/suppliers/${suppliers[0].id}`,'DELETE',{version:suppliers[0].version??0})).status,409);
  } finally { await r.close(); }
});

test('manager receives existing client assignments through account link and subsequent directory changes immediately', async () => {
  const r=await setup(true);
  try {
    const snap=await r.snapshot(), manager=snap.directories!.managers[0];
    const customer=(await r.director('/api/directories','POST',{kind:'companies',name:'СПС тест',roles:['customer'],managerId:manager.id,addresses:[{name:'Адрес отгрузки',kind:'delivery'}]})).body.entry;
    const user=(await r.director('/api/auth/users','POST',{name:'Нуры тест',login:'req-manager',password:r.password,role:'manager',managerId:manager.id})).body.user;
    const employee=r.client(); await employee('/api/auth/login','POST',{login:user.login,password:r.password});
    let scoped=(await employee('/api/snapshot')).body as Snapshot; assert.ok(scoped.directories!.assignedCustomerIds!.includes(customer.id)); assert.equal(scoped.shipments.length,0);
    const next=(await r.director('/api/directories','POST',{kind:'companies',name:'Следующий клиент',roles:['customer'],managerId:manager.id,addresses:[]})).body.entry;
    scoped=(await employee('/api/snapshot')).body; assert.ok(scoped.directories!.assignedCustomerIds!.includes(next.id));
    assert.equal((await employee('/api/directories/cleanup')).status,403); assert.equal((await employee('/api/china')).status,403);
    assert.equal((await r.director('/api/auth/users')).body.users.find((row:{id:string})=>row.id===user.id).managerId,manager.id);
    const cleanup=(await r.director('/api/directories/cleanup')).body; assert.equal(cleanup.available,false); assert.match(cleanup.blocked,/учётной записи/);
  } finally { await r.close(); }
});

test('directory cleanup backs up before clearing, preserves forms and accounts, and stays empty on reload', async () => {
  const r=await setup(true);
  try {
    const initial=await r.store.read(base.provenance.sourceSha256), snapshot=await r.snapshot();
    const preview=(await r.director('/api/directories/cleanup')).body; assert.equal(preview.available,true);
    const before=await readFile(r.store.path,'utf8');
    assert.equal((await r.director('/api/directories/cleanup','POST',{revision:preview.revision,confirm:'wrong'})).status,400); assert.equal(await readFile(r.store.path,'utf8'),before);
    const cleared=await r.director('/api/directories/cleanup','POST',{revision:preview.revision,confirm:'clear-directories'}); assert.equal(cleared.status,200);
    assert.equal(encodeOperations(decodeOperations(await readFile(cleared.body.backup,'utf8'),base.provenance.sourceSha256)),encodeOperations(initial));
    const stored=await new OperationsStore(r.directory).read(base.provenance.sourceSha256), after=currentSnapshot(base,stored);
    for(const kind of ['managers','products','vehicles','drivers'] as const) assert.equal(after.directories![kind].length,0);
    assert.equal(after.companies.filter(c=>c.roles.includes('customer')||c.roles.includes('supplier')).length,0);
    assert.deepEqual(after.directories!.paymentForms,snapshot.directories!.paymentForms); assert.equal(after.directories!.paymentForms.length,3); assert.deepEqual(stored.accounts,initial.accounts); assert.deepEqual(stored.shipments,initial.shipments);
    assert.equal((await r.director('/api/directories','POST',{kind:'companies',name:'Новый клиент после очистки',roles:['customer'],addresses:[]})).status,201);
  } finally { await r.close(); }
});

test('cleanup refuses document/work dependencies, stale previews and failed backups without changing stored data', async () => {
  const r=await setup(), failing=await setup(true,true);
  try {
    const before=await readFile(r.store.path,'utf8'), preview=(await r.director('/api/directories/cleanup')).body;
    assert.equal(preview.available,false); assert.match(preview.blocked,/используется/);
    assert.equal((await r.director('/api/directories/cleanup','POST',{revision:preview.revision,confirm:'clear-directories'})).status,409); assert.equal(await readFile(r.store.path,'utf8'),before);
    const data=await r.store.read(base.provenance.sourceSha256); clearOperations(base,data);
    const workCompany = saveCompany({name:'Только рабочая компания',roles:['customer'],addresses:[]},currentSnapshot(base,data),data).entry;
    data.work={tasks:[{id:'task-qa',version:1,title:'Связь',description:'',companyId:workCompany.id,status:'todo',dueDate:null,reminderAt:null,assigneeId:r.user.id,createdBy:r.user.id,updatedBy:r.user.id,createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()}],companyRecords:[],notes:[]};
    const untouched=encodeOperations(data); assert.throws(()=>prepareDirectoryCleanup(base,data),/рабочем пространстве/); assert.equal(encodeOperations(data),untouched);
    const fp=(await failing.director('/api/directories/cleanup')).body, original=await readFile(failing.store.path,'utf8');
    assert.equal((await failing.director('/api/directories/cleanup','POST',{revision:fp.revision-1,confirm:'clear-directories'})).status,409);
    assert.equal((await failing.director('/api/directories/cleanup','POST',{revision:fp.revision,confirm:'clear-directories'})).status,500); assert.equal(await readFile(failing.store.path,'utf8'),original);
    assert.ok(!(await readdir(failing.directory)).includes('backups'));
  } finally { await r.close(); await failing.close(); }
});

test('AZS small table has precisely ten requested columns; tanker expense presentation leaves source values intact', () => {
  assert.deepEqual(azsShipmentTemplates.small.columns.map(column=>column.title),['Дата','Контрагент','Менеджер','Форма оплаты','Количество литров','Сумма покупателя','Сумма поставщика','Поставщик','Прибыль','Оплата']);
  assert.equal(azsShipmentTemplates.medium.columns.length,19);
  assert.ok(shipmentTemplates.expanded.columns.some(column=>column.key==='costs_breakdown'));
  assert.ok(!shipmentTemplates.expanded.columns.some(column=>['kvp_source','additional_costs'].includes(column.key)));
  const row=structuredClone(base.shipments[0]); row.fields.kvp_source='125.5'; row.fields.additional_costs='80.25'; const before=JSON.stringify(row);
  assert.equal(fieldValue(row,'costs_breakdown'),'КВП: 125.5 · Допзатраты: 80.25'); assert.equal(JSON.stringify(row),before);
});

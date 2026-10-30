import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { OperationsStore, encodeOperations, decodeOperations } from '../server/operations-store';
import { defaultEmployeeSections, type AccountUser, type SharedDirectory } from '../web/src/auth-model';
import type { Shipment, Company } from '../web/src/model';
import { writeTripsQaSnapshot } from '../scripts/qa-trips-runtime.mjs';

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), 'artel-directory-grants-'));
  const directory = resolve(root, 'snapshot'); await writeTripsQaSnapshot(directory);
  const base = await loadSnapshot(directory), store = new OperationsStore(resolve(root, 'store'));
  const denied = async (): Promise<never> => { throw new Error('External requests forbidden in permission tests'); };
  const middleware = createSnapshotMiddleware(directory, { operationsStore: store, fetcher: denied, checkoApiKey: '', bankEnvironment: { ARTEL_BANK_REQUESTS_ENABLED: 'false' }, pushConfig: { publicKey: '', privateKey: '', subject: '', schedule: false } });
  const server = createServer((req, res) => middleware(req, res, () => {res.writeHead(404);res.end();}));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = () => { let cookie = ''; return async (path: string, method = 'GET', body?: unknown) => {
    const r = await fetch(url + path, { method, headers: { cookie, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
    if (r.headers.has('set-cookie')) cookie = r.headers.get('set-cookie')!.split(';')[0];
    return { status: r.status, body: await r.json() };
  }; };
  const admin = client(), people = [client(), client()], password = randomUUID();
  await admin('/api/auth/setup', 'POST', { name: 'Director QA', login: 'director-qa', password });
  const users: AccountUser[] = [], customers: Company[] = [], shipments: Shipment[] = [];
  const supplier = (await admin('/api/directories', 'POST', { kind: 'companies', name: 'Shared supplier QA', roles: ['supplier'], addresses: [] })).body.entry;
  const product = (await admin('/api/directories', 'POST', { kind: 'products', name: 'Fuel QA' })).body.entry;
  const payment = (await admin('/api/snapshot')).body.directories.paymentForms.find((row: {name: string}) => row.name === 'б/нал');
  for (const [i, api] of people.entries()) {
    const employee = (await admin('/api/directories', 'POST', { kind: 'managers', name: `Employee ${i}` })).body.entry;
    const account = await admin('/api/auth/users', 'POST', { name: employee.name, login: `employee-${i}`, password, role: 'employee', managerId: employee.id });
    assert.equal(account.status, 201); users.push(account.body.user);
    const customer = await admin('/api/directories', 'POST', { kind: 'companies', name: `Own customer ${i}`, roles: ['customer'], managerId: employee.id, addresses: [] });
    assert.equal(customer.status, 201); customers.push(customer.body.entry);
    const row = await admin('/api/shipments', 'POST', { fields: { shipment_type: 'azs', customer_id: customer.body.entry.id, supplier_id: supplier.id, manager_id: employee.id, product_id: product.id, payment_form_id: payment.id, date: '2026-10-26', quantity_litres: '1000', customer_amount: i ? '777777' : '100000', purchase_amount: '80000' } });
    assert.equal(row.status, 201); shipments.push(row.body.shipment);
    await api('/api/auth/login', 'POST', { login: account.body.user.login, password });
  }
  let user = users[0];
  const grant = async (directoryGrants: SharedDirectory[]) => {
    const {id, name, login, role, managerId, active, version, sections} = user;
    const r = await admin('/api/auth/users/' + id, 'PATCH', { name, login, role, managerId, active, version, sections, directoryGrants });
    assert.equal(r.status, 200, JSON.stringify(r.body)); user = r.body.user;
    assert.equal((await people[0]('/api/snapshot')).status, 401);
    await people[0]('/api/auth/login', 'POST', { login, password }); return user;
  };
  return { admin, a: people[0], b: people[1], users, customers, shipments, supplier, product, password, grant, store, base, close: async () => { await new Promise<void>(done => server.close(() => done())); await rm(root, {recursive:true,force:true}); } };
}

test('directory grants: a new employee gets only own clients, overview, shipments and work; common catalogs default closed', async () => {
  const f = await fixture(); try {
    assert.deepEqual(f.users[0].sections, defaultEmployeeSections);
    const d = (await f.a('/api/directories')).body;
    assert.deepEqual(d.companies.map((row: Company) => row.id), [f.customers[0].id]);
    for (const kind of ['oilDepots', 'products', 'vehicles', 'drivers', 'paymentForms', 'operatorServices']) assert.deepEqual(d.directories[kind] ?? [], []);
    assert.deepEqual(d.directories.managers.map((row: {id: string}) => row.id), [f.users[0].managerId]);
    assert.deepEqual((await f.a('/api/snapshot?context=directories')).body.shipments, []);
    const rows = (await f.a('/api/shipments')).body;
    assert.deepEqual(rows.items.map((row: Shipment) => row.id), [f.shipments[0].id]); assert.equal(rows.summary.revenue.total, '100000');
    assert.equal((await f.a('/api/shipments/' + f.shipments[1].id)).status, 404);
    assert.ok(!JSON.stringify((await f.a('/api/settlements')).body).includes(f.shipments[1].id));
    await f.b('/api/work/tasks', 'POST', { title: 'Private task QA' });
    assert.deepEqual((await f.a('/api/work')).body.work.tasks, []);
  } finally { await f.close(); }
});

test('directory grants: oil depots grant enables full CRUD only in that catalog, then revocation denies stale IDs', async () => {
  const f = await fixture(); try {
    const input = { kind: 'oilDepots', name: 'Depot QA', address: 'Address QA' };
    assert.equal((await f.a('/api/directories', 'POST', input)).status, 403);
    const user = await f.grant(['oilDepots']);
    const stored = await f.store.read(f.base.provenance.sourceSha256);
    assert.deepEqual(decodeOperations(encodeOperations(stored), f.base.provenance.sourceSha256).accounts!.users.find(row => row.id === user.id)!.directoryGrants, ['oilDepots']);
    const created = await f.a('/api/directories', 'POST', input); assert.equal(created.status, 201);
    const id = created.body.entry.id;
    assert.ok((await f.a('/api/directories')).body.directories.oilDepots.some((row: {id:string}) => row.id === id));
    const updated = await f.a('/api/directories/oilDepots/' + id, 'PATCH', { version: 0, name: 'Updated depot QA' }); assert.equal(updated.status, 200);
    assert.equal((await f.a('/api/directories', 'POST', { kind: 'products', name: 'Forbidden QA' })).status, 403);
    assert.equal((await f.a('/api/directories', 'POST', { kind: 'managers', name: 'Forbidden QA' })).status, 403);
    assert.equal((await f.a('/api/auth/users')).status, 403);
    assert.equal((await f.a('/api/directories/companies/' + f.customers[1].id, 'PATCH', { version: 1 })).status, 403);
    assert.equal((await f.a('/api/directories/oilDepots/' + id, 'DELETE', { version: updated.body.entry.version })).status, 200);
    const again = await f.a('/api/directories', 'POST', { ...input, name: 'Retained depot QA' }); assert.equal(again.status, 201);
    await f.grant([]);
    const before = await readFile(f.store.path, 'utf8');
    assert.equal((await f.a('/api/directories/oilDepots/' + again.body.entry.id, 'DELETE', { version: 0 })).status, 403);
    assert.equal((await f.a('/api/directories/oilDepots/' + again.body.entry.id, 'PATCH', { version: 0, name: 'forged' })).status, 403);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
  } finally { await f.close(); }
});

test('directory grants: own customer creation binds the actor and cannot claim, transfer or restore another employee client', async () => {
  const f = await fixture(); try {
    const created = await f.a('/api/directories', 'POST', { kind: 'companies', name: 'New own client QA', roles: ['customer'], addresses: [] }); assert.equal(created.status, 201);
    const id = created.body.entry.id;
    assert.deepEqual((await f.admin('/api/directories')).body.directories.customerManagers.filter((row: {companyId:string}) => row.companyId === id), [{companyId:id,managerId:f.users[0].managerId}]);
    const body = { version: created.body.entry.version, name: 'Updated own client QA', roles: ['customer'], addresses: [] };
    assert.equal((await f.a('/api/directories/companies/' + id, 'PATCH', {...body,managerId:f.users[1].managerId})).status, 403);
    const changed = await f.a('/api/directories/companies/' + id, 'PATCH', body); assert.equal(changed.status, 200);
    const before = await readFile(f.store.path, 'utf8');
    assert.equal((await f.a('/api/directories', 'POST', {kind:'customerManagers',companyId:f.customers[1].id,managerId:f.users[0].managerId})).status, 403);
    assert.equal((await f.a('/api/directories', 'POST', {kind:'companies',name:f.customers[1].name,roles:['customer'],managerId:f.users[0].managerId,addresses:[]})).status, 403);
    assert.equal((await f.a('/api/directories/customers/' + f.customers[1].id, 'DELETE', {version:1})).status, 403);
    assert.equal((await f.a('/api/companies/from-inn', 'POST', {inn:'7707083893'})).status, 403);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    assert.equal((await f.a('/api/directories/customers/' + id, 'DELETE', {version:changed.body.entry.version})).status, 200);
  } finally { await f.close(); }
});

test('directory grants: shared suppliers and other enabled catalogs do not reveal or reassign foreign customer history', async () => {
  const f = await fixture(); try {
    await f.grant(['suppliers','products','vehicles','drivers','managers','paymentForms']);
    const d = (await f.a('/api/directories')).body;
    assert.ok(d.companies.some((row:Company) => row.id===f.supplier.id));
    assert.ok(!d.companies.some((row:Company) => row.id===f.customers[1].id));
    const cases = [{kind:'products',name:'New product QA'},{kind:'managers',name:'New staff QA'},{kind:'paymentForms',name:'New payment QA'},{kind:'vehicles',plate:'TEST123',name:'Vehicle QA'}];
    for (const input of cases) {
      const created = await f.a('/api/directories','POST',input); assert.equal(created.status,201,JSON.stringify(created.body));
      const id=created.body.entry.id;
      const changed=await f.a('/api/directories/'+input.kind+'/'+id,'PATCH',{...input,kind:undefined,version:0,name:input.name+' updated'});assert.equal(changed.status,200,JSON.stringify(changed.body));
      assert.equal((await f.a('/api/directories/'+input.kind+'/'+id,'DELETE',{version:changed.body.entry.version})).status,200);
    }
    const dual = await f.admin('/api/directories','POST',{kind:'companies',name:'Dual-role private client QA',roles:['customer','supplier'],managerId:f.users[1].managerId,addresses:[]});assert.equal(dual.status,201);
    const visible=(await f.a('/api/directories')).body.companies.find((row:Company)=>row.id===dual.body.entry.id);
    assert.deepEqual(visible.roles,['supplier']);assert.deepEqual(visible.shipmentIds,[]);assert.deepEqual(visible.paymentIds,[]);
    assert.equal((await f.a('/api/directories/companies/'+dual.body.entry.id,'PATCH',{version:1,name:'forged',roles:['supplier'],addresses:[]})).status,403);
    assert.equal((await f.a('/api/shipments/'+f.shipments[1].id)).status,404);
  } finally { await f.close(); }
});

test('directory grants: unknown grants and removed all-data scopes are rejected atomically', async () => {
  const f=await fixture();try {
    const u=f.users[0]; const payload={name:u.name,login:u.login,role:u.role,managerId:u.managerId,active:true,version:u.version,sections:u.sections};
    const before=await readFile(f.store.path,'utf8');
    for(const change of [{directoryGrants:['customers']},{directoryGrants:['oilDepots','oilDepots']},{directoryGrants:'all'},{readScopes:{shipments:'all'}},{directoryScopes:{customers:'all'}}]) assert.equal((await f.admin('/api/auth/users/'+u.id,'PATCH',{...payload,...change})).status,400);
    assert.equal(await readFile(f.store.path,'utf8'),before);
  } finally {await f.close();}
});


test('directory grants: a depot reference reveals only the existing company label and cannot change or claim the hidden client', async () => {
  const f=await fixture();try {
    const depot=await f.admin('/api/directories','POST',{kind:'oilDepots',name:'Linked depot QA',ownerCompanyId:f.customers[1].id});
    assert.equal(depot.status,201);
    await f.grant(['oilDepots']);
    const d=(await f.a('/api/directories')).body;
    const linked=d.companies.find((row:Company)=>row.id===f.customers[1].id);
    assert.ok(linked);assert.deepEqual(linked.roles,[]);assert.equal(linked.inn,undefined);assert.equal(linked.address,undefined);
    assert.deepEqual(linked.shipmentIds,[]);
    const changed=await f.a('/api/directories/oilDepots/'+depot.body.entry.id,'PATCH',{version:0,name:'Linked depot edited QA',ownerCompanyId:f.customers[1].id});
    assert.equal(changed.status,200,JSON.stringify(changed.body));
    assert.equal((await f.a('/api/directories','POST',{kind:'oilDepots',name:'Forged reference QA',ownerCompanyId:f.customers[1].id})).status,403);
    assert.equal((await f.a('/api/directories','POST',{kind:'companies',name:'Forged address QA',roles:['customer'],addresses:[{name:'Loading QA',kind:'loading',loadingActorCompanyId:f.customers[1].id}]})).status,403);
    const created=await f.a('/api/directories','POST',{kind:'addresses',companyId:f.customers[0].id,addressKind:'delivery',name:'Own delivery QA'});assert.equal(created.status,201);
    const changedAddress=await f.a('/api/directories/addresses/'+created.body.entry.id,'PATCH',{version:0,name:'Own delivery edited QA',companyId:f.customers[0].id,addressKind:'delivery'});assert.equal(changedAddress.status,200);
    assert.equal((await f.a('/api/directories/addresses/'+created.body.entry.id,'DELETE',{version:1})).status,200);
    assert.equal((await f.a('/api/directories/customers/'+f.customers[0].id,'DELETE',{version:1})).status,409,'Shipment dependency must still block deletion');
  }finally{await f.close();}
});

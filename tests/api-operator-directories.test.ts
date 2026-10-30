import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { test } from 'node:test';
import { createSnapshotMiddleware } from '../server/local-api';
import { integrationRuntime } from './helpers/trip-saby-integration';
import { decodeOperations, encodeOperations, OperationsStore } from '../server/operations-store';
import { sharedDirectories, type AccountUser, type SectionId } from '../web/src/auth-model';
import type { NamedEntry, OperatorService } from '../web/src/model';
import { readOperatorCatalog } from '../web/src/operator-catalog';

async function fixture() {
  const runtime = await integrationRuntime();
  const store = runtime.store, directory = dirname(store.path);
  let lookups = 0;
  const fetcher: typeof fetch = async (_input, init) => {
    lookups++;
    return new Response(JSON.stringify({ meta: { status: 'ok' }, data: { ИНН: new URLSearchParams(String(init?.body)).get('inn'), НаимСокр: 'Тест Чекко оператор', НаимПолн: 'Полное тестовое наименование', КПП: '770701001', ОГРН: '1027700132195' } }), { headers: { 'Content-Type': 'application/json' } });
  };
  const middleware = createSnapshotMiddleware(runtime.snapshotDirectory, { operationsStore: store, fetcher, checkoApiKey: 'synthetic' });
  const server = createServer((req, res) => middleware(req, res, () => { res.writeHead(404); res.end(); }));
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const client = () => {
    let cookie = '';
    return async (path: string, method = 'GET', body?: unknown) => {
      const response = await fetch(url + path, { method, headers: { cookie, ...(body ? { 'Content-Type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
      if (response.headers.has('set-cookie')) cookie = response.headers.get('set-cookie')!.split(';')[0];
      return { status: response.status, body: await response.json() };
    };
  };
  const owner = client(), password = randomUUID();
  assert.equal((await owner('/api/auth/setup', 'POST', { name: 'Каталоги директор', login: 'catalog-owner', password })).status, 200);
  const employee = async (sections: SectionId[], login = 'catalog-employee') => {
    const person = await owner('/api/directories', 'POST', { kind: 'managers', name: login });
    assert.equal(person.status, 201);
    const created = await owner('/api/auth/users', 'POST', { name: login, login, password, role: 'employee', managerId: person.body.entry.id, sections, directoryGrants: sharedDirectories.map(row => row.id) });
    assert.equal(created.status, 201);
    const api = client();
    assert.equal((await api('/api/auth/login', 'POST', { login, password })).status, 200);
    return { api, user: created.body.user as AccountUser };
  };
  return { owner, employee, client, password, store, directory, base: runtime.base, lookups: () => lookups, close: async () => { await new Promise<void>(done => server.close(() => done())); await runtime.close(); } };
}

test('operator catalogs project defaults without read writes; edit versions persist and empty lists never reseed', async () => {
  const f = await fixture(); try {
    const employee = await f.employee(['directories']);
    const before = await readFile(f.store.path, 'utf8');
    const first = await employee.api('/api/directories');
    assert.equal(first.status, 200);
    assert.deepEqual(first.body.directories.operatorGroups, []);
    const services = first.body.directories.operatorServices as OperatorService[];
    assert.deepEqual(services.map(row => [row.name, row.discountPercent]), [['Роснефть', '10'], ['Лукойл', '10'], ['ГПН', '10'], ['Яндекс', '10'], ['ННК', '10']]);
    assert.equal(new Set(services.map(row => row.id)).size, 5);
    assert.deepEqual((await employee.api('/api/directories')).body.directories.operatorServices, services);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    const changed = await employee.api(`/api/directories/operatorServices/${services[0].id}`, 'PATCH', { version: 0, name: services[0].name, discountPercent: '8,25' });
    assert.equal(changed.status, 200); assert.equal(changed.body.entry.discountPercent, '8.25'); assert.equal(changed.body.entry.version, 1);
    const saved = await readFile(f.store.path, 'utf8');
    assert.equal((await employee.api(`/api/directories/operatorServices/${services[0].id}`, 'PATCH', { version: 0, name: 'stale', discountPercent: '9' })).status, 409);
    for (const discountPercent of ['-1', '100.0000000000000000000001', '0.1234567', '101', '1e2', '', null, 10, '10.2.3']) {
      assert.equal((await employee.api('/api/directories', 'POST', { kind: 'operatorServices', name: 'Invalid', discountPercent })).status, 400, String(discountPercent));
    }
    assert.equal((await employee.api(`/api/directories/operatorServices/${services[0].id}`, 'DELETE', { version: 1 })).status, 400);
    assert.equal(await readFile(f.store.path, 'utf8'), saved);
    const group = await employee.api('/api/directories', 'POST', { kind: 'operatorGroups', name: ' Синтетическая   группа ' });
    assert.equal(group.status, 201); assert.equal(group.body.entry.name, 'Синтетическая группа');
    assert.equal((await employee.api('/api/directories', 'POST', { kind: 'operatorGroups', name: 'синтетическая группа' })).body.created, false);
    assert.equal((await employee.api(`/api/directories/operatorGroups/${group.body.entry.id}`, 'PATCH', { version: 1, name: 'Другое тестовое название' })).status, 200);
    assert.equal((await employee.api(`/api/directories/operatorGroups/${group.body.entry.id}`, 'DELETE', { version: 2 })).status, 400);
    for (const discountPercent of ['0', '100', '0.125']) assert.equal((await employee.api('/api/directories', 'POST', { kind: 'operatorServices', name: `Граница ${discountPercent}`, discountPercent })).status, 201);
    const reloaded = await new OperationsStore(f.directory).read(f.base.provenance.sourceSha256);
    assert.equal(reloaded.directories!.operatorServices!.find(row => row.id === services[0].id)?.discountPercent, '8.25');
    assert.equal(reloaded.directories!.operatorServices!.length, 8);
    assert.equal(reloaded.directories!.operatorGroups![0].name, 'Другое тестовое название');
    for (const bad of [null, [{ id: 'bad', name: 'bad', discountPercent: '101' }], [{ id: 'bad', name: 'bad', discountPercent: '100.0000000000000000000001' }], [{ id: 'bad', name: 'bad', discountPercent: '10', version: -1 }]]) {
      const malformed = structuredClone(reloaded); Object.assign(malformed.directories!, { operatorServices: bad });
      assert.throws(() => decodeOperations(encodeOperations(malformed), f.base.provenance.sourceSha256));
    }
    await f.store.mutate(f.base.provenance.sourceSha256, data => { data.directories!.operatorServices = []; data.directories!.operatorGroups = []; return { changed: true, result: null }; });
    assert.deepEqual((await employee.api('/api/directories')).body.directories.operatorServices, []);
    assert.deepEqual(readOperatorCatalog((await new OperationsStore(f.directory).read(f.base.provenance.sourceSha256)).directories!), { groups: [], services: [] });
  } finally { await f.close(); }
});

test('NNK defaults never extend a saved catalog; explicit addition preserves existing discounts and does not duplicate on replay', async () => {
  const f = await fixture(); try {
    const { api } = await f.employee(['directories']);
    const savedServices: OperatorService[] = [
      { id: 'operator-service-rosneft', name: 'Роснефть', discountPercent: '7.75', version: 3 },
      { id: 'custom-service', name: 'Другой сервис', discountPercent: '3.5', version: 1 },
    ];
    await f.store.mutate(f.base.provenance.sourceSha256, data => {
      data.directories!.operatorServices = structuredClone(savedServices);
      return { changed: true, result: null };
    });
    const before = await readFile(f.store.path, 'utf8');
    assert.deepEqual((await api('/api/directories')).body.directories.operatorServices, savedServices);
    assert.deepEqual(readOperatorCatalog((await new OperationsStore(f.directory).read(f.base.provenance.sourceSha256)).directories!).services, savedServices);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
    const addition = await api('/api/directories', 'POST', { kind: 'operatorServices', name: 'ННК', discountPercent: '10' });
    assert.equal(addition.status, 201);
    assert.equal(addition.body.created, true);
    assert.equal(addition.body.entry.discountPercent, '10');
    const expected = [...savedServices, addition.body.entry];
    assert.deepEqual((await api('/api/directories')).body.directories.operatorServices, expected);
    const repeated = await api('/api/directories', 'POST', { kind: 'operatorServices', name: 'ннк', discountPercent: '10' });
    assert.equal(repeated.status, 200);
    assert.equal(repeated.body.created, false);
    assert.equal(repeated.body.entry.id, addition.body.entry.id);
    assert.deepEqual(readOperatorCatalog((await new OperationsStore(f.directory).read(f.base.provenance.sourceSha256)).directories!).services, expected);
  } finally { await f.close(); }
});

test('explicit catalog grants allow CRUD and INN lookup, while ownership transfer is denied while account and financial administration stays denied', async () => {
  const f = await fixture(); try {
    const { api, user } = await f.employee(['directories']);
    const initial = (await api('/api/directories')).body;
    const company = await api('/api/directories', 'POST', { kind: 'companies', name: 'Компания доступ QA', roles: ['customer', 'supplier'], addresses: [] });
    assert.equal(company.status, 201);
    assert.equal((await api(`/api/directories/companies/${company.body.entry.id}`, 'PATCH', { version: company.body.entry.version, name: 'Компания доступ QA изменена', roles: ['customer', 'supplier'], addresses: [] })).status, 200);
    const created: { kind: string; entry: NamedEntry; extra: Record<string, unknown> }[] = [];
    for (const [kind, extra] of [
      ['managers', {}], ['products', {}], ['paymentForms', {}], ['vehicles', { plate: 'Тестовый автомобиль доступа QA' }],
      ['drivers', { vehicleId: initial.directories.vehicles[0].id }], ['addresses', { companyId: company.body.entry.id, addressKind: 'delivery' }], ['oilDepots', {}],
    ] as const) {
      const name = `Каталог ${kind} QA`, result = await api('/api/directories', 'POST', { kind, name, ...extra });
      assert.equal(result.status, 201, `${kind}: ${JSON.stringify(result.body)}`);
      const edited = await api(`/api/directories/${kind}/${result.body.entry.id}`, 'PATCH', { name: `${name} изменён`, ...extra, version: result.body.entry.version ?? 0 });
      assert.equal(edited.status, 200, `${kind}: ${JSON.stringify(edited.body)}`);
      created.push({ kind, entry: edited.body.entry, extra });
    }
    const manager = created.find(row => row.kind === 'managers')!.entry;
    assert.equal((await api('/api/directories', 'POST', { kind: 'customerManagers', companyId: company.body.entry.id, managerId: manager.id })).status, 403);
    const catalog = (await api('/api/directories')).body;
    assert.ok(catalog.directories.managers.some((row: NamedEntry) => row.id === manager.id));
    assert.equal(catalog.directories.customerManagers.find((row: { companyId: string }) => row.companyId === company.body.entry.id)?.managerId, user.managerId);
    assert.equal((await api(`/api/directories/customerManagers/${company.body.entry.id}`, 'DELETE', { managerId: manager.id })).status, 403);
    for (const row of created.reverse()) assert.equal((await api(`/api/directories/${row.kind}/${row.entry.id}`, 'DELETE', { version: row.entry.version ?? 0 })).status, 200, row.kind);
    assert.equal((await api(`/api/directories/companies/${company.body.entry.id}`, 'DELETE', { version: 2 })).status, 200);
    assert.equal((await api('/api/companies/lookup', 'POST', { inn: '7707083893' })).status, 200);
    assert.equal((await api('/api/companies/from-inn', 'POST', { inn: '7736050003' })).status, 403);
    assert.ok(f.lookups() > 0);
    const before = await readFile(f.store.path, 'utf8');
    for (const [path, method, body] of [
      ['/api/auth/users', 'GET', undefined], ['/api/auth/users', 'POST', { name: 'Denied', login: 'denied', password: f.password, role: 'director' }],
      ['/api/directories/cleanup', 'POST', {}], ['/api/directories/reconcile-customers', 'POST', {}], ['/api/banking/export', 'GET', undefined],
      [`/api/shipments/missing-shipment`, 'DELETE', { version: 1 }],
    ] as const) assert.equal((await api(path, method, body)).status, 403, path);
    assert.equal(await readFile(f.store.path, 'utf8'), before);
  } finally { await f.close(); }
});

test('without directories all catalog writes and INN helpers deny access; revocation is rechecked in the transaction', async () => {
  const f = await fixture(); try {
    const noAccess = await f.employee(['operator'], 'catalog-denied');
    const before = await readFile(f.store.path, 'utf8');
    for (const kind of ['companies', 'managers', 'products', 'paymentForms', 'vehicles', 'drivers', 'addresses', 'oilDepots', 'customerManagers', 'operatorGroups', 'operatorServices']) {
      assert.equal((await noAccess.api('/api/directories', 'POST', { kind, name: 'Denied' })).status, 403, kind);
      for (const method of ['PATCH', 'DELETE']) assert.equal((await noAccess.api(`/api/directories/${kind}/unknown`, method, { version: 0, name: 'Denied' })).status, 403, `${kind} ${method}`);
    }
    for (const path of ['/api/companies/lookup', '/api/companies/from-inn']) assert.equal((await noAccess.api(path, 'POST', { inn: '7707083893' })).status, 403);
    assert.equal(f.lookups(), 0); assert.equal(await readFile(f.store.path, 'utf8'), before);
    const writer = await f.employee(['directories'], 'catalog-revoked');
    const originalMutate = f.store.mutate.bind(f.store);
    let revoke = true;
    f.store.mutate = async (sha, update) => {
      if (revoke) {
        revoke = false;
        await originalMutate(sha, data => { data.accounts!.users.find(user => user.id === writer.user.id)!.sections = []; return { changed: true, result: null }; });
      }
      return originalMutate(sha, update);
    };
    assert.equal((await writer.api('/api/directories', 'POST', { kind: 'operatorGroups', name: 'Revoked mutation' })).status, 403);
    assert.ok(!readOperatorCatalog((await f.store.read(f.base.provenance.sourceSha256)).directories!).groups.some(row => row.name === 'Revoked mutation'));
  } finally { await f.close(); }
});

test('directory editor cannot delete a driver account indirectly or change account permissions', async () => {
  const f = await fixture(); try {
    const writer = await f.employee(['directories']);
    const vehicle = await writer.api('/api/directories', 'POST', { kind: 'vehicles', plate: 'Автомобиль связанного водителя QA' });
    const driver = await writer.api('/api/directories', 'POST', { kind: 'drivers', name: 'Связанный водитель QA', vehicleId: vehicle.body.entry.id });
    const user = await f.owner(`/api/drivers/${driver.body.entry.id}/access`, 'POST', { version: 0, action: 'issue' });
    assert.equal(user.status, 200, JSON.stringify(user.body));
    const before = await f.store.read(f.base.provenance.sourceSha256);
    const denied = await writer.api(`/api/directories/drivers/${driver.body.entry.id}`, 'DELETE', { version: 0 });
    assert.equal(denied.status, 403); assert.match(denied.body.error, /учётная запись/);
    assert.equal((await writer.api(`/api/auth/users/${user.body.access.userId}`, 'PATCH', { role: 'employee', version: 1 })).status, 403);
    assert.deepEqual((await f.store.read(f.base.provenance.sourceSha256)).accounts, before.accounts);
    assert.equal((await writer.api(`/api/directories/drivers/${driver.body.entry.id}`, 'PATCH', { name: 'Связанный водитель QA исправлен', vehicleId: vehicle.body.entry.id, version: 0 })).status, 200);
    assert.deepEqual((await f.store.read(f.base.provenance.sourceSha256)).accounts, before.accounts);
    assert.equal((await f.owner(`/api/directories/drivers/${driver.body.entry.id}`, 'DELETE', { version: 1 })).status, 200);
    assert.equal((await f.store.read(f.base.provenance.sourceSha256)).accounts!.users.find(row => row.id === user.body.access.userId)?.active, false);
  } finally { await f.close(); }
});

test('directory company responses contain requisites but never source operation/payment references or private flags', async () => {
  const f = await fixture(); try {
    const { api } = await f.employee(['directories']);
    await f.store.mutate(f.base.provenance.sourceSha256, data => {
      data.companies.find(company => company.id === 'supplier')!.flags = ['PRIVATE-COMPANY-FLAG'];
      return { changed: true, result: null };
    });
    const full = (await f.owner('/api/directories')).body;
    const supplier = full.companies.find((company: { id: string }) => company.id === 'supplier');
    assert.ok(supplier.shipmentIds.length > 0);
    const assertSafe = (company: { id: string; inn: string; shipmentIds: string[]; paymentIds: string[]; managerLabels: string[]; flags: string[] }) => {
      assert.ok(company.inn);
      for (const key of ['shipmentIds', 'paymentIds', 'managerLabels', 'flags'] as const) assert.deepEqual(company[key], []);
    };
    const found = await api('/api/companies/from-inn', 'POST', { inn: supplier.inn });
    assert.equal(found.status, 403);
    const addresses = full.directories.addresses.filter((row: { companyId: string }) => row.companyId === supplier.id).map(({ id, name, kind }: { id: string; name: string; kind: string }) => ({ id, name, kind }));
    const edited = await api(`/api/directories/companies/${supplier.id}`, 'PATCH', { version: supplier.version ?? 0, name: 'Поставщик исправлен', inn: supplier.inn, roles: ['supplier'], addresses });
    assert.equal(edited.status, 200); assertSafe(edited.body.entry);
    const restored = await api('/api/directories', 'POST', { name: 'Поставщик исправлен', kind: 'companies', inn: supplier.inn, roles: ['customer', 'supplier'], addresses: [] });
    assert.equal(restored.status, 200); assertSafe(restored.body.entry);
    const stored = await f.store.read(f.base.provenance.sourceSha256);
    assert.deepEqual(stored.companies.find(company => company.id === supplier.id)?.flags, ['PRIVATE-COMPANY-FLAG']);
    const mutate = f.store.mutate.bind(f.store);
    let insertRace = true;
    f.store.mutate = async (sha, update) => {
      if (insertRace) {
        insertRace = false;
        await mutate(sha, data => {
          data.companies.push({ id: 'race-company', name: 'Параллельный справочник', inn: '7736050003', roles: ['supplier'], shipmentIds: [], paymentIds: [], managerLabels: [], flags: ['PRIVATE-RACE-FLAG'] });
          return { changed: true, result: null };
        });
      }
      return mutate(sha, update);
    };
    const duplicate = await f.owner('/api/companies/from-inn', 'POST', { inn: '7736050003' });
    assert.equal(duplicate.status, 200); assert.equal(duplicate.body.company.id, 'race-company'); assert.deepEqual(duplicate.body.company.flags, ['PRIVATE-RACE-FLAG']);
  } finally { await f.close(); }
});

test('service background and dated discounts persist; saved operations remain exact and backdated new operations use the previous rate', async () => {
  const f = await fixture(); try {
    const day = new Intl.DateTimeFormat('sv-SE', {timeZone:'Europe/Moscow',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date());
    const yesterday = new Date(Date.parse(day)-86400000).toISOString().slice(0,10);
    const service = (await f.owner('/api/operator')).body.services[0];
    const fuel = (date: string, discountPercent: string, serviceVersion: number) => ({schemaVersion:2,date,name:'История скидок',serviceId:service.id,serviceVersion,discountPercent,litres:'100',pricePerLitre:'10',amountMode:'auto',amount:String(1000*(1-Number(discountPercent)/100)),recipientText:'Синтетический получатель',comment:'',idempotencyKey:randomUUID()});
    const before = await f.owner('/api/operator/refuellings','POST',fuel(day,'10',0));
    assert.equal(before.status,201,JSON.stringify(before.body));
    const saved = (await f.owner('/api/operator')).body.refuellings;
    const patch = (version: number, discountPercent: string, extra: Record<string,unknown>={}) => f.owner('/api/directories/operatorServices/'+service.id,'PATCH',{version,name:'Новое название',discountPercent,...extra});
    const changed=await patch(0,'12',{backgroundColor:'#ABCDEF'}); assert.equal(changed.status,200);
    assert.equal(changed.body.entry.backgroundColor,'#abcdef');
    assert.deepEqual(changed.body.entry.discountHistory,[{effectiveFrom:'0001-01-01',discountPercent:'10'},{effectiveFrom:day,discountPercent:'12'}]);
    const older=await f.owner('/api/operator/refuellings','POST',fuel(yesterday,'10',1)); assert.equal(older.status,201,JSON.stringify(older.body));
    assert.equal((await f.owner('/api/operator/refuellings','POST',fuel(day,'10',1))).status,409);
    const current=await f.owner('/api/operator/refuellings','POST',fuel(day,'12',1)); assert.equal(current.status,201);
    assert.equal((await patch(0,'13')).status,409);
    for(const backgroundColor of ['red','#123','url(x)',null,44]) assert.equal((await patch(1,'12',{backgroundColor})).status,400);
    const renamed=await patch(1,'12');assert.equal(renamed.status,200);assert.deepEqual(renamed.body.entry.discountHistory,changed.body.entry.discountHistory);assert.equal(renamed.body.entry.backgroundColor,'#abcdef');
    const twice=await patch(2,'15');assert.equal(twice.status,200);assert.equal(twice.body.entry.discountHistory.length,2);assert.equal(twice.body.entry.discountHistory[1].discountPercent,'15');
    const state=(await f.owner('/api/operator')).body;
    assert.deepEqual(state.refuellings.find((r:{id:string})=>r.id===before.body.id),saved[0]);
    assert.equal(state.refuellings.find((r:{id:string})=>r.id===current.body.id).discountPercent,'12');
    const reloaded=await new OperationsStore(f.directory).read(f.base.provenance.sourceSha256);
    assert.deepEqual(readOperatorCatalog(reloaded.directories!).services.find(s=>s.id===service.id),twice.body.entry);
  }finally{await f.close();}
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes } from 'node:crypto';
import { OperationsStore } from '../server/operations-store';
import { ApiError } from '../server/api-error';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { SberService } from '../server/banking/sber-service';
import { decryptSberTokens, normalizeSberOperation, normalizeSberSummary, parseSberPage, SBER_ACCOUNT, sberAmount, sberPeriod } from '../server/banking/sber-domain';
import { SberHttpError, type SberRequest } from '../server/banking/sber-client';

const DAY = '2026-09-15';
const money = (amount: string) => ({ amount, currencyName: 'RUR' });
const summary = (incoming = '0.3', closing = '10.3') => ({ openingBalance: money('10'), creditTurnover: money(incoming), debitTurnover: money('0'), closingBalance: money(closing) });
const operation = (operationId = 'fixture-1', amount = '0.1') => ({ operationId, direction: 'CREDIT', amount: money(amount), operationDate: `${DAY}T09:31:30`, documentDate: DAY, number: '15', paymentPurpose: 'По договору поставки', rurTransfer: { payerName: 'Тестовый контрагент', payerInn: '7812345678', payerAccount: '40702810000000012345', payerBankBic: '044525225', payeeAccount: SBER_ACCOUNT }, uuid: 'fixture-uuid', hashAbc: 'fixture-hash' });
const environment = () => ({
  ARTEL_BANK_SBER_NK_CLIENT_ID: 'fixture-client', ARTEL_BANK_SBER_NK_CLIENT_SECRET: 'fixture-secret',
  ARTEL_BANK_SBER_NK_ACCESS_TOKEN: 'fixture-access', ARTEL_BANK_SBER_NK_REFRESH_TOKEN: 'fixture-refresh',
  ARTEL_BANK_SBER_NK_TLS_PFX_BASE64: 'fixture-pfx', ARTEL_BANK_SBER_NK_TLS_PASSPHRASE: 'fixture-passphrase', ARTEL_BANK_SBER_NK_TLS_CA_BASE64: 'fixture-ca',
  ARTEL_BANK_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
});
const simpleRequest: SberRequest = async (_env, request) => request.path.endsWith('/summary') ? summary() : request.path.endsWith('/transactionId') ? operation(request.query?.id) : { transactions: [operation('fixture-1', '0.1'), operation('fixture-2', '0.2')], _links: [] };
const basePromise = loadSnapshot();
async function runtime(request: SberRequest = simpleRequest) {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-sber-test-')), store = new OperationsStore(directory), base = await basePromise, env = environment();
  const service = new SberService(store, base.provenance.sourceSha256, env, request);
  return { directory, store, base, env, service, close: () => rm(directory, { recursive: true, force: true }) };
}

test('Sber schema preserves exact money, flat party fields, source identifiers and missing daily amounts', () => {
  const row = normalizeSberOperation(operation('900719925474099312345', '12345678901234567890.123456789'), DAY);
  assert.equal(row.amount, '12345678901234567890.123456789'); assert.equal(row.direction, 'incoming'); assert.equal(row.bookedAt, `${DAY}T09:31:30`);
  assert.equal(row.payer.account, '40702810000000012345'); assert.equal(row.bankData.uuid, 'fixture-uuid'); assert.equal(row.bankData.hashAbc, 'fixture-hash');
  const empty = normalizeSberSummary({}, DAY);
  assert.equal(empty.openingBalance, null); assert.equal(empty.incoming, null); assert.equal(empty.status, 'partial');
  assert.equal(normalizeSberSummary({ ...summary(), openingBalance: money('-1.25') }, DAY).openingBalance, '-1.25');
  assert.throws(() => sberAmount(0.1)); assert.throws(() => normalizeSberOperation({ ...operation(), direction: 'UNKNOWN' }, DAY));
  assert.throws(() => parseSberPage({ transactions: [], _links: [{rel:'next',href:'?page=1'}] }, DAY, 1));
  assert.throws(() => parseSberPage({ transactions: [], _links: [{rel:'next',href:'?page=2&accountNumber=wrong'}] }, DAY, 1));
  const clean = normalizeSberOperation({ ...operation(), access_token: 'never-persist', nested: { clientSecret: 'never-persist' } }, DAY);
  assert.ok(!JSON.stringify(clean).includes('never-persist'));
  assert.throws(() => sberPeriod('2026-09-31', '2026-09-31'));
  assert.throws(() => sberPeriod('2026-08-01', DAY));
  assert.throws(() => sberPeriod('2099-01-01', '2099-01-02'));
});

test('Sber paginates with account/date/page, commits a complete day and deduplicates repeated synchronization without touching CRM data', async () => {
  const captured: { path: string; query?: Record<string, string> }[] = [];
  const r = await runtime(async (_env, request) => {
    captured.push(request);
    if (request.path.endsWith('/summary')) return summary();
    if (request.query?.page === '1') return { transactions: [operation('one', '0.1')], _links: [{rel:'next',href:`?accountNumber=${SBER_ACCOUNT}&statementDate=${DAY}&page=2`}] };
    return { transactions: [operation('one', '0.1'), operation('two', '0.2')], _links: [] };
  });
  try {
    const before = await r.store.read(r.base.provenance.sourceSha256);
    await r.service.start(DAY, DAY);
    assert.equal(captured.length, 0);
    assert.deepEqual(await r.service.tick(), {pending:true});
    assert.equal((await r.service.list(new URLSearchParams({from:DAY,to:DAY}))).operations.length, 0);
    assert.deepEqual(await r.service.tick(), {pending:false});
    const first = await r.service.list(new URLSearchParams({from:DAY,to:DAY}));
    assert.equal(first.operations.length, 2); assert.equal(first.days[0].incoming, '0.3'); assert.ok(first.lastSuccessAt); assert.equal(first.progress, undefined);
    await r.service.start(DAY, DAY); await r.service.tick(); await r.service.tick();
    const after = await r.store.read(r.base.provenance.sourceSha256);
    assert.equal(after.sber!.operations.length, 2); assert.equal(after.sber!.days.length, 1);
    const {revision: _beforeRevision, ...beforeRest} = before;
    const {revision: _afterRevision, sber: _sber, ...afterRest} = after;
    assert.deepEqual(afterRest, beforeRest);
    assert.deepEqual(captured[1].query, {accountNumber:SBER_ACCOUNT,statementDate:DAY,page:'1'});
    assert.equal(captured[2].query?.page, '2');
    for (const q of ['контрагент', '7812345678', '40702810000000012345', 'поставки']) assert.equal((await r.service.list(new URLSearchParams({from:DAY,to:DAY,q}))).operations.length, 2);
    assert.equal((await r.service.list(new URLSearchParams({from:DAY,to:DAY,direction:'outgoing'}))).operations.length, 0);
    assert.deepEqual(first.operations[0].bankData, {});
    const raw = await readFile(r.store.path, 'utf8');
    assert.ok(!raw.includes('fixture-access')); assert.ok(!raw.includes('fixture-refresh'));
    assert.equal(decryptSberTokens(after.sber!.encryptedTokens!, r.env).accessToken, 'fixture-access');
  } finally { await r.close(); }
});

test('failed Sber page leaves prior complete day and success timestamp, restart replaces only the fully downloaded day', async () => {
  let fail = false;
  const r = await runtime(async (_env, request) => {
    if (request.path.endsWith('/summary')) return summary('0.1', '10.1');
    if (!fail) return {transactions:[operation('original')],_links:[]};
    if (request.query?.page === '1') return {transactions:[operation('new')],_links:[{rel:'next',href:'?page=2'}]};
    throw new SberHttpError(503);
  });
  try {
    await r.service.start(DAY, DAY); await r.service.tick();
    const before = await r.service.list(new URLSearchParams({from:DAY,to:DAY}));
    fail = true; await r.service.start(DAY, DAY); await r.service.tick(); await r.service.tick();
    const failed = await r.service.list(new URLSearchParams({from:DAY,to:DAY}));
    assert.equal(failed.operations[0].bankOperationId, 'original'); assert.equal(failed.lastSuccessAt, before.lastSuccessAt); assert.ok(failed.lastError); assert.ok(failed.progress?.nextAttemptAt);
    assert.deepEqual(failed.days, before.days);
    fail = false; await r.service.start(DAY, DAY); await r.service.tick();
    assert.equal((await r.service.list(new URLSearchParams({from:DAY,to:DAY}))).lastError, undefined);
  } finally { await r.close(); }
});

test('summary 404 remains unknown while successful transactions stay available', async () => {
  const r = await runtime(async (_env, request) => { if (request.path.endsWith('/summary')) throw new SberHttpError(404); return {transactions:[operation()],_links:[]}; });
  try {
    await r.service.start(DAY, DAY); await r.service.tick();
    const data = await r.service.list(new URLSearchParams({from:DAY,to:DAY}));
    assert.equal(data.operations.length, 1); assert.equal(data.days[0].closingBalance, null); assert.equal(data.days[0].status, 'partial'); assert.ok(data.lastError); assert.equal(data.lastSuccessAt, undefined);
  } finally { await r.close(); }
});

test('a partial or inconsistent Sber replacement never erases a previously complete daily statement', async () => {
  let mode: 'complete' | 'partial' | 'mismatch' = 'complete';
  const r = await runtime(async (_env, request) => {
    if (request.path.endsWith('/summary')) return mode === 'partial' ? {} : summary();
    return { transactions: mode === 'mismatch' ? [operation('unexpected', '5')] : [operation('one', '0.1'), operation('two', '0.2')], _links: [] };
  });
  try {
    await r.service.start(DAY, DAY); await r.service.tick();
    const before = await r.service.list(new URLSearchParams({ from: DAY, to: DAY }));
    for (const next of ['partial', 'mismatch'] as const) {
      mode = next; await r.service.start(DAY, DAY); await r.service.tick();
      const failed = await r.service.list(new URLSearchParams({ from: DAY, to: DAY }));
      assert.deepEqual(failed.operations, before.operations); assert.deepEqual(failed.days, before.days); assert.equal(failed.lastSuccessAt, before.lastSuccessAt); assert.ok(failed.lastError);
      assert.equal((await r.store.read(r.base.provenance.sourceSha256)).sber!.job!.page, 1);
    }
  } finally { await r.close(); }
});

test('detail changes to amount or bank ownership require a whole-day refresh and retain cached details', async () => {
  let changedOwner = false;
  const r = await runtime(async (_env, request) => {
    if (request.path.endsWith('/transactionId')) return changedOwner ? { ...operation(request.query?.id), rurTransfer: {payeeAccount:'40702810000000099999'} } : operation(request.query?.id, '99');
    return simpleRequest(_env, request);
  });
  try {
    await r.service.start(DAY, DAY); await r.service.tick();
    const prior = (await r.store.read(r.base.provenance.sourceSha256)).sber!.operations[0];
    await assert.rejects(r.service.enrich(prior.id), error => error instanceof ApiError && error.status === 409);
    changedOwner = true;
    await assert.rejects(r.service.enrich(prior.id), error => error instanceof ApiError && error.status === 502);
    assert.deepEqual(await r.service.operation(prior.id), prior);
  } finally { await r.close(); }
});

test('Sber rate-limit response persists its Retry-After before allowing another request', async () => {
  let calls = 0;
  const r = await runtime(async () => { calls++; throw new SberHttpError(429, 120); });
  try {
    await r.service.start(DAY, DAY); await r.service.tick();
    const state = (await r.store.read(r.base.provenance.sourceSha256)).sber!;
    assert.ok(Date.parse(state.job!.nextAttemptAt!) > Date.now() + 115000);
    await r.service.tick(); assert.equal(calls, 1);
  } finally { await r.close(); }
});

test('Sber storage conflicts retry pure mutations without repeating bank I/O', async () => {
  let calls = 0, conflicts = 3;
  const r = await runtime(async (...args) => { calls++; return simpleRequest(...args); });
  try {
    const service = new SberService({read:source=>r.store.read(source),mutate:async (source, update) => {if(conflicts-->0)throw new ApiError(409,'fixture conflict'); return r.store.mutate(source,update);}}, r.base.provenance.sourceSha256,r.env,r.service.request);
    await service.start(DAY,DAY); await service.tick();
    assert.equal(calls,2); assert.equal((await service.list(new URLSearchParams({from:DAY,to:DAY}))).operations.length,2);
  } finally { await r.close(); }
});

test('Sber durable lease serializes concurrent requests and stale response cannot overwrite its successor', async () => {
  let release!: () => void, started!: () => void, transactions = 0;
  const waiting = new Promise<void>(resolve => {release=resolve;}), begun = new Promise<void>(resolve=>{started=resolve;});
  const r = await runtime(async (_env, request) => {
    if (request.path.endsWith('/summary')) return transactions === 0 ? summary('1','11') : summary('2','12');
    transactions++;
    if (transactions === 1) { started(); await waiting; return {transactions:[operation('same','1')],_links:[]}; }
    return {transactions:[operation('same','2')],_links:[]};
  });
  try {
    await r.service.start(DAY,DAY);
    const slow = r.service.tick(); await begun;
    await r.service.tick(); assert.equal(transactions,1);
    await r.store.mutate(r.base.provenance.sourceSha256,data=>{data.sber!.lease!.until=0;return {result:null,changed:true};});
    await r.service.tick(); release(); await slow;
    const data = await r.service.list(new URLSearchParams({from:DAY,to:DAY}));
    assert.equal(data.operations[0].amount,'2'); assert.equal(data.lastError,undefined);
  } finally { release(); await r.close(); }
});

test('Sber token refresh saves a new encrypted pair before retry and details use official id/operationDate parameters', async () => {
  let rejected = false, detailQuery: Record<string,string> | undefined;
  const r = await runtime(async (_env, request) => {
    if(request.form)return {access_token:'rotated-access',refresh_token:'rotated-refresh',expires_in:'3600'};
    if(!rejected){rejected=true;throw new SberHttpError(401);}
    assert.equal(request.accessToken,'rotated-access');
    if(request.path.endsWith('/transactionId')){detailQuery=request.query;return {...operation(request.query?.id),paymentPurpose:'Полные реквизиты из банка'};}
    return simpleRequest(_env,request);
  });
  try {
    await r.service.start(DAY,DAY);await r.service.tick();
    const state=(await r.store.read(r.base.provenance.sourceSha256)).sber!;
    assert.equal(decryptSberTokens(state.encryptedTokens!,r.env).refreshToken,'rotated-refresh');
    const updated=await r.service.enrich(state.operations[0].id);
    assert.deepEqual(detailQuery,{accountNumber:SBER_ACCOUNT,id:state.operations[0].bankOperationId,operationDate:DAY});
    assert.equal(updated.purpose,'Полные реквизиты из банка');assert.ok(updated.detailsFetchedAt);
    assert.ok(!(await readFile(r.store.path,'utf8')).includes('rotated-refresh'));
  } finally {await r.close();}
});

test('every Sber endpoint requires CRM login/management; browser and snapshot never receive tokens', async () => {
  const r=await runtime();
  const middleware=createSnapshotMiddleware(undefined,{operationsStore:r.store,bankEnvironment:r.env,sberRequest:simpleRequest});
  const server=createServer((req,res)=>middleware(req,res,()=>{res.writeHead(404);res.end();}));
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const baseUrl=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const request=(path:string,cookie='',body?:unknown)=>fetch(baseUrl+path,{...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{}),headers:{cookie,'Content-Type':'application/json'}});
  const endpoints: [string,unknown?][]=[['/api/banking/sber/statements'],['/api/banking/sber/sync',{from:DAY,to:DAY}],['/api/banking/sber/continue',{}],[`/api/banking/sber/operations/${'0'.repeat(64)}`],[`/api/banking/sber/operations/${'0'.repeat(64)}/refresh`,{}]];
  endpoints.push(...endpoints.map(([path, body]): [string, unknown?] => [path.replace('/sber/', '/sber/sber-artel/'), body]));
  try {
    for(const [path,body]of endpoints)assert.equal((await request(path,'',body)).status,401,path);
    const password=randomBytes(20).toString('hex');
    const setup=await request('/api/auth/setup','',{name:'QA',login:'sber.qa',password}),cookie=setup.headers.get('set-cookie')!.split(';')[0];
    const snapshot=await(await request('/api/snapshot',cookie)).json();
    assert.equal((await request('/api/banking/sber/sync',cookie,{from:DAY,to:DAY})).status,200);
    assert.equal((await request('/api/banking/sber/continue',cookie,{})).status,200);
    const list=await(await request('/api/banking/sber/statements',cookie)).json();assert.equal(list.operations.length,2);
    const artelList = await (await request('/api/banking/sber/sber-artel/statements', cookie)).json();
    assert.equal(artelList.account, '40702810538000003495'); assert.equal(artelList.inn, '9721079780'); assert.equal(artelList.operations.length, 0);
    assert.ok(!JSON.stringify(artelList).includes('encryptedTokens'));
    const response=JSON.stringify(await(await request('/api/snapshot',cookie)).json());
    assert.ok(!response.includes('encryptedTokens'));assert.ok(!response.includes('fixture-access'));
    await request('/api/auth/users',cookie,{name:'Manager',login:'sber.manager',password,role:'manager',managerId:snapshot.directories.managers[0].id});
    const login=await request('/api/auth/login','',{login:'sber.manager',password}),manager=login.headers.get('set-cookie')!.split(';')[0];
    for(const [path,body]of endpoints)assert.equal((await request(path,manager,body)).status,403,path);
    assert.equal((await request('/api/banking/sber/sync',cookie,{from:DAY,to:'2099-01-01'})).status,400);
  }finally{await new Promise<void>(done=>server.close(()=>done()));await r.close();}
});

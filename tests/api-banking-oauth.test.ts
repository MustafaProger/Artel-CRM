import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createServer, type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { randomBytes, createHash } from 'node:crypto';
import { OperationsStore } from '../server/operations-store';
import { createSnapshotMiddleware, loadSnapshot } from '../server/local-api';
import { sameOrigin } from '../server/cloud-auth';
import { BankingService } from '../server/banking/service';
import { sberCallbackPath, sberReadScope, validateSberTokens, SberOAuthError, sberOAuthAvailability, sberTokenDiagnostics } from '../server/banking/oauth';
import { decryptTokens, type BankRequest } from '../server/banking/transport';
import { accountNumber, fixtureEnvironment } from './banking-fixtures';

const origin = 'https://crm.example';
const environment = { ...fixtureEnvironment, ARTEL_BANK_SBER_NK_REDIRECT_URI: origin + sberCallbackPath, ARTEL_BANK_SBER_NK_EXPECTED_INN: '7700000000', ARTEL_BANK_SBER_NK_OAUTH_ISSUER: 'https://issuer.example', ARTEL_BANK_SBER_NK_TLS_CA_BASE64: 'fixture' };
delete (environment as Record<string, unknown>).ARTEL_BANK_SBER_NK_REFRESH_TOKEN;
const jwt = (claims: unknown) => `${Buffer.from('{"alg":"gost34.10-2012"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.Zml4dHVyZQ`;
const token = (nonce: string, updates = {}) => ({ access_token: 'fixture-access', refresh_token: 'fixture-refresh', expires_in: '3600', token_type: 'Bearer', scope: sberReadScope, id_token: jwt({ iss: environment.ARTEL_BANK_SBER_NK_OAUTH_ISSUER, aud: environment.ARTEL_BANK_SBER_NK_CLIENT_ID, nonce, sub: 'fixture-user', exp: Math.floor(Date.now()/1000)+3600, iat: Math.floor(Date.now()/1000), inn:'7700000000', orgFullName:'Fixture Company', accounts:[{accountNumber}], ...updates }) });

test('OAuth callback binds browser and live CRM session; PKCE, single use and encrypted storage work without Strict session cookie', async () => {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-oauth-'));
  const store = new OperationsStore(directory), base = await loadSnapshot();
  let nonce = '', calls = 0, challenge = '';
  let claimsOverride = {};
  const http: BankRequest = async (_config, path, _token, form) => {
    assert.equal(path, '/ic/sso/api/v2/oauth/token'); calls++;
    assert.equal(form?.get('grant_type'), 'authorization_code');
    assert.equal(createHash('sha256').update(form!.get('code_verifier')!).digest('base64url'), challenge);
    return token(nonce, claimsOverride);
  };
  const middleware = createSnapshotMiddleware(undefined, { operationsStore:store, bankEnvironment:environment, bankRequest:http, authorizeRequest:sameOrigin, setupToken:'fixture-setup', secureCookies:true });
  const server = createServer((req,res)=>{req.headers.host='crm.example';middleware(req,res,()=>{res.writeHead(404);res.end();});});
  await new Promise<void>(done=>server.listen(0,'127.0.0.1',done));
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const req = (path:string, cookie='', body?:unknown, cross=false) => fetch(baseUrl+path,{redirect:'manual',headers:{host:'crm.example',origin:cross?'https://sbi.sberbank.ru:9443':origin,'sec-fetch-site':cross?'cross-site':'same-origin',cookie,'Content-Type':'application/json'},...(body!==undefined?{method:'POST',body:JSON.stringify(body)}:{})});
  try {
    const setup = await req('/api/auth/setup','',{name:'Fixture',login:'oauth.test',password:randomBytes(24).toString('hex'),setupToken:'fixture-setup'});
    assert.equal(setup.status,200);
    const cookie=setup.headers.get('set-cookie')!.split(';')[0];
    assert.match(setup.headers.get('set-cookie')!,/SameSite=Strict/);
    const start=await req('/api/banking/connections/sber-nk-artel/authorize',cookie,{});
    assert.equal(start.status,200,await start.clone().text());
    const url=new URL((await start.json()).authorizationUrl);
    nonce=url.searchParams.get('nonce')!; challenge=url.searchParams.get('code_challenge')!;
    assert.equal(url.searchParams.get('scope'),sberReadScope);
    assert.equal(url.searchParams.get('code_challenge_method'),'S256');
    const callbackCookie=start.headers.get('set-cookie')!.split(';')[0];
    assert.match(start.headers.get('set-cookie')!,/HttpOnly; Secure; SameSite=Lax/);
    const callback=sberCallbackPath+'?'+new URLSearchParams({state:url.searchParams.get('state')!,code:'fixture-code'});
    assert.equal((await req('/api/banking',cookie,undefined,true)).status,403);
    const missingBrowser = await req(callback,'',undefined,true);
    assert.equal(missingBrowser.status,400);
    assert.match(missingBrowser.headers.get('content-type')!,/text\/html/);
    assert.match(missingBrowser.headers.get('content-security-policy')!,/default-src 'none'/);
    const failurePage = await missingBrowser.text();
    assert.match(failurePage,/Вернуться в «Платежи»/);
    assert.ok(!failurePage.includes('fixture-code') && !failurePage.includes(url.searchParams.get('state')!));
    assert.equal(calls,0);
    const before=await store.read(base.provenance.sourceSha256);
    const accepted=await req(callback,callbackCookie,undefined,true);
    assert.equal(accepted.status,303,await accepted.text());
    assert.equal(accepted.headers.get('location'),'/#payments');
    assert.equal((await req(callback,callbackCookie,undefined,true)).status,400);
    assert.equal(calls,1);
    const after=await store.read(base.provenance.sourceSha256);
    assert.deepEqual(after.shipments,before.shipments); assert.deepEqual(after.paymentAllocations,before.paymentAllocations);
    assert.ok(!JSON.stringify(after).includes('fixture-refresh'));
    const saved=after.banking!.connections['sber-nk-artel'];
    assert.equal(decryptTokens(saved.encryptedTokens!,environment.ARTEL_BANK_ENCRYPTION_KEY,'sber-nk-artel').scope,sberReadScope);
    const service=new BankingService(store,base.provenance.sourceSha256,environment,http);
    assert.equal((await service.list(new URLSearchParams())).connections[0].state,'ready');
    // A rejected bank reply leaves existing tokens intact and stores only safe diagnostics.
    const failedStart = await req('/api/banking/connections/sber-nk-artel/authorize',cookie,{});
    const failedUrl = new URL((await failedStart.json()).authorizationUrl);
    nonce = failedUrl.searchParams.get('nonce')!; challenge = failedUrl.searchParams.get('code_challenge')!;
    claimsOverride = {iss:'https://sbi.sberbank.ru:9443'};
    const rejected = await req(sberCallbackPath+'?'+new URLSearchParams({state:failedUrl.searchParams.get('state')!,code:'fixture-code'}),failedStart.headers.get('set-cookie')!.split(';')[0],undefined,true);
    assert.equal(rejected.status,400);
    assert.match(await rejected.text(),/Эмитент токена/);
    const failedState = (await store.read(base.provenance.sourceSha256)).banking!.connections['sber-nk-artel'];
    assert.equal(failedState.encryptedTokens,saved.encryptedTokens);
    assert.equal(failedState.encryptedOAuth,undefined);
    assert.equal(failedState.lastOAuthError?.reason,'issuer_mismatch');
    assert.equal(failedState.lastOAuthError?.issuer,'https://sbi.sberbank.ru:9443');
    assert.ok(!JSON.stringify(failedState.lastOAuthError).includes('fixture-refresh'));
    // Revoking the initiating CRM session also revokes an unfinished authorization.
    const second=await req('/api/banking/connections/sber-nk-artel/authorize',cookie,{});
    const secondUrl=new URL((await second.json()).authorizationUrl);
    await req('/api/auth/logout',cookie,{});
    assert.equal((await req(sberCallbackPath+'?'+new URLSearchParams({state:secondUrl.searchParams.get('state')!,code:'fixture-code'}),second.headers.get('set-cookie')!.split(';')[0],undefined,true)).status,400);
    assert.equal(calls,2);
  } finally { await new Promise<void>(done=>server.close(()=>done())); await rm(directory,{recursive:true,force:true}); }
});

test('OAuth rejects broader rights, wrong company/account, issuer, audience, nonce and expired identity', async () => {
  const service=new BankingService({} as OperationsStore,'fixture',environment);
  const config=service.config('sber-nk-artel');
  assert.equal(validateSberTokens(token('nonce'),config,'nonce').refresh_token,'fixture-refresh');
  assert.throws(()=>validateSberTokens({...token('nonce'),scope:sberReadScope+' PAY_DOC_RU'},config,'nonce'));
  for (const claims of [{inn:'9999999999'},{accounts:[]},{iss:'https://evil.example'},{aud:'wrong'},{nonce:'wrong'},{exp:1},{iat:1},{aud:[environment.ARTEL_BANK_SBER_NK_CLIENT_ID,'other']}]) assert.throws(()=>validateSberTokens(token('nonce',claims),config,'nonce'));
});


test('OAuth identifies token validation failures without exposing bank response values', () => {
  const config = new BankingService({} as OperationsStore, 'fixture', environment).config('sber-nk-artel');
  assert.equal(validateSberTokens({...token('nonce'), token_type:'bearer'},config,'nonce').refresh_token,'fixture-refresh');
  for (const [claims, reason] of [
    [{iss:'https://untrusted.example/private-secret'},'issuer_mismatch'],
    [{aud:'private-client-id'},'audience_mismatch'],
    [{nonce:'private-nonce'},'nonce_mismatch'],
    [{sub:''},'subject_missing'],
    [{exp:1},'token_expired'],
  ] as const) assert.throws(() => validateSberTokens(token('nonce',claims),config,'nonce'), error => {
    assert.ok(error instanceof SberOAuthError);
    assert.equal(error.reason, reason);
    assert.ok(!error.message.includes('private-'));
    return true;
  });
});


test('Local OAuth cannot create a cloud callback attempt; missing configuration is explicit', () => {
  const config = new BankingService({} as OperationsStore, 'fixture', environment).config('sber-nk-artel');
  const local = {headers:{host:'127.0.0.1:5173'}} as IncomingMessage;
  const unavailable = sberOAuthAvailability(config,local);
  assert.equal(unavailable.available,false);
  assert.match(unavailable.message!,/другой адрес CRM/);
  assert.equal(sberOAuthAvailability(config,{headers:{host:'crm.example'}} as IncomingMessage).available,true);
  assert.equal(sberOAuthAvailability({...config,env:{}},local).available,false);
});


test('Sber requests issuer, audience and subject claims explicitly and distinguishes a missing issuer', () => {
  for (const claim of ['iss','aud','sub']) assert.ok(sberReadScope.split(' ').includes(claim));
  assert.deepEqual(sberReadScope.split(' ').filter(scope => scope === scope.toUpperCase()), ['GET_STATEMENT_ACCOUNT']);
  const config = new BankingService({} as OperationsStore, 'fixture', environment).config('sber-nk-artel');
  assert.throws(() => validateSberTokens(token('nonce',{iss:undefined}),config,'nonce'), error => error instanceof SberOAuthError && error.reason === 'issuer_missing');
});

test('Sber diagnostic accepts exact public issuer paths and only boolean verification results', () => {
  const config = new BankingService({} as OperationsStore, 'fixture', environment).config('sber-nk-artel');
  const issuer = 'https://sbi.sberbank.ru:9443/ic/sbbid';
  const result = sberTokenDiagnostics(token('private-nonce',{iss:issuer}),config,'private-nonce');
  assert.equal(result.issuer,issuer);
  assert.equal(result.checks.issuerMatches,false);
  assert.equal(result.checks.issuerPresent,true);
  assert.equal(result.checks.nonceMatches,true);
  assert.equal(result.checks.companyMatches,true);
  assert.equal(result.checks.accountsMatch,true);
  assert.ok(Object.values(result.checks).every(value => typeof value === 'boolean'));
  assert.ok(!JSON.stringify(result).includes('private-nonce'));
  assert.ok(!JSON.stringify(result).includes(accountNumber));
  for (const iss of [undefined,'https://evil.example/private','https://sbi.sberbank.ru.evil.example/','https://sbi.sberbank.ru/?secret=private','https://secret@sbi.sberbank.ru/']) assert.equal(sberTokenDiagnostics(token('nonce',{iss}),config,'nonce').issuer,undefined);
});

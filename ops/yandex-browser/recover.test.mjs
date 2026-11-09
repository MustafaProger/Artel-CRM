import test from 'node:test';
import assert from 'node:assert/strict';
import { readBalance } from './recover.mjs';
import { scope } from './balance.mjs';
const balances = {balance:'12.34',available_funds:'12.34',total_lst_balances:'12.34'};
const data = {contracts:[{contract_id:scope.contractId,external_id:scope.contractNumber,currency:'RUB',payment_type:'prepaid',balances,lst_groups:[{parent_contract_id:scope.contractId,lst_group_code:'main',services:['tanker'],balances}]}]};
function fixture(scenarios) {
  let opened=0,closed=0;
  return {get opened(){return opened;},get closed(){return closed;},
    async newCDPSession(){return {async send(){}};},
    async newPage(){const s=scenarios[opened++] ?? {}; return {
      url:()=>s.login?'https://passport.yandex.ru/auth':'https://business.taxi.yandex.ru/',
      async goto(){if(s.crash)throw Error('Page crashed');},
      async close(){closed++;},
      async waitForResponse(predicate){const r={url:()=> 'https://b2b-api-lk.go.yandex.ru/corp-cabinet/3.0/contracts/list',request:()=>({method:()=> 'GET',headerValue:async()=>s.wrongScope?'wrong':scope.companyId}),status:()=>s.status??200,fromServiceWorker:()=>false,json:async()=>data};assert.equal(predicate(r),true);return r;}
    };}
  };
}
test('no existing tab: creates and releases a renderer with the persistent context',async()=>{const c=fixture([{}]);assert.equal((await readBalance(c)).amountMinor,1234);assert.equal(c.closed,1);});
test('crashed renderer is closed and retried once',async()=>{const c=fixture([{crash:true},{}]);await readBalance(c);assert.equal(c.opened,2);assert.equal(c.closed,2);});
test('repeated failure is bounded and not auth',async()=>{const c=fixture([{crash:true},{crash:true}]);await assert.rejects(readBalance(c),/Page crashed/);assert.equal(c.closed,2);});
for(const s of [{login:true},{status:401}])test('confirmed auth stops retries',async()=>{const c=fixture([s]);await assert.rejects(readBalance(c),/^Error: auth$/);assert.equal(c.opened,1);assert.equal(c.closed,1);});
test('403 is a provider failure, not proof of logout',async()=>{const c=fixture([{status:403},{status:403}]);await assert.rejects(readBalance(c),/provider/);assert.equal(c.closed,2);});
test('wrong company cannot publish a balance',async()=>{const c=fixture([{wrongScope:true}]);await assert.rejects(readBalance(c),/scope/);assert.equal(c.opened,1);assert.equal(c.closed,1);});

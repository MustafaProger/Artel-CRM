import assert from 'node:assert/strict';
import { test } from 'node:test';
import { money, scope, fuelBalance } from './balance.mjs';
const fuel = () => ({ contract_id: scope.contractId, external_id: scope.contractNumber, currency: 'RUB', payment_type: 'prepaid', balances: { total_lst_balances: '123.45', available_funds: '123.45' }, lst_groups: [{ parent_contract_id: scope.contractId, lst_group_code: 'main', services: ['tanker'], balances: { balance: '123.45', available_funds: '123.45' } }] });
test('Decimal money conversion exact, no rounding or floating point multiplication', () => {
  for (const [input, output] of [['123.45',12345],['0',0],['-0.01',-1],['99.9',9990]]) assert.equal(money(input),output);
  for (const input of [12, null, '1.234', '1e5', '', 'NaN',' 1','99999999999999.99']) assert.throws(()=>money(input));
});
test('Fuel scope excludes taxi total and unrelated credit, accepts zero and negative balances', () => {
  const data={ balances:{available_funds:'2123.45'}, contracts:[{contract_id:'taxi', external_id:'taxi', balances:{available_funds:'2000.00'}},fuel()] };
  assert.deepEqual(fuelBalance(data,scope.companyId),{amountMinor:12345,availableMinor:12345,currency:'RUB'});
  for(const value of ['0.00','-2.34']){const c=fuel();c.balances.total_lst_balances=c.balances.available_funds=c.lst_groups[0].balances.balance=c.lst_groups[0].balances.available_funds=value;assert.equal(fuelBalance({contracts:[c]},scope.companyId).amountMinor,money(value));}
});
for (const kind of ['company','missing','duplicate','currency','number','service','group','mixed','mismatch','postpaid']) test(`Fuel parser rejects ${kind}`,()=>{
 const c=fuel(),data={contracts:[c]};let company=scope.companyId;
 if(kind==='company')company='wrong';if(kind==='missing')data.contracts=[];if(kind==='duplicate')data.contracts.push(c);
 if(kind==='currency')c.currency='USD';if(kind==='number')c.external_id='wrong';if(kind==='service')c.lst_groups[0].services=['taxi'];
 if(kind==='group')c.lst_groups[0].parent_contract_id='wrong';if(kind==='mixed')c.lst_groups.push(c.lst_groups[0]);
 if(kind==='mismatch')c.balances.available_funds='0';if(kind==='postpaid')c.payment_type='postpaid';
 assert.throws(()=>fuelBalance(data,company));
});

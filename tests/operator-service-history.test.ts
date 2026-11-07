import assert from 'node:assert/strict';
import { test } from 'node:test';
import { operatorDiscountAt, operatorCatalogDate } from '../web/src/operator-catalog';
import { operatorServiceInk, operatorServiceBackground } from '../web/src/operator-service-presentation';
test('discount boundaries are date based and Moscow midnight is independent of host timezone', () => {
  const service={id:'s',name:'s',discountPercent:'15',discountHistory:[{effectiveFrom:'0001-01-01',discountPercent:'10'},{effectiveFrom:'2026-10-22',discountPercent:'12'},{effectiveFrom:'2026-10-25',discountPercent:'15'}]};
  for(const [day,rate] of [['2026-10-21','10'],['2026-10-22','12'],['2026-10-24','12'],['2026-10-25','15'],['2027-01-01','15']])assert.equal(operatorDiscountAt(service,day),rate);
  assert.equal(operatorCatalogDate(new Date('2026-10-21T20:59:59Z')),'2026-10-21');
  assert.equal(operatorCatalogDate(new Date('2026-10-21T21:00:00Z')),'2026-10-22');
  assert.equal(operatorDiscountAt({id:'s',name:'s',discountPercent:'7'},'2020-01-01'),'7');
});
test('custom backgrounds have readable text; known services retain default colors',()=>{
  assert.equal(operatorServiceInk('#ffffff'),'#000000');assert.equal(operatorServiceInk('#000000'),'#ffffff');
  assert.equal(operatorServiceBackground('РН','operator-service-rosneft'),'#30363d');
});

import { chromium, webkit } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
const output=resolve(import.meta.dirname,'../qa/saby-panel-stability');await mkdir(output,{recursive:true});
const reports=[];
for(const mode of ['source','built']) for(const [engine,launcher] of Object.entries({chromium,webkit})) for(const width of [375,1440]) {
 const origin=mode==='source'?'http://127.0.0.1:5199':'http://127.0.0.1:5200';
 const browser=await launcher.launch();
 try {
 const context=await browser.newContext({viewport:{width,height:900},reducedMotion:'reduce',serviceWorkers:'block'});
 const errors=[], external=[], mutations=[];let failList=false;let listReads=0,holdList=false,releaseList,heldListReady;
 const realIssue={step:6,stage:'Отправка клиентам',message:'Получатель ЭТрН не совпадает с клиентом рейса'};
 let listIssues=[realIssue],panelIssues=[realIssue],targetId;
 await context.route('**/*',async route=>{
  const req=route.request(),url=new URL(req.url());
  if(url.origin!==origin){external.push(url.origin);return route.abort();}
  if(url.pathname.startsWith('/api/')&&req.method()!=='GET')mutations.push(url.pathname);
  if(url.pathname==='/api/shipment-trips'&&req.method()==='GET'){
   listReads++;if(failList){failList=false;return route.fulfill({status:503,json:{error:'Синтетический отказ загрузки'}});}const response=await route.fetch(),body=await response.json();
   if(targetId)body.trips=body.trips.map(t=>t.id===targetId?{...t,workflowIssues:listIssues}:t);
   if(holdList){holdList=false;heldListReady?.();await new Promise(resolve=>{releaseList=resolve;});}
   return route.fulfill({response,json:body});
  }
  if(url.pathname.endsWith('/saby-workflow')&&req.method()==='GET'){
   const response=await route.fetch(),body=await response.json();
   await new Promise(resolve=>setTimeout(resolve,250));
   if(targetId&&url.pathname.includes(targetId))body.workflowIssues=panelIssues;
   return route.fulfill({response,json:body});
  }
  return route.continue();
 });
 const page=await context.newPage();page.on('pageerror',e=>errors.push(String(e)));
 const fixture=await (await page.request.get(origin+'/__fixture')).json();targetId=fixture.waiting;
 await page.goto(origin+'/__preview'+(mode==='built'?'#trips':''));
 await page.locator('.trips-section-tabs').getByRole('button',{name:'Рейсы',exact:true}).click();
 const cards=page.locator('.trip-card');await cards.first().waitFor();
 const samples=[];
 for(const index of [0,1,2,3]) {
  const card=cards.nth(index),button=card.getByRole('button',{name:'Saby',exact:true});
  await button.evaluate(node=>node.scrollIntoView({block:'center'}));await page.waitForTimeout(100);
  const before=await button.evaluate(n=>n.getBoundingClientRect().top),box=await button.boundingBox();
  await page.mouse.click(box.x+box.width/2,box.y+box.height/2);
  await page.waitForTimeout(80);const loading=await button.evaluate(n=>n.getBoundingClientRect().top);
  await card.locator('.trip-saby-panel[aria-busy="false"]').waitFor();await page.waitForTimeout(100);
  const after=await button.evaluate(n=>n.getBoundingClientRect().top);
  assert.ok(Math.abs(loading-before)<=2,`${mode}/${engine}/${width} loading jump ${loading-before}`);
  assert.ok(Math.abs(after-before)<=2,`${mode}/${engine}/${width} loaded jump ${after-before}`);
  assert.equal(await page.locator('.trip-saby-action button[aria-expanded="true"]').count(),index+1);
  samples.push({index,loadingDelta:loading-before,loadedDelta:after-before});
 }
 const target=cards.filter({has:page.getByRole('heading',{name:'Рейс №55',exact:true})});
 assert.match(await target.locator('.trip-issue-label').innerText(),/Проверить этап 7/);
 // Close only this panel; its error must remain in the closed card.
 await target.getByRole('button',{name:'Saby',exact:true}).click();
 assert.equal(await target.locator('.trip-saby-panel').count(),0);
 assert.equal(await target.locator('.trip-issue-label').count(),1);
 const countBefore=listReads;listIssues=[];
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.waitForFunction(()=>!Array.from(document.querySelectorAll('.trip-card')).find(n=>n.textContent.includes('Рейс №55')).querySelector('.trip-issue-label'));
 assert.ok(listReads>countBefore);assert.equal(await page.locator('.trip-saby-panel').count(),3);
 // A stale background list cannot clear a newer error read by the panel.
 holdList=true;listIssues=[];panelIssues=[realIssue];
 const held=new Promise(resolve=>{heldListReady=resolve;});
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));await held;
 await target.getByRole('button',{name:'Saby',exact:true}).click();
 await target.locator('.trip-issue-label').waitFor();releaseList();await page.waitForTimeout(200);
 assert.match(await target.locator('.trip-issue-label').innerText(),/Проверить этап 7/);
 // The indicator can open a panel without collapsing any of the others.
 await target.getByRole('button',{name:'Saby',exact:true}).click();
 await target.locator('.trip-issue-label').click();await target.locator('.trip-saby-panel').waitFor();
 assert.equal(await page.locator('.trip-saby-panel').count(),4);
 // A stale indicator disappearing on open must not move the Saby button.
 await target.getByRole('button',{name:'Saby',exact:true}).click();
 panelIssues=[];
 const targetButton=target.getByRole('button',{name:'Saby',exact:true});
 await targetButton.evaluate(n=>n.scrollIntoView({block:'center'}));await page.waitForTimeout(100);
 const beforeClear=await targetButton.evaluate(n=>n.getBoundingClientRect().top);
 await targetButton.focus();await page.keyboard.press('Enter');
 await target.locator('.trip-saby-panel[aria-busy="false"]').waitFor();await page.waitForTimeout(100);
 assert.equal(await target.locator('.trip-issue-label').count(),0);
 const clearingDelta=(await targetButton.evaluate(n=>n.getBoundingClientRect().top))-beforeClear;
 assert.ok(Math.abs(clearingDelta)<=2,`indicator removal jump ${clearingDelta}`);
 samples.push({clearingDelta});
 const violations=(await new AxeBuilder({page}).include('.trips-page').analyze()).violations;
 if(violations.length)console.log(JSON.stringify(violations.map(v=>({id:v.id,nodes:v.nodes.map(n=>n.html)}))));
 assert.deepEqual(violations.map(v=>v.id),[]);
 // Recover an initially failed list on a background read, not an empty list.
 failList=true;await page.reload();
 await page.locator('.trips-section-tabs').getByRole('button',{name:'Рейсы',exact:true}).click();
 await page.getByText('Синтетический отказ загрузки',{exact:false}).waitFor();
 await page.evaluate(()=>window.dispatchEvent(new Event('focus')));
 await page.locator('.trip-card').first().waitFor();assert.equal(await page.locator('.trip-card').count(),4);
 assert.deepEqual(errors,[]);assert.deepEqual(external,[]);assert.deepEqual(mutations,[]);
 reports.push({mode,engine,width,samples,realErrorsVisible:true,backgroundRefresh:true,staleListProtected:true,axe:0,external:0,mutations:0});
 console.log('PASS',mode,engine,width);
 }finally{await browser.close();}
}
await writeFile(resolve(output,'report.json'),JSON.stringify(reports,null,2));

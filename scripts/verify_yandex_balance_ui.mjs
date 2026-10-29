import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { writeTripsQaSnapshot, startTripsQaServer } from './qa-trips-runtime.mjs';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'),built=process.argv.includes('--built');
const out=resolve(root,'.local/yandex-ui',built?'built':'source');await mkdir(out,{recursive:true});
const dir=await mkdtemp(resolve(tmpdir(),'yandex-ui-'));
const snapshotDirectory=resolve(dir,'snapshot');await writeTripsQaSnapshot(snapshotDirectory);
const report={syntheticOnly:true,workingStoreAccessed:false,providerCalls:0,checks:[],browserErrors:[],axe:[]};
let runtime,browser;
const check=s=>{report.checks.push(s);console.log('PASS',s);};
try {
 runtime=await startTripsQaServer({root,snapshotDirectory,operationsDirectory:resolve(dir,'store')});
 if(built)runtime.server.middlewares.stack.unshift({route:'',handle(req,res,next){const path=new URL(req.url,runtime.base).pathname;if(path.startsWith('/api/'))return next();const relative=path==='/'?'index.html':path.slice(1);if(relative.includes('..'))return next();readFile(resolve(root,'app-dist',relative)).then(body=>{res.setHeader('Content-Type',relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':'text/html');res.end(body);}).catch(()=>next());}});
 const {cookie}=await bootstrapQaAuth(runtime.base);
 for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
  browser=await launcher.launch({headless:true});const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});await authenticateContext(context,runtime.base,cookie);
  const now=new Date().toISOString();let row={id:'yandex-server-fuel',provider:'yandex',label:'НК АРТЭЛЬ · Заправки',createdAt:now,lastAttemptAt:now,lastSuccessAt:now,state:'connected',refreshMode:'server_browser',accounts:[{id:'yandex:49844602',supplier:'Яндекс Заправки',organization:'ООО НК АРТЭЛЬ',contract:'43207794/25',amountMinor:12345,currency:'RUB',balanceLabel:'Собственные средства',details:[{label:'Лимит отсрочки',amountMinor:200000}]}]};
  await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin!==runtime.base){report.providerCalls++;return route.abort();}if(u.pathname==='/api/cabinets')return route.fulfill({json:{connections:[row],credentialStorageReady:true}});return route.continue();});
  const page=await context.newPage();page.on('pageerror',e=>report.browserErrors.push(e.message));await page.goto(runtime.base+'/#cabinet-balances');
  const card=page.getByRole('article',{name:'Яндекс Go',exact:true});await expect(card).toBeVisible();
  for(const width of [320,390,768,1440]){
   await page.setViewportSize({width,height:1000});await expect(card).toContainText('Договор 43207794/25');await expect(card).toContainText('Собственные средства');await expect(card).toContainText('123,45');await expect(card).toContainText('Автоматически каждые 5 минут');await expect(card).toContainText('Прочитано в кабинете');await expect(card.getByRole('button',{name:'Обновить',exact:true})).toHaveCount(0);
   assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
   await page.screenshot({path:resolve(out,`${engine}-${width}.png`),fullPage:true});
   if([320,1440].includes(width)){const result=await new AxeBuilder({page}).include('.cabinet-page').withTags(['wcag2a','wcag2aa','wcag21aa']).analyze();report.axe.push({engine,width,violations:result.violations});assert.equal(result.violations.length,0);}
   check(`${engine} ${width}: money, contract, time, server cadence, no overflow`);
  }
  await page.locator('.cabinet-intro').getByRole('button',{name:'Добавить кабинет',exact:true}).click();await expect(page.getByRole('dialog').getByText('Яндекс Go',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Закрыть',exact:true}).click();check(`${engine}: connected managed provider not duplicated in credentials form`);
  row={...row,state:'auth_required',error:'Требуется повторный вход в Яндекс на сервере. Показан последний полученный остаток.'};await page.reload();await expect(card).toContainText('Требуется вход');await expect(card).toContainText('123,45');check(`${engine}: expired login keeps amount and warning`);
  row={...row,state:'connected',error:undefined,lastSuccessAt:new Date(Date.now()-660000).toISOString()};await page.reload();await expect(card).toContainText('Данные требуют обновления');check(`${engine}: stale timestamp cannot look current`);
  row={...row,state:'error',accounts:undefined,lastSuccessAt:undefined,error:'Не удалось проверить данные Яндекса.'};await page.reload();await expect(card).toContainText('Не удалось проверить');await expect(card).not.toContainText('123,45');check(`${engine}: failed first collection has no invented balance`);
  await context.close();await browser.close();browser=undefined;
 }
 assert.equal(report.providerCalls,0);assert.deepEqual(report.browserErrors,[]);report.passed=true;
}finally{await browser?.close();await runtime?.server.close();await rm(dir,{recursive:true,force:true});await writeFile(resolve(out,'report.json'),JSON.stringify(report,null,2));}

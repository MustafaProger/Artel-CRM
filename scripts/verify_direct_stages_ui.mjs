// Synthetic component integration: all HTTP stays on a temporary localhost server.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
const root=resolve(import.meta.dirname,'..'),output=resolve(root,'.local/direct-stages/ui');await mkdir(output,{recursive:true});
const bundle=await build({stdin:{contents:`import React from 'react';import {createRoot} from 'react-dom/client';import TripEtrnPanel from './TripEtrnPanel';import './shipments.css';import './design-system.css';const trip={id:'qa-direct',fields:{organization_id:'nk-artel',trip_flow_version:'driver-v1',trip_document_policy:'nk-direct-autostart-v1'},customers:['a','b'].map(id=>({id,fields:{customer_id:id,unloading_address:'Синтетический адрес '+id}}))};createRoot(document.getElementById('root')).render(<main className="app-shell shipments-workspace"><TripEtrnPanel trip={trip} data={{companies:[{id:'a',name:'Клиент А'},{id:'b',name:'Клиент Б'}],directories:{}}}/></main>);`,loader:'tsx',resolveDir:resolve(root,'web/src')},bundle:true,write:false,outfile:resolve(output,'app.js'),define:{'process.env.NODE_ENV':'"production"'}});
const assets=Object.fromEntries(bundle.outputFiles.map(f=>[f.path.endsWith('.css')?'/app.css':'/app.js',f.contents]));
const time='2026-10-22T07:00:00Z';
let mode='delay', writes=[], release, docsFail=false;
const result=()=>({documentMode:'nk_direct_etrn',status:'not_sent',ready:false,locked:false,phase:'preparation',blockers:['Прежний обмен требует сверки'],lastError:null,order:null,deliveries:[],monitoring:{enabled:false},history:[],driverConfirmation:{arrivedAt:time,confirmedAt:time},previousExchanges:[{at:time,documents:[{number:'3',url:'https://online.saby.ru/test',status:'Прежний документ'}]}]});
let workflow=result();
const server=createServer(async(req,res)=>{const path=new URL(req.url,'http://localhost').pathname;const json=(body,status=200)=>{res.writeHead(status,{'content-type':'application/json'});res.end(JSON.stringify(body));};if(req.method!=='GET')writes.push(path);
 if(path.endsWith('/saby-workflow')){if(mode==='delay'){await new Promise(resolve=>{release=resolve;});}if(mode==='hang')return;if(mode==='fail')return json({error:'Состояние временно недоступно'},503);return json(workflow);}
 if(path.endsWith('/etrn'))return json(docsFail?{error:'Файлы временно недоступны'}:{deliveries:[]},docsFail?503:200);
 if(path.endsWith('/loading-details'))return json({mode:'sender',required:false,editable:false,loadingActor:{name:'НК АРТЭЛЬ',inn:'7700000001'},infrastructureOwner:{name:'Владелец нефтебазы',inn:'7700000002'},details:null,version:'1'});
 if(path.endsWith('/saby'))return json({saby:{documents:[]}});
 if(assets[path]){res.writeHead(200,{'content-type':path.endsWith('.css')?'text/css':'text/javascript'});return res.end(assets[path]);}
 res.writeHead(200,{'content-type':'text/html'});res.end('<!doctype html><html lang="ru"><title>Этапы прямой ЭТрН</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>body{margin:0;padding:16px;background:#fff;font-family:Arial,sans-serif;color:#243c34}*{box-sizing:border-box}.app-shell{max-width:1100px;margin:auto}.button{display:inline-flex;gap:8px;align-items:center;background:#fff;color:#173f30;border:1px solid #547963}.etrn-note{font-size:13px;color:#4c6458}</style><div id="root"></div><script type="module" src="/app.js"></script></html>');
});await new Promise(r=>server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${server.address().port}`;
const report={synthetic:true,providerCalls:0,checks:[],accessibility:[],screenshots:[]};let browser;
try{for(const [engine,factory]of [['chromium',chromium],['webkit',webkit]]){
 mode='delay';workflow=result();docsFail=false;release=undefined;
 browser=await factory.launch({headless:true,...(engine==='chromium'?{executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'}:{})});
 const context=await browser.newContext({viewport:{width:1470,height:1000}}),page=await context.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.route('**/*',route=>new URL(route.request().url()).origin===base?route.continue():route.abort());
 await page.goto(base);await expect(page.getByRole('heading',{name:'Документы Saby',exact:true})).toBeVisible();await expect(page.getByText('АРТЭЛЬ → НК АРТЭЛЬ → Клиенты',{exact:true})).toHaveCount(0);
 await expect.poll(()=>!!release).toBe(true);mode='ok';release();
 const stages=page.getByRole('list',{name:'Этапы прямой ЭТрН'});await expect(stages).toBeVisible();await expect(stages.locator('li')).toHaveCount(7);await expect(stages.locator('.is-done')).toHaveCount(1);await expect(stages.locator('[aria-current="step"]')).toContainText('Подготовка');
 await expect(page.getByRole('heading',{name:'НК АРТЭЛЬ → Клиенты',exact:true})).toBeVisible();await expect(page.getByRole('textbox')).toHaveCount(0);await expect(page.getByText('Владелец нефтебазы:',{exact:true})).toBeVisible();
 report.checks.push(`${engine}: delayed GET has no false route; rebuilt trip shows driver fact and no archived progress`);
 for(const width of [320,390,600,1100,1470]){await page.setViewportSize({width,height:1000});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true,`${engine} overflow ${width}`);await expect(stages).toBeVisible();const shot=resolve(output,`${engine}-${width}.png`);await page.screenshot({path:shot,fullPage:true});report.screenshots.push(shot);}
 const axe=await new AxeBuilder({page}).withTags(['wcag2a','wcag2aa']).analyze();report.accessibility.push({engine,violations:axe.violations});assert.deepEqual(axe.violations.map(v=>v.id),[]);
 mode='fail';await page.reload();await expect(page.getByRole('alert')).toContainText('Состояние временно недоступно');await expect(page.getByRole('button',{name:'Повторить загрузку'})).toBeEnabled();mode='ok';await page.getByRole('button',{name:'Повторить загрузку'}).click();await expect(stages).toBeVisible();
 docsFail=true;await page.getByRole('button',{name:'Обновить состояние',exact:true}).click();await expect(page.getByRole('alert')).toContainText('Файлы временно недоступны');await expect(stages).toBeVisible();docsFail=false;await page.getByRole('button',{name:'Обновить состояние',exact:true}).click();await expect(page.getByRole('alert')).toHaveCount(0);
 report.checks.push(`${engine}: retry recovers first GET; document failure retains workflow and clears after recovery`);
 workflow={...result(),ready:true,locked:true,phase:'completed',stage6CompletedAt:time,blockers:[],deliveries:['a','b'].map(shipmentId=>({shipmentId,id:shipmentId,status:'draft',dispatch:{sender:{state:'confirmed'},carrier:{state:'confirmed'},completedAt:time,recipientAcceptedAt:shipmentId==='a'?time:null}}))};await page.getByRole('button',{name:'Обновить состояние',exact:true}).click();await expect(stages.locator('.is-done')).toHaveCount(6);await expect(stages.locator('[aria-current="step"]')).toContainText('Приёмка клиентами');await expect(stages.locator('[aria-current="step"]')).toContainText('1 из 2');
 workflow.deliveries.forEach(row=>{row.dispatch.recipientAcceptedAt='invalid';});await page.getByRole('button',{name:'Обновить состояние',exact:true}).click();await expect(page.getByText('Приёмка всех доставок подтверждена',{exact:true})).toHaveCount(0);await expect(stages.locator('[aria-current="step"]')).toContainText('0 из 2');
 report.checks.push(`${engine}: partial acceptance is not completed reception`);
 workflow={...result(),locked:true,phase:'unknown',lastError:'Требуется сверка титула',deliveries:[{shipmentId:'a',id:'known-document',status:'unknown',lastError:'Требуется сверка титула',dispatch:{sender:{state:'blocked'},carrier:{state:'not_started'}}},{shipmentId:'b',id:null,status:'not_sent'}]};
 await page.getByRole('button',{name:'Обновить состояние',exact:true}).click();
 await expect(stages.locator('li').nth(2)).toContainText('1 из 2');
 await expect(stages.locator('li').nth(3)).toContainText('0 из 2');
 report.checks.push(`${engine}: known document stays counted during unresolved signature verification`);

 mode='hang';await page.reload();await expect(page.getByRole('alert')).toContainText('Сервер не ответил за 20 секунд',{timeout:26000});await expect(page.getByRole('button',{name:'Повторить загрузку'})).toBeEnabled();mode='ok';await page.getByRole('button',{name:'Повторить загрузку'}).click();await expect(stages).toBeVisible();assert.deepEqual(errors,[]);assert.deepEqual(writes,[]);report.checks.push(`${engine}: true stalled HTTP aborts in 20s and GET-only retry recovers`);
 await browser.close();browser=null;
}report.passed=true;}finally{if(browser)await browser.close();server.closeAllConnections();server.close();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));}console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,axe:report.accessibility.length,screenshots:report.screenshots.length}));

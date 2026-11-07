import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'), temp=await mkdtemp(resolve(tmpdir(),'refresh-layout-'));
const mode=process.env.ARTEL_OPERATOR_QA_BUILT==='1'?'built':'source';
const output=resolve(root,'.local/refresh-release/ui-'+mode); await mkdir(output,{recursive:true});
await writeTripsQaSnapshot(resolve(temp,'snapshot'));
const runtime=await startOperatorQaServer({root,snapshotDirectory:resolve(temp,'snapshot'),operationsDirectory:resolve(temp,'operations')});
const {cookie}=await runtime.bootstrap(); const report={synthetic:true,artifacts:runtime.artifacts,mode,checks:[],errors:[],businessWrites:0};
let browser;
try {
for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]) {
 browser=await launcher.launch(); const context=await browser.newContext({serviceWorkers:'block',reducedMotion:'reduce'});await authenticateContext(context,runtime.base,cookie);
 const page=await context.newPage();page.on('pageerror',e=>report.errors.push(String(e)));
 page.on('request',r=>{if(!['GET','HEAD','OPTIONS'].includes(r.method()))report.businessWrites++;});
 await page.goto(runtime.base+'/#work');await expect(page.getByLabel('Фильтр исполнителя')).toBeVisible();
 for(const width of [320,390,600,760,761,1024,1100,1101,1470,1920]) {
 await page.setViewportSize({width,height:950});
 for(const view of ['Задачи','Календарь','Архив задач']) {
 await page.locator('.work-views').getByRole('button',{name:view,exact:true}).click();
 const a=await page.locator('.work-assignee').boundingBox(),b=await page.locator('.work-refresh').boundingBox(),v=await page.locator('.work-views').boundingBox();
 assert.ok(Math.abs(a.y+a.height/2-b.y-b.height/2)<2,`${engine} ${width} alignment`);assert.ok(b.x>=a.x+a.width-1);
 if(width<=1100)assert.ok(v.y+v.height<=a.y+1);
 assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
 report.checks.push({engine,width,view});
 }
 await page.getByLabel('Фильтр исполнителя').selectOption('mine');await page.getByRole('button',{name:'Обновить работу',exact:true}).click();await expect(page.getByRole('button',{name:'Обновить работу',exact:true})).toBeEnabled();await expect(page.getByLabel('Фильтр исполнителя')).toHaveValue('mine');await page.getByLabel('Фильтр исполнителя').selectOption('');
 if([390,1470].includes(width))await page.screenshot({path:resolve(output,`${engine}-${width}.png`)});
 }
 await browser.close();browser=null;
}
assert.deepEqual(report.errors,[]);assert.equal(report.businessWrites,0);report.passed=true;console.log(JSON.stringify(report));
}finally{await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await browser?.close();await runtime.server.close();await rm(temp,{recursive:true,force:true});}

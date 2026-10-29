// Every visible grant is saved through the account form and opened in a separate employee session.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {resolve} from 'node:path';
import {chromium,webkit,expect} from '@playwright/test';
import {startTripsQaServer,writeTripsQaSnapshot} from './qa-trips-runtime.mjs';
import {bootstrapQaAuth,authenticateContext} from './qa-auth.mjs';
import {sharedDirectories} from '../web/src/auth-model.ts';
const root=resolve(import.meta.dirname,'..'), built=process.argv.includes('--built');
const temp=await mkdtemp(resolve(tmpdir(),'artel-operator-grants-'));
const output=resolve(root,'../revision2',built?'grants-built':'grants-source');await mkdir(output,{recursive:true});
await writeTripsQaSnapshot(resolve(temp,'snapshot'));
const runtime=await startTripsQaServer({root,snapshotDirectory:resolve(temp,'snapshot'),operationsDirectory:resolve(temp,'store')});
const {cookie}=await bootstrapQaAuth(runtime.base);
if(built)runtime.server.middlewares.stack.unshift({route:'',handle(req,res,next){const path=new URL(req.url,runtime.base).pathname;if(path.startsWith('/api/'))return next();const relative=path==='/'?'index.html':path.slice(1);if(relative.includes('..'))return next();readFile(resolve(root,'app-dist',relative)).then(body=>{res.setHeader('Content-Type',relative.endsWith('.js')?'text/javascript':relative.endsWith('.css')?'text/css':'text/html');res.end(body)}).catch(()=>next())}});
const api=async(path,method='GET',body)=>{const response=await fetch(runtime.base+path,{method,headers:{cookie,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result};
const password=randomUUID();
const manager=(await api('/api/directories','POST',{kind:'managers',name:'Оператор проверки прав'})).entry;
const user=(await api('/api/auth/users','POST',{name:manager.name,login:'grants-operator',password,role:'employee',managerId:manager.id,sections:['work','operator','directories'],directoryGrants:[]})).user;
const report={synthetic:true,checks:[],errors:[]};let browser;
try{
for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
 browser=await launcher.launch();const admin=await browser.newContext({viewport:{width:1440,height:1000},serviceWorkers:'block',reducedMotion:'reduce'});await authenticateContext(admin,runtime.base,cookie);
 await admin.route('**/*',route=>new URL(route.request().url()).origin===runtime.base?route.continue():route.abort());
 const page=await admin.newPage();page.on('pageerror',e=>report.errors.push(e.message));
 for(const grant of sharedDirectories.filter(grant=>grant.id!=='paymentForms')){
  await page.goto(runtime.base+'/#accounts');
  await page.locator('.account-row').filter({hasText:user.login}).getByRole('button',{name:'Изменить',exact:true}).click();
  for(const item of sharedDirectories.filter(grant=>grant.id!=='paymentForms'))await page.getByLabel(`Справочник: ${item.title}`,{exact:true}).setChecked(item.id===grant.id);
  await page.getByRole('button',{name:'Сохранить пользователя',exact:true}).click();await expect(page.locator('.account-form')).toHaveCount(0);
  const saved=(await api('/api/auth/users')).users.find(item=>item.id===user.id);assert.deepEqual(saved.directoryGrants,[grant.id]);
  const staff=await browser.newContext({viewport:{width:390,height:844},serviceWorkers:'block',reducedMotion:'reduce'});await staff.route('**/*',route=>new URL(route.request().url()).origin===runtime.base?route.continue():route.abort());
  assert.equal((await staff.request.post(runtime.base+'/api/auth/login',{headers:{Origin:runtime.base},data:{login:user.login,password}})).status(),200);
  const staffPage=await staff.newPage();staffPage.on('pageerror',e=>report.errors.push(e.message));await staffPage.goto(runtime.base+'/#directories');
  await expect(staffPage.locator('.directory-tabs>button')).toHaveCount(1);await expect(staffPage.locator('.directory-tabs').getByRole('button',{name:grant.title,exact:true})).toBeVisible();await expect(staffPage.getByRole('button',{name:'Добавить',exact:true})).toBeEnabled();
  await staffPage.getByRole('button',{name:'Добавить',exact:true}).click();await expect(staffPage.getByRole('dialog')).toBeVisible();await expect(staffPage.getByRole('dialog').getByRole('button',{name:'Сохранить',exact:true})).toBeVisible();await staffPage.keyboard.press('Escape');
  assert.ok(await staffPage.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));
  const response=await staff.request.get(runtime.base+'/api/directories');assert.equal(response.status(),200);
  assert.equal((await staff.request.get(runtime.base+'/api/auth/users')).status(),403);
  await staffPage.screenshot({path:resolve(output,`${engine}-${grant.id}.png`)});
  report.checks.push(`${engine}: ${grant.id} saved, visible alone, create form and API accessible; account administration denied`);
  console.log('PASS',report.checks.at(-1));await staff.close();
 }
 await admin.close();await browser.close();browser=null;
}
assert.deepEqual(report.errors,[]);report.passed=true;
}finally{await browser?.close();await runtime.server.close();await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await rm(temp,{recursive:true,force:true})}

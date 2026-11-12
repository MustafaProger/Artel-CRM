import {chromium,expect} from '@playwright/test';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import assert from 'node:assert/strict';
import {authenticateContext} from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'),access=JSON.parse(await readFile(resolve(root,'../preview/access.json'),'utf8'));
const base=process.env.ARTEL_REVIEW_BASE||access.base,cookie=process.env.ARTEL_REVIEW_COOKIE||access.cookie;
const browser=await chromium.launch({headless:true}), context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce'});await authenticateContext(context,base,cookie);
expect.configure({timeout:15000});
const report={synthetic:true,realPush:false,checks:[]};
try{
await context.addInitScript(()=>{
 window.__pushPermission='default';window.__unsubscribeCount=0;window.__permissionEvents=new EventTarget();
 Object.defineProperty(navigator,'permissions',{configurable:true,value:{query:async()=>window.__permissionEvents}});
 Object.defineProperty(window,'Notification',{configurable:true,value:class {static get permission(){return window.__pushPermission}static async requestPermission(){return window.__pushPermission='granted'}}});
 let subscription={endpoint:'https://fcm.googleapis.com/fcm/send/local-review',options:{},toJSON(){return {endpoint:this.endpoint,keys:{auth:'synthetic',p256dh:'synthetic'}}},async unsubscribe(){window.__unsubscribeCount++;return true}};
 const worker={pushManager:{async getSubscription(){return subscription},async subscribe(){return subscription}}};
 Object.defineProperty(navigator,'serviceWorker',{configurable:true,value:{register:async()=>worker,ready:Promise.resolve(worker),getRegistration:async()=>worker,addEventListener(){},removeEventListener(){}}});
 if(!('PushManager' in window))window.PushManager=class {};
});
let posts=0,probe=0,fail=false,configFailure=true;
await context.route('**/api/push/config',route=>configFailure?route.fulfill({status:503,json:{error:'Временная ошибка связи для проверки'}}):route.fulfill({json:{enabled:true,publicKey:'AQ',lastRunAt:Date.now(),intervalSeconds:60}}));
await context.route('**/api/push/subscription',route=>{posts++;return route.fulfill({json:{ok:true}})});
await context.route('**/api/push/test',route=>{assert.equal(route.request().postDataJSON().async,true);return route.fulfill({status:202,json:{ok:true,probeId:'local-probe-'+(++probe),queued:true}})});
await context.route('**/api/push/test-status?*',route=>route.fulfill({json:{probeId:'local-probe-'+probe,status:fail?'failed':'confirmed',...(fail?{failure:'expired_subscription'}:{notificationCreatedAt:Date.now()})}}));
const page=await context.newPage();await page.goto(base+'/#operator');
await page.locator('.sidebar-settings-link').click();
await expect(page).toHaveURL(/#settings$/);
const settings=page.getByRole('region',{name:'Уведомления',exact:true});
await expect(settings.getByRole('button',{name:'Повторить проверку подключения'})).toBeEnabled();configFailure=false;await settings.getByRole('button',{name:'Повторить проверку подключения'}).click();await expect(settings.getByRole('button',{name:'Подключить этот браузер'})).toBeEnabled();report.checks.push('configuration failure recovers in-place without page reload');await expect(settings.getByText('Этот браузер подключён к уведомлениям.',{exact:true})).toHaveCount(0);assert.equal(posts,0);report.checks.push('existing subscription without browser permission is not enabled');
await settings.getByRole('button',{name:'Подключить этот браузер'}).click();await expect(settings).toBeVisible();await expect(settings.getByRole('button',{name:'Проверить уведомление'})).toBeEnabled();assert.equal(posts,1);
await settings.getByRole('button',{name:'Проверить уведомление'}).click();await expect(settings.getByText('Браузер получил тестовое уведомление.',{exact:true})).toBeVisible();report.checks.push('explicit permission, registration and receipt confirmation');
fail=true;await settings.getByRole('button',{name:'Проверить уведомление'}).click();await expect(settings.getByRole('button',{name:'Подключить этот браузер'})).toBeVisible();await expect(settings.getByText('Подписка устройства истекла. Включите уведомления повторно.',{exact:true})).toBeVisible();
await settings.getByRole('button',{name:'Подключить этот браузер'}).click();await expect(settings).toBeVisible();assert.equal(await page.evaluate(()=>window.__unsubscribeCount),1);report.checks.push('expired device subscription is renewed explicitly');
await page.evaluate(()=>{window.__pushPermission='denied';window.__permissionEvents.dispatchEvent(new Event('change'))});await expect(settings.getByRole('button',{name:'Подключить этот браузер'})).toBeDisabled();await expect(settings.getByText('Этот браузер подключён к уведомлениям.',{exact:true})).toHaveCount(0);report.checks.push('browser permission revocation immediately updates status');
const output=resolve(root,'../ui',process.env.ARTEL_REVIEW_BUILT?'built':'source');await mkdir(output,{recursive:true});await page.screenshot({path:resolve(output,'push-revoked.png'),fullPage:true});await writeFile(resolve(output,'push-report.json'),JSON.stringify({...report,passed:true},null,2));console.log(JSON.stringify(report));
}finally{await browser.close()}

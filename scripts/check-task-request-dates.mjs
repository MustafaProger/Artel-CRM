import AxeBuilder from '@axe-core/playwright';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
// Synthetic authenticated CRM + real Leaflet, with every OSM tile fulfilled locally. No public tile traffic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { SabyClient, sabyConfigFromEnv } from '../server/saby-client.ts';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, '../ui', process.env.ARTEL_OPERATOR_QA_BUILT === '1' ? 'built' : 'source');
const temporary = await mkdtemp(resolve(tmpdir(), 'artel-requests-map-'));
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'operations');
await mkdir(output, { recursive: true }); await writeTripsQaSnapshot(snapshotDirectory);
const snapshot = await loadSnapshot(snapshotDirectory), store = new OperationsStore(operationsDirectory);
const company = (id, name, role = 'customer') => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] });
const maliciousName = 'QA <img src=x onerror="window.__xss=1"> & компания';
await store.mutate(snapshot.provenance.sourceSha256, data => {
  data.sourceOperationsCleared = true; data.shipments = {}; data.paymentAllocations = [];
  data.companies = [company('supplier', 'QA Поставщик', 'supplier'), ...Array.from({ length: 9 }, (_, index) => company(`customer-${index + 1}`, index === 8 ? maliciousName : `QA Ромашка ${index + 1}`))];
  data.directories = {
    fleetSeedApplied: true, managers: [{ id: 'manager', name: 'QA Менеджер' }],
    products: [{ id: 'product', name: 'QA ДТ', transportProductKind: 'diesel', cargoPackaging: 'bulk' }],
    paymentForms: [{ id: 'payment', name: 'б/нал' }],
    drivers: [{ id: 'driver', name: 'QA Водитель', vehicleId: 'vehicle' }],
    vehicles: [{ id: 'vehicle', plate: 'Т000ЕЕ00', capacityLitres: '20000' }],
    oilDepots: [{ id: 'depot', name: 'QA Нефтебаза', address: 'Синтетический склад, 1', ownerCompanyId: 'supplier', loadingActorCompanyId: 'supplier', infrastructureOwnerCompanyId: 'supplier' }],
    addresses: Array.from({ length: 9 }, (_, index) => {
      const number = index + 1;
      return { id: `address-${number}`, companyId: `customer-${number}`, kind: 'delivery', name: `QA База ${number}`, address: number === 6 ? 'Синтетический точный адрес' : number === 7 ? 'Синтетический неоднозначный адрес' : number === 8 ? 'Синтетический неизвестный адрес' : number === 9 ? 'Синтетическая улица <svg onload="window.__xss=2">, 9' : `Синтетическая улица, ${number}`, ...(number <= 5 || number === 9 ? { latitude: number === 5 ? '55.71' : String(55.7 + number / 100), longitude: number === 5 ? '37.61' : String(37.6 + number / 100) } : {}) };
    }),
    customerManagers: Array.from({ length: 9 }, (_, index) => ({ companyId: `customer-${index + 1}`, managerId: 'manager' })), defaults: { profit: 'template-payment-form' }, duplicates: [],
  };
  return { changed: true, result: null };
});
const report={passed:false,synthetic:true,checks:[],axe:[],errors:[],externalRequests:[]};
const check=n=>{report.checks.push(n);console.log('PASS',n)};
let runtime;
try {
 const saby=new SabyClient(sabyConfigFromEnv({}),async()=>{throw new Error('External call forbidden')});
 runtime=await startOperatorQaServer({root,snapshotDirectory,operationsDirectory,sabyClient:saby});
 const {cookie}=await runtime.bootstrap();
 const api=async(path,method='GET',body)=>{const response=await fetch(runtime.base+path,{method,headers:{Cookie:cookie,Origin:runtime.base,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)})});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result};
 for(const [i,executionDate] of ['2026-10-30','2026-10-29',null,'2026-10-28','2026-10-27'].entries())await api('/api/trip-requests','POST',{companyId:`customer-${i+1}`,addressId:`address-${i+1}`,quantityLitres:'1000',executionDate,idempotencyKey:randomUUID()});
 const task=(await api('/api/work/tasks','POST',{requestId:randomUUID(),title:'Проверить документы',description:'Синтетика',dueDate:'2026-10-27',reminderAt:'2026-10-28T09:00:00Z'})).entry;
 for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
  const browser=await launcher.launch();
  try{
   const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block',timezoneId:'America/Los_Angeles'});await authenticateContext(context,runtime.base,cookie);
   await context.route('**/*',route=>{const u=new URL(route.request().url());if(u.origin===runtime.base)return route.continue();if(u.hostname.endsWith('openstreetmap.org'))return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf2e8"/></svg>'});report.externalRequests.push(u.origin);return route.abort()});
   const page=await context.newPage();page.on('pageerror',e=>report.errors.push(e.message));await page.clock.install({time:new Date('2026-10-28T20:59:00Z')});await page.goto(runtime.base+'/#work');
   const checkbox=page.getByRole('checkbox',{name:'Выполнена: Проверить документы',exact:true});await expect(checkbox).not.toBeChecked();await checkbox.focus();await checkbox.press('Space');await expect(checkbox).toBeChecked();await expect(page.getByRole('dialog')).toHaveCount(0);
   let saved=(await api('/api/work')).work.tasks.find(r=>r.id===task.id);assert.equal(saved.status,'done');assert.equal(saved.dueDate,'2026-10-27');
   await checkbox.click();await expect(checkbox).not.toBeChecked();
   check(engine+': checkbox keyboard completion/reopen persisted; separate from editor');
   await page.route('**/api/work/tasks/*',route=>route.request().method()==='PATCH'?route.fulfill({status:409,json:{error:'QA: задача изменена'}}):route.continue());
   await checkbox.click();await expect(page.getByRole('alert')).toContainText('QA: задача изменена');await expect(checkbox).not.toBeChecked();await page.unroute('**/api/work/tasks/*');
   await page.getByRole('button',{name:'Задача: Проверить документы',exact:true}).click();await expect(page.getByLabel('Срок задачи',{exact:true})).toHaveCount(0);await expect(page.getByLabel('Напоминание',{exact:true})).toBeVisible();
   await page.getByLabel('Описание',{exact:true}).fill('Изменено без срока');await page.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
   saved=(await api('/api/work')).work.tasks.find(r=>r.id===task.id);assert.equal(saved.dueDate,'2026-10-27');
   await page.getByRole('button',{name:'Календарь',exact:true}).click();await expect(page.locator('.work-calendar-event')).toHaveCount(1);await expect(page.getByText('Срок задачи',{exact:true})).toHaveCount(0);await page.getByRole('button',{name:'Задачи',exact:true}).click();
   check(engine+': conflict shown, deadline hidden/preserved, reminder calendar retained');
   const widths=async(view,selector)=>{for(const width of [320,390,768,1440]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));const a=await new AxeBuilder({page}).include(selector).analyze();report.axe.push({engine,width,view,violations:a.violations});assert.equal(a.violations.length,0);await page.screenshot({path:resolve(output,`${engine}-${view}-${width}.png`)});check(`${engine}: ${view} ${width} layout/axe`)}};
   await widths('work','.work-page');
   await page.goto(runtime.base+'/#trips');await expect(page.locator('.trip-request-card')).toHaveCount(5);assert.deepEqual(await page.locator('.trip-request-card h2').allTextContents(),[5,4,2,1,3].map(n=>`QA Ромашка ${n}`));
   const edit=()=>page.getByRole('button',{name:'Изменить заявку: QA Ромашка 4, QA База 4',exact:true}).click();const date=page.getByLabel('Дата выполнения',{exact:true});const save=async()=>{await page.getByRole('button',{name:'Сохранить заявку',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0)};
   await edit();await expect(date).toHaveValue('2026-10-28');await date.fill('2026-10-26');await save();await expect(page.locator('.trip-request-card h2').first()).toHaveText('QA Ромашка 4');
   await edit();await expect(date).toHaveValue('2026-10-26');await date.fill('2026-10-28');await save();
   await page.getByRole('button',{name:'Новая заявка',exact:true}).click();await expect(date).toHaveValue('2026-10-28');await page.getByRole('button',{name:'Отмена',exact:true}).click();await expect(page.getByRole('dialog')).toHaveCount(0);
   check(engine+': saved date roundtrip/reorder; undated last; new date Moscow today');await widths('requests','.trip-requests-panel');
   await page.getByRole('button',{name:'Карта',exact:true}).click();await expect(page.locator('.trip-map-summary')).toContainText('На карте 2 из 2 заявок');
   const marker=n=>page.locator('.trip-map-marker').and(page.getByRole('button',{name:new RegExp(`QA Ромашка ${n}, Синтетическая улица`)}));
   await expect(marker(4)).toHaveCount(1);await expect(marker(2)).toHaveCount(1);for(const n of [1,3,5])await expect(marker(n)).toHaveCount(0);
   await page.clock.fastForward(90000);await expect(marker(4)).toHaveCount(0);await expect(marker(1)).toHaveCount(1);await expect(marker(2)).toHaveCount(1);
   check(engine+': map exact today/tomorrow and Moscow midnight across browser timezone');await context.close();
  }finally{await browser.close()}
 }
 await runtime.replaceMiddleware();assert.equal((await api('/api/trip-requests')).requests.find(r=>r.companyId==='customer-4').executionDate,'2026-10-28');assert.equal((await api('/api/work')).work.tasks.find(r=>r.id===task.id).status,'todo');check('runtime restart persists dates and task');
 assert.deepEqual(report.errors,[]);assert.deepEqual(report.externalRequests,[]);report.passed=true;
}finally{await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));await runtime?.server.close();await rm(temporary,{recursive:true,force:true,maxRetries:5,retryDelay:100})}

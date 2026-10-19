// Synthetic store and real Leaflet; public map tiles are always replaced locally.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { emptyDirectories } from '../server/directory-operations.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';
const root=resolve(import.meta.dirname,'..'), temporary=await mkdtemp(resolve(tmpdir(),'artel-delivery-point-'));
const output=resolve(root,'qa/osm-delivery-point-2026-10-12'); await mkdir(output,{recursive:true});
const snapshotDirectory=resolve(temporary,'snapshot'),operationsDirectory=resolve(temporary,'store');
const source=await writeTripsQaSnapshot(snapshotDirectory),store=new OperationsStore(operationsDirectory);
await store.mutate(source,data=>{
 data.sourceOperationsCleared=true;
 data.companies=[{id:'qa-company',name:'Учебный клиент',roles:['customer'],shipmentIds:[],paymentIds:[],managerLabels:[],flags:[]}];
 data.directories={...emptyDirectories(),fleetSeedApplied:true,addresses:[{id:'qa-address',name:'Учебная площадка',address:'Учебный адрес, 7',kind:'delivery',companyId:'qa-company',receiverName:'Учебный приёмщик'}]};
 return {changed:true,result:null};
});
const report={fixtureOnly:true,externalRequests:[],errors:[],checks:[],screenshots:[]};
const check=name=>{report.checks.push(name);console.log('PASS',name)};
let runtime,browser;
try{
 runtime=await startTripsQaServer({root,snapshotDirectory,operationsDirectory});
 const {base}=runtime,{cookie}=await bootstrapQaAuth(base);
 const snapshot=async()=>{const response=await fetch(base+'/api/snapshot',{headers:{cookie}});assert.ok(response.ok);return response.json()};
 const address=async()=> (await snapshot()).directories.addresses.find(row=>row.id==='qa-address');
 for(const [engine,launcher] of [['chromium',chromium],['webkit',webkit]]){
  browser=await launcher.launch({headless:true});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',serviceWorkers:'block'});
  await authenticateContext(context,base,cookie);
  await context.route('**/*',route=>{
   const url=new URL(route.request().url());
   if(url.origin===base)return route.continue();
   if(url.hostname==='tile.openstreetmap.org')return route.fulfill({contentType:'image/svg+xml',body:'<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" fill="#edf1e8"/><path d="M0 70H256M100 0V256" stroke="#fff" stroke-width="12"/></svg>'});
   report.externalRequests.push(url.origin);return route.abort();
  });
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(engine+': '+error.message));
  await page.goto(base+'/#directories');
  await page.getByRole('button',{name:'Редактировать: Учебный клиент',exact:true}).click();
  let dialog=page.getByRole('dialog');
  const before=await address();
  await dialog.getByRole('button',{name:/^(Выбрать точку на карте|Изменить точку на карте)$/}).click();
  const canvas=dialog.getByRole('region',{name:'Выбор точки доставки на карте OpenStreetMap',exact:true});
  await expect(canvas.locator('.leaflet-tile-loaded').first()).toBeVisible();
  assert.deepEqual(await address(),before);check(engine+': opening map leaves stored address untouched');
  await canvas.click({position:{x:110,y:125}});
  await expect(canvas.locator('.delivery-point-marker')).toHaveCount(1);
  await expect(dialog.getByLabel('Широта точки',{exact:true})).toHaveValue(/^-?\d+\.\d{1,6}$/);const selected=await dialog.getByLabel('Широта точки',{exact:true}).inputValue();
  const box=await canvas.locator('.delivery-point-marker').boundingBox();assert.ok(box);
  await page.mouse.move(box.x+14,box.y+14);await page.mouse.down();await page.mouse.move(box.x+55,box.y+40,{steps:8});await page.mouse.up();
  await expect(dialog.getByLabel('Широта точки',{exact:true})).not.toHaveValue(selected);check(engine+': map click and marker dragging update draft coordinates');
  await dialog.getByLabel('Широта точки',{exact:true}).fill('999');await dialog.getByRole('button',{name:'Применить координаты',exact:true}).click();
  await expect(dialog.getByText('Укажите широту от −90 до 90 и долготу от −180 до 180.',{exact:true})).toBeVisible();
  await dialog.getByLabel('Широта точки',{exact:true}).fill('55,751244');await dialog.getByLabel('Долгота точки',{exact:true}).fill('37,618423');
  await dialog.getByRole('button',{name:'Применить координаты',exact:true}).click();
  for(const width of [320,390,1440]){
   await page.setViewportSize({width,height:width<500?844:1000});await canvas.scrollIntoViewIfNeeded();
   assert.ok(await dialog.evaluate(e=>e.scrollWidth<=e.clientWidth+1));
   await expect(canvas.getByRole('link',{name:'OpenStreetMap',exact:true})).toBeVisible();
   const path=resolve(output,`${engine}-${width}.png`);await page.screenshot({path});report.screenshots.push(path);
  }
  await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog).toHaveCount(0);
  const saved=await address();assert.equal(saved.latitude,'55.751244');assert.equal(saved.longitude,'37.618423');assert.equal(saved.address,before.address);assert.equal(saved.receiverName,before.receiverName);assert.match(saved.mapUrl,/pt=37\.618423%2C55\.751244/);
  runtime.replaceMiddleware();await page.reload();
  await page.getByRole('button',{name:'Редактировать: Учебный клиент',exact:true}).click();dialog=page.getByRole('dialog');
  await expect(dialog.getByText('Точка выбрана: 55.751244, 37.618423',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Изменить точку на карте',exact:true}).click();
  await dialog.getByLabel('Широта точки',{exact:true}).fill('56');await dialog.getByRole('button',{name:'Применить координаты',exact:true}).click();
  await dialog.getByRole('button',{name:'Отмена',exact:true}).click();
  await dialog.getByRole('button',{name:'Не сохранять',exact:true}).click();
  await expect(dialog).toHaveCount(0);assert.deepEqual(await address(),saved);
  check(engine+': coordinates survive save/restart/reload, address and receiver preserved; cancel never writes');
  await page.getByRole('group',{name:'Справочники',exact:true}).getByRole('button',{name:'Места погрузки и доставки',exact:true}).click();
  await page.getByRole('button',{name:'Редактировать: Учебная площадка',exact:true}).click();dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Изменить точку на карте',exact:true}).click();
  await dialog.getByLabel('Широта',{exact:true}).fill('55.9');await dialog.getByLabel('Долгота',{exact:true}).fill('37.9');
  await expect(dialog.getByLabel('Ссылка на Яндекс.Карты',{exact:true})).toHaveValue('https://yandex.ru/maps/?pt=37.9%2C55.9&z=17');
  await expect(dialog.locator('.delivery-point-marker')).toHaveCount(1);
  await dialog.getByRole('button',{name:'Сохранить',exact:true}).click();await expect(dialog).toHaveCount(0);
  const moved=await address();assert.equal(moved.latitude,'55.9');assert.equal(moved.longitude,'37.9');assert.match(moved.mapUrl,/pt=37\.9%2C55\.9/);
  await page.getByRole('button',{name:'Редактировать: Учебная площадка',exact:true}).click();dialog=page.getByRole('dialog');
  await dialog.getByRole('button',{name:'Изменить точку на карте',exact:true}).click();
  await expect(dialog.locator('.delivery-point-marker')).toHaveCount(1);
  await dialog.getByLabel('Ссылка на Яндекс.Карты',{exact:true}).fill('https://yandex.ru/maps/?text=Test');
  await expect(dialog.getByLabel('Широта',{exact:true})).toHaveValue('');await expect(dialog.getByLabel('Долгота',{exact:true})).toHaveValue('');
  await expect(dialog.locator('.delivery-point-marker')).toHaveCount(0);
  await expect(dialog.getByText('Точка доставки ещё не выбрана',{exact:true})).toBeVisible();
  await dialog.getByRole('button',{name:'Отмена',exact:true}).click();await dialog.getByRole('button',{name:'Не сохранять',exact:true}).click();await expect(dialog).toHaveCount(0);
  assert.deepEqual(await address(),moved);check(engine+': legacy coordinate fields keep navigation aligned; changing URL clears stale marker; cancel preserves stored point');
  await context.close();await browser.close();browser=undefined;
 }
 assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);
 await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
}catch(error){await writeFile(resolve(output,'report.json'),JSON.stringify({...report,failure:String(error)},null,2));throw error}
finally{await browser?.close();await runtime?.server.close();await rm(temporary,{recursive:true,force:true})}

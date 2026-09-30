// Isolated synthetic store. The initial preflight is real; later workflow UI states are mocked.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { OperationsStore } from '../server/operations-store.ts';
import { loadSnapshot } from '../server/local-api.ts';
import { SabyClient, sabyConfigFromEnv } from '../server/saby-client.ts';
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs';

const root=resolve(import.meta.dirname,'..'),temporary=await mkdtemp(resolve(tmpdir(),'artel-trip-autofill-ui-'));
const snapshotDirectory=resolve(temporary,'snapshot'),operationsDirectory=resolve(temporary,'operations'),output=resolve(root,'qa/trip-autofill-2026-09-30');
await mkdir(output,{recursive:true});await writeTripsQaSnapshot(snapshotDirectory);
const baseSnapshot=await loadSnapshot(snapshotDirectory),store=new OperationsStore(operationsDirectory);
const company=(id,name,role)=>({id,name,roles:[role],managerLabels:[],shipmentIds:[],paymentIds:[],flags:[]});
await store.mutate(baseSnapshot.provenance.sourceSha256,data=>{
  data.sourceOperationsCleared=true;data.shipments={};data.paymentAllocations=[];
  data.companies=[company('qa-supplier','QA Склад','supplier'),company('qa-supplier2','QA Поставщик 2','supplier'),company('qa-recipient','QA Клиент','customer'),company('qa-carrier','QA Перевозчик','carrier'),company('qa-multiple','QA Несколько вариантов','carrier'),{...company('qa-default','QA Предпочтительный','carrier'),defaultDriverId:'qa-driver4',defaultVehicleId:'qa-vehicle4'}, {...company('qa-owner','QA Владелец','other'),address:'Юридический адрес, 99'}];
  data.directories={fleetSeedApplied:true,managers:[{id:'qa-manager',name:'QA Менеджер'}],products:[{id:'qa-product',name:'QA ДТ',transportProductKind:'diesel',cargoPackaging:'bulk'},{id:'qa-packaged',name:'QA ДТ в упаковке',transportProductKind:'diesel',cargoPackaging:'packaged'}],paymentForms:[{id:'qa-payment',name:'б/нал'}],
    vehicles:[{id:'qa-vehicle',plate:'Т000ЕЕ00',capacityLitres:'12000'},...[2,3,4,5].map(n=>({id:`qa-vehicle${n}`,plate:`Т00${n}ЕЕ00`,carrierId:n<4?'qa-multiple':'qa-default'}))],drivers:[{id:'qa-driver',name:'QA Водитель',vehicleId:'qa-vehicle',phone:'+79000000000'},...[2,3,4,5].map(n=>({id:`qa-driver${n}`,name:`QA Водитель ${n}`,vehicleId:`qa-vehicle${n}`,carrierId:n<4?'qa-multiple':'qa-default'}))],
    oilDepots:[{id:'qa-depot',name:'QA Нефтебаза',address:'Фактический адрес, 1',ownerCompanyId:'qa-owner',loadingActorCompanyId:'qa-recipient',infrastructureOwnerCompanyId:'qa-supplier'}],
    addresses:[{id:'qa-loading',companyId:'qa-supplier',kind:'loading',name:'QA Погрузка',address:'Синтетический склад, 1'},{id:'qa-delivery',companyId:'qa-recipient',kind:'delivery',name:'QA Доставка',address:'Синтетическая площадка, 2'}],
    customerManagers:[{companyId:'qa-recipient',managerId:'qa-manager'}],defaults:{profit:'template-payment-form'},duplicates:[]};
  return {changed:true,result:null};
});
const report={fixtureOnly:true,workingStoreAccessed:false,mockedWorkflowStates:true,providerCalls:0,checks:[],screenshots:[],errors:[]};
const check=name=>{report.checks.push(name);console.log('PASS',name);};
let runtime,browser;
try {
  const client=new SabyClient(sabyConfigFromEnv({}),async()=>{report.providerCalls++;throw new Error('External requests forbidden in trip autofill QA');});
  runtime=await startTripsQaServer({root,snapshotDirectory,operationsDirectory,sabyClient:client});
  const {cookie}=await bootstrapQaAuth(runtime.base);
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce',serviceWorkers:'block'});
  await authenticateContext(context,runtime.base,cookie);
  const page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  let mutationRequests=0;
  page.on('request',request=>{if(request.method()==='POST'&&/\/api\/shipment-trips\/[^/]+\/(?:saby|etrn)/.test(new URL(request.url()).pathname))mutationRequests++;});
  const choose=async(scope,label,name)=>{const picker=scope.getByRole('combobox',{name:new RegExp('^'+label)});await picker.fill(name);await scope.getByRole('listbox').getByRole('option',{name:new RegExp(name)}).first().click();await expect(picker).toHaveValue(name);};
  const shot=async name=>{const path=resolve(output,`${name}.png`);await page.screenshot({path,fullPage:true});report.screenshots.push(path);};
  const fit=async locator=>assert.ok(await locator.evaluate(node=>node.scrollWidth<=node.clientWidth+1),'Horizontal overflow');
  await page.goto(runtime.base+'/#trips');await page.getByRole('button',{name:'Новый рейс',exact:true}).click();
  let dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('combobox',{name:/^Наша организация/})).toHaveValue('АРТЕЛЬ');
  const nk=dialog.getByRole('checkbox',{name:'Собственный клиент НК Артэль — НК отправитель и перевозчик'});
  await nk.check();await expect(dialog.getByRole('combobox',{name:/^Наша организация/})).toHaveValue('НК АРТЕЛЬ');await nk.uncheck();
  await dialog.getByLabel('Дата отгрузки / погрузки',{exact:true}).fill('2026-10-07');
  await expect(dialog.getByLabel('Дата отгрузки / погрузки — время',{exact:true})).toBeEmpty();
  await expect(dialog.getByLabel('Плановая погрузка',{exact:true})).toHaveCount(0);
  await expect(dialog.getByLabel('Фактическая погрузка',{exact:true})).toHaveCount(0);
  await expect(dialog.getByTestId('trip-customer').first().getByLabel('Фактическая выгрузка',{exact:true})).toHaveValue('2026-10-07');
  await dialog.getByTestId('trip-customer').first().getByLabel('Фактическая выгрузка',{exact:true}).fill('2026-10-09');
  await dialog.getByLabel('Дата отгрузки / погрузки',{exact:true}).fill('2026-10-08');
  await expect(dialog.getByTestId('trip-customer').first().getByLabel('Фактическая выгрузка',{exact:true})).toHaveValue('2026-10-09');
  await dialog.getByLabel('Дата отгрузки / погрузки',{exact:true}).fill('2026-10-07');
  await choose(dialog,'Поставщик','QA Склад');await choose(dialog,'Нефтебаза','QA Нефтебаза');
  await choose(dialog,'Поставщик','QA Поставщик 2');await expect(dialog.getByRole('combobox',{name:'Нефтебаза',exact:true})).toHaveValue('QA Нефтебаза');
  await expect(dialog).toContainText('Фактический адрес, 1');await expect(dialog).toContainText('Юридический адрес, 99');
  await dialog.getByLabel('Цена поставщика за тонну, ₽',{exact:false}).fill('60000');
  await dialog.getByLabel('Плановая масса груза, т',{exact:false}).fill('8');await choose(dialog,'Товар','QA ДТ');
  await expect(dialog.getByLabel('Плановая масса брутто по документам, т',{exact:true})).toHaveCount(0);
  await choose(dialog,'Товар','QA ДТ в упаковке');await expect(dialog.getByLabel('Плановая масса брутто по документам, т',{exact:true})).toBeVisible();await choose(dialog,'Товар','QA ДТ');
  for(const [index,litres] of [[0,'6000'],[1,'4000']]) {
    if(index)await dialog.getByRole('button',{name:'Добавить клиента',exact:true}).click();
    const row=dialog.getByTestId('trip-customer').nth(index);
    await choose(row,'Клиент','QA Клиент');await choose(row,'Место выгрузки','QA Доставка');
    await row.getByLabel('Количество литров, л',{exact:false}).fill(litres);
    await row.getByLabel('Цена за литр, ₽',{exact:false}).fill('75');
    await row.getByLabel('Сумма перевозки, ₽',{exact:true}).fill('1000');
    await row.getByLabel('Примечание к доставке',{exact:true}).fill(`Синтетическая доставка ${index+1}`);
  }
  const first=dialog.getByTestId('trip-customer').first();
  await first.getByRole('button',{name:'Добавить промежуточную остановку'}).click();
  await first.getByLabel('Название остановки 1',{exact:true}).fill('QA обслуживание цистерны');
  await first.getByLabel('Адрес остановки 1',{exact:true}).fill('Синтетический сервис, 3');
  await dialog.getByLabel('Промежуточные остановки в заявке Saby').selectOption('false');
  await expect(dialog.getByRole('combobox',{name:/^Перевозчик/})).toHaveCount(0);
  const driverPicker=dialog.getByRole('combobox',{name:'Водитель *',exact:true});await expect(driverPicker).toBeEnabled();await expect(driverPicker).toHaveValue('');
  await expect(dialog.getByRole('combobox',{name:'Автомобиль *',exact:true})).toHaveValue('');await driverPicker.fill('QA Водитель');await expect(dialog.getByRole('listbox',{name:'Водитель',exact:true}).getByRole('option')).toHaveCount(5);await driverPicker.press('Escape');
  await choose(dialog,'Водитель','QA Водитель');await expect(dialog.getByRole('combobox',{name:'Автомобиль *',exact:true})).toHaveValue('Т000ЕЕ00');
  await choose(dialog,'Автомобиль','Т002ЕЕ00');await expect(driverPicker).toHaveValue('QA Водитель');await expect(dialog.getByRole('combobox',{name:'Автомобиль *',exact:true})).toHaveValue('Т002ЕЕ00');
  await choose(dialog,'Водитель','QA Водитель 5');await expect(dialog.getByRole('combobox',{name:'Автомобиль *',exact:true})).toHaveValue('Т005ЕЕ00');await choose(dialog,'Водитель','QA Водитель');
  for(const width of [1440,390]){await page.setViewportSize({width,height:1050});await fit(dialog);await shot(`new-trip-${width}`);}
  await dialog.getByRole('button',{name:'Сохранить рейс',exact:true}).click();await expect(dialog).toHaveCount(0);
  const card=page.getByTestId('trip-card');await expect(card).toHaveCount(1);await expect(card).toContainText('Доставок: 2');
  const routeItems=card.locator('.trip-deliveries > li');await expect(routeItems).toHaveCount(3);
  await expect(routeItems.nth(0)).toContainText('Синтетическая доставка 1');await expect(routeItems.nth(1)).toContainText('QA обслуживание цистерны');await expect(routeItems.nth(2)).toContainText('Синтетическая доставка 2');
  const trips=(await(await context.request.get(runtime.base+'/api/shipment-trips')).json()).trips,trip=trips[0];
  assert.equal(trips.length,1);assert.equal(new Set(trip.customers.map(row=>row.id)).size,2);
  assert.equal(trip.fields.loading_planned_at,'2026-10-07');assert.equal(trip.fields.loading_actual_at,'2026-10-07');
  assert.equal(trip.fields.quantity_tonnes,'8');assert.equal(trip.fields.quantity_gross_tonnes,'8');
  assert.equal(trip.fields.oil_depot_id,'qa-depot');assert.equal(trip.fields.loading_address,'Фактический адрес, 1');assert.equal(trip.fields.supplier_id,'qa-supplier2');
  assert.equal(trip.customers[0].fields.unloading_actual_at,'2026-10-09');assert.equal(trip.customers[1].fields.unloading_actual_at,'2026-10-07');
  assert.equal(trip.fields.intermediate_stops_in_order,'false');
  assert.equal(trip.fields.carrier_id,null);assert.equal(trip.fields.driver_id,'qa-driver');assert.equal(trip.fields.vehicle_id,'qa-vehicle');
  check('Bulk diesel uses one mass; depot remains independent; date/manual unloading preserved; all drivers selectable without company and only explicit driver default chooses vehicle');

  const panel=page.getByRole('region',{name:'Документы рейса в Saby',exact:true});
  await expect(panel.getByRole('button',{name:'Создать заявку в Saby',exact:true})).toHaveCount(1);
  await expect(panel.getByRole('button',{name:'Создать заявку в Saby',exact:true})).toBeDisabled();
  await expect(panel).toContainText('Подготовка заявки');await expect(panel).toContainText('Для создания заявки заполните');
  assert.equal(mutationRequests,0);assert.equal(report.providerCalls,0);
  const preflight=await context.request.post(`${runtime.base}/api/shipment-trips/${trip.id}/saby-workflow`,{data:{}});
  assert.equal(preflight.status(),422);assert.equal(report.providerCalls,0);
  const after=await store.read(baseSnapshot.provenance.sourceSha256);assert.equal(after.tripSaby,undefined);assert.equal(after.saby,undefined);assert.equal(after.etrn,undefined);
  await card.getByRole('button',{name:'Saby',exact:true}).click();await card.getByRole('button',{name:'Saby',exact:true}).click();
  await expect(panel.getByRole('button',{name:'Создать заявку в Saby',exact:true})).toBeDisabled();assert.equal(mutationRequests,0);
  check('Opening and saving never start exchange; one send button is blocked by real whole-trip preflight with zero external requests');

  let releaseLoad;const loadGate=new Promise(resolve=>{releaseLoad=resolve;});
  const tripUrl=`${runtime.base}/api/shipment-trips/${trip.id}`;
  await page.route(tripUrl,async route=>{if(route.request().method()==='GET')await loadGate;await route.continue();});
  await card.getByRole('button',{name:'Изменить рейс',exact:true}).click();dialog=page.getByRole('dialog');
  await expect(dialog.getByRole('status')).toContainText('Загружаем');await expect(dialog.getByRole('button',{name:'Сохранить рейс',exact:true})).toBeDisabled();
  releaseLoad();await expect(dialog.getByLabel('Дата отгрузки / погрузки',{exact:true})).toHaveValue('2026-10-07');
  await expect(dialog.getByLabel('Плановая масса груза, т',{exact:false})).toHaveValue('8');
  await expect(dialog.getByTestId('trip-customer').first().getByLabel('Название остановки 1',{exact:true})).toHaveValue('QA обслуживание цистерны');
  await dialog.getByRole('button',{name:'Отмена',exact:true}).click();await page.unroute(tripUrl);
  check('Existing trip waits for complete loading; saved route and timing reopen without replacement by empty defaults');

  await store.mutate(baseSnapshot.provenance.sourceSha256,data=>{
    for(const row of trip.customers) Object.assign(data.shipments[row.id].fields,{loading_planned_at:'2026-10-06T10:30',loading_actual_at:'2026-10-07T11:45',quantity_gross_tonnes:'8.2',carrier_id:'qa-carrier'});
    return {changed:true,result:null};
  });await page.reload();
  await card.getByRole('button',{name:'Изменить рейс',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog).toContainText('Сохранены исторические даты');
  await dialog.getByLabel('Примечание к рейсу',{exact:true}).fill('QA сохраняем историю');await dialog.getByRole('button',{name:'Сохранить рейс',exact:true}).click();await expect(dialog).toHaveCount(0);
  let saved=(await(await context.request.get(tripUrl)).json()).trip;
  assert.equal(saved.fields.date,'2026-10-07');assert.equal(saved.fields.loading_planned_at,'2026-10-06T10:30');assert.equal(saved.fields.loading_actual_at,'2026-10-07T11:45');assert.equal(saved.fields.quantity_gross_tonnes,'8.2');assert.equal(saved.fields.carrier_id,'qa-carrier');
  check('Saving unrelated notes preserves historical date, loading plan/fact, gross mass and hidden carrier ID without requiring company fleet links');

  await card.getByRole('button',{name:'Изменить рейс',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByLabel('Дата отгрузки / погрузки',{exact:true})).toHaveValue('2026-10-06');
  await dialog.getByLabel('Дата отгрузки / погрузки',{exact:true}).fill('2026-10-08');
  await dialog.getByLabel('Дата отгрузки / погрузки — время',{exact:true}).fill('12:30');
  await page.route(tripUrl,async route=>{if(route.request().method()==='PATCH'){await route.fetch();await route.abort('connectionfailed');}else await route.continue();});
  await dialog.getByRole('button',{name:'Сохранить рейс',exact:true}).click();await expect(dialog).toHaveCount(0);await page.unroute(tripUrl);
  saved=(await(await context.request.get(tripUrl)).json()).trip;
  assert.equal(saved.fields.date,'2026-10-08');assert.equal(saved.fields.loading_planned_at,'2026-10-08T12:30');assert.equal(saved.fields.loading_actual_at,'2026-10-08T12:30');assert.equal(saved.customers[0].fields.unloading_actual_at,'2026-10-09');
  check('Explicit unified date synchronizes loading; lost PATCH reply recovers persisted loading alias without duplicate or conflict');

  await card.getByRole('button',{name:'Изменить рейс',exact:true}).click();dialog=page.getByRole('dialog');await expect(dialog.getByRole('combobox',{name:'Водитель *',exact:true})).toHaveValue('QA Водитель');
  await choose(dialog,'Водитель','QA Водитель 2');await expect(dialog.getByRole('combobox',{name:'Автомобиль *',exact:true})).toHaveValue('Т002ЕЕ00');await choose(dialog,'Автомобиль','Т003ЕЕ00');
  await dialog.getByRole('button',{name:'Сохранить рейс',exact:true}).click();await expect(dialog).toHaveCount(0);
  saved=(await(await context.request.get(tripUrl)).json()).trip;assert.equal(saved.fields.driver_id,'qa-driver2');assert.equal(saved.fields.vehicle_id,'qa-vehicle3');assert.equal(saved.fields.carrier_id,'qa-carrier');assert.equal(saved.customers[0].fields.unloading_actual_at,'2026-10-09');
  check('Changing driver selects its explicit vehicle; manual alternative saves while historical legal carrier and manual dates remain intact');

  const workflow={status:'not_sent',phase:'preparation',ready:true,blockers:[],locked:false,updatedAt:null,lastError:null,order:null,deliveries:trip.customers.map(row=>({shipmentId:row.id,id:null,status:'not_sent',lastError:null})),carrierConfirmed:false,loadingFacts:null};
  let state=structuredClone(workflow),postCount=0,releaseSend;
  const sendGate=new Promise(resolve=>{releaseSend=resolve;});
  await page.route(`**/api/shipment-trips/${trip.id}/saby-workflow`,async route=>{
    if(route.request().method()==='POST'){
      postCount++;assert.deepEqual(route.request().postDataJSON(),{});
      if(postCount===1){await sendGate;state={...state,status:'sent',phase:'awaiting_carrier',locked:true,order:{id:'synthetic-order',number:'42',date:'2026-10-07',status:'draft',url:'https://saby.ru/',revision:'synthetic-revision',remoteStatus:'Синтетическая заявка',signatureStatus:'not_signed',remoteStateCode:'0',exchangeStage:'sender_action_required'}};}
      else state={...state,phase:'awaiting_loading',carrierConfirmed:true};
    }
    await route.fulfill({json:state});
  });
  if(await card.getByRole('button',{name:'Saby',exact:true}).getAttribute('aria-expanded')==='true')await card.getByRole('button',{name:'Saby',exact:true}).click();
  await card.getByRole('button',{name:'Saby',exact:true}).click();
  const send=panel.getByRole('button',{name:'Создать заявку в Saby',exact:true});await expect(send).toBeEnabled();
  await send.evaluate(button=>{button.click();button.click();});await expect(send).toBeDisabled();assert.equal(postCount,1);releaseSend();
  await expect(panel).toContainText('АРТЕЛЬ · подпись и отправка');await expect(panel.getByRole('heading',{name:'Фактическая погрузка'})).toHaveCount(0);
  await expect(panel.getByRole('button',{name:'Создать заявку в Saby',exact:true})).toHaveCount(0);
  await panel.getByRole('button',{name:'Обновить из Saby',exact:true}).click();await expect(panel.getByRole('heading',{name:'Фактическая погрузка'})).toBeVisible();
  await expect(panel.getByLabel('Прибытие на погрузку · Москва',{exact:true})).toBeEmpty();
  await expect(panel.getByLabel('Убытие с погрузки · Москва',{exact:true})).toBeEmpty();
  await expect(panel.getByLabel('Фактическая масса груза, т',{exact:true})).toHaveCount(2);
  for(const input of await panel.getByLabel('Фактическая масса груза, т',{exact:true}).all())await expect(input).toBeEmpty();
  await expect(panel.getByRole('button',{name:'Сохранить погрузку и продолжить',exact:true})).toBeDisabled();
  for(const width of [1440,390]){await page.setViewportSize({width,height:1050});await fit(panel);await shot(`awaiting-loading-mocked-${width}`);}
  assert.equal(postCount,2);assert.equal(report.providerCalls,0);assert.deepEqual(report.errors,[]);
  check('Mocked workflow UI prevents double-click, waits for carrier, then requests empty actual loading facts without inventing them; desktop/mobile fit');
} finally {
  await browser?.close();await runtime?.server.close();
  await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2));
  await rm(temporary,{recursive:true,force:true});
}

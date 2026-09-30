// Browser -> real authenticated HTTP/workflow/store/client -> synthetic Saby transport.
// No production data. Reported signatures below are synthetic bytes, not valid CMS signatures.
import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { SabyClient } from '../server/saby-client.ts';
import { integrationRuntime, integrationApi, integrationConfig, integrationSettings } from '../tests/helpers/trip-saby-integration.ts';
import { bootstrapQaAuth, authenticateContext } from './qa-auth.mjs';
import { startTripsQaServer } from './qa-trips-runtime.mjs';

const root=resolve(import.meta.dirname,'..'),output=resolve(root,'qa/trips-etrn-runtime-2026-09-30');
await mkdir(output,{recursive:true});
const rt=await integrationRuntime(),transport=integrationApi(),config=integrationConfig(),blobs=new Map(),downloads=[];
const previousSettings=process.env.SABY_AUTOFILL_PROFILE_JSON;
process.env.SABY_AUTOFILL_PROFILE_JSON=JSON.stringify(integrationSettings);
const report={fixtureOnly:true,workingStoreAccessed:false,realSabyRequests:0,bankRequests:0,mockedHttpResponses:false,delayedWorkflowResponses:0,syntheticProvider:true,checks:[],errors:[],unexpectedRequests:[],screenshots:[],providerMethods:{}};
const check=name=>{report.checks.push(name);console.log('PASS',name);};
let enteredReservation,releaseReservation,pauseReservation=true;
const reservationStarted=new Promise(resolve=>{enteredReservation=resolve;});
const reservationGate=new Promise(resolve=>{releaseReservation=resolve;});
const provider=async(url,init)=>{
  if(init?.method==='GET'){
    assert.equal(new Headers(init.headers).get('X-SBISSessionID'),config.sessionId);
    const address=String(url);downloads.push(address);
    if(blobs.has(address))return new Response(blobs.get(address));
    assert.equal(address,'https://disk.saby.ru/carrier.xml');return transport.send(url,init);
  }
  const rpc=JSON.parse(String(init?.body));
  if(pauseReservation&&rpc.method==='СБИС.ЗаписатьДокумент'&&!rpc.params.Документ.Идентификатор){pauseReservation=false;enteredReservation();await reservationGate;}
  const result=await transport.send(url,init);
  if(rpc.method==='СБИС.ЗаписатьДокумент'&&rpc.params.Документ.Вложение){
    const document=rpc.params.Документ;blobs.set(`https://disk.saby.ru/${document.Идентификатор}.xml`,Buffer.from(document.Вложение[0].Файл.ДвоичныеДанные,'base64'));
  }
  return result;
};
const uploads=type=>transport.writes(type).filter(call=>call.params.Документ.Вложение).map(call=>call.params.Документ);
const decode=document=>new TextDecoder('windows-1251').decode(Buffer.from(document.Вложение[0].Файл.ДвоичныеДанные,'base64'));
let runtime,browser,page,releaseStaleRead=()=>{};
try{
  runtime=await startTripsQaServer({root,snapshotDirectory:rt.snapshotDirectory,operationsDirectory:resolve(rt.directory,'store'),sabyClient:new SabyClient(config,provider)});
  const {base}=runtime,{cookie}=await bootstrapQaAuth(base);
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:1440,height:1050},reducedMotion:'reduce',serviceWorkers:'block',timezoneId:'Europe/Moscow'});
  await context.route('**/*',route=>{
    if(new URL(route.request().url()).origin===base)return route.continue();
    report.unexpectedRequests.push(route.request().url());return route.abort();
  });
  await authenticateContext(context,base,cookie);
  const api=async(path,method='GET',data)=>{
    const response=await context.request.fetch(base+path,{method,...(data===undefined?{}:{data})});
    assert.ok(response.ok(),`${method} ${path}: ${response.status()} ${await response.text()}`);return response.json();
  };
  const workflowPath=`/api/shipment-trips/${rt.tripId}/saby-workflow`,etrnPath=`/api/shipment-trips/${rt.tripId}/etrn`;
  const ready=await api(workflowPath);assert.equal(ready.ready,true,ready.blockers.join(' '));assert.equal(ready.phase,'preparation');assert.equal(transport.calls.length,0);
  const initialData=await rt.store.read(rt.source),accounting=structuredClone(initialData.shipments),recipientInn=initialData.companies.find(row=>row.id==='customer').inn;
  page=await context.newPage();await page.clock.install();page.on('pageerror',reason=>report.errors.push(reason.message));
  const shot=async name=>{const path=resolve(output,`${name}.png`);await page.screenshot({path,fullPage:true});report.screenshots.push(path);};
  await page.goto(base+'/#trips');await page.getByRole('button',{name:'Изменить рейс',exact:true}).click();
  const tripEditor=page.getByRole('dialog');await expect(tripEditor.getByRole('combobox',{name:'Водитель *',exact:true})).toBeEnabled();await expect(tripEditor.getByRole('combobox',{name:'Водитель *',exact:true})).not.toHaveValue('');await expect(tripEditor.getByRole('combobox',{name:/^Перевозчик/})).toHaveCount(0);await expect(tripEditor.getByRole('combobox',{name:'Автомобиль *',exact:true})).toBeEnabled();
  await tripEditor.getByRole('button',{name:'Отмена',exact:true}).click();await expect(tripEditor).toHaveCount(0);
  await page.getByRole('button',{name:'Saby',exact:true}).click();
  const panel=page.getByRole('region',{name:'Документы рейса в Saby',exact:true}),send=panel.getByRole('button',{name:'Создать заявку в Saby',exact:true});
  await expect(send).toBeEnabled();await expect(send).toHaveCount(1);assert.equal(transport.calls.length,0);
  await send.evaluate(button=>{button.click();button.click();});await reservationStarted;await expect(send).toBeDisabled();releaseReservation();
  await expect(panel).toContainText('АРТЕЛЬ · подпись и отправка');await expect(panel.getByRole('heading',{name:'№ 41',exact:true})).toBeVisible();
  assert.equal(transport.reserves('TransportOrder').length,1);assert.equal(transport.writes('TransportOrder').length,2);assert.equal(transport.writes('ConsignmentNote').length,0);
  assert.match(decode(uploads('TransportOrder')[0]),/КНД="1110361"/);assert.match(decode(uploads('TransportOrder')[0]),/Точка только общей заявки/);
  assert.equal((await api(workflowPath)).phase,'awaiting_carrier');await expect(panel.getByRole('heading',{name:'Фактическая погрузка'})).toHaveCount(0);
  check('One browser action reserves one order number and uploads one whole-trip order; double-click is safe and no CN precedes carrier acceptance');

  await expect(panel).toHaveAttribute('aria-busy','false');
  const beforePoll=transport.calls.length,postRequests=[],readRequests=[];
  page.on('request',request=>{if(request.url().endsWith(workflowPath)){if(request.method()==='POST')postRequests.push(request.url());if(request.method()==='GET')readRequests.push(request.url());}});
  await page.clock.fastForward(60001);
  await expect.poll(()=>readRequests.length).toBe(1);
  await expect.poll(async()=>await panel.getAttribute('aria-busy')).toBe('false');
  await page.waitForTimeout(100);assert.equal(postRequests.length,0);assert.equal(transport.calls.length,beforePoll);
  assert.equal((await api(workflowPath)).status,'not_sent');
  check('Minute browser polling only reads durable state, never POSTs or mislabels a draft as sent');

  // Hold the real pre-confirmation GET response while the manual POST advances the workflow.
  // Only delivery timing changes: the delayed response body comes from the authenticated API.
  let staleWorkflow=null,delayNextRead=true;
  const staleReadGate=new Promise(resolve=>{releaseStaleRead=resolve;});
  const workflowUrl=base+workflowPath;
  const delayWorkflowRead=async route=>{
    if(route.request().method()!=='GET'||!delayNextRead)return route.fallback();
    delayNextRead=false;
    const response=await route.fetch();staleWorkflow=await response.json();
    await staleReadGate;
    await route.fulfill({response});report.delayedWorkflowResponses++;
  };
  await page.route(workflowUrl,delayWorkflowRead);
  const delayedResponse=page.waitForResponse(response=>response.url()===workflowUrl&&response.request().method()==='GET');
  void delayedResponse.catch(()=>{}); // Cleanup may close the page before a failed precondition releases the response.
  await page.clock.fastForward(60001);
  await expect.poll(()=>staleWorkflow?.phase).toBe('awaiting_carrier');
  assert.equal(staleWorkflow.carrierConfirmed,false);
  const postsBeforeAcceptance=postRequests.length;
  transport.accept();await panel.getByRole('button',{name:'Обновить из Saby',exact:true}).click();
  await expect(panel.getByRole('heading',{name:'Фактическая погрузка',exact:true})).toBeVisible();
  await expect(panel).toHaveAttribute('aria-busy','false');
  assert.equal(postRequests.length,postsBeforeAcceptance+1);
  assert.equal((await api(workflowPath)).phase,'awaiting_loading');assert.equal(transport.writes('ConsignmentNote').length,0);
  releaseStaleRead();await(await delayedResponse).finished();
  // Flush response parsing and the next render frames before asserting the accepted UI survives.
  await page.clock.runFor(100);
  await expect(panel.locator('.workflow-current strong')).toHaveText('Заявка подтверждена · нужны факты погрузки');
  await expect(panel.getByRole('heading',{name:'Фактическая погрузка',exact:true})).toBeVisible();
  await expect(panel.locator('.etrn-loading-facts')).toHaveCount(1);
  await expect(panel).toHaveAttribute('aria-busy','false');
  assert.equal(report.delayedWorkflowResponses,1);
  assert.equal(postRequests.length,postsBeforeAcceptance+1);
  await page.unroute(workflowUrl,delayWorkflowRead);
  check('A delayed pre-confirmation GET cannot overwrite the manual POST acceptance or hide the actual-loading form');
  const form=panel.locator('.etrn-loading-facts');
  await expect(form.getByLabel('Прибытие на погрузку · Москва',{exact:true})).toBeEmpty();await expect(form.getByLabel('Убытие с погрузки · Москва',{exact:true})).toBeEmpty();
  for(const field of await form.getByLabel('Фактическая масса груза, т',{exact:true}).all())await expect(field).toBeEmpty();
  await expect(form.getByRole('button',{name:'Сохранить погрузку и продолжить',exact:true})).toBeDisabled();
  for(const width of [1440,390]){await page.setViewportSize({width,height:1050});assert.ok(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1));await shot(`awaiting-actual-loading-${width}`);}
  const facts=rt.facts();await form.getByLabel('Прибытие на погрузку · Москва',{exact:true}).fill(facts.arrivedAt);await form.getByLabel('Убытие с погрузки · Москва',{exact:true}).fill(facts.departedAt);
  for(const [index,row] of rt.trip.customers.entries()){
    const value=facts.deliveries[row.id],delivery=form.locator('fieldset').nth(index);
    await delivery.getByLabel('Фактическая масса груза, т',{exact:true}).fill(value.grossMassTonnes);await delivery.getByLabel('Способ определения массы').selectOption(value.massMethod);
  }
  await form.getByRole('checkbox',{name:'Подтверждаю фактические сведения погрузки всего рейса'}).check();await form.getByRole('button',{name:'Сохранить погрузку и продолжить',exact:true}).click();
  await expect(panel).toContainText('ЭТрН созданы · ожидают обработки');await expect(panel.locator('.etrn-delivery')).toHaveCount(2);
  const completed=await api(workflowPath);assert.equal(completed.phase,'completed');assert.equal(completed.order.number,'41');
  assert.equal(transport.reserves('ConsignmentNote').length,2);assert.equal(transport.writes('ConsignmentNote').length,4);
  const cnUploads=uploads('ConsignmentNote');assert.deepEqual(cnUploads.map(row=>row.Номер),['100','101']);assert.equal(new Set(cnUploads.map(row=>row.Идентификатор)).size,2);
  for(const [index,document] of cnUploads.entries()){
    const xml=decode(document);assert.match(xml,new RegExp(`<СвИП ИННФЛ="${recipientInn}"`));assert.match(xml,/НомЗак="41"/);assert.doesNotMatch(xml,/Точка только общей заявки|Собственная остановка/);
    assert.match(xml,new RegExp(`Объем="${index?'6':'8'}"`));assert.match(xml,new RegExp(`МасБрутОтгр="${index?'5200':'7000'}"`));assert.equal(document.Грузополучатель.СвЮЛ,undefined);
  }
  const etrn=await api(etrnPath);assert.ok(etrn.deliveries.every(row=>row.document.signatureStatus==='not_signed'));assert.deepEqual((await rt.store.read(rt.source)).shipments,accounting);
  check('A signed synthetic carrier title is verified via real HTTP; staff loading facts create two numbered IP CNs for repeated recipients, linked to the one order and excluding intermediate stops');

  for(const [index,row] of etrn.deliveries.entries()){
    const file=row.document.files.find(file=>file.extension==='xml');assert.ok(file);
    const link=panel.locator('.etrn-delivery').nth(index).getByRole('link',{name:file.name,exact:true});await expect(link).toBeVisible();assert.equal(await link.getAttribute('href'),file.url);
    assert.equal((await fetch(base+file.url)).status,401);
    const response=await context.request.get(base+file.url);assert.equal(response.status(),200);const bytes=await response.body();assert.ok(bytes.equals(blobs.get(`https://disk.saby.ru/${row.document.id}.xml`)));
    const count=downloads.length;assert.ok((await(await context.request.get(base+file.url)).body()).equals(bytes));assert.equal(downloads.length,count);
    const refreshed=(await api(etrnPath)).deliveries[index].document.files.find(saved=>saved.id===file.id);assert.equal(refreshed.size,bytes.length);assert.equal(refreshed.sha256,createHash('sha256').update(bytes).digest('hex'));
  }
  check('Authenticated XML downloads match uploaded bytes, persist SHA-256, and use private cache on repeat; anonymous downloads are denied');

  for(const row of etrn.deliveries){
    const document=transport.docs.get(row.document.id),fileUrl=`https://disk.saby.ru/${row.document.id}.sig`;
    document.Вложение[0].Подпись=[{Сертификат:{Отпечаток:'SYNTHETIC-REPORTED-ONLY'},Файл:{Имя:`${row.document.id}.sig`,Ссылка:fileUrl}}];document.ГИС_УИД=`SYNTHETIC-GIS-${row.document.id}`;document.Состояние={Название:'Синтетическое ожидание участника'};
    blobs.set(fileUrl,Buffer.from(`Synthetic signature for ${row.document.id}; not a valid cryptographic signature`));
  }
  const writesBeforeRefresh=transport.writes().length;await panel.getByRole('button',{name:'Обновить из Saby',exact:true}).click();
  await expect(panel.getByText(/Подпись: Saby сообщает о наличии подписи/)).toHaveCount(2);await expect(panel.getByText(/ГИС ЭПД: Saby вернул идентификатор/)).toHaveCount(2);assert.equal(transport.writes().length,writesBeforeRefresh);
  const signed=await api(etrnPath);
  for(const row of signed.deliveries){
    assert.equal(row.document.signatureStatus,'reported_by_saby');const signature=row.document.files.find(file=>file.extension==='sig');assert.ok(signature);
    const response=await context.request.get(base+signature.url);assert.equal(response.status(),200);assert.ok((await response.body()).equals(blobs.get(`https://disk.saby.ru/${row.document.id}.sig`)));
  }
  check('Global refresh reads both CNs and signature files; provider signature/GIS evidence remains separate from cryptographic verification or participant completion');

  runtime.replaceMiddleware(new SabyClient(config,provider));await page.reload();await page.getByRole('button',{name:'Saby',exact:true}).click();await expect(panel.getByText(/Подпись: Saby сообщает о наличии подписи/)).toHaveCount(2);
  const repeated=await api(workflowPath,'POST',{});assert.equal(repeated.phase,'completed');assert.equal(transport.writes().length,writesBeforeRefresh);assert.deepEqual((await api(etrnPath)).deliveries.map(row=>row.document.id),signed.deliveries.map(row=>row.document.id));
  const edit={fields:rt.trip.fields,customers:rt.trip.customers.map(({id,fields})=>({id,fields})),versions:Object.fromEntries(rt.trip.customers.map(row=>[row.id,row.version]))};
  assert.equal((await context.request.patch(base+`/api/shipment-trips/${rt.tripId}`,{data:edit})).status(),409);assert.equal((await context.request.delete(base+`/api/shipment-trips/${rt.tripId}`,{data:{versions:edit.versions}})).status(),409);
  for(const width of [1440,390]){await page.setViewportSize({width,height:1050});assert.ok(await panel.evaluate(node=>node.scrollWidth<=node.clientWidth+1));await shot(`created-cns-reported-signatures-${width}`);}
  const persisted=await readFile(resolve(rt.directory,'store','operations.json'),'utf8'),publicResponse=JSON.stringify({workflow:await api(workflowPath),etrn:await api(etrnPath)});
  assert.ok(!persisted.includes(config.sessionId));assert.ok(!publicResponse.includes(config.sessionId));assert.ok(!publicResponse.includes('https://disk.saby.ru/'));assert.ok(!publicResponse.includes('ДвоичныеДанные'));assert.deepEqual(report.errors,[]);assert.deepEqual(report.unexpectedRequests,[]);
  check('Middleware/browser restart preserves IDs and evidence; repeats create no duplicates, sent trips reject edits/deletion, and credentials/vendor URLs stay private');
}catch(reason){report.failure=reason.message;await page?.screenshot({path:resolve(output,'failure.png'),fullPage:false}).catch(()=>{});throw reason;}
finally{
  releaseReservation();releaseStaleRead();for(const call of transport.calls)report.providerMethods[call.method]=(report.providerMethods[call.method]??0)+1;
  await browser?.close();await runtime?.server.close();await rt.close();if(previousSettings===undefined)delete process.env.SABY_AUTOFILL_PROFILE_JSON;else process.env.SABY_AUTOFILL_PROFILE_JSON=previousSettings;
  await writeFile(resolve(output,'browser.json'),JSON.stringify(report,null,2));
}

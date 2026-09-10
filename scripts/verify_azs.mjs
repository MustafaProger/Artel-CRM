import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { bootstrapQaAuth, installQaFetchAuth, authenticateContext } from './qa-auth.mjs';

const root=resolve(import.meta.dirname,'..'),port=5188,base=`http://127.0.0.1:${port}`;
const output=process.env.ARTEL_QA_OUTPUT||resolve(root,'qa/azs');await mkdir(output,{recursive:true});
const store=await mkdtemp(resolve(tmpdir(),'artel-azs-ui-'));
const original=resolve(root,'data/local-operations/operations.json');
const hash=async path=>existsSync(path)?createHash('sha256').update(await readFile(path)).digest('hex'):null;
const before=await hash(original),report={checks:[],screenshots:[],errors:[],measurements:[],productionPreview:true};
const check=name=>{report.checks.push(name);console.log('PASS',name)};
let server,browser,page,restoreFetch;
const request=async(method,path,body)=>{const response=await fetch(base+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});const result=await response.json();assert.ok(response.ok,JSON.stringify(result));return result};
try {
  await assert.rejects(fetch(base,{signal:AbortSignal.timeout(500)}),'QA port must be unused');
  server=spawn(process.execPath,[resolve(root,'node_modules/vite/bin/vite.js'),'preview','--host','127.0.0.1','--port',String(port),'--strictPort'],{cwd:root,env:{...process.env,ARTEL_STORE_DIR:store,CHECKO_API_KEY:''},stdio:'ignore'});
  let ready=false;for(let count=0;count<100;count++){try{if((await fetch(base+'/api/auth/session')).ok){ready=true;break}}catch{}await new Promise(done=>setTimeout(done,100))}assert.ok(ready,'QA server did not start');
  const {cookie}=await bootstrapQaAuth(base);restoreFetch=installQaFetchAuth(base,cookie);
  let snapshot=await request('GET','/api/snapshot?shipments=omit');
  const manager=snapshot.directories.managers[0],product=snapshot.directories.products[0];
  const customer=(await request('POST','/api/directories',{kind:'companies',name:'АЗС QA Покупатель',roles:['customer'],managerId:manager.id,addresses:[]})).entry;
  const supplier=(await request('POST','/api/directories',{kind:'companies',name:'АЗС QA Поставщик',roles:['supplier'],addresses:[]})).entry;
  snapshot=await request('GET','/api/snapshot?shipments=omit');
  browser=await chromium.launch({headless:true,executablePath:'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'});
  const context=await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',acceptDownloads:true});await authenticateContext(context,base,cookie);
  page=await context.newPage();page.on('pageerror',error=>report.errors.push(error.message));
  const screenshot=async name=>{const path=resolve(output,`${name}.png`);await page.screenshot({path,fullPage:true});report.screenshots.push(path)};
  const choose=async(scope,label,name)=>{const input=scope.getByRole('combobox',{name:new RegExp(`^${label}`)});await input.click();await input.fill(name);await expect(scope.getByRole('listbox').getByRole('option').first()).toBeVisible();const exact=scope.getByRole('listbox').getByRole('option',{name,exact:true});if(await exact.count()===1)await exact.click();else await input.press('Enter');await expect(input).toHaveValue(name)};
  await page.goto(base+'/#shipments');await expect(page.getByRole('tab',{name:'Бензовозы',exact:true})).toHaveAttribute('aria-selected','true');
  await expect(page.getByTestId('shipment-row').first()).toBeVisible();
  assert.deepEqual(await page.locator('.shipment-column-headings th').evaluateAll(items=>items.slice(0,3).map(item=>item.dataset.field)),['document_number','month','date']);
  await expect(page.locator('th[data-field="purchase_unit"]')).toHaveCount(0);
  await page.getByRole('tab',{name:'АЗС',exact:true}).click();await expect(page.getByTestId('shipments-loaded-count')).toHaveAttribute('data-total','0');
  const expected=['date','customer_name','document_number','month','customer_inn','manager_label','payment_form','product','quantity_litres','customer_amount','purchase_amount','sale_price_per_litre','supplier_name','supplier_inn','kvp_source','profit_source','paid_amount_source','debt_overpayment_source','days_since_shipment'];
  assert.deepEqual(await page.locator('.shipment-column-headings th').evaluateAll(items=>items.map(item=>item.dataset.field)),expected);
  await expect(page.getByLabel('Вид таблицы')).toHaveCount(0);await expect(page.getByLabel('Форма расчёта').locator('option[value="f2"]')).toHaveCount(0);check('separate workspaces, tanker UPD/month/date, exact AZS table, no F2');
  await page.getByRole('button',{name:'Добавить отгрузку',exact:true}).click();let editor=page.getByRole('dialog',{name:'Добавить отгрузку АЗС',exact:true});
  await editor.getByLabel('УПД',{exact:true}).fill('AZS-QA-001');await editor.getByLabel('Дата',{exact:true}).fill('2026-09-01');
  await choose(editor,'Контрагент',customer.name);await expect(editor.getByRole('combobox',{name:/^Менеджер/})).toHaveValue(manager.name);
  await choose(editor,'Поставщик',supplier.name);await choose(editor,'Товар',product.name);await choose(editor,'Форма оплаты','б/нал');
  await editor.getByRole('combobox',{name:/^Форма оплаты/}).click();await expect(editor.getByRole('option',{name:'ф2',exact:true})).toHaveCount(0);await editor.getByRole('combobox',{name:/^Форма оплаты/}).press('Escape');
  await editor.getByLabel('Количество литров',{exact:true}).fill('1000');await editor.getByLabel('Сумма покупателя, ₽',{exact:true}).fill('100000');await editor.getByLabel('Сумма поставщика, ₽',{exact:true}).fill('80000');
  const outputText=async label=>(await editor.locator(`output[aria-label="${label}"]`).innerText()).replace(/\s/g,'');
  assert.equal(await outputText('Прибыль, ₽'),'20000');assert.equal(await outputText('Цена продажи за литр, ₽'),'—');assert.equal(await outputText('КВП'),'—');
  await choose(editor,'Форма оплаты','нал');assert.equal(await outputText('Прибыль, ₽'),'33600');await choose(editor,'Форма оплаты','б/нал');
  for(const width of [1440,768,390,320]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));assert.ok(await editor.evaluate(element=>element.scrollWidth<=element.clientWidth+1));await screenshot(`editor-${width}`)}
  await page.setViewportSize({width:1440,height:1000});await editor.getByRole('button',{name:'Сохранить отгрузку',exact:true}).click();await expect(editor).toHaveCount(0);await expect(page.getByTestId('shipments-loaded-count')).toHaveAttribute('data-total','1');
  let rows=(await request('GET','/api/shipments?type=azs')).items;assert.equal(rows.length,1);let row=rows[0];assert.equal(row.fields.document_number,'AZS-QA-001');assert.equal(row.fields.profit_source,'20000');assert.equal(row.cost,'80000');check('AZS create UI, optional UPD, role-based companies, automatic manager, both profit previews, exact persistence');
  for(const width of [1440,1024,768,390,320]){await page.setViewportSize({width,height:1000});const measurement=await page.evaluate(()=>({width:innerWidth,doc:document.documentElement.scrollWidth,tableHeight:document.querySelector('.shipment-grid-scroll').clientHeight,rowHeight:document.querySelector('[data-testid="shipment-row"]').getBoundingClientRect().height}));assert.ok(measurement.doc<=width+1);assert.equal(measurement.rowHeight,38);assert.ok(measurement.tableHeight>500);report.measurements.push(measurement);await screenshot(`table-${width}`)}
  await page.setViewportSize({width:1440,height:1000});
  await page.getByLabel('Формат таблицы АЗС').selectOption('small');
  const small=['date','customer_name','manager_label','payment_form','quantity_litres','customer_amount','purchase_amount','supplier_name','profit_source','paid_amount_source'];
  assert.deepEqual(await page.locator('.shipment-column-headings th').evaluateAll(items=>items.map(item=>item.dataset.field)),small);
  await expect(page.locator('.shipment-actions-heading')).toHaveCount(0);
  await expect(page.getByTestId('shipment-row').locator('td')).toHaveCount(10);
  await page.getByRole('button',{name:`Редактировать отгрузку ${row.id}`,exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('dialog').getByRole('button',{name:'Отмена',exact:true}).click();
  for(const width of [1440,768,390,320]){await page.setViewportSize({width,height:1000});assert.ok(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth+1));await screenshot(`small-${width}`)}
  const smallDownload=page.waitForEvent('download');await page.getByRole('button',{name:'CSV',exact:true}).click();const smallCsv=await readFile(await(await smallDownload).path(),'utf8');assert.equal(smallCsv.split('\n')[0].split(';').length,10);
  await page.reload();await page.getByRole('tab',{name:'АЗС',exact:true}).click();await expect(page.getByLabel('Формат таблицы АЗС')).toHaveValue('small');
  await page.getByLabel('Формат таблицы АЗС').selectOption('medium');await expect(page.locator('.shipment-column-headings th')).toHaveCount(19);
  await page.setViewportSize({width:1440,height:1000});
  check('AZS medium/small switch, exact 10 columns including CSV, date opens editor, preference persists and mobile fits');
  await page.getByRole('button',{name:`Редактировать отгрузку ${row.id}`,exact:true}).click();editor=page.getByRole('dialog',{name:'Изменить отгрузку АЗС',exact:true});await choose(editor,'Форма оплаты','нал');await editor.getByRole('button',{name:'Сохранить отгрузку',exact:true}).click();await expect(editor).toHaveCount(0);
  await page.reload();await page.getByRole('tab',{name:'АЗС',exact:true}).click();await expect(page.getByTestId('shipments-loaded-count')).toHaveAttribute('data-total','1');row=(await request('GET',`/api/shipments/${row.id}`)).shipment;assert.equal(row.fields.profit_source,'33600');assert.equal(row.fields.sale_price_per_litre,null);
  const downloadEvent=page.waitForEvent('download');await page.getByRole('button',{name:'CSV',exact:true}).click();const csv=await readFile(await(await downloadEvent).path(),'utf8');assert.ok(csv.includes('AZS-QA-001'));assert.ok(csv.includes('33600'));assert.ok(csv.includes('Сумма поставщика'));assert.ok(!csv.includes('Сумма перевозки'));check('responsive table/editor, cash edit persists after reload and AZS CSV excludes tanker fields');
  await page.getByRole('tab',{name:'Бензовозы',exact:true}).click();await page.getByLabel('Поиск отгрузок',{exact:true}).fill(row.id);await expect(page.getByTestId('shipments-loaded-count')).toHaveAttribute('data-total','0');await page.getByLabel('Поиск отгрузок',{exact:true}).fill('');await page.getByRole('tab',{name:'АЗС',exact:true}).click();await expect(page.getByTestId('shipments-loaded-count')).toHaveAttribute('data-total','1');
  await page.getByRole('button',{name:`Удалить отгрузку ${row.id}`,exact:true}).click();let deletion=page.getByRole('dialog',{name:'Удалить эту отгрузку?',exact:true});await expect(deletion).toContainText(customer.name);await deletion.getByRole('button',{name:'Отмена',exact:true}).click();assert.equal((await request('GET','/api/shipments?type=azs')).total,1);
  await page.getByRole('button',{name:`Удалить отгрузку ${row.id}`,exact:true}).click();deletion=page.getByRole('dialog',{name:'Удалить эту отгрузку?',exact:true});await deletion.getByRole('button',{name:'Удалить операцию',exact:true}).click();await expect(deletion).toHaveCount(0);await expect(page.getByTestId('shipments-loaded-count')).toHaveAttribute('data-total','0');
  await page.reload();await page.getByRole('tab',{name:'АЗС',exact:true}).click();await expect(page.getByTestId('shipments-loaded-count')).toHaveAttribute('data-total','0');check('AZS absent from tanker search, deletion confirmation and cancel, permanent delete after reload');
  assert.equal(await hash(original),before);assert.deepEqual(report.errors,[]);report.status='passed';
}catch(error){report.status='failed';report.error=String(error.stack||error);if(page)await page.screenshot({path:resolve(output,'failure.png'),fullPage:true}).catch(()=>{});throw error}
finally{restoreFetch?.();await writeFile(resolve(output,'verification.json'),JSON.stringify(report,null,2));await browser?.close();server?.kill('SIGTERM');await rm(store,{recursive:true,force:true})}

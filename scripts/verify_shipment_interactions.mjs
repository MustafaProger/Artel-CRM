import { chromium, expect } from '@playwright/test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

// Read-only checks against the local application. No operation/company writes.
const base = process.env.ARTEL_UI_BASE || 'http://127.0.0.1:5173';
const report = {status:'running',checkedAt:new Date().toISOString(),checks:[],consoleErrors:[]};
const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await chromium.launch({headless:true,...(existsSync(chrome) ? {executablePath:chrome} : {})});
const context = await browser.newContext({viewport:{width:1440,height:1000},reducedMotion:'reduce',acceptDownloads:true});
const page = await context.newPage();
page.on('pageerror',error => report.consoleErrors.push(error.message));
const check = (name,details = {}) => {report.checks.push({name,...details});console.log(`PASS ${name}`)};
const parseCsv = text => {
  const rows = [];let row = [],cell = '',quoted = false;
  for(let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;i < text.length;i++) {
    const char = text[i];
    if(char === '"') {if(quoted && text[i + 1] === '"') {cell += '"';i++} else quoted = !quoted}
    else if(char === ';' && !quoted) {row.push(cell);cell = ''}
    else if((char === '\r' || char === '\n') && !quoted) {if(char === '\r' && text[i + 1] === '\n') i++;row.push(cell);rows.push(row);row = [];cell = ''}
    else cell += char;
  }
  if(cell || row.length) {row.push(cell);rows.push(row)}
  return rows;
};
try {
  const snapshot = await (await fetch(`${base}/api/snapshot`)).json();
  await page.goto(`${base}/#shipments`);
  const loaded = () => page.getByTestId('shipments-loaded-count');
  const search = () => page.getByLabel('Поиск отгрузок',{exact:true});
  const scroll = () => page.getByTestId('shipments-scroll');
  await page.getByRole('button',{name:'Все',exact:true}).click();
  await expect(loaded()).toHaveAttribute('data-total',String(snapshot.shipments.length));
  await expect(loaded()).toHaveAttribute('data-loaded','50');
  for(const [name,columnCount] of [['Расширенный',27],['Стандарт',19],['Уменьшенный',10]]) {
    await page.getByRole('button',{name,exact:true}).click();
    const downloadEvent = page.waitForEvent('download');
    await page.getByRole('button',{name:'Экспорт CSV',exact:true}).click();
    const download = await downloadEvent;
    const stream = await download.createReadStream();
    const chunks = [];
    for await(const chunk of stream) chunks.push(chunk);
    const csv = parseCsv(Buffer.concat(chunks).toString('utf8'));
    assert.equal(csv.length,snapshot.shipments.length + 1,'CSV includes every filtered operation');
    assert(csv.every(row => row.length === columnCount),'CSV uses the chosen template columns');
    await expect(loaded()).toHaveAttribute('data-loaded','50');
    check(`CSV ${name}: all operations while only 50 loaded`,{operations:csv.length - 1,columns:columnCount});
  }
  await page.reload();
  await expect(page.getByRole('button',{name:'Уменьшенный',exact:true})).toHaveAttribute('aria-pressed','true');
  check('Template preference persists after reload');

  await page.getByRole('button',{name:'Все',exact:true}).click();
  await expect(loaded()).toHaveAttribute('data-total',String(snapshot.shipments.length));
  const period = snapshot.monthly.find(item => item.month === '2026-08')?.month || snapshot.monthly.at(-1).month;
  const manager = snapshot.managers.find(item => item.shipmentCount > 10).label;
  await page.getByLabel('Период',{exact:true}).selectOption(period);
  await page.getByLabel('Фильтр менеджера',{exact:true}).selectOption(manager);
  const expected = await (await fetch(`${base}/api/shipments?${new URLSearchParams({period,manager,settlement:'all',limit:'50',offset:'0'})}`)).json();
  await expect(loaded()).toHaveAttribute('data-total',String(expected.total));
  assert(expected.total > 0);
  check('Period and manager filters use the complete server result',{period,manager,total:expected.total});
  await page.getByLabel('Период',{exact:true}).selectOption('all');
  await page.getByLabel('Фильтр менеджера',{exact:true}).selectOption('all');
  await expect(loaded()).toHaveAttribute('data-loaded','50');

  let failedMore = false;
  const failMore = async route => {
    const url = new URL(route.request().url());
    if(url.searchParams.get('offset') === '50' && !failedMore) {failedMore = true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Тестовая ошибка подгрузки'})})}
    else await route.continue();
  };
  await page.route('**/api/shipments?**',failMore);
  await scroll().evaluate(element => {element.scrollTop = element.scrollHeight - element.clientHeight - 100});
  await expect(page.getByRole('alert')).toHaveText('Тестовая ошибка подгрузки');
  await expect(loaded()).toHaveAttribute('data-loaded','50');
  await page.getByRole('button',{name:'Повторить',exact:true}).click();
  await expect.poll(async () => Number(await loaded().getAttribute('data-loaded'))).toBeGreaterThanOrEqual(100);
  await page.unroute('**/api/shipments?**',failMore);
  check('Failed next page preserves loaded rows and manual retry succeeds');

  let failedInitial = false;
  const failInitial = async route => {
    const url = new URL(route.request().url());
    if(url.searchParams.get('query') === 'QA_INITIAL_RETRY' && !failedInitial) {failedInitial = true;await route.fulfill({status:503,contentType:'application/json',body:JSON.stringify({error:'Тестовая ошибка первой загрузки'})})}
    else await route.continue();
  };
  await page.route('**/api/shipments?**',failInitial);
  await search().fill('QA_INITIAL_RETRY');
  await expect(page.getByRole('alert')).toHaveText('Тестовая ошибка первой загрузки');
  await page.getByRole('button',{name:'Повторить загрузку',exact:true}).click();
  await expect(page.getByText('Операций пока нет',{exact:true})).toBeVisible();
  await expect(loaded()).toHaveAttribute('data-loaded','0');
  await page.unroute('**/api/shipments?**',failInitial);
  check('Initial load error offers a successful retry and correct empty state');

  let releaseSlow;
  const pendingSlow = new Promise(resolve => {releaseSlow = resolve});
  let slowStarted;
  const started = new Promise(resolve => {slowStarted = resolve});
  const slowResponse = async route => {
    const url = new URL(route.request().url());
    if(url.searchParams.get('query') === 'QA_STALE_RESPONSE') {
      slowStarted();await pendingSlow;
      await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({...expected,total:987654,items:expected.items})}).catch(() => {});
    } else await route.continue();
  };
  await page.route('**/api/shipments?**',slowResponse);
  await search().fill('QA_STALE_RESPONSE');await started;
  await search().fill('');
  await expect(loaded()).toHaveAttribute('data-total',String(snapshot.shipments.length));
  releaseSlow();
  await page.waitForTimeout(300);
  await expect(loaded()).toHaveAttribute('data-total',String(snapshot.shipments.length));
  await expect(loaded()).toHaveAttribute('data-loaded','50');
  await page.unroute('**/api/shipments?**',slowResponse);
  check('Changing a filter aborts and ignores an older delayed response');

  await page.getByRole('button',{name:'Добавить отгрузку',exact:true}).click();
  const editor = page.getByRole('dialog',{name:'Добавить отгрузку',exact:true});
  await editor.getByLabel('УПД',{exact:true}).fill('QA_DISCARD_NOT_SAVED');
  await page.keyboard.press('Escape');
  await expect(editor).toBeVisible();
  await expect(editor.getByText('Есть несохранённые изменения.',{exact:true})).toBeVisible();
  await editor.getByRole('button',{name:'Продолжить',exact:true}).click();
  await expect(editor.getByLabel('УПД',{exact:true})).toHaveValue('QA_DISCARD_NOT_SAVED');
  await editor.getByRole('button',{name:'Закрыть редактор',exact:true}).click();
  await editor.getByRole('button',{name:'Закрыть без сохранения',exact:true}).click();
  await expect(editor).toHaveCount(0);
  check('Escape preserves unsaved edits until explicit discard');
  assert.deepEqual(report.consoleErrors,[]);
  const finalSnapshot = await (await fetch(`${base}/api/snapshot`)).json();
  assert.deepEqual(finalSnapshot.shipments,snapshot.shipments);
  check('No operation was changed by read-only interaction checks');
  report.status = 'passed';
} catch(error) {report.status = 'failed';report.error = String(error);process.exitCode = 1;console.error(error)}
finally {await browser.close();report.completedAt = new Date().toISOString();await writeFile(resolve('qa/shipments-interactions.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({status:report.status,checks:report.checks.length}))}

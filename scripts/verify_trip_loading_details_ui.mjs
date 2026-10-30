// Isolated component UI: synthetic HTTP responses, no working store or provider.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';

const root = resolve(import.meta.dirname, '..'), output = resolve(root, 'qa/trip-loading-details');
await mkdir(output, { recursive: true });
const bundled = await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import TripEtrnPanel from './TripEtrnPanel'; import './shipments.css'; import './design-system.css'; const trip={id:'qa-loading',fields:{trip_flow_version:'driver-v1'},customers:[{id:'delivery',version:1,paidAmount:'0',fields:{customer_id:'client',unloading_address:'Синтетическая площадка'}}]}; createRoot(document.getElementById('root')).render(<main className="app-shell shipments-workspace"><TripEtrnPanel trip={trip} data={{companies:[{id:'client',name:'Синтетический клиент'}],directories:{}}}/></main>);`, loader: 'tsx', resolveDir: resolve(root, 'web/src') }, bundle: true, write: false, outfile: resolve(output, 'app.js'), define: { 'process.env.NODE_ENV': '"production"' } });
const assets = Object.fromEntries(bundled.outputFiles.map(file => [file.path.endsWith('.css') ? '/app.css' : '/app.js', file.contents]));
let state, record, puts, reads, otherWrites, reject;
const reset = () => {
  state = { documentMode: 'nk_direct_etrn', ready: false, blockers: ['Укажите сведения о погрузке'], locked: false, deliveries: [], phase: 'preparation', order: null, history: [], monitoring: { enabled: false }, automation: { enabled: false, mode: 'after_driver_departure' } };
  record = { details: null, editable: true, required: true, autoContinuation: true, mode: 'depot', loadingActor: { name: 'Синтетическая организация погрузки', inn: '7700000000' }, infrastructureOwner: null, version: 'v1' };
  puts = []; reads = 0; otherWrites = []; reject = false;
};
reset();
const server = createServer(async (request, response) => {
  const path = new URL(request.url, 'http://localhost').pathname;
  const json = (body, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); };
  if (path.endsWith('/loading-details')) {
    if (request.method === 'GET') { reads++; return json(record); }
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks)); puts.push(body);
    if (reject) return json({ error: 'Сведения о погрузке изменились.' }, 409);
    assert.equal(body.version, record.version);
    record = { ...record, details: body.details, version: `v${puts.length + 1}` }; return json(record);
  }
  if (request.method !== 'GET') otherWrites.push(path);
  if (path.endsWith('/saby-workflow')) return json(state);
  if (path.endsWith('/etrn')) return json({ deliveries: [] });
  if (path.endsWith('/saby')) return json({ saby: { documents: [] } });
  if (assets[path]) { response.writeHead(200, { 'content-type': path.endsWith('css') ? 'text/css' : 'text/javascript' }); return response.end(assets[path]); }
  response.writeHead(200, { 'content-type': 'text/html' }); response.end('<!doctype html><html lang="ru"><title>Проверка сведений о погрузке</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><style>body{margin:0;padding:12px;font-family:Arial,sans-serif;color:#243c34;background:#fff}*{box-sizing:border-box}.app-shell{max-width:900px;margin:auto}.button{display:inline-flex;align-items:center;gap:8px;background:#fff;border:1px solid #547963;color:#173f30}.button.primary{background:#176849;color:#fff}.etrn-note{color:#4c6458;font-size:13px;line-height:1.6}</style><div id="root"></div><script type="module" src="/app.js"></script></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const report = { synthetic: true, productionStoreAccessed: false, providerCalls: 0, checks: [], screenshots: [] };
let browser;
try {
  for (const [engine, factory] of [['chromium', chromium], ['webkit', webkit]]) {
    reset();
    browser = await factory.launch({ headless: true, ...(engine === 'chromium' ? { executablePath: process.env.PLAYWRIGHT_CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' } : {}) });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort());
    const form = page.getByRole('region', { name: 'Сведения о погрузке', exact: true });
    await page.goto(base); await expect(form.getByLabel('Фамилия', { exact: true })).toHaveValue('');
    await expect(page.getByText('Черновик ЭТрН: нужны сведения', { exact: true })).toBeVisible();
    await expect(form.getByText('Если водитель уже убыл, после заполнения всех сведений обработка ЭТрН продолжится автоматически.', { exact: true })).toBeVisible();
    await expect(form.getByRole('combobox', { name: 'Основание полномочий сотрудника', exact: true })).toHaveValue('');
    await form.getByLabel('Наименование документа', { exact: true }).fill('Договор погрузки');
    await form.getByRole('button', { name: 'Сохранить сведения', exact: true }).click();
    await expect(form.getByText('Сведения сохранены для этого рейса.', { exact: true })).toBeVisible();
    assert.equal(puts.length, 1); assert.equal(puts[0].details.worker.authority, ''); assert.equal(puts[0].details.worker.surname, '');
    report.checks.push(`${engine}: partial draft saves without invented people, authority or external exchange`);
    await form.getByLabel(/^Номер документа/).fill('15'); await form.getByLabel('Дата документа', { exact: true }).fill('2026-10-21');
    await form.getByLabel(/^ИНН сторон документа/).fill('7700000000, 7700000001');
    await form.getByLabel('Фамилия', { exact: true }).fill('Иванов'); await form.getByLabel('Имя', { exact: true }).fill('Иван'); await form.getByLabel('Должность', { exact: true }).fill('Кладовщик');
    await form.getByRole('combobox', { name: 'Основание полномочий сотрудника', exact: true }).selectOption('document');
    const authority = form.getByRole('group', { name: 'Документ о полномочиях сотрудника', exact: true });
    await authority.getByRole('combobox', { name: 'Как указать документ', exact: true }).selectOption('electronic');
    await authority.getByLabel('Идентификатор электронного документа', { exact: true }).fill('qa-authority-id'); await authority.getByLabel(/^ИНН сторон документа/).fill('7700000000');
    await form.getByRole('button', { name: 'Сохранить сведения', exact: true }).click(); await expect(form.getByRole('button', { name: 'Сохранить сведения', exact: true })).toBeDisabled();
    assert.equal(puts[1].details.worker.authorityDocument.documentId, 'qa-authority-id'); assert.deepEqual(puts[1].details.basis.issuerInns, ['7700000000', '7700000001']);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1100 }); assert.ok(await form.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
      const path = resolve(output, `${engine}-${width}.png`); await form.screenshot({ path }); report.screenshots.push(path);
    }
    const axe = await new AxeBuilder({ page }).include('.trip-loading-details').withTags(['wcag2a', 'wcag2aa']).analyze(); report.accessibility ??= []; report.accessibility.push({ engine, violations: axe.violations }); assert.deepEqual(axe.violations.map(row => row.id), []);
    report.checks.push(`${engine}: paper/electronic basis and employee authority, 320/390/1440px, scoped axe`);
    reject = true; await form.getByLabel('Фамилия', { exact: true }).fill('Петров'); await form.getByRole('button', { name: 'Сохранить сведения', exact: true }).click();
    await expect(form.getByText('Сведения о погрузке изменились.', { exact: true })).toBeVisible(); await expect(form.getByRole('button', { name: 'Сохранить сведения', exact: true })).toBeDisabled(); await expect(form.getByLabel('Фамилия', { exact: true })).toHaveValue('Петров');
    await form.getByRole('button', { name: 'Загрузить сохранённые сведения', exact: true }).click(); await expect(form.getByLabel('Фамилия', { exact: true })).toHaveValue('Иванов');
    state.locked = true; state.previousExchanges = [{ at: '2026-10-21T11:00:00Z', documents: [{ number: '2', url: 'https://tms.saby.ru/docview/qa', status: 'Проблемы при доставке' }, { number: '3', url: 'javascript:alert(1)', status: 'Черновик' }] }]; record.editable = false; await page.reload(); await expect(form).toContainText('Обмен уже начат.'); await expect(form.getByRole('textbox')).toHaveCount(0); await expect(form.getByRole('button', { name: 'Сохранить сведения', exact: true })).toHaveCount(0);
    await page.getByText('Предыдущие накладные', { exact: true }).click(); await expect(page.getByRole('link', { name: 'Накладная № 2' })).toHaveAttribute('href', 'https://tms.saby.ru/docview/qa'); await expect(page.getByRole('link', { name: 'Накладная № 3' })).toHaveCount(0);
    record = { ...record, mode: 'sender', required: false, loadingActor: { name: 'Синтетический НК', inn: '7700000001' }, infrastructureOwner: { name: 'Синтетический владелец нефтебазы', inn: '7700000002' }, carrierResponsible: { surname: 'Синтетический', name: 'Ответственный', patronymic: 'Тестовый', phone: '+70000000000' } }; await page.reload();
    await expect(form).toContainText('Отправитель:Синтетический НК'); await expect(form).toContainText('Владелец нефтебазы:Синтетический владелец нефтебазы');
    await expect(form).toContainText('Ответственный НК:Синтетический Ответственный Тестовый');
    await expect(form.getByRole('textbox')).toHaveCount(0); await expect(form.getByRole('button')).toHaveCount(0); await expect(form).not.toContainText('Основание погрузки');
    await page.setViewportSize({ width: 320, height: 1100 }); assert.ok(await form.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    const senderPath = resolve(output, `${engine}-sender-320.png`); await form.screenshot({ path: senderPath }); report.screenshots.push(senderPath);
    const senderAxe = await new AxeBuilder({ page }).include('.trip-loading-details').withTags(['wcag2a', 'wcag2aa']).analyze(); report.accessibility.push({ engine, mode: 'sender', violations: senderAxe.violations }); assert.deepEqual(senderAxe.violations.map(row => row.id), []);
    record.carrierResponsible = null; await page.reload(); await expect(form).toContainText('Отправитель:Синтетический НК'); await expect(form).not.toContainText('Ответственный НК:');
    record.mode = 'depot'; await page.reload(); await expect(page.getByRole('region', { name: 'Документы рейса в Saby' })).toBeVisible(); await expect(form).toHaveCount(0);
    const readsBefore = reads; state = { ...state, documentMode: 'artel_to_nk', locked: false, notRequired: true }; await page.reload(); await expect(page.getByRole('heading', { name: 'ЭТрН не нужна', exact: true })).toBeVisible(); assert.equal(reads, readsBefore);
    assert.deepEqual(otherWrites, []); assert.deepEqual(errors, []);
    report.checks.push(`${engine}: stale-write conflict preserved input, locked read-only, confirmed sender/infrastructure summary, same-sender depot hidden, ordinary path no details request`);
    await browser.close(); browser = null;
  }
  console.log(JSON.stringify({ passed: true, checks: report.checks.length, report: resolve(output, 'report.json') }));
} catch (error) { report.failure = error.message; throw error; }
finally { await browser?.close(); await new Promise(resolve => server.close(resolve)); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); }

// UI contract checks only: synthetic HTTP responses, no working store or Saby access.
// Run: node --import tsx scripts/verify_trips_etrn.mjs
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { emptyEtrnProfile } from '../web/src/EtrnProfileForm.tsx';

const root = resolve(import.meta.dirname, '..');
const output = resolve(root, 'qa/trips-etrn-2026-09-29');
await mkdir(output, { recursive: true });
const trip = { id: 'synthetic-trip', fields: { date: '2026-09-29' }, customers: [{ id: 'synthetic-shipment', fields: { customer_id: 'synthetic-client' } }] };
const snapshot = { companies: [{ id: 'synthetic-client', name: 'Синтетический клиент' }] };
const endpoint = '/api/shipment-trips/synthetic-trip/etrn';
const profile = emptyEtrnProfile();
profile.recipient = { name: 'Синтетический получатель', inn: '7707083893', kpp: '770701001', address: 'Синтетический адрес, 1', phone: '+79990000001', edoId: '' };
const state = { configured: true, configurationBlockers: [], deliveries: [{ shipmentId: 'synthetic-shipment', profile, blockers: ['Подтвердите сведения этой доставки.'], document: null }], updatedAt: null };
const report = { fixtureOnly: true, workingStoreAccessed: false, realSabyRequests: 0, checks: [], errors: [], unexpectedRequests: [], screenshots: [], overflows: [] };
const check = name => { report.checks.push(name); console.log('PASS', name); };
const calls = [];
let unknownNext = false;
const stubDocument = () => ({ id: 'synthetic-document', revision: 'synthetic-revision', status: 'draft', url: 'https://online.saby.ru/document/synthetic-document', remoteStatus: 'Черновик', lastError: null, updatedAt: '2026-09-29T10:00:00Z', files: [{ id: 'synthetic-xml', name: 'Синтетическая ЭТрН.xml', extension: 'xml', size: 2000, url: `${endpoint}/files/synthetic-shipment/synthetic-xml` }], signatureStatus: 'not_signed', gisStatus: null, availableActions: ['Подписать и отправить'] });
const server = await createServer({
  configFile: false, envDir: false, root: resolve(root, 'web'),
  plugins: [react(), {
    name: 'synthetic-etrn-view',
    resolveId(id) { if (id === 'virtual:etrn-view') return '\0etrn-view'; },
    load(id) { if (id === '\0etrn-view') return `import React from 'react'; import {createRoot} from 'react-dom/client'; import TripEtrnPanel from '/src/TripEtrnPanel.tsx'; import '/src/styles.css'; import '/src/apple-theme.css'; import '/src/shipments.css'; import '/src/trips.css'; createRoot(document.getElementById('root')).render(React.createElement(TripEtrnPanel,{trip:${JSON.stringify(trip)},data:${JSON.stringify(snapshot)}}));`; },
    configureServer(vite) { vite.middlewares.use(async (request, response, next) => {
      if (request.url !== '/qa/etrn') return next();
      response.setHeader('Content-Type', 'text/html');
      response.end(await vite.transformIndexHtml('/qa/etrn', '<!doctype html><html lang="ru"><head><title>Синтетическая проверка ЭТрН</title><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="root" style="max-width:1000px;margin:0 auto;padding:12px"></main><script type="module" src="/@id/virtual:etrn-view"></script></body></html>'));
    }); },
  }], server: { host: '127.0.0.1', port: 0, cors: false },
});
await server.listen();
const base = `http://127.0.0.1:${server.httpServer.address().port}`;
let browser, page;
try {
  browser = await chromium.launch({ headless: true, executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' });
  const context = await browser.newContext({ viewport: { width: 1280, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block', timezoneId: 'Europe/Moscow' });
  await context.route('**/*', async route => {
    const request = route.request(), url = new URL(request.url());
    if (url.origin !== base) { report.unexpectedRequests.push(url.href); return route.abort(); }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    calls.push({ path: url.pathname, method: request.method(), body: request.postDataJSON() });
    if (url.pathname.endsWith('/saby')) return route.fulfill({ json: { saby: { status: 'ready', documents: [] }, readiness: { ready: true, blockers: [] } } });
    if (request.method() === 'PUT' && url.pathname === endpoint) {
      const body = request.postDataJSON(); assert.equal(body.shipmentId, 'synthetic-shipment');
      state.deliveries[0].profile = structuredClone(body.profile);
      state.deliveries[0].blockers = body.profile.confirmed ? [] : ['Подтвердите сведения этой доставки.'];
    } else if (url.pathname === endpoint + '/submit') {
      assert.deepEqual(request.postDataJSON(), { shipmentId: 'synthetic-shipment' });
      await new Promise(resolve => setTimeout(resolve, 80));
      state.deliveries[0].document = unknownNext ? { ...stubDocument(), id: null, status: 'unknown', url: null, files: [], remoteStatus: null, signatureStatus: 'unknown', availableActions: [], lastError: 'Ответ потерян. Нужна сверка.' } : stubDocument();
      unknownNext = false;
    } else if (url.pathname === endpoint + '/refresh') {
      assert.deepEqual(request.postDataJSON(), { shipmentId: 'synthetic-shipment' });
      state.deliveries[0].document = stubDocument();
    } else if (url.pathname.includes('/files/')) return route.fulfill({ contentType: 'application/xml', body: '<synthetic/>' });
    return route.fulfill({ json: state });
  });
  page = await context.newPage(); page.on('pageerror', reason => report.errors.push(reason.message));
  await page.goto(base + '/qa/etrn');
  const panel = page.getByRole('region', { name: 'ЭТрН в Saby', exact: true });
  const delivery = page.getByTestId('etrn-delivery');
  const submit = delivery.getByRole('button', { name: 'Создать ЭТрН в Saby', exact: true });
  await expect(submit).toBeDisabled();
  await expect(delivery.getByLabel('Наименование', { exact: true })).toHaveValue('Синтетический получатель');
  await expect(delivery.getByLabel('Идентификатор участника ЭДО, если известен')).toHaveValue('');
  const fill = async (label, value) => delivery.getByLabel(label, { exact: true }).fill(value);
  await fill('Номер заявки на перевозку', 'QA-100'); await fill('Дата заявки', '2026-09-29');
  await delivery.getByLabel('Роль грузоотправителя', { exact: true }).selectOption('0');
  await fill('Телефон грузоотправителя', '+79990000002'); await fill('Телефон перевозчика', '+79990000003');
  await fill('Транспортное наименование груза', 'Синтетический груз'); await fill('Состояние груза', 'Исправное');
  await fill('Код вида тары', '00'); await fill('Способ упаковки', 'Без упаковки'); await fill('Количество грузовых мест', '1'); await fill('Маркировка', 'Отсутствует');
  await delivery.getByLabel('Способ определения массы', { exact: true }).selectOption('03');
  await fill('Фактическая масса этой доставки, т', '8,25'); await delivery.getByLabel('Опасный груз', { exact: true }).selectOption('yes');
  await fill('Номер ООН', '1202'); await fill('Надлежащее отгрузочное наименование', 'Синтетическое описание'); await fill('Класс опасности', '3'); await fill('Классификационный код', 'F1'); await fill('Группа упаковки', 'III'); await fill('Знаки опасности', '3'); await fill('Код ограничения проезда через тоннели', 'D/E');
  await fill('Тип транспортного средства', 'Синтетическая цистерна'); await fill('Марка', 'QA'); await fill('Грузоподъёмность, т', '12'); await fill('Вместимость, м³', '20');
  await delivery.getByLabel('Основание владения автомобилем', { exact: true }).selectOption('3');
  await fill('Наименование документа', 'Синтетическая аренда'); await fill('Номер документа', 'QA-A'); await fill('Дата документа', '2026-09-01');
  const issuers = delivery.getByLabel('ИНН составителей через запятую'); await issuers.pressSequentially('7707083893,7736050003');
  await expect(issuers).toHaveValue('7707083893, 7736050003');
  for (const group of ['Водитель выбранного рейса', 'Подписант грузоотправителя']) {
    const section = delivery.getByRole('group', { name: group, exact: true });
    await section.getByLabel('Фамилия', { exact: true }).fill('Тестов'); await section.getByLabel('Имя', { exact: true }).fill('Тест'); await section.getByLabel('Отчество, если есть').fill('Тестович');
  }
  await fill('Прибытие под погрузку', '2026-09-29T10:00'); await fill('Убытие после погрузки', '2026-09-29T11:00');
  for (const group of ['Лицо, осуществляющее погрузку', 'Владелец объекта погрузки']) await delivery.getByRole('group', { name: group, exact: true }).getByLabel('Совпадает с грузоотправителем').selectOption('yes');
  await fill('Нормативные требования к перевозке', 'Синтетические требования'); await fill('Лицо, дающее указания о переадресовке', 'Тестовый отправитель'); await fill('Способ получения указаний о переадресовке', 'По телефону'); await fill('Телефон для переадресовки', '+79990000001');
  await delivery.getByLabel('Перегрузка', { exact: true }).selectOption('1'); await fill('Должность', 'Директор'); await delivery.getByLabel('Основание полномочий подписанта', { exact: true }).selectOption('1');
  const confirmation = delivery.getByRole('checkbox', { name: /Данные проверены/ });
  await confirmation.check(); await fill('Номер заявки на перевозку', 'QA-101'); await expect(confirmation).not.toBeChecked(); await confirmation.check();
  await expect(submit).toBeDisabled(); await delivery.getByRole('button', { name: 'Сохранить и проверить', exact: true }).click();
  await expect(submit).toBeEnabled();
  const saved = state.deliveries[0].profile;
  assert.equal(saved.deliveryMassTonnes, '8.25'); assert.deepEqual(saved.vehicle.ownershipDocument.issuerInns, ['7707083893', '7736050003']); assert.equal(saved.confirmed, true); assert.equal(saved.signer.status, '1'); assert.equal(saved.consignorPhone, '+79990000002'); assert.equal(saved.carrierPhone, '+79990000003');
  await expect(delivery.getByRole('link', { name: 'Скачать XML грузоотправителя', exact: true })).toHaveAttribute('href', endpoint + '/xml/synthetic-shipment');
  check('Ordinary labeled form preserves all delivery facts, conditional dangerous cargo/ownership fields, Moscow times, comma decimals and multi-party INNs; edits clear confirmation and require saving before submission');
  for (const width of [1280, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    const dimensions = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
    if (dimensions.scroll > width + 1) report.overflows.push(dimensions);
    const path = resolve(output, `form-${width}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path);
  }
  assert.deepEqual(report.overflows, []); check('Desktop and 390/320 px mobile form has no horizontal overflow');
  await page.setViewportSize({ width: 1280, height: 1000 });
  await submit.evaluate(button => { button.click(); button.click(); });
  await expect(delivery).toContainText('Создано в Saby');
  assert.equal(calls.filter(call => call.path.endsWith('/submit')).length, 1);
  await expect(submit).toHaveCount(0); await expect(delivery.getByLabel('Номер заявки на перевозку', { exact: true })).toBeDisabled();
  await expect(delivery.getByRole('link', { name: 'Открыть для подписания в Saby' })).toHaveAttribute('href', 'https://online.saby.ru/document/synthetic-document');
  await expect(delivery).toContainText('Подпись не получена'); await expect(delivery).toContainText('Подтверждение не получено');
  await expect(delivery.getByRole('link', { name: 'Синтетическая ЭТрН.xml' })).toHaveAttribute('href', endpoint + '/files/synthetic-shipment/synthetic-xml');
  check('Double click submits once, freezes the sent profile and exposes Saby signing/file links while signature and GIS remain explicitly unconfirmed');
  state.deliveries[0].document = null; unknownNext = true; await page.reload(); await delivery.getByRole('button', { name: 'Создать ЭТрН в Saby', exact: true }).click();
  await expect(delivery).toContainText('Результат требует сверки'); await expect(delivery.getByRole('button', { name: 'Создать ЭТрН в Saby', exact: true })).toHaveCount(0);
  await delivery.getByRole('button', { name: 'Сверить с Saby', exact: true }).click(); await expect(delivery).toContainText('Создано в Saby');
  assert.equal(calls.filter(call => call.path.endsWith('/submit')).length, 2); assert.equal(calls.filter(call => call.path.endsWith('/refresh')).length, 1);
  check('Unknown result offers reconciliation without another creation and shows the existing document after refresh');
  state.deliveries[0].document.url = 'https://saby.ru.attacker.example/document'; state.deliveries[0].document.files[0].url = 'https://attacker.example/file';
  await page.reload(); await expect(delivery).toContainText('Создано в Saby'); await expect(delivery.getByRole('link', { name: 'Открыть для подписания в Saby' })).toHaveCount(0); await expect(delivery.getByRole('link', { name: 'Синтетическая ЭТрН.xml' })).toHaveCount(0);
  check('Lookalike Saby domains and off-origin file links cannot be opened from the UI');
  state.configured = false; state.configurationBlockers = ['Синтетический доступ не настроен.']; state.deliveries[0].document = null;
  await page.reload(); await expect(panel).toContainText('Подключение не настроено'); await expect(delivery.getByRole('button', { name: 'Создать ЭТрН в Saby', exact: true })).toBeDisabled();
  await expect(delivery.getByRole('button', { name: 'Сохранить и проверить', exact: true })).toBeEnabled();
  check('An unconfigured connector blocks transmission while preparation remains available');
  assert.deepEqual(report.errors, []); assert.deepEqual(report.unexpectedRequests, []);
} catch (reason) {
  report.failure = reason.message;
  await page?.screenshot({ path: resolve(output, 'failure.png'), fullPage: true }).catch(() => {});
  throw reason;
} finally {
  await browser?.close(); await server.close();
  await writeFile(resolve(output, 'browser.json'), JSON.stringify(report, null, 2));
}

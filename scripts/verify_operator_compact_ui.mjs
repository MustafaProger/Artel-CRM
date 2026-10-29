// Compact operator UI acceptance. Temporary synthetic store, no browser business writes or external traffic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { chromium, webkit, expect } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { OperationsStore } from '../server/operations-store.ts';
import { writeTripsQaSnapshot } from './qa-trips-runtime.mjs';
import { startOperatorQaServer } from './qa-operator-runtime.mjs';
import { authenticateContext } from './qa-auth.mjs';
const root = resolve(import.meta.dirname, '..'), temporary = await mkdtemp(resolve(tmpdir(), 'operator-case-tables-'));
const output = resolve(process.env.ARTEL_OPERATOR_QA_OUTPUT || resolve(root, '.local/operator-compact-ui', process.env.ARTEL_OPERATOR_QA_BUILT === '1' ? 'built' : 'source'));
await mkdir(output, { recursive: true });
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store'), source = await writeTripsQaSnapshot(snapshotDirectory);
const runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
const { cookie } = await runtime.bootstrap(), store = new OperationsStore(operationsDirectory);
const api = async (path, method = 'GET', body) => {
  const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify({ path, status: response.status, result })); return result;
};
const read = () => api('/api/operator');
const calendar = offset => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + offset * 86400000));
const recipientId = randomUUID();
const plan = await api('/api/operator/plans', 'POST', { clientName: 'Синтетические таблицы', recipients: [{ id: recipientId, name: 'Учебный получатель', bank: 'Учебный банк', card: '0000', phone: '', details: '', limit: '10000000' }], idempotencyKey: randomUUID() });
const operation = async (name, carryovers) => {
  const work = await read(), current = work.plans.find(item => item.id === plan.id), service = work.services.find(item => item.name === 'ННК'), amount = carryovers ? '61200.00' : '64800.00';
  const saved = await api('/api/operator/refuellings', 'POST', { schemaVersion: 3, planId: current.id, planVersion: current.version, name, date: '2026-10-21', serviceId: service.id, serviceVersion: service.version ?? 0, discountPercent: service.discountPercent, litres: '900', pricePerLitre: '80', amount, amountMode: 'auto', comment: '', allocations: [{ kind: 'recipient', recipientId, amount }], ...(carryovers ? { carryovers } : {}), idempotencyKey: randomUUID() });
  if (!carryovers) await api(`/api/operator/refuellings/${saved.id}/payment`, 'PATCH', { version: 1, paid: true, idempotencyKey: randomUUID() });
  return (await read()).refuellings.find(item => item.id === saved.id);
};
const createCase = async (driver, kind, litres = '50') => {
  const row = await operation(driver), result = await api('/api/operator/cases', 'POST', { operationId: row.id, operationVersion: row.version, kind, ...(kind === 'return' ? { litres } : {}), idempotencyKey: randomUUID() });
  return (await read()).cases.find(item => item.id === result.id);
};
const task = async (entry, offset) => {
  await api(`/api/operator/cases/${entry.id}/task`, 'PATCH', { version: entry.version, dueDate: calendar(offset), comment: `Проверить остаток и связаться с водителем ${entry.source.driverName}.`, idempotencyKey: randomUUID() });
  return (await read()).cases.find(item => item.id === entry.id);
};
const settle = async (entry, method, litres) => {
  await api(`/api/operator/cases/${entry.id}/settle`, 'PATCH', { version: entry.version, method, ...(litres ? { litres } : {}), idempotencyKey: randomUUID() });
  return (await read()).cases.find(item => item.id === entry.id);
};
let returning = await createCase('Учебный возврат частично', 'return', '100'); returning = await task(returning, 0); returning = await settle(returning, 'fuel', '10');
let overdue = await createCase('Учебный возврат просрочен', 'return'); overdue = await task(overdue, -1);
await createCase('Учебный возврат без задания', 'return');
let money = await createCase('Учебный возврат деньгами', 'return'); money = await settle(money, 'money');
const credited = await createCase('Учебный возврат зачтён', 'return'); await operation(credited.source.driverName, [{ caseId: credited.id, version: credited.version, litres: '50' }]);
let deferred = await createCase('Учебная частичная заправка', 'deferred'); deferred = await task(deferred, 1); deferred = await settle(deferred, 'fuel', '800');
await createCase('Учебная заправка без задания', 'deferred');
let completed = await createCase('Учебная завершённая заправка', 'deferred'); completed = await task(completed, 0); await settle(completed, 'fuel', '900');
const usedPlan = (await read()).plans.find(item => item.id === plan.id);
await api(`/api/operator/plans/${plan.id}`, 'PATCH', { version: usedPlan.version, clientName: usedPlan.clientName, recipients: usedPlan.recipients.map(({ id, name, bank, card, phone, details, used }) => ({ id, name, bank, card, phone, details, limit: used })), idempotencyKey: randomUUID() });
await api('/api/operator/plans', 'POST', { clientName: 'Учебный клиент · приём оплаты', recipients: [{ id: randomUUID(), name: 'Учебный получатель первый', bank: 'Учебный банк', card: '0000', phone: '', details: '', limit: '30000' }, { id: randomUUID(), name: 'Учебный получатель второй', bank: 'Учебный банк', card: '0000', phone: '', details: '', limit: '60000' }], idempotencyKey: randomUUID() });
const fixture = await read(), operatorBefore = JSON.stringify((await store.read(source)).operator);
const report = { synthetic: true, engineFilter: process.env.ARTEL_OPERATOR_QA_ENGINE || 'all', callbacksOnly: process.env.ARTEL_OPERATOR_QA_CALLBACKS_ONLY === '1', keyboardTraversal: { chromium: 'Tab', webkit: 'Alt+Tab (Option+Tab: all controls)' }, mode: runtime.mode, artifacts: runtime.artifacts, checks: [], axe: [], screenshots: [], geometry: [], errors: [], browserMutations: [], externalRequests: [] };
let browser, page, engine;
const shot = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
const check = label => { report.checks.push(`${engine}: ${label}`); console.log('PASS', engine, label); };
const close = async dialog => { await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click(); await expect(dialog).toHaveCount(0); };
const choose = async (kind, status = 'open') => {
  await page.getByRole('tab', { name: new RegExp(kind === 'plans' ? '^Задания ·' : kind === 'return' ? '^Возвраты' : kind === 'deferred' ? '^Ожидают заправки' : '^Операции$') }).click();
  if (kind === 'plans') await page.getByRole('group', { name: 'Статус заданий', exact: true }).getByRole('button', { name: new RegExp(status === 'open' ? '^Активные ·' : '^Выполненные ·') }).click();
  else if (kind !== 'operations') await page.getByRole('group', { name: 'Состояние записей', exact: true }).getByRole('button', { name: new RegExp(status === 'open' ? '^Открытые ·' : '^Выполненные ·') }).click();
};
const checkToolbar = async () => {
  const tabs = await page.getByRole('tablist', { name: 'Раздел операторской', exact: true }).boundingBox(), bar = await page.locator('.operator-toolbar').boundingBox();
  assert.ok(bar.y >= tabs.y + tabs.height + 4, 'Actions must be below tabs');
  assert.ok(bar.x >= 0 && bar.x + bar.width <= page.viewportSize().width + 1, 'Toolbar within viewport');
  const buttons = await page.locator('.operator-toolbar > button').evaluateAll(nodes => nodes.map(node => { const r = node.getBoundingClientRect(); return { top: r.top, height: r.height, width: r.width }; }));
  assert.equal(buttons.length, 3); assert.ok(buttons.every(b => b.height >= 44 && b.width >= 44 && Math.abs(b.top - buttons[0].top) < 1));
};
const cardGeometry = async width => {
  const cards = await page.locator('.operator-card').evaluateAll(nodes => nodes.map(node => {
    const style = getComputedStyle(node), heading = getComputedStyle(node.querySelector('h3'));
    const buttons = [...node.querySelectorAll(':scope > .operator-card-actions button')].map(button => {
      const box = button.getBoundingClientRect(), css = getComputedStyle(button), svg = button.querySelector('svg');
      return { x: box.x, y: box.y, width: box.width, height: box.height, font: Number.parseFloat(css.fontSize), label: button.getAttribute('aria-label') || button.textContent.trim(), title: button.title, svg: !!svg, visibleLabel: button.textContent.trim() };
    });
    const rect = node.getBoundingClientRect(), task = node.querySelector('.operator-case-task');
    return { kind: node.classList.contains('operator-plan-card') ? 'plan' : 'case', padding: style.padding, gap: style.gap, borderRadius: style.borderRadius, fontSize: heading.fontSize, cardRight: rect.right, cardWidth: rect.width, buttons, taskPadding: task ? getComputedStyle(task).paddingTop : null };
  }));
  assert.ok(cards.length > 0);
  for (const card of cards) {
    assert.ok(card.cardRight <= width + 1);
    assert.equal(card.padding, width <= 600 ? '16px' : '18px'); assert.equal(card.fontSize, '16px');
    assert.equal(card.borderRadius, '18px');
    for (const button of card.buttons) {
      assert.ok(button.height >= 38 && button.height <= 40, `${card.kind} action height ${button.height}`);
      assert.ok(button.font >= 12 && button.font <= 13 && button.svg && button.visibleLabel);
      assert.ok(button.width <= card.cardWidth, 'Card action fits');
      assert.ok(button.x + button.width <= card.cardRight - Number.parseFloat(card.padding) - 1 + .5, 'Action fits inside card padding');
      assert.ok(Math.abs(button.y - card.buttons[0].y) <= 1, 'Card actions must share one row');
    }
    if (card.taskPadding) assert.ok(Number.parseFloat(card.taskPadding) <= 10);
  }
  return cards;
};
try {
  for (const [name, launcher] of [['chromium', chromium], ['webkit', webkit]].filter(([name]) => !process.env.ARTEL_OPERATOR_QA_ENGINE || process.env.ARTEL_OPERATOR_QA_ENGINE === name)) {
    engine = name; browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' }); await authenticateContext(context, runtime.base, cookie);
    await context.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (url.origin !== runtime.base) { report.externalRequests.push(url.origin); return route.abort(); }
      if (url.pathname.startsWith('/api/operator') && !['GET', 'HEAD'].includes(request.method())) { report.browserMutations.push({ method: request.method(), path: url.pathname }); return route.abort(); }
      return route.continue();
    });
    page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => report.errors.push(`${engine}: ${error.message}`));
    await page.goto(runtime.base + '/#operator'); await expect(page.getByRole('tab', { name: 'Операции', exact: true })).toBeVisible();
    for (const kind of (process.env.ARTEL_OPERATOR_QA_CALLBACKS_ONLY === '1' ? [] : ['plans', 'return', 'deferred'])) for (const status of ['open', 'completed']) {
      await choose(kind, status);
      if (kind === 'plans') {
        await expect(page.getByRole('heading', { level: 2, name: /^Задания ·/ })).toHaveCount(0);
        await expect(page.getByRole('heading', { level: 2, name: 'Приём оплаты', exact: true })).toBeVisible();
        await expect(page.getByRole('heading', { level: 2, name: 'Возвраты и заправки', exact: true })).toBeVisible();
        await expect(page.getByLabel('Срок задания', { exact: true })).toHaveCount(0);
        const entries = fixture.cases.filter(entry => entry.task && entry.status === (status === 'open' ? 'open' : 'completed')).sort((a,b) => a.task.dueDate.localeCompare(b.task.dueDate) || a.createdAt.localeCompare(b.createdAt));
        assert.deepEqual(await page.locator('.operator-case-card').evaluateAll(nodes => nodes.map(node => node.id.replace('operator-case-',''))), entries.map(entry => entry.id));
        for (const entry of entries) { const card = page.locator(`#operator-case-${entry.id}`); if(entry.status==='open') await expect(card.locator('.operator-case-deadline time')).toHaveAttribute('datetime', entry.task.dueDate); else await expect(card).toContainText('Выполнено'); await card.getByRole('button',{name:/^Подробности:/}).click(); await expect(page.locator('.operator-details-drawer')).toContainText(entry.task.comment); await page.getByRole('button',{name:'Закрыть подробности'}).click(); await expect(page.locator('.operator-details-drawer')).toHaveCount(0); }
        if (status === 'open') { await expect(page.locator(`#operator-case-${overdue.id}`)).toContainText('Просрочено'); await expect(page.locator(`#operator-case-${returning.id}`)).toContainText('На сегодня'); }
      } else {
        const entries = fixture.cases.filter(entry => entry.kind === kind && entry.status === status);
        await expect(page.locator('.operator-case-card')).toHaveCount(entries.length);
        await expect(page.locator('.operator-cases-table tbody tr')).toHaveCount(entries.length);
      }
      for (const width of [320,375,390,768,1440,1920]) {
        await page.setViewportSize({ width, height: 1000 }); await checkToolbar();
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${kind}/${status}/${width} overflow`);
        report.geometry.push({ engine,kind,status,width,cards:await cardGeometry(width) });
        const results = await new AxeBuilder({ page }).include('.operator-workspace').analyze(); report.axe.push({ engine,kind,status,width,violations:results.violations }); assert.deepEqual(results.violations,[]);
        if ([375,1440].includes(width)) await shot(`${kind}-${status}-${width}`);
        check(`${kind}/${status} ${width}px: toolbar below tabs; shared card styling; one compact action row; no overflow; axe`);
      }
    }
    for (const width of [320,375,768,1920]) {
      await page.setViewportSize({width,height:1000}); await choose('operations'); await checkToolbar();
      await page.getByRole('button',{name:'Обновить',exact:true}).click(); await expect(page.getByRole('button',{name:'Обновить',exact:true})).toBeEnabled();
      await page.getByRole('button',{name:'Новая операция',exact:true}).click(); await expect(page.getByRole('dialog',{name:'Новая операция',exact:true})).toBeVisible(); await close(page.getByRole('dialog'));
      await choose('plans');
      const payment = page.locator('.operator-plan-card').first(); await payment.getByRole('button',{name:/^Подробности задания/}).click(); await page.locator('.operator-details-drawer').getByRole('button',{name:/^Редактировать задание/}).click(); await expect(page.locator('.operator-details-drawer')).toHaveCount(0); await expect(page.getByRole('dialog',{name:'Редактирование задания',exact:true})).toBeVisible(); await close(page.getByRole('dialog'));
      const card=page.locator(`#operator-case-${returning.id}`), first=card.getByRole('button',{name:/^Подробности:/});
      await first.focus(); await expect(first).toBeFocused(); await page.keyboard.press(engine === 'webkit' ? 'Alt+Tab' : 'Tab'); await expect(card.getByRole('button',{name:'Вернуть деньги',exact:true})).toBeFocused();
      for (const [action,title] of [['Изменить задание','Задание на возврат'],['Вернуть деньги','Отметить выполненный перевод'],['Отметить заправку','Отметить заправку'],['Исходная операция','Операция']]) {
        const inDetails=['Изменить задание','Исходная операция'].includes(action); if(inDetails){await first.click();await page.locator('.operator-details-drawer').getByRole('button',{name:action,exact:true}).click();await expect(page.locator('.operator-details-drawer')).toHaveCount(0);}else await card.getByRole('button',{name:action,exact:true}).click();const dialog=page.getByRole('dialog',{name:title,exact:true});await expect(dialog).toBeVisible();await close(dialog);await expect(inDetails?first:card.getByRole('button',{name:action,exact:true})).toBeFocused();
      }
      await choose('return'); const row=page.locator(`tr[data-case-id="${returning.id}"]`);await row.getByRole('button',{name:/^Открыть карточку/}).click();await expect(page.locator(`#operator-case-${returning.id}`)).toBeFocused();
      check(`${width}px: refresh/new/edit and all compact case actions preserve callbacks, keyboard/focus; table Open focuses card`);
    }
    assert.equal(JSON.stringify((await store.read(source)).operator),operatorBefore);
    await context.close();await browser.close();browser=null;
  }
  assert.deepEqual(report.browserMutations,[]);assert.deepEqual(report.externalRequests,[]);assert.deepEqual(report.errors,[]);report.passed=true;
} catch(error) { report.failure=String(error.stack||error);if(page&&!page.isClosed())await shot('failure').catch(()=>{});throw error; }
finally { await browser?.close();await runtime.server.close();await rm(temporary,{recursive:true,force:true});await writeFile(resolve(output,'report.json'),JSON.stringify(report,null,2)); }
console.log(JSON.stringify({passed:report.passed,checks:report.checks.length,axe:report.axe.length,screenshots:report.screenshots.length,report:resolve(output,'report.json')}));

// Synthetic fixture only; table navigation never submits a business mutation.
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
const output = resolve(process.env.ARTEL_OPERATOR_QA_OUTPUT || resolve(root, '.local/operator-cases-table-ui', process.env.ARTEL_OPERATOR_QA_BUILT === '1' ? 'built' : 'source'));
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
let money = await createCase('Учебный возврат деньгами', 'return'); money = await settle(money, 'money');
const credited = await createCase('Учебный возврат зачтён', 'return'); await operation(credited.source.driverName, [{ caseId: credited.id, version: credited.version, litres: '50' }]);
let deferred = await createCase('Учебная частичная заправка', 'deferred'); deferred = await task(deferred, 1); deferred = await settle(deferred, 'fuel', '800');
await createCase('Учебная заправка без задания', 'deferred');
let completed = await createCase('Учебная завершённая заправка', 'deferred'); completed = await task(completed, 0); await settle(completed, 'fuel', '900');
const fixture = await read(), operatorBefore = JSON.stringify((await store.read(source)).operator);
const report = { synthetic: true, mode: runtime.mode, artifacts: runtime.artifacts, checks: [], axe: [], screenshots: [], errors: [], browserMutations: [], externalRequests: [] };
let browser, page, engine;
const shot = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
const check = label => { report.checks.push(`${engine}: ${label}`); console.log('PASS', engine, label); };
const close = async dialog => { await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click(); await expect(dialog).toHaveCount(0); };
try {
  for (const [name, launcher] of [['chromium', chromium], ['webkit', webkit]]) {
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
    for (const kind of ['return', 'deferred']) {
      await page.getByRole('tab', { name: new RegExp(kind === 'return' ? '^Возвраты' : '^Ожидают заправки') }).click();
      const section = page.getByRole('region', { name: kind === 'return' ? 'Возвраты' : 'Ожидают заправки', exact: true });
      for (const status of ['open', 'completed']) {
        await page.getByRole('group', { name: 'Состояние записей', exact: true }).getByRole('button', { name: new RegExp(status === 'open' ? '^Открытые ·' : '^Выполненные ·') }).click();
        const entries = fixture.cases.filter(entry => entry.kind === kind && entry.status === status).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        const table = section.locator('.operator-cases-table'); await expect(table).toBeVisible();
        assert.deepEqual(await table.locator('tbody tr').evaluateAll(nodes => nodes.map(node => node.dataset.caseId)), entries.map(entry => entry.id));
        assert.deepEqual(await section.locator('.operator-case-card').evaluateAll(nodes => nodes.map(node => node.id.replace('operator-case-', ''))), entries.map(entry => entry.id));
        await expect(table.getByRole('columnheader')).toHaveCount(8); await expect(table.locator('thead th[scope=col]')).toHaveCount(8); await expect(table.locator('tbody th[scope=row]')).toHaveCount(entries.length);
        const tableBox = await section.locator('.operator-cases-table-section').boundingBox(), cardsBox = await section.locator('.operator-case-cards').boundingBox(); assert.ok(tableBox.y >= cardsBox.y + cardsBox.height);
        for (const entry of entries) {
          const row = table.locator(`tr[data-case-id="${entry.id}"]`);
          await expect(row).toContainText(entry.source.driverName); await expect(row).toContainText('21.10.2026'); await expect(row).toContainText('ННК'); await expect(row).toContainText('10%');
          const nums = await row.locator('.operator-cases-table-number').allTextContents(); assert.deepEqual(nums.map(text => text.replace(/\s/g, '').replace(',', '.')), [entry.litres, entry.remainingLitres, entry.remainingAmount]);
          if (entry.task) { await expect(row.locator('.operator-cases-table-task')).toContainText(entry.task.createdByName); await expect(row.locator('.operator-cases-table-task time')).toHaveAttribute('datetime', entry.task.dueDate); }
          else await expect(row.locator('.operator-cases-table-task')).toHaveText('Не поставлено');
          if (entry.id === returning.id) { await expect(row).toContainText('На сегодня'); await expect(row).toContainText('Частично исполнено'); await expect(row).toContainText('Заправка'); }
          if (entry.id === overdue.id) await expect(row).toContainText('Просрочено');
          if (entry.id === money.id) await expect(row).toContainText('Возврат денег');
          if (entry.id === credited.id) await expect(row).toContainText('Зачёт в новой операции');
          if (status === 'completed') await expect(row).toContainText('Выполнено');
        }
        for (const width of [320, 375, 390, 768, 1440, 1920]) {
          await page.setViewportSize({ width, height: 1000 });
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${kind}/${status}/${width} page overflow`);
          const scroll = section.locator('.operator-cases-table-scroll'); assert.ok(await scroll.evaluate(el => el.getBoundingClientRect().right <= innerWidth + 1));
          if (width <= 768) assert.ok(await scroll.evaluate(el => el.scrollWidth > el.clientWidth));
          await scroll.focus(); await page.keyboard.press('ArrowRight');
          const result = await new AxeBuilder({ page }).include('.operator-cases').analyze(); report.axe.push({ engine, kind, status, width, violations: result.violations }); assert.deepEqual(result.violations, []);
          const first = entries[0], row = table.locator(`tr[data-case-id="${first.id}"]`), button = row.getByRole('button', { name: /^Открыть карточку/ });
          await expect(button).toHaveAttribute('aria-controls', `operator-case-${first.id}`); await button.focus(); await page.keyboard.press('Enter');
          await expect(page.locator(`#operator-case-${first.id}`)).toBeFocused();
          if ([375, 1440, 1920].includes(width)) { await scroll.evaluate(el => { el.scrollLeft = 0; }); await shot(`${kind}-${status}-${width}`); }
          check(`${kind}/${status} ${width}px: same filtered cards/table, local scroll, no page overflow, semantic headers, axe, keyboard Open focuses card`);
        }
      }
      await page.getByRole('group', { name: 'Состояние записей', exact: true }).getByRole('button', { name: /^Открытые ·/ }).click();
      const entry = kind === 'return' ? returning : deferred, card = page.locator(`#operator-case-${entry.id}`);
      await section.locator(`tr[data-case-id="${entry.id}"]`).getByRole('button', { name: /^Открыть карточку/ }).click(); await expect(card).toBeFocused();
      await card.getByRole('button', { name: /^Подробности:/ }).click(); await page.locator('.operator-details-drawer').getByRole('button', { name: 'Исходная операция', exact: true }).click(); await expect(page.locator('.operator-details-drawer')).toHaveCount(0); let dialog = page.getByRole('dialog', { name: 'Операция', exact: true }); await expect(dialog.getByLabel('Имя водителя', { exact: true })).toHaveValue(entry.source.driverName); await expect(dialog.getByRole('button', { name: 'Сохранить операцию', exact: true })).toHaveCount(0); await close(dialog);
      await card.getByRole('button', { name: /^Подробности:/ }).click(); await page.locator('.operator-details-drawer').getByRole('button', { name: 'Изменить задание', exact: true }).click(); await expect(page.locator('.operator-details-drawer')).toHaveCount(0); dialog = page.getByRole('dialog', { name: kind === 'return' ? 'Задание на возврат' : 'Задание на заправку', exact: true }); await expect(dialog.getByLabel('Дата выполнения', { exact: true })).toHaveValue(entry.task.dueDate); await close(dialog);
      await card.getByRole('button', { name: kind === 'return' ? 'Вернуть деньги' : 'Отметить заправку', exact: true }).click(); dialog = page.getByRole('dialog', { name: kind === 'return' ? 'Отметить выполненный перевод' : 'Отметить заправку', exact: true }); await expect(dialog).toBeVisible(); await close(dialog);
      check(`${kind}: Open reaches existing source/task/settlement callbacks without submitting mutations`);
    }
    assert.equal(JSON.stringify((await store.read(source)).operator), operatorBefore); await context.close(); await browser.close(); browser = null;
  }
  assert.deepEqual(report.browserMutations, []); assert.deepEqual(report.externalRequests, []); assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) { report.failure = String(error.stack || error); if (page && !page.isClosed()) await shot('failure').catch(() => {}); throw error; }
finally { await browser?.close(); await runtime.server.close(); await rm(temporary, { recursive: true, force: true }); await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2)); }
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, axe: report.axe.length, screenshots: report.screenshots.length, report: resolve(output, 'report.json') }));

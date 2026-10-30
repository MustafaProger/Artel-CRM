// Synthetic browser acceptance only. All state lives in a temporary directory;
// external browser traffic, schedulers and real notification transport are disabled.
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

const root = resolve(import.meta.dirname, '..');
const temporary = await mkdtemp(resolve(tmpdir(), 'operator-returns-ui-'));
const output = resolve(process.env.ARTEL_OPERATOR_QA_OUTPUT || resolve(root, '.local/operator-returns-ui', process.env.ARTEL_OPERATOR_QA_BUILT === '1' ? 'built' : 'source'));
await mkdir(output, { recursive: true });
const snapshotDirectory = resolve(temporary, 'snapshot'), operationsDirectory = resolve(temporary, 'store');
const source = await writeTripsQaSnapshot(snapshotDirectory);
const runtime = await startOperatorQaServer({ root, snapshotDirectory, operationsDirectory });
const { cookie } = await runtime.bootstrap();
const store = new OperationsStore(operationsDirectory);
const report = { synthetic: true, frontend: runtime.mode, artifacts: runtime.artifacts, physicalPhoneDelivery: 'not tested; push transport is mocked', checks: [], axe: [], screenshots: [], errors: [] };
let browser, page, engine;
const check = label => { report.checks.push(`${engine}: ${label}`); console.log('PASS', engine, label); };
const api = async (path, method = 'GET', body) => {
  const response = await fetch(runtime.base + path, { method, headers: { Cookie: cookie, 'Content-Type': 'application/json', Origin: runtime.base }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const result = await response.json(); assert.ok(response.ok, JSON.stringify({ path, status: response.status, result })); return result;
};
const read = () => api('/api/operator');
const group = (await api('/api/directories', 'POST', { kind: 'operatorGroups', name: 'Синтетическая группа QA' })).entry;
const save = async (dialog, name) => { await dialog.getByRole('button', { name, exact: true }).click(); await expect(dialog).toHaveCount(0, { timeout: 15000 }); };
const close = async dialog => { await dialog.getByRole('button', { name: 'Закрыть', exact: true }).click(); await expect(dialog).toHaveCount(0); };
const refresh = async () => { await page.getByRole('button', { name: 'Обновить', exact: true }).click(); await expect(page.getByRole('button', { name: 'Обновить', exact: true })).toBeEnabled(); };
const tab = async name => page.getByRole('tab', { name: new RegExp(`^${name}(?: ·|$)`) }).click();
const moneyText = value => new RegExp(value.split('').join('[\\s\\u00a0\\u202f]*') + ',00');
const shot = async name => { const path = resolve(output, `${engine}-${name}.png`); await page.screenshot({ path, fullPage: true }); report.screenshots.push(path); };
const axe = async (label, selector) => {
  const result = await new AxeBuilder({ page }).include(selector).analyze();
  report.axe.push({ engine, label, violations: result.violations }); assert.deepEqual(result.violations, [], `${engine} axe: ${label}`);
};
const preserve = async (operationId, planId) => {
  const data = await store.read(source); return JSON.stringify({ operation: data.operator.refuellings[operationId], plan: data.operator.plans[planId] });
};
const createPlan = async (clientName, recipients = [{ id: randomUUID(), name: 'Получатель QA', bank: 'Банк QA', card: '0000', phone: '', details: '', limit: '1000000' }]) => { const result = await api('/api/operator/plans', 'POST', { clientName, recipients, idempotencyKey: randomUUID() }); return (await read()).plans.find(plan => plan.id === result.id); };
const seedOperation = async (plan, name, overrides = {}) => {
  const work = await read(), current = work.plans.find(item => item.id === plan.id), service = work.services.find(item => item.name === (overrides.service || 'Лукойл'));
  const amount = overrides.amount || (900 * 80 * (1 - Number(service.discountPercent) / 100)).toFixed(2);
  const { service: ignored, ...fields } = overrides; void ignored;
  const saved = await api('/api/operator/refuellings', 'POST', { schemaVersion: 3, planId: current.id, planVersion: current.version, name, date: '2026-10-21', groupId: group.id, serviceId: service.id, serviceVersion: service.version ?? 0, discountPercent: service.discountPercent, litres: '900', pricePerLitre: '80', amount, amountMode: 'auto', comment: '', allocations: [{ kind: 'recipient', recipientId: current.recipients[0].id, amount }], ...fields, idempotencyKey: randomUUID() });
  await api(`/api/operator/refuellings/${saved.id}/payment`, 'PATCH', { version: 1, paid: true, idempotencyKey: randomUUID() });
  return (await read()).refuellings.find(item => item.id === saved.id);
};
const actions = async row => {
  await tab('Операции'); await page.getByLabel('Фильтр по заданию', { exact: true }).selectOption(''); await page.getByLabel('Поиск операций', { exact: true }).fill(row.name);
  const visible = page.locator(page.viewportSize().width <= 700 ? '.operator-mobile-journal' : '.operator-desktop-journal').locator(`[data-operation-id="${row.id}"]`);
  await visible.getByRole('button', { name: `Действие с операцией ${row.name}`, exact: true }).click();
  return page.locator('.operator-operation-actions');
};
const newCase = async (row, kind = 'return') => {
  const panel = await actions(row); await panel.getByRole('button', { name: new RegExp(kind === 'return' ? '^Оформить возврат' : '^Заправка позже') }).click();
  const dialog = page.locator('.operator-case-dialog'); await expect(dialog).toBeVisible();
  if (kind === 'return') await dialog.getByLabel('Литры к возврату', { exact: true }).fill('50'); return dialog;
};
const caseCard = name => page.locator('.operator-case-card').filter({ has: page.getByRole('heading', { name, exact: true }) });
const openOperation = async (plan, name, carryover) => {
  await tab('Операции'); await page.getByRole('button', { name: 'Новая операция', exact: true }).click(); const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Задание', { exact: true }).selectOption(plan.id);
  if (carryover) await dialog.getByLabel('Остаток водителя', { exact: true }).selectOption(carryover.id);
  else await dialog.getByLabel('Имя водителя', { exact: true }).fill(name);
  await expect(dialog.getByLabel('Группа', { exact: true })).toHaveCount(0); await dialog.getByLabel('Сервис', { exact: true }).selectOption({ label: 'Лукойл' });
  await dialog.getByLabel('Литры', { exact: true }).fill('900'); await dialog.getByLabel('Цена за литр, ₽', { exact: true }).fill('80'); return dialog;
};
const allocate = async (dialog, recipients, amounts) => {
  for (let i = 0; i < amounts.length; i++) {
    await dialog.getByRole('button', { name: 'Добавить получателя', exact: true }).click();
    await dialog.getByLabel(`Получатель ${i + 1}`, { exact: true }).selectOption(recipients[i].id);
    await dialog.getByLabel(`Сумма получателю ${i + 1}, ₽`, { exact: true }).fill(amounts[i]);
  }
};
const droppedReplay = async (dialog, path, method, label) => {
  const bodies = []; let count = 0;
  await page.route(path, async route => {
    if (route.request().method() !== method) return route.continue();
    bodies.push(route.request().postData()); count++;
    if (count === 1) { const result = await route.fetch(); assert.ok(result.ok(), await result.text()); await route.abort(); }
    else if (count === 2) await route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ error: 'Синтетический временный отказ' }) });
    else await route.continue();
  });
  try {
    await dialog.getByRole('button', { name: label, exact: true }).click();
    await expect(dialog.getByRole('button', { name: 'Проверить сохранение', exact: true })).toBeEnabled();
    await expect(dialog.locator('fieldset')).toHaveAttribute('disabled', '');
    await dialog.getByRole('button', { name: 'Проверить сохранение', exact: true }).click();
    await expect(dialog).toContainText('Синтетический временный отказ'); await expect(dialog.locator('fieldset')).toHaveAttribute('disabled', '');
    await save(dialog, 'Проверить сохранение'); assert.equal(bodies.length, 3); assert.equal(new Set(bodies).size, 1);
  } finally { await page.unroute(path); }
};
const taskSection = () => page.getByRole('region', { name: 'Задания на возвраты и заправки', exact: true });
const details = () => page.locator('dialog.operator-details-drawer');
const openDetails = async card => { await card.getByRole('button', { name: /^Подробности/ }).click(); await expect(details()).toBeVisible(); return details(); };
const closeDetails = async () => { await details().getByRole('button', { name: 'Закрыть подробности' }).click(); await expect(details()).toHaveCount(0); };
const detailAction = async (card, name) => { await openDetails(card); await details().getByRole('button', { name, exact: true }).click(); await expect(details()).toHaveCount(0); };
const caseById = id => page.locator(`#operator-case-${id}`);
const showTasks = async (status = 'active') => {
  await tab('Задания');
  await page.getByRole('group', { name: 'Статус заданий', exact: true }).getByRole('button', { name: new RegExp(status === 'active' ? '^Активные' : '^Выполненные') }).click();
};
const openCaseTask = async entry => {
  await showTasks(); await page.getByRole('button', { name: 'Новое задание', exact: true }).click();
  let dialog = page.getByRole('dialog'); await dialog.getByRole('button', { name: new RegExp(entry.kind === 'return' ? '^Возврат водителю' : '^Заправка из остатка') }).click();
  await expect(dialog.getByRole('heading', { name: entry.kind === 'return' ? 'Выберите оформленный возврат' : 'Выберите ожидающую заправку', exact: true })).toBeVisible();
  await dialog.getByLabel('Поиск водителя для задания', { exact: true }).fill(entry.source.driverName);
  await dialog.locator('.operator-source-choice').filter({ hasText: entry.source.driverName }).click();
  dialog = page.getByRole('dialog', { name: entry.kind === 'return' ? 'Задание на возврат' : 'Задание на заправку', exact: true });
  await expect(dialog).toBeVisible(); return dialog;
};
const today = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
const assignTask = async (entry, comment, replay = false) => {
  const before = await read(), dialog = await openCaseTask(entry);
  await expect(dialog.getByLabel('Дата выполнения', { exact: true })).toHaveValue(today());
  await dialog.getByLabel('Что нужно сделать', { exact: true }).fill(`  ${comment}  `);
  await axe(`${entry.kind} task form`, '.operator-case-dialog');
  if (replay) await droppedReplay(dialog, `**/api/operator/cases/${entry.id}/task`, 'PATCH', 'Поставить задание');
  else await save(dialog, 'Поставить задание');
  const after = await read(), saved = after.cases.find(row => row.id === entry.id);
  assert.equal(saved.task.dueDate, today()); assert.equal(saved.task.comment, comment); assert.equal(saved.taskHistory.length, 1);
  assert.equal(after.cases.length, before.cases.length); assert.equal(after.refuellings.length, before.refuellings.length);
  assert.deepEqual(after.refuellings, before.refuellings); assert.deepEqual(after.plans, before.plans);
  await showTasks(); await openDetails(caseById(entry.id)); await expect(details()).toContainText(comment); await expect(details()).toContainText(`Поставил: ${saved.task.createdByName}`); await closeDetails();
  await expect(caseById(entry.id)).toContainText('На сегодня');
  await expect(page.getByLabel('Срок задания', { exact: true })).toHaveCount(0);
  await expect(caseById(entry.id).locator('.operator-case-deadline time')).toHaveAttribute('datetime', today());
  await expect(caseById(entry.id)).toBeVisible();
  return saved;
};
const verifyMoneyGeometry = async dialog => {
  await expect(dialog.getByRole('heading', { name: 'Отметить выполненный перевод', exact: true })).toBeVisible();
  const confirm = dialog.locator('.operator-case-confirm'); await expect(confirm).toContainText('Подтверждаю:'); await expect(confirm).toContainText('уже переведены водителю.');
  for (const width of [375, 768, 1920]) {
    await page.setViewportSize({ width, height: width === 375 ? 844 : 1000 });
    await confirm.scrollIntoViewIfNeeded();
    const box = await confirm.getByRole('checkbox').boundingBox(), text = await confirm.locator('span').boundingBox(), bounds = await dialog.boundingBox();
    assert.ok(box.width > 0 && box.width <= 24 && box.height <= 24, JSON.stringify(box));
    assert.ok(text.x >= box.x + box.width && text.x + text.width <= Math.min(bounds.x + bounds.width, width) + 1, JSON.stringify({ box, text, bounds }));
    assert.ok(text.y >= bounds.y && text.y + text.height <= Math.min(bounds.y + bounds.height, page.viewportSize().height) + 1, JSON.stringify({ box, text, bounds }));
    assert.ok(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await axe(`${width}px money confirmation full app styles`, '.operator-case-dialog'); await shot(`${width}-money-confirmation`);
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
};
const contrast = (first, second) => {
  const luminance = value => { const rgb = value.match(/[\d.]+/g).slice(0, 3).map(Number).map(n => { n /= 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; }); return rgb[0] * .2126 + rgb[1] * .7152 + rgb[2] * .0722; };
  const a = luminance(first), b = luminance(second); return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
};
try {
  for (const [name, launcher] of [['chromium', chromium], ['webkit', webkit]].filter(([name]) => !process.env.QA_ENGINE || name === process.env.QA_ENGINE)) {
    engine = name; browser = await launcher.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce', serviceWorkers: 'block' });
    await authenticateContext(context, runtime.base, cookie);
    await context.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
    page = await context.newPage(); page.setDefaultTimeout(12000); page.on('pageerror', error => report.errors.push({ engine, error: error.message }));
    await page.goto(runtime.base + '/#operator'); await expect(page.getByRole('tab', { name: 'Операции', exact: true })).toBeVisible();
    await tab('Задания'); await page.getByRole('button', { name: 'Новое задание', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^Приём оплаты/ }).click();
    let dialog = page.getByRole('dialog'); const clientName = `QA основной ${engine}`;
    await dialog.getByLabel('Клиент', { exact: true }).fill(clientName);
    for (let i = 0; i < 2; i++) {
      if (i) await dialog.getByRole('button', { name: 'Добавить реквизиты', exact: true }).click();
      await dialog.getByLabel(`Имя получателя ${i + 1}`, { exact: true }).fill(`QA получатель ${i + 1}`);
      await dialog.getByLabel(`Банк ${i + 1}`, { exact: true }).fill('Учебный банк');
      assert.equal(await dialog.getByLabel(`Карта / счёт / телефон ${i + 1}`, { exact: true }).evaluate(el => el.tagName), 'INPUT');
      await dialog.getByLabel(`Карта / счёт / телефон ${i + 1}`, { exact: true }).fill(i ? '+7 000 000 00 02' : '0000 0000 0000 0001');
      await dialog.getByLabel(`Лимит, ₽ ${i + 1}`, { exact: true }).fill(i ? '1000000' : '30000');
    }
    await axe('unified plan form', '.operator-dialog'); await save(dialog, 'Сохранить задание');
    const plan = (await read()).plans.find(item => item.clientName === clientName); assert.ok(plan); assert.equal(plan.recipients.length, 2);
    const legacy = await createPlan(`QA старые реквизиты ${engine}`, [{ id: randomUUID(), name: 'Архивный получатель', bank: 'Банк', card: '0000\r\n1234', phone: '+70000000001', details: 'Историческое уточнение', limit: '1000' }]);
    await refresh(); await detailAction(page.locator('.operator-plan-card').filter({ hasText: legacy.clientName }), `Редактировать задание ${legacy.clientName}`); dialog = page.getByRole('dialog');
    await expect(dialog.getByLabel('Карта / счёт / телефон 1', { exact: true })).toHaveValue(/0000 1234[\s\S]*\+70000000001/);
    await dialog.getByLabel('Клиент', { exact: true }).fill(legacy.clientName + ' уточнённое'); await save(dialog, 'Сохранить задание');
    const edited = (await read()).plans.find(item => item.id === legacy.id);
    for (const field of ['card', 'phone', 'details']) assert.equal(edited.recipients[0][field], legacy.recipients[0][field]);
    check('unified requisites create card/phone recipients; unrelated legacy edit preserves card, phone and details');

    // Old records remain editable although the group field is no longer shown.
    // A missing group must be omitted, never serialized as an empty string.
    const historicalRecipient = await api('/api/operator/recipients', 'POST', { name: `QA старый получатель ${engine}`, bank: 'Архивный банк', card: '0000 1234', phone: '+70000000003', details: 'Сохранённые подробности', idempotencyKey: randomUUID() });
    const oldService = (await read()).services.find(item => item.name === 'Лукойл');
    const oldV2 = await api('/api/operator/refuellings', 'POST', { schemaVersion: 2, date: '2026-10-21', name: `QA v2 без группы ${engine}`, serviceId: oldService.id, serviceVersion: oldService.version ?? 0, discountPercent: oldService.discountPercent, litres: '900', pricePerLitre: '80', amount: '64800.00', amountMode: 'auto', recipientText: 'QA получатель без группы', comment: '', idempotencyKey: randomUUID() });
    const oldLegacy = await api('/api/operator/refuellings', 'POST', { date: '2026-10-21', name: `QA историческая без группы ${engine}`, service: 'Лукойл', discountPercent: '7', litres: '100.123456', pricePerLitre: '65.123456', amount: '6000.25', recipientId: historicalRecipient.id, recipientVersion: 1, comment: 'Архивная операция', idempotencyKey: randomUUID() });
    await refresh();
    for (const [saved, description] of [[oldV2, 'v2 without group'], [oldLegacy, 'legacy without group converts to v2']]) {
      const original = (await read()).refuellings.find(item => item.id === saved.id);
      assert.equal(Object.hasOwn(original, 'groupId'), false);
      const editPanel = await actions(original); await editPanel.getByRole('button', { name: /^Изменить операцию/ }).click();
      const editor = page.getByRole('dialog', { name: 'Операция', exact: true });
      await expect(editor.getByLabel('Группа', { exact: true })).toHaveCount(0);
      await expect(editor.getByLabel('Задание', { exact: true })).toHaveCount(0);
      await expect(editor.getByLabel('Цена за литр, ₽', { exact: true })).toHaveValue(original.pricePerLitre);
      await editor.getByLabel('Комментарий', { exact: true }).fill(`Отредактировано без группы ${engine}`);
      const payloads = [], routePath = `**/api/operator/refuellings/${saved.id}`;
      await page.route(routePath, route => { if (route.request().method() === 'PATCH') payloads.push(route.request().postDataJSON()); return route.continue(); });
      try { await save(editor, 'Сохранить операцию'); } finally { await page.unroute(routePath); }
      assert.equal(payloads.length, 1); assert.equal(Object.hasOwn(payloads[0], 'groupId'), false); assert.equal(payloads[0].schemaVersion, 2);
      const updated = (await read()).refuellings.find(item => item.id === saved.id);
      assert.equal(updated.schemaVersion, 2); assert.equal(updated.version, original.version + 1); assert.equal(Object.hasOwn(updated, 'groupId'), false); assert.equal(Object.hasOwn(updated, 'groupName'), false);
      for (const key of ['date', 'name', 'service', 'discountPercent', 'litres', 'pricePerLitre', 'amount', 'paid', 'createdAt', 'createdBy']) assert.equal(updated[key], original[key], `${description}: ${key}`);
      assert.deepEqual(updated.paymentHistory, original.paymentHistory);
      assert.equal(updated.comment, `Отредактировано без группы ${engine}`);
      if (original.schemaVersion === undefined) {
        for (const value of Object.values(original.recipient).filter(Boolean)) assert.ok(updated.recipientText.includes(value));
        assert.deepEqual(updated.legacyPrecision, { litres: original.litres, pricePerLitre: original.pricePerLitre });
      } else assert.equal(updated.recipientText, original.recipientText);
      check(`${description}: UI omits groupId, saves successfully, keeps exact historical amounts/rates/requisites and creator`);
    }

    const driver = `QA основной водитель ${engine}`;
    dialog = await openOperation(plan, driver); await expect(dialog.getByLabel('Сумма к оплате, ₽', { exact: true })).toHaveValue('64800.00');
    await allocate(dialog, plan.recipients, ['30000', '34800']); await save(dialog, 'Сохранить операцию');
    let row = (await read()).refuellings.find(item => item.name === driver); assert.equal(row.amount, '64800.00'); assert.equal(row.allocations.length, 2);
    let panel = await actions(row); await expect(panel.getByRole('button', { name: /^Оформить возврат/ })).toHaveCount(0);
    await panel.getByRole('button', { name: /^Подтвердить оплату/ }).click(); dialog = page.getByRole('dialog'); await save(dialog, 'Подтвердить');
    row = (await read()).refuellings.find(item => item.id === row.id); assert.equal(row.paid, true);
    const tbody = page.locator(`tbody[data-operation-id="${row.id}"]`); await expect(tbody.locator('tr')).toHaveCount(2);
    await expect(tbody.locator('.operator-group-driver')).toHaveCount(1); await expect(tbody.locator('.operator-group-driver')).toHaveAttribute('rowspan', '2');
    await expect(page.getByRole('columnheader', { name: 'Группа', exact: true })).toHaveCount(0);
    await expect(page.getByRole('columnheader', { name: 'Сумма получателю, ₽', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Копировать реквизиты/ })).toHaveCount(0);
    await expect(tbody.locator('.operator-recipient-row .operator-recipient-amount')).toHaveCount(2);
    await expect(tbody.locator('.operator-recipient-row').first()).toHaveCSS('border-left-style', 'solid');
    await expect(tbody.locator('.operator-operation-total')).toHaveCount(1); await expect(tbody.locator('.operator-operation-total')).toContainText(moneyText('64800'));
    assert.deepEqual((await tbody.locator('.operator-recipient-amount').allTextContents()).map(t => t.replace(/\s/g, '')), ['30000,00₽', '34800,00₽']);
    panel = await actions(row); await expect(panel.getByRole('button', { name: /^Просмотр операции/ })).toBeVisible(); await expect(panel.getByRole('button', { name: /^Удалить операцию/ })).toBeDisabled();
    await axe('paid action panel', '.operator-operation-actions'); await close(panel);
    check('900 l × 80 less 10% = 64800, paid via UI; separate recipient rows 30000/34800, shared driver and total once, inline amounts, no group/copy/amount column, paid action restrictions');

    const preserved = await preserve(row.id, plan.id);
    dialog = await newCase(row, 'return'); await expect(dialog.locator('output')).toContainText(moneyText('3600')); await axe('return preview', '.operator-case-dialog');
    await droppedReplay(dialog, '**/api/operator/cases', 'POST', 'Создать возврат');
    let cases = (await read()).cases.filter(item => item.operationId === row.id); assert.equal(cases.length, 1);
    const assigned = await assignTask(cases[0], `Вернуть водителю остаток сегодня ${engine}`, true);
    let card = caseById(assigned.id); await detailAction(card, 'Изменить задание');
    dialog = page.getByRole('dialog', { name: 'Задание на возврат', exact: true });
    await dialog.getByLabel('Что нужно сделать', { exact: true }).fill(`Уточнённый возврат сегодня ${engine}`); await save(dialog, 'Сохранить задание');
    const revised = (await read()).cases.find(item => item.id === assigned.id); assert.equal(revised.taskHistory.length, 2); assert.equal(revised.task.createdBy, assigned.task.createdBy);
    await openDetails(card); await expect(details()).toContainText(`Уточнённый возврат сегодня ${engine}`); await closeDetails(); await card.getByRole('button', { name: 'Вернуть деньги', exact: true }).click(); dialog = page.locator('.operator-case-dialog');
    await verifyMoneyGeometry(dialog);
    await expect(dialog.getByRole('button', { name: 'Деньги возвращены', exact: true })).toBeDisabled(); await dialog.getByRole('checkbox').check();
    await droppedReplay(dialog, `**/api/operator/cases/${cases[0].id}/settle`, 'PATCH', 'Деньги возвращены');
    let cash = (await read()).cases.find(item => item.id === cases[0].id); assert.equal(cash.status, 'completed'); assert.equal(cash.settlements.length, 1); assert.equal(cash.settlements[0].amount, '3600.00');
    assert.equal(await preserve(row.id, plan.id), preserved); await expect(card).toHaveCount(0);
    await showTasks('completed'); await expect(caseById(cash.id)).toContainText('Выполнено'); await expect(caseById(cash.id).getByRole('button', { name: 'Вернуть деньги', exact: true })).toHaveCount(0);
    await showTasks(); await expect(caseById(cash.id)).toHaveCount(0);
    check('return50 preview3600; scheduled return task from existing case, author/date/edit/history; task and cash dropped reply +429 replay once; completed task moves to completed, original source/plan bytes unchanged; checkbox bounded375/768/1920');

    dialog = await newCase(row); await save(dialog, 'Создать возврат');
    const credit = (await read()).cases.find(item => item.operationId === row.id && item.status === 'open'); assert.ok(credit);
    const purchasePlan = await createPlan(`QA зачёт ${engine}`); await refresh();
    dialog = await openOperation(purchasePlan, driver, credit); await expect(dialog.getByLabel('Имя водителя', { exact: true })).toHaveAttribute('readonly', '');
    await expect(dialog.getByLabel('Сумма к оплате, ₽', { exact: true })).toHaveValue('61200.00'); await expect(dialog).toContainText('50 л из остатка + 850 л к оплате');
    await allocate(dialog, purchasePlan.recipients, ['61200']);
    await droppedReplay(dialog, '**/api/operator/refuellings', 'POST', 'Сохранить операцию');
    const purchased = (await read()).refuellings.filter(item => item.planId === purchasePlan.id); assert.equal(purchased.length, 1); assert.equal(purchased[0].payableLitres, '850'); assert.equal(purchased[0].amount, '61200.00');
    const used = (await read()).cases.find(item => item.id === credit.id); assert.equal(used.status, 'completed'); assert.equal(used.settlements.length, 1); assert.equal(used.settlements[0].operationId, purchased[0].id);
    assert.equal(await preserve(row.id, plan.id), preserved);
    panel = await actions(row); await expect(panel.getByRole('button', { name: /^Снять подтверждение оплаты/ })).toBeDisabled(); await close(panel);
    panel = await actions(purchased[0]); await expect(panel.getByRole('button', { name: /^Удалить операцию/ })).toBeDisabled(); await panel.getByRole('button', { name: /^Просмотр операции/ }).click();
    dialog = page.getByRole('dialog'); await expect(dialog.getByLabel('Литры', { exact: true })).toBeDisabled(); await expect(dialog.getByRole('button', { name: 'Сохранить операцию', exact: true })).toHaveCount(0); await close(dialog);
    check('credit50 + newtotal900 auto payable850=61200; lost response replay consumes once; source and carried operation protected');
    await tab('Операции'); const sourceGroup = page.locator(`tbody[data-operation-id="${row.id}"]`);
    await expect(sourceGroup.locator('.operator-journal-case.is-completed')).toHaveCount(2);
    await sourceGroup.getByRole('button', { name: 'Возврат: 50 л · завершён', exact: true }).first().click();
    await expect(page.getByRole('tab', { name: /^Возвраты/ })).toHaveAttribute('aria-selected', 'true');
    await expect(page.locator('.operator-case-card.is-focused')).toBeVisible();
    check('journal completed return badge opens its historical case without changing data');

    const deferredPlan = await createPlan(`QA ожидание ${engine}`); const deferredSource = await seedOperation(deferredPlan, `QA ожидающий водитель ${engine}`); await refresh();
    const deferredBytes = await preserve(deferredSource.id, deferredPlan.id);
    dialog = await newCase(deferredSource, 'deferred'); await expect(dialog.getByLabel('Литры к возврату', { exact: true })).toHaveCount(0); await expect(dialog).toContainText('900 л'); await save(dialog, 'Перенести заправку');
    let deferredTask = (await read()).cases.find(item => item.operationId === deferredSource.id);
    deferredTask = await assignTask(deferredTask, `Заправить из остатка сегодня ${engine}`);
    card = taskSection().locator(`#operator-case-${deferredTask.id}`); await expect(card.getByRole('button', { name: 'Вернуть деньги', exact: true })).toHaveCount(0);
    await card.getByRole('button', { name: 'Отметить заправку', exact: true }).click(); dialog = page.locator('.operator-case-dialog'); await dialog.getByLabel('Заправлено, л', { exact: true }).fill('800');
    await save(dialog, 'Подтвердить заправку'); let deferred = (await read()).cases.find(item => item.operationId === deferredSource.id);
    assert.equal(deferred.remainingLitres, '100'); assert.equal(deferred.status, 'open'); await expect(card.locator('.operator-case-totals')).toContainText('100 л');
    await detailAction(card, 'Изменить задание'); dialog = page.getByRole('dialog', { name: 'Задание на заправку', exact: true });
    const tomorrow = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(Date.now() + 86400000));
    await dialog.getByLabel('Дата выполнения', { exact: true }).fill(tomorrow); await dialog.getByLabel('Что нужно сделать', { exact: true }).fill(`Дозаправить оставшиеся 100 л ${engine}`); await save(dialog, 'Сохранить задание');
    const rescheduled = (await read()).cases.find(item => item.id === deferred.id); assert.equal(rescheduled.remainingLitres, '100'); assert.equal(rescheduled.task.dueDate, tomorrow); assert.equal(rescheduled.taskHistory.length, 2); assert.equal(rescheduled.settlements.length, 1); assert.equal(rescheduled.task.createdBy, deferredTask.task.createdBy);
    await card.getByRole('button', { name: 'Отметить заправку', exact: true }).click(); dialog = page.locator('.operator-case-dialog'); await expect(dialog.getByLabel('Заправлено, л', { exact: true })).toHaveValue('100'); await save(dialog, 'Подтвердить заправку');
    deferred = (await read()).cases.find(item => item.id === deferred.id); assert.equal(deferred.status, 'completed'); assert.equal(deferred.settlements.length, 2); assert.equal(await preserve(deferredSource.id, deferredPlan.id), deferredBytes);
    await expect(card).toHaveCount(0); await showTasks('completed'); await expect(caseById(deferred.id)).toContainText('Выполнено'); await showTasks(); await expect(caseById(deferred.id)).toHaveCount(0); check('defer full900; schedule existing remainder task; fuel800 keeps task active100; fuel100 moves task to completed; source and limits unchanged');

    const manualPlan = await createPlan(`QA ручная сумма ${engine}`); const manual = await seedOperation(manualPlan, `QA ручная сумма водитель ${engine}`, { amount: '63000.00', amountMode: 'manual' }); await refresh();
    dialog = await newCase(manual); await expect(dialog.locator('output')).toContainText(moneyText('3600'));
    // Definitive rejection does not lock or change the input. Retry may be corrected safely.
    await page.route('**/api/operator/cases', route => route.request().method() === 'POST' ? route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error: 'Синтетическая проверка формы' }) }) : route.continue(), { times: 1 });
    await dialog.getByRole('button', { name: 'Создать возврат', exact: true }).click(); await expect(dialog).toContainText('Синтетическая проверка формы'); await expect(dialog.getByLabel('Литры к возврату', { exact: true })).toBeEnabled(); await expect(dialog.getByLabel('Литры к возврату', { exact: true })).toHaveValue('50'); await save(dialog, 'Создать возврат');
    let manualCase = (await read()).cases.find(item => item.operationId === manual.id); assert.equal(manualCase.amount, '3600.00');
    await tab('Возвраты'); card = caseCard(manual.name); await card.getByRole('button', { name: 'Отметить заправку', exact: true }).click(); dialog = page.locator('.operator-case-dialog'); await dialog.getByLabel('Заправлено, л', { exact: true }).fill('20');
    await api(`/api/operator/cases/${manualCase.id}/settle`, 'PATCH', { version: manualCase.version, method: 'fuel', litres: '10', idempotencyKey: randomUUID() });
    await dialog.getByRole('button', { name: 'Подтвердить заправку', exact: true }).click(); await expect(dialog.getByRole('button', { name: 'Обновить данные', exact: true })).toBeVisible(); await expect(dialog.getByRole('button', { name: 'Подтвердить заправку', exact: true })).toBeDisabled();
    await expect(dialog.getByLabel('Заправлено, л', { exact: true })).toHaveValue('20'); await dialog.getByRole('button', { name: 'Обновить данные', exact: true }).click(); await save(dialog, 'Подтвердить заправку');
    manualCase = (await read()).cases.find(item => item.id === manualCase.id); assert.equal(manualCase.remainingLitres, '20'); assert.equal(manualCase.settlements.length, 2);
    check('manual source63000 still refund50=3600; definitive400 keeps editable input; stale409 refresh preserves volume and does not double settle');

    const badgePlan = await createPlan(`QA цвета ${engine}`); const badgeRows = [];
    for (const service of ['Лукойл', 'Яндекс', 'Роснефть', 'ГПН', 'ННК']) badgeRows.push(await seedOperation(badgePlan, `QA цвета ${service} ${engine}`, { service }));
    await refresh(); await tab('Операции'); await page.getByLabel('Поиск операций', { exact: true }).fill('');
    for (let i = 0; i < badgeRows.length; i++) {
      const badge = page.locator(`tbody[data-operation-id="${badgeRows[i].id}"] .operator-service-badges`); await expect(badge).toHaveClass(new RegExp(`operator-service-${['lukoil', 'yandex', 'rosneft', 'gpn', 'nnk'][i]}`));
      const colors = await badge.locator('span').evaluateAll(nodes => nodes.map(node => ({ text: node.textContent, fg: getComputedStyle(node).color, bg: getComputedStyle(node).backgroundColor })));
      for (const color of colors) assert.ok(contrast(color.fg, color.bg) >= 4.5, JSON.stringify(color));
      assert.equal(badgeRows[i].discountPercent, (await read()).services.find(s => s.id === badgeRows[i].serviceId).discountPercent);
    }
    assert.equal(badgeRows.at(-1).discountPercent, '10'); check('five service badge tones including green NNK10, name and discount contrast >=4.5; catalog discounts preserved');

    for (const width of [375, 390, 768, 1440, 1920]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const name of ['Операции', 'Задания', 'Возвраты', 'Ожидают заправки']) {
        await tab(name); const geometry = await page.evaluate(() => ({ width: innerWidth, scrollWidth: document.documentElement.scrollWidth, offenders: [...document.querySelectorAll('*')].filter(el => el.getBoundingClientRect().right > innerWidth + 1 && getComputedStyle(el).display !== 'none').map(el => ({ tag: el.tagName, class: el.className, right: el.getBoundingClientRect().right, width: el.getBoundingClientRect().width, scrollWidth: el.scrollWidth })).slice(0, 45) })); assert.ok(geometry.scrollWidth <= width + 1, `${name} overflow at ${width}: ${JSON.stringify(geometry)}`);
        if (name === 'Возвраты' || name === 'Ожидают заправки') { const kind = name === 'Возвраты' ? 'return' : 'deferred'; const count = (await read()).cases.filter(item => item.kind === kind && item.status === 'open').length; await expect(page.getByRole('tab', { name: `${name} · ${count}`, exact: true })).toBeVisible(); }
        await axe(`${width}px ${name}`, '.operator-workspace');
      }
      await tab('Операции'); await page.getByLabel('Поиск операций', { exact: true }).fill(driver);
      const desktop = page.locator('.operator-desktop-journal'), mobile = page.locator('.operator-mobile-journal');
      if (width <= 700) { await expect(desktop).toBeHidden(); await expect(mobile).toBeVisible(); await expect(mobile.locator(`[data-operation-id="${row.id}"] li`)).toHaveCount(2); await expect(mobile.locator(`[data-operation-id="${row.id}"] .operator-recipient-amount`)).toHaveCount(2); await expect(mobile.locator(`[data-operation-id="${purchased[0].id}"] .operator-recipient-amount`)).toHaveCount(0); } else { await expect(desktop).toBeVisible(); await expect(mobile).toBeHidden(); await expect(desktop.locator(`[data-operation-id="${purchased[0].id}"] .operator-recipient-amount`)).toHaveCount(0); }
      panel = await actions(row); assert.ok(await panel.evaluate(el => el.scrollWidth <= el.clientWidth + 1));
      const first = panel.getByRole('button', { name: 'Закрыть действия с операцией', exact: true }), last = panel.getByRole('button', { name: 'Закрыть', exact: true });
      await first.focus(); await page.keyboard.press('Shift+Tab'); await expect(last).toBeFocused(); await page.keyboard.press('Tab'); await expect(first).toBeFocused();
      await axe(`${width}px action panel`, '.operator-operation-actions'); await shot(`${width}-actions`);
      await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0);
      await expect(page.locator(width <= 700 ? '.operator-mobile-journal' : '.operator-desktop-journal').locator(`[data-operation-id="${row.id}"]`).getByRole('button', { name: `Действие с операцией ${row.name}`, exact: true })).toBeFocused();
      await shot(`${width}-journal`); check(`${width}px four tabs/axe/no document overflow; ${width <= 700 ? 'recipient mobile cards' : 'grouped table'}; action panel keyboard trap/Escape/focus`);
    }
    await page.goto(runtime.base + `/?operatorPlan=${plan.id}#operator`); await expect(page.getByLabel('Фильтр по заданию', { exact: true })).toHaveValue(plan.id);
    check('notification deep link selects existing plan');
    await context.close();

    // Exercise the real notification component with synthetic browser APIs and
    // intercepted push endpoints. No real subscription or push is performed.
    const pushContext = await browser.newContext({ viewport: { width: 390, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' }); await authenticateContext(pushContext, runtime.base, cookie);
    await pushContext.route('**/*', route => new URL(route.request().url()).origin === runtime.base ? route.continue() : route.abort());
    await pushContext.addInitScript(() => {
      const subscription = { endpoint: 'https://synthetic.invalid/qa', options: {}, toJSON: () => ({ endpoint: 'https://synthetic.invalid/qa', keys: { p256dh: 'synthetic', auth: 'synthetic' } }), unsubscribe: async () => true };
      const worker = { pushManager: { getSubscription: async () => subscription } };
      Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: { register: async () => worker, ready: Promise.resolve(worker), getRegistration: async () => worker, addEventListener() {}, removeEventListener() {} } });
      Object.defineProperty(window, 'Notification', { configurable: true, value: { permission: 'granted', requestPermission: async () => 'granted' } }); Object.defineProperty(window, 'PushManager', { configurable: true, value: function PushManager() {} });
    });
    const requests = []; await pushContext.route('**/api/push/**', async route => {
      const path = new URL(route.request().url()).pathname;
      if (path === '/api/push/test') requests.push(route.request().postDataJSON());
      const body = path === '/api/push/config' ? { enabled: true, publicKey: 'AQ', lastRunAt: null, intervalSeconds: 60 } : path === '/api/push/test' ? { probeId: 'synthetic-probe' } : path === '/api/push/test-status' ? { probeId: 'synthetic-probe', status: 'confirmed', notificationCreatedAt: Date.now() } : { ok: true };
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    page = await pushContext.newPage(); page.on('pageerror', error => report.errors.push({ engine, error: error.message }));
    await page.goto(runtime.base + `/?operatorPlan=${plan.id}#operator`); await expect(page.getByLabel('Фильтр по заданию', { exact: true })).toHaveValue(plan.id);
    await page.getByRole('button', { name: /^Уведомления операторской(?:, включены)?$/ }).click(); dialog = page.getByRole('dialog', { name: 'Уведомления операторской', exact: true });
    await dialog.getByRole('button', { name: 'Проверить уведомление', exact: true }).click(); await expect(dialog).toContainText('Браузер получил тестовое уведомление.');
    assert.deepEqual(requests, [{ endpoint: 'https://synthetic.invalid/qa', kind: 'operator', operatorPlanId: plan.id }]); check('mocked notification test carries operator context and real existing plan id; physical delivery unproven');
    await pushContext.close(); await browser.close(); browser = null;
  }
  const beforeRestart = JSON.stringify((await store.read(source)).operator); await runtime.replaceMiddleware();
  const work = await read(); assert.ok(work.cases.length > 0); assert.equal(JSON.stringify((await store.read(source)).operator), beforeRestart);
  check('middleware/runtime restart preserves all synthetic operator state'); assert.deepEqual(report.errors, []); report.passed = true;
} catch (error) {
  report.failure = { message: error.message, stack: error.stack };
  if (page && !page.isClosed()) { await shot('failure').catch(() => {}); await writeFile(resolve(output, `${engine}-failure.txt`), await page.locator('body').innerText({ timeout: 3000 }).catch(() => 'Page unavailable')); }
  throw error;
} finally {
  await browser?.close(); await runtime.server.close(); await rm(temporary, { recursive: true, force: true });
  await writeFile(resolve(output, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify({ passed: report.passed, checks: report.checks.length, axe: report.axe.length, report: resolve(output, 'report.json'), frontend: report.frontend }));

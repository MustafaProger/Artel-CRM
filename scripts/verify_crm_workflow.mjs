// Authenticated browser audit on disposable fixtures only. No working store or providers.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { chromium, webkit, expect } from '@playwright/test'
import { OperationsStore } from '../server/operations-store.ts'
import { enabledPages } from '../web/src/page-catalog.ts'
import { authenticateContext, bootstrapQaAuth } from './qa-auth.mjs'
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs'

const root = resolve(import.meta.dirname, '..')
const dir = await mkdtemp(resolve(tmpdir(), 'artel-workflow-'))
const snapshotDirectory = resolve(dir, 'snapshot'), operationsDirectory = resolve(dir, 'operations')
const source = await writeTripsQaSnapshot(snapshotDirectory)
const store = new OperationsStore(operationsDirectory)
const company = (id, name, role) => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] })
await store.mutate(source, data => {
  data.sourceOperationsCleared = true
  data.companies = [company('qa-supplier', 'QA Поставщик', 'supplier'), company('qa-client', 'QA Клиент', 'customer')]
  data.directories = {
    fleetSeedApplied: true,
    managers: [{ id: 'qa-a', name: 'QA Нура' }, { id: 'qa-b', name: 'QA Коллега' }, { id: 'qa-c', name: 'QA Администратор' }],
    products: [{ id: 'qa-product', name: 'QA Топливо', transportProductKind: 'diesel', cargoPackaging: 'bulk' }],
    paymentForms: [{ id: 'qa-payment', name: 'б/нал' }],
    drivers: [{ id: 'qa-driver', name: 'QA Водитель', vehicleId: 'qa-vehicle' }],
    vehicles: [{ id: 'qa-vehicle', plate: 'Т000ЕЕ00', capacityLitres: '20000' }],
    oilDepots: [{ id: 'qa-depot', name: 'QA Нефтебаза', ownerCompanyId: 'qa-supplier', loadingActorCompanyId: 'qa-supplier', address: 'QA Погрузка' }],
    addresses: [{ id: 'qa-place', name: 'QA Выгрузка', address: 'QA Выгрузка', companyId: 'qa-client', kind: 'delivery', latitude: '55.7', longitude: '37.6' }],
    customerManagers: [{ companyId: 'qa-client', managerId: 'qa-a' }], defaults: { profit: 'template-payment-form' }, duplicates: [],
  }
  return { changed: true, result: null }
})

let runtime, browser
try {
  runtime = await startTripsQaServer({ root, snapshotDirectory, operationsDirectory })
  const { base } = runtime
  const director = await bootstrapQaAuth(base)
  const call = async (path, cookie, method = 'GET', body) => {
    const response = await fetch(base + path, { method, headers: { ...(cookie ? { Cookie: cookie } : {}), 'Content-Type': 'application/json', Origin: base }, ...(body ? { body: JSON.stringify(body) } : {}) })
    const value = await response.json()
    assert.ok(response.ok, `${method} ${path}: ${response.status} ${value.error ?? ''}`)
    return { value, cookie: response.headers.get('set-cookie')?.split(';')[0] }
  }
  const staff = async (name, id, role) => {
    const login = id, password = randomUUID()
    const added = await call('/api/auth/users', director.cookie, 'POST', { name, login, password, role, managerId: id, sections: ['work', 'trips', 'directories'] })
    return { ...added.value.user, cookie: (await call('/api/auth/login', null, 'POST', { login, password })).cookie }
  }
  const alice = await staff('QA Нура', 'qa-a', 'employee'), bob = await staff('QA Коллега', 'qa-b', 'employee'), admin = await staff('QA Администратор', 'qa-c', 'admin')
  const request = (user, comment) => call('/api/trip-requests', user.cookie, 'POST', { companyId: 'qa-client', addressId: 'qa-place', quantityLitres: '8000', comment, idempotencyKey: randomUUID() })
  await request(alice, 'QA заявка Нуры')
  await request(bob, 'QA заявка коллеги')
  await call('/api/operator/plans', director.cookie, 'POST', { clientName: 'QA задание', recipients: [{ id: randomUUID(), name: 'QA получатель', bank: 'QA банк', card: '0000', phone: '', details: '', limit: '50000' }], idempotencyKey: randomUUID() })
  await call('/api/documents/categories', director.cookie, 'POST', { name: 'QA категория' })
  await call('/api/shipment-trips', director.cookie, 'POST', { idempotencyKey: randomUUID(), fields: {
    organization_id: 'artel', date: '2026-11-11', loading_at: '2026-11-11T09:00', supplier_id: 'qa-supplier', oil_depot_id: 'qa-depot', product_id: 'qa-product', purchase_price_unspecified_unit: '60000', quantity_tonnes: '8', driver_id: 'qa-driver', vehicle_id: 'qa-vehicle',
  }, customers: [{ fields: { customer_id: 'qa-client', manager_id: 'qa-a', payment_form_id: 'qa-payment', quantity_litres: '8000', sale_price_per_litre: '75', transport_amount: '0', invoice_not_required: 'true', unloading_address_id: 'qa-place' } }] })
  const browserErrors = []
  const open = async (user, width = 1440) => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, reducedMotion: 'reduce', serviceWorkers: 'block' })
    await authenticateContext(context, base, user.cookie)
    await context.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
    const page = await context.newPage()
    page.setDefaultTimeout(6500)
    page.on('pageerror', e => browserErrors.push(e.message))
    page.on('dialog', dialog => { browserErrors.push(`Unexpected browser dialog: ${dialog.type()}`); void dialog.dismiss() })
    return { context, page }
  }
  const visit = async (page, route, content) => {
    await page.goto(`${base}/#${route}`)
    await expect(page.locator(content)).toBeVisible()
  }
  const draft = async (page, action, field, value, close = 'Отмена') => {
    await page.getByRole('button', { name: action, exact: true }).click()
    const editor = page.locator('dialog[open]')
    await expect(editor).toBeVisible()
    await editor.getByLabel(field, { exact: true }).fill(value)
    await editor.getByRole('button', { name: close, exact: true }).click()
    await expect(editor).toHaveCount(0)
  }
  browser = await chromium.launch()
  const d = await open(director), a = await open(alice), b = await open(bob), m = await open(admin)
  const selectors = {
    overview: '.overview-page', work: '.work-companies', shipments: '.shipment-add',
    trips: '.trips-section-tabs', payments: '.banking-page', 'cabinet-balances': '.cabinet-page, .cabinet-workspace, .cabinet-section',
    china: '.china-actions', invoices: '.invoice-workspace', operator: '.operator-workspace',
    accounts: '.account-management', directories: '.directories-page', documents: '.document-archive',
  }
  for (const { id } of enabledPages) {
    await visit(d.page, id, selectors[id])
    console.log('PAGE', id)
  }
  await visit(a.page, 'work', '.work-companies')
  await draft(a.page, 'Новая задача', 'Название', 'QA черновик', 'Закрыть рабочую запись')
  await a.page.getByRole('button', { name: 'Новая задача', exact: true }).click()
  let editor = a.page.locator('dialog[open]')
  await editor.getByLabel('Название', { exact: true }).fill('QA назначение коллеге')
  await editor.getByRole('combobox', { name: /Исполнитель/ }).click()
  await editor.getByRole('option', { name: bob.name, exact: true }).click()
  await editor.locator('button[type=submit]').click()
  await expect(editor).toHaveCount(0)
  await visit(b.page, 'work', '.work-companies')
  const assigned = b.page.getByRole('button', { name: 'Задача: QA назначение коллеге' })
  await expect(assigned).toBeVisible()
  await assigned.click()
  await b.page.locator('dialog[open]').getByRole('button', { name: 'Удалить', exact: true }).click()
  await expect(assigned).toHaveCount(0)
  await expect(b.page.locator('dialog[open]')).toHaveCount(0)
  console.log('PASS assignment, cancel and one-click task deletion')

  for (const [session, count] of [[d, 2], [a, 1], [b, 1], [m, 0]]) {
    await visit(session.page, 'trips', '.trips-section-tabs')
    await session.page.getByRole('button', { name: 'Заявки', exact: true }).click()
    if (!count) await expect(session.page.getByRole('heading', { name: 'Заявок пока нет' })).toBeVisible()
    await expect(session.page.getByTestId('trip-request-card')).toHaveCount(count)
    await expect(session.page.getByText('Создайте заявку, чтобы выбрать её при заполнении рейса.', { exact: true })).toHaveCount(0)
  }
  await expect(a.page.getByTestId('trip-request-card')).toContainText('Создана: QA Нура')
  await expect(a.page.getByTestId('trip-request-card')).not.toContainText('QA заявка коллеги')
  await draft(a.page, 'Новая заявка', 'Комментарий', 'QA черновик заявки')
  await a.page.getByRole('button', { name: /^Удалить заявку:/ }).click()
  await expect(a.page.getByRole('heading', { name: 'Заявок пока нет' })).toBeVisible()
  await d.page.getByRole('button', { name: 'Рейсы', exact: true }).last().click()
  await expect(d.page.getByTestId('trip-card')).toContainText('Создан: QA Директор')
  await draft(d.page, 'Изменить рейс', 'Примечание к рейсу', 'QA черновик рейса')
  const tripCard = d.page.getByTestId('trip-card')
  await tripCard.getByRole('button', { name: 'Saby', exact: true }).click()
  await tripCard.getByRole('button', { name: 'Удалить рейс', exact: true }).click()
  await expect(tripCard).toHaveCount(0)
  await expect(d.page.locator('dialog[open]')).toHaveCount(0)
  console.log('PASS request privacy, author/date, cancel and one-click request/trip deletion')

  await visit(d.page, 'directories', '.directory-tabs')
  const tabs = d.page.locator('.directory-tabs button')
  const directoryNames = ['Клиенты', 'Поставщики', 'Нефтебазы', 'Сотрудники', 'Товары', 'Автомобили', 'Водители', 'Места погрузки и доставки', 'Сервисы операторской']
  await expect(tabs).toHaveText(directoryNames)
  for (const [tabName, entry] of [['Клиенты', 'QA Клиент'], ['Поставщики', 'QA Поставщик'], ['Места погрузки и доставки', 'QA Выгрузка']]) {
    await d.page.locator('.directory-tabs').getByRole('button', { name: tabName, exact: true }).click()
    await expect(d.page.locator('.directory-record strong').getByText(entry, { exact: true })).toBeVisible()
  }
  await visit(a.page, 'directories', '.directory-tabs')
  await expect(a.page.locator('.directory-tabs button')).toHaveText(['Клиенты', 'Места погрузки и доставки'])
  await expect(a.page.locator('.directory-record strong').getByText('QA Клиент', { exact: true })).toBeVisible()
  for (const tab of await tabs.all()) {
    await tab.click()
    await d.page.getByRole('button', { name: 'Добавить', exact: true }).click()
    editor = d.page.locator('dialog[open]')
    await expect(editor).toBeVisible()
    const field = editor.locator('input[type=text]:not([readonly])').first()
    if (await field.count()) await field.fill('QA черновик')
    await editor.getByRole('button', { name: 'Отмена', exact: true }).click()
    await expect(editor).toHaveCount(0)
  }
  await call('/api/directories', director.cookie, 'POST', { kind: 'products', name: 'QA на удаление' })
  await d.page.reload()
  await d.page.getByRole('button', { name: 'Товары', exact: true }).click()
  const deleteProduct = d.page.getByRole('button', { name: 'Удалить: QA на удаление', exact: true })
  await deleteProduct.click()
  await expect(deleteProduct).toHaveCount(0)
  await expect(d.page.locator('dialog[open]')).toHaveCount(0)
  await visit(d.page, 'accounts', '.account-management')
  await d.page.getByRole('button', { name: 'Добавить пользователя', exact: true }).click()
  await expect(d.page.getByRole('option', { name: 'Логист', exact: true, includeHidden: true })).toHaveCount(0)
  console.log('PASS nine directory tabs, cancel, one-click deletion, retired role')

  await visit(d.page, 'operator', '.operator-workspace')
  for (const name of [/Задания/, /^Возвраты/, /^Ожидают заправки/, 'Сверки', 'Операции']) {
    await d.page.getByRole('tab', { name }).click()
  }
  await draft(d.page, 'Новая операция', 'Имя водителя', 'QA черновик операции', 'Закрыть')
  await visit(d.page, 'china', '.china-actions')
  await draft(d.page, 'Добавить день', 'Количество литров 1', '8000')
  await visit(d.page, 'documents', '.archive-category-tabs')
  await draft(d.page, 'Добавить категорию', 'Название категории', 'QA черновик категории')
  await d.page.getByRole('button', { name: 'Удалить категорию', exact: true }).click()
  await expect(d.page.getByRole('button', { name: 'QA категория', exact: true })).toHaveCount(0)
  await expect(d.page.locator('dialog[open]')).toHaveCount(0)
  await visit(d.page, 'shipments', '.shipment-add')
  await d.page.getByRole('button', { name: 'Добавить отгрузку', exact: true }).click()
  await expect(d.page.locator('dialog[open]')).toBeVisible()
  await d.page.locator('dialog[open]').getByRole('button', { name: 'Отмена', exact: true }).click()
  await expect(d.page.locator('dialog[open]')).toHaveCount(0)
  console.log('PASS China, documents and shipments forms')
  await browser.close()

  browser = await webkit.launch()
  const mobile = await open(director, 390)
  await visit(mobile.page, 'trips', '.trips-section-tabs')
  await mobile.page.getByRole('button', { name: 'Заявки', exact: true }).click()
  await draft(mobile.page, 'Новая заявка', 'Комментарий', 'QA мобильная отмена')
  await visit(mobile.page, 'directories', '.directory-tabs')
  await expect(mobile.page.locator('.directory-tabs button')).toHaveText(directoryNames)
  assert.deepEqual(browserErrors, [])
  console.log('PASS mobile WebKit and no uncaught browser errors')
} finally {
  await browser?.close()
  await runtime?.server.close()
  await rm(dir, { recursive: true, force: true })
}

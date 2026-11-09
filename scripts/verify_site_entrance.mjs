// Browser audit of route and tab motion against a temporary synthetic store.
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { chromium, webkit, expect } from '@playwright/test'
import { enabledPages } from '../web/src/page-catalog.ts'
import { OperationsStore } from '../server/operations-store.ts'
import { startTripsQaServer, writeTripsQaSnapshot } from './qa-trips-runtime.mjs'
import { authenticateContext } from './qa-auth.mjs'

const root = resolve(import.meta.dirname, '..')
const temp = await mkdtemp(resolve(tmpdir(), 'artel-site-entrance-'))
const snapshots = resolve(temp, 'snapshot'), operations = resolve(temp, 'operations')
const password = randomUUID()
const invoiceFixture = {
  integration: { status: 'read_only', message: 'Синтетический обработчик счетов', checkedAt: '2026-10-28T12:00:00Z' },
  invoiceProfiles: [], invoiceCreation: { mode: 'live', connections: [] }, canPrepare: false,
  organizations: [], buyers: [], connections: [], defaultUnitPrice: '79',
  settings: { defaultUnitPrice: '79', revision: 1, updatedAt: null, updatedBy: null },
  product: { name: 'Учебное топливо', unit: 'л', vatRate: '22', vatMode: 'included' },
  canCreate: false, canEditDefaultPrice: false, history: { status: 'ready', items: [] },
}
let runtime, browser

async function instrument(page, base) {
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.route('**/*', route => new URL(route.request().url()).origin === base ? route.continue() : route.abort())
  await page.addInitScript(() => {
    window.entrances = []
    const record = (animation, kind) => {
      const target = animation.effect.target
      if (!(target instanceof HTMLElement)) return
      const timing = animation.effect.getTiming()
      const frames = animation.effect.getKeyframes()
      window.entrances.push({ kind, target, timing, frames, animation })
    }
    document.addEventListener('animationstart', event => {
      if (!['surface-appear', 'heading-appear'].includes(event.animationName)) return
      const animation = event.target.getAnimations().find(item => item.animationName === event.animationName)
      if (animation) record(animation, event.animationName)
    })
    document.addEventListener('transitionrun', event => {
      if (event.propertyName !== 'transform' || !event.target.matches('.scrollable-segments-selection')) return
      const animation = event.target.getAnimations().find(item => item.transitionProperty === 'transform')
      if (animation) record(animation, 'indicator')
    })
    const animate = Element.prototype.animate
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options)
      if (options?.id === 'view-entrance') record(animation, 'view-entrance')
      return animation
    }
  })
  return errors
}

async function verifyMotion(page, selector, kind, reduced) {
  const samples = () => page.evaluate(({ selector, kind }) => window.entrances
    .filter(sample => sample.kind === kind && sample.target.matches(selector))
    .map(({ timing, frames }) => ({ duration: timing.duration, delay: timing.delay, frames })), { selector, kind })
  if (reduced) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))))
    assert.deepEqual(await samples(), [], selector)
  } else {
    await expect.poll(async () => (await samples()).length, { message: selector }).toBeGreaterThan(0)
    const [sample] = await samples()
    assert.ok(sample.duration > 0 && sample.duration + sample.delay <= 300, selector)
    if (kind !== 'indicator') {
      assert.ok(Number(sample.frames[0].opacity) < 1, selector)
      assert.equal(Number(sample.frames.at(-1).opacity), 1, selector)
    }
  }
}
const clearMotion = page => page.evaluate(() => { window.entrances.length = 0 })
const switchTo = async (page, group, button, content, motion, reduced) => {
  await clearMotion(page)
  await page.locator(group).getByRole('button', { name: button }).or(page.locator(group).getByRole('tab', { name: button })).click()
  await expect(page.locator(content).first()).toBeVisible()
  await verifyMotion(page, motion, 'view-entrance', reduced)
  await verifyMotion(page, `${group} > .scrollable-segments-selection`, 'indicator', reduced)
}

try {
  const source = await writeTripsQaSnapshot(snapshots)
  const store = new OperationsStore(operations)
  await store.mutate(source, data => {
    const company = (id, name, role) => ({ id, name, roles: [role], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] })
    data.companies = [company('qa-supplier', 'QA Поставщик', 'supplier'), company('qa-customer', 'QA Клиент', 'customer')]
    data.directories = {
      fleetSeedApplied: true, managers: [{ id: 'qa-manager', name: 'QA Сотрудник' }],
      products: [{ id: 'qa-product', name: 'QA Дизель', transportProductKind: 'diesel', cargoPackaging: 'bulk' }],
      paymentForms: [{ id: 'qa-payment', name: 'б/нал' }],
      drivers: [{ id: 'qa-driver', name: 'QA Водитель', vehicleId: 'qa-vehicle' }],
      vehicles: [{ id: 'qa-vehicle', plate: 'Т000ЕЕ00', capacityLitres: '20000' }],
      oilDepots: [{ id: 'qa-depot', name: 'QA Нефтебаза', address: 'Синтетическая нефтебаза, 1', ownerCompanyId: 'qa-supplier', loadingActorCompanyId: 'qa-supplier', infrastructureOwnerCompanyId: 'qa-supplier' }],
      addresses: [{ id: 'qa-address', name: 'QA Выгрузка', kind: 'delivery', companyId: 'qa-customer', address: 'Синтетическая улица, 1' }],
      customerManagers: [{ companyId: 'qa-customer', managerId: 'qa-manager' }], defaults: { profit: 'template-payment-form' }, duplicates: [],
    }
    return { changed: true, result: null }
  })
  runtime = await startTripsQaServer({ root, snapshotDirectory: snapshots, operationsDirectory: operations })
  const { base } = runtime
  const setup = await fetch(base + '/api/auth/setup', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: 'QA Директор', login: 'motion.qa', password }),
  })
  assert.ok(setup.ok)
  const cookie = setup.headers.get('set-cookie').split(';')[0]
  const post = async (path, data) => {
    const response = await fetch(base + path, {
      method: 'POST', headers: { Cookie: cookie, Origin: base, 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    })
    const body = await response.json()
    assert.ok(response.ok, `${path} ${response.status} ${body.error ?? ''}`)
    return body
  }
  await post('/api/work/tasks', { title: 'QA активная задача' })
  await post('/api/work/tasks', { title: 'QA архивная задача', status: 'done' })
  for (const name of ['QA Первая категория', 'QA Вторая категория']) await post('/api/documents/categories', { name })
  await post('/api/shipment-trips', { idempotencyKey: randomUUID(), fields: {
    organization_id: 'artel', date: '2026-11-09', loading_at: '2026-11-09T09:00', supplier_id: 'qa-supplier',
    oil_depot_id: 'qa-depot', product_id: 'qa-product', purchase_price_unspecified_unit: '60000',
    quantity_tonnes: '8', driver_id: 'qa-driver', vehicle_id: 'qa-vehicle',
  }, customers: [{ fields: {
    customer_id: 'qa-customer', manager_id: 'qa-manager', payment_form_id: 'qa-payment', quantity_litres: '10000',
    sale_price_per_litre: '75', transport_amount: '1500', invoice_not_required: 'true', unloading_address_id: 'qa-address',
  } }] })
  const driver = await post('/api/drivers/qa-driver/access', { action: 'issue', version: 0 })

  const ready = {
    overview: '.organization-overview', work: '.work-layout', shipments: '.shipment-grid',
    trips: '.trip-requests-panel .trips-empty', payments: '.bank-cards', 'cabinet-balances': '.cabinet-layout',
    china: '.china-table-scroll', invoices: '.invoice-create-panel', operator: '#operator-content',
    accounts: '.account-list', directories: '.directory-list', documents: '.archive-list',
  }
  for (const [name, launcher, width, reduced] of [
    ['Chromium', chromium, 1440, false], ['Chromium', chromium, 390, false],
    ['WebKit', webkit, 390, false], ['Chromium', chromium, 390, true],
  ]) {
    browser = await launcher.launch()
    const context = await browser.newContext({
      viewport: { width, height: 950 }, hasTouch: width === 390, isMobile: width === 390,
      reducedMotion: reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block', timezoneId: 'Europe/Moscow',
    })
    const page = await context.newPage()
    const errors = await instrument(page, base)
    await page.route('**/api/invoices', route => route.request().method() === 'GET'
      ? route.fulfill({ json: invoiceFixture }) : route.abort())
    await page.goto(base)
    await expect(page.getByRole('heading', { name: 'Вход', exact: true })).toBeVisible()
    await verifyMotion(page, '.auth-form', 'surface-appear', reduced)
    await authenticateContext(context, base, cookie)
    await page.goto(base)
    await expect(page.locator(ready.overview)).toBeVisible()

    const visit = async id => {
      await clearMotion(page)
      await page.evaluate(id => { location.hash = id }, id)
      await expect(page.locator(ready[id]).first()).toBeVisible()
      await expect(page.locator('#main-content h1')).toHaveCount(1)
      await verifyMotion(page, '.page-content', 'surface-appear', reduced)
    }
    // Start away from overview so the loop checks its transition as well.
    await visit('work')
    for (const { id } of enabledPages) {
      if (id !== 'work') await visit(id)
    }

    await switchTo(page, '.archive-category-tabs', /QA Вторая/, '.archive-empty', '.archive-empty', reduced)
    await visit('overview')
    await clearMotion(page)
    await page.locator('.overview-ledger-tabs').getByRole('button', { name: 'Клиенты' }).click()
    await expect(page.locator('.organization-ledger')).toHaveAttribute('data-side', 'clients')
    await verifyMotion(page, '.organization-ledger', 'surface-appear', reduced)
    await verifyMotion(page, '.overview-ledger-tabs > .scrollable-segments-selection', 'indicator', reduced)
    await visit('directories')
    await switchTo(page, '.directory-tabs', 'Поставщики', '.directory-list', '.directory-record-count', reduced)
    await visit('accounts')
    await switchTo(page, '.account-role-filters', /Менеджер/, '.account-empty', '.account-empty', reduced)
    await visit('operator')
    await switchTo(page, '.operator-tabs', /Задания/, '#operator-content', '#operator-content', reduced)
    await visit('payments')
    await switchTo(page, '.bank-source-tabs', /Архив/, '.payment-archive', '.payment-archive', reduced)
    await visit('trips')
    await switchTo(page, '.trips-section-tabs', 'Карта', '.trips-page-map > section', '.trips-page-map > section', reduced)
    await switchTo(page, '.trips-section-tabs', 'Рейсы', '.trips-toolbar', '.trips-toolbar', reduced)
    await switchTo(page, '.trips-section-tabs', 'В процессе', '.trip-process', '.trip-process', reduced)
    await switchTo(page, '.execution-filters', /Завершённые/, '.execution-context', '.execution-context', reduced)
    await visit('shipments')
    await switchTo(page, '.shipment-type-segments', /АЗС/, '.shipment-grid', '.shipment-grid-scroll', reduced)
    await visit('work')
    await switchTo(page, '.work-list-scopes', 'Сегодня', '.work-company-list', '.work-company-list > .work-empty, .work-task-row', reduced)
    await switchTo(page, '.work-list-scopes', 'Предстоящие', '.work-week', '.work-week-heading > strong', reduced)
    await switchTo(page, '.work-views', 'Календарь', '.work-calendar-grid', '.work-calendar-scroll', reduced)
    await switchTo(page, '.work-views', /Архив/, '.work-task-row', '.work-task-row', reduced)
    await switchTo(page, '.work-views', 'Задачи', '.work-week', '.work-week-heading > strong', reduced)
    assert.deepEqual(errors, [])

    const driverContext = await browser.newContext({ viewport: { width, height: 950 }, reducedMotion: reduced ? 'reduce' : 'no-preference', serviceWorkers: 'block' })
    const login = await driverContext.request.post(base + '/api/auth/login', {
      data: { login: driver.access.login, password: driver.temporaryPassword },
    })
    assert.ok(login.ok())
    const driverPage = await driverContext.newPage()
    const driverErrors = await instrument(driverPage, base)
    await driverPage.goto(base + '/#driver-trips')
    await expect(driverPage.locator('.driver-trip-list')).toBeVisible()
    await verifyMotion(driverPage, '.driver-route-content', 'surface-appear', reduced)
    await switchTo(driverPage, '.driver-sections', 'Архивные', '.driver-empty', '.driver-empty', reduced)
    await switchTo(driverPage, '.driver-sections', 'Активные', '.driver-trip-card', '.driver-trip-list', reduced)
    await clearMotion(driverPage)
    await driverPage.locator('.driver-trip-card').click()
    await expect(driverPage.locator('.driver-trip-detail')).toBeVisible()
    await verifyMotion(driverPage, '.driver-route-content', 'surface-appear', reduced)
    await verifyMotion(driverPage, '.driver-trip-detail', 'surface-appear', reduced)
    assert.deepEqual(driverErrors, [])
    await driverContext.close()

    const logistics = await context.newPage()
    const logisticsErrors = await instrument(logistics, base)
    const logisticsLogin = await context.request.post(base + '/api/logistics/auth/login', { data: { login: 'motion.qa', password } })
    assert.ok(logisticsLogin.ok())
    await logistics.goto(base + '/logistics/')
    await expect(logistics.locator('.trip-requests-panel')).toBeVisible()
    await verifyMotion(logistics, '.logistics-page-content', 'surface-appear', reduced)
    for (const id of ['vehicles', 'drivers', 'customers', 'suppliers', 'oilDepots', 'products', 'addresses', 'trips']) {
      await clearMotion(logistics)
      await logistics.evaluate(id => { location.hash = id }, id)
      await expect(logistics.locator(`a[href="#${id}"][aria-current="page"]`)).toHaveCount(1)
      await expect(logistics.locator(id === 'trips' ? '.trip-requests-panel' : '.directory-list')).toBeVisible()
      await verifyMotion(logistics, '.logistics-page-content', 'surface-appear', reduced)
    }
    assert.deepEqual(logisticsErrors, [])
    console.log(`PASS ${name} ${width}px reduced=${reduced}: ${enabledPages.length} CRM routes, auth, driver, 8 logistics routes, tab changes`)
    await context.close()
    await browser.close()
    browser = undefined
  }
} finally {
  await browser?.close()
  await runtime?.server.close()
  await rm(temp, { recursive: true, force: true })
}

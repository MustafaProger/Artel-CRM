// QA fixture only. Requires an already bootstrapped disposable loopback runtime.
// Provider data is returned as browser mocks; no integration is called or configured.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export async function seed(runtime, auth) {
  const origin = new URL(runtime.base);
  assert.equal(origin.protocol, 'http:');
  assert.equal(origin.hostname, '127.0.0.1');
  assert.ok(auth?.cookie, 'Pass the synthetic bootstrap auth result');
  const mutations = [];
  const api = async (path, method = 'GET', body) => {
    const response = await fetch(runtime.base + path, { method, headers: { Cookie: auth.cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const result = await response.json();
    assert.ok(response.ok, JSON.stringify({ path, status: response.status, error: result.error }));
    if (method !== 'GET') mutations.push({ path, method });
    return result;
  };
  const directory = async (kind, values) => (await api('/api/directories', 'POST', { kind, ...values })).entry;
  const today = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date());
  const now = `${today}T09:00:00Z`;
  const manager = await directory('managers', { name: 'Учебный менеджер' });
  const supplier = await directory('companies', { name: 'Учебный поставщик топлива', roles: ['supplier'], addresses: [] });
  const product = await directory('products', { name: 'Учебное дизельное топливо', transportProductKind: 'diesel', cargoPackaging: 'bulk' });
  const vehicle = await directory('vehicles', { plate: 'Т000ЕЕ00', capacityLitres: '16000' });
  const driver = await directory('drivers', { name: 'Учебный водитель', vehicleId: vehicle.id });
  const payment = (await api('/api/snapshot?shipments=omit&context=directories')).directories.paymentForms.find(row => row.name === 'б/нал');
  assert.ok(payment);
  const customers = [], requests = [], trips = [];
  for (const [index, name] of ['Учебный Север', 'Учебный Строй', 'Учебный Восток', 'Учебный Склад'].entries()) {
    const customer = await directory('companies', { name, roles: ['customer'], managerId: manager.id, addresses: [] });
    const address = await directory('addresses', { name: index % 2 ? 'Строительная площадка' : 'Производственная база', companyId: customer.id, addressKind: 'delivery', address: `Учебный город, Примерная улица, ${index + 1}` });
    customers.push(customer);
    requests.push(await api('/api/trip-requests', 'POST', { companyId: customer.id, addressId: address.id, quantityLitres: String(3000 + index * 1000), executionDate: today, salePricePerLitre: '75', comment: index === 1 ? 'Въезд через северные ворота. Связаться с ответственным перед прибытием.' : '', idempotencyKey: randomUUID() }));
    if (index < 3) trips.push(await api('/api/shipment-trips', 'POST', { idempotencyKey: randomUUID(), fields: { organization_id: 'artel', date: today, loading_at: today, supplier_id: supplier.id, product_id: product.id, purchase_price_unspecified_unit: '60000', quantity_tonnes: '8', driver_id: driver.id, vehicle_id: vehicle.id }, customers: [{ fields: { customer_id: customer.id, manager_id: manager.id, payment_form_id: payment.id, quantity_litres: '10000', sale_price_per_litre: '75', transport_amount: '1000', invoice_not_required: 'true', unloading_address_id: address.id } }] }));
  }
  const recipientId = randomUUID();
  const plan = await api('/api/operator/plans', 'POST', { clientName: 'Учебный клиент операторской', recipients: [{ id: recipientId, name: 'Учебный получатель', bank: 'Учебный банк', card: '0000', phone: '', details: '', limit: '1000000' }], idempotencyKey: randomUUID() });
  for (const [index, name] of ['Учебный водитель Иван', 'Учебный водитель Пётр', 'Учебный водитель Роман'].entries()) {
    const workspace = await api('/api/operator'), current = workspace.plans.find(row => row.id === plan.id), service = workspace.services.find(row => row.name === 'ННК');
    assert.ok(service);
    const saved = await api('/api/operator/refuellings', 'POST', { schemaVersion: 3, planId: current.id, planVersion: current.version, name, date: today, serviceId: service.id, serviceVersion: service.version ?? 0, discountPercent: service.discountPercent, litres: '900', pricePerLitre: '80', amount: '64800.00', amountMode: 'auto', comment: 'Учебная операция для проверки интерфейса.', allocations: [{ kind: 'recipient', recipientId, amount: '64800.00' }], idempotencyKey: randomUUID() });
    if (index === 0) await api(`/api/operator/refuellings/${saved.id}/payment`, 'PATCH', { version: 1, paid: true, idempotencyKey: randomUUID() });
  }
  const bankDefinitions = [{ id: 'sber-nk-artel', provider: 'sber', bankName: 'СберБизнес', company: 'НК АРТЭЛЬ' }, { id: 'sber-artel', provider: 'sber', bankName: 'СберБизнес', company: 'АРТЭЛЬ' }, { id: 'tbank-nk-artel', provider: 'tbank', bankName: 'Т-Банк', company: 'НК АРТЭЛЬ' }];
  const bankRows = bankDefinitions.flatMap((bank, bankIndex) => ['incoming', 'outgoing'].map((direction, index) => ({ id: `qa-bank-${bankIndex}-${index}`, connectionId: bank.id, provider: bank.provider, bankOperationId: `qa-${bankIndex}-${index}`, account: `0000000000000000000${bankIndex + 1}`, statementDate: today, documentNumber: String(101 + index), documentDate: today, direction, amount: direction === 'incoming' ? '750000' : '128000', currency: 'RUB', status: 'Исполнено', booked: true, purpose: 'Учебная оплата топлива', payer: { name: 'Учебный покупатель' }, payee: { name: 'Учебный поставщик' }, bankData: {}, updatedAt: now, source: 'statement-api', counterpartyId: null, allocations: [], importedSourceIds: [] })));
  const bankCards = bankDefinitions.map((bank, index) => ({ ...bank, accounts: [{ number: `0000000000000000000${index + 1}`, currency: 'RUB' }], state: 'connected', missing: [], lastSuccessAt: now, lastCompletedPeriod: { from: today, to: today }, totals: [{ currency: 'RUB', incoming: '750000', outgoing: '128000', count: 2 }], limitations: [] }));
  const browserFixtures = { '/api/banking': { connections: bankCards, items: bankRows, total: bankRows.length, page: 1, pageSize: 25, totals: [{ currency: 'RUB', incoming: '2250000', outgoing: '384000', count: 6 }], statuses: ['Исполнено'], storedCount: 6, scheduleEnabled: false } };
  for (const card of bankCards.filter(row => row.provider === 'sber')) browserFixtures[`/api/banking/sber/${card.id}/statements`] = { account: card.accounts[0].number, company: card.company, inn: '0000000000', days: [{ date: today, openingBalance: '500000', incoming: '750000', outgoing: '128000', closingBalance: '1122000', currency: 'RUB', syncedAt: now, status: 'complete' }], operations: bankRows.filter(row => row.connectionId === card.id), missing: [], lastSuccessAt: now, lastCompletedPeriod: { from: today, to: today }, scheduleEnabled: false };
  const profile = { revision: 'qa-v1', sourceNumber: 'QA-1', sourceDate: today, observedAt: now, organizationId: 'qa-seller', connectionId: 'qa-connection', organizationName: 'Учебный продавец', productName: 'Предоплата за дизельное топливо', unit: 'л', currency: 'RUB', vatRate: '22', vatMode: 'included', sampleUnitPrice: '79', bankLabel: 'Учебный банк', bankDiffersFromDefault: false, postedAsSample: true, qr: false, productSelectionStatus: 'ready' };
  browserFixtures['/api/invoices'] = { integration: { status: 'configured', message: 'Синтетические справочники', checkedAt: now }, invoiceProfiles: [profile], invoiceCreation: { mode: 'live', connections: [{ connectionId: profile.connectionId, ready: true, checking: false, blockers: [] }] }, canPrepare: true, organizations: [{ id: profile.organizationId, name: profile.organizationName, connectionId: profile.connectionId }], buyers: [{ id: 'qa-buyer', name: 'Учебный покупатель', inn: '0000000000', connectionId: profile.connectionId }], connections: [{ id: profile.connectionId, baseId: null, baseLabel: 'Учебная база', status: 'ready', checkedAt: now, counts: { organizations: 1, buyers: 1 } }], defaultUnitPrice: '79', settings: { defaultUnitPrice: '79', revision: 1, updatedAt: null, updatedBy: null }, product: { name: profile.productName, unit: 'л', vatRate: '22', vatMode: 'included' }, canCreate: true, canEditDefaultPrice: true, history: { status: 'ready', items: [1, 2].map(index => ({ id: `qa-invoice-${index}`, status: 'ready', workflowState: 'completed', number: `УЧ-${index}`, amount: String(79000 * index), unitPrice: '79', organizationName: profile.organizationName, buyerName: `Учебный покупатель ${index}`, createdAt: now, fileAvailable: true, quantity: { display: String(1000 * index), numerator: String(1000 * index), denominator: '1', exact: true } })) } };
  return { syntheticOnly: true, mutations, counts: { customers: customers.length, requests: requests.length, trips: trips.length, operatorOperations: 3 }, browserFixtures };
}

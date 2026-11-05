// QA-only population of remaining pages; all writes target disposable loopback storage.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
export async function seedExtras(runtime, auth) {
  assert.equal(new URL(runtime.base).hostname, '127.0.0.1');
  const mutations = [];
  const api = async (path, method = 'GET', body) => { const response = await fetch(runtime.base + path, { method, headers: { Cookie: auth.cookie, Origin: runtime.base, 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) }); const result = await response.json(); assert.ok(response.ok, JSON.stringify({ path, status: response.status, error: result.error })); if (method !== 'GET') mutations.push({ path, method }); return result; };
  const user = (await api('/api/auth/session')).user;
  for (const title of ['Проверить документы на доставку', 'Согласовать время разгрузки с клиентом', 'Подготовить сверку за месяц', 'Обновить карточку водителя']) await api('/api/work/tasks', 'POST', { requestId: randomUUID(), title, description: 'Синтетическая задача для визуальной проверки интерфейса.', assigneeId: user.id });
  await api('/api/documents/categories', 'POST', { name: 'Учебные договоры' });
  const archive = await api('/api/documents'), categoryId = archive.categories.find(c => c.name === 'Учебные договоры').id;
  for (const name of ['Договор поставки топлива — учебный образец', 'Дополнительное соглашение о доставке', 'Акт сверки взаиморасчётов', 'Реквизиты учебной организации']) await api('/api/documents/cards', 'POST', { categoryId, name, files: [], version: 1 });
  const snapshot = await api('/api/snapshot?shipments=omit&context=directories');
  const supplier = snapshot.companies.find(c => c.roles?.includes('supplier'));
  assert.ok(supplier, 'Base fixture must seed a supplier');
  const dates = [0, 1, 2, 3].map(days => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date(Date.now() - days * 86400000)));
  for (const [i,date] of dates.entries()) {
    await api('/api/china/days', 'POST', { requestId: randomUUID(), date, fuels: [{ supplierId: supplier.id, litres: String(1200 + i * 100), amount: String(86400 + i * 7200) }] });
    await api('/api/china/payments', 'POST', { requestId: randomUUID(), date, amount: String(100000 + i * 10000) });
  }
  for (const [i,name] of ['Учебный менеджер Анна', 'Учебный менеджер Павел'].entries()) {
    const manager = (await api('/api/directories', 'POST', { kind: 'managers', name })).entry;
    await api('/api/auth/users', 'POST', { name, login: `visual-qa-${i}`, password: randomUUID() + 'Qa!7', role: 'manager', managerId: manager.id, sections: ['work', 'shipments', 'trips', 'documents'] });
  }
  const now = new Date().toISOString();
  const browserFixtures = { '/api/cabinets': { credentialStorageReady: true, connections: ['glopro', 'rosneft'].map((provider,index) => ({ id: `qa-cabinet-${index}`, provider, label: index ? 'Учебный филиал' : 'Учебная компания', createdAt: now, state: 'connected', lastSuccessAt: now, accounts: [0,1].map(n => ({ id: `qa-account-${index}-${n}`, supplier: n ? 'Учебный поставщик' : 'Учебный топливный оператор', organization: n ? 'Учебная Северная компания' : 'Учебная компания', amountMinor: 75000000 - index * 18000000 - n * 13000000, currency: 'RUB', sourceUpdatedAt: now })) })) } };
  return { syntheticOnly: true, mutations, counts: { workTasks: 4, documentCards: 4, chinaDays: 4, chinaPayments: 4, addedAccounts: 2, cabinetConnectionsMocked: 2 }, browserFixtures };
}

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import { effectiveSections, hasSection, type AccountRole, type AccountUser } from '../web/src/auth-model';
import { hasPageAccess } from '../web/src/page-access';
import { calculateQuantity, normalizePositiveDecimal } from '../web/src/invoice-math';

const user = (role: AccountRole, sections?: AccountUser['sections']): AccountUser => ({ id: 'synthetic-crm-owner', name: 'Учебный сотрудник', login: 'qa', role, managerId: null, active: true, version: 1, sections });
for (const role of ['director', 'admin', 'manager', 'employee', 'logistician'] as const) {
  test(`${role}: invoices require explicit catalog permission and can be revoked`, () => {
    const before = effectiveSections(user(role));
    assert.equal(hasPageAccess(user(role), 'invoices'), false);
    assert.equal(hasPageAccess(user(role, [...before, 'invoices']), 'invoices'), true);
    assert.deepEqual(effectiveSections(user(role, [...before, 'invoices'])).filter(id => id !== 'invoices'), before);
    assert.equal(hasPageAccess(user(role, before), 'invoices'), false);
    assert.equal(hasSection({ ...user(role, ['invoices']), active: false }, 'invoices'), false);
  });
}
test('driver remains isolated even with an invoice section in a legacy record', () => assert.equal(hasPageAccess(user('driver', ['invoices']), 'invoices'), false));
test('invoice decimal preview normalizes comma inputs and retains exact ratio', () => {
  assert.equal(normalizePositiveDecimal('9000,50'), '9000.5');
  assert.equal(calculateQuantity('9000', '79').numerator, '9000');
  assert.equal(calculateQuantity('9000', '79').denominator, '79');
  assert.equal(calculateQuantity('9000', '79').exact, false);
  assert.throws(() => normalizePositiveDecimal('0'));
  assert.throws(() => normalizePositiveDecimal('1e3'));
});
const source = await readFile(new URL('../web/public/sw.js', import.meta.url), 'utf8');
async function click(url: string, paths: string[]) {
  let wait: Promise<unknown> | undefined;
  const messages: unknown[] = [], navigations: string[] = [], opened: string[] = [], focused: string[] = [];
  const handlers = new Map<string, (event: unknown) => void>();
  const origin = 'https://crm.synthetic.test';
  vm.runInNewContext(source, { URL, self: {
    location: { origin }, addEventListener: (name: string, handler: (event: unknown) => void) => handlers.set(name, handler),
    clients: { matchAll: async () => paths.map(path => ({ url: origin + path, postMessage: (message: unknown) => messages.push(structuredClone(message)), navigate: async (target: string) => navigations.push(target), focus: async () => focused.push(path) })), openWindow: async (target: string) => opened.push(target) },
  } });
  handlers.get('notificationclick')!({ notification: { data: { url }, close() {} }, waitUntil(promise: Promise<unknown>) { wait = promise; } });
  await wait; return { messages, navigations, opened, focused };
}
test('invoice notification focuses existing CRM and opens history without losing draft', async () => {
  const result = await click('/?invoiceView=history&invoiceJob=qa-job#invoices', ['/#operator']);
  assert.deepEqual(result.messages, [{ type: 'artel-open-invoices', jobId: 'qa-job' }]);
  assert.deepEqual(result.navigations, []); assert.deepEqual(result.opened, []); assert.deepEqual(result.focused, ['/#operator']);
});
test('invoice notification does not interrupt a different logistics workspace', async () => {
  const result = await click('/?invoiceView=history#invoices', ['/logistics/#trips']);
  assert.deepEqual(result.messages, []); assert.deepEqual(result.navigations, []); assert.deepEqual(result.opened, ['https://crm.synthetic.test/?invoiceView=history#invoices']);
});
test('invoice path alias uses the same root worker and existing main CRM window', async () => {
  const result = await click('/invoices/?invoiceView=history#invoices', ['/']);
  assert.deepEqual(result.messages, [{ type: 'artel-open-invoices', jobId: null }]); assert.deepEqual(result.navigations, []);
});
test('existing work and driver notification navigation remains unchanged', async () => {
  for (const target of ['/#work', '/#driver-trip/qa-trip']) {
    const result = await click(target, ['/']); assert.deepEqual(result.navigations, ['https://crm.synthetic.test' + target]); assert.deepEqual(result.messages, []);
  }
});
test('external notification URL cannot open an external origin', async () => {
  const result = await click('https://foreign.synthetic.test/?invoiceView=history#invoices', []);
  assert.deepEqual(result.opened, ['https://crm.synthetic.test/#work']);
});

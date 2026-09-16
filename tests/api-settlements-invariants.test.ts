import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildSettlements } from '../server/settlements';
import { emptyBanking, operationId } from '../server/banking/domain';
import { emptySber, SBER_ACCOUNT, SBER_INN } from '../server/banking/sber-domain';
import { validInn } from '../server/checko';
import type { OperationsData } from '../server/operations-store';
import type { BankOperation } from '../web/src/banking-model';
import type { Company, Shipment } from '../web/src/model';

// The oracle uses integer kopecks and interval intersection. It neither calls the
// production decimal helpers nor reproduces their payment-allocation loop.
const inns = ['7707083893', '7736050003', '7704217370', '7736207543'];
const companies: Company[] = inns.map((inn, index) => ({ id: `buyer-${index}`, name: `Покупатель ${index}`, inn, roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] }));
const accounts = ['40702810000000000001', '40702810000000000002'];
const minimum = (a: bigint, b: bigint) => a < b ? a : b;
const maximum = (a: bigint, b: bigint) => a > b ? a : b;
const sum = (values: bigint[]) => values.reduce((total, value) => total + value, 0n);
const money = (value: bigint) => `${value / 100n}.${String(value % 100n).padStart(2, '0')}`;
const kopecks = (value: string | null) => {
  assert.notEqual(value, null, 'Expected a known monetary amount');
  assert.match(value!, /^\d+(?:\.\d{1,2})?$/, `Not an exact nonnegative kopeck amount: ${value}`);
  const [whole, fraction = ''] = value!.split('.');
  return BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'));
};
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const random = (seed: number) => {
  let state = seed >>> 0;
  return (bound: number) => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) % bound; };
};
const shuffled = <T>(values: T[], next: ReturnType<typeof random>) => {
  const result = [...values];
  for (let index = result.length - 1; index > 0; index--) { const other = next(index + 1); [result[index], result[other]] = [result[other], result[index]]; }
  return result;
};

interface Debt { row: Shipment; buyer: number; amount: bigint; opening: bigint }
interface Credit { row: BankOperation; buyer: number; amount: bigint }
function debt(id: string, buyer: number, amount: bigint, date = '2026-09-10', opening = 0n, createdAt?: string): Debt {
  const company = companies[buyer];
  return { buyer, amount, opening, row: { id, date, createdAt, customerId: company.id, customer: company.name, supplierId: null, supplier: null, carrierId: null, carrier: null, product: null, liters: null, revenue: money(amount), cost: null, manager: null, sourceRow: 0, sourceSheet: 'Synthetic invariants', flags: [], fields: { date, customer_id: company.id, customer_inn: company.inn!, customer_amount: money(amount), paid_amount_source: money(opening), document_number: id, payment_form: 'б/нал' } } };
}
function credit(bankId: string, buyer: number, amount: bigint, date = '2026-09-01', provider: 'tbank' | 'sber' = 'tbank', account = provider === 'sber' ? SBER_ACCOUNT : accounts[0]): Credit {
  const connectionId = provider === 'sber' ? 'sber-nk-artel' : 'tbank-nk-artel';
  return { buyer, amount, row: { id: operationId(connectionId, account, bankId), provider, connectionId, bankOperationId: bankId, account, statementDate: date, bookedAt: `${date}T12:00:00Z`, amount: money(amount), currency: 'RUB', direction: 'incoming', booked: true, payer: { name: `Плательщик ${buyer}`, inn: inns[buyer] }, payee: { name: 'Собственная фирма', inn: SBER_INN }, bankData: {}, source: 'statement-api', updatedAt: '2026-09-16T00:00:00Z', counterpartyId: null, allocations: [], importedSourceIds: [] } };
}
function storeFor(receipts: Credit[]): OperationsData {
  return { schemaVersion: 1, sourceSha256: 'synthetic-settlements-invariants', revision: 0, shipments: {}, companies: [], paymentAllocations: [], banking: { ...emptyBanking(), operations: receipts.filter(entry => entry.row.provider === 'tbank').map(entry => entry.row) }, sber: { ...emptySber(), operations: receipts.filter(entry => entry.row.provider === 'sber').map(entry => entry.row) } };
}
const debtOrder = (a: Debt, b: Debt) => compare(a.row.date!, b.row.date!) || compare(a.row.createdAt ?? '', b.row.createdAt ?? '') || compare(a.row.id, b.row.id);
const creditOrder = (a: Credit, b: Credit) => compare(a.row.statementDate, b.row.statementDate) || compare(a.row.id, b.row.id);
const overlap = (a: bigint, aLength: bigint, b: bigint, bLength: bigint) => maximum(0n, minimum(a + aLength, b + bLength) - maximum(a, b));

function verify(debts: Debt[], credits: Credit[], label: string, catalog = companies) {
  const rows = debts.map(entry => entry.row), store = storeFor(credits), before = structuredClone({ rows, store, catalog });
  const result = buildSettlements(rows, catalog, store);
  assert.deepEqual({ rows, store, catalog }, before, `${label}: projection must not mutate source records`);
  const active = [...new Map(credits.filter(entry => entry.row.direction === 'incoming').map(entry => [entry.row.id, entry])).values()];
  const expectedTotals = { shipped: 0n, incoming: 0n, debt: 0n, advance: 0n, allocated: 0n };
  const expectedAllocations: { shipmentId: string; paymentId: string; amount: bigint; date: string }[] = [];
  let expectedCompanies = 0;
  for (let buyer = 0; buyer < inns.length; buyer++) {
    const shipments = debts.filter(entry => entry.buyer === buyer).sort(debtOrder);
    const receipts = active.filter(entry => entry.buyer === buyer).sort(creditOrder);
    const group = result.report.companies.find(entry => entry.inn === inns[buyer]);
    if (!shipments.length && !receipts.length) { assert.equal(group, undefined, `${label}: no fabricated firm balance`); continue; }
    expectedCompanies++;
    assert.ok(group, `${label}: buyer ${buyer} must exist`);
    assert.deepEqual(group.shipments.map(entry => entry.id), shipments.map(entry => entry.row.id), `${label}: stable shipment order`);
    assert.deepEqual(group.receipts.map(entry => entry.id), receipts.map(entry => entry.row.id), `${label}: stable receipt order`);
    const billed = sum(shipments.map(entry => entry.amount)), opening = sum(shipments.map(entry => entry.opening));
    const outstanding = billed - opening, incoming = sum(receipts.map(entry => entry.amount));
    const allocated = minimum(outstanding, incoming), remainingDebt = maximum(0n, outstanding - incoming), advance = maximum(0n, incoming - outstanding);
    for (const [field, value] of Object.entries({ shipped: billed, openingPaid: opening, incoming, allocated, debt: remainingDebt, advance })) {
      assert.equal(kopecks(group[field as keyof typeof group] as string), value, `${label}: buyer ${buyer} ${field}`);
    }
    assert.equal(kopecks(group.incoming), kopecks(group.allocated) + kopecks(group.advance), `${label}: firm funds conservation`);
    assert.equal(kopecks(group.shipped), kopecks(group.openingPaid) + kopecks(group.allocated) + kopecks(group.debt), `${label}: firm debt conservation`);
    expectedTotals.shipped += billed; expectedTotals.incoming += incoming; expectedTotals.allocated += allocated; expectedTotals.debt += remainingDebt; expectedTotals.advance += advance;
    for (const [index, shipment] of shipments.entries()) {
      const priorDebt = sum(shipments.slice(0, index).map(entry => entry.amount - entry.opening));
      const unpaid = shipment.amount - shipment.opening;
      const expectedPaid = maximum(0n, minimum(unpaid, incoming - priorDebt));
      const actual = group.shipments[index];
      assert.equal(kopecks(actual.bankPaid), expectedPaid, `${label}: FIFO amount for ${shipment.row.id}`);
      assert.equal(kopecks(actual.paid), shipment.opening + expectedPaid, `${label}: previous payments preserved`);
      assert.equal(kopecks(actual.debt), unpaid - expectedPaid, `${label}: remaining shipment debt`);
      assert.ok(kopecks(actual.paid) <= shipment.amount, `${label}: allocation cannot overpay a shipment`);
      if (expectedPaid > 0n) assert.ok(group.shipments.slice(0, index).every(entry => kopecks(entry.debt) === 0n), `${label}: later shipment only after all earlier debt is covered`);
    }
    for (const [index, receipt] of receipts.entries()) {
      const priorFunds = sum(receipts.slice(0, index).map(entry => entry.amount));
      const expected = shipments.flatMap((shipment, shipmentIndex) => {
        const priorDebt = sum(shipments.slice(0, shipmentIndex).map(entry => entry.amount - entry.opening));
        const amount = overlap(priorFunds, receipt.amount, priorDebt, shipment.amount - shipment.opening);
        return amount === 0n ? [] : [{ shipmentId: shipment.row.id, paymentId: receipt.row.id, amount, date: receipt.row.statementDate }];
      });
      const actual = group.receipts[index];
      assert.deepEqual(actual.allocations.map(entry => ({ ...entry, amount: kopecks(entry.amount) })), expected, `${label}: independent interval oracle for ${receipt.row.id}`);
      const used = sum(actual.allocations.map(entry => kopecks(entry.amount)));
      assert.equal(kopecks(actual.amount), receipt.amount);
      assert.equal(kopecks(actual.allocated), used, `${label}: receipt allocation sum`);
      assert.equal(kopecks(actual.allocated) + kopecks(actual.advance), receipt.amount, `${label}: receipt funds conservation`);
      assert.ok(actual.allocations.every(entry => entry.paymentId === receipt.row.id && shipments.some(shipment => shipment.row.id === entry.shipmentId)), `${label}: no allocation crosses an INN`);
      expectedAllocations.push(...expected);
    }
  }
  assert.equal(result.report.companies.length, expectedCompanies, `${label}: exact firm isolation`);
  for (const [field, amount] of Object.entries(expectedTotals)) assert.equal(kopecks(result.report.totals[field as keyof typeof expectedTotals]), amount, `${label}: total ${field}`);
  assert.equal(new Set(result.allocations.map(entry => entry.id)).size, result.allocations.length, `${label}: allocation identities are unique`);
  const allocationOrder = (a: { paymentId: string; shipmentId: string }, b: { paymentId: string; shipmentId: string }) => compare(a.paymentId, b.paymentId) || compare(a.shipmentId, b.shipmentId);
  assert.deepEqual(result.allocations.map(({ id: _id, ...entry }) => ({ ...entry, amount: kopecks(entry.amount) })).sort(allocationOrder), expectedAllocations.sort(allocationOrder), `${label}: report and returned allocations agree`);
  return result;
}

function dataset(seed: number) {
  const next = random(seed), debts: Debt[] = [], credits: Credit[] = [];
  for (let buyer = 0; buyer < inns.length; buyer++) {
    for (let index = 0, count = next(7); index < count; index++) {
      const amount = seed % 17 === 0 && index === 0 ? 900719925474099300n + BigInt(next(100)) : BigInt(next(1_000_001));
      const opening = minimum(amount, BigInt(next(100_001)));
      const date = `2026-09-${String(1 + next(9)).padStart(2, '0')}`;
      const created = next(3) ? `2026-09-16T${String(next(3)).padStart(2, '0')}:00:00Z` : undefined;
      debts.push(debt(`s-${seed}-${buyer}-${index}`, buyer, amount, date, opening, created));
    }
    for (let index = 0, count = next(7); index < count; index++) {
      const amount = seed % 17 === 0 && index === 0 ? 900719925474099301n : BigInt(1 + next(1_000_000));
      const date = next(2) ? `2026-09-${String(1 + next(9)).padStart(2, '0')}` : '2026-08-31';
      const provider = next(2) ? 'sber' : 'tbank';
      credits.push(credit(`p-${seed}-${buyer}-${index}`, buyer, amount, date, provider, provider === 'sber' ? SBER_ACCOUNT : accounts[next(accounts.length)]));
    }
  }
  return { debts, credits, next };
}

test('160 generated ledgers conserve each kopeck, obey FIFO and isolate four INNs across three input permutations', () => {
  assert.ok(inns.every(validInn), 'All synthetic customer INNs must pass validation');
  for (let seed = 1; seed <= 160; seed++) {
    const { debts, credits, next } = dataset(seed);
    const expected = verify(debts, credits, `seed ${seed}`);
    for (let permutation = 0; permutation < 3; permutation++) {
      const actual = verify(shuffled(debts, next), shuffled(credits, next), `seed ${seed}, permutation ${permutation}`, shuffled(companies, next));
      assert.deepEqual(actual, expected, `seed ${seed}: results and allocation IDs cannot depend on input order`);
    }
  }
});

test('splitting or combining receipts preserves total debt, advance and per-shipment payments for 40 ledgers', () => {
  for (let seed = 201; seed <= 240; seed++) {
    const { debts, credits } = dataset(seed);
    const expected = verify(debts, credits, `original ${seed}`);
    const combined = inns.flatMap((_, buyer) => {
      const amount = sum(credits.filter(entry => entry.buyer === buyer).map(entry => entry.amount));
      return amount > 0n ? [credit(`combined-${seed}-${buyer}`, buyer, amount)] : [];
    });
    const split = combined.flatMap(entry => {
      const first = entry.amount / 3n, second = entry.amount / 3n, third = entry.amount - first - second;
      return [first, second, third].flatMap((amount, index) => amount > 0n ? [credit(`split-${seed}-${entry.buyer}-${index}`, entry.buyer, amount, `2026-09-0${index + 1}`, index === 1 ? 'sber' : 'tbank')] : []);
    });
    for (const [name, rows] of [['combined', combined], ['split', split]] as const) {
      const result = verify(debts, rows, `${name} ${seed}`);
      assert.deepEqual(result.report.totals, expected.report.totals);
      assert.deepEqual(result.report.companies.map(group => group.shipments), expected.report.companies.map(group => group.shipments));
    }
  }
});

test('prepayments fund later shipments and reallocate to newly inserted backdated shipments without losing funds', () => {
  for (let seed = 301; seed <= 340; seed++) {
    const next = random(seed);
    const receipts = inns.map((_, buyer) => credit(`advance-${seed}-${buyer}`, buyer, BigInt(10_000 + next(50_000)), '2026-08-01', buyer % 2 ? 'sber' : 'tbank'));
    const prepaid = verify([], receipts, `prepayment ${seed}`);
    assert.equal(kopecks(prepaid.report.totals.debt), 0n);
    assert.equal(kopecks(prepaid.report.totals.allocated), 0n);
    const later = receipts.flatMap(entry => [debt(`later-${seed}-${entry.buyer}-1`, entry.buyer, entry.amount / 2n, '2026-09-10'), debt(`later-${seed}-${entry.buyer}-2`, entry.buyer, entry.amount, '2026-09-20')]);
    verify(later, receipts, `new shipments ${seed}`);
    const backdated = receipts.map(entry => debt(`backdated-${seed}-${entry.buyer}`, entry.buyer, entry.amount, '2026-08-20'));
    const result = verify([...later, ...backdated], receipts, `backdated ${seed}`);
    for (const group of result.report.companies) {
      assert.ok(group.shipments[0].id.startsWith('backdated-'));
      assert.equal(kopecks(group.shipments[0].debt), 0n);
      assert.ok(group.shipments.slice(1).every(row => kopecks(row.bankPaid) === 0n));
    }
  }
});

test('removed, amended and reclassified authoritative records rebuild balances for 40 generated ledgers', () => {
  for (let seed = 401; seed <= 440; seed++) {
    const { debts, credits } = dataset(seed);
    verify(debts, credits, `before corrections ${seed}`);
    const amended = credits.map((entry, index) => {
      if (index % 3 === 0) {
        const amount = entry.amount + 12345n;
        return { ...entry, amount, row: { ...entry.row, amount: money(amount) } };
      }
      if (index % 3 === 1) {
        const buyer = (entry.buyer + 1) % inns.length;
        return { ...entry, buyer, row: { ...entry.row, payer: { ...entry.row.payer, inn: inns[buyer] } } };
      }
      return { ...entry, row: { ...entry.row, direction: 'outgoing' as const, payer: { inn: SBER_INN }, payee: { inn: inns[entry.buyer] } } };
    });
    verify(debts, amended, `amended amount, INN and direction ${seed}`);
    verify(debts, amended.filter((_, index) => index % 2 === 0), `removed receipt ${seed}`);
    verify(debts.filter((_, index) => index % 2 === 0), amended, `removed shipment ${seed}`);
    const repriced = debts.map(entry => { const amount = entry.amount + 50000n; return { ...entry, amount, row: { ...entry.row, revenue: money(amount), fields: { ...entry.row.fields, customer_amount: money(amount) } } }; });
    verify(repriced, amended, `shipment repriced ${seed}`);
    assert.equal(kopecks(verify(debts, [], `all receipts removed ${seed}`).report.totals.incoming), 0n);
    assert.equal(kopecks(verify([], amended, `all shipments removed ${seed}`).report.totals.debt), 0n);
  }
});

test('replayed IDs count once, while identical bank operation IDs on other accounts or providers remain distinct', () => {
  const rows = [debt('one-shipment', 0, 10000n)];
  const receipts = [credit('same-bank-id', 0, 1000n, '2026-09-01', 'tbank', SBER_ACCOUNT), credit('same-bank-id', 0, 2000n, '2026-09-01', 'tbank', accounts[1]), credit('same-bank-id', 0, 3000n, '2026-09-01', 'sber', SBER_ACCOUNT)];
  assert.equal(new Set(receipts.map(entry => entry.row.id)).size, 3);
  const expected = verify(rows, receipts, 'separate bank identities');
  assert.equal(kopecks(expected.report.totals.incoming), 6000n);
  const next = random(92173);
  for (let replay = 1; replay <= 30; replay++) {
    const copies = Array.from({ length: replay }, () => structuredClone(receipts)).flat();
    const actual = verify(rows, shuffled(copies, next), `duplicate replay ${replay}`);
    assert.deepEqual(actual, expected, 'Replayed bank IDs cannot create extra money or change allocation identity');
  }
});

test('zero debts, fully paid shipments and exact settlement retain zero debt without using excess advance twice', () => {
  const rows = [debt('zero', 0, 0n), debt('already-paid', 0, 10000n, '2026-09-11', 10000n), debt('needs-payment', 0, 12345n, '2026-09-12')];
  const paid = verify(rows, [credit('exact-payment', 0, 12345n)], 'exact settlement');
  assert.equal(paid.report.totals.debt, '0'); assert.equal(paid.report.totals.advance, '0');
  assert.equal(paid.allocations.length, 1); assert.equal(paid.allocations[0].shipmentId, 'needs-payment');
  const excess = verify(rows, [credit('excess-payment', 0, 12346n)], 'one kopeck excess');
  assert.equal(kopecks(excess.report.totals.advance), 1n);
  const consumed = verify([...rows, debt('one-kopeck-shipment', 0, 1n, '2026-09-13')], [credit('excess-payment', 0, 12346n)], 'one kopeck advance consumed');
  assert.equal(consumed.report.totals.debt, '0'); assert.equal(consumed.report.totals.advance, '0');
  assert.deepEqual(verify([], [], 'empty ledger').report.totals, { shipped: '0', incoming: '0', debt: '0', advance: '0', allocated: '0' });
});

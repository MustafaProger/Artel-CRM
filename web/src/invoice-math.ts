// Exact input validation and preview from the standalone invoices app. Server remains authoritative.
export type Quantity = { numerator: string; denominator: string; display: string; exact: boolean };
/** Exact decimal values; limits protect input handling, not business rounding. */
export function normalizePositiveDecimal(value: string) {
  if (typeof value !== 'string') throw new Error('Введите положительное число.');
  const normalized = value.trim().replace(',', '.');
  if (!/^\d{1,18}(?:\.\d{1,12})?$/.test(normalized)) throw new Error('Введите положительное число: до 18 цифр и до 12 знаков после запятой.');
  const [whole, fraction = ''] = normalized.split('.');
  const integral = whole.replace(/^0+(?=\d)/, '');
  const decimal = fraction.replace(/0+$/, '');
  if (integral === '0' && !decimal) throw new Error('Число должно быть больше нуля.');
  return integral + (decimal ? `.${decimal}` : '');
}

function fraction(value: string): [bigint, bigint] {
  const [whole, decimal = ''] = normalizePositiveDecimal(value).split('.');
  return [BigInt(whole + decimal), 10n ** BigInt(decimal.length)];
}

const gcd = (a: bigint, b: bigint) => { while (b) [a, b] = [b, a % b]; return a; };

/** Does not round quantity. Repeating decimals retain their exact fraction. */
export function calculateQuantity(amount: string, unitPrice: string): Quantity {
  const [a, ad] = fraction(amount);
  const [p, pd] = fraction(unitPrice);
  const divisor = gcd(a * pd, ad * p);
  const numerator = a * pd / divisor;
  const denominator = ad * p / divisor;
  let finiteDenominator = denominator;
  for (const prime of [2n, 5n]) while (finiteDenominator % prime === 0n) finiteDenominator /= prime;
  const exact = finiteDenominator === 1n;
  let remainder = numerator % denominator;
  let decimal = '';
  while (remainder && (exact || decimal.length < 12)) {
    remainder *= 10n;
    decimal += String(remainder / denominator);
    remainder %= denominator;
  }
  const display = String(numerator / denominator) + (decimal ? `.${decimal}` : '') + (remainder ? '…' : '');
  return { numerator: String(numerator), denominator: String(denominator), display, exact };
}


/** Version 2 invoice preview. The worker independently verifies the same calculation. */
export type RoundedInvoiceCalculation = {
  version: 2; requestedAmount: string; unitPrice: string; exactQuantityDisplay: string;
  quantity: string; amount: string; difference: string;
  requestedAmountCents: string; unitPriceCents: string; amountCents: string; differenceCents: string;
  rounding: 'nearest-whole-litre-half-up';
};
const maxSafeCents = BigInt(Number.MAX_SAFE_INTEGER);
function moneyText(cents: bigint): string {
  const digits = String(cents < 0n ? -cents : cents).padStart(3, '0');
  return `${cents < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`;
}
function exactSerializableMoney(cents: bigint) {
  const text = moneyText(cents).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
  return cents <= maxSafeCents && Number.isFinite(Number(text)) && String(Number(text)) === text;
}
function moneyCents(value: string, label: string): bigint {
  const text = normalizePositiveDecimal(value);
  if (!/^\d+(?:\.\d{1,2})?$/.test(text)) throw new Error(`${label}: введите число с точкой или запятой, не более двух знаков после разделителя.`);
  const [whole, decimal = ''] = text.split('.');
  const cents = BigInt(whole) * 100n + BigInt(decimal.padEnd(2, '0'));
  if (cents <= 0n) throw new Error(`${label}: значение должно быть больше нуля.`);
  if (!exactSerializableMoney(cents)) throw new Error(`${label}: значение слишком велико для точной передачи в 1С.`);
  return cents;
}
export function calculateRoundedInvoice(amount: string, unitPrice: string): RoundedInvoiceCalculation {
  const requestedAmountCents = moneyCents(amount, 'Сумма');
  const unitPriceCents = moneyCents(unitPrice, 'Цена за литр');
  // Round the exact ratio once; never round a fractional litre preview first.
  const quantity = (requestedAmountCents * 2n + unitPriceCents) / (unitPriceCents * 2n);
  if (quantity === 0n) throw new Error('После округления получилось 0 л. Увеличьте сумму или уменьшите цену за литр.');
  const amountCents = quantity * unitPriceCents;
  if (!exactSerializableMoney(amountCents)) throw new Error('Итоговая сумма слишком велика для точной передачи в 1С.');
  const differenceCents = amountCents - requestedAmountCents;
  return {
    version: 2, requestedAmount: moneyText(requestedAmountCents), unitPrice: moneyText(unitPriceCents),
    exactQuantityDisplay: calculateQuantity(amount, unitPrice).display,
    quantity: String(quantity), amount: moneyText(amountCents),
    difference: `${differenceCents > 0n ? '+' : ''}${moneyText(differenceCents)}`,
    requestedAmountCents: String(requestedAmountCents), unitPriceCents: String(unitPriceCents),
    amountCents: String(amountCents), differenceCents: String(differenceCents), rounding: 'nearest-whole-litre-half-up',
  };
}

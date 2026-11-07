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


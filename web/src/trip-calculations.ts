import Decimal from 'decimal.js';

const Exact = Decimal.clone({ precision: 100 });

function amount(raw: string, label: string, positive: boolean) {
  if (typeof raw !== 'string') throw new Error(`${label}: укажите число.`);
  const normalized = raw.trim().replace(/[\s\u00a0\u202f]/g, '').replace(',', '.');
  if (!/^[+]?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized) || normalized.replace(/[^\d]/g, '').length > 40) throw new Error(`${label}: укажите корректное число.`);
  const value = new Exact(normalized);
  if (!value.isFinite() || (positive ? !value.gt(0) : value.lt(0))) throw new Error(`${label}: ${positive ? 'значение должно быть больше нуля' : 'значение не может быть отрицательным'}.`);
  return value;
}

/** Allocate integer units by largest remainder, so rounding never changes a truck total. */
function split(total: Decimal, weights: Decimal[], sum: Decimal, precision: number): string[] {
  const scale = new Exact(10).pow(precision);
  const totalUnits = total.times(scale);
  const shares = weights.map((weight, index) => {
    const exact = totalUnits.times(weight).div(sum);
    return { index, units: exact.floor(), remainder: exact.minus(exact.floor()) };
  });
  const remaining = totalUnits.minus(shares.reduce((value, share) => value.plus(share.units), new Exact(0))).toNumber();
  const byRemainder = [...shares].sort((a, b) => b.remainder.cmp(a.remainder) || a.index - b.index);
  for (let index = 0; index < remaining; index++) byRemainder[index].units = byRemainder[index].units.plus(1);
  return shares.map(share => share.units.div(scale).toFixed());
}

/** Whole-truck tonnes and expenses are distributed according to customer litres. */
export function allocateTrip(totalTonnes: string, litres: string[], additionalCosts = '0'): { totalLitres: string; tonnes: string[]; additionalCosts: string[] } {
  const total = amount(totalTonnes, 'Плановая масса груза', true);
  const costs = amount(additionalCosts, 'Дополнительные затраты', false);
  if (!Array.isArray(litres) || !litres.length || litres.length > 100) throw new Error('Добавьте от 1 до 100 клиентов.');
  const weights = litres.map((value, index) => amount(value, `Литры клиента ${index + 1}`, true));
  const totalLitres = weights.reduce((sum, value) => sum.plus(value), new Exact(0));
  const tonnes = split(total, weights, totalLitres, Math.max(6, total.decimalPlaces()));
  if (tonnes.some(value => new Exact(value).isZero())) throw new Error('Доля массы груза клиента слишком мала. Уточните массу груза или разбивку литров.');
  return { totalLitres: totalLitres.toFixed(), tonnes, additionalCosts: split(costs, weights, totalLitres, Math.max(2, costs.decimalPlaces())) };
}

/** New trips keep each measured delivery mass; only expenses retain the historic litres allocation. */
export function allocateMeasuredTrip(masses: (string | null)[], litres: string[], additionalCosts = '0') {
  const costs = amount(additionalCosts, 'Дополнительные затраты', false);
  if (!litres.length || litres.length > 100 || masses.length !== litres.length) throw new Error('Добавьте от 1 до 100 доставок.');
  const weights = litres.map((value, index) => amount(value, `Литры доставки ${index + 1}`, true));
  const totalLitres = weights.reduce((sum, value) => sum.plus(value), new Exact(0));
  if (masses.some(value => value === null) && masses.some(value => value !== null)) throw new Error('Массы всех доставок сохраняются одновременно.');
  const tonnes = masses.map((value, index) => value === null ? null : amount(value, `Масса доставки ${index + 1}`, true).toFixed());
  return { totalLitres: totalLitres.toFixed(), tonnes, totalTonnes: tonnes[0] === null ? null : tonnes.reduce((sum, value) => sum.plus(value!), new Exact(0)).toFixed(), additionalCosts: split(costs, weights, totalLitres, Math.max(2, costs.decimalPlaces())) };
}

import Decimal from 'decimal.js';
import type { ChinaData } from './china-model';

const Exact = Decimal.clone({ precision: 80 });
export const sumChinaAmounts = (values: string[]) => values.reduce((total, value) => total.plus(value), new Exact(0)).toFixed();
/** The running balance includes every receipt and every fuel entry, regardless of date. */
export function chinaTotals(china: ChinaData) {
  const payments = sumChinaAmounts(china.payments.map(payment => payment.amount));
  const fuel = sumChinaAmounts(china.days.flatMap(day => day.fuels.map(entry => entry.amount)));
  return { payments, fuel, balance: new Exact(payments).minus(fuel).toFixed() };
}

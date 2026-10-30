// Only the explicitly connected fuel contract; never the combined services total.
export const scope = Object.freeze({ companyId: '7d90c6ecc6804d738c19d1c1c0ab0aaa', contractId: '49844602', contractNumber: '43207794/25' });
export function money(value) {
  if (typeof value !== 'string' || !/^-?\d{1,13}(\.\d{1,2})?$/.test(value)) throw Error('schema');
  const [whole, fraction = ''] = value.replace('-', '').split('.');
  const minor = (BigInt(whole) * 100n + BigInt(fraction.padEnd(2, '0'))) * (value.startsWith('-') ? -1n : 1n);
  const result = Number(minor);
  if (!Number.isSafeInteger(result)) throw Error('schema');
  return result;
}
export function fuelBalance(data, companyId) {
  if (companyId !== scope.companyId) throw Error('scope');
  if (!Array.isArray(data?.contracts)) throw Error('schema');
  const matches = data.contracts.filter(c => c.contract_id === scope.contractId && c.external_id === scope.contractNumber);
  if (matches.length !== 1) throw Error('scope');
  const c = matches[0];
  if (c.currency !== 'RUB' || c.payment_type !== 'prepaid' || !Array.isArray(c.lst_groups) || c.lst_groups.length !== 1) throw Error('schema');
  const g = c.lst_groups[0];
  if (g.parent_contract_id !== scope.contractId || g.lst_group_code !== 'main' || JSON.stringify(g.services) !== '["tanker"]') throw Error('scope');
  const b = g.balances;
  const result = { amountMinor: money(b?.balance), availableMinor: money(b?.available_funds), currency: 'RUB' };
  if (money(c.balances?.total_lst_balances) !== result.amountMinor || money(c.balances?.available_funds) !== result.availableMinor) throw Error('schema');
  if (b.overdraft_limit !== undefined) result.overdraftLimitMinor = money(b.overdraft_limit);
  if (b.overdraft_balance !== undefined) result.overdraftAvailableMinor = money(b.overdraft_balance);
  return result;
}

import { bankConnections } from '../web/src/banking-model';
import { bankConfig } from '../server/banking/transport';

// Synthetic fixtures only. Never imported by the application or seeded into a real store.
export const accountNumber = '40702810000000000001';
export const dollarAccount = '40702840000000000002';
export const fixtureDay = '2026-09-14';
export const fixtureEnvironment = {
  ARTEL_BANK_SYNC_ENABLED: 'true',
  ARTEL_BANK_TBANK_NK_TOKEN: 'fixture-only-token', ARTEL_BANK_TBANK_NK_WEBHOOK_TOKEN: 'fixture-only-webhook',
  ARTEL_BANK_TBANK_NK_ACCOUNTS: JSON.stringify([{ number: accountNumber, currency: 'RUB' }, { number: dollarAccount, currency: 'USD' }]),
};
export const fixtureConfig = () => bankConfig(bankConnections.find(row => row.provider === 'tbank')!, fixtureEnvironment);
export function tbankRow(id = 'tbank-operation-1', amount = '0.1', account = accountNumber, direction = 'Credit') {
  return { operationId: id, operationDate: `${fixtureDay}T10:00:00Z`, operationStatus: 'Transaction', accountNumber: account, accountAmount: amount, operationAmount: '99999', accountCurrencyDigitalCode: account === dollarAccount ? '840' : '643', operationCurrencyDigitalCode: '978', typeOfOperation: direction, documentNumber: id.replace('tbank-operation-', ''), docDate: `${fixtureDay}T09:00:00Z`, payPurpose: `Оплата по договору ${id}. Тестовая выписка.`, payer: { name: 'Клиент тестовый', inn: '7812345678', kpp: '781201001', acct: '40702810000000000090', bankName: 'Банк плательщика', bicRu: '044525974', corAcct: '30101810000000000002' }, receiver: { name: 'НК АРТЕЛЬ — тест', inn: '7700000000', acct: account } };
}

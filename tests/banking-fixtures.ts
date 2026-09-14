import { bankConnections } from '../web/src/banking-model';
import { bankConfig } from '../server/banking/transport';

// Synthetic fixtures only. Never imported by the application or seeded into a real store.
export const accountNumber = '40702810000000000001';
export const dollarAccount = '40702840000000000002';
export const fixtureDay = '2026-09-14';
export const fixtureEnvironment = {
  ARTEL_BANK_ENCRYPTION_KEY: '1'.repeat(64), ARTEL_BANK_SYNC_ENABLED: 'true',
  ARTEL_BANK_TBANK_NK_TOKEN: 'fixture-only-token', ARTEL_BANK_TBANK_NK_WEBHOOK_TOKEN: 'fixture-only-webhook',
  ARTEL_BANK_TBANK_NK_ACCOUNTS: JSON.stringify([{ number: accountNumber, currency: 'RUB' }, { number: dollarAccount, currency: 'USD' }]),
  ...Object.fromEntries(['ARTEL_BANK_SBER_NK', 'ARTEL_BANK_SBER_ARTEL'].flatMap(prefix => Object.entries({ ACCOUNTS: JSON.stringify([{ number: accountNumber, currency: 'RUB' }]), CLIENT_ID: 'fixture-client', CLIENT_SECRET: 'fixture-secret', REFRESH_TOKEN: 'fixture-refresh', TLS_CERT_PATH: '/fixture/not-a-real-certificate', TLS_KEY_PATH: '/fixture/not-a-real-key' }).map(([key, value]) => [`${prefix}_${key}`, value]))),
};
export const fixtureConfig = (provider: 'sber' | 'tbank' = 'tbank') => bankConfig(bankConnections.find(row => row.provider === provider)!, fixtureEnvironment);
export function sberRow(id = 'sber-operation-1', amount = '123456.78') {
  return { operationId: id, uuid: '00000000-0000-0000-0000-000000000001', amount: { amount, currencyName: 'RUB' }, direction: 'DEBIT', number: '42', documentDate: fixtureDay, operationDate: `${fixtureDay}T10:00:00`, paymentPurpose: 'Оплата топлива. В том числе НДС 20%.', rurTransfer: { payerName: 'НК АРТЕЛЬ — тест', payerAccount: accountNumber, payerInn: '7700000000', payeeName: 'ООО «КОМПЛЕКС — ОЙЛ» — тест', payeeInn: '7800000000', payeeKpp: '780001001', payeeAccount: '40702810000000000099', payeeBankBic: '044525225', payeeBankName: 'Банк получателя — тест', payeeBankCorrAccount: '30101810000000000001', departmentalInfo: { uip: 'test-uip', kbk: 'test-kbk' } } };
}
export function tbankRow(id = 'tbank-operation-1', amount = '0.1', account = accountNumber, direction = 'Credit') {
  return { operationId: id, operationDate: `${fixtureDay}T10:00:00Z`, operationStatus: 'Transaction', accountNumber: account, accountAmount: amount, operationAmount: '99999', accountCurrencyDigitalCode: account === dollarAccount ? '840' : '643', operationCurrencyDigitalCode: '978', typeOfOperation: direction, documentNumber: id.replace('tbank-operation-', ''), docDate: `${fixtureDay}T09:00:00Z`, payPurpose: `Оплата по договору ${id}. Тестовая выписка.`, payer: { name: 'Клиент тестовый', inn: '7812345678', kpp: '781201001', acct: '40702810000000000090', bankName: 'Банк плательщика', bicRu: '044525974', corAcct: '30101810000000000002' }, receiver: { name: 'НК АРТЕЛЬ — тест', inn: '7700000000', acct: account } };
}

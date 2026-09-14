import type { BankAccount, BankOperation, BankParty } from '../../web/src/banking-model';
import { ApiError } from '../api-error';
import { cleanBankData, exactAmount, nextDay, object, operationId, str, validDate } from './domain';
import type { BankConfig, BankRequest } from './transport';

export interface StatementPage { operations: BankOperation[]; nextCursor?: string }
export interface BankAdapter {
  page(config: BankConfig, token: string, account: BankAccount, day: string, cursor?: string): Promise<StatementPage>
  detail(config: BankConfig, token: string, row: BankOperation): Promise<BankOperation>
  print(config: BankConfig, token: string, row: BankOperation): Promise<Buffer>
}
const isoCurrency = (value: string) => ({ '643': 'RUB', '810': 'RUB', '840': 'USD', '978': 'EUR', '156': 'CNY', '398': 'KZT', '933': 'BYN', '784': 'AED' }[value] ?? value);
function normalized(config: BankConfig, account: BankAccount, day: string, raw: unknown, provider: 'sber' | 'tbank'): BankOperation {
  const r = object(raw), sber = provider === 'sber';
  const bankId = str(sber ? r.operationId : r.operationId);
  const direction = sber ? r.direction : r.typeOfOperation;
  if (!bankId || !['DEBIT','CREDIT','Debit','Credit'].includes(String(direction)) || !validDate(day) || r.accountNumber && r.accountNumber !== account.number) throw new ApiError(502, 'Неполные идентификаторы, счёт или направление операции в ответе банка. Страница не сохранена.');
  const amount = sber ? object(r.amount).amount : r.accountAmount;
  const currency = str(sber ? object(r.amount).currencyName : r.accountCurrencyDigitalCode);
  if (!currency) throw new ApiError(502, 'Банк не передал валюту суммы. Страница не сохранена.');
  const transfer = object(r.rurTransfer), cur = object(r.curTransfer), swift = object(r.swiftTransfer);
  const sberParty = (prefix: 'payer' | 'payee'): BankParty => ({ name: str(transfer[`${prefix}Name`]), inn: str(transfer[`${prefix}Inn`]), kpp: str(transfer[`${prefix}Kpp`]), account: str(transfer[`${prefix}Account`]), bankName: str(transfer[`${prefix}BankName`]), bic: str(transfer[`${prefix}BankBic`]), correspondentAccount: str(transfer[`${prefix}BankCorrAccount`]) });
  const tParty = (value: unknown): BankParty => { const p = object(value); return { name: str(p.name), inn: str(p.inn), kpp: str(p.kpp), account: str(p.acct), bankName: str(p.bankName), bic: str(p.bicRu) ?? str(p.bicSwift), correspondentAccount: str(p.corAcct) }; };
  const payer = sber ? sberParty('payer') : tParty(r.payer), payee = sber ? sberParty('payee') : tParty(r.receiver);
  if (sber && !r.rurTransfer) {
    const t = r.curTransfer ? cur : swift;
    Object.assign(payer, { name: str(t.orderingCustomerName), account: str(t.orderingCustomerAccount), bankName: str(t.orderingInstitutionName) });
    Object.assign(payee, { name: str(t.beneficiaryCustomerName), account: str(t.beneficiaryCustomerAccount), bankName: str(t.beneficiaryBankName) });
  }
  return {
    id: operationId(config.definition.id, account.number, bankId), connectionId: config.definition.id, provider, bankOperationId: bankId,
    account: account.number, statementDate: day, documentNumber: str(sber ? r.number : r.documentNumber), documentDate: str(sber ? r.documentDate : r.docDate), bookedAt: str(r.operationDate),
    direction: direction === 'CREDIT' || direction === 'Credit' ? 'incoming' : 'outgoing', amount: exactAmount(amount), currency: isoCurrency(currency),
    status: sber ? undefined : str(r.operationStatus), booked: sber || r.operationStatus === 'Transaction', purpose: str(sber ? r.paymentPurpose : r.payPurpose),
    payer, payee, bankData: object(cleanBankData(r)), source: 'statement-api', updatedAt: new Date().toISOString(), counterpartyId: null, allocations: [], importedSourceIds: [],
  };
}
export const normalizeSber = (config: BankConfig, account: BankAccount, day: string, raw: unknown) => normalized(config, account, day, raw, 'sber');
export const normalizeTbank = (config: BankConfig, account: BankAccount, day: string, raw: unknown) => normalized(config, account, day, raw, 'tbank');
function pdf(value: unknown) {
  if (typeof value !== 'string' || value.length > 16 * 1024 * 1024) throw new ApiError(502, 'Банк не предоставил печатную форму PDF.');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new ApiError(502, 'Банк вернул неподдерживаемый формат печатной формы.');
  return buffer;
}
export function sberAdapter(http: BankRequest): BankAdapter {
  return {
    async page(config, token, account, day, cursor = '1') {
      const path = '/fintech/api/v2/statement/transactions';
      const params = new URLSearchParams({ accountNumber: account.number, statementDate: day, page: cursor, curFormat: 'curTransfer' });
      const body = object(await http(config, `${path}?${params}`, token));
      if (!Array.isArray(body.transactions)) throw new ApiError(502, 'СберБизнес не вернул список операций выписки.');
      let nextCursor: string | undefined;
      if (body._links !== undefined && !Array.isArray(body._links)) throw new ApiError(502, 'Некорректная пагинация СберБизнеса.');
      const link = (body._links as unknown[] | undefined)?.map(object).find(link => link.rel === 'next');
      if (link) {
        const url = new URL(String(link.href), `https://fintech.sberbank.ru:9443${path}`);
        nextCursor = url.searchParams.get('page') ?? undefined;
        if (!nextCursor || !/^\d+$/.test(nextCursor) || Number(nextCursor) !== Number(cursor) + 1 || url.origin !== 'https://fintech.sberbank.ru:9443' || url.pathname !== path || url.searchParams.get('accountNumber') !== account.number || url.searchParams.get('statementDate') !== day) throw new ApiError(502, 'Некорректная следующая страница СберБизнеса.');
      }
      return { operations: body.transactions.map(raw => normalizeSber(config, account, day, raw)), nextCursor };
    },
    async detail(config, token, row) {
      const params = new URLSearchParams({ id: row.bankOperationId, accountNumber: row.account, operationDate: row.statementDate });
      const raw = await http(config, `/fintech/api/v2/statement/transactionId?${params}`, token);
      const result = normalizeSber(config, { number: row.account, currency: row.currency }, row.statementDate, raw);
      if (result.id !== row.id) throw new ApiError(502, 'Банк вернул другой идентификатор операции. Выполните сверку выписки.');
      return { ...result, detailsFetchedAt: new Date().toISOString() };
    },
    async print(config, token, row) {
      const params = new URLSearchParams({ id: row.bankOperationId, accountNumber: row.account, operationDate: row.statementDate, format: 'PDF' });
      return pdf(object(await http(config, `/fintech/api/v2/statement/transactionId/print?${params}`, token)).file);
    },
  };
}
export function tbankAdapter(http: BankRequest): BankAdapter {
  return {
    async page(config, token, account, day, cursor) {
      // Inclusive Moscow calendar dates are converted to the API's UTC [from,to) interval.
      const params = new URLSearchParams({ accountNumber: account.number, from: new Date(`${day}T00:00:00+03:00`).toISOString(), to: new Date(`${nextDay(day)}T00:00:00+03:00`).toISOString(), operationStatus: 'Transaction', limit: '1000', ...(cursor ? { cursor } : {}) });
      const body = object(await http(config, `/openapi/api/v1/statement?${params}`, token));
      if (!Array.isArray(body.operations)) throw new ApiError(502, 'Т-Банк не вернул список операций выписки.');
      if (body.operations.some(raw => object(raw).operationStatus !== 'Transaction')) throw new ApiError(502, 'Т-Банк вернул неподтверждённые операции вместо запрошенных транзакций. Страница не сохранена.');
      const nextCursor = str(body.nextCursor);
      if (nextCursor && (nextCursor === cursor || nextCursor.length > 100)) throw new ApiError(502, 'Некорректная следующая страница Т-Банка.');
      return { operations: body.operations.map(raw => normalizeTbank(config, account, day, raw)), nextCursor };
    },
    // The statement is the detailed account-operation resource; never query created payment orders as movements.
    async detail(_config, _token, row) { return row; },
    async print(config, token, row) {
      if (!row.booked || !row.bookedAt) throw new ApiError(409, 'Печатная форма доступна только для подтверждённой операции с датой проведения.');
      const params = new URLSearchParams({ accountNumber: row.account, operationId: row.bankOperationId, operationDate: row.bookedAt.slice(0, 10) });
      return pdf(object(await http(config, `/openapi/api/v1/payment-document?${params}`, token)).fileData);
    },
  };
}

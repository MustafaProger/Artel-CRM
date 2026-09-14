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
export function normalizeTbank(config: BankConfig, account: BankAccount, day: string, raw: unknown): BankOperation {
  const r = object(raw);
  const bankId = str(r.operationId);
  const direction = r.typeOfOperation;
  if (!bankId || !['DEBIT','CREDIT','Debit','Credit'].includes(String(direction)) || !validDate(day) || r.accountNumber && r.accountNumber !== account.number) throw new ApiError(502, 'Неполные идентификаторы, счёт или направление операции в ответе банка. Страница не сохранена.');
  const amount = r.accountAmount;
  const currency = str(r.accountCurrencyDigitalCode);
  if (!currency) throw new ApiError(502, 'Банк не передал валюту суммы. Страница не сохранена.');
  const tParty = (value: unknown): BankParty => { const p = object(value); return { name: str(p.name), inn: str(p.inn), kpp: str(p.kpp), account: str(p.acct), bankName: str(p.bankName), bic: str(p.bicRu) ?? str(p.bicSwift), correspondentAccount: str(p.corAcct) }; };
  const payer = tParty(r.payer), payee = tParty(r.receiver);
  return {
    id: operationId(config.definition.id, account.number, bankId), connectionId: config.definition.id, provider: 'tbank', bankOperationId: bankId,
    account: account.number, statementDate: day, documentNumber: str(r.documentNumber), documentDate: str(r.docDate), bookedAt: str(r.operationDate),
    direction: direction === 'CREDIT' || direction === 'Credit' ? 'incoming' : 'outgoing', amount: exactAmount(amount), currency: isoCurrency(currency),
    status: str(r.operationStatus), booked: r.operationStatus === 'Transaction', purpose: str(r.payPurpose),
    payer, payee, bankData: object(cleanBankData(r)), source: 'statement-api', updatedAt: new Date().toISOString(), counterpartyId: null, allocations: [], importedSourceIds: [],
  };
}
function pdf(value: unknown) {
  if (typeof value !== 'string' || value.length > 16 * 1024 * 1024) throw new ApiError(502, 'Банк не предоставил печатную форму PDF.');
  const buffer = Buffer.from(value, 'base64');
  if (buffer.subarray(0, 5).toString() !== '%PDF-') throw new ApiError(502, 'Банк вернул неподдерживаемый формат печатной формы.');
  return buffer;
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

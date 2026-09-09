import type { Company } from '../web/src/model';
import { ApiError } from './api-error';

const record = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const text = (value: unknown): string | null => typeof value === 'string' && value.trim() ? value.trim() : null;

export function validInn(inn: string): boolean {
  if (!/^\d{10}(?:\d{2})?$/.test(inn) || /^0+$/.test(inn)) return false;
  const digit = (weights: number[]) => weights.reduce((sum, weight, index) => sum + weight * Number(inn[index]), 0) % 11 % 10;
  return inn.length === 10
    ? digit([2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[9])
    : digit([7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[10]) && digit([3, 7, 2, 4, 10, 3, 5, 9, 4, 6, 8]) === Number(inn[11]);
}

/** Official methods: checko.ru/integration/api/company and /entrepreneur. */
export async function lookupCheckoCompany(inn: string, apiKey: string | undefined, fetcher: typeof fetch = fetch): Promise<Company> {
  if (!apiKey?.trim()) throw new ApiError(503, 'Для добавления по ИНН настройте CHECKO_API_KEY на сервере.');
  let payload: unknown;
  try {
    // The key is sent in the POST body, never in a URL, client response, or log.
    const response = await fetcher(`https://api.checko.ru/v2/${inn.length === 12 ? 'entrepreneur' : 'company'}`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({ key: apiKey, inn }).toString(), signal: AbortSignal.timeout(12_000), redirect: 'error',
    });
    if ([401, 403].includes(response.status)) throw new ApiError(502, 'Чекко отклонил доступ к API. Проверьте API-ключ и права доступа.');
    if (response.status === 429) throw new ApiError(502, 'Чекко ограничил частоту запросов. Повторите попытку позже.');
    if (!response.ok) throw new ApiError(502, 'Чекко временно недоступен. Повторите попытку позже.');
    if (Number(response.headers.get('content-length')) > 2 * 1024 * 1024) throw new Error('Response too large');
    const reader = response.body?.getReader();
    if (!reader) throw new Error('Empty provider response');
    let size = 0;
    const parts: Uint8Array[] = [];
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 2 * 1024 * 1024) { await reader.cancel(); throw new Error('Response too large'); }
      parts.push(value);
    }
    payload = JSON.parse(Buffer.concat(parts).toString('utf8'));
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) throw new ApiError(502, 'Чекко не ответил за 12 секунд. Проверьте подключение и повторите попытку.');
    throw new ApiError(502, 'Не удалось подключиться к Чекко или прочитать ответ. Проверьте соединение и повторите попытку.');
  }
  const root = record(payload);
  const meta = record(root?.meta);
  if (meta?.status !== 'ok') throw new ApiError(502, 'Чекко не вернул сведения. Проверьте доступ к API, лимит запросов и ИНН.');
  const data = record(root?.data);
  if (!data || !Object.keys(data).length) throw new ApiError(404, 'Организация или ИП с таким ИНН не найдены в Чекко.');
  if (data['ИНН'] !== inn) throw new ApiError(502, 'Чекко вернул сведения для другого ИНН; организация не добавлена.');
  const fullName = inn.length === 12 ? text(data['ФИО']) : text(data['НаимПолн']);
  const name = inn.length === 12 ? fullName && `ИП ${fullName}` : text(data['НаимСокр']) ?? fullName;
  if (!name) throw new ApiError(502, 'В ответе Чекко отсутствует наименование; организация не добавлена.');
  const location = record(data['ЮрАдрес']) ?? record(data['Адрес']);
  return {
    id: `company-inn-${inn}`, name, fullName, inn,
    kpp: text(data['КПП']), ogrn: text(data[inn.length === 12 ? 'ОГРНИП' : 'ОГРН']),
    address: text(location?.['АдресРФ']) ?? text(location?.['НасПункт']) ?? text(data['Адрес']) ?? text(data['НасПункт']),
    status: text(record(data['Статус'])?.['Наим']), registrySource: 'checko', registryCheckedAt: new Date().toISOString(),
    roles: [], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [],
  };
}

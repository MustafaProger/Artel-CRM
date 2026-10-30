import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { CabinetConnection } from '../web/src/cabinet-model';
const companyId = '7d90c6ecc6804d738c19d1c1c0ab0aaa', contractId = '49844602', contractNumber = '43207794/25';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const time = (v: unknown, now: number): v is string => typeof v === 'string' && /^\d{4}-\d\d-\d\dT/.test(v) && Number.isFinite(Date.parse(v)) && Date.parse(v) <= now + 60_000;
const base = (): CabinetConnection => ({ id: 'yandex-server-fuel', provider: 'yandex', label: 'НК АРТЭЛЬ · Заправки', createdAt: '2026-10-27T00:00:00.000Z', state: 'error', refreshMode: 'server_browser' });
export function yandexBrowserConnection(value: unknown, now = Date.now()): CabinetConnection {
  const invalid = () => ({ ...base(), error: 'Не удалось проверить данные Яндекса. Требуется проверка серверного подключения.' });
  if (!object(value) || value.version !== 1 || value.companyId !== companyId || value.contractId !== contractId || value.contractNumber !== contractNumber
    || !['connected', 'error', 'auth_required'].includes(String(value.state)) || !time(value.createdAt, now) || !time(value.lastAttemptAt, now)
    || Date.parse(value.createdAt) > Date.parse(value.lastAttemptAt)) return invalid();
  const connection: CabinetConnection = { ...base(), createdAt: value.createdAt, lastAttemptAt: value.lastAttemptAt, state: value.state as CabinetConnection['state'] };
  if (value.balance !== undefined || value.lastSuccessAt !== undefined) {
    const b = value.balance;
    if (!object(b) || !time(value.lastSuccessAt, now) || Date.parse(value.lastSuccessAt) > Date.parse(value.lastAttemptAt) || Date.parse(value.lastSuccessAt) < Date.parse(value.createdAt)
      || b.currency !== 'RUB' || !Number.isSafeInteger(b.amountMinor) || !Number.isSafeInteger(b.availableMinor)
      || ['overdraftLimitMinor', 'overdraftAvailableMinor'].some(k => b[k] !== undefined && !Number.isSafeInteger(b[k]))) return invalid();
    connection.lastSuccessAt = value.lastSuccessAt;
    const details: { label: string; amountMinor: number }[] = [];
    if (b.availableMinor !== b.amountMinor) details.push({ label: 'Доступно по договору', amountMinor: b.availableMinor as number });
    if (b.overdraftLimitMinor !== undefined) details.push({ label: 'Лимит отсрочки', amountMinor: b.overdraftLimitMinor as number });
    if (b.overdraftAvailableMinor !== undefined) details.push({ label: 'Доступная отсрочка', amountMinor: b.overdraftAvailableMinor as number });
    connection.accounts = [{ id: 'yandex:' + contractId, supplier: 'Яндекс Заправки', organization: 'ООО НК АРТЭЛЬ', contract: contractNumber,
      amountMinor: b.amountMinor as number, currency: 'RUB', balanceLabel: 'Собственные средства', ...(details.length ? { details } : {}) }];
  }
  if (connection.state === 'connected' && !connection.accounts) return invalid();
  if (connection.state === 'auth_required') connection.error = 'Требуется повторный вход в Яндекс на сервере. Попросите администратора подтвердить вход. Показан последний полученный остаток.';
  else if (connection.state === 'error') connection.error = 'Не удалось обновить остаток Яндекса. Сервер повторит попытку автоматически. Показан последний полученный остаток.';
  else if (!connection.lastSuccessAt || now - Date.parse(connection.lastSuccessAt) > 600_000) {
    connection.state = 'error'; connection.error = 'Обновление Яндекса задерживается. Показан последний полученный остаток; требуется проверка серверного подключения.';
  }
  return connection;
}
export async function readYandexBrowserBalance(path?: string): Promise<CabinetConnection | null> {
  if (!path) return null;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 16_384) return yandexBrowserConnection(null);
      return yandexBrowserConnection(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : yandexBrowserConnection(null);
  }
}

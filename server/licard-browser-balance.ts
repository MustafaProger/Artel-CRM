import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { CabinetConnection } from '../web/src/cabinet-model';

const contract = 'RU260007461';
const createdAt = '2026-11-16T00:00:00.000Z';

export function licardBrowserConnection(value: unknown, now = Date.now()): CabinetConnection {
  const connection: CabinetConnection = {
    id: 'licard-server-fuel', provider: 'licard', label: 'НК АРТЭЛЬ', createdAt,
    state: 'error', refreshMode: 'server_browser',
  };
  const invalid = { ...connection, error: 'Не удалось проверить данные ЛУКОЙЛ.' };
  if (!value || typeof value !== 'object') return invalid;
  const snapshot = value as Record<string, unknown>;
  const time = (date: unknown): date is string => typeof date === 'string'
    && /^\d{4}-\d{2}-\d{2}T/.test(date) && Date.parse(date) >= Date.parse(createdAt) && Date.parse(date) <= now + 60_000;
  const { state, lastAttemptAt, lastSuccessAt, amountMinor } = snapshot;
  if (snapshot.version !== 1 || snapshot.contract !== contract || !time(lastAttemptAt)
    || (state !== 'connected' && state !== 'error' && state !== 'auth_required')) return invalid;
  connection.lastAttemptAt = lastAttemptAt;
  connection.state = state;
  if (lastSuccessAt !== undefined || amountMinor !== undefined) {
    if (!time(lastSuccessAt) || Date.parse(lastSuccessAt) > Date.parse(lastAttemptAt)
      || typeof amountMinor !== 'number' || !Number.isSafeInteger(amountMinor)) return invalid;
    connection.lastSuccessAt = lastSuccessAt;
    connection.accounts = [{
      id: 'licard:' + contract, supplier: 'ЛУКОЙЛ', organization: 'ООО НК АРТЭЛЬ',
      contract, amountMinor, currency: 'RUB', balanceLabel: 'Баланс по договору',
    }];
  }
  if (state === 'auth_required') connection.error = 'Администратору нужно повторно войти в ЛИКАРД на сервере.';
  else if (state === 'error') connection.error = 'Не удалось обновить баланс ЛУКОЙЛ. Сервер повторит попытку.';
  else if (!connection.lastSuccessAt) return invalid;
  else if (now - Date.parse(connection.lastSuccessAt) > 600_000) {
    connection.state = 'error';
    connection.error = 'Обновление ЛУКОЙЛ задерживается. Показан последний полученный баланс.';
  }
  return connection;
}

export async function readLicardBrowserBalance(path?: string): Promise<CabinetConnection | null> {
  if (!path) return null;
  try {
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await file.stat();
      if (!info.isFile() || info.size > 16_384) return licardBrowserConnection(null);
      return licardBrowserConnection(JSON.parse(await file.readFile('utf8')));
    } finally { await file.close(); }
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT' ? null : licardBrowserConnection(null);
  }
}

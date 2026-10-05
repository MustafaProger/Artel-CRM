import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { AccountUser } from '../web/src/auth-model';
import type { Driver, Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { passwordFields, type StoredUser } from './auth';

export interface DriverAccess {
  driverId: string; userId: string | null; login: string | null; active: boolean; version: number;
  status: 'not-issued' | 'active' | 'revoked'; loginUrl: string;
}
const loginUrl = 'https://artel-crm.online/';
function activeDriver(snapshot: Snapshot, id: string): Driver {
  const row = snapshot.directories?.drivers.find(driver => driver.id === id);
  const flags = row as (Driver & { archived?: boolean; directoryArchived?: boolean; deletedAt?: string }) | undefined;
  if (!row || !row.name?.trim() || snapshot.directories?.deletedEntries?.drivers?.includes(id) || flags?.archived || flags?.directoryArchived || flags?.deletedAt) throw new ApiError(404, 'Действующий водитель не найден.');
  return row;
}
function linkedUser(data: OperationsData, driverId: string) {
  return data.accounts?.users.find(user => user.role === 'driver' && user.driverId === driverId);
}
export function readDriverAccess(data: OperationsData, snapshot: Snapshot, driverId: string): DriverAccess {
  activeDriver(snapshot, driverId);
  const user = linkedUser(data, driverId);
  return { driverId, userId: user?.id ?? null, login: user?.login ?? null, active: !!user?.active && !user.deletedAt,
    version: user?.version ?? 0, status: !user ? 'not-issued' : user.active && !user.deletedAt ? 'active' : 'revoked', loginUrl };
}
function invalidateSessions(data: OperationsData, user: StoredUser) {
  data.accounts!.sessions = data.accounts!.sessions.filter(session => session.userId !== user.id);
  if (data.push) data.push.devices = data.push.devices.filter(device => device.userId !== user.id);
}
/** Used inside the same OperationsStore transaction as the version/identity check. */
export async function mutateDriverAccess(data: OperationsData, snapshot: Snapshot, driverId: string, method: string, input: Record<string, unknown>) {
  const driver = activeDriver(snapshot, driverId);
  const fields = method === 'POST' ? ['version', 'action', 'password'] : ['version', 'active'];
  if (Object.keys(input).some(key => !fields.includes(key)) || !Number.isSafeInteger(input.version) || Number(input.version) < 0) throw new ApiError(400, 'Передайте текущую версию доступа водителя.');
  if (method === 'POST' && !['issue', 'reset'].includes(String(input.action)) || method === 'PATCH' && input.active !== false) throw new ApiError(400, 'Выберите выдачу, смену пароля или отключение доступа.');
  const accounts = data.accounts;
  if (!accounts?.users.some(user => user.active && !user.deletedAt && user.role === 'director')) throw new ApiError(409, 'Сначала настройте учётную запись директора.');
  const previous = linkedUser(data, driverId);
  if (input.version !== (previous?.version ?? 0)) throw new ApiError(409, 'Доступ уже изменён. Обновите сведения о доступе.');
  // Tombstoned accounts are never restored or replaced by another account.
  if (previous?.deletedAt) throw new ApiError(409, 'Учётная запись удалена; автоматическое восстановление запрещено.');
  if (method === 'PATCH') {
    if (!previous || !previous.active) return { access: readDriverAccess(data, snapshot, driverId), changed: false };
    previous.active = false; previous.version++; invalidateSessions(data, previous);
    return { access: readDriverAccess(data, snapshot, driverId), changed: true };
  }
  if (input.action === 'issue' && previous) return { access: readDriverAccess(data, snapshot, driverId), changed: false };
  // Omission requests generation; an explicitly supplied value must pass the
  // same password policy as employee accounts (including empty/invalid input).
  const candidate = Object.hasOwn(input, 'password') ? input.password : randomBytes(24).toString('base64url');
  const credentials = await passwordFields(candidate);
  const temporaryPassword = candidate as string; // Validated by passwordFields.
  if (previous) {
    Object.assign(previous, credentials, { active: true, version: previous.version + 1 });
    invalidateSessions(data, previous);
  } else {
    let login = `driver.${createHash('sha256').update(driverId).digest('hex').slice(0, 16)}`;
    // Employee logins and existing password hashes are never modified to resolve a collision.
    while (accounts.users.some(user => user.login === login)) login = `driver.${randomBytes(12).toString('hex')}`;
    accounts.users.push({ ...credentials, id: `user-${randomUUID()}`, driverId, name: driver.fullName || driver.name, login,
      role: 'driver', managerId: null, sections: [], active: true, version: 1 });
  }
  return { access: readDriverAccess(data, snapshot, driverId), temporaryPassword, changed: true };
}

/** Explicit maintenance entry point: return one-time secrets only for new accounts.
 * Caller must use OperationsStore.mutate and put the result only in a private owner delivery file.
 * Re-running never rotates an existing password, revives access or returns existing credentials. */
export async function createMissingDriverAccounts(data: OperationsData, snapshot: Snapshot) {
  const created: { driverId: string; name: string; login: string; temporaryPassword: string; loginUrl: string }[] = [];
  let skipped = 0;
  for (const driver of snapshot.directories?.drivers ?? []) {
    try { activeDriver(snapshot, driver.id); } catch { skipped++; continue; }
    if (linkedUser(data, driver.id)) { skipped++; continue; }
    const issued = await mutateDriverAccess(data, snapshot, driver.id, 'POST', { version: 0, action: 'issue' });
    if (issued.temporaryPassword) created.push({ driverId: driver.id, name: driver.fullName || driver.name, login: issued.access.login!, temporaryPassword: issued.temporaryPassword, loginUrl });
  }
  return { created, skipped, changed: created.length > 0 };
}

/** Closed driver boundary, run before ANY application route including bank/auth routers. */
export function requireDriverRoute(actor: AccountUser, path: string, method: string) {
  if (actor.role !== 'driver') return;
  if (path === '/api/auth/session' && method === 'GET' || ['/api/auth/login', '/api/auth/logout'].includes(path) && method === 'POST') return;
  if (/^\/api\/driver\/trips(?:\/[^/]+)?$/.test(path) && method === 'GET') return;
  if (['/api/push/config', '/api/push/test-status'].includes(path) && method === 'GET' || path === '/api/push/subscription' && ['POST', 'DELETE'].includes(method) || path === '/api/push/test' && method === 'POST') return;
  throw new ApiError(403, 'Водителю доступен только просмотр своих рейсов.');
}

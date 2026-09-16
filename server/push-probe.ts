import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError } from './api-error';
import type { OperationsData, OperationsStorage } from './operations-store';
import type { PushDevice } from './push';

const probeLifetime = 300000;
const probeRetention = 3600000;
const tokenHash = (token: string) => createHash('sha256').update(token).digest('hex');
const validId = (id: unknown): id is string => typeof id === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(id);

export function createPushProbe(data: OperationsData, device: PushDevice, now = Date.now()) {
  const push = data.push ??= { devices: [], deliveries: {} };
  const probes = push.probes ??= {};
  for (const [id, probe] of Object.entries(probes)) if (probe.expiresAt < now - probeRetention) delete probes[id];
  if (Object.keys(probes).length >= 1000) throw new ApiError(429, 'Слишком много проверок уведомлений. Повторите позже.');
  const probeId = randomUUID(), token = randomBytes(32).toString('base64url');
  probes[probeId] = { userId: device.userId, deviceId: device.id, tokenHash: tokenHash(token), createdAt: now, expiresAt: now + probeLifetime };
  return { probeId, token };
}

export function readPushProbe(data: OperationsData, probeId: unknown, userId: string, now = Date.now()) {
  const probe = validId(probeId) ? data.push?.probes?.[probeId] : undefined;
  if (!probe || probe.userId !== userId) throw new ApiError(404, 'Проверка уведомления не найдена.');
  return {
    probeId,
    status: probe.notificationCreatedAt !== undefined ? 'confirmed' : now >= probe.expiresAt ? 'expired' : 'pending',
    providerAcceptedAt: probe.providerAcceptedAt ?? null,
    notificationCreatedAt: probe.notificationCreatedAt ?? null,
    expiresAt: probe.expiresAt,
  };
}

export function markPushProbeAccepted(data: OperationsData, probeId: string, now = Date.now()) {
  const probe = data.push?.probes?.[probeId];
  if (!probe || probe.providerAcceptedAt !== undefined) return false;
  probe.providerAcceptedAt = now;
  return true;
}

export function acceptPushProbeReceipt(data: OperationsData, body: Record<string, unknown>, now = Date.now()) {
  if (Object.keys(body).some(key => key !== 'probeId' && key !== 'token') || !validId(body.probeId) || typeof body.token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(body.token)) throw new ApiError(400, 'Некорректное подтверждение уведомления.');
  const probe = data.push?.probes?.[body.probeId];
  const actualHash = Buffer.from(tokenHash(body.token), 'hex');
  const expectedHash = Buffer.from(probe?.tokenHash ?? '0'.repeat(64), 'hex');
  if (!timingSafeEqual(actualHash, expectedHash) || !probe) throw new ApiError(404, 'Подтверждение уведомления не найдено.');
  if (now >= probe.expiresAt) throw new ApiError(410, 'Срок подтверждения уведомления истёк.');
  // The token has one effect; retries during its lifetime do not alter the receipt timestamp.
  if (probe.notificationCreatedAt !== undefined) return false;
  probe.notificationCreatedAt = now;
  return true;
}

/** Persist receipt/provider results across unrelated optimistic storage conflicts, without resending. */
export async function mutatePushProbe<T>(store: OperationsStorage, source: string, update: (data: OperationsData) => { result: T; changed: boolean }) {
  for (let attempt = 0; ; attempt++) {
    try { return await store.mutate(source, update); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409 || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Bound anonymous receipt traffic before reading or mutating durable storage. */
export function createPushReceiptLimiter() {
  const windows = new Map<string, { since: number; count: number }>();
  return (address: string, now = Date.now()) => {
    for (const [key, window] of windows) if (now - window.since >= 60000) windows.delete(key);
    const window = windows.get(address);
    if (!window) {
      if (windows.size >= 1000) throw new ApiError(429, 'Слишком много подтверждений. Повторите позже.');
      windows.set(address, { since: now, count: 1 });
    } else if (++window.count > 60) throw new ApiError(429, 'Слишком много подтверждений. Повторите позже.');
  };
}

import { createHash, ECDH, randomUUID, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import webPush from 'web-push';
import { ApiError } from './api-error';
import { sessionToken } from './auth';
import type { OperationsData, OperationsStorage } from './operations-store';

export interface PushDevice {
  id: string; userId: string; sessionHash: string; endpoint: string;
  keys: { p256dh: string; auth: string }; createdAt: number; testAt?: number;
}
interface Delivery { deviceId: string; at: number; attempts: number; retryAt: number; lease?: string; sent?: boolean }
export interface PushData { devices: PushDevice[]; deliveries: Record<string, Delivery>; lastRunAt?: number }
export interface PushConfig { publicKey: string; privateKey: string; subject: string; schedule: boolean }
export type PushSender = (device: PushDevice, payload: string, config: PushConfig) => Promise<unknown>;
export const pushConfig = (): PushConfig => ({ publicKey: process.env.VAPID_PUBLIC_KEY ?? '', privateKey: process.env.VAPID_PRIVATE_KEY ?? '', subject: process.env.VAPID_SUBJECT ?? '', schedule: process.env.PUSH_SCHEDULE_ENABLED === 'true' });
export const pushReady = (config: PushConfig) => !!(config.publicKey && config.privateKey && config.subject && config.schedule);
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const pushSessionHash = (request: IncomingMessage) => hash(sessionToken(request) ?? '');
export function validCron(request: IncomingMessage, secret = process.env.CRON_SECRET) {
  const actual = request.headers.authorization ?? '';
  const expected = `Bearer ${secret}`;
  return !!secret && secret.length >= 32 && Buffer.byteLength(actual) === Buffer.byteLength(expected) && timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}
// Only browser push services may receive server requests; arbitrary URLs are rejected.
export function validPushEndpoint(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 4096) return false;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port && !url.hash && (
      url.hostname === 'fcm.googleapis.com' || url.hostname === 'updates.push.services.mozilla.com' ||
      url.hostname === 'web.push.apple.com' || url.hostname.endsWith('.push.apple.com') ||
      url.hostname === 'wns.windows.com' || url.hostname.endsWith('.notify.windows.com'));
  } catch { return false; }
}
const validKey = (key: unknown, bytes: number): key is string => typeof key === 'string' && /^[\w-]+$/.test(key) && Buffer.from(key, 'base64url').length === bytes && Buffer.from(key, 'base64url').toString('base64url') === key;
export function parseSubscription(value: unknown) {
  const row = value as Partial<PushDevice> | null;
  if (!row || !validPushEndpoint(row.endpoint) || !validKey(row.keys?.p256dh, 65) || !validKey(row.keys?.auth, 16)) throw new ApiError(400, 'Некорректная подписка устройства.');
  try { ECDH.convertKey(Buffer.from(row.keys.p256dh, 'base64url'), 'prime256v1'); } catch { throw new ApiError(400, 'Некорректный ключ устройства.'); }
  return { endpoint: row.endpoint, keys: { p256dh: row.keys.p256dh, auth: row.keys.auth } };
}
export function validatePush(value: PushData | undefined) {
  if (value === undefined) return;
  if (!value || !Array.isArray(value.devices) || value.devices.length > 1000 || !value.deliveries || typeof value.deliveries !== 'object' || Array.isArray(value.deliveries)) throw new Error('Invalid push storage');
  const ids = new Set(), endpoints = new Set();
  for (const device of value.devices) {
    parseSubscription(device);
    if (!device.id || ids.has(device.id) || endpoints.has(device.endpoint) || typeof device.userId !== 'string' || !device.userId || !/^[a-f0-9]{64}$/.test(device.sessionHash) || !Number.isSafeInteger(device.createdAt) || device.testAt !== undefined && !Number.isSafeInteger(device.testAt)) throw new Error('Invalid push device');
    ids.add(device.id); endpoints.add(device.endpoint);
  }
  if (value.lastRunAt !== undefined && !Number.isSafeInteger(value.lastRunAt)) throw new Error('Invalid push heartbeat');
  for (const [key, row] of Object.entries(value.deliveries)) {
    if (!/^[a-f0-9]{64}$/.test(key) || !row || typeof row.deviceId !== 'string' || !Number.isSafeInteger(row.at) || !Number.isSafeInteger(row.retryAt) || !Number.isSafeInteger(row.attempts) || row.attempts < 1 || row.lease !== undefined && typeof row.lease !== 'string' || row.sent !== undefined && typeof row.sent !== 'boolean') throw new Error('Invalid push delivery');
  }
}
export function subscribe(data: OperationsData, value: unknown, userId: string, sessionHash: string) {
  const subscription = parseSubscription(value);
  const push = data.push ??= { devices: [], deliveries: {} };
  const previous = push.devices.find(device => device.endpoint === subscription.endpoint);
  if (previous?.userId === userId && previous.sessionHash === sessionHash && JSON.stringify(previous.keys) === JSON.stringify(subscription.keys)) return false;
  if (!previous && (push.devices.length >= 1000 || push.devices.filter(device => device.userId === userId).length >= 10)) throw new ApiError(409, 'Достигнут лимит устройств для уведомлений. Отключите неиспользуемое устройство.');
  if (previous) push.devices = push.devices.filter(device => device.id !== previous.id);
  // Preserve delivery identity on re-login, but never transfer another account's deliveries.
  push.devices.push({ ...subscription, id: previous?.userId === userId ? previous.id : randomUUID(), userId, sessionHash, createdAt: previous?.userId === userId ? previous.createdAt : Date.now() });
  return true;
}
export function unsubscribe(data: OperationsData, endpoint: unknown, userId: string) {
  if (!validPushEndpoint(endpoint)) throw new ApiError(400, 'Некорректная подписка устройства.');
  const before = data.push?.devices.length ?? 0;
  if (data.push) data.push.devices = data.push.devices.filter(device => device.endpoint !== endpoint || device.userId !== userId);
  return before !== (data.push?.devices.length ?? 0);
}
export const sendPush: PushSender = (device, payload, config) => webPush.sendNotification(device, payload, {
  vapidDetails: { publicKey: config.publicKey, privateKey: config.privateKey, subject: config.subject },
  TTL: 3600, urgency: 'high', timeout: 5000,
});
function candidates(data: OperationsData, now: number) {
  const rows = [...(data.work?.tasks ?? []).map(row => ({ ...row, kind: 'tasks' })), ...(data.work?.companyRecords ?? []).map(row => ({ ...row, kind: 'companies' }))];
  return rows.filter(row => row.reminderAt && Date.parse(row.reminderAt) <= now && !row.archivedAt && (!('status' in row) || row.status !== 'done') && data.accounts?.users.some(user => user.id === row.assigneeId && user.active));
}
const deliveryKey = (kind: string, id: string, reminderAt: string, deviceId: string) => hash(`${kind}:${id}:${reminderAt}:${deviceId}`);
async function mutatePush<T>(store: OperationsStorage, source: string, update: (data: OperationsData) => { result: T; changed: boolean }) {
  for (let attempt = 0; ; attempt++) {
    try { return await store.mutate(source, update); }
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409 || attempt >= 4) throw error;
      await new Promise(resolve => setTimeout(resolve, 50 * (attempt + 1)));
    }
  }
}

/** Claim in durable storage before network I/O. Concurrent invocations cannot send the same claim. */
export async function dispatchReminders(store: OperationsStorage, source: string, config: PushConfig, sender = sendPush, now = Date.now()) {
  if (!pushReady(config)) throw new ApiError(503, 'Отправка уведомлений ещё не настроена.');
  const lease = randomUUID();
  const claimed = await mutatePush(store, source, data => {
    const push = data.push ??= { devices: [], deliveries: {} };
    push.lastRunAt = now;
    const pending: { key: string; device: PushDevice; kind: string; id: string; reminderAt: string }[] = [];
    const relevant = new Set<string>();
    for (const row of candidates(data, now)) for (const device of push.devices.filter(device => device.userId === row.assigneeId)) {
      const key = deliveryKey(row.kind, row.id, row.reminderAt!, device.id);
      relevant.add(key);
      const previous = push.deliveries[key];
      if (pending.length >= 20 || previous?.sent || previous && previous.retryAt > now) continue;
      push.deliveries[key] = { deviceId: device.id, at: now, attempts: (previous?.attempts ?? 0) + 1, retryAt: now + 120000, lease };
      pending.push({ key, device: { ...device }, kind: row.kind, id: row.id, reminderAt: row.reminderAt! });
    }
    for (const key of Object.keys(push.deliveries)) if (!relevant.has(key) && push.deliveries[key].at < now - 86400000) delete push.deliveries[key];
    return { result: pending, changed: true };
  });
  const results: { key: string; deviceId: string; sent: boolean; expired: boolean; cancelled: boolean }[] = [];
  for (let offset = 0; offset < claimed.length; offset += 5) {
    const current = await store.read(source);
    await Promise.all(claimed.slice(offset, offset + 5).map(async item => {
      const available = current.push?.devices.some(device => device.id === item.device.id && device.userId === item.device.userId) && candidates(current, now).some(row => row.id === item.id && row.kind === item.kind && row.assigneeId === item.device.userId && row.reminderAt === item.reminderAt);
      if (!available) { results.push({ key: item.key, deviceId: item.device.id, sent: false, expired: false, cancelled: true }); return; }
      try {
        await sender(item.device, JSON.stringify({ title: 'Артель CRM', body: 'Напоминание по задаче. Откройте CRM, чтобы посмотреть подробности.', tag: item.key, url: `/?workKind=${item.kind}&workId=${encodeURIComponent(item.id)}#work` }), config);
        results.push({ key: item.key, deviceId: item.device.id, sent: true, expired: false, cancelled: false });
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode;
        results.push({ key: item.key, deviceId: item.device.id, sent: false, expired: status === 404 || status === 410, cancelled: false });
      }
    }));
  }
  if (results.length) await mutatePush(store, source, data => {
    for (const result of results) {
      const delivery = data.push?.deliveries[result.key];
      if (!delivery || delivery.lease !== lease) continue;
      if (result.cancelled || result.expired) delete data.push!.deliveries[result.key];
      else { delivery.sent = result.sent; delete delivery.lease; delivery.retryAt = now + Math.min(3600000, 60000 * 2 ** Math.min(delivery.attempts, 6)); }
      if (result.expired) data.push!.devices = data.push!.devices.filter(device => device.id !== result.deviceId);
    }
    return { result: null, changed: true };
  });
  return { checked: claimed.length, sent: results.filter(row => row.sent).length, failed: results.filter(row => !row.sent && !row.cancelled && !row.expired).length, expired: results.filter(row => row.expired).length };
}

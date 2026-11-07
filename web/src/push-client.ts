export interface PushCapabilityInput {
  secureContext: boolean; serviceWorker: boolean; pushManager: boolean; notification: boolean;
  permission?: string; userAgent?: string; platform?: string; maxTouchPoints?: number; standalone?: boolean;
}
const pushFeatures = ['secureContext', 'serviceWorker', 'pushManager', 'notification'] as const;
type PushFeature = typeof pushFeatures[number];
interface PushCapabilities {
  secureContext: boolean; serviceWorker: boolean; pushManager: boolean; notification: boolean;
  supported: boolean; missing: PushFeature[]; permission: NotificationPermission | 'unavailable';
  ios: boolean; installed: boolean; browserName: string; browserVersion: string;
}
const pushFeatureLabels: Record<PushFeature, string> = {
  secureContext: 'Защищённое открытие', serviceWorker: 'Service Worker', pushManager: 'Push API', notification: 'Notifications API',
};
/** Keep only capability flags and recognised browser/version tokens, never the full user agent or page URL. */
export function inspectPushCapabilities(input: PushCapabilityInput): PushCapabilities {
  const agent = (input.userAgent ?? '').slice(0, 1024);
  const browserPatterns: [string, RegExp][] = [
    ['Huawei Browser', /HuaweiBrowser\/([\d.]+)/i], ['Samsung Internet', /SamsungBrowser\/([\d.]+)/i],
    ['Edge', /(?:EdgA|EdgiOS|Edg)\/([\d.]+)/i], ['Firefox', /(?:Firefox|FxiOS)\/([\d.]+)/i],
    ['Chrome', /(?:Chrome|CriOS)\/([\d.]+)/i], ['Safari', /Version\/([\d.]+).*Safari\//i],
  ];
  const matched = browserPatterns.find(([, pattern]) => pattern.test(agent));
  const browserName = matched?.[0] ?? 'Не определён';
  const browserVersion = matched?.[1].exec(agent)?.[1].slice(0, 32) ?? '';
  const features = {
    secureContext: input.secureContext === true, serviceWorker: input.serviceWorker === true,
    pushManager: input.pushManager === true, notification: input.notification === true,
  };
  const missing = pushFeatures.filter(feature => !features[feature]);
  return {
    ...features, supported: missing.length === 0, missing,
    permission: !features.notification ? 'unavailable' : input.permission === 'granted' || input.permission === 'denied' ? input.permission : 'default',
    ios: /iPad|iPhone|iPod/.test(agent) || input.platform === 'MacIntel' && (input.maxTouchPoints ?? 0) > 1,
    installed: input.standalone === true, browserName, browserVersion,
  };
}
export function readPushCapabilities() {
  return inspectPushCapabilities({
    secureContext: window.isSecureContext, serviceWorker: 'serviceWorker' in navigator,
    pushManager: 'PushManager' in window, notification: 'Notification' in window,
    permission: 'Notification' in window ? Notification.permission : undefined,
    userAgent: navigator.userAgent, platform: navigator.platform, maxTouchPoints: navigator.maxTouchPoints,
    standalone: matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone,
  });
}
export function formatPushDiagnostics(capabilities: ReturnType<typeof inspectPushCapabilities>) {
  const permissions = { granted: 'разрешено', denied: 'запрещено', default: 'не предоставлено', unavailable: 'API отсутствует' };
  return [
    'Проверка уведомлений Артэль CRM',
    `Браузер: ${capabilities.browserName}${capabilities.browserVersion ? ` ${capabilities.browserVersion}` : ''}`,
    `Открытие: ${capabilities.installed ? 'с отдельного значка приложения' : 'в браузере'}`,
    ...pushFeatures.map(feature => `${pushFeatureLabels[feature]}: ${capabilities[feature] ? 'доступно' : 'недоступно'}`),
    `Разрешение: ${permissions[capabilities.permission]}`,
    'Доставка на телефон этой проверкой не подтверждается.',
  ].join('\n');
}
export const pushSupported = () => readPushCapabilities().supported;
let registration: Promise<ServiceWorkerRegistration> | undefined;
let subscriptionRequest: { publicKey: string; promise: Promise<PushSubscription> } | undefined;
export function waitForPush<T>(operation: Promise<T>, milliseconds: number, message: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error(message)), milliseconds);
    operation.then(value => { window.clearTimeout(timer); resolve(value); }, error => { window.clearTimeout(timer); reject(error); });
  });
}
export function registerPushWorker() {
  registration ??= navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(() => navigator.serviceWorker.ready).catch(error => { registration = undefined; throw error; });
  return waitForPush(registration, 15000, 'Браузер не завершил подготовку уведомлений за 15 секунд. Повторите проверку подключения.');
}
export function subscribePushDevice(worker: ServiceWorkerRegistration, publicKey: string) {
  // A native subscribe operation cannot be cancelled. Keep it after a UI timeout
  // so a retry waits for that operation instead of starting another subscription.
  if (subscriptionRequest && subscriptionRequest.publicKey !== publicKey) throw new Error('Предыдущее подключение ещё выполняется. Повторите проверку позже.');
  if (!subscriptionRequest) {
    const promise = worker.pushManager.getSubscription().then(current => current ?? worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(publicKey) }));
    subscriptionRequest = { publicKey, promise };
    const clear = () => { if (subscriptionRequest?.promise === promise) subscriptionRequest = undefined; };
    void promise.then(clear, clear);
  }
  return waitForPush(subscriptionRequest.promise, 25000, 'Браузер не завершил подключение за 25 секунд. Повторите проверку подключения позже.');
}
export async function pushRequest(path: string, method = 'GET', body?: unknown, accountId?: string) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/push/${path}`, { method, cache: 'no-store', signal: controller.signal, headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(accountId ? { 'X-Artel-Account': accountId } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw Object.assign(new Error(result.error || 'Не удалось настроить уведомления.'), { status: response.status });
    return result;
  } catch (error) {
    if (controller.signal.aborted) throw new Error('Сервер не ответил за 15 секунд. Результат действия пока не подтверждён; повторите проверку.', { cause: error });
    throw error;
  } finally { window.clearTimeout(timer); }
}
export async function disconnectPushDevice() {
  if ('serviceWorker' in navigator) {
    const worker = await navigator.serviceWorker.getRegistration('/');
    await (await worker?.pushManager.getSubscription())?.unsubscribe();
  }
}
export async function currentPushEndpoint() {
  if (!('serviceWorker' in navigator)) return null;
  const worker = await navigator.serviceWorker.getRegistration('/');
  return (await worker?.pushManager.getSubscription())?.endpoint ?? null;
}
export function applicationKey(value: string) {
  const decoded = atob(value.replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(decoded, char => char.charCodeAt(0));
}

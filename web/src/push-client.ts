export const pushSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
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
export async function pushRequest(path: string, method = 'GET', body?: unknown) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), 15000);
  try {
    const response = await fetch(`/api/push/${path}`, { method, cache: 'no-store', signal: controller.signal, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || 'Не удалось настроить уведомления.');
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

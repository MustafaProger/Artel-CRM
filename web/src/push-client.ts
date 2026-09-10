export const pushSupported = () => window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
let registration: Promise<ServiceWorkerRegistration> | undefined;
export function registerPushWorker() {
  registration ??= navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' }).then(() => navigator.serviceWorker.ready);
  return registration.catch(error => { registration = undefined; throw error; });
}
export async function pushRequest(path: string, method = 'GET', body?: unknown) {
  const response = await fetch(`/api/push/${path}`, { method, cache: 'no-store', ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось настроить уведомления.');
  return result;
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

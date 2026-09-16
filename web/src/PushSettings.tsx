import { useEffect, useState } from 'react';
import { applicationKey, pushRequest, pushSupported, registerPushWorker, subscribePushDevice, waitForPush } from './push-client';

interface Config { enabled: boolean; publicKey: string; lastRunAt: number | null; intervalSeconds: number }
export default function PushSettings({ userId }: { userId: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [probeId, setProbeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [permission, setPermission] = useState(() => 'Notification' in window ? Notification.permission : 'default');
  const supported = pushSupported();
  const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1;
  const installed = matchMedia('(display-mode: standalone)').matches || !!(navigator as Navigator & { standalone?: boolean }).standalone;
  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const result: Config = await pushRequest('config');
        if (cancelled) return;
        setConfig(result);
        if (!supported) return;
        const worker = await registerPushWorker();
        let current = await waitForPush(worker.pushManager.getSubscription(), 15000, 'Браузер не ответил при проверке подключения уведомлений. Повторите проверку позже.');
        if (cancelled) return;
        // A VAPID key change invalidates existing subscriptions.
        if (current && result.publicKey && current.options.applicationServerKey && new Uint8Array(current.options.applicationServerKey).toString() !== applicationKey(result.publicKey).toString()) { await current.unsubscribe(); current = null; }
        if (current && Notification.permission === 'granted' && result.enabled) await pushRequest('subscription', 'POST', { subscription: current.toJSON() });
        if (!cancelled) setSubscription(current);
      } catch (reason) { if (!cancelled) setError((reason as Error).message); }
    }
    void load();
    return () => { cancelled = true; };
  }, [userId, supported]);
  useEffect(() => {
    const controller = new AbortController();
    let inFlight = false;
    async function refreshConfig() {
      if (document.visibilityState !== 'visible' || inFlight) return;
      inFlight = true;
      try {
        const response = await fetch('/api/push/config', { cache: 'no-store', signal: controller.signal });
        if (response.ok) {
          const result: Config = await response.json();
          if (!controller.signal.aborted) setConfig(result);
        }
      } catch { /* Keep the last known configuration during temporary outages. */ }
      finally { inFlight = false; }
    }
    const refresh = () => void refreshConfig();
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { controller.abort(); window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
  }, [userId]);
  useEffect(() => {
    if (!probeId) return;
    const controller = new AbortController();
    let retry: number | undefined;
    const unconfirmed = () => {
      setNotice('Проверка отправлена, но браузер пока не подтвердил получение. Проверьте разрешения и подключение устройства.');
      setProbeId(null);
    };
    const deadline = window.setTimeout(() => { controller.abort(); unconfirmed(); }, 60000);
    async function check() {
      try {
        const response = await fetch(`/api/push/test-status?probeId=${encodeURIComponent(probeId!)}`, { cache: 'no-store', signal: controller.signal });
        const result = await response.json();
        if (controller.signal.aborted) return;
        if (!response.ok) {
          setError(result.error || 'Не удалось проверить получение уведомления.');
          unconfirmed();
          return;
        }
        if (result.probeId !== probeId) throw new Error('Unexpected notification check');
        if (result.status === 'confirmed' && typeof result.notificationCreatedAt === 'number') {
          setNotice('Браузер получил тестовое уведомление.');
          setProbeId(null);
          return;
        }
        if (result.status === 'expired') { unconfirmed(); return; }
      } catch {
        if (controller.signal.aborted) return;
        // Retry only the read-only status request, never the push itself.
      }
      retry = window.setTimeout(() => void check(), 3000);
    }
    void check();
    return () => { controller.abort(); window.clearTimeout(deadline); window.clearTimeout(retry); };
  }, [probeId]);
  async function action(kind: 'enable' | 'disable' | 'test') {
    if (busy) return;
    setBusy(true); setError(''); setNotice(''); setProbeId(null);
    try {
      if (kind === 'enable') {
        // Must be called directly from the click, before other asynchronous work (iOS).
        setNotice('Разрешите уведомления в запросе браузера.');
        const permissionRequest = Notification.permission === 'granted' ? Promise.resolve(Notification.permission) : Notification.requestPermission();
        const granted = await waitForPush(permissionRequest, 30000, 'Браузер пока не завершил запрос разрешения. Ответьте на него и повторите подключение.');
        setPermission(granted);
        if (granted !== 'granted') throw new Error(granted === 'denied' ? 'Уведомления запрещены. Разрешите их в настройках браузера или устройства.' : 'Разрешение не получено. Нажмите «Включить уведомления» ещё раз.');
        setNotice('Готовим уведомления в браузере…');
        const worker = await registerPushWorker();
        setNotice('Браузер подключает устройство к уведомлениям…');
        const current = await subscribePushDevice(worker, config!.publicKey);
        setNotice('Сохраняем подключение устройства…');
        await pushRequest('subscription', 'POST', { subscription: current.toJSON() });
        setSubscription(current);
        setNotice('Уведомления включены для ваших задач и работы с компаниями.');
      } else if (kind === 'disable' && subscription) {
        await pushRequest('subscription', 'DELETE', { endpoint: subscription.endpoint });
        await waitForPush(subscription.unsubscribe(), 15000, 'Сервер отключил уведомления, но браузер пока не завершил отключение. Повторите проверку позже.');
        setSubscription(null); setNotice('Уведомления на этом устройстве выключены.');
      } else if (subscription) {
        const result = await pushRequest('test', 'POST', { endpoint: subscription.endpoint });
        if (typeof result.probeId === 'string' && result.probeId) {
          setProbeId(result.probeId);
          setNotice('Сервис принял проверку. Ожидаем подтверждение браузера…');
        } else setNotice('Сервис принял проверку. Получение браузером пока не подтверждено.');
      }
    } catch (reason) {
      setNotice('');
      setError(reason instanceof DOMException ? 'Браузер не смог подключить уведомления. Проверьте разрешения для CRM в браузере и настройках устройства, затем повторите попытку.' : (reason as Error).message);
    }
    finally { setBusy(false); }
  }
  const intervalSeconds = config?.intervalSeconds ?? 300;
  const intervalLabel = intervalSeconds === 30 ? 'каждые 30 секунд, пока сервер CRM запущен' : intervalSeconds === 60 ? 'каждую минуту' : intervalSeconds === 300 ? 'каждые 5 минут' : `каждые ${intervalSeconds} секунд`;
  return <div className="work-push-settings">
    {ios && !installed ? <p>На iPhone/iPad откройте меню «Поделиться» → «На экран Домой», запустите CRM с её значка и включите уведомления здесь.</p> : !supported ? <p>Этот браузер не поддерживает Web Push. Откройте CRM в браузере с поддержкой уведомлений.</p> : <>
      <p>{subscription ? 'Уведомления на этом устройстве включены.' : 'Получайте уведомления о назначении задач и напоминания, даже когда CRM закрыта.'}</p>
      {config && !config.enabled && <p>Серверная отправка ещё не настроена.</p>}
      {config?.enabled && config.lastRunAt && Date.now() - config.lastRunAt > 20 * 60000 && <p role="status">Проверка напоминаний задерживается. Последняя проверка: {new Date(config.lastRunAt).toLocaleString('ru-RU')}.</p>}
      {permission === 'denied' && <p>Разрешите уведомления для CRM в настройках браузера или устройства.</p>}
      <div className="work-push-actions">{subscription ? <><button className="button" disabled={busy || !!probeId || !config?.enabled} onClick={() => void action('test')}>Проверить уведомление</button><button className="button" disabled={busy} onClick={() => void action('disable')}>Выключить</button></> : <button className="button" disabled={busy || !config?.enabled || permission === 'denied'} onClick={() => void action('enable')}>{busy ? 'Подключение…' : 'Включить уведомления'}</button>}</div>
      <p>Когда другой сотрудник назначает вам задачу, уведомление отправляется сразу после сохранения. Для задач себе уведомление приходит по времени напоминания. Проверка напоминаний — {intervalLabel}; возможна задержка доставки.</p>
    </>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>;
}

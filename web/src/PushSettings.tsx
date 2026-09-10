import { useEffect, useState } from 'react';
import { applicationKey, pushRequest, pushSupported, registerPushWorker } from './push-client';

interface Config { enabled: boolean; publicKey: string; lastRunAt: number | null; intervalSeconds: number }
export default function PushSettings({ userId }: { userId: string }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
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
        let current = await worker.pushManager.getSubscription();
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
  async function action(kind: 'enable' | 'disable' | 'test') {
    if (busy) return;
    setBusy(true); setError(''); setNotice('');
    try {
      if (kind === 'enable') {
        // Must be called directly from the click, before other asynchronous work (iOS).
        const granted = await Notification.requestPermission();
        setPermission(granted);
        if (granted !== 'granted') throw new Error(granted === 'denied' ? 'Уведомления запрещены. Разрешите их в настройках браузера или устройства.' : 'Разрешение не получено. Нажмите «Включить уведомления» ещё раз.');
        const worker = await registerPushWorker();
        const current = await worker.pushManager.getSubscription() ?? await worker.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: applicationKey(config!.publicKey) });
        await pushRequest('subscription', 'POST', { subscription: current.toJSON() });
        setSubscription(current);
        setNotice('Уведомления включены для ваших задач и работы с компаниями.');
      } else if (kind === 'disable' && subscription) {
        await pushRequest('subscription', 'DELETE', { endpoint: subscription.endpoint });
        await subscription.unsubscribe();
        setSubscription(null); setNotice('Уведомления на этом устройстве выключены.');
      } else if (subscription) {
        await pushRequest('test', 'POST', { endpoint: subscription.endpoint });
        setNotice('Проверка отправлена. Проверьте уведомления устройства.');
      }
    } catch (reason) {
      setError(reason instanceof DOMException ? 'Браузер не смог подключить уведомления. Проверьте разрешения для CRM в браузере и настройках устройства, затем повторите попытку.' : (reason as Error).message);
    }
    finally { setBusy(false); }
  }
  return <div className="work-push-settings">
    {ios && !installed ? <p>На iPhone/iPad откройте меню «Поделиться» → «На экран Домой», запустите CRM с её значка и включите уведомления здесь.</p> : !supported ? <p>Этот браузер не поддерживает Web Push. Откройте CRM в браузере с поддержкой уведомлений.</p> : <>
      <p>{subscription ? 'Уведомления на этом устройстве включены.' : 'Получайте напоминания, даже когда CRM закрыта.'}</p>
      {config && !config.enabled && <p>Серверная отправка ещё не настроена.</p>}
      {config?.enabled && config.lastRunAt && Date.now() - config.lastRunAt > 20 * 60000 && <p role="status">Проверка напоминаний задерживается. Последняя проверка: {new Date(config.lastRunAt).toLocaleString('ru-RU')}.</p>}
      {permission === 'denied' && <p>Разрешите уведомления для CRM в настройках браузера или устройства.</p>}
      <div className="work-push-actions">{subscription ? <><button className="button" disabled={busy || !config?.enabled} onClick={() => void action('test')}>Проверить уведомление</button><button className="button" disabled={busy} onClick={() => void action('disable')}>Выключить</button></> : <button className="button" disabled={busy || !config?.enabled || permission === 'denied'} onClick={() => void action('enable')}>{busy ? 'Подключение…' : 'Включить уведомления'}</button>}</div>
      <p>Напоминания отправляются назначенному сотруднику. Проверка по расписанию — {config?.intervalSeconds === 30 ? 'каждые 30 секунд, пока сервер CRM запущен' : 'каждые 5 минут'}; возможна задержка доставки.</p>
    </>}
    {error && <p role="alert">{error}</p>}{notice && <p role="status">{notice}</p>}
  </div>;
}

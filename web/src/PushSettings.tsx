import { useEffect, useState } from 'react';
import { applicationKey, formatPushDiagnostics, pushRequest, readPushCapabilities, registerPushWorker, subscribePushDevice, waitForPush } from './push-client';
import './push-diagnostics.css';

interface Config { enabled: boolean; publicKey: string; lastRunAt: number | null; intervalSeconds: number }
export default function PushSettings({ userId, kind: audience = 'work', operatorPlanId, onEnabledChange, onEnabled }: { userId: string; kind?: 'work' | 'driver' | 'invoices' | 'operator'; operatorPlanId?: string; onEnabledChange?: (enabled: boolean) => void; onEnabled?: () => void }) {
  const [checking, setChecking] = useState(true);
  const [connectionCheck, setConnectionCheck] = useState(0);
  const [config, setConfig] = useState<Config | null>(null);
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [expiredSubscription, setExpiredSubscription] = useState(false);
  const [registered, setRegistered] = useState(false);
  const [probeId, setProbeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [copyNotice, setCopyNotice] = useState('');
  const [permission, setPermission] = useState(() => 'Notification' in window ? Notification.permission : 'default');
  const capabilities = readPushCapabilities();
  const { supported, ios, installed } = capabilities;
  const diagnosticText = formatPushDiagnostics(capabilities);
  useEffect(() => { onEnabledChange?.(registered && !!subscription && permission === 'granted' && !!config?.enabled); }, [registered, subscription, permission, config?.enabled, onEnabledChange]);
  useEffect(() => {
    let cancelled = false;
    setChecking(true); setRegistered(false); setError(''); setNotice('');
    async function load() {
      try {
        const result: Config = await pushRequest('config', 'GET', undefined, userId);
        if (cancelled) return;
        setConfig(result);
        if (!supported) return;
        const worker = await registerPushWorker();
        let current = await waitForPush(worker.pushManager.getSubscription(), 15000, 'Браузер не ответил при проверке подключения уведомлений. Повторите проверку позже.');
        if (cancelled) return;
        // A VAPID key change invalidates existing subscriptions.
        if (current && result.publicKey && current.options.applicationServerKey && new Uint8Array(current.options.applicationServerKey).toString() !== applicationKey(result.publicKey).toString()) { await waitForPush(current.unsubscribe(), 15000, 'Не удалось обновить подключение браузера. Повторите проверку.'); current = null; }
        if (current?.expirationTime && current.expirationTime <= Date.now()) { setExpiredSubscription(true); setSubscription(current); setPermission(Notification.permission); return; }
        if (current && Notification.permission === 'granted' && result.enabled) { await pushRequest('subscription', 'POST', { subscription: current.toJSON(), explicit: false }, userId); if (!cancelled) setRegistered(true); }
        if (!cancelled) { setPermission(Notification.permission); setSubscription(current); }
      } catch (reason) {
        if (!cancelled && (reason as Error & { status?: number }).status === 409) {
          setSubscription(null);
          setNotice('Подтвердите включение уведомлений для текущего пользователя.');
        } else if (!cancelled) setError((reason as Error).message);
      } finally { if (!cancelled) setChecking(false); }
    }
    void load();
    return () => { cancelled = true; };
  }, [userId, supported, connectionCheck]);
  useEffect(() => {
    let cancelled = false, inFlight = false;
    let permissionStatus: PermissionStatus | undefined;
    const syncPermission = () => {
      if (!('Notification' in window)) return;
      setPermission(Notification.permission);
      if (Notification.permission !== 'granted') {setRegistered(false);setNotice('');setProbeId(null);}
    };
    // Permission changes can arrive while the dialog remains open, without a focus event.
    if (navigator.permissions?.query) void navigator.permissions.query({name:'notifications'}).then(status => {
      if (cancelled) return;
      permissionStatus = status; status.addEventListener('change', syncPermission);
    }).catch(() => { /* Focus and visibility remain the fallback. */ });
    async function refreshConfig() {
      if (document.visibilityState !== 'visible' || inFlight) return;
      syncPermission();
      inFlight = true;
      try {
        const result: Config = await pushRequest('config', 'GET', undefined, userId);
        if (!cancelled) setConfig(result);
      } catch { /* Keep the last known configuration during temporary outages. */ }
      finally { inFlight = false; }
    }
    const refresh = () => void refreshConfig();
    const timer = window.setInterval(refresh, 60000);
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => { cancelled = true; permissionStatus?.removeEventListener('change', syncPermission); window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh); };
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
        const response = await fetch(`/api/push/test-status?probeId=${encodeURIComponent(probeId!)}`, { cache: 'no-store', signal: controller.signal, headers: { 'X-Artel-Account': userId } });
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
        if (result.status === 'failed') { setProbeId(null); setNotice(''); if (result.failure === 'expired_subscription') {setRegistered(false);setExpiredSubscription(true);} setError(result.failure === 'expired_subscription' ? 'Подписка устройства истекла. Включите уведомления повторно.' : 'Сервис доставки не ответил. Проверьте подключение и повторите тест позже.'); return; }
        if (result.status === 'expired') { unconfirmed(); return; }
      } catch {
        if (controller.signal.aborted) return;
        // Retry only the read-only status request, never the push itself.
      }
      retry = window.setTimeout(() => void check(), 3000);
    }
    void check();
    return () => { controller.abort(); window.clearTimeout(deadline); window.clearTimeout(retry); };
  }, [probeId, userId]);
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
        if (expiredSubscription) { const previous = await waitForPush(worker.pushManager.getSubscription(), 15000, 'Браузер не ответил. Повторите подключение.'); if (previous) await waitForPush(previous.unsubscribe(), 15000, 'Не удалось обновить подписку. Повторите подключение.'); setExpiredSubscription(false); }
        const current = await subscribePushDevice(worker, config!.publicKey);
        setNotice('Сохраняем подключение устройства…');
        await pushRequest('subscription', 'POST', { subscription: current.toJSON(), explicit: true }, userId);
        setSubscription(current); setRegistered(true);
        setNotice(audience === 'driver' ? 'Уведомления о новых рейсах включены на этом устройстве.' : 'Уведомления всех доступных вам разделов включены в этом браузере.');
        onEnabled?.();
      } else if (kind === 'disable' && subscription) {
        await pushRequest('subscription', 'DELETE', { endpoint: subscription.endpoint }, userId);
        await waitForPush(subscription.unsubscribe(), 15000, 'Сервер отключил уведомления, но браузер пока не завершил отключение. Повторите проверку позже.');
        setSubscription(null); setRegistered(false); setNotice('Уведомления на этом устройстве выключены.');
      } else if (subscription) {
        setPermission(Notification.permission);
        if (Notification.permission !== 'granted') { setRegistered(false); throw new Error('Разрешение браузера отключено. Включите уведомления снова.'); }
        const result = await pushRequest('test', 'POST', { endpoint: subscription.endpoint, async: true, kind: audience, ...(audience === 'operator' && operatorPlanId ? { operatorPlanId } : {}) }, userId);
        if (typeof result.probeId === 'string' && result.probeId) {
          setProbeId(result.probeId);
          setNotice('Проверка создана. Ожидаем подтверждение браузера…');
        } else setNotice('Сервис принял проверку. Получение браузером пока не подтверждено.');
      }
    } catch (reason) {
      setNotice('');
      if ([404, 410].includes((reason as Error & {status?: number}).status ?? 0)) setRegistered(false);
      setError(reason instanceof DOMException ? 'Браузер не смог подключить уведомления. Проверьте разрешения для CRM в браузере и настройках устройства, затем повторите попытку.' : (reason as Error).message);
    }
    finally { if ('Notification' in window) setPermission(Notification.permission); setBusy(false); }
  }
  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(formatPushDiagnostics(readPushCapabilities()));
      setCopyNotice('Диагностика скопирована.');
    } catch {
      setCopyNotice('Не удалось скопировать автоматически. Выделите и скопируйте текст в поле выше.');
    }
  }
  const enabled = registered && !!subscription && permission === 'granted' && !!config?.enabled;
  return <div className="work-push-settings">
    {audience !== 'driver' && <p>Уведомления включаются сразу для всех доступных вам разделов: работы, счетов и операторской. Достаточно включить их один раз в этом браузере на этом устройстве. Выключение тоже действует на все разделы.</p>}
    {!capabilities.secureContext ? <p>Для уведомлений откройте CRM по защищённому адресу, который начинается с https://.</p>
      : ios && !installed ? <p>На iPhone/iPad с iOS 16.4 или новее откройте меню «Поделиться» → «На экран Домой», запустите CRM с её значка и включите уведомления здесь.</p>
      : !supported ? <>
        <p>{capabilities.browserName === 'Huawei Browser' ? 'Huawei Browser на этом устройстве не предоставляет нужные возможности для уведомлений CRM. Начните с диагностики ниже; знать модель телефона для этого не нужно.' : 'В этом браузере уведомления CRM недоступны. Если вы открыли ссылку внутри другого приложения, откройте её в обычном браузере и проверьте снова.'}</p>
        <p>Скопируйте диагностику ниже — она покажет, какие возможности недоступны на этом устройстве.</p>
      </> : <>

      {config && !config.enabled && <p>Серверная отправка ещё не настроена.</p>}
      {config?.enabled && config.lastRunAt && Date.now() - config.lastRunAt > 20 * 60000 && <p role="status">Проверка напоминаний задерживается. Последняя проверка: {new Date(config.lastRunAt).toLocaleString('ru-RU')}.</p>}
      {subscription && !enabled && !checking && <p role="status">Подключение устройства не подтверждено. Включите уведомления повторно.</p>}
      {permission === 'denied' && <p>Разрешите уведомления для CRM в настройках браузера или устройства.</p>}
      {enabled && <p role="status">{audience === 'driver' ? 'Уведомления о новых рейсах включены.' : 'Уведомления всех доступных вам разделов включены в этом браузере.'}</p>}
      <div className="work-push-actions">{checking ? <p role="status">Проверяем подключение уведомлений…</p> : enabled ? <><button className="button" disabled={busy || !!probeId || !config?.enabled} onClick={() => void action('test')}>Проверить уведомление</button><button className="button" disabled={busy} onClick={() => void action('disable')}>{audience === 'driver' ? 'Выключить' : 'Выключить для всех разделов'}</button></> : <button className="button" disabled={busy || !config?.enabled || permission === 'denied'} onClick={() => void action('enable')}>{busy ? 'Подключение…' : audience === 'driver' ? 'Включить уведомления' : 'Включить для всех разделов'}</button>}</div>

    </>}
    {error && <><p role="alert">{error}</p><button type="button" className="button" disabled={busy || checking || !!probeId} onClick={() => setConnectionCheck(value => value + 1)}>Повторить проверку подключения</button></>}{notice && <p role="status">{notice}</p>}
    <details className="push-diagnostics">
      <summary>Проверка этого устройства</summary>
      <textarea aria-label="Диагностика уведомлений" readOnly rows={9} value={diagnosticText}/>
      <button type="button" className="button" onClick={() => void copyDiagnostics()}>Скопировать диагностику</button>
      {copyNotice && <p role="status">{copyNotice}</p>}
    </details>
  </div>;
}

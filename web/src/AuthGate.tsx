import { advanceAuthEpoch, apiFetch as fetch, logisticsSessionExpiredEvent, sessionExpiredEvent } from './workspace-api';
import { useCallback, useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck, Truck, UserRound } from 'lucide-react';
import type { AccountUser, SessionState } from './auth-model';
import { currentPushEndpoint } from './push-client';
import { watchVisibleRefresh } from './visible-refresh';
import './auth.css';

const emptyForm = { name: '', login: '', password: '', setupToken: '' };

function AuthBrand({ logistics = false }: { logistics?: boolean }) {
  return <div className="auth-brand">
    <span className="auth-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="32" height="32"><path d="M5 26 16 5l11 21h-7l-4-8-4 8Z" fill="currentColor" /></svg>
    </span>
    <span><strong>{logistics ? 'Артэль · Логистика' : 'Артэль CRM'}</strong><small>{logistics ? 'рейсы, водители и документы' : 'управление поставками топлива'}</small></span>
  </div>;
}

export default function AuthGate({ children, workspace }: { children: (user: AccountUser, onLogout: () => void) => ReactNode; workspace?: 'logistics' }) {
  const logistics = workspace === 'logistics';
  const [session, setSession] = useState<SessionState | null>(null);
  const [error, setError] = useState('');
  const [logoutError, setLogoutError] = useState('');
  const [operation, setOperation] = useState<'login' | 'logout' | null>(null);
  const busy = operation !== null;
  const [checking, setChecking] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState(emptyForm);
  const sessionRequest = useRef(0);
  const sessionController = useRef<AbortController | null>(null);
  const operationRef = useRef<'login' | 'logout' | null>(null);
  const refreshAfterAction = useRef(false);
  const currentSession = useRef<SessionState | null>(null);
  const pushEndpoint = useRef<{ userId: string; endpoint: string } | null>(null);
  const channel = useRef<BroadcastChannel | null>(null);
  const lastChange = useRef('');
  const audience = logistics ? 'logistics' : 'crm';
  const changeKey = `artel:auth-change:${audience}`;

  const invalidateReads = useCallback(() => {
    sessionRequest.current++;
    sessionController.current?.abort();
    sessionController.current = null;
  }, []);
  const applySession = useCallback((value: SessionState | null) => {
    const old = currentSession.current?.user, next = value?.user;
    if (old?.id !== next?.id || old?.version !== next?.version) advanceAuthEpoch(audience);
    currentSession.current = value;
    setSession(value);
  }, [audience]);
  const clearSession = useCallback(() => {
    advanceAuthEpoch(audience);
    applySession(currentSession.current ? { ...currentSession.current, user: null } : null);
    setShowPassword(false);
    setForm(emptyForm);
    setLogoutError('');
  }, [applySession, audience]);
  const refresh = useCallback(async () => {
    // A focus/visibility burst shares one read. Auth mutations apply their own
    // confirmed response; a cross-tab change schedules a fresh check afterwards.
    if (operationRef.current || sessionController.current) return;
    const generation = ++sessionRequest.current;
    const controller = new AbortController();
    sessionController.current = controller;
    const timer = window.setTimeout(() => controller.abort(), 15000);
    setChecking(true);
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store', signal: controller.signal });
      if (generation !== sessionRequest.current) return;
      if (!response.ok) {
        if (response.status === 401) clearSession();
        throw new Error('Не удалось проверить доступ.');
      }
      const current = await response.json() as SessionState;
      if (generation !== sessionRequest.current) return;
      applySession(current);
      setError('');
    } catch (e) {
      if (generation === sessionRequest.current) setError(controller.signal.aborted ? 'Не удалось проверить доступ. Повторите загрузку.' : (e as Error).message);
    } finally {
      window.clearTimeout(timer);
      if (sessionController.current === controller) sessionController.current = null;
      if (generation === sessionRequest.current) setChecking(false);
    }
  }, [applySession, clearSession]);

  useEffect(() => {
    void refresh();
    const stop = watchVisibleRefresh(() => { void refresh(); }, 60000);
    return () => { stop(); invalidateReads(); };
  }, [refresh, invalidateReads]);

  useEffect(() => {
    const expired = () => { invalidateReads(); setChecking(false); clearSession(); };
    const event = logistics ? logisticsSessionExpiredEvent : sessionExpiredEvent;
    window.addEventListener(event, expired);
    return () => window.removeEventListener(event, expired);
  }, [logistics, invalidateReads, clearSession]);

  useEffect(() => {
    const changed = (value: unknown) => {
      if (typeof value !== 'string' || !value || value === lastChange.current) return;
      lastChange.current = value;
      invalidateReads();
      clearSession();
      setChecking(true);
      if (operationRef.current) refreshAfterAction.current = true;
      else void refresh();
    };
    if (typeof BroadcastChannel !== 'undefined') {
      channel.current = new BroadcastChannel(changeKey);
      channel.current.onmessage = event => changed(event.data);
    }
    const storage = (event: StorageEvent) => { if (event.key === changeKey) changed(event.newValue); };
    window.addEventListener('storage', storage);
    return () => { channel.current?.close(); channel.current = null; window.removeEventListener('storage', storage); };
  }, [changeKey, clearSession, invalidateReads, refresh]);

  // Resolve the optional endpoint while the workspace is open, never while the
  // user waits to log out. Session-bound server revocation is authoritative.
  useEffect(() => {
    pushEndpoint.current = null;
    const userId = session?.user?.id;
    if (logistics || !userId || session.user?.role === 'driver') return;
    let active = true;
    void currentPushEndpoint(true).then(endpoint => { if (active && endpoint) pushEndpoint.current = { userId, endpoint }; }).catch(() => undefined);
    return () => { active = false; };
  }, [logistics, session?.user?.id, session?.user?.role]);

  const notifyTabs = () => {
    const nonce = `${Date.now()}:${Math.random()}`;
    lastChange.current = nonce;
    try { channel.current?.postMessage(nonce); } catch { /* The storage event is an independent fallback. */ }
    try { localStorage.setItem(changeKey, nonce); } catch { /* BroadcastChannel still works when storage is unavailable. */ }
  };
  const begin = (next: 'login' | 'logout') => {
    if (operationRef.current) return false;
    operationRef.current = next;
    setOperation(next);
    setError('');
    setLogoutError('');
    invalidateReads();
    advanceAuthEpoch(audience);
    return true;
  };
  const finish = () => {
    operationRef.current = null;
    setOperation(null);
    if (refreshAfterAction.current) { refreshAfterAction.current = false; void refresh(); }
  };
  const authRequest = async (path: string, body: unknown, signal: AbortSignal) => {
    const send = async () => {
      const response = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
      return { response, value: await response.json() as { user?: AccountUser; error?: string } };
    };
    // Cookies are shared across tabs. Serialize response delivery as well as the
    // POST so a delayed logout cannot erase a newer login's cookie. Browsers
    // without Web Locks retain server revocation + cross-tab revalidation.
    return navigator.locks ? navigator.locks.request(`artel:auth-mutation:${audience}`, { mode: 'exclusive', signal }, send) : send();
  };
  const logout = async () => {
    if (!begin('logout')) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const endpoint = pushEndpoint.current;
      const { response } = await authRequest('/api/auth/logout', endpoint?.userId === currentSession.current?.user?.id ? { pushEndpoint: endpoint?.endpoint } : {}, controller.signal);
      if (!response.ok && response.status !== 401) throw new Error('Не удалось подтвердить выход. Проверьте соединение и повторите.');
      // Do not unsubscribe the browser transport: it can hang or finish after a
      // new login and remove its subscription. The server has revoked access and
      // unlinked this session's devices before returning success.
      invalidateReads();
      clearSession();
      setChecking(false);
      notifyTabs();
    } catch {
      setLogoutError('Не удалось подтвердить выход. Проверьте соединение и повторите.');
      if (!currentSession.current?.user) setError('Не удалось подтвердить выход. Проверьте соединение и повторите.');
    } finally {
      window.clearTimeout(timer);
      finish();
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!session || logistics && session.needsSetup || !begin('login')) return;
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 15000);
    try {
      const payload = session.needsSetup ? form : { login: form.login, password: form.password };
      const { response, value } = await authRequest(`/api/auth/${session.needsSetup ? 'setup' : 'login'}`, payload, controller.signal);
      if (!response.ok) throw new Error(value.error || 'Не удалось войти.');
      if (!value.user?.id) throw new Error('Не удалось подтвердить вход. Повторите попытку.');
      invalidateReads();
      advanceAuthEpoch(audience);
      applySession({ user: value.user as AccountUser, needsSetup: false, setupTokenRequired: currentSession.current?.setupTokenRequired ?? false });
      setChecking(false);
      setForm(emptyForm);
      setShowPassword(false);
      notifyTabs();
    } catch (e) {
      setError(controller.signal.aborted ? 'Не удалось подтвердить вход. Проверьте соединение и повторите.' : (e as Error).message);
    } finally {
      window.clearTimeout(timer);
      finish();
    }
  };

  if (session?.user) return <>
    <div className="auth-session-workspace" inert={operation === 'logout'}>{children(session.user, () => { void logout(); })}</div>
    {operation === 'logout' ? <div className="auth-session-notice" role="status"><LoaderCircle className="auth-spinner" size={20} aria-hidden="true"/><span>Завершаем сеанс…</span></div>
      : (logoutError || error) && <div className="auth-session-notice auth-session-error" role="alert"><span>{logoutError || error}</span><button type="button" className="button" onClick={() => logoutError ? void logout() : void refresh()}>{logoutError ? 'Повторить выход' : 'Проверить доступ'}</button><button type="button" className="button" onClick={() => { setError(''); setLogoutError(''); }}>Закрыть</button></div>}
  </>;

  const needsSetup = !logistics && session?.needsSetup;
  return <main className="auth-screen">
    <section className="auth-story" aria-label="Об Артэль CRM">
      <div className="auth-story-rings" aria-hidden="true" />
      <div className="auth-story-content">
        <AuthBrand logistics={logistics} />
        <div className="auth-story-copy">
          <h2>{logistics ? 'Рейсы и документы.' : 'Отгрузки и финансы.'}<br /><em>{logistics ? 'Работа логиста.' : 'Всё под контролем.'}</em></h2>
          <p>{logistics ? 'Планируйте рейсы, выбирайте водителей и автомобили, отслеживайте документы в Saby.' : 'Управляйте поставками, следите за оплатами и планируйте работу команды в одном пространстве.'}</p>
        </div>
        <div className="auth-insight-card">
          <div className="auth-insight-label"><Truck size={18} aria-hidden="true" /> Рабочее пространство команды</div>
          <strong>{logistics ? 'От погрузки до доставки' : 'От отгрузки до оплаты'}</strong>
          <span>{logistics ? 'Маршруты, транспорт и справочники — в одном интерфейсе.' : 'Клиенты, поставщики и расчёты — всегда под рукой.'}</span>
        </div>
      </div>
    </section>

    <section className="auth-form-side" aria-labelledby="auth-title">
      <div className="auth-mobile-brand"><AuthBrand logistics={logistics} /></div>
      <div className="auth-form-wrap">
        <div className="auth-kicker"><ShieldCheck size={18} aria-hidden="true" /> Закрытая рабочая зона</div>
        <h1 id="auth-title">{needsSetup ? 'Первый вход' : 'Вход'}</h1>
        <p className="auth-form-lead">{needsSetup
          ? 'Создайте учётную запись директора, чтобы начать работу с CRM.'
          : logistics ? 'Войдите под своей учётной записью Артэль CRM.' : 'С возвращением. Войдите, чтобы продолжить работу в Артэль CRM.'}</p>

        {!session ? <div className="auth-connection">
          {checking ? <p className="auth-loading" role="status"><LoaderCircle size={20} aria-hidden="true" /> Проверяем доступ…</p>
            : <><p className="auth-error" role="alert">{error}</p><button className="auth-submit" onClick={() => void refresh()}>Повторить загрузку<ArrowRight size={20} aria-hidden="true" /></button></>}
        </div> : logistics && session.needsSetup ? <p className="auth-error" role="alert">Учётные записи ещё не настроены. Обратитесь к администратору основной CRM.</p> : <form className="auth-form" onSubmit={submit} aria-busy={busy}>
          <fieldset disabled={busy} aria-label={needsSetup ? 'Создание учётной записи директора' : 'Данные для входа'}>
            {needsSetup && <div className="auth-field">
              <label htmlFor="auth-name">Имя</label>
              <div className="auth-input-wrap">
                <UserRound size={20} aria-hidden="true" />
                <input id="auth-name" name="name" required maxLength={120} autoComplete="name" placeholder="Как к вам обращаться" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
              </div>
            </div>}
            <div className="auth-field">
              <label htmlFor="auth-login">Логин</label>
              <div className="auth-input-wrap">
                <UserRound size={20} aria-hidden="true" />
                <input id="auth-login" name="username" required maxLength={64} autoComplete="username" autoCapitalize="none" spellCheck={false} placeholder="Введите логин" value={form.login} onChange={event => setForm({ ...form, login: event.target.value })} />
              </div>
            </div>
            <div className="auth-field">
              <label htmlFor="auth-password">Пароль</label>
              <div className="auth-input-wrap">
                <LockKeyhole size={20} aria-hidden="true" />
                <input id="auth-password" name="password" required type={showPassword ? 'text' : 'password'} minLength={needsSetup ? 12 : undefined} maxLength={256} autoComplete={needsSetup ? 'new-password' : 'current-password'} aria-describedby={needsSetup ? 'auth-password-hint' : undefined} placeholder={needsSetup ? 'Придумайте пароль' : 'Введите пароль'} value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} />
                <button className="auth-password-toggle" type="button" aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'} aria-controls="auth-password" onClick={() => setShowPassword(value => !value)}>
                  {showPassword ? <EyeOff size={20} aria-hidden="true" /> : <Eye size={20} aria-hidden="true" />}
                </button>
              </div>
              {needsSetup && <p className="auth-field-hint" id="auth-password-hint">Не менее 12 символов.</p>}
            </div>
            {needsSetup && session.setupTokenRequired && <div className="auth-field">
              <label htmlFor="auth-setup-token">Ключ первоначальной настройки</label>
              <div className="auth-input-wrap">
                <KeyRound size={20} aria-hidden="true" />
                <input id="auth-setup-token" name="setupToken" required type="password" autoComplete="off" placeholder="Введите ключ настройки" value={form.setupToken} onChange={event => setForm({ ...form, setupToken: event.target.value })} />
              </div>
            </div>}
            {error && <p className="auth-error" role="alert">{error}</p>}
            <button className="auth-submit" type="submit">
              <span>{operation === 'logout' ? 'Завершаем сеанс…' : busy ? (needsSetup ? 'Создаём…' : 'Входим…') : needsSetup ? 'Создать директора' : 'Войти'}</span>
              {busy ? <LoaderCircle className="auth-spinner" size={20} aria-hidden="true" /> : <ArrowRight size={20} aria-hidden="true" />}
            </button>
          </fieldset>
        </form>}

        <div className="auth-security-note"><LockKeyhole size={17} aria-hidden="true" /><span>Доступ к данным открыт только авторизованным сотрудникам.</span></div>
      </div>
    </section>
  </main>;
}

import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowRight, Eye, EyeOff, KeyRound, LoaderCircle, LockKeyhole, ShieldCheck, Truck, UserRound } from 'lucide-react';
import type { AccountUser, SessionState } from './auth-model';
import { currentPushEndpoint, disconnectPushDevice } from './push-client';
import './auth.css';

const emptyForm = { name: '', login: '', password: '', setupToken: '' };

function AuthBrand() {
  return <div className="auth-brand">
    <span className="auth-brand-mark" aria-hidden="true">
      <svg viewBox="0 0 32 32" width="32" height="32"><path d="M5 26 16 5l11 21h-7l-4-8-4 8Z" fill="currentColor" /></svg>
    </span>
    <span><strong>Артель CRM</strong><small>управление поставками топлива</small></span>
  </div>;
}

export default function AuthGate({ children }: { children: (user: AccountUser, onLogout: () => void) => ReactNode }) {
  const [session, setSession] = useState<SessionState | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(true);
  const [showPassword, setShowPassword] = useState(false);
  const [form, setForm] = useState(emptyForm);

  const refresh = useCallback(async () => {
    setChecking(true);
    try {
      const response = await fetch('/api/auth/session');
      if (!response.ok) throw new Error('Не удалось проверить доступ.');
      setSession(await response.json());
      setError('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const focus = () => { void refresh(); };
    window.addEventListener('focus', focus);
    const timer = setInterval(focus, 60000);
    return () => { window.removeEventListener('focus', focus); clearInterval(timer); };
  }, [refresh]);

  const logout = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/auth/logout', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ pushEndpoint: await currentPushEndpoint().catch(() => null) }),
      });
      if (!response.ok && response.status !== 401) throw new Error('Не удалось завершить сеанс.');
      await disconnectPushDevice().catch(() => undefined);
      setShowPassword(false);
      setSession(value => value ? { ...value, user: null } : value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !session) return;
    setBusy(true);
    setError('');
    try {
      const payload = session.needsSetup ? form : { login: form.login, password: form.password };
      const response = await fetch(`/api/auth/${session.needsSetup ? 'setup' : 'login'}`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
      });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error || 'Не удалось войти.');
      setForm(emptyForm);
      setShowPassword(false);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (session?.user) return children(session.user, () => { if (!busy) void logout(); });

  const needsSetup = session?.needsSetup;
  return <main className="auth-screen">
    <section className="auth-story" aria-label="Об Артель CRM">
      <div className="auth-story-rings" aria-hidden="true" />
      <div className="auth-story-content">
        <AuthBrand />
        <div className="auth-story-copy">
          <h2>Отгрузки и финансы.<br /><em>Всё под контролем.</em></h2>
          <p>Управляйте поставками, следите за оплатами и планируйте работу команды в одном пространстве.</p>
        </div>
        <div className="auth-insight-card">
          <div className="auth-insight-label"><Truck size={18} aria-hidden="true" /> Рабочее пространство команды</div>
          <strong>От отгрузки до оплаты</strong>
          <span>Клиенты, поставщики и расчёты — всегда под рукой.</span>
        </div>
      </div>
    </section>

    <section className="auth-form-side" aria-labelledby="auth-title">
      <div className="auth-mobile-brand"><AuthBrand /></div>
      <div className="auth-form-wrap">
        <div className="auth-kicker"><ShieldCheck size={18} aria-hidden="true" /> Закрытая рабочая зона</div>
        <h1 id="auth-title">{needsSetup ? 'Первый вход' : 'Вход'}</h1>
        <p className="auth-form-lead">{needsSetup
          ? 'Создайте учётную запись директора, чтобы начать работу с CRM.'
          : 'С возвращением. Войдите, чтобы продолжить работу в Артель CRM.'}</p>

        {!session ? <div className="auth-connection">
          {checking ? <p className="auth-loading" role="status"><LoaderCircle size={20} aria-hidden="true" /> Проверяем доступ…</p>
            : <><p className="auth-error" role="alert">{error}</p><button className="auth-submit" onClick={() => void refresh()}>Повторить загрузку<ArrowRight size={20} aria-hidden="true" /></button></>}
        </div> : <form className="auth-form" onSubmit={submit} aria-busy={busy}>
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
              <span>{busy ? (needsSetup ? 'Создаём…' : 'Входим…') : needsSetup ? 'Создать директора' : 'Войти'}</span>
              {busy ? <LoaderCircle className="auth-spinner" size={20} aria-hidden="true" /> : <ArrowRight size={20} aria-hidden="true" />}
            </button>
          </fieldset>
        </form>}

        <div className="auth-security-note"><LockKeyhole size={17} aria-hidden="true" /><span>Доступ к данным открыт только авторизованным сотрудникам.</span></div>
      </div>
    </section>
  </main>;
}

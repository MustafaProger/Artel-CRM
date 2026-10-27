import { useEffect, useRef, useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

export default function AccountSavedPassword({ userId, version, available }: { userId: string; version: number; available: boolean }) {
  const [password, setPassword] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef<AbortController | null>(null);
  const hide = () => { pending.current?.abort(); pending.current = null; setPassword(''); setBusy(false); };
  useEffect(() => {
    const onVisibility = () => { if (document.hidden) hide(); };
    window.addEventListener('blur', hide);
    document.addEventListener('visibilitychange', onVisibility);
    return () => { pending.current?.abort(); window.removeEventListener('blur', hide); document.removeEventListener('visibilitychange', onVisibility); };
  }, []);
  useEffect(() => {
    if (!password) return;
    const timer = window.setTimeout(hide, 30_000);
    return () => window.clearTimeout(timer);
  }, [password]);
  if (!available) return <small className="account-password-unavailable">Пароль недоступен для просмотра: задан ранее.</small>;
  const reveal = async () => {
    if (pending.current) return;
    const controller = new AbortController(); pending.current = controller; setBusy(true); setError('');
    try {
      const response = await fetch(`/api/auth/users/${encodeURIComponent(userId)}/password`, { method: 'POST', cache: 'no-store', signal: controller.signal, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version }) });
      const result = await response.json();
      if (controller.signal.aborted || pending.current !== controller) return;
      if (!response.ok) throw new Error(result.error || 'Не удалось показать пароль.');
      setPassword(result.password);
    } catch (reason) {
      if (!controller.signal.aborted) setError((reason as Error).message);
    } finally { if (pending.current === controller) { pending.current = null; setBusy(false); } }
  };
  return <div className="account-saved-password">
    <button className="button" type="button" disabled={busy} aria-expanded={!!password} onClick={() => password ? hide() : void reveal()}>
      {password ? <EyeOff size={16} aria-hidden="true"/> : <Eye size={16} aria-hidden="true"/>}{busy ? 'Загрузка…' : password ? 'Скрыть пароль' : 'Показать пароль'}
    </button>
    {password && <div className="account-saved-password-value"><span>Текущий пароль</span><code>{password}</code><small>Скроется через 30 секунд.</small></div>}
    {error && <small role="alert">{error}</small>}
  </div>;
}

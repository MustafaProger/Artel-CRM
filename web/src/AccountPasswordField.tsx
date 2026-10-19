import { useState } from 'react';
import { Copy, Eye, EyeOff, KeyRound } from 'lucide-react';

export default function AccountPasswordField({ value, onChange, editing }: { value: string; onChange: (value: string) => void; editing: boolean }) {
  const [visible, setVisible] = useState(false), [notice, setNotice] = useState('');
  const label = editing ? 'Новый пароль (если нужно)' : 'Пароль';
  const generate = () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    onChange(Array.from(crypto.getRandomValues(new Uint8Array(24)), byte => alphabet[byte & 63]).join(''));
    setVisible(false);
    setNotice('Пароль создан. Он начнёт действовать после сохранения пользователя.');
  };
  return <div className="account-full-field account-password-field">
    <label htmlFor="account-password">{label}</label>
    <div className="account-password-input"><input id="account-password" aria-label={label} required={!editing} type={visible ? 'text' : 'password'} minLength={12} maxLength={256} autoComplete="new-password" spellCheck={false} value={value} onChange={event => { onChange(event.target.value); setNotice(''); }}/><button type="button" className="icon-button" aria-label={visible ? 'Скрыть пароль' : 'Показать пароль'} disabled={!value} onClick={() => setVisible(current => !current)}>{visible ? <EyeOff size={18}/> : <Eye size={18}/>}</button></div>
    <div className="account-password-actions"><button type="button" className="button" onClick={generate}><KeyRound size={16}/>Сгенерировать пароль</button><button type="button" className="button" disabled={!value} onClick={async () => {
      try { await navigator.clipboard.writeText(value); setNotice('Пароль скопирован. Передайте его сотруднику лично после сохранения.'); }
      catch { setNotice('Не удалось скопировать. Покажите пароль и скопируйте вручную.'); }
    }}><Copy size={16}/>Скопировать пароль</button></div>
    {notice && <p className="work-hint" role="status">{notice}</p>}
  </div>;
}

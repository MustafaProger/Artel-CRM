import { useEffect, useRef, useState } from 'react';
import { Plus, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import './accounts.css';
import { effectiveSections, legacyManagerSections, sections, type AccountRole, type AccountUser, type SectionId } from './auth-model';
import type { Directories } from './model';
const empty = () => ({ name: '', login: '', password: '', role: 'manager' as AccountRole, managerId: '', active: true, sections: [...legacyManagerSections] });
const roleNames = { director: 'Директор', admin: 'Администратор', manager: 'Сотрудник / менеджер' };
async function request(url: string, method = 'GET', body?: unknown) {
  const response = await fetch(url, { method, ...(body ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || 'Не удалось сохранить данные.');
  return result;
}
export default function AccountManagement({ directories, onChanged }: { directories: Directories; onChanged: () => void }) {
  const [users, setUsers] = useState<AccountUser[]>([]), [error, setError] = useState(''), [notice, setNotice] = useState(''), [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<AccountUser | null | undefined>(undefined), [form, setForm] = useState(empty), [employeeName, setEmployeeName] = useState('');
  const [employees, setEmployees] = useState(directories.managers);
  const [currentUserId, setCurrentUserId] = useState(''), [deleting, setDeleting] = useState<AccountUser | null>(null);
  useEffect(() => setEmployees(directories.managers), [directories.managers]);
  const refresh = async () => { const result = await request('/api/auth/users'); setUsers(result.users); setCurrentUserId(result.currentUserId); };
  useEffect(() => { void refresh().catch(e => setError(e.message)); }, []);
  const edit = (user: AccountUser | null) => {
    setEditing(user); setError(''); setNotice(''); setEmployeeName('');
    setForm(user ? { name: user.name, login: user.login, password: '', role: user.role, managerId: user.managerId ?? '', active: user.active, sections: effectiveSections(user) } : empty());
  };
  const toggle = (id: SectionId, enabled: boolean) => setForm(previous => ({ ...previous, sections: enabled ? [...previous.sections, id] : previous.sections.filter(value => value !== id) }));
  const privileged = form.role !== 'manager';
  const deletionBlock = (user: AccountUser) => user.id === currentUserId ? 'Нельзя удалить свою учётную запись' : user.active && user.role === 'director' && users.filter(row => row.active && row.role === 'director').length === 1 ? 'Нельзя удалить последнего активного директора' : '';
  return <section className="panel account-panel">
    <div className="panel-heading"><div><h2>Учётные записи</h2></div><button className="button primary" disabled={busy} onClick={() => edit(null)}><Plus size={16} aria-hidden="true" />Добавить пользователя</button></div>
    {error && <p className="soft-notice" role="alert">{error}</p>}{notice && <p className="soft-notice" role="status">{notice}</p>}
    {editing !== undefined && <form className="account-form" onSubmit={async event => {
      event.preventDefault(); if (busy) return; setBusy(true); setError('');
      try {
        await request(`/api/auth/users${editing ? '/' + editing.id : ''}`, editing ? 'PATCH' : 'POST', { ...form, managerId: form.managerId || null, ...(editing ? { version: editing.version } : {}) });
        setEditing(undefined); setForm(empty()); await refresh(); onChanged(); setNotice('Учётная запись сохранена. Предыдущие сеансы сотрудника завершены.');
      } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
    }}><fieldset disabled={busy}>
      <legend>{editing ? 'Изменить учётную запись' : 'Новая учётная запись'}</legend>
      <div className="account-editor-grid"><div className="account-details-card"><div className="account-group-heading"><span className="account-group-icon"><UserRound size={19} aria-hidden="true" /></span><div><h3>Данные сотрудника</h3></div></div><div className="account-fields">
      <label className="account-full-field">Сотрудник справочника<select aria-label="Сотрудник справочника" required={!editing || form.role === 'manager' && form.active} value={form.managerId} onChange={event => { const id = event.target.value; setForm({ ...form, managerId: id, name: employees.find(employee => employee.id === id)?.name ?? form.name }); }}>
        <option value="">Выберите сотрудника</option>{employees.map(employee => <option key={employee.id} value={employee.id}>{employee.name} {users.some(user => user.active && user.managerId === employee.id && user.id !== editing?.id) ? '· аккаунт уже есть' : ''}</option>)}
      </select></label>
      <div className="account-create-employee"><label>Новый сотрудник<input value={employeeName} maxLength={120} placeholder="Если сотрудника ещё нет в справочнике" onChange={event => setEmployeeName(event.target.value)} /></label><button className="button" type="button" disabled={!employeeName.trim()} onClick={async () => {
        setBusy(true); setError(''); try {
          const result = await request('/api/directories', 'POST', { kind: 'managers', name: employeeName });
          const employee = result.entry;
          setEmployees(previous => previous.some(row => row.id === employee.id) ? previous : [...previous, employee]);
          setForm(previous => ({ ...previous, managerId: employee.id, name: employee.name })); setEmployeeName(''); onChanged();
          setNotice(result.created ? 'Сотрудник добавлен в справочник. Настройте вход.' : 'Выбран существующий сотрудник. Дубликат не создан.');
        } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
      }}>Добавить сотрудника</button></div>
      <label>Имя в приложении<input required maxLength={120} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
      <label>Логин<input required maxLength={64} autoComplete="off" autoCapitalize="none" value={form.login} onChange={event => setForm({ ...form, login: event.target.value })} /></label>
      <label>{editing ? 'Новый пароль (если нужно)' : 'Пароль'}<input required={!editing} type="password" minLength={12} maxLength={256} autoComplete="new-password" value={form.password} onChange={event => setForm({ ...form, password: event.target.value })} /></label>
      </div></div><div className="account-access-card"><div className="account-group-heading"><span className="account-group-icon"><ShieldCheck size={19} aria-hidden="true" /></span><div><h3>Права доступа</h3></div></div>
      <label>Полномочия<select aria-label="Полномочия" value={form.role} onChange={event => setForm({ ...form, role: event.target.value as AccountRole, sections: [] })}>{Object.entries(roleNames).map(([id, title]) => <option value={id} key={id}>{title}</option>)}</select></label>
      <div className="account-permissions"><div className="account-permissions-heading"><strong>Доступные разделы</strong><span>{privileged ? sections.length : sections.filter(section => form.sections.includes(section.id)).length} из {sections.length}</span></div><div className="account-section-grid">{sections.map(section => <label key={section.id}><input className="account-toggle" type="checkbox" checked={privileged || form.sections.includes(section.id)} disabled={privileged} onChange={event => toggle(section.id, event.target.checked)} /><span>{section.title}</span></label>)}</div></div>
      <p className="work-hint">{privileged ? 'Директор и администратор имеют полный доступ, включая все отгрузки и управление аккаунтами.' : 'Отгрузки — только назначенные выбранному сотруднику. Доступ к клиенту не открывает чужие отгрузки. Китай и банковские платежи сохраняют ограничения для директора и администратора.'}</p>
      </div></div>
      <div className="account-form-footer"><label className="active-field"><input className="account-toggle" type="checkbox" checked={form.active} onChange={event => setForm({ ...form, active: event.target.checked })} /><span>Активен</span></label>
      <div className="account-actions"><button className="button primary" type="submit">{busy ? 'Сохраняем…' : 'Сохранить пользователя'}</button><button className="button" type="button" onClick={() => setEditing(undefined)}>Отмена</button></div></div>
    </fieldset></form>}
    <div className="account-list-heading"><h3>Пользователи</h3><span>{users.length}</span></div><div className="account-list">{users.map(user => <div className="account-row" key={user.id}><span className="account-avatar" aria-hidden="true">{user.name.trim().slice(0, 1).toUpperCase()}</span><div className="account-user-info"><div className="account-user-title"><strong>{user.name}</strong><span className={`account-status${user.active ? '' : ' is-inactive'}`}>{user.active ? 'Активен' : 'Отключён'}</span></div><small>{user.login} · {roleNames[user.role]}</small><small>Сотрудник: {employees.find(employee => employee.id === user.managerId)?.name ?? 'Не связан — привяжите сотрудника'}</small><small>Разделы: {user.active ? sections.filter(section => effectiveSections(user).includes(section.id)).map(section => section.title).join(', ') || 'Нет доступа' : 'Доступ отключён'}</small><small>{user.role === 'manager' ? 'Отгрузки: только свои' : 'Отгрузки: все'}</small></div><div className="account-row-actions"><button className="button" disabled={busy} onClick={() => edit(user)}>Изменить</button><button className="button account-delete" disabled={busy || !!deletionBlock(user)} title={deletionBlock(user) || `Удалить ${user.name}`} aria-label={`Удалить ${user.name}`} onClick={() => { setDeleting(user); setError(''); setNotice(''); }}><Trash2 size={15} aria-hidden="true"/>Удалить</button>{deletionBlock(user) && <small>{deletionBlock(user)}</small>}</div></div>)}</div>
    {deleting && <DeleteAccountDialog user={deleting} onClose={() => setDeleting(null)} onDeleted={async () => { await refresh(); setDeleting(null); if (editing?.id === deleting.id) setEditing(undefined); onChanged(); setNotice('Учётная запись удалена. Доступ и уведомления отключены, история работы сохранена.'); }}/>}
  </section>;
}

function DeleteAccountDialog({ user, onClose, onDeleted }: { user: AccountUser; onClose: () => void; onDeleted: () => Promise<void> }) {
  const dialog = useRef<HTMLDialogElement>(null), confirmationInput = useRef<HTMLInputElement>(null), inFlight = useRef(false);
  const [confirmationName, setConfirmationName] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => { const element = dialog.current; element?.showModal(); confirmationInput.current?.focus(); return () => element?.close(); }, []);
  return <dialog ref={dialog} className="account-delete-dialog" aria-labelledby="account-delete-title" onCancel={event => { event.preventDefault(); if (!inFlight.current) onClose(); }}><form onSubmit={async event => {
    event.preventDefault(); if (inFlight.current || confirmationName !== user.name) return;
    inFlight.current = true; setBusy(true); setError('');
    try { await request(`/api/auth/users/${encodeURIComponent(user.id)}`, 'DELETE', { version: user.version, confirmationName }); await onDeleted(); }
    catch (reason) { setError((reason as Error).message); }
    finally { inFlight.current = false; setBusy(false); }
  }}><h2 id="account-delete-title">Удалить учётную запись?</h2><p><strong>{user.name}</strong> больше не сможет войти в CRM. Все сеансы завершатся, уведомления будут отключены.</p><p>История, комментарии, файлы и сотрудник в справочнике сохранятся. Вернуть эту учётную запись через интерфейс нельзя.</p><p>Незавершённые задачи и работу с компаниями сначала передайте другому сотруднику или завершите и архивируйте в разделе <a href="#work" onClick={event => { if (inFlight.current) event.preventDefault(); else onClose(); }}>«Работа»</a>.</p><label>Для подтверждения введите точное имя: <strong>{user.name}</strong><input ref={confirmationInput} autoComplete="off" aria-label="Имя сотрудника для подтверждения удаления" value={confirmationName} disabled={busy} onChange={event => setConfirmationName(event.target.value)} /></label>{error && <p className="shipment-error" role="alert">{error}</p>}<div className="account-actions"><button type="button" className="button" disabled={busy} onClick={onClose}>Отмена</button><button type="submit" className="button danger" disabled={busy || confirmationName !== user.name}>{busy ? 'Удаление…' : 'Удалить учётную запись'}</button></div></form></dialog>;
}

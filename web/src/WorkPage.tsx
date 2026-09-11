import { useCallback, useEffect, useRef, useState } from 'react';
import { Bell, CalendarDays, ChevronLeft, ChevronRight, LayoutGrid, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react';
import type { AccountUser } from './auth-model';
import DirectorySelect from './DirectorySelect';
import type { Company } from './model';
import { workStatuses, workFileLimit, workFilesTotalLimit, type AnyWorkEntry, type WorkCompanyRecord, type WorkKind, type WorkNote, type WorkResponse, type WorkTask } from './work-model';
import './work.css';
import PushSettings from './PushSettings';

type Editor = { kind: WorkKind; entry?: AnyWorkEntry };
type SavedAction = 'saved' | 'archived' | 'restored' | 'deleted';
type CalendarEvent = { id: string; day: string; title: string; reminder: boolean; editor: Editor };
const localDay = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
const dateLabel = (date: string | null) => date ? new Date(date.length === 10 ? `${date}T12:00:00` : date).toLocaleString('ru-RU', date.length === 10 ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const localInputTime = (value: string | null | undefined) => {
  if (!value) return '';
  const date = new Date(value);
  return `${localDay(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};
const titleFor = (editor: Editor) => editor.entry ? 'question' in editor.entry ? editor.entry.question : editor.entry.title : '';

export default function WorkPage() {
  const [data, setData] = useState<WorkResponse | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [filter, setFilter] = useState(''), [view, setView] = useState<'board' | 'calendar' | 'archive'>('board');
  const [companySearch, setCompanySearch] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const request = useRef<AbortController | null>(null), active = useRef(true);
  const refresh = useCallback(async (visible = false) => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (visible) setLoading(true);
    try {
      const response = await fetch(`/api/work${filter ? `?assigneeId=${encodeURIComponent(filter)}` : ''}`, { signal: controller.signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось загрузить рабочее пространство.');
      if (!controller.signal.aborted && active.current) { setData(result); setError(''); }
    } catch (reason) {
      if (!controller.signal.aborted && active.current) setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.');
    } finally { if (!controller.signal.aborted && active.current) setLoading(false); }
  }, [filter]);
  useEffect(() => {
    active.current = true;
    void refresh(true);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(onVisible, 15000);
    window.addEventListener('focus', onVisible);
    document.addEventListener('visibilitychange', onVisible);
    return () => { active.current = false; request.current?.abort(); window.clearInterval(timer); window.removeEventListener('focus', onVisible); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh]);
  useEffect(() => {
    if (!data) return;
    const params = new URLSearchParams(location.search);
    const id = params.get('workId'), kind = params.get('workKind');
    if (!id || (kind !== 'tasks' && kind !== 'companies')) return;
    const entry = (kind === 'tasks' ? data.work.tasks : data.work.companyRecords).find(row => row.id === id);
    if (entry) setEditor({ kind, entry });
    else setNotice('Запись из уведомления больше недоступна.');
    params.delete('workId'); params.delete('workKind');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}#work`);
  }, [data]);
  const userName = (id: string) => data?.users.find(user => user.id === id)?.name ?? 'Сотрудник недоступен';
  const companyName = (id: string | null) => data?.companies.find(company => company.id === id)?.name ?? (id ? 'Компания недоступна' : '');
  const isManager = data?.currentUser.role === 'manager';
  const work = data?.work;
  const today = localDay(new Date());
  const events: CalendarEvent[] = [];
  for (const task of (work?.tasks ?? []).filter(task => !task.archivedAt)) {
    if (task.dueDate) events.push({ id: `${task.id}-due`, day: task.dueDate, title: task.title, reminder: false, editor: { kind: 'tasks', entry: task } });
    if (task.reminderAt) events.push({ id: `${task.id}-reminder`, day: localDay(new Date(task.reminderAt)), title: task.title, reminder: true, editor: { kind: 'tasks', entry: task } });
  }
  for (const row of work?.companyRecords ?? []) if (row.reminderAt && !row.archivedAt) events.push({ id: row.id, day: localDay(new Date(row.reminderAt)), title: companyName(row.companyId), reminder: true, editor: { kind: 'companies', entry: row } });
  const reminders = [
    ...(work?.tasks ?? []).filter(task => task.reminderAt && task.status !== 'done' && !task.archivedAt).map(task => ({ at: task.reminderAt!, title: task.title, editor: { kind: 'tasks', entry: task } as Editor })),
    ...(work?.companyRecords ?? []).filter(row => row.reminderAt && !row.archivedAt).map(row => ({ at: row.reminderAt!, title: `${companyName(row.companyId)}: ${row.question}`, editor: { kind: 'companies', entry: row } as Editor })),
  ].sort((a, b) => a.at.localeCompare(b.at));
  const records: Editor[] = [
    ...(work?.tasks ?? []).map(entry => ({ kind: 'tasks' as const, entry })),
    ...(work?.companyRecords ?? []).map(entry => ({ kind: 'companies' as const, entry })),
  ].filter(item => !!(item.entry as WorkTask).archivedAt === (view === 'archive')).filter(item => {
    const entry = item.entry as WorkTask | WorkCompanyRecord;
    const company = data?.companies.find(company => company.id === entry.companyId);
    return `${company?.name ?? ''} ${company?.inn ?? ''}`.toLocaleLowerCase('ru').includes(companySearch.trim().toLocaleLowerCase('ru'));
  }).sort((a, b) => b.entry!.updatedAt.localeCompare(a.entry!.updatedAt));
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - (first.getDay() + 6) % 7);
  const days = Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
  return <div className="work-page">
    <div className="work-toolbar">
      <div className="work-views" role="group" aria-label="Представление работы"><button className={`button ${view === 'board' ? 'primary' : ''}`} aria-pressed={view === 'board'} onClick={() => setView('board')}><LayoutGrid size={17}/>Работа с компаниями</button><button className={`button ${view === 'calendar' ? 'primary' : ''}`} aria-pressed={view === 'calendar'} onClick={() => setView('calendar')}><CalendarDays size={17}/>Календарь</button><button className={`button ${view === 'archive' ? 'primary' : ''}`} aria-pressed={view === 'archive'} onClick={() => setView('archive')}>Архив задач</button></div>
      {isManager ? <span className="work-filter-caption">Назначенные мне</span> : <select className="filter-select" aria-label="Фильтр исполнителя" value={filter} onChange={event => setFilter(event.target.value)}><option value="">Все сотрудники</option><option value="mine">Мои записи</option>{data?.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select>}
      <button className="button work-refresh" disabled={loading} onClick={() => void refresh(true)} aria-label="Обновить работу"><RefreshCw size={16} className={loading ? 'spin' : ''}/><span>Обновить</span></button>
      <button className="button primary" disabled={!data} onClick={() => setEditor({ kind: 'tasks' })}><Plus size={17}/>Новая задача</button>
    </div>
    {notice && <p className="work-notice" role="status">{notice}</p>}
    {error && <p className="shipment-error" role="alert">{error}</p>}
    {!data && <div className="panel work-empty">{loading ? 'Загрузка рабочего пространства…' : 'Данные не загружены. Нажмите «Обновить».'}</div>}
    {data && <>
      <div className="work-layout">
        <section className="work-main" aria-label={view === 'calendar' ? 'Календарь задач' : 'Работа с компаниями'}>
          {view !== 'calendar' ? <section className="panel work-companies"><header className="work-section-heading"><div><h2>{view === 'archive' ? 'Архив задач' : 'Работа с компаниями'}</h2><p>Текущие вопросы, комментарии и напоминания</p></div>{view !== 'archive' && <button className="button" onClick={() => setEditor({ kind: 'companies' })}><Plus size={16}/>Добавить</button>}</header><label className="work-company-search work-field"><span>Поиск компании</span><input aria-label="Поиск компании в работе" placeholder="Название или ИНН компании…" value={companySearch} onChange={event => setCompanySearch(event.target.value)}/></label><div className="work-company-list">{records.map(item => { const row = item.entry as WorkTask | WorkCompanyRecord; const task = 'title' in row ? row : null; return <button key={row.id} className={task ? 'work-card' : 'work-company-row'} onClick={() => setEditor(item)} aria-label={task ? `Задача: ${task.title}` : `Работа с компанией: ${companyName(row.companyId)}`}><span><strong>{task ? task.title : (row as WorkCompanyRecord).question}</strong><p>{companyName(row.companyId) || 'Без компании'}</p>{task?.description && <p>{task.description}</p>}<small>{userName(row.assigneeId)} · Комментариев: {row.comments?.length ?? 0} · Файлов: {row.attachments?.length ?? 0}</small></span><span className="work-card-footer">{task && <small>{workStatuses.find(status => status.id === task.status)?.name}</small>}{task?.dueDate && <small className={task.dueDate < today && task.status !== 'done' ? 'work-overdue' : ''}><CalendarDays size={13}/>{dateLabel(task.dueDate)}</small>}{row.reminderAt && <small><Bell size={13}/>{dateLabel(row.reminderAt)}</small>}</span></button>; })}{!records.length && <p className="work-empty">{companySearch ? 'По компании ничего не найдено.' : view === 'archive' ? 'В архиве пока нет задач.' : 'Рабочих записей пока нет.'}</p>}</div></section> : <section className="panel work-calendar"><header className="work-calendar-heading"><h2>{month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</h2><div><button className="icon-button" aria-label="Предыдущий месяц" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={18}/></button><button className="button" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Сегодня</button><button className="icon-button" aria-label="Следующий месяц" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={18}/></button></div></header><div className="work-calendar-scroll"><div className="work-calendar-grid">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => <strong className="work-weekday" key={day}>{day}</strong>)}{days.map(date => { const day = localDay(date); return <div className={`work-day ${date.getMonth() !== month.getMonth() ? 'outside' : ''} ${day === today ? 'today' : ''}`} key={day}><span>{date.getDate()}</span>{events.filter(event => event.day === day).map(event => <button key={event.id} className={event.reminder ? 'work-calendar-event reminder' : 'work-calendar-event'} title={`${event.reminder ? 'Напоминание' : 'Срок'}: ${event.title}`} onClick={() => setEditor(event.editor)}>{event.reminder && <Bell size={12}/>}<span>{event.title}</span></button>)}</div>; })}</div></div><p className="work-calendar-legend"><CalendarDays size={14}/>Срок задачи <Bell size={14}/>Напоминание · время вашего устройства</p></section>}

        </section>
        <aside className="work-side">
          <section className="panel work-reminders"><header className="work-section-heading"><h2><Bell size={17}/>Напоминания</h2><span>{reminders.length}</span></header>{data && <PushSettings key={data.currentUser.id} userId={data.currentUser.id}/>}<p className="work-hint">Для выполненных и архивных задач напоминания отключены.</p>{reminders.length ? <div className="work-reminder-list">{reminders.map(reminder => <button key={reminder.editor.entry!.id} className="work-reminder" onClick={() => setEditor(reminder.editor)}><strong>{reminder.title}</strong><small className={reminder.at <= new Date().toISOString() ? 'work-overdue' : ''}>{dateLabel(reminder.at)}{reminder.at <= new Date().toISOString() ? ' · наступило' : ''}</small></button>)}</div> : <p className="work-empty">Напоминаний пока нет.</p>}</section>
          <section className="panel work-notes"><header className="work-section-heading"><h2>Заметки</h2><button className="icon-button" aria-label="Добавить заметку" onClick={() => setEditor({ kind: 'notes' })}><Plus size={18}/></button></header>{data.work.notes.length ? <div className="work-note-list">{data.work.notes.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(note => <button className="work-note" key={note.id} onClick={() => setEditor({ kind: 'notes', entry: note })} aria-label={`Заметка: ${note.title}`}><strong>{note.title}</strong><p>{note.content}</p><small>{userName(note.assigneeId)}</small></button>)}</div> : <p className="work-empty">Короткие рабочие записи.</p>}</section>
        </aside>
      </div>
      {editor && <WorkEditor key={`${editor.kind}-${editor.entry?.id ?? 'new'}`} editor={editor} users={data.users} companies={data.companies} actor={data.currentUser} onClose={() => setEditor(null)} onSaved={(action, entry) => {
        request.current?.abort();
        const key = editor.kind === 'companies' ? 'companyRecords' : editor.kind;
        setData(previous => {
          if (!previous) return previous;
          const remaining = previous.work[key].filter(row => row.id !== editor.entry?.id && row.id !== entry?.id);
          return { ...previous, work: { ...previous.work, [key]: entry ? [...remaining, entry] : remaining } };
        });
        setEditor(null);
        setNotice(action === 'deleted' ? 'Запись удалена.' : action === 'archived' ? 'Задача перенесена в архив.' : action === 'restored' ? 'Задача возвращена в работу.' : 'Сохранено. Назначение доступно сотруднику в разделе «Работа».');
        void refresh();
      }}/>}
    </>}
  </div>;
}

function WorkEditor({ editor, users, companies, actor, onClose, onSaved }: { editor: Editor; users: AccountUser[]; companies: Company[]; actor: AccountUser; onClose: () => void; onSaved: (action: SavedAction, entry?: AnyWorkEntry) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), inFlight = useRef(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const entry = editor.entry, task = entry as WorkTask | undefined, record = entry as WorkCompanyRecord | undefined, note = entry as WorkNote | undefined;
  const [fields, setFields] = useState(() => ({ title: task?.title ?? '', description: task?.description ?? '', status: task?.status ?? 'todo', companyId: task?.companyId ?? '', assigneeId: entry?.assigneeId ?? actor.id, dueDate: task?.dueDate ?? '', reminderAt: localInputTime(task?.reminderAt), question: record?.question ?? '', comment: '', content: note?.content ?? '' }));
  const [files, setFiles] = useState<File[]>([]);
  const archived = !!task?.archivedAt;
  const deleteCancel = useRef<HTMLButtonElement>(null);
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [confirmDelete, setConfirmDelete] = useState(false), [dirty, setDirty] = useState(false), [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  useEffect(() => { if (confirmDelete) deleteCancel.current?.focus(); }, [confirmDelete]);
  useEffect(() => { if (!dirty) return; const prevent = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [dirty]);
  const update = (key: keyof typeof fields, value: string) => { setFields(previous => ({ ...previous, [key]: value })); setDirty(true); };
  const close = () => { if (inFlight.current) return; if (dirty) setConfirmClose(true); else onClose(); };
  const save = async (method: 'POST' | 'PATCH' | 'DELETE', nextArchived?: boolean) => {
    if (inFlight.current) return;
    if (method !== 'DELETE' && !dialog.current?.querySelector('form')?.reportValidity()) return;
    inFlight.current = true; setSaving(true); setError('');
    try {
      let body: Record<string, unknown> = { version: entry?.version };
      if (method !== 'DELETE') {
        const reminderAt = fields.reminderAt ? new Date(fields.reminderAt).toISOString() : null;
        const addAttachments = await Promise.all(files.map(async file => ({ name: file.name, data: await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Не удалось прочитать файл.')); reader.readAsDataURL(file); }) })));
        body = { ...(entry ? { version: entry.version } : { requestId }), assigneeId: fields.assigneeId, ...(editor.kind !== 'notes' ? { archived: nextArchived ?? archived, comment: fields.comment, addAttachments } : {}), ...(editor.kind === 'tasks' ? { title: fields.title, description: fields.description, status: fields.status, companyId: fields.companyId || null, dueDate: fields.dueDate || null, reminderAt } : editor.kind === 'companies' ? { companyId: fields.companyId, question: fields.question, comment: fields.comment, reminderAt } : { title: fields.title, content: fields.content }) };
      }
      const response = await fetch(`/api/work/${editor.kind}${entry ? `/${encodeURIComponent(entry.id)}` : ''}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить запись.');
      onSaved(method === 'DELETE' ? 'deleted' : nextArchived === true ? 'archived' : nextArchived === false ? 'restored' : 'saved', result.entry);
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.'); }
    finally { inFlight.current = false; setSaving(false); }
  };
  const input = (label: string, key: keyof typeof fields, options: { type?: string; required?: boolean; multiline?: boolean; max?: number } = {}) => <label className="work-field"><span>{label}{options.required ? ' *' : ''}</span>{options.multiline ? <textarea aria-label={label} value={fields[key]} rows={4} maxLength={options.max ?? 10000} required={options.required} disabled={saving} onChange={event => update(key, event.target.value)}/> : <input type={options.type ?? 'text'} aria-label={label} value={fields[key]} maxLength={options.max ?? 200} required={options.required} disabled={saving} onChange={event => update(key, event.target.value)}/>}</label>;
  const heading = editor.kind === 'tasks' ? entry ? 'Задача' : 'Новая задача' : editor.kind === 'companies' ? 'Работа с компанией' : entry ? 'Заметка' : 'Новая заметка';
  return <dialog ref={dialog} className="detail-dialog work-editor" aria-labelledby="work-editor-title" onCancel={event => { event.preventDefault(); close(); }}><form onSubmit={event => { event.preventDefault(); void save(entry ? 'PATCH' : 'POST'); }}>
    <header className="work-editor-heading"><h2 id="work-editor-title">{heading}</h2><button type="button" className="icon-button" aria-label="Закрыть рабочую запись" disabled={saving} onClick={close}><X size={20}/></button></header>
    <div className="work-editor-body">
      {editor.kind !== 'companies' && input('Название', 'title', { required: true })}
      {editor.kind === 'tasks' && input('Описание', 'description', { multiline: true })}
      {editor.kind === 'notes' && input('Текст заметки', 'content', { multiline: true })}
      {editor.kind !== 'notes' && <DirectorySelect label="Компания" entries={companies.filter(company => !company.directoryArchived || company.id === fields.companyId).map(company => ({ id: company.id, name: company.name, detail: company.inn ? `ИНН ${company.inn}` : undefined }))} value={fields.companyId} onChange={id => update('companyId', id)} disabled={saving} required={editor.kind === 'companies'} legacy={fields.companyId && !companies.some(company => company.id === fields.companyId) ? 'Компания недоступна' : undefined}/>}

      {editor.kind === 'companies' && input('Текущий вопрос', 'question', { required: true, multiline: true })}
      <div className="work-field-grid"><label className="work-field"><span>Исполнитель *</span><select aria-label="Исполнитель" value={fields.assigneeId} required disabled={saving || !entry && actor.role === 'manager'} onChange={event => update('assigneeId', event.target.value)}>{!users.some(user => user.id === fields.assigneeId) && <option value={fields.assigneeId}>Сотрудник недоступен</option>}{users.map(user => <option value={user.id} key={user.id}>{user.name}{user.id === actor.id ? ' (я)' : ''}</option>)}</select></label>{editor.kind === 'tasks' && <label className="work-field"><span>Состояние</span><select aria-label="Состояние задачи" value={fields.status} disabled={saving} onChange={event => update('status', event.target.value)}>{workStatuses.map(status => <option key={status.id} value={status.id}>{status.name}</option>)}</select></label>}
        {editor.kind === 'tasks' && input('Срок задачи', 'dueDate', { type: 'date' })}{editor.kind !== 'notes' && input('Напоминание', 'reminderAt', { type: 'datetime-local' })}
      </div>
      {actor.role === 'manager' && <p className="work-hint">{entry ? 'После передачи запись появится у выбранного сотрудника и исчезнет из ваших назначений.' : 'Новая запись назначается вам. После сохранения её можно передать сотруднику.'}</p>}
      {editor.kind !== 'notes' && <p className="work-hint">Напоминание отображается внутри приложения, время — по настройкам вашего устройства.</p>}
      {editor.kind !== 'notes' && <section className="work-comments"><h3>Комментарии</h3>{record?.comments?.map(comment => <article key={comment.id}><small>{users.find(user => user.id === comment.authorId)?.name ?? 'Сотрудник недоступен'} · {dateLabel(comment.createdAt)}</small><p>{comment.text}</p></article>)}{input('Новый комментарий', 'comment', { multiline: true })}</section>}
      {editor.kind !== 'notes' && <section className="work-files"><h3>Файлы</h3><p className="work-hint">До 1 МБ на файл, до 2 МБ и 20 файлов в карточке. Доступны сотруднику, которому назначена запись.</p>{record?.attachments?.map(file => <a key={file.id} className="work-file" href={`/api/work/${editor.kind}/${encodeURIComponent(entry!.id)}/files/${encodeURIComponent(file.id)}`} download={file.name}>{file.name} · {Math.ceil(file.size / 1024)} КБ</a>)}<label className="work-field"><span>Прикрепить файлы</span><input type="file" multiple aria-label="Прикрепить файлы" disabled={saving} onChange={event => { const selected = [...files, ...Array.from(event.target.files ?? [])]; event.target.value = ''; if (selected.some(file => file.size > workFileLimit) || selected.reduce((sum, file) => sum + file.size, 0) + (record?.attachments ?? []).reduce((sum, file) => sum + file.size, 0) > workFilesTotalLimit || selected.length + (record?.attachments?.length ?? 0) > 20) { setError('Превышен предел файлов: 1 МБ на файл, 2 МБ и 20 файлов в карточке.'); return; } setFiles(selected); setDirty(true); setError(''); }}/></label>{files.map((file, index) => <div className="work-file" key={index}>{file.name}<button type="button" className="icon-button" aria-label={`Убрать файл ${file.name}`} disabled={saving} onClick={() => setFiles(files.filter((_, i) => i !== index))}><X size={15}/></button></div>)}</section>}
      {entry && <p className="work-hint">Изменено: {dateLabel(entry.updatedAt)} · {users.find(user => user.id === entry.updatedBy)?.name ?? 'Сотрудник недоступен'}</p>}
      {error && <p className="shipment-error" role="alert">{error}</p>}
      {confirmClose && <div className="work-confirm" role="alert"><p>Закрыть без сохранения изменений?</p><button type="button" className="button" onClick={() => setConfirmClose(false)}>Продолжить редактирование</button><button type="button" className="button" onClick={onClose}>Не сохранять</button></div>}
    </div>
    <footer className="work-editor-footer">{confirmDelete ? <div className="work-confirm" role="alert"><p>Удалить «{titleFor(editor)}»? {editor.kind === 'notes' ? 'Заметку нельзя будет восстановить.' : 'Комментарии и файлы тоже будут удалены. Восстановить запись будет нельзя.'}{editor.kind === 'companies' ? ' Компания останется в справочнике.' : ''}</p><button ref={deleteCancel} type="button" className="button" disabled={saving} onClick={() => setConfirmDelete(false)}>Отмена</button><button type="button" className="button danger" disabled={saving} onClick={() => void save('DELETE')}>{saving ? 'Удаление…' : 'Удалить запись'}</button></div> : <>
      {entry && <button type="button" className="button work-delete" disabled={saving} onClick={() => setConfirmDelete(true)}><Trash2 size={16}/>Удалить</button>}
      {entry && editor.kind !== 'notes' && <button type="button" className="button" disabled={saving} onClick={() => void save('PATCH', !archived)}>{archived ? 'Вернуть в работу' : 'В архив задач'}</button>}
      <button type="button" className="button" disabled={saving} onClick={close}>Отмена</button><button className="button primary" type="submit" disabled={saving}><Save size={16}/>{saving ? 'Сохранение…' : 'Сохранить'}</button>
    </>}</footer>
  </form></dialog>;
}

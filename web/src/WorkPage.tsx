import { useDialogMotion } from './useDialogMotion'
import LoadingSkeleton, { LoadingProgress } from './LoadingSkeleton'
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Bell, Check, ChevronDown, LoaderCircle, MessageSquare, Paperclip, CalendarDays, ChevronLeft, ChevronRight, List, ListChecks, Plus, RefreshCw, Save, Send, Trash2, X } from 'lucide-react';
import { hasSection, isScopedEmployee, type AccountUser } from './auth-model';
import DirectorySelect from './DirectorySelect';
import type { Company } from './model';
import { isWorkDirectoryCompany, isClosedWorkStatus, isMyWork, workAssigneeIds, workToday, workStatuses, workFileLimit, workFilesTotalLimit, workSubtaskLimit, type WorkPriority, type WorkSubtask, type AnyWorkEntry, type WorkCompanyRecord, type WorkKind, type WorkNote, type WorkResponse, type WorkStatus, type WorkTask } from './work-model';
import './work.css';
import ScrollableSegments from './ScrollableSegments';
import { useViewEntrance } from './useViewEntrance';

type Editor = { kind: WorkKind; entry?: AnyWorkEntry; dueDate?: string; status?: WorkStatus };
const savedNotices = {
  saved: 'Сохранено.',
  archived: 'Задача перенесена в архив.',
  failed: 'Задача отмечена как невыполненная и перенесена в архив.',
  restored: 'Задача возвращена в работу.',
  deleted: 'Запись удалена.',
  'handed-off': 'Задача передана.',
};
type SavedAction = keyof typeof savedNotices;
type TaskActivity = 'comments' | 'handoff';
type EditableSubtask = WorkSubtask & { removing?: true };
type CalendarEvent = { id: string; day: string; title: string; reminder: boolean; priority?: WorkPriority; editor: Editor };
const localDay = (value: Date) => `${value.getFullYear()}-${String(value.getMonth() + 1).padStart(2, '0')}-${String(value.getDate()).padStart(2, '0')}`;
const addDays = (value: Date, days: number) => { const next = new Date(value); next.setDate(next.getDate() + days); return next; };
const weekStart = (value: Date) => addDays(new Date(value.getFullYear(), value.getMonth(), value.getDate()), -((value.getDay() + 6) % 7));
const dateLabel = (date: string | null) => date ? new Date(date.length === 10 ? `${date}T12:00:00` : date).toLocaleString('ru-RU', date.length === 10 ? { day: 'numeric', month: 'short' } : { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '';
const localInputTime = (value: string | null | undefined) => {
  if (!value) return '';
  const date = new Date(value);
  return `${localDay(date)}T${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
};

function TaskOutcome({ status }: { status: 'done' | 'failed' }) {
  return <span className={`work-task-outcome is-${status}`}>{status === 'done' ? 'Выполнена' : 'Не выполнена'}</span>;
}

function SubtaskCount({ subtasks }: { subtasks?: WorkSubtask[] }) {
  if (!subtasks?.length) return null;
  return <span className="work-subtask-count"><ListChecks size={14} aria-hidden="true"/>Подзадачи {subtasks.filter(row => row.done).length}/{subtasks.length}</span>;
}

function WorkChoice({ label, value, options, onChange, disabled = false, priority = false, placeholder = false, portalMenu = false, selectedValues }: {
  label: string;
  value: string;
  options: { value: string; name: string; disabled?: boolean }[];
  onChange: (value: string) => void;
  disabled?: boolean;
  priority?: boolean;
  placeholder?: boolean;
  portalMenu?: boolean;
  selectedValues?: readonly string[];
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 0, above: true });
  const selected = options.filter(option => selectedValues ? selectedValues.includes(option.value) : option.value === value);
  useLayoutEffect(() => {
    if (!open || !portalMenu) return;
    const place = () => {
      const host = root.current?.closest('dialog');
      const anchor = trigger.current;
      if (!host || !anchor) return;
      const dialogRect = host.getBoundingClientRect(), rect = anchor.getBoundingClientRect();
      const width = Math.min(priority ? 220 : 190, dialogRect.width - 16);
      const spaceAbove = rect.top - Math.max(dialogRect.top, 0);
      const spaceBelow = Math.min(dialogRect.bottom, window.innerHeight) - rect.bottom;
      const above = spaceAbove >= Math.min(spaceBelow, 220);
      setMenuPosition({
        top: (above ? rect.top - 5 : rect.bottom + 5) - dialogRect.top,
        left: Math.max(8, Math.min(rect.left - dialogRect.left, dialogRect.width - width - 8)),
        width, maxHeight: Math.min(220, Math.max(spaceAbove, spaceBelow) - 10), above,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, portalMenu, priority]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const focusOption = (index: number) => {
    const choices = Array.from((menu.current ?? root.current)?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
    choices[(index + choices.length) % choices.length]?.focus();
  };
  const choices = <div ref={menu} id={`${id}-options`} className={`work-choice-options${portalMenu ? ` work-choice-portal${menuPosition.above ? '' : ' is-below'}` : ''}`} role="listbox" aria-multiselectable={selectedValues ? true : undefined} aria-labelledby={`${id}-label`} style={portalMenu ? { top: menuPosition.top, left: menuPosition.left, width: menuPosition.width, maxHeight: menuPosition.maxHeight } : undefined} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const available = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
      focusOption(available.indexOf(document.activeElement as HTMLButtonElement) + (event.key === 'ArrowDown' ? 1 : -1));
    }
  }}>{options.map(option => <button key={option.value} type="button" role="option" aria-selected={selected.includes(option)} disabled={option.disabled} onClick={() => { onChange(option.value); if (!selectedValues) { setOpen(false); trigger.current?.focus(); } }}>
      {priority && <span className={`work-priority-dot work-priority-${option.value}`} aria-hidden="true"/>}
      <span>{option.name}</span>{selected.includes(option) && <Check size={15} aria-hidden="true"/>}
    </button>)}</div>;
  const host = portalMenu ? root.current?.closest('dialog') : null;
  return <div ref={root} className={`work-field work-choice${priority ? ' work-priority-field' : ''}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !menu.current?.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && open) {
      event.preventDefault();
      const available = Array.from((menu.current ?? root.current)?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
      const current = available.indexOf(document.activeElement as HTMLButtonElement);
      focusOption(current < 0 ? (event.key === 'ArrowDown' ? 0 : available.length - 1) : current + (event.key === 'ArrowDown' ? 1 : -1));
    }
  }}>
    <span id={`${id}-label`}>{label}</span>
    <button ref={trigger} type="button" className={`work-choice-trigger${placeholder ? ' is-placeholder' : ''}`} role="combobox" aria-labelledby={`${id}-label`} aria-controls={`${id}-options`} aria-expanded={open} aria-haspopup="listbox" disabled={disabled} onClick={() => setOpen(previous => !previous)} onKeyDown={event => {
      if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !open) { event.preventDefault(); setOpen(true); requestAnimationFrame(() => focusOption(event.key === 'ArrowDown' ? 0 : options.length - 1)); }
    }}>
      {priority && !placeholder && <span className={`work-priority-dot work-priority-${value}`} aria-hidden="true"/>}
      <span className="work-choice-value" title={selected.map(option => option.name).join(', ')}>{placeholder ? label.replace(' *', '') : selected.map(option => option.name).join(', ') || label}</span>
      <ChevronDown size={15} aria-hidden="true"/>
    </button>
    {open && (host ? createPortal(choices, host) : choices)}
  </div>;
}

export default function WorkPage({ onTaskCount }: { onTaskCount: (count: number) => void }) {
  const [data, setData] = useState<WorkResponse | null>(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(''), [notice, setNotice] = useState('');
  const [filter, setFilter] = useState(''), [view, setView] = useState<'board' | 'kanban' | 'calendar' | 'archive'>('board');
  const [listScope, setListScope] = useState<'all' | 'today' | 'upcoming'>('all');
  const taskTargets = '.work-week-heading > strong, .work-week-days, .work-date-group > h3, .work-task-row, .work-company-list > .work-empty';
  const workMain = useViewEntrance<HTMLElement>(`${view}:${listScope}`, view === 'calendar'
    ? '.work-calendar-heading > h2, .work-calendar-scroll, .work-calendar-legend'
    : view === 'kanban' ? '.work-lane'
    : `${view === 'archive' ? '.work-section-heading h2, ' : ''}${taskTargets}`, 6);
  const [selectedWeek, setSelectedWeek] = useState(() => weekStart(new Date()));
  const [draggedTask, setDraggedTask] = useState<string | null>(null), [dropStatus, setDropStatus] = useState<WorkStatus | null>(null), [movingTask, setMovingTask] = useState<string | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const [month, setMonth] = useState(() => new Date(new Date().getFullYear(), new Date().getMonth(), 1));
  const request = useRef<AbortController | null>(null), active = useRef(true);
  const completing = useRef(new Set<string>());
  const editorSaving = useRef(false);
  const openEditor = (next: Editor) => { if (!editorSaving.current) setEditor(next); };
  const navigate = (update: () => void) => { if (!editorSaving.current) update(); };
  const [pendingTasks, setPendingTasks] = useState<Record<string, WorkTask['status']>>({});
  const [taskErrors, setTaskErrors] = useState<Record<string, string>>({});
  const refresh = useCallback(async (visible = false) => {
    if (completing.current.size || editorSaving.current) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    if (visible) setLoading(true);
    try {
      const response = await fetch(`/api/work${filter ? `?assigneeId=${encodeURIComponent(filter)}` : ''}`, { signal: controller.signal, cache: 'no-store' });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось загрузить рабочее пространство.');
      if (!controller.signal.aborted && active.current) { setData(result); onTaskCount(result.todayTaskCount); setError(''); setTaskErrors({}); }
    } catch (reason) {
      if (!controller.signal.aborted && active.current) setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.');
    } finally { if (!controller.signal.aborted && active.current) setLoading(false); }
  }, [filter, onTaskCount]);
  useEffect(() => {
    active.current = true;
    void refresh(true);
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(onVisible, 30000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { active.current = false; request.current?.abort(); window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
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
  const toggleTask = async (task: WorkTask) => {
    if (completing.current.has(task.id)) return;
    const status = isClosedWorkStatus(task.status) ? 'todo' : 'done';
    completing.current.add(task.id);
    request.current?.abort(); setLoading(false);
    setPendingTasks(previous => ({ ...previous, [task.id]: status }));
    setTaskErrors(previous => { const next = { ...previous }; delete next[task.id]; return next; });
    try {
      const response = await fetch(`/api/work/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: task.version, status, archived: isClosedWorkStatus(status) }), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить. Обновите список и повторите.');
      if (active.current) {
        onTaskCount(result.todayTaskCount);
        setData(previous => previous ? { ...previous, work: { ...previous.work, tasks: previous.work.tasks.map(row => row.id === task.id && row.version <= result.entry.version ? result.entry : row) } } : previous);
      }
    } catch (reason) {
      if (active.current) setTaskErrors(previous => ({ ...previous, [task.id]: reason instanceof Error && reason.name !== 'TimeoutError' && reason.name !== 'TypeError' ? reason.message : 'Не удалось подтвердить сохранение. Обновите список перед повтором.' }));
    } finally {
      completing.current.delete(task.id);
      if (active.current) setPendingTasks(previous => { const next = { ...previous }; delete next[task.id]; return next; });
    }
  };
  const moveTask = async (task: WorkTask, status: WorkStatus) => {
    if (movingTask || completing.current.has(task.id) || task.status === status) return;
    completing.current.add(task.id);
    setMovingTask(task.id); setError('');
    request.current?.abort(); setLoading(false);
    try {
      const response = await fetch(`/api/work/tasks/${encodeURIComponent(task.id)}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ version: task.version, status, archived: isClosedWorkStatus(status) }), signal: AbortSignal.timeout(20000) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось изменить состояние задачи.');
      if (active.current) {
        onTaskCount(result.todayTaskCount);
        setData(previous => previous ? { ...previous, work: { ...previous.work, tasks: previous.work.tasks.map(row => row.id === task.id && row.version <= result.entry.version ? result.entry : row) } } : previous);
      }
    } catch (reason) {
      if (active.current) setError(reason instanceof Error ? reason.message : 'Не удалось подтвердить изменение. Обновите список.');
    } finally { completing.current.delete(task.id); if (active.current) { setMovingTask(null); setDraggedTask(null); setDropStatus(null); } }
  };
  const userName = (id: string) => [...(data?.users ?? []), ...(data?.historicalUsers ?? [])].find(user => user.id === id)?.name ?? 'Сотрудник недоступен';
  const assigneeNames = (row: AnyWorkEntry) => workAssigneeIds(row).map(userName).join(', ');
  const companyName = (id: string | null) => data?.companies.find(company => company.id === id)?.name ?? (id ? 'Компания недоступна' : '');
  const isManager = !!data && isScopedEmployee(data.currentUser);
  const work = data?.work;
  const today = workToday();
  const events: CalendarEvent[] = [];
  for (const task of (work?.tasks ?? []).filter(task => !task.archivedAt)) {
    if (task.dueDate) events.push({ id: `${task.id}-due`, day: task.dueDate, title: task.title, priority: task.priority ?? 4, reminder: false, editor: { kind: 'tasks', entry: task } });
    if (task.reminderAt) events.push({ id: `${task.id}-reminder`, day: localDay(new Date(task.reminderAt)), title: task.title, priority: task.priority ?? 4, reminder: true, editor: { kind: 'tasks', entry: task } });
  }
  for (const row of work?.companyRecords ?? []) if (row.reminderAt && !row.archivedAt) events.push({ id: row.id, day: localDay(new Date(row.reminderAt)), title: companyName(row.companyId), reminder: true, editor: { kind: 'companies', entry: row } });
  const records: Editor[] = [
    ...(work?.tasks ?? []).map(entry => ({ kind: 'tasks' as const, entry })),
    ...(work?.companyRecords ?? []).map(entry => ({ kind: 'companies' as const, entry })),
  ].filter(item => {
    const row = item.entry as WorkTask | WorkCompanyRecord;
    if (!!row.archivedAt !== (view === 'archive')) return false;
    if (view !== 'board' || listScope === 'all') return true;
    if (item.kind !== 'tasks') return false;
    const due = (row as WorkTask).dueDate;
    return listScope === 'today' ? !!due && due <= today : !!due && due >= localDay(selectedWeek) && due <= localDay(addDays(selectedWeek, 6));
  }).sort((a, b) => {
    if (view === 'board' && listScope !== 'all') {
      const dates = ((a.entry as WorkTask).dueDate ?? '').localeCompare((b.entry as WorkTask).dueDate ?? '');
      if (dates) return dates;
    }
    return (view === 'archive' ? (b.entry as WorkTask).archivedAt! : b.entry!.createdAt).localeCompare(view === 'archive' ? (a.entry as WorkTask).archivedAt! : a.entry!.createdAt) || a.entry!.id.localeCompare(b.entry!.id);
  });
  const weekDays = Array.from({ length: 7 }, (_, index) => addDays(selectedWeek, index));
  const renderRecord = (item: Editor) => {
    const row = item.entry as WorkTask | WorkCompanyRecord;
    const task = 'title' in row ? row : null;
    const pending = Object.hasOwn(pendingTasks, row.id);
    const status = task ? pendingTasks[row.id] ?? task.status : null;
    return <div key={row.id} className={task ? `work-task-row${status === 'done' ? ' is-done' : ''}${pending ? ' is-saving' : ''}` : 'work-record-row'}>
      {task && (task.status === 'failed' ? <button type="button" className="work-task-check work-task-reopen" aria-label={`Вернуть в работу: ${task.title}`} title="Вернуть в работу" disabled={pending} onClick={() => void toggleTask(task)}>
        <span className="work-task-check-box" aria-hidden="true"><X size={15} strokeWidth={2.5}/></span>
      </button> : <label className={`work-task-check work-priority-${task.priority ?? 4}`} title={status === 'done' ? 'Вернуть в работу' : 'Выполнить задачу'}>
        <input type="checkbox" aria-label={`Выполнена: ${task.title}`} checked={status === 'done'} disabled={pending} onChange={() => void toggleTask(task)}/>
        <span className="work-task-check-box" aria-hidden="true"><Check size={16} strokeWidth={3}/></span>
      </label>)}
      <div className="work-task-content">
        <button className={task ? 'work-task-open' : 'work-company-row'} disabled={pending} onClick={() => openEditor(item)} aria-label={task ? `Задача: ${task.title}` : `Работа с компанией: ${companyName(row.companyId)}`}>
          <strong>{task ? task.title : (row as WorkCompanyRecord).question}</strong>
          {row.companyId && <span className="work-task-company">{companyName(row.companyId)}</span>}
          {task?.description && <span className="work-task-description">{task.description}</span>}
          <span className="work-task-meta">{status && isClosedWorkStatus(status) && <TaskOutcome status={status}/>}<span>{assigneeNames(row)}</span><SubtaskCount subtasks={task?.subtasks}/>{!!row.comments?.length && <span><MessageSquare size={13}/>Комментарии: {row.comments.length}</span>}{!!row.attachments?.length && <span><Paperclip size={13}/>Файлы: {row.attachments.length}</span>}{row.reminderAt && <span><Bell size={13}/>{dateLabel(row.reminderAt)}</span>}</span>
        </button>
        {taskErrors[row.id] && <p className="work-task-error" role="alert">{taskErrors[row.id]} <button type="button" onClick={() => void refresh()}>Обновить</button></p>}
      </div>
      {task && pending && <span className="work-task-status" role="status"><LoaderCircle size={13} className="spin"/>Сохраняем…</span>}
    </div>;
  };
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const start = new Date(first); start.setDate(1 - (first.getDay() + 6) % 7);
  const days = Array.from({ length: 42 }, (_, index) => { const date = new Date(start); date.setDate(start.getDate() + index); return date; });
  const updateWorkList = (edited: Editor, entry?: AnyWorkEntry) => {
    request.current?.abort();
    const key = edited.kind === 'companies' ? 'companyRecords' : edited.kind;
    setData(previous => {
      if (!previous) return previous;
      const remaining = previous.work[key].filter(row => row.id !== edited.entry?.id && row.id !== entry?.id);
      const actor = previous.currentUser;
      const visible = entry && (!isScopedEmployee(actor) || isMyWork(entry, actor.id)) &&
        (!filter || (filter === 'mine' ? isMyWork(entry, actor.id) : workAssigneeIds(entry).includes(filter)));
      return { ...previous, work: { ...previous.work, [key]: visible ? [...remaining, entry] : remaining } };
    });
  };
  const renderEditor = () => data && editor && <WorkEditor key={`${editor.kind}-${editor.entry?.id ?? 'new'}`} editor={editor} users={data.users} historicalUsers={data.historicalUsers ?? []} companies={data.companies} actor={data.currentUser}
    onSaving={value => { editorSaving.current = value; if (value) { request.current?.abort(); setLoading(false); } }}
    onClose={() => setEditor(null)} onTaskCount={onTaskCount} onCommentSaved={entry => updateWorkList(editor, entry)}
    onSaved={(action, entry) => {
      updateWorkList(editor, entry);
      if (action === 'handed-off' && view === 'archive') {
        setListScope('all');
        setView('board');
      }
      setEditor(null);
      setNotice(savedNotices[action]);
    }}/>;
  return <div className="work-page">
    <div className="work-view-toolbar">
      <ScrollableSegments className="work-views" label="Представление работы" value={view}><button className={`button ${view === 'board' ? 'primary' : ''}`} aria-pressed={view === 'board'} onClick={() => { if (view !== 'board') navigate(() => setView('board')); }}><List size={17}/>Задачи</button><button className={`button ${view === 'calendar' ? 'primary' : ''}`} aria-pressed={view === 'calendar'} onClick={() => { if (view !== 'calendar') navigate(() => setView('calendar')); }}><CalendarDays size={17}/>Календарь</button><button className={`button ${view === 'archive' ? 'primary' : ''}`} aria-pressed={view === 'archive'} onClick={() => { if (view !== 'archive') navigate(() => setView('archive')); }}>Архив задач</button></ScrollableSegments>
      <div className="work-assignee">{isManager ? <span className="work-filter-caption">Мои записи</span> : <select className="filter-select" aria-label="Фильтр исполнителя" disabled={Object.keys(pendingTasks).length > 0} value={filter} onChange={event => setFilter(event.target.value)}><option value="">Все сотрудники</option><option value="mine">Мои записи</option>{data?.users.map(user => <option key={user.id} value={user.id}>{user.name}</option>)}</select>}</div>
      <div className="work-toolbar-actions"><button className="button work-refresh mobile-icon-action" disabled={loading} onClick={() => void refresh(true)} aria-label="Обновить работу" title="Обновить работу"><RefreshCw size={16} aria-hidden="true" className={loading ? 'spin' : ''}/><span className="mobile-action-label">Обновить</span></button>
      </div>
    </div>
    {notice && <p className="work-notice" role="status">{notice}</p>}
    {error && <p className="shipment-error" role="alert">{error}</p>}
    {!data && (loading ? <LoadingSkeleton label="Загружаем рабочее пространство" variant={view === 'calendar' ? 'work-calendar' : 'work'} rows={4}/> : <div className="panel work-empty">Данные не загружены. Нажмите «Обновить».</div>)}
    {data && loading && <LoadingProgress label="Обновляем рабочее пространство"/>}
    {data && <>
      <div className="work-layout view-entrance">
        <section ref={workMain} className="work-main" aria-label={view === 'calendar' ? 'Календарь задач' : 'Задачи'}>
          {view === 'kanban' ? <div className="work-board" aria-label="Канбан состояний задач">{workStatuses.map(status => {
            const tasks = (work?.tasks ?? []).filter(task => task.status === status.id && (isClosedWorkStatus(status.id) || !task.archivedAt)).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
            return <section key={status.id} className={`work-lane work-lane-${status.id}${dropStatus === status.id ? ' work-lane-drop' : ''}`} aria-label={status.name} onDragOver={event => { if (draggedTask && !movingTask) { event.preventDefault(); setDropStatus(status.id); } }} onDragLeave={event => { if (!event.currentTarget.contains(event.relatedTarget as Node)) setDropStatus(null); }} onDrop={event => { event.preventDefault(); const task = work?.tasks.find(row => row.id === draggedTask); if (task) void moveTask(task, status.id); }}>
              <header><h2>{status.name}</h2><span>{tasks.length}</span></header><div className="work-cards">{tasks.map(task => <div key={task.id} className={`work-kanban-card${movingTask === task.id ? ' is-moving' : ''}`} draggable={!movingTask} onDragStart={event => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('text/plain', task.id); setDraggedTask(task.id); }} onDragEnd={() => { setDraggedTask(null); setDropStatus(null); }}><button className="work-card" onClick={() => openEditor({ kind: 'tasks', entry: task })}><strong>{task.title}</strong>{task.description && <p>{task.description}</p>}<SubtaskCount subtasks={task.subtasks}/><small>{companyName(task.companyId) || 'Без компании'} · {assigneeNames(task)}</small>{task.dueDate && <span className={`work-card-footer${task.dueDate < today && !isClosedWorkStatus(task.status) ? ' work-overdue' : ''}`}><CalendarDays size={13}/>{dateLabel(task.dueDate)}</span>}</button><select aria-label={`Состояние задачи: ${task.title}`} value={task.status} disabled={!!movingTask} onChange={event => void moveTask(task, event.target.value as WorkStatus)}>{workStatuses.map(option => <option key={option.id} value={option.id}>{option.name}</option>)}</select></div>)}{!tasks.length && <p className="work-empty-lane">Перетащите задачу сюда</p>}{<button className="work-add-lane" onClick={() => openEditor({ kind: 'tasks', status: status.id })}><Plus size={16}/>Добавить задачу</button>}</div>
            </section>;
          })}</div> : view !== 'calendar' ? <section className="panel work-companies"><header className="work-section-heading"><div><h2>{view === 'archive' ? 'Архив задач' : listScope === 'today' ? 'Сегодня' : listScope === 'upcoming' ? 'Предстоящие' : 'Задачи'}</h2></div>{view !== 'archive' && <button className="button primary mobile-icon-action" aria-label="Новая задача" title="Новая задача" onClick={() => openEditor({ kind: 'tasks', dueDate: listScope === 'today' ? today : undefined })}><Plus size={17} aria-hidden="true"/><span className="mobile-action-label">Новая задача</span></button>}</header>
            {view === 'board' && <div className="work-list-controls"><ScrollableSegments className="work-list-scopes" label="Период задач" value={listScope}><button type="button" aria-pressed={listScope === 'all'} onClick={() => { if (listScope !== 'all') navigate(() => setListScope('all')); }}>Все</button><button type="button" aria-pressed={listScope === 'today'} onClick={() => { if (listScope !== 'today') navigate(() => setListScope('today')); }}>Сегодня</button><button type="button" aria-pressed={listScope === 'upcoming'} onClick={() => { if (listScope !== 'upcoming') navigate(() => { setListScope('upcoming'); setSelectedWeek(weekStart(new Date())); }); }}>Предстоящие</button></ScrollableSegments></div>}
            {view === 'board' && listScope === 'upcoming' && <div className="work-week"><div className="work-week-heading"><strong>{selectedWeek.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</strong><div><button type="button" className="icon-button" aria-label="Предыдущая неделя" onClick={() => navigate(() => setSelectedWeek(addDays(selectedWeek, -7)))}><ChevronLeft size={18}/></button><button type="button" className="button" onClick={() => navigate(() => setSelectedWeek(weekStart(new Date())))}>Сегодня</button><button type="button" className="icon-button" aria-label="Следующая неделя" onClick={() => navigate(() => setSelectedWeek(addDays(selectedWeek, 7)))}><ChevronRight size={18}/></button></div></div><div className="work-week-days">{weekDays.map(date => { const day = localDay(date); return <button type="button" key={day} className={day === today ? 'is-today' : ''} onClick={() => document.getElementById(`work-day-${day}`)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>{date.toLocaleDateString('ru-RU', { weekday: 'short' })}<strong>{date.getDate()}</strong></button>; })}</div></div>}
            <div className="work-company-list">{view === 'board' && listScope === 'upcoming' ? weekDays.map(date => { const day = localDay(date); return <section className="work-date-group" id={`work-day-${day}`} key={day}><h3>{date.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', weekday: 'long' })}{day === today ? ' · Сегодня' : ''}</h3>{records.filter(item => (item.entry as WorkTask).dueDate === day).map(renderRecord)}{<button className="work-add-day" onClick={() => openEditor({ kind: 'tasks', dueDate: day })}><Plus size={16}/>Добавить задачу</button>}</section>; }) : <>{records.map(renderRecord)}{!records.length && <p className="work-empty">{view === 'archive' ? 'В архиве пока нет задач.' : listScope === 'today' ? 'На сегодня и ранее незавершённых задач нет.' : 'Задач пока нет.'}</p>}{view === 'board' && (<button className="work-add-day" onClick={() => openEditor({ kind: 'tasks', dueDate: listScope === 'today' ? today : undefined })}><Plus size={16}/>{listScope === 'today' ? 'Добавить задачу на сегодня' : 'Добавить задачу'}</button>)}</>}</div></section> : <section className="panel work-calendar"><header className="work-calendar-heading"><h2>{month.toLocaleDateString('ru-RU', { month: 'long', year: 'numeric' })}</h2><div><button className="icon-button" aria-label="Предыдущий месяц" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))}><ChevronLeft size={18}/></button><button className="button" onClick={() => setMonth(new Date(new Date().getFullYear(), new Date().getMonth(), 1))}>Сегодня</button><button className="icon-button" aria-label="Следующий месяц" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))}><ChevronRight size={18}/></button></div></header><div className="work-calendar-scroll"><div className="work-calendar-grid">{['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'].map(day => <strong className="work-weekday" key={day}>{day}</strong>)}{days.map(date => { const day = localDay(date); return <div className={`work-day ${date.getMonth() !== month.getMonth() ? 'outside' : ''} ${day === today ? 'today' : ''}`} key={day}><span>{date.getDate()}</span>{events.filter(event => event.day === day).map(event => <button key={event.id} className={`work-calendar-event${event.reminder ? ' reminder' : ''}${event.priority ? ` work-priority-${event.priority}` : ''}`} title={`${event.reminder ? 'Напоминание' : 'Срок'}: ${event.title}`} onClick={() => openEditor(event.editor)}>{event.reminder && <Bell size={12}/>}<span>{event.title}</span></button>)}</div>; })}</div></div><p className="work-calendar-legend"><CalendarDays size={14}/>Срок задачи <Bell size={14}/>Напоминание · время вашего устройства</p></section>}

        </section>
        <aside className="work-side" aria-label="Заметки">

          <section className="panel work-notes"><header className="work-section-heading"><h2>Заметки</h2><button className="icon-button" aria-label="Добавить заметку" onClick={() => openEditor({ kind: 'notes' })}><Plus size={18}/></button></header>{data.work.notes.length ? <div className="work-note-list">{data.work.notes.slice().sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(note => <button className="work-note" key={note.id} onClick={() => openEditor({ kind: 'notes', entry: note })} aria-label={`Заметка: ${note.title}`}><strong>{note.title}</strong><p>{note.content}</p><small>{userName(note.assigneeId)}</small></button>)}</div> : <p className="work-empty">Заметок пока нет.</p>}</section>
        </aside>
      </div>
      {editor && renderEditor()}
    </>}
  </div>;
}

function WorkEditor({ editor, users, historicalUsers, companies, actor, onSaving, onClose: onDismiss, onSaved, onCommentSaved, onTaskCount }: { editor: Editor; users: AccountUser[]; historicalUsers: Pick<AccountUser, 'id' | 'name'>[]; companies: Company[]; actor: AccountUser; onSaving: (saving: boolean) => void; onClose: () => void; onSaved: (action: SavedAction, entry?: AnyWorkEntry) => void; onCommentSaved: (entry: WorkTask) => void; onTaskCount: (count: number) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), inFlight = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const focusSubtask = useRef<string | null>(null);
  const addedSubtask = useRef<HTMLLIElement>(null);
  const addSubtaskButton = useRef<HTMLButtonElement>(null);
  const errorMessage = useRef<HTMLParagraphElement>(null);
  const userName = (id: string) => [...users, ...historicalUsers].find(user => user.id === id)?.name ?? 'Сотрудник недоступен';
  const [requestId] = useState(() => crypto.randomUUID());
  const [entry, setEntry] = useState(editor.entry);
  const task = editor.kind === 'tasks' ? entry as WorkTask | undefined : undefined;
  const record = editor.kind === 'companies' ? entry as WorkCompanyRecord | undefined : task;
  const note = entry as WorkNote | undefined;
  const [assignees, setAssignees] = useState(() => task ? [...workAssigneeIds(task)] : []);
  const [activity, setActivity] = useState<TaskActivity | null>(null);
  const [handoffTo, setHandoffTo] = useState<string[]>([]);
  const [handoffComment, setHandoffComment] = useState('');
  const [latestCommentId, setLatestCommentId] = useState<string>();
  const [revealedCommentId, setRevealedCommentId] = useState<string>();
  const waitingCommentId = latestCommentId === revealedCommentId ? undefined : latestCommentId;
  const latestCommentAnchor = useRef<HTMLSpanElement>(null);
  const activityId = useId();
  const activityFrame = useRef<HTMLDivElement>(null);
  const activityHeight = useRef<number | undefined>(undefined);
  const activityResize = useRef<Animation | null>(null);
  const measureActivity = () => {
    const frame = activityFrame.current;
    activityHeight.current = frame ? parseFloat(getComputedStyle(frame).height) : undefined;
  };
  const toggleActivity = (panel: TaskActivity) => {
    measureActivity();
    setActivity(current => current === panel ? null : panel);
  };
  useLayoutEffect(() => {
    const frame = activityFrame.current;
    const start = activityHeight.current;
    activityHeight.current = undefined;
    activityResize.current?.cancel();
    activityResize.current = null;
    if (!frame || start === undefined || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const styles = getComputedStyle(frame);
    const end = parseFloat(styles.height);
    if (start !== end) {
      activityResize.current = frame.animate([{ height: `${start}px` }, { height: `${end}px` }], {
        duration: parseFloat(styles.getPropertyValue('--work-activity-duration')),
        easing: 'ease-in-out',
      });
    }
  }, [activity, latestCommentId]);
  useEffect(() => () => activityResize.current?.cancel(), []);
  useEffect(() => {
    const anchor = latestCommentAnchor.current;
    const viewport = anchor?.closest('.work-editor-body');
    if (activity !== 'comments' || !waitingCommentId || !anchor || !viewport) return;

    // Watch the icon so a long comment can animate as soon as its top is visible.
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry.isIntersecting || entry.intersectionRatio < 1) return;
      observer.disconnect();
      setRevealedCommentId(waitingCommentId);
    }, { root: viewport, threshold: 1 });
    observer.observe(anchor);
    anchor.scrollIntoView({
      block: 'nearest',
      inline: 'nearest',
      behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth',
    });
    return () => observer.disconnect();
  }, [activity, waitingCommentId]);
  const taskUsers = users.filter(user => hasSection(user, 'work'));
  const handoffUsers = taskUsers.filter(user => user.id !== actor.id);
  const assigneeOptions = [
    ...assignees.filter(id => !taskUsers.some(user => user.id === id)).map(id => ({ value: id, name: `${userName(id)} · доступ отключён` })),
    ...taskUsers.map(user => ({ value: user.id, name: `${user.name}${user.id === actor.id ? ' (я)' : ''}` })),
  ];
  const [fields, setFields] = useState(() => ({ title: task?.title ?? note?.title ?? '', description: task?.description ?? '', priority: String(task?.priority ?? 4), companyId: record?.companyId ?? '', assigneeId: entry?.assigneeId ?? actor.id, dueDate: task?.dueDate ?? editor.dueDate ?? '', reminderAt: localInputTime(record?.reminderAt), question: record && 'question' in record ? record.question : '', comment: '', content: note?.content ?? '' }));
  const [priorityChosen, setPriorityChosen] = useState(false);
  const [files, setFiles] = useState<File[]>([]);
  const [subtasks, setSubtasks] = useState<EditableSubtask[]>(() => task?.subtasks ?? []);
  const activeSubtasks = subtasks.filter(row => !row.removing);
  const archived = !!record?.archivedAt;
  const [saving, setSaving] = useState(false), [error, setError] = useState('');
  const [pendingAction, setPendingAction] = useState<SavedAction | 'comment' | null>(null);
  const motion = useDialogMotion(dialog, onDismiss);
  const onClose = motion.close;

  const addSubtask = () => {
    const id = crypto.randomUUID();
    focusSubtask.current = id;
    setSubtasks(current => [...current, { id, title: '', done: false }]);
  };
  useLayoutEffect(() => {
    const row = addedSubtask.current;
    if (!focusSubtask.current || !row) return;
    focusSubtask.current = null;
    const input = row.querySelector<HTMLInputElement>('.work-subtask-title');
    input?.focus({ preventScroll: true });
    input?.scrollIntoView({ block: 'nearest' });
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    const styles = getComputedStyle(row);
    row.animate([{ height: '0px', opacity: 0 }, { height: styles.height, opacity: 1 }], {
      duration: parseFloat(styles.getPropertyValue('--work-subtask-duration')),
      easing: styles.getPropertyValue('--motion-ease').trim(),
    });
  }, [subtasks]);
  const removeSubtask = (id: string, button: HTMLButtonElement) => {
    addSubtaskButton.current?.focus({ preventScroll: true });
    const remove = () => setSubtasks(current => current.filter(row => row.id !== id));
    const row = button.closest('li');
    if (!row || matchMedia('(prefers-reduced-motion: reduce)').matches) {
      remove();
      return;
    }

    const styles = getComputedStyle(row);
    const start = { height: styles.height, opacity: styles.opacity };
    const duration = parseFloat(styles.getPropertyValue('--work-subtask-duration'));
    const easing = styles.getPropertyValue('--motion-ease').trim();
    row.getAnimations().forEach(animation => animation.cancel());
    setSubtasks(current => current.map(row => row.id === id ? { ...row, removing: true } : row));
    const exit = row.animate([start, { height: '0px', opacity: 0 }], { duration, easing, fill: 'forwards' });
    void exit.finished.then(remove, remove);
  };
  useEffect(() => { if (error) { errorMessage.current?.focus({ preventScroll: true }); errorMessage.current?.scrollIntoView({ block: 'nearest' }); } }, [error]);
  const update = (key: keyof typeof fields, value: string) => { setFields(previous => ({ ...previous, [key]: value })) };
  const close = () => { if (!inFlight.current) onClose(); };
  const save = async (method: 'POST' | 'PATCH' | 'DELETE', { nextArchived, activityAction, nextStatus }: {
    nextArchived?: boolean;
    activityAction?: 'comment' | 'handed-off';
    nextStatus?: WorkStatus;
  } = {}) => {
    const postingComment = activityAction === 'comment';
    const handingOff = activityAction === 'handed-off';
    if (inFlight.current) return;
    if (method !== 'DELETE' && !postingComment && !formRef.current?.reportValidity()) return;
    inFlight.current = true; onSaving(true); setSaving(true); setError('');
    const action = activityAction ?? (
      method === 'DELETE' ? 'deleted'
        : nextStatus === 'failed' ? 'failed'
        : nextStatus === 'done' || nextArchived === true ? 'archived'
        : nextArchived === false ? 'restored'
        : 'saved'
    );
    setPendingAction(action);
    try {
      let body: Record<string, unknown> = { version: entry?.version };
      if (postingComment) {
        body.comment = fields.comment;
      } else if (method !== 'DELETE') {
        const reminderAt = fields.reminderAt === localInputTime(record?.reminderAt)
          ? record?.reminderAt ?? null
          : fields.reminderAt ? new Date(fields.reminderAt).toISOString() : null;
        const addAttachments = await Promise.all(files.map(async file => ({ name: file.name, data: await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result).split(',')[1]); reader.onerror = () => reject(new Error('Не удалось прочитать файл.')); reader.readAsDataURL(file); }) })));
        const identity = entry ? { version: entry.version } : { requestId };
        const recordFields = { comment: handingOff ? handoffComment : fields.comment, addAttachments, reminderAt };
        if (editor.kind === 'tasks') {
          body = {
            ...identity, ...recordFields,
            title: fields.title, description: fields.description,
            priority: Number(fields.priority), companyId: fields.companyId || null, dueDate: fields.dueDate || null,
            ...(activeSubtasks.length || task?.subtasks ? { subtasks: activeSubtasks } : {}),
            ...(handingOff
              ? { handoff: true, assigneeIds: handoffTo }
              : { assigneeIds: assignees, status: nextStatus ?? task?.status ?? editor.status ?? 'todo', archived: nextArchived ?? archived }),
          };
        } else if (editor.kind === 'companies') {
          body = { ...identity, ...recordFields, assigneeId: fields.assigneeId, companyId: fields.companyId, question: fields.question, archived: nextArchived ?? archived };
        } else {
          body = { ...identity, title: fields.title, content: fields.content };
        }
      }
      const response = await fetch(`/api/work/${editor.kind}${entry ? `/${encodeURIComponent(entry.id)}` : ''}`, { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || (method === 'DELETE' ? 'Не удалось удалить запись.' : 'Не удалось сохранить запись.'));
      onTaskCount(result.todayTaskCount);
      if (postingComment) {
        measureActivity();
        setLatestCommentId((result.entry as WorkTask).comments?.at(-1)?.id);
        setEntry(result.entry);
        update('comment', '');
        onCommentSaved(result.entry);
      } else {
        await motion.complete(() => onSaved(action as SavedAction, result.entry));
      }
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.'); }
    finally { inFlight.current = false; onSaving(false); setSaving(false); setPendingAction(null); }
  };
  const isNote = editor.kind === 'notes';
  const input = (label: string, key: keyof typeof fields, options: { type?: string; required?: boolean; multiline?: boolean; max?: number; placeholder?: string; hideLabel?: boolean } = {}) => <label className="work-field">{!options.hideLabel && <span>{label}{options.required ? ' *' : ''}</span>}{options.multiline ? <textarea aria-label={label} placeholder={options.placeholder} value={fields[key]} rows={4} maxLength={options.max ?? 10000} required={options.required} disabled={saving} onChange={event => update(key, event.target.value)}/> : <input type={options.type ?? 'text'} aria-label={label} placeholder={options.placeholder} value={fields[key]} maxLength={options.max ?? 200} required={options.required} disabled={saving} onChange={event => update(key, event.target.value)}/>}</label>;
  const compactDate = (label: string, key: 'dueDate' | 'reminderAt', type: 'date' | 'datetime-local') => <label className={`work-field work-compact-date${fields[key] ? ' has-value' : ''}`}><span className="work-accessible-label">{label}</span><input type={type} aria-label={label} value={fields[key]} disabled={saving} onClick={event => event.currentTarget.showPicker?.()} onChange={event => update(key, event.target.value)}/>{!fields[key] && <span className="work-date-placeholder" aria-hidden="true">{label}</span>}</label>;
  const heading = editor.kind === 'tasks' ? entry ? 'Задача' : 'Новая задача' : editor.kind === 'companies' ? 'Работа с компанией' : entry ? 'Заметка' : 'Новая заметка';
  const companyField = editor.kind !== 'notes' && <DirectorySelect label="Компания" placeholder="Компания" portalMenu={editor.kind === 'tasks'} entries={companies.filter(company => isWorkDirectoryCompany(company) || company.id === record?.companyId).map(company => ({ id: company.id, name: company.name, detail: company.inn ? `ИНН ${company.inn}` : undefined }))} value={fields.companyId} onChange={id => update('companyId', id)} disabled={saving} required={editor.kind === 'companies'} legacy={fields.companyId && !companies.some(company => company.id === fields.companyId) ? 'Компания недоступна' : undefined}/>;
  const taskParameters = <div className={editor.kind === 'tasks' ? 'work-task-parameters' : 'work-other-parameters'}>
      {editor.kind !== 'tasks' && companyField}
      <div className="work-field-grid">{editor.kind === 'tasks' ? <WorkChoice label="Исполнители" value="" selectedValues={assignees} portalMenu disabled={saving}
        onChange={id => setAssignees(current => current.includes(id) ? current.filter(value => value !== id) : [...current, id])}
        options={assigneeOptions}/> : <WorkChoice label="Исполнитель *" value={fields.assigneeId} disabled={saving || !entry && isScopedEmployee(actor)} onChange={value => update('assigneeId', value)} options={[...(!users.some(user => user.id === fields.assigneeId) ? [{ value: fields.assigneeId, name: `${userName(fields.assigneeId)} · доступ отключён`, disabled: true }] : []), ...users.map(user => ({ value: user.id, name: `${user.name}${user.id === actor.id ? ' (я)' : ''}` }))]}/>}
      {editor.kind === 'tasks' && <WorkChoice label="Приоритет" value={fields.priority} portalMenu placeholder={!entry && !priorityChosen} disabled={saving} priority onChange={value => { update('priority', value); setPriorityChosen(true); }} options={[{ value: '1', name: 'P1 · Срочно' }, { value: '2', name: 'P2 · Высокий' }, { value: '3', name: 'P3 · Средний' }, { value: '4', name: 'P4 · Обычный' }]}/>}
        {editor.kind === 'tasks' && compactDate('Срок задачи', 'dueDate', 'date')}{editor.kind === 'tasks' ? compactDate('Напоминание', 'reminderAt', 'datetime-local') : editor.kind !== 'notes' && input('Напоминание', 'reminderAt', { type: 'datetime-local' })}
      </div>
      {editor.kind === 'tasks' && companyField}
      {editor.kind !== 'tasks' && isScopedEmployee(actor) && <p className="work-hint">{entry ? 'После передачи запись появится у выбранного сотрудника и исчезнет из ваших назначений.' : 'Новая запись назначается вам. После сохранения её можно передать сотруднику.'}</p>}
      {editor.kind !== 'notes' && <p className="work-hint">При включённых уведомлениях напоминание придёт исполнителю на устройство. Укажите время в часовом поясе вашего устройства.</p>}
  </div>;
  const fileRows = <>
        {record?.attachments?.map(file => <a key={file.id} className="work-file" href={`/api/work/${editor.kind}/${encodeURIComponent(entry!.id)}/files/${encodeURIComponent(file.id)}`} download={file.name}><Paperclip size={14} aria-hidden="true"/><span>{file.name}</span><small>{Math.ceil(file.size / 1024)} КБ</small></a>)}
        {files.map((file, index) => <div className="work-file" key={index}>{file.name}<button type="button" className="icon-button" aria-label={`Убрать файл ${file.name}`} disabled={saving} onClick={() => setFiles(files.filter((_, i) => i !== index))}><X size={15}/></button></div>)}
  </>;
  const uploadAction = <label className="work-upload"><Paperclip size={14} aria-hidden="true"/><span>Добавить файл</span><input type="file" multiple aria-label="Добавить файл" disabled={saving} onChange={event => { const selected = [...files, ...Array.from(event.target.files ?? [])]; event.target.value = ''; if (selected.some(file => file.size > workFileLimit) || selected.reduce((sum, file) => sum + file.size, 0) + (record?.attachments ?? []).reduce((sum, file) => sum + file.size, 0) > workFilesTotalLimit || selected.length + (record?.attachments?.length ?? 0) > 20) { setError('Файл: до 20 МБ; в карточке не более 20 файлов и 20 МБ суммарно.'); return; } setFiles(selected); setError(''); }}/></label>;
  const taskFiles = editor.kind !== 'notes' && <section className="work-files" aria-label="Файлы">{fileRows}{uploadAction}</section>;
  const taskActivity = <>
      {editor.kind === 'companies' && <section className="work-comments"><h3>Комментарии</h3>{record?.comments?.slice().reverse().map(comment => <article key={comment.id}><small>{userName(comment.authorId)} · {dateLabel(comment.createdAt)}</small><p>{comment.text}</p></article>)}{input('Новый комментарий', 'comment', { multiline: true })}</section>}
      {entry && <p className="work-hint">Изменено: {dateLabel(entry.updatedAt)} · {userName(entry.updatedBy)}</p>}
  </>;
  const details = <>
      {editor.kind === 'notes' && input('Текст заметки', 'content', { multiline: true, hideLabel: true, placeholder: 'Текст заметки' })}
      {editor.kind === 'companies' && input('Текущий вопрос', 'question', { required: true, multiline: true })}
      {editor.kind !== 'notes' && taskParameters}{taskFiles}{taskActivity}
  </>;
  const form = <form ref={formRef} aria-busy={saving} onSubmit={event => { event.preventDefault(); void save(entry ? 'PATCH' : 'POST'); }}>
    <header className="work-editor-heading"><div className="work-editor-title"><h2 id="work-editor-title">{heading}</h2>{task && isClosedWorkStatus(task.status) && <TaskOutcome status={task.status}/>}</div><button type="button" className="icon-button" aria-label="Закрыть рабочую запись" disabled={saving} onClick={close}><X size={20}/></button></header>
    <div className="work-editor-body">
      <div className="work-editor-content">
      {editor.kind !== 'companies' && input('Название', 'title', { required: true, hideLabel: isNote, placeholder: isNote ? 'Название' : editor.kind === 'tasks' ? 'Название задачи' : undefined })}
      {editor.kind === 'tasks' && <div className="work-description-field">
        <div aria-hidden="true">{fields.description}{' '}</div>
        <textarea aria-label="Описание" placeholder="Описание" value={fields.description} rows={1} maxLength={10000}
          disabled={saving} onChange={event => update('description', event.target.value)}/>
      </div>}
      {editor.kind === 'tasks' && <section className="work-subtasks" aria-label="Подзадачи">
        <div className="work-subtasks-heading-frame" data-empty={!activeSubtasks.length} aria-hidden={!activeSubtasks.length}>
          <div className="work-subtasks-heading">
            <h3>Подзадачи</h3>
            <span role="status">{activeSubtasks.filter(row => row.done).length} из {activeSubtasks.length} готово</span>
          </div>
        </div>
        {subtasks.length > 0 && <ul className="work-subtask-list">{subtasks.map((row, index) => (
          <li key={row.id} className="work-subtask-item" inert={row.removing} ref={focusSubtask.current === row.id ? addedSubtask : undefined}>
            <div className={`work-subtask-row${row.done ? ' is-done' : ''}`}>
              <label className="work-subtask-check">
                <input type="checkbox" aria-label={`Выполнена подзадача: ${row.title || index + 1}`} checked={row.done} disabled={saving || row.removing}
                  onChange={event => { const done = event.target.checked; setSubtasks(current => current.map(item => item.id === row.id ? { ...item, done } : item)); }}/>
                <span className="work-subtask-check-box" aria-hidden="true"><Check size={11}/></span>
              </label>
              <input className="work-subtask-title" aria-label={`Название подзадачи ${index + 1}`} placeholder="Название подзадачи"
                value={row.title} maxLength={200} required disabled={saving || row.removing}
                onChange={event => { const title = event.target.value; setSubtasks(current => current.map(item => item.id === row.id ? { ...item, title } : item)); }}/>
              <button type="button" className="icon-button" aria-label={`Удалить подзадачу ${index + 1}`} disabled={saving || row.removing}
                onClick={event => removeSubtask(row.id, event.currentTarget)}><X size={16}/></button>
            </div>
          </li>
        ))}</ul>}
        <div className="work-task-actions">
          <button ref={addSubtaskButton} type="button" className="work-add-subtask" disabled={saving || activeSubtasks.length >= workSubtaskLimit} onClick={addSubtask}>
            <Plus size={16}/>Добавить подзадачу
          </button>
          <button type="button" className="work-add-subtask" aria-expanded={activity === 'comments'} aria-controls={`${activityId}-comments`} disabled={saving}
            onClick={() => toggleActivity('comments')}>
            <MessageSquare size={16}/>Комментарии{task?.comments?.length ? ` (${task.comments.length})` : ''}
          </button>
          {task && <button type="button" className="work-add-subtask" aria-expanded={activity === 'handoff'} aria-controls={`${activityId}-handoff`} disabled={saving}
            onClick={() => toggleActivity('handoff')}>
            <Send size={16}/>Передать задачу
          </button>}
        </div>
        <div ref={activityFrame} className="work-activity-frame">
          <div className="work-activity-layer" data-active={activity === 'comments'} inert={activity !== 'comments'}>
            <section id={`${activityId}-comments`} className="work-task-activity" aria-label="Комментарии">
              {!!task?.comments?.length && <div className="work-activity-history" role="region" aria-label="История комментариев" tabIndex={0}>
                <ol className="work-activity-list">{task.comments.slice().reverse().map(comment => <li key={comment.id} className={comment.id === waitingCommentId ? 'is-awaiting-reveal' : comment.id === latestCommentId ? 'is-new' : undefined}>
                  <span ref={comment.id === waitingCommentId ? latestCommentAnchor : undefined} className="work-activity-icon" aria-hidden="true">{comment.handoffTo ? <Send size={15}/> : <MessageSquare size={15}/>}</span>
                  <article>
                    <header><strong>{userName(comment.authorId)}</strong><time dateTime={comment.createdAt}>{dateLabel(comment.createdAt)}</time></header>
                    {comment.handoffTo && <small>Передано · {comment.handoffTo.map(userName).join(', ')}</small>}
                    <p>{comment.text}</p>
                  </article>
                </li>)}</ol>
              </div>}
              {input('Новый комментарий', 'comment', { multiline: true, hideLabel: true, placeholder: 'Напишите комментарий' })}
              <span className="work-comment-status" role="status">
                {latestCommentId && `Комментарий отправлен. Записей в истории: ${task?.comments?.length}.`}
              </span>
              {task && <button type="button" className="button primary work-activity-submit" disabled={saving || !fields.comment.trim()} onClick={() => void save('PATCH', { activityAction: 'comment' })}>
                {pendingAction === 'comment' ? <><LoaderCircle size={16} className="spin" aria-hidden="true"/>Отправляем…</> : <><Send size={16} aria-hidden="true"/>Отправить комментарий</>}
              </button>}
            </section>
          </div>
          {task && <div className="work-activity-layer" data-active={activity === 'handoff'} inert={activity !== 'handoff'}>
            <section id={`${activityId}-handoff`} className="work-task-activity work-handoff" aria-label="Передача задачи">
              <fieldset className="work-handoff-people" disabled={saving}>
                <legend>Кому передать</legend>
                {handoffUsers.length ? <div className="work-handoff-options">{handoffUsers.map(user => <label key={user.id}>
                  <input type="checkbox" checked={handoffTo.includes(user.id)}
                    onChange={() => setHandoffTo(current => current.includes(user.id) ? current.filter(id => id !== user.id) : [...current, user.id])}/>
                  <span>{user.name}</span>
                </label>)}</div> : <p className="work-hint">Нет доступных сотрудников.</p>}
              </fieldset>
              <label className="work-field"><span>Комментарий к передаче <small aria-hidden="true">необязательно</small></span><textarea rows={2} value={handoffComment} maxLength={10000} disabled={saving}
                placeholder="Что осталось сделать?" onChange={event => setHandoffComment(event.target.value)}/></label>
              <button type="button" className="button primary work-activity-submit" disabled={saving || !handoffTo.length} onClick={() => void save('PATCH', { activityAction: 'handed-off' })}>
                {pendingAction === 'handed-off' ? <><LoaderCircle size={16} className="spin" aria-hidden="true"/>Передаём…</> : <><Send size={16} aria-hidden="true"/>Передать</>}
              </button>
            </section>
          </div>}
        </div>
      </section>}
      {editor.kind === 'tasks' && <><div className="work-task-toolbar" role="group" aria-label="Параметры задачи" tabIndex={0}>{taskParameters}{uploadAction}</div>{(record?.attachments?.length || files.length) ? <section className="work-files work-task-file-list" aria-label="Файлы задачи">{fileRows}</section> : null}</>}
      {editor.kind === 'tasks' ? taskActivity : details}
      </div>

    </div>
    <footer className="work-editor-footer">
      {error && <p ref={errorMessage} tabIndex={-1} className="shipment-error work-action-error" role="alert">{error}</p>}
      {entry && <button type="button" className="button work-delete" disabled={saving} onClick={() => void save('DELETE')}><Trash2 size={16} aria-hidden="true"/>{pendingAction === 'deleted' ? 'Удаляем…' : 'Удалить'}</button>}
      {entry && editor.kind === 'companies' && <button type="button" className="button" disabled={saving} onClick={() => void save('PATCH', { nextArchived: !archived })}>{pendingAction === 'archived' ? 'Переносим в архив…' : pendingAction === 'restored' ? 'Возвращаем в работу…' : archived ? 'Вернуть в работу' : 'В архив задач'}</button>}
      {task && <div className="work-task-outcome-actions">
        {archived || isClosedWorkStatus(task.status) ?
          <button type="button" className="button" disabled={saving} onClick={() => void save('PATCH', { nextStatus: 'todo', nextArchived: false })}>
            {pendingAction === 'restored' ? 'Возвращаем…' : 'Вернуть в работу'}
          </button> : <>
            <button type="button" className="button work-mark-failed" disabled={saving} onClick={() => void save('PATCH', { nextStatus: 'failed' })}>
              <X size={16} aria-hidden="true"/>{pendingAction === 'failed' ? 'Сохраняем…' : 'Не выполнена'}
            </button>
            <button type="button" className="button" disabled={saving} onClick={() => void save('PATCH', { nextStatus: 'done' })}>
              <Check size={16} aria-hidden="true"/>{pendingAction === 'archived' ? 'Сохраняем…' : 'Выполнить'}
            </button>
          </>}
      </div>}
      <button className="button primary" type="submit" disabled={saving}>{pendingAction === 'saved' ? <LoaderCircle size={16} className="spin" aria-hidden="true"/> : <Save size={16} aria-hidden="true"/>}{pendingAction === 'saved' ? 'Сохраняем…' : 'Сохранить'}</button>
    </footer>
  </form>;
  return <dialog ref={dialog} className={`detail-dialog work-editor${isNote ? ' work-note-editor' : ''}`} aria-labelledby="work-editor-title" onCancel={event => { event.preventDefault(); close(); }}>{form}</dialog>;
}

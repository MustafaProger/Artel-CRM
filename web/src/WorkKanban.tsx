import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { FolderKanban, GripVertical, Pencil, Plus, Settings2, Trash2, X } from 'lucide-react';
import { hasSection, type AccountUser } from './auth-model';
import { commonBoardId, legacyBoardTask, type BoardColumn, type BoardDirectory, type TaskPlacement, type WorkBoard } from './kanban-model';
import { isClosedWorkStatus, type WorkTask } from './work-model';
import WorkTaskCheck from './WorkTaskCheck';
import WorkChoice from './WorkChoice';
import ScrollableSegments from './ScrollableSegments';
import LoadingSkeleton from './LoadingSkeleton';
import { useDialogMotion } from './useDialogMotion';
import { useViewEntrance } from './useViewEntrance';
import './work-kanban.css';

type Scope = 'personal' | 'shared' | 'common';
type Editor = { kind: 'board' | 'column'; board?: WorkBoard; column?: BoardColumn };
type Mutation = (board: WorkBoard | undefined, method: string, fields: Record<string, unknown>) => Promise<void>;

export default function WorkKanban({ actor, users, refreshKey, openTask, onTasksChanged }: {
  actor: AccountUser; users: AccountUser[]; refreshKey: number;
  onTasksChanged: () => void; openTask: (placement: TaskPlacement, entry?: WorkTask) => void;
}) {
  const [directory, setDirectory] = useState<BoardDirectory>();
  const [scope, setScope] = useState<Scope>('common');
  const [selection, setSelection] = useState('');
  const [editor, setEditor] = useState<Editor | null>(null);
  const [error, setError] = useState('');
  const [saving, setSaving] = useState(false);
  const [drag, setDrag] = useState('');
  const [drop, setDrop] = useState<{ columnId: string; beforeId?: string }>();
  const focusCard = useRef<{ id: string; checkbox?: boolean } | null>(null);
  const writing = useRef(false), read = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    if (writing.current) return;
    read.current?.abort();
    const controller = new AbortController();
    read.current = controller;
    try {
      const response = await fetch('/api/work/boards', { signal: controller.signal, cache: 'no-store' });
      const data = await response.json();
      if (response.status === 401 || response.status === 403) { setDirectory(undefined); setEditor(null); }
      if (!response.ok) throw new Error(data.error || 'Не удалось загрузить доски.');
      if (!controller.signal.aborted) {
        setDirectory(data);
        setEditor(current => current?.board && !data.boards.some((b: WorkBoard) => b.id === current.board!.id) ? null : current);
        setError('');
      }
    } catch (reason) {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Доски недоступны.');
    }
  }, []);
  useEffect(() => {
    void refresh();
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    const timer = window.setInterval(onVisible, 30000);
    document.addEventListener('visibilitychange', onVisible);
    return () => { read.current?.abort(); clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, [refresh, refreshKey]);

  const projectScope = (b: WorkBoard): Scope => b.id === commonBoardId ? 'common' : b.memberIds?.length ? 'shared' : 'personal';
  const boards = directory?.boards.filter(b => projectScope(b) === scope) ?? [];
  const groups = [...new Set(boards.map(b => b.group ?? ''))].sort((a, b) => a.localeCompare(b, 'ru'));
  const people = users.filter(u => u.id !== actor.id && hasSection(u, 'work'));
  const taskById = new Map(directory?.tasks.map(t => [t.id, t]));
  const board = boards.find(b => b.id === selection) ?? boards[0];
  const lanes = useViewEntrance<HTMLDivElement>(board?.id ?? '', '.kb-lane', 5);
  useLayoutEffect(() => {
    if (!focusCard.current || editor || saving || !lanes.current) return;
    const { id, checkbox } = focusCard.current;
    const card = lanes.current.querySelector<HTMLElement>(`[data-card="${CSS.escape(id)}"]`);
    focusCard.current = null;
    if (!card) return;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const control = card.querySelector<HTMLElement>(checkbox ? '.work-task-check input, button.work-task-check' : '.kb-card-open');
    control?.focus({ preventScroll: true });
    card.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: reduced ? 'instant' : 'smooth' });
    if (!reduced) card.animate([{ opacity: .6, transform: 'translateY(-3px)' }, { opacity: 1, transform: 'translateY(0)' }], {
      duration: parseFloat(getComputedStyle(card).getPropertyValue('--motion-feedback')) || 180,
      easing: getComputedStyle(card).getPropertyValue('--motion-ease').trim() || 'ease-out',
    });
  }, [board, editor, saving, lanes]);
  const mutate: Mutation = async (target, method, fields) => {
    if (writing.current) throw new Error('Дождитесь сохранения.');
    writing.current = true;
    read.current?.abort();
    setSaving(true);
    setError('');
    let needsRefresh = false;
    try {
      const response = await fetch('/api/work/boards' + (target ? '/' + encodeURIComponent(target.id) : ''), {
        method, headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ version: target?.version, ...fields }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Не удалось сохранить доску.');
      const updated: WorkBoard | null = result.board;
      if (updated && fields.action === 'moveCard' && typeof fields.cardId === 'string') focusCard.current = { id: fields.cardId };
      setDirectory(previous => {
        if (!previous) return previous;
        const id = updated?.id ?? target?.id;
        const boards = previous.boards.filter(row => row.id !== id);
        return { ...previous, boards: (updated ? [...boards, updated] : boards).sort((a, b) => a.title.localeCompare(b.title, 'ru')) };
      });
      if (updated) { setScope(projectScope(updated)); setSelection(updated.id); }
    } catch (reason) {
      needsRefresh = true;
      throw reason instanceof Error && !['TimeoutError', 'TypeError'].includes(reason.name) ? reason : new Error('Не удалось подтвердить сохранение. Проверьте доску перед повтором.');
    } finally {
      writing.current = false;
      setSaving(false);
      if (needsRefresh) void refresh();
    }
  };

  const saveTask = async (task: WorkTask, changes: Record<string, unknown>, errorMessage: string, checkbox = false) => {
    if (writing.current) return;
    writing.current = true;
    setSaving(true);
    setError('');
    read.current?.abort();
    let failure = '';
    try {
      const response = await fetch('/api/work/tasks/' + encodeURIComponent(task.id), {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
        body: JSON.stringify({ version: task.version, ...changes }),
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || errorMessage);
      onTasksChanged();
    } catch (reason) {
      failure = reason instanceof Error && !['TimeoutError', 'TypeError'].includes(reason.name) ? reason.message : errorMessage;
    } finally {
      writing.current = false;
      await refresh();
      if (failure) setError(failure);
      focusCard.current = { id: task.id, checkbox };
      setSaving(false);
    }
  };

  const move = async (column: BoardColumn, beforeId?: string) => {
    const cardId = drag;
    setDrag(''); setDrop(undefined);
    if (!board || !cardId || cardId === beforeId) return;
    if (board.id === commonBoardId) {
      const task = taskById.get(cardId);
      if (task) await saveTask(task, {
        placement: { boardId: board.id, version: board.version, columnId: column.id, beforeId: beforeId ?? null },
      }, 'Не удалось перенести задачу.');
    } else {
      try { await mutate(board, 'PATCH', { action: 'moveCard', cardId, columnId: column.id, beforeId }); }
      catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось перенести задачу.'); }
    }
  };

  const toggleTask = (task: WorkTask, board: WorkBoard, column: BoardColumn) => {
    const status = isClosedWorkStatus(task.status) ? 'todo' : 'done';
    void saveTask(task, {
      status, archived: status === 'done',
      ...(!task.createdAt ? { placement: { boardId: board.id, version: board.version, columnId: column.id } } : {}),
    }, 'Не удалось изменить состояние задачи.', true);
  };

  return <section className="panel kb-panel" aria-label="Канбан">
    <header className="kb-toolbar">
      <ScrollableSegments className="kb-scopes work-green-segments" label="Проекты" value={scope}>
        <button aria-pressed={scope === 'common'} onClick={() => setScope('common')}>Общий</button>
        <button aria-pressed={scope === 'shared'} onClick={() => setScope('shared')}>Совместные</button>
        <button aria-pressed={scope === 'personal'} onClick={() => setScope('personal')}>Личные</button>
      </ScrollableSegments>
      <button className="button primary mobile-icon-action" aria-label="Новый проект" title="Новый проект" disabled={!directory || saving} onClick={() => setEditor({ kind: 'board' })}><Plus size={16}/><span className="mobile-action-label">Новый проект</span></button>
    </header>
    {error && <p role="alert" className="shipment-error">{error}</p>}
    {!directory && !error && <LoadingSkeleton label="Загружаем доски" rows={3}/>}
    {directory && (board ? <>
      {scope !== 'common' && <div className="kb-heading">
        <div className="kb-board-name">
          <WorkChoice projectHeading label="Выбрать проект" value={board.id} disabled={saving} onChange={setSelection}
            options={groups.flatMap(group => boards.filter(project => (project.group ?? '') === group)
              .map(project => ({ value: project.id, name: project.title, group })))}/>
          {(board.group || scope === 'shared') && <small>{[board.group, scope === 'shared' && [board.ownerId, ...(board.memberIds ?? [])].map(id => users.find(u => u.id === id)?.name ?? 'Бывший сотрудник').join(', ')].filter(Boolean).join(' · ')}</small>}
        </div>
        {board.ownerId === actor.id && <button className="icon-button" aria-label="Настройки проекта" title="Настройки проекта" disabled={saving} onClick={() => setEditor({ kind: 'board', board })}><Settings2 size={18}/></button>}
      </div>}
      <div className={`kb-lanes${scope === 'common' ? ' kb-common-lanes' : ''}`} ref={lanes} aria-label={scope === 'common' ? 'Колонки общего канбана' : 'Колонки доски'} key={board.id}>
        {board.columns.map((column, index) => <section className={'kb-lane' + (drop?.columnId === column.id ? ' kb-hover' : '')}
          key={column.id} aria-label={column.title}
          onDragOver={event => {
            if (!drag || saving) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'move';
            const cardNode = (event.target as Element).closest<HTMLElement>('[data-card]');
            let beforeId = cardNode?.dataset.card;
            if (cardNode && event.clientY > cardNode.getBoundingClientRect().top + cardNode.offsetHeight / 2) {
              beforeId = column.cards[column.cards.findIndex(card => card.id === beforeId) + 1]?.id;
            }
            setDrop({ columnId: column.id, beforeId });
          }}
          onDragLeave={e => { if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDrop(undefined); }}
          onDrop={event => { event.preventDefault(); void move(column, drop?.columnId === column.id ? drop.beforeId : undefined); }}>
          <header><span className={'kb-dot kb-tone-' + index % 4}/><h3>{column.title}</h3><span className="kb-count">{column.cards.length}</span>
            {scope !== 'common' && <button className="icon-button" title="Настройки колонки" aria-label={'Настройки колонки ' + column.title} disabled={saving} onClick={() => setEditor({ kind: 'column', board, column })}><Pencil size={14}/></button>}
          </header>
          <div className="kb-cards">{column.cards.map(card => {
            const task = taskById.get(card.id) ?? legacyBoardTask(board, card);
            return <div key={card.id} data-card={card.id} draggable={!saving}
              className={'kb-card' + (task.status === 'done' ? ' kb-card-done' : '') + (drag === card.id ? ' kb-dragging' : '') + (drop?.beforeId === card.id ? ' kb-insert' : '')}
              onDragStart={e => { e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', card.id); setDrag(card.id); }}
              onDragEnd={() => { setDrag(''); setDrop(undefined); }}>
              <WorkTaskCheck task={task} disabled={saving} onToggle={() => toggleTask(task, board, column)}/>
              <button className="kb-card-open" type="button" disabled={saving} onClick={() => openTask({ board, column, card }, task)}>
                <span><strong>{card.title}</strong>{card.description && <span className="kb-description">{card.description}</span>}
                  <CardDetails task={task}/></span>
                <GripVertical size={15} aria-hidden="true"/>
              </button>
            </div>;
          })}</div>
          <button className={'kb-add' + (drop?.columnId === column.id && !drop.beforeId ? ' kb-insert' : '')} disabled={saving} onClick={() => openTask({ board, column })}><Plus size={15}/>Добавить задачу</button>
        </section>)}
        {scope !== 'common' && <button className="kb-new-column" disabled={saving} onClick={() => setEditor({ kind: 'column', board })}><Plus size={16}/>Добавить колонку</button>}
      </div>
    </> : <div className="kb-empty"><FolderKanban size={30}/><h2>{scope === 'personal' ? 'Личных проектов пока нет' : 'Совместных проектов пока нет'}</h2>
      <p>{scope === 'personal' ? 'Создайте проект и разложите задачи по колонкам.' : 'Выберите участников при создании проекта или в настройках личного проекта.'}</p></div>)}
    {editor && directory && <BoardEditor editor={editor} scope={scope} actor={actor} people={people} groups={[...new Set(directory.boards.map(b => b.group).filter((g): g is string => !!g))]} mutate={mutate} onClose={() => setEditor(null)}/>}
  </section>;
}

function CardDetails({ task }: { task: WorkTask }) {
  const details = [
    task.dueDate ? new Date(task.dueDate + 'T12:00:00').toLocaleDateString('ru-RU', {day:'numeric', month:'short'}) : '',
    task.subtasks?.length ? `Подзадачи ${task.subtasks.filter(s => s.done).length}/${task.subtasks.length}` : '',
  ].filter(Boolean);
  return details.length ? <small className="kb-card-details">{details.join(' · ')}</small> : null;
}

function BoardEditor({ editor, scope, actor, people, groups, mutate, onClose }: {
  editor: Editor; scope: Scope; actor: AccountUser; people: AccountUser[]; groups: string[]; mutate: Mutation; onClose: () => void;
}) {
  const { board, column, kind } = editor;
  const dialog = useRef<HTMLDialogElement>(null);
  const { close } = useDialogMotion(dialog, onClose);
  const [requestId] = useState(() => crypto.randomUUID());
  const [title, setTitle] = useState((kind === 'board' ? board : column)?.title ?? '');
  const [visibility, setVisibility] = useState<Scope>(board ? board.memberIds?.length ? 'shared' : 'personal' : scope === 'shared' ? 'shared' : 'personal');
  const [memberIds, setMemberIds] = useState((board?.memberIds ?? []).filter(id => people.some(p => p.id === id)));
  const [group, setGroup] = useState(board?.group ?? '');
  const [confirm, setConfirm] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const existing = kind === 'board' ? board : column;
  const heading = kind === 'board' ? board ? 'Настройки проекта' : 'Новый проект' : column ? 'Настройки колонки' : 'Новая колонка';
  const canDelete = existing && (kind !== 'board' || board?.ownerId === actor.id);
  const occupied = kind === 'column' && !!column?.cards.length;
  const save = async (remove = false) => {
    if (busy) return;
    setBusy(true); setError('');
    let action: string;
    if (kind === 'column') action = remove ? 'deleteColumn' : column ? 'renameColumn' : 'addColumn';
    else action = 'rename';
    try {
      await mutate(board, !board ? 'POST' : remove && kind === 'board' ? 'DELETE' : 'PATCH', {
        action, title, columnId: column?.id, ...(kind === 'board' ? { group, memberIds: visibility === 'shared' ? memberIds : [] } : {}), ...(!board ? { requestId } : {}),
      });
      close();
    } catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось сохранить.'); setBusy(false); }
  };

  return <dialog ref={dialog} className="detail-dialog work-editor kb-dialog" aria-labelledby="kb-editor-title" onCancel={e => { e.preventDefault(); if (!busy) close(); }}>
    <form onSubmit={e => { e.preventDefault(); void save(confirm); }}>
      <header className="work-editor-heading"><h2 id="kb-editor-title">{confirm ? kind === 'board' ? 'Удаление проекта' : 'Удаление колонки' : heading}</h2><button type="button" className="icon-button" disabled={busy} aria-label="Закрыть" onClick={close}><X size={18}/></button></header>
      <div className="work-editor-body">
        {confirm ? <p className="kb-confirm">{kind === 'board' ? 'Удалить проект «' + title + '» вместе со всеми колонками и задачами?' : 'Удалить колонку «' + title + '»?'}</p> : <>
          <label className="work-field"><span>Название</span><input autoFocus required maxLength={160} value={title} disabled={busy} onChange={e => setTitle(e.target.value)}/></label>
          {kind === 'board' && <>
            <label className="work-field"><span>Группа проектов</span><input list="kb-project-groups" value={group} maxLength={100} disabled={busy} onChange={e => setGroup(e.target.value)} placeholder="Например, Самообразование"/></label>
            <datalist id="kb-project-groups">{groups.map(g => <option key={g} value={g}/>)}</datalist>
            <label className="work-field"><span>Кто видит проект</span><select value={visibility} onChange={e => setVisibility(e.target.value as Scope)} disabled={busy}>
              <option value="personal">Только я</option><option value="shared">Выбранные сотрудники</option></select></label>
            {visibility === 'shared' && <fieldset className="kb-members"><legend>Участники проекта</legend>
              {people.map(person => <label key={person.id}><input type="checkbox" disabled={busy} checked={memberIds.includes(person.id)}
                onChange={e => setMemberIds(ids => e.target.checked ? [...ids, person.id] : ids.filter(id => id !== person.id))}/>{person.name}</label>)}
              {!people.length && <p>Нет других сотрудников с доступом к разделу «Работа».</p>}</fieldset>}
          </>}
          {occupied && <p className="kb-help">Чтобы удалить колонку, сначала перенесите её задачи.</p>}
        </>}
        {error && <p role="alert" className="shipment-error">{error}</p>}
      </div>
      <footer className="work-editor-footer">
        {canDelete && !confirm && <button type="button" className="icon-button kb-delete" disabled={busy || occupied} title="Удалить" aria-label="Удалить" onClick={() => setConfirm(true)}><Trash2 size={17}/></button>}
        <button type="button" className="button" disabled={busy} onClick={() => confirm ? setConfirm(false) : close()}>Отмена</button>
        <button type="submit" className={'button ' + (confirm ? 'work-delete' : 'primary')} disabled={busy || (!confirm && (!title.trim() || (kind === 'board' && visibility === 'shared' && !memberIds.length)))}>{busy ? 'Сохраняем…' : confirm ? 'Удалить' : 'Сохранить'}</button>
      </footer>
    </form>
  </dialog>;
}

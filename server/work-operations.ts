import { randomUUID } from 'node:crypto';
import { hasSection, isAdministrator, isScopedEmployee, type AccountUser } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import { isWorkDirectoryCompany, emptyWork, isClosedWorkStatus, isMyWork, workAssigneeIds, workFileLimit, workFilesTotalLimit, workStatuses, workPriorities, workSubtaskLimit, type WorkSubtask, type WorkAttachment, type AnyWorkEntry, type WorkCompanyRecord, type WorkData, type WorkKind, type WorkNote, type WorkResponse, type WorkTask } from '../web/src/work-model';
import { commonBoardId, isBoardMember, legacyBoardTask, type WorkBoard } from '../web/src/kanban-model';
import { canReadBoardTask, getBoard, persistBoard, validBoards } from './kanban';
import { ApiError } from './api-error';
import { StoreError, type OperationsData } from './operations-store';
import { queueTaskAssignment, queueTaskCompletion } from './push';
import { profileAvatarProjection } from './profile-avatars';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value: unknown, max: number, required = false): value is string => typeof value === 'string' && value.length <= max && (!required || !!value.trim());
const identifier = (value: unknown): value is string => boundedText(value, 180, true);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && date(value.slice(0, 10)) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
const listKey = (kind: WorkKind) => kind === 'companies' ? 'companyRecords' : kind;
const isSupervisor = isAdministrator;
const canAccess = (data: OperationsData, actor: AccountUser, entry: AnyWorkEntry) =>
  'status' in entry && entry.boardId ? canReadBoardTask(data, entry.boardId, actor.id)
    : isSupervisor(actor) || isScopedEmployee(actor) && isMyWork(entry, actor.id);
const validAssignees = (value: unknown): value is string[] => Array.isArray(value) && value.every(identifier) && new Set(value).size === value.length;

/** A handed-over task grants its company label in Work, never ownership of that
 * company's shipments or money. Existing task edits must retain this reference. */
export function workCompanyIds(data: OperationsData, actor: AccountUser): string[] {
  return [...new Set([...(data.work?.tasks ?? []), ...(data.work?.companyRecords ?? [])]
    .filter(row => canAccess(data, actor, row)).flatMap(row => row.companyId ? [row.companyId] : []))];
}

function validSubtasks(value: unknown): value is WorkSubtask[] {
  if (!Array.isArray(value) || value.length > workSubtaskLimit) return false;
  const ids = new Set<string>();
  for (const row of value) {
    if (!object(row) || !identifier(row.id) || ids.has(row.id) || !boundedText(row.title, 200, true) || typeof row.done !== 'boolean') return false;
    ids.add(row.id);
  }
  return true;
}

// Reuse only the validated immutable file bytes. Card and file metadata are always checked.
let verifiedFiles = new Map<string, { data: string; size: number }>();

/** Old stores may omit work entirely. Existing malformed work is never silently discarded. */
export function validateWorkData(value: unknown): asserts value is WorkData | undefined {
  if (value === undefined) return;
  if (!object(value) || !Array.isArray(value.tasks) || !Array.isArray(value.companyRecords) || !Array.isArray(value.notes) || !validBoards(value.boards)) throw new StoreError('Invalid work storage');
  const ids = new Set<string>();
  const checkedFiles = new Map<string, { data: string; size: number }>();
  let checkedBytes = 0;
  for (const kind of ['tasks', 'companyRecords', 'notes'] as const) {
    const rows = value[kind];
    if (!Array.isArray(rows)) throw new StoreError('Invalid work collection');
    for (const row of rows) {
      if (!object(row) || !identifier(row.id) || ids.has(row.id) || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || !identifier(row.assigneeId) || !identifier(row.createdBy) || !identifier(row.updatedBy) || !instant(row.createdAt) || !instant(row.updatedAt)) throw new StoreError('Invalid work entry');
      ids.add(row.id);
      if (kind === 'tasks' && (!boundedText(row.title, 200, true) || !boundedText(row.description, 10000) || !workStatuses.some(status => status.id === row.status) || row.priority !== undefined && !workPriorities.includes(row.priority as 1 | 2 | 3 | 4) || row.companyId !== null && !identifier(row.companyId) || row.dueDate !== null && !date(row.dueDate) || row.reminderAt !== null && !instant(row.reminderAt))) throw new StoreError('Invalid work task');
      if (kind === 'tasks' && row.boardId !== undefined && !identifier(row.boardId)) throw new StoreError('Invalid task project');
      if (kind === 'tasks' && row.assigneeIds !== undefined && (!validAssignees(row.assigneeIds) || row.assigneeIds[0] !== row.assigneeId)) throw new StoreError('Invalid task assignees');
      if (kind === 'tasks' && row.notifyOnCompletion !== undefined && typeof row.notifyOnCompletion !== 'boolean') throw new StoreError('Invalid task completion setting');
      if (kind === 'tasks' && row.subtasks !== undefined && !validSubtasks(row.subtasks)) throw new StoreError('Invalid work subtasks');
      if (kind === 'notes' && (!boundedText(row.title, 200, true) || !boundedText(row.content, 10000))) throw new StoreError('Invalid work note');
      if (kind !== 'notes') {
        if (row.archivedAt !== undefined && row.archivedAt !== null && !instant(row.archivedAt)) throw new StoreError('Invalid work archive');
        if (row.attachments !== undefined) {
          if (!Array.isArray(row.attachments) || row.attachments.length > 20) throw new StoreError('Invalid attachments');
          let total = 0;
          const fileIds = new Set<string>();
          for (const file of row.attachments) {
            if (!object(file) || !identifier(file.id) || fileIds.has(file.id) || !boundedText(file.name, 200, true) || (/[\\/]/.test(file.name) || [...file.name].some(char => char.charCodeAt(0) < 32)) || !instant(file.createdAt) || !identifier(file.authorId) || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > workFileLimit || typeof file.data !== 'string') throw new StoreError('Invalid attachment');
            const previous = verifiedFiles.get(file.id);
            if (!previous || previous.data !== file.data || previous.size !== file.size) {
              const bytes = Buffer.from(file.data, 'base64');
              if (bytes.length !== file.size || bytes.toString('base64') !== file.data) throw new StoreError('Invalid attachment');
            }
            const size = Number(file.size);
            checkedBytes += file.data.length;
            if (checkedBytes <= 32 * 1024 * 1024) checkedFiles.set(file.id, { data: file.data, size });
            fileIds.add(file.id); total += size;
          }
          if (total > workFilesTotalLimit) throw new StoreError('Attachments too large');
        }
      }
      if (kind === 'companyRecords') {
        if (!identifier(row.companyId) || !boundedText(row.question, 10000, true) || row.reminderAt !== null && !instant(row.reminderAt) || !Array.isArray(row.comments)) throw new StoreError('Invalid work company');
      }
      if (kind !== 'notes' && row.comments !== undefined) {
        if (!Array.isArray(row.comments)) throw new StoreError('Invalid comments');
        const comments = new Set<string>();
        for (const comment of row.comments) {
          if (!object(comment) || !identifier(comment.id) || comments.has(comment.id) || !boundedText(comment.text, 10000, true) || !instant(comment.createdAt) || !identifier(comment.authorId)) throw new StoreError('Invalid work comment');
          if (comment.handoffTo !== undefined && (kind !== 'tasks' || !validAssignees(comment.handoffTo) || !comment.handoffTo.length)) throw new StoreError('Invalid task handoff');
          comments.add(comment.id);
        }
      }
    }
  }
  verifiedFiles = checkedFiles;
}

function workPersonIds(row: AnyWorkEntry) {
  const ids = [...workAssigneeIds(row), row.createdBy, row.updatedBy];
  if ('comments' in row) for (const comment of row.comments ?? []) ids.push(comment.authorId, ...comment.handoffTo ?? []);
  if ('attachments' in row) for (const file of row.attachments ?? []) ids.push(file.authorId);
  return ids;
}

export function canReadHistoricalWorkPerson(data: OperationsData, actor: AccountUser, userId: string) {
  if (!hasSection(actor, 'work') || !data.work) return false;
  const { tasks, companyRecords, notes } = data.work;
  return [...tasks, ...companyRecords, ...notes].some(row => canAccess(data, actor, row) && workPersonIds(row).includes(userId));
}

export function readWork(data: OperationsData, snapshot: Snapshot, params: URLSearchParams, actor: AccountUser, users: AccountUser[]): WorkResponse {
  if (!isSupervisor(actor) && !isScopedEmployee(actor)) throw new ApiError(403, 'Нет доступа к рабочему пространству.');
  const requested = params.get('assigneeId');
  if (requested && requested !== 'mine' && !users.some(user => user.id === requested) && !(isSupervisor(actor) && data.accounts?.users.some(user => user.id === requested))) throw new ApiError(400, 'Сотрудник не найден.');
  const work = data.work ?? emptyWork();
  const visible = (entry: AnyWorkEntry) => canAccess(data, actor, entry) && (isSupervisor(actor) || isMyWork(entry, actor.id)) && (!requested || (requested === 'mine' ? isMyWork(entry, actor.id) : workAssigneeIds(entry).includes(requested)));
  const visibleWork = { tasks: work.tasks.filter(visible).map(publicWorkEntry), companyRecords: work.companyRecords.filter(visible).map(publicWorkEntry), notes: work.notes.filter(visible) };
  const visibleTaskIds = new Set(visibleWork.tasks.map(task => task.id));
  // Old links keep their labels without making unrelated companies selectable.
  const referencedCompanies = new Set([...visibleWork.tasks, ...visibleWork.companyRecords].flatMap(row => row.companyId ? [row.companyId] : []));
  const referenced = new Set([...visibleWork.tasks, ...visibleWork.companyRecords, ...visibleWork.notes].flatMap(workPersonIds));
  return {
    work: visibleWork,
    taskBoards: (work.boards ?? []).filter(b => b.id !== commonBoardId && isBoardMember(b, actor.id))
      .map(b => ({ ...b, columns: b.columns.map(col => ({ ...col, cards: col.cards.filter(c => visibleTaskIds.has(c.id)) })) })),
    todayTaskCount: activeTaskCount(data, actor),
    historicalUsers: (data.accounts?.users ?? []).filter(user => referenced.has(user.id) && !users.some(active => active.id === user.id)).map(({ id, name, avatar }) => ({ id, name, ...profileAvatarProjection(id, avatar) })),
    users: isSupervisor(actor) ? users : users.map(user => ({ ...user, login: '' })), companies: snapshot.companies.filter(company => isWorkDirectoryCompany(company) || referencedCompanies.has(company.id)), currentUser: actor, revision: data.revision,
  };
}

export function activeTaskCount(data: OperationsData, actor: AccountUser): number {
  return data.work?.tasks.filter(task => !task.archivedAt && !isClosedWorkStatus(task.status) && isMyWork(task, actor.id) && canAccess(data, actor, task)).length ?? 0;
}

const stringField = (value: unknown, label: string, max: number, required = false) => {
  if (!boundedText(value, max, required)) throw new ApiError(400, `${label}: ${required ? 'укажите значение, ' : ''}не более ${max} символов.`);
  return value.trim();
};
const optionalDate = (value: unknown, label: string, timestamp = false) => {
  if (value === null || value === '') return null;
  if (!(timestamp ? instant(value) : date(value))) throw new ApiError(400, `${label}: укажите корректную дату${timestamp ? ' и время' : ''}.`);
  return value as string;
};
export function publicWorkEntry<T extends AnyWorkEntry>(entry: T): T {
  if (!('attachments' in entry)) return entry;
  return { ...entry, attachments: entry.attachments?.map(({ data: _data, ...file }) => { void _data; return file; }) };
}
export function workFile(data: OperationsData, kind: string, id: string, fileId: string, actor: AccountUser) {
  const entry = (kind === 'tasks' ? data.work?.tasks : data.work?.companyRecords)?.find(row => row.id === id);
  const file = entry && canAccess(data, actor, entry) ? entry.attachments?.find(row => row.id === fileId) : undefined;
  if (!file) throw new ApiError(404, 'Файл не найден или недоступен.');
  return file;
}
export interface WorkMutationResult { entry?: AnyWorkEntry; deleted?: boolean; id?: string; created?: boolean; changed: boolean; completionQueued?: boolean; board?: WorkBoard }

/** Called inside the existing storage transaction; both authorization and version checks are atomic. */
export function mutateWork(data: OperationsData, snapshot: Snapshot, kindValue: string, body: Record<string, unknown>, id: string | undefined, method: string, actor: AccountUser, users: AccountUser[]): WorkMutationResult {
  if (kindValue !== 'tasks') return saveWorkEntry(data, snapshot, kindValue, body, id, method, actor, users);
  const { placement, ...fields } = body;
  if (placement !== undefined && !object(placement)) throw new ApiError(400, 'Укажите колонку канбана.');
  const stored = data.work?.tasks.find(task => task.id === id);
  const boardId = placement?.boardId ?? stored?.boardId;
  if (!boardId && placement === undefined) return saveWorkEntry(data, snapshot, kindValue, fields, id, method, actor, users);
  const board = getBoard(data, boardId);
  if (!board || !isBoardMember(board, actor.id) || stored?.boardId && board.id !== stored.boardId) throw new ApiError(404, 'Проект недоступен.');
  const work = data.work ??= emptyWork();
  const key = id ?? (fields.requestId ? 'work-tasks-' + fields.requestId : undefined);
  const source = board.columns.find(col => col.cards.some(card => card.id === key));
  const card = source?.cards.find(row => row.id === key);
  let destination = placement ? board.columns.find(col => col.id === placement.columnId) : source;
  if (stored && !stored.boardId && (board.id !== commonBoardId || stored.createdBy !== actor.id && !isSupervisor(actor))) {
    throw new ApiError(403, 'Добавить обычную задачу в общий канбан может автор или администратор.');
  }
  const replay = !id && !!card && work.tasks.some(task => task.id === key && task.boardId === board.id && task.createdBy === actor.id);
  if (placement && !(board.id === commonBoardId && placement.version === undefined) && placement.version !== board.version && !replay) throw new ApiError(409, 'Канбан изменился. Откройте актуальную карточку.');
  if (!destination) throw new ApiError(404, 'Колонка больше недоступна.');
  if (board.id === commonBoardId && placement && method !== 'DELETE') {
    // An explicit outcome or handoff in the standard editor takes precedence over its initial column.
    if (!fields.handoff && (!stored || fields.status === undefined || fields.status === stored.status)) fields.status = destination.id;
  }
  const before = placement?.beforeId;
  if (before != null && (before === key || !destination.cards.some(c => c.id === before))) throw new ApiError(409, 'Позиция задачи изменилась.');
  if (id && card && !stored) {
    const now = new Date().toISOString();
    work.tasks.push({ ...legacyBoardTask(board, card), createdAt: now, updatedAt: now });
  }
  const eligible = users.filter(u => isBoardMember(board, u.id));
  const result = saveWorkEntry(data, snapshot, kindValue, fields, id, method, actor, eligible, board.id);
  if (!result.changed) return replay ? { ...result, board } : result;
  if (result.deleted && card && source) source.cards.splice(source.cards.indexOf(card), 1);
  const task = result.entry as WorkTask | undefined;
  if (task) {
    if (board.id === commonBoardId) destination = board.columns.find(col => col.id === task.status)!;
    const summary = { id: task.id, title: task.title, description: task.description };
    if (card && source === destination && (!placement || placement.beforeId === undefined)) {
      if (card.title === summary.title && card.description === summary.description) return result;
      Object.assign(card, summary);
    } else {
      if (card && source) source.cards.splice(source.cards.indexOf(card), 1);
      const index = destination.cards.findIndex(c => c.id === before);
      destination.cards.splice(index < 0 ? destination.cards.length : index, 0, summary);
    }
  }
  persistBoard(data, board);
  board.version++;
  return { ...result, board };
}

function saveWorkEntry(data: OperationsData, snapshot: Snapshot, kindValue: string, body: Record<string, unknown>, id: string | undefined, method: string, actor: AccountUser, users: AccountUser[], boardId?: string): WorkMutationResult {
  if (!isSupervisor(actor) && !isScopedEmployee(actor)) throw new ApiError(403, 'Нет доступа к рабочему пространству.');
  if (!['tasks', 'companies', 'notes'].includes(kindValue)) throw new ApiError(404, 'Раздел работы не найден.');
  if (!['POST', 'PATCH', 'DELETE'].includes(method) || (method === 'POST') === !!id) throw new ApiError(405, 'Метод не поддерживается для этого маршрута.');
  const kind = kindValue as WorkKind;
  const key = listKey(kind);
  const work = data.work ?? emptyWork();
  const previous = id ? work[key].find(row => row.id === id) : undefined;
  if (id && (!previous || !canAccess(data, actor, previous))) throw new ApiError(404, 'Запись не найдена или недоступна.');
  if (previous && (!Number.isSafeInteger(body.version) || Number(body.version) < 1)) throw new ApiError(400, 'Передайте версию записи.');
  if (previous && body.version !== previous.version) throw new ApiError(409, 'Запись изменена другим сотрудником. Закройте карточку, обновите список и повторите изменение.');
  if (method === 'DELETE') {
    if (Object.keys(body).some(key => key !== 'version')) throw new ApiError(400, 'В запросе есть неизвестные параметры.');
    if (key === 'tasks') work.tasks = work.tasks.filter(row => row.id !== id);
    else if (key === 'companyRecords') work.companyRecords = work.companyRecords.filter(row => row.id !== id);
    else work.notes = work.notes.filter(row => row.id !== id);
    data.work = work;
    if (kind === 'tasks') {
      queueTaskAssignment(data, undefined, previous as WorkTask, actor);
      queueTaskCompletion(data, undefined, previous as WorkTask, actor);
    }
    return { deleted: true, id, changed: true };
  }
  const allowed = ['version', 'requestId', 'assigneeId', ...(kind !== 'notes' ? ['archived', 'comment', 'addAttachments'] : []), ...(kind === 'tasks' ? ['title', 'description', 'status', 'priority', 'companyId', 'dueDate', 'reminderAt', 'subtasks', 'assigneeIds', 'handoff', 'notifyOnCompletion'] : kind === 'companies' ? ['companyId', 'question', 'comment', 'reminderAt'] : ['title', 'content'])];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, 'В запросе есть неизвестные параметры.');
  if (previous && body.requestId !== undefined || !previous && body.version !== undefined) throw new ApiError(400, 'Некорректные параметры создания или изменения.');
  if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))) throw new ApiError(400, 'Некорректный идентификатор запроса.');
  const get = (name: string, fallback: unknown) => body[name] === undefined ? previous ? (previous as unknown as Record<string, unknown>)[name] : fallback : body[name];
  // Notes belong to their creator. Keep the stored assignment for older notes.
  const previousAssignees = previous ? workAssigneeIds(previous) : [];
  const creator = previous?.createdBy ?? actor.id;
  const handoff = body.handoff === true;
  if (body.handoff !== undefined && (!handoff || !previous || !Array.isArray(body.assigneeIds) || !body.assigneeIds.length)) throw new ApiError(400, 'Укажите исполнителей для передачи задачи.');
  const activeAssignee = (id: string) => users.some(user => user.id === id && user.active && !user.deletedAt && (kind !== 'tasks' || hasSection(user, 'work')));
  let handoffTo: string[] | undefined;
  let assigneeIds: readonly string[];
  if (kind === 'tasks' && body.assigneeIds !== undefined) {
    if (body.assigneeId !== undefined || !validAssignees(body.assigneeIds)) throw new ApiError(400, 'Выберите исполнителей из списка сотрудников.');
    if (handoff) {
      if (body.assigneeIds.some(id => id === actor.id || !activeAssignee(id))) throw new ApiError(400, 'Для передачи выберите действующих коллег.');
      handoffTo = body.assigneeIds;
      assigneeIds = [...new Set([...previousAssignees, ...handoffTo, ...(activeAssignee(creator) ? [creator] : [])])];
    } else {
      assigneeIds = body.assigneeIds.length ? body.assigneeIds : [creator];
    }
  } else if (kind === 'tasks' && previous && body.assigneeId === undefined) {
    assigneeIds = previousAssignees;
  } else {
    const assigneeId = kind === 'notes' ? previous?.assigneeId ?? actor.id : get('assigneeId', actor.id);
    if (!identifier(assigneeId)) throw new ApiError(400, 'Выберите действующего сотрудника.');
    assigneeIds = [assigneeId];
  }
  const assigneeId = assigneeIds[0];
  if (assigneeIds.some(id => !activeAssignee(id) && !previousAssignees.includes(id))) throw new ApiError(400, 'Выберите действующего сотрудника.');
  if (kind !== 'tasks' && !previous && !isSupervisor(actor) && assigneeId !== actor.id) throw new ApiError(403, 'Создайте запись для себя. Затем её можно передать сотруднику.');
  const companyId = kind === 'notes' ? null : get('companyId', null);
  if (kind !== 'notes' && (companyId !== null || kind === 'companies') && (!identifier(companyId) || !snapshot.companies.some(company => company.id === companyId && (isWorkDirectoryCompany(company) || previous && 'companyId' in previous && previous.companyId === companyId)))) throw new ApiError(400, 'Выберите доступную компанию из справочника.');
  const now = new Date().toISOString();
  const common = { id: id ?? `work-${kind}-${body.requestId ?? randomUUID()}`, version: (previous?.version ?? 0) + 1, assigneeId, createdAt: previous?.createdAt ?? now, updatedAt: now, createdBy: previous?.createdBy ?? actor.id, updatedBy: actor.id };
  let entry: AnyWorkEntry;
  if (kind === 'tasks') {
    // Accept the obsolete boolean from open copies of the previous editor.
    if (body.notifyOnCompletion !== undefined && typeof body.notifyOnCompletion !== 'boolean') throw new ApiError(400, 'Некорректная настройка уведомления о выполнении.');
    const status = handoff ? 'todo' : get('status', 'todo');
    if (!workStatuses.some(row => row.id === status)) throw new ApiError(400, 'Неизвестное состояние задачи.');
    const priority = body.priority === undefined ? (previous as WorkTask | undefined)?.priority ?? 4 : body.priority;
    if (!workPriorities.includes(priority as 1 | 2 | 3 | 4)) throw new ApiError(400, 'Неизвестный приоритет задачи.');
    const subtasks = body.subtasks === undefined ? (previous as WorkTask | undefined)?.subtasks : body.subtasks;
    if (subtasks !== undefined && !validSubtasks(subtasks)) throw new ApiError(400, `Укажите названия подзадач. Допускается до ${workSubtaskLimit} подзадач по 200 символов.`);
    entry = { ...common, ...(boardId ? { boardId } : {}), ...(assigneeIds.length > 1 ? { assigneeIds: [...assigneeIds] } : {}), title: stringField(get('title', ''), 'Название', 200, true), description: stringField(get('description', ''), 'Описание', 10000), status: status as WorkTask['status'], priority: priority as WorkTask['priority'], companyId: companyId as string | null, dueDate: optionalDate(get('dueDate', null), 'Срок'), reminderAt: optionalDate(get('reminderAt', null), 'Напоминание', true), ...(subtasks === undefined ? {} : { subtasks: subtasks.map(({ id, title, done }) => ({ id, title: title.trim(), done })) }) };
  } else if (kind === 'companies') {
    const comment = body.comment === undefined ? '' : stringField(body.comment, 'Комментарий', 10000);
    const comments = [...((previous as WorkCompanyRecord | undefined)?.comments ?? [])];
    if (comment) comments.push({ id: `work-comment-${randomUUID()}`, text: comment, authorId: actor.id, createdAt: now });
    entry = { ...common, companyId: companyId as string, question: stringField(get('question', ''), 'Текущий вопрос', 10000, true), reminderAt: optionalDate(get('reminderAt', null), 'Напоминание', true), comments };
  } else {
    entry = { ...common, title: stringField(get('title', ''), 'Название', 200, true), content: stringField(get('content', ''), 'Текст заметки', 10000) };
  }
  if (kind !== 'notes') {
    const previousRecord = previous as WorkTask | WorkCompanyRecord | undefined;
    const record = entry as WorkTask | WorkCompanyRecord;
    if (body.archived !== undefined && typeof body.archived !== 'boolean') throw new ApiError(400, 'Некорректное состояние архива.');
    record.archivedAt = handoff ? null : body.archived === true ? previousRecord?.archivedAt ?? now : body.archived === false ? null : previousRecord?.archivedAt ?? null;
    if (kind === 'tasks') {
      const task = entry as WorkTask;
      if (body.archived === false && body.status === undefined) task.status = 'todo';
      if (isClosedWorkStatus(task.status) && (body.status !== undefined || !previous)) record.archivedAt = previousRecord?.archivedAt ?? now;
      if (body.status !== undefined && !isClosedWorkStatus(task.status) && body.archived !== true) record.archivedAt = null;
    }
    if (kind === 'tasks') {
      record.comments = [...(previousRecord?.comments ?? [])];
      const comment = body.comment === undefined ? '' : stringField(body.comment, 'Комментарий', 10000);
      if (comment || handoff) record.comments.push({
        id: `work-comment-${randomUUID()}`, text: comment || 'Задача передана', authorId: actor.id, createdAt: now,
        ...(handoffTo ? { handoffTo } : {}),
      });
    }
    const files: WorkAttachment[] = [...(previousRecord?.attachments ?? [])];
    if (body.addAttachments !== undefined) {
      if (!Array.isArray(body.addAttachments) || body.addAttachments.length > 20) throw new ApiError(400, 'Некорректный список файлов.');
      for (const file of body.addAttachments) {
        if (!object(file) || Object.keys(file).some(key => !['name', 'data'].includes(key)) || !boundedText(file.name, 200, true) || (/[\\/]/.test(file.name) || [...file.name].some(char => char.charCodeAt(0) < 32)) || typeof file.data !== 'string' || file.data.length > Math.ceil(workFileLimit / 3) * 4 || Buffer.from(file.data, 'base64').toString('base64') !== file.data || Buffer.from(file.data, 'base64').length > workFileLimit) throw new ApiError(400, 'Файл: до 20 МБ, имя до 200 символов без путей.');
        files.push({ id: `work-file-${randomUUID()}`, name: file.name, data: file.data, size: Buffer.from(file.data, 'base64').length, authorId: actor.id, createdAt: now });
      }
    }
    if (files.length > 20 || files.reduce((sum, file) => sum + file.size, 0) > workFilesTotalLimit) throw new ApiError(400, 'В карточке допускается до 20 файлов, суммарно до 20 МБ.');
    record.attachments = files;
  }
  if (!previous) {
    const duplicate = work[key].find(row => row.id === entry.id);
    if (duplicate) {
      // A lost POST response can be retried without producing a second task or comment.
      if (!canAccess(data, actor, duplicate) || duplicate.createdBy !== actor.id) throw new ApiError(409, 'Идентификатор запроса уже использован.');
      const comparable = (row: AnyWorkEntry) => Object.fromEntries(Object.entries(row)
        .filter(([key]) => !['version', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'comments', 'attachments'].includes(key))
        .map(([key, value]) => [key, key === 'archivedAt' ? Boolean(value) : value]));
      const originalComment = (duplicate as WorkCompanyRecord).comments?.[0]?.text ?? '';
      if (JSON.stringify(comparable(duplicate)) !== JSON.stringify(comparable(entry)) || kind !== 'notes' && originalComment !== String(body.comment ?? '').trim()) throw new ApiError(409, 'Запрос уже сохранён с другими значениями. Обновите список.');
      if (JSON.stringify(('attachments' in duplicate ? duplicate.attachments : [])?.map(file => ({name:file.name,data:file.data}))) !== JSON.stringify(('attachments' in entry ? entry.attachments : [])?.map(file => ({name:file.name,data:file.data})))) throw new ApiError(409, 'Запрос уже сохранён с другими файлами.');
      return { entry: publicWorkEntry(duplicate), created: false, changed: false };
    }
  }
  if (!assigneeIds.some(activeAssignee) && kind !== 'notes' && !('archivedAt' in entry && entry.archivedAt) && !('status' in entry && isClosedWorkStatus(entry.status))) throw new ApiError(400, 'Чтобы вернуть запись в работу, выберите действующего сотрудника.');
  if (key === 'tasks') work.tasks = [...work.tasks.filter(row => row.id !== entry.id), entry as WorkTask];
  else if (key === 'companyRecords') work.companyRecords = [...work.companyRecords.filter(row => row.id !== entry.id), entry as WorkCompanyRecord];
  else work.notes = [...work.notes.filter(row => row.id !== entry.id), entry as WorkNote];
  validateWorkData(work);
  data.work = work;
  const completionQueued = kind === 'tasks' && queueTaskCompletion(data, entry as WorkTask, previous as WorkTask | undefined, actor);
  if (kind === 'tasks') queueTaskAssignment(data, entry as WorkTask, previous as WorkTask | undefined, actor, handoffTo);
  return { entry: publicWorkEntry(entry), created: !previous, changed: true, completionQueued };
}

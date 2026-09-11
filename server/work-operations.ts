import { randomUUID } from 'node:crypto';
import type { AccountUser } from '../web/src/auth-model';
import type { Snapshot } from '../web/src/model';
import { emptyWork, workFileLimit, workFilesTotalLimit, workStatuses, type WorkAttachment, type AnyWorkEntry, type WorkCompanyRecord, type WorkData, type WorkKind, type WorkNote, type WorkResponse, type WorkTask } from '../web/src/work-model';
import { ApiError } from './api-error';
import { StoreError, type OperationsData } from './operations-store';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const boundedText = (value: unknown, max: number, required = false): value is string => typeof value === 'string' && value.length <= max && (!required || !!value.trim());
const identifier = (value: unknown): value is string => boundedText(value, 180, true);
const date = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const instant = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value) && date(value.slice(0, 10)) && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString().replace('.000Z', 'Z') === value.replace('.000Z', 'Z');
const listKey = (kind: WorkKind) => kind === 'companies' ? 'companyRecords' : kind;
const isSupervisor = (actor: AccountUser) => actor.role === 'director' || actor.role === 'admin';
const canAccess = (actor: AccountUser, entry: AnyWorkEntry) => isSupervisor(actor) || actor.role === 'manager' && entry.assigneeId === actor.id;

/** Old stores may omit work entirely. Existing malformed work is never silently discarded. */
export function validateWorkData(value: unknown): asserts value is WorkData | undefined {
  if (value === undefined) return;
  if (!object(value) || !Array.isArray(value.tasks) || !Array.isArray(value.companyRecords) || !Array.isArray(value.notes)) throw new StoreError('Invalid work storage');
  const ids = new Set<string>();
  for (const kind of ['tasks', 'companyRecords', 'notes'] as const) {
    const rows = value[kind];
    if (!Array.isArray(rows)) throw new StoreError('Invalid work collection');
    for (const row of rows) {
      if (!object(row) || !identifier(row.id) || ids.has(row.id) || !Number.isSafeInteger(row.version) || Number(row.version) < 1 || !identifier(row.assigneeId) || !identifier(row.createdBy) || !identifier(row.updatedBy) || !instant(row.createdAt) || !instant(row.updatedAt)) throw new StoreError('Invalid work entry');
      ids.add(row.id);
      if (kind === 'tasks' && (!boundedText(row.title, 200, true) || !boundedText(row.description, 10000) || !workStatuses.some(status => status.id === row.status) || row.companyId !== null && !identifier(row.companyId) || row.dueDate !== null && !date(row.dueDate) || row.reminderAt !== null && !instant(row.reminderAt))) throw new StoreError('Invalid work task');
      if (kind === 'notes' && (!boundedText(row.title, 200, true) || !boundedText(row.content, 10000))) throw new StoreError('Invalid work note');
      if (kind !== 'notes') {
        if (row.archivedAt !== undefined && row.archivedAt !== null && !instant(row.archivedAt)) throw new StoreError('Invalid work archive');
        if (row.attachments !== undefined) {
          if (!Array.isArray(row.attachments) || row.attachments.length > 20) throw new StoreError('Invalid attachments');
          let total = 0;
          const fileIds = new Set<string>();
          for (const file of row.attachments) {
            if (!object(file) || !identifier(file.id) || fileIds.has(file.id) || !boundedText(file.name, 200, true) || (/[\\/]/.test(file.name) || [...file.name].some(char => char.charCodeAt(0) < 32)) || !instant(file.createdAt) || !identifier(file.authorId) || !Number.isSafeInteger(file.size) || Number(file.size) < 0 || Number(file.size) > workFileLimit || typeof file.data !== 'string' || Buffer.from(file.data, 'base64').toString('base64') !== file.data || Buffer.from(file.data, 'base64').length !== file.size) throw new StoreError('Invalid attachment');
            fileIds.add(file.id); total += Number(file.size);
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
          comments.add(comment.id);
        }
      }
    }
  }
}

export function readWork(data: OperationsData, snapshot: Snapshot, params: URLSearchParams, actor: AccountUser, users: AccountUser[]): WorkResponse {
  if (!['director', 'admin', 'manager'].includes(actor.role)) throw new ApiError(403, 'Нет доступа к рабочему пространству.');
  const requested = params.get('assigneeId');
  if (requested && requested !== 'mine' && !users.some(user => user.id === requested)) throw new ApiError(400, 'Сотрудник не найден.');
  const assigneeId = requested === 'mine' ? actor.id : requested;
  const work = data.work ?? emptyWork();
  const visible = (entry: AnyWorkEntry) => canAccess(actor, entry) && (!assigneeId || entry.assigneeId === assigneeId);
  return {
    work: { tasks: work.tasks.filter(visible).map(publicWorkEntry), companyRecords: work.companyRecords.filter(visible).map(publicWorkEntry), notes: work.notes.filter(visible) },
    users: isSupervisor(actor) ? users : users.map(user => ({ ...user, login: '' })), companies: snapshot.companies, currentUser: actor, revision: data.revision,
  };
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
  const file = entry && canAccess(actor, entry) ? entry.attachments?.find(row => row.id === fileId) : undefined;
  if (!file) throw new ApiError(404, 'Файл не найден или недоступен.');
  return file;
}
export interface WorkMutationResult { entry?: AnyWorkEntry; deleted?: boolean; id?: string; created?: boolean; changed: boolean }

/** Called inside the existing storage transaction; both authorization and version checks are atomic. */
export function mutateWork(data: OperationsData, snapshot: Snapshot, kindValue: string, body: Record<string, unknown>, id: string | undefined, method: string, actor: AccountUser, users: AccountUser[]): WorkMutationResult {
  if (!['director', 'admin', 'manager'].includes(actor.role)) throw new ApiError(403, 'Нет доступа к рабочему пространству.');
  if (!['tasks', 'companies', 'notes'].includes(kindValue)) throw new ApiError(404, 'Раздел работы не найден.');
  if (!['POST', 'PATCH', 'DELETE'].includes(method) || (method === 'POST') === !!id) throw new ApiError(405, 'Метод не поддерживается для этого маршрута.');
  const kind = kindValue as WorkKind;
  const key = listKey(kind);
  const work = data.work ?? emptyWork();
  const previous = id ? work[key].find(row => row.id === id) : undefined;
  if (id && (!previous || !canAccess(actor, previous))) throw new ApiError(404, 'Запись не найдена или недоступна.');
  if (previous && (!Number.isSafeInteger(body.version) || Number(body.version) < 1)) throw new ApiError(400, 'Передайте версию записи.');
  if (previous && body.version !== previous.version) throw new ApiError(409, 'Запись изменена другим сотрудником. Закройте карточку, обновите список и повторите изменение.');
  if (method === 'DELETE') {
    if (Object.keys(body).some(key => key !== 'version')) throw new ApiError(400, 'В запросе есть неизвестные параметры.');
    if (key === 'tasks') work.tasks = work.tasks.filter(row => row.id !== id);
    else if (key === 'companyRecords') work.companyRecords = work.companyRecords.filter(row => row.id !== id);
    else work.notes = work.notes.filter(row => row.id !== id);
    data.work = work;
    return { deleted: true, id, changed: true };
  }
  const allowed = ['version', 'requestId', 'assigneeId', ...(kind !== 'notes' ? ['archived', 'comment', 'addAttachments'] : []), ...(kind === 'tasks' ? ['title', 'description', 'status', 'companyId', 'dueDate', 'reminderAt'] : kind === 'companies' ? ['companyId', 'question', 'comment', 'reminderAt'] : ['title', 'content'])];
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new ApiError(400, 'В запросе есть неизвестные параметры.');
  if (previous && body.requestId !== undefined || !previous && body.version !== undefined) throw new ApiError(400, 'Некорректные параметры создания или изменения.');
  if (body.requestId !== undefined && (typeof body.requestId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(body.requestId))) throw new ApiError(400, 'Некорректный идентификатор запроса.');
  const get = (name: string, fallback: unknown) => body[name] === undefined ? previous ? (previous as unknown as Record<string, unknown>)[name] : fallback : body[name];
  const assigneeId = get('assigneeId', actor.id);
  if (!identifier(assigneeId) || !users.some(user => user.id === assigneeId)) throw new ApiError(400, 'Выберите действующего сотрудника.');
  // Managers may create for themselves and then explicitly hand their task over; they cannot write into another employee's list directly.
  if (!previous && !isSupervisor(actor) && assigneeId !== actor.id) throw new ApiError(403, 'Создайте запись для себя. Затем её можно передать сотруднику.');
  const companyId = kind === 'notes' ? null : get('companyId', null);
  if (kind !== 'notes' && (companyId !== null || kind === 'companies') && (!identifier(companyId) || !snapshot.companies.some(company => company.id === companyId && (!company.directoryArchived || previous && 'companyId' in previous && previous.companyId === companyId)))) throw new ApiError(400, 'Выберите доступную компанию из справочника.');
  const now = new Date().toISOString();
  const common = { id: id ?? `work-${kind}-${body.requestId ?? randomUUID()}`, version: (previous?.version ?? 0) + 1, assigneeId, createdAt: previous?.createdAt ?? now, updatedAt: now, createdBy: previous?.createdBy ?? actor.id, updatedBy: actor.id };
  let entry: AnyWorkEntry;
  if (kind === 'tasks') {
    const status = get('status', 'todo');
    if (!workStatuses.some(row => row.id === status)) throw new ApiError(400, 'Неизвестное состояние задачи.');
    entry = { ...common, title: stringField(get('title', ''), 'Название', 200, true), description: stringField(get('description', ''), 'Описание', 10000), status: status as WorkTask['status'], companyId: companyId as string | null, dueDate: optionalDate(get('dueDate', null), 'Срок'), reminderAt: optionalDate(get('reminderAt', null), 'Напоминание', true) };
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
    record.archivedAt = body.archived === true ? previousRecord?.archivedAt ?? now : body.archived === false ? null : previousRecord?.archivedAt ?? null;
    if (kind === 'tasks') {
      record.comments = [...(previousRecord?.comments ?? [])];
      const comment = body.comment === undefined ? '' : stringField(body.comment, 'Комментарий', 10000);
      if (comment) record.comments.push({ id: `work-comment-${randomUUID()}`, text: comment, authorId: actor.id, createdAt: now });
    }
    const files: WorkAttachment[] = [...(previousRecord?.attachments ?? [])];
    if (body.addAttachments !== undefined) {
      if (!Array.isArray(body.addAttachments) || body.addAttachments.length > 20) throw new ApiError(400, 'Некорректный список файлов.');
      for (const file of body.addAttachments) {
        if (!object(file) || Object.keys(file).some(key => !['name', 'data'].includes(key)) || !boundedText(file.name, 200, true) || (/[\\/]/.test(file.name) || [...file.name].some(char => char.charCodeAt(0) < 32)) || typeof file.data !== 'string' || file.data.length > Math.ceil(workFileLimit / 3) * 4 || Buffer.from(file.data, 'base64').toString('base64') !== file.data || Buffer.from(file.data, 'base64').length > workFileLimit) throw new ApiError(400, 'Файл: до 1 МБ, имя до 200 символов без путей.');
        files.push({ id: `work-file-${randomUUID()}`, name: file.name, data: file.data, size: Buffer.from(file.data, 'base64').length, authorId: actor.id, createdAt: now });
      }
    }
    if (files.length > 20 || files.reduce((sum, file) => sum + file.size, 0) > workFilesTotalLimit) throw new ApiError(400, 'В карточке допускается до 20 файлов, суммарно до 2 МБ.');
    record.attachments = files;
  }
  if (!previous) {
    const duplicate = work[key].find(row => row.id === entry.id);
    if (duplicate) {
      // A lost POST response can be retried without producing a second task or comment.
      if (!canAccess(actor, duplicate) || duplicate.createdBy !== actor.id) throw new ApiError(409, 'Идентификатор запроса уже использован.');
      const comparable = (row: AnyWorkEntry) => Object.fromEntries(Object.entries(row).filter(([key]) => !['version', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy', 'comments', 'attachments'].includes(key)));
      const originalComment = (duplicate as WorkCompanyRecord).comments?.[0]?.text ?? '';
      if (JSON.stringify(comparable(duplicate)) !== JSON.stringify(comparable(entry)) || kind !== 'notes' && originalComment !== String(body.comment ?? '').trim()) throw new ApiError(409, 'Запрос уже сохранён с другими значениями. Обновите список.');
      if (JSON.stringify(('attachments' in duplicate ? duplicate.attachments : [])?.map(file => ({name:file.name,data:file.data}))) !== JSON.stringify(('attachments' in entry ? entry.attachments : [])?.map(file => ({name:file.name,data:file.data})))) throw new ApiError(409, 'Запрос уже сохранён с другими файлами.');
      return { entry: publicWorkEntry(duplicate), created: false, changed: false };
    }
  }
  if (key === 'tasks') work.tasks = [...work.tasks.filter(row => row.id !== entry.id), entry as WorkTask];
  else if (key === 'companyRecords') work.companyRecords = [...work.companyRecords.filter(row => row.id !== entry.id), entry as WorkCompanyRecord];
  else work.notes = [...work.notes.filter(row => row.id !== entry.id), entry as WorkNote];
  validateWorkData(work);
  data.work = work;
  return { entry: publicWorkEntry(entry), created: !previous, changed: true };
}

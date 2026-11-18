import { randomUUID } from 'node:crypto';
import { hasSection, isAdministrator, type AccountUser } from '../web/src/auth-model';
import { commonBoardId, isBoardMember, type WorkBoard } from '../web/src/kanban-model';
import { emptyWork, workStatuses } from '../web/src/work-model';
import { ApiError } from './api-error';
import { ownCustomerIds } from './auth-scope';
import type { Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, max: number, required = true): value is string =>
  typeof value === 'string' && value.length <= max && (!required || !!value.trim());

export function validBoards(value: unknown): boolean {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const boardIds = new Set<string>();
  return value.every(board => {
    if (!record(board) || !text(board.id, 180) || boardIds.has(board.id) || !text(board.title, 160) ||
      !text(board.ownerId, 180, board.id !== commonBoardId) || !(board.companyId == null || text(board.companyId, 180)) ||
      (board.group !== undefined && !text(board.group, 100, false)) ||
      (board.memberIds !== undefined && (!Array.isArray(board.memberIds) || !board.memberIds.every(id => text(id, 180)) || new Set(board.memberIds).size !== board.memberIds.length)) ||
      !Number.isSafeInteger(board.version) || Number(board.version) < 1 || !Array.isArray(board.columns)) return false;
    boardIds.add(board.id);
    const ids = new Set<string>();
    const unique = (id: unknown) => {
      if (!text(id, 180) || ids.has(id)) return false;
      ids.add(id);
      return true;
    };
    return board.columns.every(col => record(col) && unique(col.id) && text(col.title, 160) && Array.isArray(col.cards) &&
      col.cards.every(card => record(card) && unique(card.id) && text(card.title, 200) && text(card.description, 10000, false)));
  });
}

export const hasCompanyBoards = (data: OperationsData) => !!data.work?.boards?.some(board => !!board.companyId);

/** Capture the previous audience once. Subsequent company assignments do not grant project membership. */
export function convertCompanyBoards(data: OperationsData, snapshot: Snapshot) {
  const old = data.work?.boards?.filter(board => board.companyId) ?? [];
  if (!old.length) return false;
  const people = (data.accounts?.users ?? []).filter(user => user.active && !user.deletedAt && user.role !== 'driver' && hasSection(user, 'work'))
    .map(user => ({ id: user.id, companies: isAdministrator(user) ? null : ownCustomerIds(snapshot, user) }));
  const companyIds = new Set(snapshot.companies.filter(c => c.roles.some(r => r === 'customer' || r === 'supplier')).map(c => c.id));
  for (const board of old) {
    const id = board.companyId!;
    board.memberIds = companyIds.has(id) ? people.filter(p => p.id !== board.ownerId && (!p.companies || p.companies.has(id))).map(p => p.id) : [];
    delete board.companyId;
    board.version++;
  }
  return true;
}

function commonBoard(): WorkBoard {
  return { id: commonBoardId, title: 'Общий канбан', ownerId: '', version: 1,
    columns: workStatuses.map(({ id, name }) => ({ id, title: name, cards: [] })) };
}
export function getBoard(data: OperationsData, id: unknown) {
  return data.work?.boards?.find(b => b.id === id) ?? (id === commonBoardId ? commonBoard() : undefined);
}
export function persistBoard(data: OperationsData, board: WorkBoard) {
  const boards = (data.work ??= emptyWork()).boards ??= [];
  if (!boards.some(b => b.id === board.id)) boards.push(board);
}
export function canReadBoardTask(data: OperationsData, boardId: string, userId: string) {
  const board = getBoard(data, boardId);
  return !!board && isBoardMember(board, userId);
}
export function boardDirectory(data: OperationsData, actor: AccountUser) {
  const boards = (data.work?.boards ?? []).filter(board => board.id !== commonBoardId && isBoardMember(board, actor.id));
  return { boards: [getBoard(data, commonBoardId)!, ...boards] };
}

function members(data: OperationsData, ownerId: string, value: unknown): string[] {
  if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || id === ownerId ||
      !data.accounts?.users.some(u => u.id === id && u.active && !u.deletedAt && u.role !== 'driver' && hasSection(u, 'work')))) {
    throw new ApiError(400, 'Выберите действующих сотрудников с доступом к разделу «Работа».');
  }
  return [...new Set<string>(value)];
}
function field(value: unknown, max: number, required = true) {
  if (!text(value, max, required)) throw new ApiError(400, required ? 'Проверьте название и его длину.' : 'Описание слишком длинное.');
  return value.trim();
}

export function mutateBoard(data: OperationsData, actor: AccountUser, method: string, id: string | undefined, body: Record<string, unknown>) {
  const directory = boardDirectory(data, actor);
  const work = data.work ??= emptyWork();
  const boards = work.boards ??= [];
  if (method === 'POST' && !id) {
    if (!text(body.requestId, 36) || !/^[0-9a-f-]{36}$/i.test(body.requestId)) throw new ApiError(400, 'Не указан идентификатор новой доски.');
    const title = field(body.title, 160);
    if (body.companyId != null) throw new ApiError(400, 'Обновите страницу и выберите участников проекта.');
    const memberIds = members(data, actor.id, body.memberIds ?? []);
    const group = field(body.group ?? '', 100, false);
    const previous = boards.find(row => row.id === body.requestId);
    if (previous) {
      if (previous.ownerId === actor.id && previous.title === title && previous.group === group && JSON.stringify(previous.memberIds) === JSON.stringify(memberIds)) return { result: previous, changed: false };
      throw new ApiError(409, 'Доска уже существует.');
    }
    const board: WorkBoard = { id: body.requestId, title, group, memberIds, ownerId: actor.id, version: 1,
      columns: ['К работе', 'В работе', 'Готово'].map(name => ({ id: randomUUID(), title: name, cards: [] })) };
    boards.push(board);
    return { result: board, changed: true };
  }
  if (!id || (method !== 'PATCH' && method !== 'DELETE')) throw new ApiError(405, 'Метод не поддерживается.');
  const board = directory.boards.find(row => row.id === id);
  if (!board) throw new ApiError(404, 'Доска недоступна.');
  if (board.id === commonBoardId) throw new ApiError(403, 'Общий канбан использует состояния обычных задач.');
  if (board.version !== body.version) throw new ApiError(409, 'Доска изменилась. Откройте её заново перед следующей правкой.');
  if (method === 'DELETE') {
    if (board.ownerId !== actor.id) throw new ApiError(403, 'Удаление доступно только владельцу проекта.');
    work.tasks = work.tasks.filter(task => task.boardId !== board.id);
    boards.splice(boards.indexOf(board), 1);
    return { result: null, changed: true };
  }
  persistBoard(data, board);
  const column = board.columns.find(col => col.id === body.columnId);
  switch (body.action) {
    case 'rename':
      if (board.ownerId !== actor.id) throw new ApiError(403, 'Настройки проекта доступны только владельцу.');
      if (body.memberIds !== undefined) board.memberIds = members(data, actor.id, body.memberIds);
      if (body.group !== undefined) board.group = field(body.group, 100, false);
      delete board.companyId;
      board.title = field(body.title, 160);
      break;
    case 'addColumn':
      board.columns.push({ id: randomUUID(), title: field(body.title, 160), cards: [] });
      break;
    case 'renameColumn':
    case 'deleteColumn':
      if (!column) throw new ApiError(404, 'Колонка недоступна.');
      if (body.action === 'renameColumn') column.title = field(body.title, 160);
      else {
        if (column.cards.length) throw new ApiError(409, 'Сначала перенесите задачи в другую колонку.');
        board.columns.splice(board.columns.indexOf(column), 1);
      }
      break;
    case 'moveCard': {
      const source = board.columns.find(col => col.cards.some(card => card.id === body.cardId));
      const card = source?.cards.find(row => row.id === body.cardId);
      if (!source || !card || !column) throw new ApiError(404, 'Задача или колонка недоступна.');
      if (body.beforeId === card.id) throw new ApiError(400, 'Выберите другую задачу для позиции.');
      const before = body.beforeId == null ? null : column.cards.find(row => row.id === body.beforeId);
      if (body.beforeId != null && !before) throw new ApiError(400, 'Выберите позицию в колонке.');
      source.cards.splice(source.cards.indexOf(card), 1);
      column.cards.splice(before ? column.cards.indexOf(before) : column.cards.length, 0, card);
      break;
    }
    default: throw new ApiError(400, 'Неизвестное действие с доской.');
  }
  board.version++;
  return { result: board, changed: true };
}

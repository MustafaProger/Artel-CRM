import type { WorkTask } from './work-model';

export const commonBoardId = 'work-common';
export interface BoardCard { id: string; title: string; description: string }
export interface BoardColumn { id: string; title: string; cards: BoardCard[] }
export interface WorkBoard {
  id: string;
  title: string;
  ownerId: string;
  /** Only present in stores created by the original company-board editor. */
  companyId?: string | null;
  memberIds?: string[];
  group?: string;
  version: number;
  columns: BoardColumn[];
}
export const isBoardMember = (board: WorkBoard, id: string) =>
  board.id === commonBoardId || board.ownerId === id || !!board.memberIds?.includes(id);

export interface BoardDirectory { boards: WorkBoard[]; tasks: WorkTask[] }
export interface TaskPlacement { board: WorkBoard; column: BoardColumn; card?: BoardCard }

/** Old cards acquire their full task record on first save. Until then there is no recorded creation date. */
export function legacyBoardTask(board: WorkBoard, card: BoardCard): WorkTask {
  return { ...card, boardId: board.id, version: 1, createdAt: '', updatedAt: '', createdBy: board.ownerId,
    updatedBy: board.ownerId, assigneeId: board.ownerId, companyId: null, dueDate: null, reminderAt: null, status: 'todo' };
}

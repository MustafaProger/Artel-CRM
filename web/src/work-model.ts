import type { AccountUser } from './auth-model';
import type { Company } from './model';

/** The Work picker uses the same active clients and suppliers as Directories. */
export const isWorkDirectoryCompany = (company: Company): boolean =>
  !company.directoryArchived && company.roles.some(role => role === 'customer' || role === 'supplier');

export const workStatuses = [
  { id: 'todo', name: 'К работе' },
  { id: 'doing', name: 'В работе' },
  { id: 'done', name: 'Готово' },
  { id: 'failed', name: 'Не выполнена' },
] as const;
export type WorkStatus = (typeof workStatuses)[number]['id'];
export const isClosedWorkStatus = (status: WorkStatus): status is 'done' | 'failed' =>
  status === 'done' || status === 'failed';
export const workPriorities = [1, 2, 3, 4] as const;
export type WorkPriority = (typeof workPriorities)[number];
export type WorkKind = 'tasks' | 'companies' | 'notes';

export interface WorkEntry {
  id: string;
  version: number;
  assigneeId: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
}
export interface WorkSubtask { id: string; title: string; done: boolean }
export const workSubtaskLimit = 50;

export interface WorkTask extends WorkEntry {
  /** Older records use the single assigneeId. */
  assigneeIds?: string[];
  archivedAt?: string | null;
  subtasks?: WorkSubtask[];
  comments?: WorkComment[];
  attachments?: WorkAttachment[];
  title: string;
  description: string;
  status: WorkStatus;
  /** Set by the task author to receive a push when a colleague completes it. */
  /** Older tasks without a priority are treated as P4. */
  priority?: WorkPriority;
  companyId: string | null;
  dueDate: string | null;
  /** UTC instant; entered and displayed in the employee's browser time zone. */
  reminderAt: string | null;
}
export interface WorkComment { id: string; text: string; createdAt: string; authorId: string; handoffTo?: string[] }
export const workFileLimit = 20 * 1024 * 1024;
export const workFilesTotalLimit = 20 * 1024 * 1024;
export interface WorkAttachment { id: string; name: string; size: number; createdAt: string; authorId: string; data?: string }
export interface WorkCompanyRecord extends WorkEntry {
  archivedAt?: string | null;
  attachments?: WorkAttachment[];
  companyId: string;
  question: string;
  reminderAt: string | null;
  comments: WorkComment[];
}
export interface WorkNote extends WorkEntry { title: string; content: string }
export interface WorkData {
  tasks: WorkTask[];
  companyRecords: WorkCompanyRecord[];
  notes: WorkNote[];
}
export type AnyWorkEntry = WorkTask | WorkCompanyRecord | WorkNote;
export interface WorkResponse {
  work: WorkData;
  users: AccountUser[];
  /** Names referenced by visible records, including former employees. Never used for new assignments. */
  historicalUsers: Pick<AccountUser, 'id' | 'name'>[];
  companies: Company[];
  currentUser: AccountUser;
  revision: number;
  todayTaskCount: number;
}

export const workAssigneeIds = (entry: AnyWorkEntry): readonly string[] =>
  'status' in entry && entry.assigneeIds ? entry.assigneeIds : [entry.assigneeId];

export const isMyWork = (entry: AnyWorkEntry, userId: string): boolean =>
  workAssigneeIds(entry).includes(userId) || 'status' in entry && entry.createdBy === userId;

const workDayFormatter = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' });
export const workToday = (now = new Date()): string => workDayFormatter.format(now);

export const emptyWork = (): WorkData => ({ tasks: [], companyRecords: [], notes: [] });

import type { AccountUser } from './auth-model';
import type { Company } from './model';

export const workStatuses = [
  { id: 'todo', name: 'К выполнению' },
  { id: 'doing', name: 'В работе' },
  { id: 'done', name: 'Готово' },
] as const;
export type WorkStatus = (typeof workStatuses)[number]['id'];
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
export interface WorkTask extends WorkEntry {
  archivedAt?: string | null;
  comments?: WorkComment[];
  attachments?: WorkAttachment[];
  title: string;
  description: string;
  status: WorkStatus;
  companyId: string | null;
  dueDate: string | null;
  /** UTC instant; entered and displayed in the employee's browser time zone. */
  reminderAt: string | null;
}
export interface WorkComment { id: string; text: string; createdAt: string; authorId: string }
export const workFileLimit = 1024 * 1024;
export const workFilesTotalLimit = 2 * 1024 * 1024;
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
  companies: Company[];
  currentUser: AccountUser;
  revision: number;
}

export const emptyWork = (): WorkData => ({ tasks: [], companyRecords: [], notes: [] });

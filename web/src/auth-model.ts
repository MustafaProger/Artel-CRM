export type AccountRole = 'director' | 'admin' | 'manager';
export interface AccountUser { id: string; name: string; login: string; role: AccountRole; managerId: string | null; active: boolean; version: number }
export interface SessionState { user: AccountUser | null; needsSetup: boolean; setupTokenRequired: boolean }

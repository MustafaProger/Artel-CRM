export interface DocumentCategory { id: string; name: string; createdAt: string; createdBy: string }
export interface ArchiveItem { version?: number; updatedAt?: string; updatedBy?: string; id: string; categoryId: string; name: string; createdAt: string; createdBy: string }
export interface ArchiveDocument { id: string; categoryId: string; itemId?: string; title: string; expiresOn: string | null; fileName: string; size: number; data: string; createdAt: string; createdBy: string }
export interface DocumentArchive { categories: DocumentCategory[]; items?: ArchiveItem[]; documents: ArchiveDocument[] }
export interface DocumentArchiveView { categories: DocumentCategory[]; items: ArchiveItem[]; documents: (Omit<ArchiveDocument, 'data' | 'itemId'> & { itemId: string })[] }
export const documentMaxBytes = 5 * 1024 * 1024
export const moscowToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date())
export const documentExpired = (expiresOn: string | null, today = moscowToday()) => !!expiresOn && expiresOn < today

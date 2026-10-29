import { randomUUID } from 'node:crypto';
import { ApiError } from './api-error';
import type { OperationsData } from './operations-store';
import { documentMaxBytes, type DocumentArchive, type DocumentArchiveView } from '../web/src/documents-model';
const fail = (message: string): never => { throw new ApiError(400, message); };
function text(value: unknown, label: string, max = 200): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > max || Array.from(value).some(char => char.charCodeAt(0) < 32)) return fail(`Проверьте поле «${label}» (до ${max} символов).`);
  return value.trim();
}
function expiry(value: unknown): string | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) return fail('Укажите существующую дату окончания.');
  return value;
}
export function archiveView(archive: DocumentArchive = { categories: [], documents: [] }): DocumentArchiveView {
  const items = [...(archive.items ?? [])];
  for (const category of archive.categories) {
    if (archive.documents.some(d => d.categoryId === category.id && !d.itemId)) items.push({ ...category, id: `legacy-${category.id}`, categoryId: category.id, name: 'Документы категории' });
  }
  return { categories: archive.categories, items, documents: archive.documents.map(({ data: _data, ...entry }) => ({ ...entry, itemId: entry.itemId ?? `legacy-${entry.categoryId}` })) };
}
export function validateDocumentArchive(value: unknown): asserts value is DocumentArchive {
  if (!value || typeof value !== 'object') throw new Error('Invalid document archive');
  const a = value as DocumentArchive;
  if (!Array.isArray(a.categories) || !Array.isArray(a.documents) || (a.items !== undefined && !Array.isArray(a.items))) throw new Error('Invalid document archive');
  const ids = new Set<string>();
  for (const entry of [...a.categories, ...(a.items ?? []), ...a.documents]) {
    if (!entry || typeof entry.id !== 'string' || ids.has(entry.id) || typeof entry.createdBy !== 'string' || !Number.isFinite(Date.parse(entry.createdAt))) throw new Error('Invalid document metadata');
    ids.add(entry.id);
  }
  for (const c of a.categories) text(c.name, 'Категория');
  for (const item of a.items ?? []) {
    text(item.name, 'Название элемента');
    if (item.version !== undefined && (!Number.isSafeInteger(item.version) || item.version < 1)) throw new Error('Invalid item version');
    if (!a.categories.some(c => c.id === item.categoryId)) throw new Error('Invalid item category');
  }
  for (const d of a.documents) {
    if (d.itemId !== undefined && !a.items?.some(i => i.id === d.itemId && i.categoryId === d.categoryId)) throw new Error('Invalid document item');
    text(d.title, 'Название'); text(d.fileName, 'Файл'); expiry(d.expiresOn);
    if (!a.categories.some(c => c.id === d.categoryId) || typeof d.data !== 'string' || d.size <= 0 || d.size > documentMaxBytes || Buffer.from(d.data, 'base64').length !== d.size || Buffer.from(d.data, 'base64').toString('base64') !== d.data) throw new Error('Invalid document file');
  }
}
export function createArchiveEntry(data: OperationsData, kind: string, input: unknown, actorId: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Некорректный запрос.');
  const b = input as Record<string, unknown>;
  const archive = data.documentArchive ??= { categories: [], documents: [] };
  const normalized = archiveView(archive);
  archive.items = normalized.items;
  for (const doc of archive.documents) doc.itemId ??= `legacy-${doc.categoryId}`;
  const metadata = { id: randomUUID(), createdAt: new Date().toISOString(), createdBy: actorId };
  if (kind === 'categories') {
    const name = text(b.name, 'Категория');
    if (archive.categories.some(c => c.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) throw new ApiError(409, 'Такая категория уже есть.');
    const entry = { ...metadata, name }; archive.categories.push(entry); return entry;
  }
  if (!archive.categories.some(c => c.id === b.categoryId)) return fail('Выберите существующую категорию.');
  if (kind === 'items') {
    const name = text(b.name, 'Название элемента');
    if (archive.items.some(i => i.categoryId === b.categoryId && i.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) throw new ApiError(409, 'В этой категории уже есть такой элемент.');
    const entry = { ...metadata, categoryId: b.categoryId as string, name, version: 1 }; archive.items.push(entry); return entry;
  }
  if (!archive.items.some(i => i.id === b.itemId && i.categoryId === b.categoryId)) return fail('Выберите элемент в этой категории.');
  const title = text(b.title, 'Название'), fileName = text(b.fileName, 'Файл'), expiresOn = expiry(b.expiresOn);
  if (typeof b.data !== 'string' || b.data.length > Math.ceil(documentMaxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b.data)) return fail('Файл слишком большой или повреждён. Максимум 5 МБ.');
  const bytes = Buffer.from(b.data, 'base64');
  if (!bytes.length || bytes.length > documentMaxBytes || bytes.toString('base64') !== b.data) return fail('Выберите непустой файл до 5 МБ.');
  if (archive.documents.reduce((sum, d) => sum + d.size, 0) + bytes.length > 24 * 1024 * 1024) throw new ApiError(413, 'Локальный архив заполнен (24 МБ).');
  const entry = { ...metadata, categoryId: b.categoryId as string, itemId: b.itemId as string, title, fileName, expiresOn, size: bytes.length, data: b.data };
  archive.documents.push(entry);
  const item = archive.items.find(i => i.id === b.itemId)!; item.version = (item.version ?? 1) + 1;
  return archiveView({ categories: [], documents: [entry] }).documents[0];
}


/** One transaction saves the card and all attachments, including staged removals. */
export function saveArchiveCard(data: OperationsData, input: unknown, actorId: string, id?: string) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Некорректный запрос.');
  const b = input as Record<string, unknown>;
  const archive = data.documentArchive ??= { categories: [], documents: [] };
  archive.items = archiveView(archive).items;
  for (const doc of archive.documents) doc.itemId ??= `legacy-${doc.categoryId}`;
  const previous = id ? archive.items.find(i => i.id === id) : undefined;
  if (id && !previous) throw new ApiError(404, 'Документ не найден.');
  if (previous && b.version !== (previous.version ?? 1)) throw new ApiError(409, 'Документ уже изменён. Закройте окно и обновите список перед повторным редактированием.');
  const name = text(b.name, 'Наименование');
  const categoryId = previous?.categoryId ?? b.categoryId;
  if (!archive.categories.some(c => c.id === categoryId) || (previous && b.categoryId !== previous.categoryId)) return fail('Выберите существующую категорию.');
  if (archive.items.some(i => i.id !== id && i.categoryId === categoryId && i.name.toLocaleLowerCase('ru') === name.toLocaleLowerCase('ru'))) throw new ApiError(409, 'В этой категории уже есть документ с таким наименованием.');
  if (!Array.isArray(b.files) || b.files.length > 100) return fail('Добавьте не более 100 файлов в одну карточку.');
  const itemId = id ?? randomUUID(), now = new Date().toISOString(), seen = new Set<string>();
  const files = b.files.map(value => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail('Некорректный файл.');
    const f = value as Record<string, unknown>;
    const old = f.id ? archive.documents.find(d => d.id === f.id && d.itemId === itemId) : undefined;
    if (f.id && (!old || seen.has(old.id))) return fail('Файл не принадлежит этой карточке или указан дважды.');
    if (old) seen.add(old.id);
    const title = text(f.title, 'Название файла'), expiresOn = expiry(f.expiresOn);
    const fileName = f.data === undefined && old ? old.fileName : text(f.fileName, 'Файл');
    const encoded = f.data === undefined && old ? old.data : f.data;
    if (typeof encoded !== 'string' || !encoded.length || encoded.length > Math.ceil(documentMaxBytes / 3) * 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return fail('Выберите непустой файл до 5 МБ.');
    const bytes = Buffer.from(encoded, 'base64');
    if (!bytes.length || bytes.length > documentMaxBytes || bytes.toString('base64') !== encoded) return fail('Файл повреждён или превышает 5 МБ.');
    return { id: old?.id ?? randomUUID(), categoryId: categoryId as string, itemId, title, expiresOn, fileName, data: encoded, size: bytes.length, createdAt: old?.createdAt ?? now, createdBy: old?.createdBy ?? actorId };
  });
  const otherFiles = archive.documents.filter(d => d.itemId !== itemId);
  if ([...otherFiles, ...files].reduce((total, f) => total + f.size, 0) > 24 * 1024 * 1024) throw new ApiError(413, 'Локальный архив заполнен (24 МБ).');
  const entry = { id: itemId, categoryId: categoryId as string, name, createdAt: previous?.createdAt ?? now, createdBy: previous?.createdBy ?? actorId, updatedAt: now, updatedBy: actorId, version: (previous?.version ?? (previous ? 1 : 0)) + 1 };
  archive.items = [...archive.items.filter(i => i.id !== itemId), entry];
  archive.documents = [...otherFiles, ...files];
  return entry;
}

/** Delete the selected scope and its bytes together in the store transaction. */
export function deleteArchiveEntry(data: OperationsData, kind: 'categories' | 'cards', id: string, input: unknown) {
  const archive = data.documentArchive;
  if (!archive) throw new ApiError(404, 'Документ или категория уже удалены.');
  if (kind === 'categories') {
    if (!archive.categories.some(c => c.id === id)) throw new ApiError(404, 'Категория уже удалена.');
    archive.documents = archive.documents.filter(d => d.categoryId !== id);
    archive.items = (archive.items ?? []).filter(i => i.categoryId !== id);
    archive.categories = archive.categories.filter(c => c.id !== id);
  } else {
    const item = archiveView(archive).items.find(i => i.id === id);
    if (!item) throw new ApiError(404, 'Документ уже удалён.');
    if (!input || typeof input !== 'object' || (input as { version?: unknown }).version !== (item.version ?? 1)) throw new ApiError(409, 'Документ уже изменён. Закройте окно и перезагрузите страницу перед удалением.');
    archive.documents = archive.documents.filter(d => (d.itemId ?? `legacy-${d.categoryId}`) !== id);
    archive.items = (archive.items ?? []).filter(i => i.id !== id);
  }
}

import { win32 } from 'node:path';
import JSZip from 'jszip';
import type { DocumentArchive } from '../web/src/documents-model';
import { archiveView } from './document-archive';

const reservedName = /^(?:con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³]) *(?:\.|$)/i;

function safeName(value: string) {
  const name = value.replace(/[<>:"/\\|?*\p{Cc}]/gu, '_').trim().replace(/[. ]+$/, '');
  if (reservedName.test(name)) return '_' + name;
  return name;
}

function fitName(name: string, maxBytes: number) {
  let result = '';
  let bytes = 0;
  for (const char of name) {
    bytes += Buffer.byteLength(char);
    if (bytes > maxBytes) break;
    result += char;
  }
  return result.replace(/[. ]+$/, '');
}

function uniqueName(used: Set<string>, name: string, extension = '') {
  const stem = safeName(name) || '_';
  let suffix = '';
  for (let index = 2; ; index++) {
    const fittedStem = fitName(stem, 255 - Buffer.byteLength(suffix + extension)) || '_';
    const fileName = fittedStem + suffix + extension;
    // Case-insensitive and Unicode-normalizing filesystems must keep each entry.
    const key = fileName.normalize('NFC').toLowerCase();
    if (!used.has(key)) {
      used.add(key);
      return fileName;
    }
    suffix = ' (' + index + ')';
  }
}

export function documentArchiveZip(archive?: DocumentArchive) {
  const zip = new JSZip();
  const { categories, items } = archiveView(archive);
  const categoryNames = new Set<string>();
  const categoryFolders = new Map(categories.map(category => [category.id, {
    path: uniqueName(categoryNames, category.name),
    used: new Set<string>(),
  }]));
  for (const folder of categoryFolders.values()) zip.folder(folder.path);
  const itemFolders = new Map(items.map(item => {
    const parent = categoryFolders.get(item.categoryId)!;
    const path = parent.path + '/' + uniqueName(parent.used, item.name);
    zip.folder(path);
    return [item.id, { path, used: new Set<string>() }];
  }));
  for (const file of archive?.documents ?? []) {
    const folder = itemFolders.get(file.itemId ?? 'legacy-' + file.categoryId)!;
    const originalExtension = win32.extname(file.fileName);
    const extension = fitName(safeName(originalExtension), 64);
    const title = file.title.trim();
    const hasExtension = extension && title.toLowerCase().endsWith(extension.toLowerCase());
    const filename = uniqueName(folder.used, hasExtension ? title.slice(0, -extension.length) : title, extension);
    zip.file(folder.path + '/' + filename, Buffer.from(file.data, 'base64'), { date: new Date(file.createdAt) });
  }
  // Most attachments are already compressed, and the archive store limits their total size.
  return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' });
}

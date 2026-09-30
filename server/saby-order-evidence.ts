import { SabyError } from './saby-client';

interface XmlNode { name: string; attributes: Record<string, string>; children: Array<XmlNode | string> }
export interface SabySenderTitleIdentity { fileId: string; date: string; time: string }
function failure(): never { throw new SabyError('unknown', 'Текущий титул заявки в Saby не подтверждает сохранённые сведения рейса. Новые ЭТрН не создаются; требуется сверка.', true); }
const namePattern = /^[A-Za-z_А-Яа-яЁё][A-Za-z0-9_А-Яа-яЁё.:-]*$/u;
function xmlText(value: string): string {
  let invalid = false;
  const text = value.replace(/&([^;]*);/g, (_all, entity: string) => {
    const known: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
    if (Object.hasOwn(known, entity)) return known[entity];
    const number = /^#\d+$/.test(entity) ? Number(entity.slice(1)) : /^#x[\da-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : NaN;
    if (!Number.isInteger(number) || ![9, 10, 13].includes(number) && (number < 32 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff || number === 0xfffe || number === 0xffff)) { invalid = true; return ''; }
    return String.fromCodePoint(number);
  });
  if (invalid || /&(?![^;]*;)/.test(value) || /&[^;]*$/.test(value)) failure();
  return text;
}
/** A bounded closed XML reader: no DTD, entity expansion, network, or executable processing. */
function parseXml(bytes: Uint8Array): XmlNode {
  if (!bytes.length || bytes.length > 2_000_000) failure();
  const prefix = new TextDecoder('ascii').decode(bytes.slice(0, 160));
  let text: string;
  try { text = new TextDecoder(/encoding=["']utf-8["']/i.test(prefix) ? 'utf-8' : 'windows-1251', { fatal: true }).decode(bytes).replace(/^\uFEFF/, ''); } catch { failure(); }
  if ([...text].some(char => { const code = char.codePointAt(0)!; return code < 32 && ![9, 10, 13].includes(code) || code === 0xfffe || code === 0xffff; })) failure();
  let offset = 0; let root: XmlNode | undefined; const stack: XmlNode[] = [];
  const appendText = (content: string) => { if (!stack.length) { if (content.trim()) failure(); } else stack.at(-1)!.children.push(content); };
  while (offset < text.length) {
    if (text[offset] !== '<') { const next = text.indexOf('<', offset); const end = next < 0 ? text.length : next; appendText(xmlText(text.slice(offset, end))); offset = end; continue; }
    if (text.startsWith('<!--', offset)) { const end = text.indexOf('-->', offset + 4); if (end < 0 || text.slice(offset + 4, end).includes('--')) failure(); offset = end + 3; continue; }
    if (text.startsWith('<?', offset)) { const end = text.indexOf('?>', offset + 2); if (end < 0) failure(); offset = end + 2; continue; }
    if (text.startsWith('<![CDATA[', offset)) { const end = text.indexOf(']]>', offset + 9); if (end < 0) failure(); appendText(text.slice(offset + 9, end)); offset = end + 3; continue; }
    if (text.startsWith('<!', offset)) failure();
    let quote = ''; let end = offset + 1;
    for (; end < text.length; end++) { const char = text[end]; if (quote) { if (char === quote) quote = ''; } else if (char === '"' || char === "'") quote = char; else if (char === '>') break; else if (char === '<') failure(); }
    if (end === text.length || quote) failure();
    const body = text.slice(offset + 1, end); offset = end + 1;
    if (body.startsWith('/')) { const name = body.slice(1).trim(); if (!namePattern.test(name) || stack.pop()?.name !== name) failure(); continue; }
    const selfClosing = body.endsWith('/'); const inner = selfClosing ? body.slice(0, -1).trimEnd() : body;
    const name = /^[^\s/]+/.exec(inner)?.[0]; if (!name || !namePattern.test(name)) failure();
    const node: XmlNode = { name, attributes: {}, children: [] }; let position = name.length;
    while (position < inner.length) {
      if (!inner.slice(position).trim()) break;
      const match = /^\s+([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/.exec(inner.slice(position));
      if (!match || !namePattern.test(match[1]) || Object.hasOwn(node.attributes, match[1])) failure();
      if ((match[2] ?? match[3]).includes('<')) failure();
      node.attributes[match[1]] = xmlText(match[2] ?? match[3]); position += match[0].length;
    }
    if (stack.length) stack.at(-1)!.children.push(node); else { if (root) failure(); root = node; }
    if (!selfClosing) { if (stack.length >= 128) failure(); stack.push(node); }
  }
  if (stack.length || !root) failure();
  return root;
}
const child = (node: XmlNode, name: string) => { const matches = node.children.filter((entry): entry is XmlNode => typeof entry !== 'string' && entry.name === name); if (matches.length !== 1) failure(); return matches[0]; };
function identity(root: XmlNode): SabySenderTitleIdentity {
  if (root.name !== 'Файл' || root.attributes.ВерсФорм !== '5.01') failure();
  const doc = child(root, 'Документ');
  child(doc, 'ПодпИнфГО');
  if (doc.attributes.КНД !== '1110361' || !root.attributes.ИдФайл || !doc.attributes.ДатИнфГО || !doc.attributes.ВрИнфГО) failure();
  const date = doc.attributes.ДатИнфГО; const parts = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(date);
  if (!parts || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(doc.attributes.ВрИнфГО)) failure();
  const day = `${parts[3]}-${parts[2]}-${parts[1]}`; const parsed = new Date(`${day}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== day) failure();
  return { fileId: root.attributes.ИдФайл, date: doc.attributes.ДатИнфГО, time: doc.attributes.ВрИнфГО };
}
function canonical(node: XmlNode, path = ''): unknown {
  const current = `${path}/${node.name}`;
  const ignored: Record<string, string[]> = {
    '/Файл': ['ИдФайл', 'ВерсПрог'],
    '/Файл/Документ': ['ДатИнфГО', 'ВрИнфГО', 'НаимЭкСубСост'],
    '/Файл/Документ/СодИнфГО': ['УИД_Зак'],
  };
  const attributes = Object.fromEntries(Object.entries(node.attributes).filter(([name]) => !ignored[current]?.includes(name)).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => [name, value.replace(/\s+/g, ' ').trim()]));
  const children: unknown[] = [];
  let text = '';
  const flush = () => { const value = text.replace(/\s+/g, ' ').trim(); if (value) children.push(value); text = ''; };
  for (const value of node.children) {
    if (typeof value === 'string') { text += value; continue; }
    flush();
    // Saby preparation fills the current authorized signer's details; they are not cargo facts.
    if (current === '/Файл/Документ' && value.name === 'ПодпИнфГО') continue;
    children.push(canonical(value, current));
  }
  flush(); return [node.name, attributes, children];
}
/** Allow Saby's file/signing header preparation, never changes to route, cargo or organization IDs. */
export function verifySabySenderBusiness(currentBytes: Uint8Array, frozenBytes: Uint8Array): SabySenderTitleIdentity {
  const current = parseXml(currentBytes); const frozen = parseXml(frozenBytes);
  const currentIdentity = identity(current); identity(frozen);
  if (JSON.stringify(canonical(current)) !== JSON.stringify(canonical(frozen))) failure();
  return currentIdentity;
}
export function verifySabyCarrierLink(bytes: Uint8Array, sender: SabySenderTitleIdentity): void {
  const root = parseXml(bytes); if (root.name !== 'Файл') failure();
  const document = child(root, 'Документ'); const link = child(document, 'ИдИнфГО'); const content = child(document, 'СодИнфПрв');
  if (document.attributes.КНД !== '1110362' || link.attributes.ИдФайлИнфГО !== sender.fileId || link.attributes.ДатФайлИнфГО !== sender.date || link.attributes.ВрФайлИнфГО !== sender.time || !link.attributes.ЭП || content.attributes.СодОпер !== '1' || !content.attributes.УИД_Зак) throw new SabyError('unknown', 'Подписанный ответ перевозчика не подтверждает приём именно этой заявки. Проверьте связь титулов в Saby.', true);
}

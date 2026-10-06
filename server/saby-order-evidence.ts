import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { SabyError } from './saby-client';

export interface XmlNode { name: string; attributes: Record<string, string>; children: Array<XmlNode | string> }
export interface SabySenderTitleIdentity { fileId: string; date: string; time: string }
export interface SabyCarrierVehicleIdentity { plate: string; vin: string; stsNumber: string }
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
export function parseXml(bytes: Uint8Array): XmlNode {
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
function legalCompanyName(value: string): string {
  const normalized = value.replace(/\s+/g, ' ').trim().toUpperCase();
  const form = '(?:ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ|ООО)';
  const prefix = new RegExp(`^${form} (.+)$`).exec(normalized);
  const suffix = new RegExp(`^(.+), ${form}$`).exec(normalized);
  const name = prefix?.[1] ?? suffix?.[1];
  if (!name) return JSON.stringify(['literal', normalized]);
  const unquoted = /^(?:"([^"]+)"|«([^»]+)»)$/.exec(name);
  return JSON.stringify(['ООО', unquoted?.[1] ?? unquoted?.[2] ?? name]);
}
function permitAddedCoordinates(current: XmlNode, frozen: XmlNode, path = ''): void {
  if (current.name !== frozen.name) return;
  const here = `${path}/${current.name}`;
  const nodes = (node: XmlNode) => node.children.filter((value): value is XmlNode => typeof value !== 'string' && !(here === '/Файл/Документ' && value.name === 'ПодпИнфГО'));
  if (['/Файл/Документ/СодИнфГО/ПунктПод/АдрПунктПод', '/Файл/Документ/СодИнфГО/АдрПункт/АдресПункт'].includes(here)) {
    const existing = nodes(frozen).filter(node => node.name === 'Коорд');
    const added = nodes(current).filter(node => node.name === 'Коорд');
    // User instruction 06.10.2026: accept coordinates added by Saby only while the address stays unchanged.
    // Remove them from the comparison copy only; comparison of every remaining address field still follows.
    if (!existing.length && added.length === 1) {
      const point = added[0]; const latitude = point.attributes.Широта; const longitude = point.attributes.Долгота;
      if (Object.keys(point.attributes).length === 2 && [latitude, longitude].every(value => typeof value === 'string' && /^[+-]?\d{1,3}(?:\.\d{1,32})?$/.test(value)) &&
          new Decimal(latitude).abs().lte(90) && new Decimal(longitude).abs().lte(180) && !point.children.some(value => typeof value !== 'string' || value.trim())) {
        current.children = current.children.filter(node => node !== point);
      }
    }
  }
  const actual = nodes(current); const expected = nodes(frozen);
  if (actual.length !== expected.length) return;
  actual.forEach((node, index) => permitAddedCoordinates(node, expected[index], here));
}
function canonical(node: XmlNode, path = '', diagnosticIgnoreCoordinates = false): unknown {
  const current = `${path}/${node.name}`;
  const ignored: Record<string, string[]> = {
    '/Файл': ['ИдФайл', 'ВерсПрог'],
    '/Файл/Документ': ['ДатИнфГО', 'ВрИнфГО', 'НаимЭкСубСост'],
    '/Файл/Документ/СодИнфГО': ['УИД_Зак'],
  };
  const attributes = Object.fromEntries(Object.entries(node.attributes).filter(([name]) => !ignored[current]?.includes(name)).sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => {
    let normalized = value.replace(/\s+/g, ' ').trim();
    // Same legal name, including Saby's short "Name, ООО" form. INN/KPP remain strictly compared.
    if (name === 'НаимОрг' && ['/Файл/Документ/СодИнфГО/СвГО/ИдСв/СвЮЛУч', '/Файл/Документ/СодИнфГО/СвПрв/ИдСв/СвЮЛУч'].includes(current)) normalized = legalCompanyName(normalized);
    // XML decimals can gain trailing zeroes. No rounding, numeric IDs or unit conversions.
    if (current === '/Файл/Документ/СодИнфГО/ОпГруз/МасГруз' && ['МасБрутЗнач', 'МасНетЗнач'].includes(name) && /^\d{1,18}(?:\.\d{1,8})?$/.test(normalized)) normalized = new Decimal(normalized).toFixed();
    return [name, normalized];
  }));
  const children: unknown[] = [];
  let text = '';
  const flush = () => { const value = text.replace(/\s+/g, ' ').trim(); if (value) children.push(value); text = ''; };
  for (const value of node.children) {
    if (typeof value === 'string') { text += value; continue; }
    flush();
    // Saby preparation fills the current authorized signer's details; they are not cargo facts.
    if (current === '/Файл/Документ' && value.name === 'ПодпИнфГО') continue;
    // Used only to choose an actionable error; never makes differing coordinates acceptable.
    if (diagnosticIgnoreCoordinates && value.name === 'Коорд' && ['/Файл/Документ/СодИнфГО/ПунктПод/АдрПунктПод', '/Файл/Документ/СодИнфГО/АдрПункт/АдресПункт'].includes(current)) continue;
    children.push(canonical(value, current, diagnosticIgnoreCoordinates));
  }
  flush(); return [node.name, attributes, children];
}
/** Allow Saby's file/signing header preparation, never changes to route, cargo or organization IDs. */
export function verifySabySenderBusiness(currentBytes: Uint8Array, frozenBytes: Uint8Array): SabySenderTitleIdentity {
  const current = parseXml(currentBytes); const frozen = parseXml(frozenBytes);
  const currentIdentity = identity(current); identity(frozen);
  permitAddedCoordinates(current, frozen);
  if (JSON.stringify(canonical(current)) !== JSON.stringify(canonical(frozen))) {
    if (JSON.stringify(canonical(current, '', true)) === JSON.stringify(canonical(frozen, '', true))) {
      throw new SabyError('validation', 'Координаты маршрута в Saby отличаются от сохранённых сведений CRM. Требуется сверка координат перед продолжением; документ не изменён.');
    }
    failure();
  }
  return currentIdentity;
}
export function verifySabyCarrierLink(bytes: Uint8Array, sender: SabySenderTitleIdentity): void {
  const root = parseXml(bytes); if (root.name !== 'Файл') failure();
  const document = child(root, 'Документ'); const link = child(document, 'ИдИнфГО'); const content = child(document, 'СодИнфПрв');
  if (document.attributes.КНД !== '1110362' || link.attributes.ИдФайлИнфГО !== sender.fileId || link.attributes.ДатФайлИнфГО !== sender.date || link.attributes.ВрФайлИнфГО !== sender.time || !link.attributes.ЭП || content.attributes.СодОпер !== '1' || !content.attributes.УИД_Зак) throw new SabyError('unknown', 'Подписанный ответ перевозчика не подтверждает приём именно этой заявки. Проверьте связь титулов в Saby.', true);
}

function carrierIdentity(root: XmlNode): void {
  if (root.name !== 'Файл' || root.attributes.ВерсФорм !== '5.01' || !root.attributes.ИдФайл?.trim() || !root.attributes.ВерсПрог?.trim()) failure();
  const document = child(root, 'Документ');
  child(document, 'ИдИнфГО'); child(document, 'СодИнфПрв'); child(document, 'ПодпИнфПрв');
  if (document.attributes.КНД !== '1110362') failure();
  const date = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(document.attributes.ДатИнфПрв ?? '');
  if (!date || !/^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(document.attributes.ВрИнфПрв ?? '')) failure();
  const iso = `${date[3]}-${date[2]}-${date[1]}`; const parsed = new Date(`${iso}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== iso) failure();
}
function carrierBusiness(node: XmlNode, path = ''): unknown {
  const current = `${path}/${node.name}`;
  // Preparation may regenerate its own file identifier, producer version and creation timestamp.
  // The source-title link, legal signatory, authority, VAT/payment and all transport data are immutable.
  const generated: Record<string, string[]> = {
    '/Файл': ['ИдФайл', 'ВерсПрог'],
    '/Файл/Документ': ['ДатИнфПрв', 'ВрИнфПрв'],
  };
  const attributes = Object.entries(node.attributes).filter(([name]) => !generated[current]?.includes(name)).sort(([a], [b]) => a.localeCompare(b));
  const children: unknown[] = []; let text = '';
  const flush = () => { if (text.trim()) children.push(text); text = ''; };
  for (const value of node.children) {
    if (typeof value === 'string') { text += value; continue; }
    flush(); children.push(carrierBusiness(value, current));
  }
  flush(); return [node.name, attributes, children];
}
/** Compare the verified filled reply with final preparation; this is not a signature or XML digest. */
export function verifySabyCarrierBusiness(currentBytes: Uint8Array, frozenBytes: Uint8Array, expectedVehicle?: SabyCarrierVehicleIdentity): void {
  const before = carrierBusinessHash(frozenBytes);
  if (carrierBusinessHash(currentBytes) === before) return;
  if (expectedVehicle) { verifySabyCarrierVehicleAddition(currentBytes, before, expectedVehicle); return; }
  carrierChanged();
}
function carrierChanged(): never { throw new SabyError('validation', 'Saby изменил сведения ответа НК при подготовке. Подписание остановлено; требуется сверка.'); }
function carrierRootHash(root: XmlNode): string {
  carrierIdentity(root);
  return createHash('sha256').update(JSON.stringify(carrierBusiness(root))).digest('hex');
}
function onlyCarrierVehicle(root: XmlNode): XmlNode | undefined {
  let current = root;
  for (const name of ['Документ', 'СодИнфПрв', 'СвТС', 'ТС']) {
    const found = current.children.filter((n): n is XmlNode => typeof n !== 'string' && n.name === name);
    if (found.length !== 1) return undefined;
    current = found[0];
  }
  return current;
}
/** Prove additions against the original complete digest; never globally ignore vehicle identifiers. */
export function verifySabyCarrierVehicleAddition(currentBytes: Uint8Array, beforeHash: string, expected: SabyCarrierVehicleIdentity): { businessHash: string } {
  const current = parseXml(currentBytes); const businessHash = carrierRootHash(current);
  const vehicle = onlyCarrierVehicle(current);
  if (!/^[a-f0-9]{64}$/.test(beforeHash) || !expected?.plate || !vehicle || vehicle.attributes.РегНомер !== expected.plate) carrierChanged();
  const possible = ([['НомерВИН', expected.vin, /^[A-Z0-9]{17}$/], ['НомСТС', expected.stsNumber, /^\d{10}$/]] as const)
    .filter(([attribute, value, format]) => typeof value === 'string' && format.test(value) && vehicle.attributes[attribute] === value)
    .map(([attribute]) => attribute);
  for (let mask = 1; mask < 1 << possible.length; mask++) {
    const candidate = structuredClone(current); const copy = onlyCarrierVehicle(candidate)!;
    possible.forEach((attribute, index) => { if (mask & 1 << index) delete copy.attributes[attribute]; });
    if (carrierRootHash(candidate) === beforeHash) return { businessHash };
  }
  carrierChanged();
}
/** Durable semantic digest for lost-preparation reconciliation; distinct from raw file SHA-256. */
export function carrierBusinessHash(bytes: Uint8Array): string {
  return carrierRootHash(parseXml(bytes));
}

import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { decodeSabySignatureBase64, SabyError } from './saby-client';
import { serializeXml } from './saby-carrier-details';
import { serializeSabyConsignmentNote, type SabyConsignmentSnapshot, type SabyConsignmentTitleOptions } from './saby-consignment-note';
import { parseXml, type XmlNode, type SabySenderTitleIdentity } from './saby-order-evidence';
import { encodeWindows1251 } from './saby-transport-order';

const fail = (message = 'Текущий титул ЭТрН не подтверждает сохранённые сведения доставки. Подписание остановлено; требуется сверка.'): never => { throw new SabyError('validation', message); };
const children = (node: XmlNode): XmlNode[] => node.children.filter((child): child is XmlNode => typeof child !== 'string');
const only = (node: XmlNode, name: string): XmlNode => { const found = children(node).filter(child => child.name === name); if (found.length !== 1) fail(); return found[0]; };
const normalized = (value: string) => value.replace(/\s+/g, ' ').trim();
const date = (value: string | undefined): boolean => {
  const match = /^(\d{2})\.(\d{2})\.(\d{4})$/.exec(value || '');
  if (!match) return false;
  const iso = `${match[3]}-${match[2]}-${match[1]}`; const parsed = new Date(`${iso}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === iso;
};
const time = (value: string | undefined) => /^([01]\d|2[0-3]):[0-5]\d:[0-5]\d$/.test(value || '');
export interface SabyConsignmentEvidenceOptions extends SabyConsignmentTitleOptions {
  /** Only the initial unsigned sender read may omit the UID. Prepared and carrier titles must contain it. */
  phase?: 'unprepared' | 'prepared';
  operatorUid?: string;
  orderCoordinatePolicy?: boolean;
  /** Issued only from a persisted, explicitly approved native-document amendment. */
  nativeAmendment?: {
    beforeMethod: 'По телефону' | typeof NATIVE_APPROVED_REDIRECTION_METHOD; afterMethod: typeof NATIVE_APPROVED_REDIRECTION_METHOD;
    /** Exact approved prepared bytes; permits only the observed preceding-second link timestamp. */
    preparedXmlSha256?: string;
    attachment: { documentId: string; revision: string; attachmentId: string; cabinetUrl: string; revisionNumber: string };
  };
}
export const NATIVE_APPROVED_REDIRECTION_METHOD = 'Электронное уведомление перевозчика о переадресовке';
export const validConsignmentOperatorUid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value) && !/^0{8}-0{4}-0{4}-0{4}-0{12}$/.test(value);
function operatorUid(content: XmlNode, options: SabyConsignmentEvidenceOptions): string | undefined {
  if (options.senderTitleVersion !== 2) return undefined;
  const uid = content.attributes.УИД_ТрН;
  if (uid === undefined && options.phase === 'unprepared' && options.operatorUid === undefined) return undefined;
  if (!validConsignmentOperatorUid(uid) || options.operatorUid !== undefined && (!validConsignmentOperatorUid(options.operatorUid) || uid !== options.operatorUid)) fail('Saby не подтвердил неизменный операторский УИД ЭТрН. Подписание остановлено.');
  return uid;
}

function title(bytes: Uint8Array, knd: '1110339' | '1110340') {
  const root = parseXml(bytes); const doc = only(root, 'Документ');
  if (root.name !== 'Файл' || root.attributes.ВерсФорм !== '5.01' || !root.attributes.ИдФайл || doc.attributes.КНД !== knd) fail();
  only(doc, 'Подписант');
  const dateName = knd === '1110339' ? 'ДатИнфГО' : 'ДатИнфПрвПрием';
  const timeName = knd === '1110339' ? 'ВрИнфГО' : 'ВрИнфПрвПрием';
  if (!date(doc.attributes[dateName]) || !time(doc.attributes[timeName])) fail();
  return { root, doc, content: only(doc, knd === '1110339' ? 'СодИнфГО' : 'СодИнфПрвПрием'), identity: { fileId: root.attributes.ИдФайл, date: doc.attributes[dateName], time: doc.attributes[timeName] } };
}
function legalName(value: string): string {
  const upper = normalized(value).toUpperCase(); const form = '(?:ООО|ОБЩЕСТВО С ОГРАНИЧЕННОЙ ОТВЕТСТВЕННОСТЬЮ)';
  const inner = new RegExp(`^${form} (.+)$`).exec(upper)?.[1] ?? new RegExp(`^(.+), ${form}$`).exec(upper)?.[1];
  if (!inner) return upper;
  return `ООО:${/^(?:"([^"]+)"|«([^»]+)»)$/.exec(inner)?.slice(1).find(Boolean) || inner}`;
}
function canonical(node: XmlNode, path = ''): unknown {
  const here = `${path}/${node.name}`;
  const generated: Record<string, string[]> = { '/Файл': ['ИдФайл', 'ВерсПрог'], '/Файл/Документ': ['ДатИнфГО', 'ВрИнфГО', 'НаимЭкСубСост'], '/Файл/Документ/СодИнфГО': ['УИД_ТрН'] };
  const attributes = Object.entries(node.attributes).filter(([key]) => !generated[here]?.includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => {
    let clean = normalized(value);
    if (key === 'НаимОрг' && node.name === 'СвЮЛУч') clean = legalName(clean);
    const numeric: Record<string, string[]> = { ОпГруз: ['Объем', 'КолМестГр'], ПлМасГруз: ['МасНетЗнач', 'МасБрутЗнач'], СвПогруз: ['МасБрутОтгр', 'КолМестПрием'], ПарТС: ['Грузопод', 'Вместим'], Габар: ['ВысЗнач', 'ДлЗнач', 'ШирЗнач'] };
    if (numeric[node.name]?.includes(key) && /^\d{1,18}(?:\.\d{1,9})?$/.test(clean)) clean = new Decimal(clean).toFixed();
    return [key, clean];
  });
  const result: unknown[] = []; let text = '';
  const flush = () => { if (normalized(text)) result.push(normalized(text)); text = ''; };
  for (const child of node.children) {
    if (typeof child === 'string') { text += child; continue; }
    flush();
    // Saby selects the authorized signer from the chosen certificate during Prepare.
    if (here === '/Файл/Документ' && child.name === 'Подписант') continue;
    result.push(canonical(child, here));
  }
  flush(); return [node.name, attributes, result];
}

function verifyAndNormalizeDirectCoordinates(current: XmlNode, frozen: XmlNode): void {
  const at = (root: XmlNode, path: string[]) => path.reduce((node, name) => only(node, name), root);
  for (const path of [['Документ', 'СодИнфГО', 'СвГП', 'АдресДостГр'], ['Документ', 'СодИнфГО', 'СвПогруз', 'ФАдресПогр']]) {
    const a = at(current, path), b = at(frozen, path);
    const aa = only(a, 'АдресИнф'), ba = only(b, 'АдресИнф');
    if (!aa.attributes.АдрТекст?.trim() || JSON.stringify(canonical(aa)) !== JSON.stringify(canonical(ba))) fail();
    for (const location of [a, b]) {
      const coordinates = children(location).filter(child => child.name === 'Коорд');
      if (coordinates.length > 1) fail();
      for (const node of coordinates) {
        if (Object.keys(node.attributes).sort().join('|') !== 'Долгота|Широта' || node.children.length ||
          ![node.attributes.Широта, node.attributes.Долгота].every(value => /^-?\d{1,3}(?:\.\d{1,13})?$/.test(value)) ||
          Math.abs(Number(node.attributes.Широта)) > 90 || Math.abs(Number(node.attributes.Долгота)) > 180) fail();
      }
      location.children = location.children.filter(child => typeof child === 'string' || child.name !== 'Коорд');
    }
  }
}

/** A cabinet link is evidence only when its complete query identifies the current API attachment. */
function cabinetReference(value: string, withDate: boolean): URL {
  let url: URL;
  try { url = new URL(value); } catch { return fail('Не подтверждена служебная ссылка Saby на текущий титул.'); }
  const keys = [...url.searchParams.keys()];
  const expected = ['client', 'f3', 'file', 'guid', 'org', 'ver', ...(withDate ? ['date'] : [])].sort();
  if (url.protocol !== 'https:' || url.hostname !== 'tms.saby.ru' || url.port || url.username || url.password || url.hash || url.pathname !== '/opendoc.html' ||
      keys.length !== new Set(keys).size || keys.sort().join('|') !== expected.join('|') ||
      !validConsignmentOperatorUid(url.searchParams.get('guid')) || !validConsignmentOperatorUid(url.searchParams.get('file')) ||
      !['client', 'org', 'f3', 'ver'].every(key => /^[1-9]\d{0,15}$/.test(url.searchParams.get(key) ?? ''))) fail('Не подтверждена служебная ссылка Saby на текущий титул.');
  return url;
}

function verifyApprovedNativeAmendment(current: ReturnType<typeof title>, frozen: ReturnType<typeof title>, options: SabyConsignmentEvidenceOptions): void {
  const approval = options.nativeAmendment;
  if (!approval) return;
  if (options.senderTitleVersion !== 2 || !['По телефону', NATIVE_APPROVED_REDIRECTION_METHOD].includes(approval.beforeMethod) || approval.afterMethod !== NATIVE_APPROVED_REDIRECTION_METHOD) fail();
  const sourceRedirection = only(only(frozen.content, 'УказГО'), 'СвПА');
  if (sourceRedirection.attributes.СпосПерУкПА !== approval.beforeMethod) fail();
  // Before Prepare the original unsigned artifact still contains the frozen source method.
  if (options.phase === 'unprepared') return;
  const actualRedirection = only(only(current.content, 'УказГО'), 'СвПА');
  if (actualRedirection.attributes.СпосПерУкПА !== approval.afterMethod) fail();
  const operatorBlocks = children(current.content).filter(node => node.name === 'ИнфПол' && Object.hasOwn(node.attributes, 'ИдФайлИнфПол'));
  if (operatorBlocks.length !== 1) fail('Не подтверждён единственный служебный блок Saby текущего титула.');
  const block = operatorBlocks[0]; const contents = children(block);
  if (Object.keys(block.attributes).join('|') !== 'ИдФайлИнфПол' || !validConsignmentOperatorUid(block.attributes.ИдФайлИнфПол) ||
      block.children.some(child => typeof child === 'string' && !!child.trim()) || contents.length !== 1 || contents[0].name !== 'ТекстИнф') fail();
  const link = contents[0];
  if (Object.keys(link.attributes).sort().join('|') !== 'Значение|Идентиф' || link.attributes.Идентиф !== 'Документ.СсылкаНаВложение' ||
      link.children.some(child => typeof child !== 'string' || !!child.trim())) fail();
  const source = cabinetReference(approval.attachment.cabinetUrl, false), actual = cabinetReference(link.attributes.Значение, true);
  if (!validConsignmentOperatorUid(approval.attachment.documentId) || !validConsignmentOperatorUid(approval.attachment.revision) ||
      source.searchParams.get('file') !== approval.attachment.attachmentId || source.searchParams.get('ver') !== approval.attachment.revisionNumber) fail();
  for (const [key, value] of source.searchParams) if (actual.searchParams.get(key) !== value) fail('Служебная ссылка Saby относится к другому документу или вложению.');
  const generatedAt = current.identity.date.split('.').reverse().join('') + current.identity.time.replaceAll(':', '');
  const precedingSecond = new Date(Date.parse(`${current.identity.date.split('.').reverse().join('-')}T${current.identity.time}Z`) - 1000).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  if (actual.searchParams.get('date') !== generatedAt && !(approval.preparedXmlSha256 && actual.searchParams.get('date') === precedingSecond)) fail('Служебная ссылка Saby относится к другому времени подготовки титула.');
  sourceRedirection.attributes.СпосПерУкПА = approval.afterMethod;
  current.content.children = current.content.children.filter(child => child !== block);
}

/** Compare every cargo/party/route/event field; historical callers retain strict coordinate matching. */
export function verifyConsignmentSenderBusiness(currentBytes: Uint8Array, frozenBytes: Uint8Array, policy?: 'address-direct-v1' | 'address-order-v1', options: SabyConsignmentEvidenceOptions = {}): SabySenderTitleIdentity & { operatorUid?: string } {
  const pinned = options.nativeAmendment?.preparedXmlSha256;
  if (pinned !== undefined && (!/^[a-f0-9]{64}$/.test(pinned) || createHash('sha256').update(currentBytes).digest('hex') !== pinned)) fail('Подготовленный титул отличается от согласованного файла.');
  const current = title(currentBytes, '1110339'); const frozen = title(frozenBytes, '1110339');
  verifyApprovedNativeAmendment(current, frozen, options);
  if (policy === 'address-direct-v1' || policy === 'address-order-v1') verifyAndNormalizeDirectCoordinates(current.root, frozen.root);
  if (JSON.stringify(canonical(current.root)) !== JSON.stringify(canonical(frozen.root))) fail();
  const uid = operatorUid(current.content, options);
  return { ...current.identity, ...(uid ? { operatorUid: uid } : {}) };
}

/** Exact prescribed acceptance operation, FNS 1110340 5.01 table 7.4. No unload or client acceptance. */
export const CONSIGNMENT_CARRIER_ACCEPTANCE = 'Груз принят к перевозке водителем, уполномоченным перевозчиком на перевозку груза, от лица, осуществившего погрузку груза в транспортное средство';

function carrierContext(currentBytes: Uint8Array, senderBytes: Uint8Array, snapshot: SabyConsignmentSnapshot, permitMissingAcceptance = false, options: SabyConsignmentEvidenceOptions = {}) {
  const current = title(currentBytes, '1110340'); const sender = title(senderBytes, '1110339');
  // The external document number is assigned by Saby; all remaining data comes from the frozen delivery.
  // The orchestration also compares senderBytes to its saved exact-number artifact before this call.
  const expected = serializeSabyConsignmentNote(snapshot, '00000000-0000-4000-8000-000000000000', '2025-01-01T00:00:00.000Z', sender.content.attributes.НомерТрН, options);
  verifyConsignmentSenderBusiness(senderBytes, expected.xml, snapshot.documentMode === 'nk-direct-v1' ? 'address-direct-v1' : options.orderCoordinatePolicy ? 'address-order-v1' : undefined, { ...options, phase: 'prepared' });
  const link = only(current.doc, 'ИдИнфГО');
  if (link.attributes.ИдФайлИнфГО !== sender.identity.fileId || link.attributes.ДатФайлИнфГО !== sender.identity.date || link.attributes.ВрФайлИнфГО !== sender.identity.time || !/^[A-Za-z0-9+/]+={0,2}$/.test(link.attributes.ЭП || '')) fail('Ответ перевозчика не связан с актуальным подписанным титулом отправителя ЭТрН.');
  if (Object.keys(link.attributes).some(key => !['ИдФайлИнфГО', 'ДатФайлИнфГО', 'ВрФайлИнфГО', 'ЭП'].includes(key)) || children(link).length || link.children.some(child => typeof child === 'string' && child.trim())) fail();
  const uid = sender.content.attributes.УИД_ТрН;
  if (!uid?.trim() || !permitMissingAcceptance && current.content.attributes.УИД_ТрН !== uid || current.content.attributes.УИД_ТрН && current.content.attributes.УИД_ТрН !== uid) fail('Ответ перевозчика относится к другой ЭТрН.');
  const operation = current.content.attributes.СодОпер;
  if ((!permitMissingAcceptance || operation) && normalized(operation || '') !== CONSIGNMENT_CARRIER_ACCEPTANCE) fail('Saby не подтвердил требуемое действие приёма груза перевозчиком.');
  if (Object.keys(current.content.attributes).some(key => !['УИД_ТрН', 'СодОпер'].includes(key))) fail();
  // Optional remarks/marks are new business assertions. They cannot be signed from the CRM facts.
  if (current.content.children.some(child => typeof child === 'string' ? !!child.trim() : !['ИнфПол', 'ЗамПрвПрием'].includes(child.name) || Object.keys(child.attributes).length || child.children.some(value => typeof value === 'string' ? !!value.trim() : true))) fail('В ответе перевозчика ЭТрН есть дополнительные оговорки, отметки или сведения. Требуется ручная сверка в Saby.');
  if (children(current.doc).map(child => child.name).join('|') !== 'ИдИнфГО|СодИнфПрвПрием|Подписант' || children(current.root).map(child => child.name).join('|') !== 'Документ') fail();
  if (Object.keys(current.root.attributes).some(key => !['ИдФайл', 'ВерсПрог', 'ВерсФорм'].includes(key)) || Object.keys(current.doc.attributes).some(key => !['КНД', 'ПоФактХЖ', 'ДатИнфПрвПрием', 'ВрИнфПрвПрием'].includes(key))) fail();
  return { current, uid };
}

/** T2 confirms T1 by source link. Mass, driver, vehicle and events are checked in that exact T1. */
export function verifyConsignmentCarrierBusiness(currentBytes: Uint8Array, senderBytes: Uint8Array, snapshot: SabyConsignmentSnapshot, options: SabyConsignmentEvidenceOptions = {}): void {
  carrierContext(currentBytes, senderBytes, snapshot, false, options);
}

/** Exact current detached signature linkage, not a local CMS cryptographic validation. */
export function verifyConsignmentCarrierSourceSignature(currentBytes: Uint8Array, signatureBytes: Uint8Array): void {
  const current = title(currentBytes, '1110340');
  const linked = decodeSabySignatureBase64(only(current.doc, 'ИдИнфГО').attributes.ЭП);
  if (!signatureBytes.length || !linked.equals(Buffer.from(signatureBytes))) fail('Ответ перевозчика ссылается на другую подпись исходного титула ЭТрН.');
}

/** Complete only missing standard acceptance metadata in Saby's own generated unsigned T2. */
export function fillConsignmentCarrier(bytes: Uint8Array, senderBytes: Uint8Array, snapshot: SabyConsignmentSnapshot, options: SabyConsignmentEvidenceOptions = {}): { bytes: Uint8Array; changed: boolean } {
  const { current, uid } = carrierContext(bytes, senderBytes, snapshot, true, options);
  const changed = !current.content.attributes.СодОпер || !current.content.attributes.УИД_ТрН;
  if (!changed) return { bytes, changed: false };
  current.content.attributes.СодОпер = CONSIGNMENT_CARRIER_ACCEPTANCE;
  current.content.attributes.УИД_ТрН = uid;
  const filled = encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(current.root));
  verifyConsignmentCarrierBusiness(filled, senderBytes, snapshot, options);
  return { bytes: filled, changed: true };
}

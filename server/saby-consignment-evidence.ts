import Decimal from 'decimal.js';
import { decodeSabySignatureBase64, SabyError } from './saby-client';
import { serializeXml } from './saby-carrier-details';
import { serializeSabyConsignmentNote, type SabyConsignmentSnapshot } from './saby-consignment-note';
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

/** Compare every cargo/party/route/event field; allow only service headers and equivalent scalars. */
export function verifyConsignmentSenderBusiness(currentBytes: Uint8Array, frozenBytes: Uint8Array): SabySenderTitleIdentity {
  const current = title(currentBytes, '1110339'); const frozen = title(frozenBytes, '1110339');
  if (JSON.stringify(canonical(current.root)) !== JSON.stringify(canonical(frozen.root))) fail();
  return current.identity;
}

/** Exact prescribed acceptance operation, FNS 1110340 5.01 table 7.4. No unload or client acceptance. */
export const CONSIGNMENT_CARRIER_ACCEPTANCE = 'Груз принят к перевозке водителем, уполномоченным перевозчиком на перевозку груза, от лица, осуществившего погрузку груза в транспортное средство';

function carrierContext(currentBytes: Uint8Array, senderBytes: Uint8Array, snapshot: SabyConsignmentSnapshot, permitMissingAcceptance = false) {
  const current = title(currentBytes, '1110340'); const sender = title(senderBytes, '1110339');
  // The external document number is assigned by Saby; all remaining data comes from the frozen delivery.
  // The orchestration also compares senderBytes to its saved exact-number artifact before this call.
  const expected = serializeSabyConsignmentNote(snapshot, '00000000-0000-4000-8000-000000000000', '2025-01-01T00:00:00.000Z', sender.content.attributes.НомерТрН);
  verifyConsignmentSenderBusiness(senderBytes, expected.xml);
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
export function verifyConsignmentCarrierBusiness(currentBytes: Uint8Array, senderBytes: Uint8Array, snapshot: SabyConsignmentSnapshot): void {
  carrierContext(currentBytes, senderBytes, snapshot);
}

/** Exact current detached signature linkage, not a local CMS cryptographic validation. */
export function verifyConsignmentCarrierSourceSignature(currentBytes: Uint8Array, signatureBytes: Uint8Array): void {
  const current = title(currentBytes, '1110340');
  const linked = decodeSabySignatureBase64(only(current.doc, 'ИдИнфГО').attributes.ЭП);
  if (!signatureBytes.length || !linked.equals(Buffer.from(signatureBytes))) fail('Ответ перевозчика ссылается на другую подпись исходного титула ЭТрН.');
}

/** Complete only missing standard acceptance metadata in Saby's own generated unsigned T2. */
export function fillConsignmentCarrier(bytes: Uint8Array, senderBytes: Uint8Array, snapshot: SabyConsignmentSnapshot): { bytes: Uint8Array; changed: boolean } {
  const { current, uid } = carrierContext(bytes, senderBytes, snapshot, true);
  const changed = !current.content.attributes.СодОпер || !current.content.attributes.УИД_ТрН;
  if (!changed) return { bytes, changed: false };
  current.content.attributes.СодОпер = CONSIGNMENT_CARRIER_ACCEPTANCE;
  current.content.attributes.УИД_ТрН = uid;
  const filled = encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(current.root));
  verifyConsignmentCarrierBusiness(filled, senderBytes, snapshot);
  return { bytes: filled, changed: true };
}

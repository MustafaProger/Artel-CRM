import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { SabyError } from './saby-client';
import { formatSabyVolume, SABY_VOLUME_ROUNDING_INFO, SABY_VOLUME_ROUNDING_VERSION } from './saby-volume';

export interface XmlNode { name: string; attributes: Record<string, string>; children: Array<XmlNode | string> }
export interface SabySenderTitleIdentity { fileId: string; date: string; time: string }
export interface SabyCarrierVehicleIdentity { plate: string; vin: string; stsNumber: string }
/** Persisted on newly authorized workflows; absent historical workflows keep their original rules. */
export type SabySenderVerificationPolicy = 'address-multidelivery-v1';
export const SABY_SENDER_COORDINATE_MISMATCH = 'Координаты маршрута в Saby отличаются от сохранённых сведений CRM. Требуется сверка координат перед продолжением; документ не изменён.';
function failure(): never { throw new SabyError('unknown', 'Текущий титул заявки в Saby не подтверждает сохранённые сведения рейса. Новые ЭТрН не создаются; требуется сверка.', true); }
const namePattern = /^[A-Za-z_А-Яа-яЁё][A-Za-z0-9_А-Яа-яЁё.:-]*$/u;
function xmlText(value: string): string {
  const known: Record<string, string> = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>' };
  const parts: string[] = [];
  let offset = 0;
  // Advance past each complete entity exactly once. A regex searching for a
  // missing semicolon can retry from every '&' and block the server quadratically.
  for (;;) {
    const start = value.indexOf('&', offset);
    if (start < 0) { parts.push(value.slice(offset)); return parts.join(''); }
    parts.push(value.slice(offset, start));
    const end = value.indexOf(';', start + 1);
    if (end < 0) failure();
    const entity = value.slice(start + 1, end);
    if (Object.hasOwn(known, entity)) parts.push(known[entity]);
    else {
      const number = /^#\d+$/.test(entity) ? Number(entity.slice(1)) : /^#x[\da-f]+$/i.test(entity) ? parseInt(entity.slice(2), 16) : NaN;
      if (!Number.isInteger(number) || ![9, 10, 13].includes(number) && (number < 32 || number > 0x10ffff || number >= 0xd800 && number <= 0xdfff || number === 0xfffe || number === 0xffff)) failure();
      parts.push(String.fromCodePoint(number));
    }
    offset = end + 1;
  }
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
const namedChildren = (node: XmlNode, name: string) => node.children.filter((value): value is XmlNode => typeof value !== 'string' && value.name === name);
const noContent = (node: XmlNode) => !node.children.some(value => typeof value !== 'string' || value.trim());
/** Only a rule already bound into both identical information blocks permits rounded cargo units.
 * It does not permit changing XML values: current and frozen volumes are still compared in full.
 */
function volumeMatchesLitres(volume: string, litres: string, information: Map<string, string>): boolean {
  const version = information.get(SABY_VOLUME_ROUNDING_INFO) === SABY_VOLUME_ROUNDING_VERSION ? SABY_VOLUME_ROUNDING_VERSION : undefined;
  const expected = formatSabyVolume(litres, 'litres', 2, version);
  return expected !== null && new Decimal(expected).gt(0) && new Decimal(volume).eq(expected);
}
/** Read a plain, unambiguous information block; unknown structure is never discarded. */
function plainInformation(node: XmlNode): Map<string, string> | undefined {
  if (Object.keys(node.attributes).length || node.children.some(value => typeof value === 'string' && value.trim())) return;
  const result = new Map<string, string>();
  for (const entry of node.children) {
    if (typeof entry === 'string') continue;
    const { Идентиф: key, Значение: value } = entry.attributes;
    if (entry.name !== 'ТекстИнф' || Object.keys(entry.attributes).length !== 2 || !key || !value || result.has(key) || !noContent(entry)) return;
    result.set(key, value);
  }
  return result;
}
/** Saby may omit duplicated cargo information only when all four values remain provable.
 * Deliberately limited to one cargo/delivery and the serializer's unique route 1 -> 2.
 * Only comparison copies change; original prepared bytes and signing hashes never do.
 */
function permitOmittedSingleDeliveryInformation(current: XmlNode, frozen: XmlNode): void {
  const actual = child(child(current, 'Документ'), 'СодИнфГО'); const expected = child(child(frozen, 'Документ'), 'СодИнфГО');
  const cargos = [namedChildren(actual, 'ОпГруз'), namedChildren(expected, 'ОпГруз')];
  const routes = [namedChildren(actual, 'АдрПункт'), namedChildren(expected, 'АдрПункт')];
  const infos = [namedChildren(actual, 'ИнфПол'), namedChildren(expected, 'ИнфПол')];
  if (cargos.some(values => values.length !== 1) || routes.some(values => values.length !== 2) || infos.some(values => values.length !== 1)) return;
  for (let side = 0; side < 2; side++) {
    const points = namedChildren(cargos[side][0], 'Пункт');
    if (points.length !== 1 || !noContent(points[0]) || Object.keys(points[0].attributes).length !== 3 || points[0].attributes.Погр !== '1' || points[0].attributes.Выгр !== '2' || points[0].attributes.КолГрМест !== '1' || routes[side][0].attributes.ПорНомПункт !== '1' || routes[side][0].attributes.Опер !== 'Погрузка' || routes[side][1].attributes.ПорНомПункт !== '2' || routes[side][1].attributes.Опер !== 'Выгрузка') return;
  }
  const originalBlocks = namedChildren(cargos[1][0], 'ИнфПол'); const currentBlocks = namedChildren(cargos[0][0], 'ИнфПол');
  if (originalBlocks.length !== 1 || currentBlocks.length > 1 || currentBlocks.some(block => Object.keys(block.attributes).length || !noContent(block))) return;
  const cargo = plainInformation(originalBlocks[0]); const actualInfo = plainInformation(infos[0][0]); const frozenInfo = plainInformation(infos[1][0]);
  const required = ['Доставка CRM', 'Получатель доставки', 'ИНН получателя', 'Адрес доставки'];
  if (!cargo || cargo.size !== required.length || required.some(key => !cargo.has(key)) || !actualInfo || !frozenInfo || actualInfo.size !== frozenInfo.size || [...frozenInfo].some(([key, value]) => actualInfo.get(key) !== value)) return;
  if (actualInfo.get('Получатель доставки') !== cargo.get('Получатель доставки') || actualInfo.get('ИНН получателя') !== cargo.get('ИНН получателя') || !/^\d{10}(?:\d{2})?$/.test(cargo.get('ИНН получателя')!)) return;
  const deliveries = [...actualInfo.keys()].filter(key => /^Доставка \d+$/.test(key));
  if (deliveries.length !== 1 || deliveries[0] !== 'Доставка 1' || !actualInfo.get('Рейс CRM') || actualInfo.get('Рейс CRM') !== actualInfo.get('Доставка CRM')) return;
  const prefix = `${cargo.get('Доставка CRM')}: ${cargo.get('Получатель доставки')}; `; const suffix = ` л; ${cargo.get('Адрес доставки')}`;
  const delivery = actualInfo.get('Доставка 1')!;
  if (!delivery.startsWith(prefix) || !delivery.endsWith(suffix)) return;
  const litres = delivery.slice(prefix.length, delivery.length - suffix.length);
  const decimal = /^\d{1,18}(?:\.\d{1,8})?$/;
  if (!decimal.test(litres) || !new Decimal(litres).gt(0) || cargos.some(values => !decimal.test(values[0].attributes.Объем ?? '') || !volumeMatchesLitres(values[0].attributes.Объем, litres, frozenInfo))) return;
  for (const route of routes) {
    const point = namedChildren(route[1], 'АдресПункт'); if (point.length !== 1) return;
    const address = namedChildren(point[0], 'Адрес'); if (address.length !== 1) return;
    const text = namedChildren(address[0], 'АдрИнф');
    if (text.length !== 1 || text[0].attributes.КодСтр !== '643' || text[0].attributes.АдрТекст !== cargo.get('Адрес доставки')) return;
  }
  cargos[1][0].children = cargos[1][0].children.filter(node => node !== originalBlocks[0]);
  if (currentBlocks.length) cargos[0][0].children = cargos[0][0].children.filter(node => node !== currentBlocks[0]);
}
/** Each omitted cargo block must be independently recoverable from the intact numbered summary.
 * Its route number binds that identity to the same cargo slot, volume, mass and unloading address.
 * In particular, the first recipient's INN cannot establish the identity of later recipients.
 * Validate the entire mapping before removing anything from either comparison tree.
 */
function permitOmittedDeliveryInformation(current: XmlNode, frozen: XmlNode): void {
  const contents = [current, frozen].map(root => child(child(root, 'Документ'), 'СодИнфГО'));
  const cargos = contents.map(content => namedChildren(content, 'ОпГруз'));
  const routes = contents.map(content => namedChildren(content, 'АдрПункт'));
  const infos = contents.map(content => namedChildren(content, 'ИнфПол'));
  const count = cargos[1].length;
  if (!count || cargos[0].length !== count || routes.some(points => points.length !== count + 1) || infos.some(blocks => blocks.length !== 1)) return;
  const actualInfo = plainInformation(infos[0][0]); const frozenInfo = plainInformation(infos[1][0]);
  if (!actualInfo || !frozenInfo || actualInfo.size !== frozenInfo.size || [...frozenInfo].some(([key, value]) => actualInfo.get(key) !== value)) return;
  if (!actualInfo.get('Рейс CRM')?.trim() || actualInfo.get('Рейс CRM') !== actualInfo.get('Доставка CRM')) return;
  for (const prefix of ['Доставка ', 'ИНН получателя доставки ']) {
    const keys = [...actualInfo.keys()].filter(key => key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length)));
    if (keys.length !== count || Array.from({ length: count }, (_, index) => `${prefix}${index + 1}`).some(key => !keys.includes(key))) return;
  }
  for (const points of routes) {
    if (points.some((point, index) => point.attributes.ПорНомПункт !== String(index + 1) || point.attributes.Опер !== (index ? 'Выгрузка' : 'Погрузка'))) return;
  }
  const removed: Array<{ node: XmlNode; block: XmlNode }> = [];
  const deliveryIds = new Set<string>(); const decimal = /^\d{1,18}(?:\.\d{1,8})?$/;
  for (let index = 0; index < count; index++) {
    const before = cargos[1][index]; const after = cargos[0][index];
    const originalBlocks = namedChildren(before, 'ИнфПол'); const currentBlocks = namedChildren(after, 'ИнфПол');
    if (originalBlocks.length !== 1 || currentBlocks.length > 1) return;
    const information = plainInformation(originalBlocks[0]);
    const required = ['Доставка CRM', 'Получатель доставки', 'ИНН получателя', 'Адрес доставки'];
    if (!information || information.size !== required.length || required.some(key => !information.get(key)?.trim())) return;
    const deliveryId = information.get('Доставка CRM')!; const recipient = information.get('Получатель доставки')!;
    const inn = information.get('ИНН получателя')!; const address = information.get('Адрес доставки')!;
    if (deliveryIds.has(deliveryId) || !/^\d{10}(?:\d{2})?$/.test(inn) || actualInfo.get(`ИНН получателя доставки ${index + 1}`) !== inn) return;
    deliveryIds.add(deliveryId);
    if (index === 0 && (actualInfo.get('Получатель доставки') !== recipient || actualInfo.get('ИНН получателя') !== inn)) return;
    const prefix = `${deliveryId}: ${recipient}; `; const suffix = ` л; ${address}`;
    const summary = actualInfo.get(`Доставка ${index + 1}`)!;
    if (!summary.startsWith(prefix) || !summary.endsWith(suffix)) return;
    const litres = summary.slice(prefix.length, summary.length - suffix.length);
    if (!decimal.test(litres) || !new Decimal(litres).gt(0)) return;
    for (let side = 0; side < 2; side++) {
      const cargo = cargos[side][index]; const points = namedChildren(cargo, 'Пункт');
      if (points.length !== 1 || !noContent(points[0]) || Object.keys(points[0].attributes).length !== 3 ||
        points[0].attributes.Погр !== '1' || points[0].attributes.Выгр !== String(index + 2) || points[0].attributes.КолГрМест !== '1') return;
      if (!decimal.test(cargo.attributes.Объем ?? '') || !volumeMatchesLitres(cargo.attributes.Объем, litres, frozenInfo)) return;
      const locations = namedChildren(routes[side][index + 1], 'АдресПункт');
      if (locations.length !== 1) return;
      const full = fullAddress(locations[0]); if (!full) return;
      const detail = namedChildren(full, 'АдрИнф')[0];
      if (detail.attributes.КодСтр !== '643' || detail.attributes.АдрТекст !== address) return;
    }
    if (currentBlocks.length && (!noContent(currentBlocks[0]) || Object.keys(currentBlocks[0].attributes).length)) {
      const retained = plainInformation(currentBlocks[0]);
      if (!retained || retained.size !== information.size || [...information].some(([key, value]) => retained.get(key) !== value)) return;
      continue;
    }
    removed.push({ node: before, block: originalBlocks[0] });
    if (currentBlocks.length) removed.push({ node: after, block: currentBlocks[0] });
  }
  for (const { node, block } of removed) node.children = node.children.filter(value => value !== block);
}
/** FNS defines this flag solely as the UTC indicator of ДатВрОпер.
 * An added 1 conveys no time when that date is absent on both sides.
 * Restrict to the same unique numbered unloading point; all other fields remain compared.
 */
function permitInertUnloadingUtcFlag(current: XmlNode, frozen: XmlNode): void {
  const actual = namedChildren(child(child(current, 'Документ'), 'СодИнфГО'), 'АдрПункт');
  const expected = namedChildren(child(child(frozen, 'Документ'), 'СодИнфГО'), 'АдрПункт');
  if (actual.length !== expected.length) return;
  actual.forEach((point, index) => {
    const before = expected[index]; const number = point.attributes.ПорНомПункт;
    if (!number || !/^[1-9]\d{0,2}$/.test(number) || point.attributes.Опер !== 'Выгрузка' || before.attributes.Опер !== 'Выгрузка' || before.attributes.ПорНомПункт !== number || actual.filter(row => row.attributes.ПорНомПункт === number).length !== 1 || expected.filter(row => row.attributes.ПорНомПункт === number).length !== 1) return;
    if (['ДатВрОпер', 'ПредВрОпер', 'НалКоорТочПредВрОпер'].every(key => !Object.hasOwn(point.attributes, key) && !Object.hasOwn(before.attributes, key)) && !Object.hasOwn(before.attributes, 'НалКоорТочВрОпер') && point.attributes.НалКоорТочВрОпер === '1') delete point.attributes.НалКоорТочВрОпер;
  });
}
function validCoordinates(point: XmlNode): boolean {
  const latitude = point.attributes.Широта; const longitude = point.attributes.Долгота;
  return Object.keys(point.attributes).length === 2 && [latitude, longitude].every(value => typeof value === 'string' && /^[+-]?\d{1,3}(?:\.\d{1,32})?$/.test(value)) &&
    new Decimal(latitude).abs().lte(90) && new Decimal(longitude).abs().lte(180) && noContent(point);
}
/** Preserve every address value verbatim; only attribute order and inter-element whitespace are irrelevant. */
function exactAddress(node: XmlNode): unknown {
  return [node.name, Object.entries(node.attributes).sort(([a], [b]) => a.localeCompare(b)), node.children.filter(value => typeof value !== 'string' || value.trim()).map(value => typeof value === 'string' ? value : exactAddress(value))];
}
function fullAddress(node: XmlNode): XmlNode | undefined {
  const addresses = namedChildren(node, 'Адрес');
  if (addresses.length !== 1) return;
  const address = addresses[0]; const details = namedChildren(address, 'АдрИнф');
  // This is the full-address representation emitted by our sender serializer.
  if (details.length !== 1 || address.children.some(value => typeof value === 'string' ? !!value.trim() : value !== details[0]) || !/^\d{3}$/.test(details[0].attributes.КодСтр ?? '') || !details[0].attributes.АдрТекст?.trim() || !noContent(details[0])) return;
  return address;
}
function permitCoordinatePresenceChanges(current: XmlNode, frozen: XmlNode, path = '', policy?: SabySenderVerificationPolicy): void {
  if (current.name !== frozen.name) return;
  const here = `${path}/${current.name}`;
  const nodes = (node: XmlNode) => node.children.filter((value): value is XmlNode => typeof value !== 'string' && !(here === '/Файл/Документ' && value.name === 'ПодпИнфГО'));
  if (['/Файл/Документ/СодИнфГО/ПунктПод/АдрПунктПод', '/Файл/Документ/СодИнфГО/АдрПункт/АдресПункт'].includes(here)) {
    const existing = nodes(frozen).filter(node => node.name === 'Коорд');
    const added = nodes(current).filter(node => node.name === 'Коорд');
    if (policy === 'address-multidelivery-v1' && (existing.length || added.length)) {
      const actualAddress = fullAddress(current); const expectedAddress = fullAddress(frozen);
      // User instruction 20.10.2026: the exact full address takes precedence over valid
      // provider coordinates, including changed coordinates already present on both sides.
      // Only this new persisted policy changes that rule; historical attempts stay strict.
      if (existing.length > 1 || added.length > 1 || [...existing, ...added].some(point => !validCoordinates(point)) ||
        !actualAddress || !expectedAddress || JSON.stringify(exactAddress(actualAddress)) !== JSON.stringify(exactAddress(expectedAddress))) failure();
      current.children = current.children.filter(node => node !== added[0]);
      frozen.children = frozen.children.filter(node => node !== existing[0]);
    }
    // User instruction 06.10.2026: accept coordinates added by Saby only while the address stays unchanged.
    // Remove them from the comparison copy only; comparison of every remaining address field still follows.
    if (!existing.length && added.length === 1) {
      if (validCoordinates(added[0])) current.children = current.children.filter(node => node !== added[0]);
    }
    // User instruction 14.10.2026: a missing Saby point is acceptable only with the exact full address.
    // Change the comparison copy, never the frozen CRM point, prepared bytes or signing hashes.
    if (!added.length && existing.length === 1 && validCoordinates(existing[0])) {
      const actualAddress = fullAddress(current); const expectedAddress = fullAddress(frozen);
      if (actualAddress && expectedAddress && JSON.stringify(exactAddress(actualAddress)) === JSON.stringify(exactAddress(expectedAddress))) frozen.children = frozen.children.filter(node => node !== existing[0]);
    }
  }
  const actual = nodes(current); const expected = nodes(frozen);
  if (actual.length !== expected.length) return;
  actual.forEach((node, index) => permitCoordinatePresenceChanges(node, expected[index], here, policy));
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
export function verifySabySenderBusiness(currentBytes: Uint8Array, frozenBytes: Uint8Array, policy?: SabySenderVerificationPolicy): SabySenderTitleIdentity {
  const current = parseXml(currentBytes); const frozen = parseXml(frozenBytes);
  const currentIdentity = identity(current); identity(frozen);
  if (policy === 'address-multidelivery-v1') permitOmittedDeliveryInformation(current, frozen);
  else permitOmittedSingleDeliveryInformation(current, frozen);
  permitInertUnloadingUtcFlag(current, frozen);
  permitCoordinatePresenceChanges(current, frozen, '', policy);
  if (JSON.stringify(canonical(current)) !== JSON.stringify(canonical(frozen))) {
    if (JSON.stringify(canonical(current, '', true)) === JSON.stringify(canonical(frozen, '', true))) {
      throw new SabyError('validation', SABY_SENDER_COORDINATE_MISMATCH);
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

/** Explicit repair only: prove the entire original digest after removing newly added identifiers.
 * Existing identifiers, authority, payment, source linkage and transport facts cannot be replaced. */
export function correctSabyCarrierVehicleAddition(currentBytes: Uint8Array, beforeHash: string, expected: SabyCarrierVehicleIdentity): Uint8Array {
  const root = parseXml(currentBytes); const vehicle = onlyCarrierVehicle(root);
  if (!vehicle || vehicle.attributes.РегНомер !== expected.plate || !/^[A-Z0-9]{17}$/.test(expected.vin ?? '') || !/^\d{10}$/.test(expected.stsNumber ?? '')) carrierChanged();
  const keys = (['НомерВИН', 'НомСТС'] as const).filter(key => Object.hasOwn(vehicle.attributes, key));
  for (let mask = 1; mask < 1 << keys.length; mask++) {
    const candidate = structuredClone(root); const copy = onlyCarrierVehicle(candidate)!;
    const added = keys.filter((_, i) => mask & 1 << i);
    for (const key of added) delete copy.attributes[key];
    if (carrierRootHash(candidate) !== beforeHash) continue;
    for (const key of added) copy.attributes[key] = key === 'НомерВИН' ? expected.vin! : expected.stsNumber!;
    const escape = (value: string) => value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
    const xml = (node: XmlNode): string => `<${node.name}${Object.entries(node.attributes).map(([k,v]) => ` ${k}="${escape(v)}"`).join('')}>${node.children.map(c => typeof c === 'string' ? escape(c) : xml(c)).join('')}</${node.name}>`;
    return Buffer.from('<?xml version="1.0" encoding="utf-8"?>' + xml(candidate), 'utf8');
  }
  return carrierChanged();
}

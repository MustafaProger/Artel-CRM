import { createHash } from 'node:crypto';
import Decimal from 'decimal.js';
import { formatSabyVolume } from './saby-volume';
import { SabyError, sabyObject, type SabyObject } from './saby-client';
import { serializeXml } from './saby-carrier-details';
import { serializeSabyConsignmentNote, type SabyConsignmentSnapshot } from './saby-consignment-note';
import { parseXml, type XmlNode } from './saby-order-evidence';
import { encodeWindows1251 } from './saby-transport-order';

export interface ConsignmentDraftRequestedFields {
  recipientInn: string; recipientKpp: string; deliveryAddress: string;
  arrivedAt: string; departedAt: string; grossMassKg: string; packageCount: string;
}
export interface ConsignmentDraftFill {
  bytes: Uint8Array; changed: boolean; beforeHash: string; afterHash: string;
  fields: ConsignmentDraftRequestedFields;
}

const fail = (detail?: string): never => { throw new SabyError('validation', 'Связанный черновик ЭТрН не подтверждает сохранённые сведения доставки.' + (detail ? ` ${detail}.` : '') + ' Дозаполнение остановлено; требуется сверка.'); };
const elements = (node: XmlNode) => node.children.filter((child): child is XmlNode => typeof child !== 'string');
const named = (node: XmlNode, name: string) => elements(node).filter(child => child.name === name);
const only = (node: XmlNode, name: string): XmlNode => { const found = named(node, name); if (found.length !== 1) fail(`XML ${node.name}/${name}: ожидался один элемент, получено ${found.length}`); return found[0]; };
const normalized = (value: string | undefined) => (value ?? '').replace(/\s+/g, ' ').trim();
const digest = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const decimal = (value: string | undefined) => /^-?\d{1,18}(?:\.\d{1,9})?$/.test(normalized(value));
const equivalentNumber = (left: string | undefined, right: string | undefined) => decimal(left) && decimal(right) && new Decimal(normalized(left)).eq(normalized(right));
const equal = (left: string | undefined, right: string | undefined) => { if (!normalized(right) || normalized(left) !== normalized(right)) fail(); };
const equalNumber = (left: string | undefined, right: string | undefined) => { if (!equivalentNumber(left, right)) fail(); };
// The native draft inherits the order's two-decimal volume. Reconstruct that
// value from the versioned frozen litres; the note itself always needs its three-decimal value.
// Unversioned historical snapshots retain their original exact-only conversion.
const nativeRoundedVolume = (actual: string | undefined, expected: string | undefined, orderVolume?: string | null) =>
  !!orderVolume && equivalentNumber(actual, orderVolume) && !equivalentNumber(expected, orderVolume);
const compact = (value: string | undefined) => normalized(value).replace(/\s/g, '').toUpperCase();

function title(bytes: Uint8Array) {
  const root = parseXml(bytes);
  if (root.name !== 'Файл' || root.attributes.ВерсФорм !== '5.01' || !normalized(root.attributes.ИдФайл) || elements(root).length !== 1) fail();
  const document = only(root, 'Документ');
  if (document.attributes.КНД !== '1110339' || named(document, 'Подписант').length > 1) fail();
  const content = only(document, 'СодИнфГО');
  const cargo = only(only(content, 'СвГруз'), 'ОпГруз');
  const loading = only(content, 'СвПогруз');
  const recipients = named(content, 'СвГП');
  if (recipients.length > 1) fail();
  return { root, document, content, cargo, loading, recipient: recipients[0] };
}

function identity(party: XmlNode): { inn: string; kpp: string; name: string } {
  const id = only(party, 'ИдСв');
  if (elements(id).length !== 1) fail();
  const entity = elements(id)[0];
  if (entity.name === 'СвЮЛУч' && /^\d{10}$/.test(entity.attributes.ИННЮЛ ?? '') && /^\d{9}$/.test(entity.attributes.КПП ?? '')) return { inn: entity.attributes.ИННЮЛ, kpp: entity.attributes.КПП, name: entity.attributes.НаимОрг ?? '' };
  if (entity.name === 'СвИП' && /^\d{12}$/.test(entity.attributes.ИННФЛ ?? '')) {
    const person = only(entity, 'ФИО');
    return { inn: entity.attributes.ИННФЛ, kpp: '', name: [person.attributes.Фамилия, person.attributes.Имя, person.attributes.Отчество].filter(Boolean).join(' ') };
  }
  return fail();
}
function sameParty(actual: XmlNode, expected: XmlNode) {
  const left = identity(actual), right = identity(expected);
  if (left.inn !== right.inn || left.kpp !== right.kpp) fail();
}
function address(actual: XmlNode, expected: XmlNode, allowMissingCoordinates = false) {
  // The supported native draft has the same literal physical address as the frozen delivery.
  // Structured legal addresses in participant requisites are deliberately left untouched.
  const left = only(actual, 'АдресИнф'), right = only(expected, 'АдресИнф');
  equal(left.attributes.КодСтр, right.attributes.КодСтр);
  equal(left.attributes.АдрТекст, right.attributes.АдрТекст);
  if (named(actual, 'Коорд').length > 1 || named(expected, 'Коорд').length > 1) fail();
  const knownCoordinates = named(expected, 'Коорд')[0];
  if (knownCoordinates && (!allowMissingCoordinates || named(actual, 'Коорд').length)) {
    const actualCoordinates = only(actual, 'Коорд');
    equalNumber(actualCoordinates.attributes.Широта, knownCoordinates.attributes.Широта);
    equalNumber(actualCoordinates.attributes.Долгота, knownCoordinates.attributes.Долгота);
  }
}
function expectedTitle(snapshot: SabyConsignmentSnapshot, number: string) {
  // This supplies target values and anchors only. Its other business fields never replace the native title.
  return title(serializeSabyConsignmentNote(snapshot, '00000000-0000-4000-8000-000000000001', '2025-01-01T00:00:00.000Z', number).xml);
}
function recipient(actual: XmlNode, expected: XmlNode) {
  sameParty(only(actual, 'РекИдентГП'), only(expected, 'РекИдентГП'));
  address(only(actual, 'АдресДостГр'), only(expected, 'АдресДостГр'));
}
function emptyNativeRecipient(value: XmlNode): boolean {
  // Observed Saby shell only: empty identity/contact and an empty delivery address.
  // A partial recipient, unknown child or even one populated attribute is never replaced.
  const shape = (node: XmlNode): unknown => {
    if (Object.keys(node.attributes).length || node.children.some(child => typeof child === 'string' && !!child.trim())) return null;
    return [node.name, elements(node).map(shape)];
  };
  return JSON.stringify(shape(value)) === JSON.stringify(['СвГП', [['РекИдентГП', [['ИдСв', []], ['Контакт', []]]], ['АдресДостГр', []]]]);
}
function anchors(actual: ReturnType<typeof title>, expected: ReturnType<typeof title>, allowMissingLoadingCoordinates = false, nativeOrderVolume?: string | null) {
  for (const key of ['НомерТрН', 'ДатаТрН', 'НомЗак', 'ДатаЗак']) equal(actual.content.attributes[key], expected.content.attributes[key]);
  sameParty(only(only(actual.content, 'СвГО'), 'РекИдентГО'), only(only(expected.content, 'СвГО'), 'РекИдентГО'));
  sameParty(only(actual.content, 'СвПер'), only(expected.content, 'СвПер'));
  equal(actual.cargo.attributes.НаимГруз, expected.cargo.attributes.НаимГруз);
  equalNumber(actual.cargo.attributes.КолМестГр, expected.cargo.attributes.КолМестГр);
  if (!allowMissingLoadingCoordinates || !nativeRoundedVolume(actual.cargo.attributes.Объем, expected.cargo.attributes.Объем, nativeOrderVolume)) equalNumber(actual.cargo.attributes.Объем, expected.cargo.attributes.Объем);
  const actualMass = only(actual.cargo, 'ПлМасГруз'), expectedMass = only(expected.cargo, 'ПлМасГруз');
  equalNumber(actualMass.attributes.МасБрутЗнач, expectedMass.attributes.МасБрутЗнач);
  if (actualMass.attributes.МасНетЗнач || expectedMass.attributes.МасНетЗнач) equalNumber(actualMass.attributes.МасНетЗнач, expectedMass.attributes.МасНетЗнач);
  const actualDriver = only(actual.content, 'СвВодит'), expectedDriver = only(expected.content, 'СвВодит');
  for (const key of ['ИННФЛ', 'СерВУ', 'НомВУ', 'ДатаВыдВУ']) {
    if (expectedDriver.attributes[key] && compact(actualDriver.attributes[key]) !== compact(expectedDriver.attributes[key])) fail();
  }
  const actualVehicle = only(only(actual.content, 'СвТС'), 'ТС'), expectedVehicle = only(only(expected.content, 'СвТС'), 'ТС');
  for (const key of ['РегНомер', 'НомерВИН']) if (expectedVehicle.attributes[key] && compact(actualVehicle.attributes[key]) !== compact(expectedVehicle.attributes[key])) fail();
  address(only(actual.loading, 'ФАдресПогр'), only(expected.loading, 'ФАдресПогр'), allowMissingLoadingCoordinates);
  if (actual.recipient && !emptyNativeRecipient(actual.recipient)) recipient(actual.recipient, expected.recipient);
}

const requestedLoading = ['ФДатВрПриб', 'НалКоорТочВрФПогр', 'ФДатВрУбыт', 'НалКоорТочВрФУбыт', 'МасБрутОтгр', 'КолМестПрием'] as const;
function requestedFields(expected: ReturnType<typeof title>): ConsignmentDraftRequestedFields {
  const party = identity(only(expected.recipient, 'РекИдентГП'));
  return { recipientInn: party.inn, recipientKpp: party.kpp,
    deliveryAddress: only(only(expected.recipient, 'АдресДостГр'), 'АдресИнф').attributes.АдрТекст,
    arrivedAt: expected.loading.attributes.ФДатВрПриб, departedAt: expected.loading.attributes.ФДатВрУбыт,
    grossMassKg: expected.loading.attributes.МасБрутОтгр, packageCount: expected.loading.attributes.КолМестПрием };
}
function targets(actual: ReturnType<typeof title>, expected: ReturnType<typeof title>) {
  if (!actual.recipient) fail();
  recipient(actual.recipient, expected.recipient);
  for (const key of requestedLoading) {
    if (key === 'МасБрутОтгр' || key === 'КолМестПрием') equalNumber(actual.loading.attributes[key], expected.loading.attributes[key]);
    else equal(actual.loading.attributes[key], expected.loading.attributes[key]);
  }
}

/** Verify only the requested fields and frozen anchors, never the remainder or signing authority. */
export function verifyDraftRequestedFields(bytes: Uint8Array, snapshot: SabyConsignmentSnapshot, number: string): void {
  const actual = title(bytes), expected = expectedTitle(snapshot, number);
  anchors(actual, expected); targets(actual, expected);
}

/** Fill a separately proven unsigned native draft. The caller must freeze identity/revision/signatures first.
 * Only the missing recipient, driver loading events/count/gross mass and proven rounded volume may change; native business stays native.
 */
export function fillConsignmentDraft(bytes: Uint8Array, snapshot: SabyConsignmentSnapshot, number: string): ConsignmentDraftFill {
  const actual = title(bytes), expected = expectedTitle(snapshot, number);
  anchors(actual, expected, true, formatSabyVolume(snapshot.fields.quantity_litres, 'litres', 2, snapshot.volumeRoundingVersion));
  const before = JSON.stringify(canonical(actual.root));
  if (!equivalentNumber(actual.cargo.attributes.Объем, expected.cargo.attributes.Объем)) actual.cargo.attributes.Объем = expected.cargo.attributes.Объем;
  // Saby's unsigned native draft can omit coordinates while keeping the exact address.
  // Only fill absence from frozen CRM facts; conflicting coordinates still fail above.
  const location = only(actual.loading, 'ФАдресПогр');
  const coordinates = named(only(expected.loading, 'ФАдресПогр'), 'Коорд')[0];
  if (coordinates && !named(location, 'Коорд').length) location.children.unshift(structuredClone(coordinates));
  if (!actual.recipient) {
    const cargoIndex = actual.content.children.indexOf(only(actual.content, 'СвГруз'));
    actual.content.children.splice(cargoIndex, 0, structuredClone(expected.recipient));
  } else if (emptyNativeRecipient(actual.recipient)) {
    const recipientIndex = actual.content.children.indexOf(actual.recipient);
    actual.content.children.splice(recipientIndex, 1, structuredClone(expected.recipient));
  }
  // The user explicitly selected driver facts as the source for both actual event times.
  // Previously filled conflicting count or mass is not assumed to be an empty native draft.
  for (const key of requestedLoading) {
    const target = expected.loading.attributes[key];
    if (!target) fail();
    if ((key === 'МасБрутОтгр' || key === 'КолМестПрием') && normalized(actual.loading.attributes[key]) && !equivalentNumber(actual.loading.attributes[key], target)) fail();
    actual.loading.attributes[key] = target;
  }
  const changed = before !== JSON.stringify(canonical(actual.root));
  const filled = changed ? encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(actual.root)) : bytes;
  verifyDraftRequestedFields(filled, snapshot, number);
  return { bytes: filled, changed, beforeHash: digest(bytes), afterHash: digest(filled), fields: requestedFields(expected) };
}

const numericFields: Record<string, string[]> = {
  ОпГруз: ['Объем', 'КолМестГр'], ПлМасГруз: ['МасНетЗнач', 'МасБрутЗнач'], СвПогруз: ['МасБрутОтгр', 'КолМестПрием'],
  ПарТС: ['Грузопод', 'Вместим'], Габар: ['ВысЗнач', 'ДлЗнач', 'ШирЗнач'],
};
function canonical(node: XmlNode, path = '', allowServiceHeaders = false): unknown {
  const here = `${path}/${node.name}`;
  const service: Record<string, string[]> = { '/Файл': ['ИдФайл', 'ВерсПрог'], '/Файл/Документ': ['ДатИнфГО', 'ВрИнфГО', 'НаимЭкСубСост'] };
  const attributes = Object.entries(node.attributes).filter(([key]) => !allowServiceHeaders || !service[here]?.includes(key)).sort(([a], [b]) => a.localeCompare(b)).map(([key, value]) => [key, numericFields[node.name]?.includes(key) && decimal(value) ? new Decimal(normalized(value)).toFixed() : normalized(value)]);
  const children: unknown[] = []; let text = '';
  const flush = () => { if (normalized(text)) children.push(normalized(text)); text = ''; };
  for (const child of node.children) {
    if (typeof child === 'string') text += child;
    else { flush(); children.push(canonical(child, here, allowServiceHeaders)); }
  }
  flush(); return [node.name, attributes, children];
}

/** Read-back against the exact filled native title, including signer, UID and every unrelated business field.
 * Formatting and generated file/timestamp headers may differ; no business subtree may be lost or introduced.
 * This is not the stricter comparison to the CRM-generated title required before automatic signing.
 */
export function verifyConsignmentDraftUpdate(currentBytes: Uint8Array, expectedFilledBytes: Uint8Array): void {
  const current = title(currentBytes), expected = title(expectedFilledBytes);
  if (JSON.stringify(canonical(current.root, '', true)) !== JSON.stringify(canonical(expected.root, '', true))) fail();
}

function references(value: unknown): SabyObject[] | null {
  if (!Array.isArray(value) || value.some(link => !sabyObject(link) || !sabyObject(link.Документ) || typeof link.Документ.Идентификатор !== 'string' || !link.Документ.Идентификатор.trim() || typeof link.Документ.Тип !== 'string' || !link.Документ.Тип.trim())) return null;
  return value.map(link => (link as SabyObject).Документ as SabyObject);
}
function exactReference(reference: SabyObject, document: SabyObject): boolean {
  return reference.Идентификатор === document.Идентификатор && reference.Тип === document.Тип &&
    (!reference.Номер || reference.Номер === document.Номер) && (!reference.Дата || reference.Дата === document.Дата);
}
/** Read-only reciprocal identity proof; it never discovers by number or writes a new relation. */
export function hasExactConsignmentOrderLink(note: SabyObject, order: SabyObject): boolean {
  if (note.Тип !== 'ConsignmentNote' || order.Тип !== 'TransportOrder' || typeof note.Идентификатор !== 'string' || !note.Идентификатор.trim() || typeof order.Идентификатор !== 'string' || !order.Идентификатор.trim() || [note, order].some(doc => doc.Удален === 'Да' || doc.ЧастичныеДанные === 'Да')) return false;
  const bases = references(note.ДокументОснование), consequences = references(order.ДокументСледствие);
  if (!bases || !consequences) return false;
  const sourceOrders = bases.filter(doc => doc.Тип === 'TransportOrder');
  const targetNotes = consequences.filter(doc => doc.Идентификатор === note.Идентификатор);
  return sourceOrders.length === 1 && exactReference(sourceOrders[0], order) && targetNotes.length === 1 && exactReference(targetNotes[0], note);
}

/** Prove the whole operator-created order draft before allocating its first delivery.
 * Positional matching is against the immutable order delivery list, never a search by mass alone.
 * The original bytes remain in LinkedDraftState; the replacement uses frozen CRM business data.
 */
export function allocateNativeConsignmentDraft(bytes: Uint8Array, snapshots: SabyConsignmentSnapshot[], number: string): ConsignmentDraftFill {
  if (!snapshots.length || new Set(snapshots.map(x => x.shipmentId)).size !== snapshots.length) fail('Состав доставок заявки неоднозначен');
  const root = parseXml(bytes), document = only(root, 'Документ'), content = only(document, 'СодИнфГО');
  const cargo = only(content, 'СвГруз'), items = named(cargo, 'ОпГруз');
  if (elements(cargo).length !== snapshots.length || items.length !== snapshots.length) fail('Число грузов нативной ЭТрН не совпадает с заявкой');
  const recipients = named(content, 'СвГП');
  if (recipients.length > 1 || recipients.length === 1 && !emptyNativeRecipient(recipients[0])) fail('Получатель общего черновика уже заполнен');
  for (let index = 0; index < snapshots.length; index++) {
    const snapshot = snapshots[index];
    if (snapshot.tripId !== snapshots[0].tripId || snapshot.profile.order.number !== snapshots[0].profile.order.number || snapshot.profile.order.date !== snapshots[0].profile.order.date) fail('Доставки относятся к разным заявкам');
    const copy = structuredClone(root), info = only(only(copy, 'Документ'), 'СодИнфГО');
    only(info, 'СвГруз').children = [structuredClone(items[index])];
    const actual = title(encodeWindows1251(serializeXml(copy)));
    anchors(actual, expectedTitle(snapshot, number), true, formatSabyVolume(snapshot.fields.quantity_litres, 'litres', 2, snapshot.volumeRoundingVersion));
  }
  const snapshot = snapshots[0];
  const generated = serializeSabyConsignmentNote(snapshot, '00000000-0000-4000-8000-000000000001', '2025-01-01T00:00:00.000Z', number, { senderTitleVersion: 2 });
  const filled = parseXml(generated.xml);
  filled.attributes.ИдФайл = root.attributes.ИдФайл;
  const resultDocument = only(filled, 'Документ');
  for (const key of ['ДатИнфГО', 'ВрИнфГО']) resultDocument.attributes[key] = document.attributes[key];
  const result = encodeWindows1251('<?xml version="1.0" encoding="windows-1251"?>' + serializeXml(filled));
  verifyDraftRequestedFields(result, snapshot, number);
  return { bytes: result, changed: true, beforeHash: digest(bytes), afterHash: digest(result), fields: requestedFields(expectedTitle(snapshot, number)) };
}

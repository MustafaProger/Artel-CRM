import { decodeSabySignatureBase64, SabyError } from './saby-client';
import { parseXml, type XmlNode } from './saby-order-evidence';

const reject = (): never => { throw new SabyError('validation', 'Подписанная приёмка клиента не подтверждает эту ЭТрН и исходный титул перевозчика. Требуется сверка.'); };
const children = (node: XmlNode): XmlNode[] => node.children.filter((child): child is XmlNode => typeof child !== 'string');
const only = (node: XmlNode, name: string): XmlNode => { const found = children(node).filter(child => child.name === name); if (found.length !== 1) reject(); return found[0]; };
/** FNS 5.01 T3: positive acceptance, exact consignment UID, exact signed T2 file identity. */
export function verifyNkRecipientAcceptance(recipientBytes: Uint8Array, carrierBytes: Uint8Array, carrierSignature: Uint8Array): void {
  const recipient = parseXml(recipientBytes), carrier = parseXml(carrierBytes);
  const receiptDoc = only(recipient, 'Документ'), carrierDoc = only(carrier, 'Документ');
  if (recipient.name !== 'Файл' || carrier.name !== 'Файл' || recipient.attributes.ВерсФорм !== '5.01' || carrier.attributes.ВерсФорм !== '5.01' || receiptDoc.attributes.КНД !== '1110341' || carrierDoc.attributes.КНД !== '1110340' || !recipient.attributes.ИдФайл || !carrier.attributes.ИдФайл) reject();
  only(receiptDoc, 'Подписант');
  const receipt = only(receiptDoc, 'СодИнфГП'), origin = only(carrierDoc, 'СодИнфПрвПрием'), link = only(receiptDoc, 'ИдИнфПрвПрием');
  if (!receipt.attributes.СодОпПр?.trim() || receipt.attributes.СодОпПр.length > 255 || Object.hasOwn(receipt.attributes, 'СодОпОтк') || Object.hasOwn(receipt.attributes, 'ПричОтк') || !origin.attributes.УИД_ТрН?.trim() || receipt.attributes.УИД_ТрН !== origin.attributes.УИД_ТрН) reject();
  only(receipt, 'ПриемГрузГП');
  if (link.attributes.ИдФайлИнфПрвПрием !== carrier.attributes.ИдФайл || link.attributes.ДатФайлПрвПрием !== carrierDoc.attributes.ДатИнфПрвПрием || link.attributes.ВрФайлПрвПрием !== carrierDoc.attributes.ВрИнфПрвПрием || !link.attributes.ДатФайлПрвПрием || !link.attributes.ВрФайлПрвПрием || Object.keys(link.attributes).some(key => !['ИдФайлИнфПрвПрием', 'ДатФайлПрвПрием', 'ВрФайлПрвПрием', 'ЭП'].includes(key)) || children(link).length || link.children.some(child => typeof child === 'string' && child.trim())) reject();
  if (!carrierSignature.length || !Buffer.from(decodeSabySignatureBase64(link.attributes.ЭП)).equals(Buffer.from(carrierSignature))) reject();
}

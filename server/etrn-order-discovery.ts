import { SabyClient, SabyError, sabyObject, type SabyObject, type SabyOrganization } from './saby-client';
import type { SabyConsignmentSnapshot } from './saby-consignment-note';

export interface ConsignmentSourceOrder { id: string; number: string; date: string }
const PAGE_SIZE = 200;
const MAX_PAGES = 20;
const fail = (message: string): never => { throw new SabyError('unknown', message, true); };
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 1024 && value.trim() === value && ![...value].some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127);
function isoDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || !Number.isFinite(Date.parse(`${value}T00:00:00Z`)) || new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) !== value) return fail('Не подтверждён период поиска ЭТрН заявки.');
  return value;
}
const ruDay = (value: string) => value.split('-').reverse().join('.');
function remoteDay(value: unknown): string {
  if (typeof value !== 'string' || !/^\d{2}\.\d{2}\.\d{4}$/.test(value)) return fail('Saby вернул ЭТрН без подтверждённой даты. Создание остановлено.');
  return isoDay(value.split('.').reverse().join('-'));
}
function moscowDay(): string {
  const parts = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date());
  return ['year', 'month', 'day'].map(type => parts.find(part => part.type === type)!.value).join('-');
}
function partyIdentity(value: unknown): { inn: string; kpp: string } {
  const legal = sabyObject(value) && sabyObject(value.СвЮЛ) ? value.СвЮЛ : null;
  const person = sabyObject(value) && sabyObject(value.СвФЛ) ? value.СвФЛ : null;
  if (legal && person) return fail('Неоднозначные стороны ЭТрН при поиске связанных документов.');
  if (legal && /^\d{10}$/.test(String(legal.ИНН)) && /^\d{9}$/.test(String(legal.КПП))) return { inn: String(legal.ИНН), kpp: String(legal.КПП) };
  if (person && /^\d{12}$/.test(String(person.ИНН))) return { inn: String(person.ИНН), kpp: '' };
  return fail('Не подтверждены стороны ЭТрН при поиске связанных документов.');
}
const matches = (identity: { inn: string; kpp: string }, expected: SabyOrganization) => identity.inn === expected.inn && (identity.inn.length === 12 || identity.kpp === expected.kpp);
function roleMatches(remote: SabyObject, role: 'sender' | 'carrier', expected: SabyOrganization): boolean {
  const parties = sabyObject(remote.Стороны) ? remote.Стороны : {};
  const values = (role === 'sender' ? [remote.Грузоотправитель, parties.Отправитель] : [remote.ТранспортнаяКомпания, remote.Перевозчик, parties.Перевозчик]).filter(value => value !== undefined && value !== null);
  if (!values.length) return fail('Не подтверждены стороны ЭТрН при поиске связанных документов.');
  const identities = values.map(partyIdentity);
  if (identities.some(identity => identity.inn !== identities[0].inn || identity.kpp !== identities[0].kpp)) return fail('Стороны ЭТрН противоречат друг другу. Новое создание остановлено.');
  return matches(identities[0], expected);
}
function baseDocuments(remote: SabyObject): SabyObject[] {
  if (remote.ДокументОснование === undefined || remote.ДокументОснование === null) return [];
  if (!Array.isArray(remote.ДокументОснование)) return fail('Saby вернул неполные связи ЭТрН. Создание остановлено.');
  return remote.ДокументОснование.map(value => {
    if (!sabyObject(value) || !sabyObject(value.Документ) || !text(value.Документ.Идентификатор) || !text(value.Документ.Тип)) return fail('Saby вернул неполные связи ЭТрН. Создание остановлено.');
    return value.Документ;
  });
}

/** Read-only absence check before a first order-linked write. A marker search
 * alone cannot discover Saby-native documents, whose marker may be empty.
 * No documented relation filter exists: enumerate the complete dated register
 * and read each document. Ambiguous orphan notes block, never become permission
 * to create another note. The caller still validates the current signed order,
 * exact candidate contents and reciprocal links before adopting or writing. */
export async function discoverOrderConsignments(client: SabyClient, order: ConsignmentSourceOrder, snapshot: SabyConsignmentSnapshot, marker: string): Promise<SabyObject[]> {
  if (!text(order.id) || !text(order.number) || !text(marker)) return fail('Не подтверждена исходная заявка для поиска ЭТрН.');
  const sender = snapshot.customerOrganization;
  if (!/^\d{10}$/.test(sender.inn) || !/^\d{9}$/.test(sender.kpp) || !matches(client.config.customer, sender)) return fail('Кабинет поиска ЭТрН не соответствует отправителю сохранённой доставки.');
  const documentDays = [isoDay(order.date), isoDay(snapshot.fields.date)].sort();
  const firstDay = documentDays[0], lastDay = [...documentDays, moscowDay()].sort().at(-1)!;
  const ids: string[] = [], seen = new Set<string>();
  let complete = false;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await client.call('СБИС.СписокДокументов', { Фильтр: {
      Тип: 'ConsignmentNote', Направление: 'Исходящий', ДатаС: ruDay(firstDay), ДатаПо: ruDay(lastDay),
      НашаОрганизация: { СвЮЛ: { ИНН: snapshot.customerOrganization.inn, КПП: snapshot.customerOrganization.kpp } },
      Навигация: { РазмерСтраницы: String(PAGE_SIZE), Страница: String(page) },
    } }, false, true);
    if (!sabyObject(result) || result.ЧастичныеДанные === 'Да' || !Array.isArray(result.Документ) || result.Документ.length > PAGE_SIZE || !sabyObject(result.Навигация) || !['Да', 'Нет'].includes(String(result.Навигация.ЕстьЕще)) ||
        result.Навигация.Страница !== undefined && String(result.Навигация.Страница) !== String(page) ||
        result.Навигация.РазмерСтраницы !== undefined && (!/^\d+$/.test(String(result.Навигация.РазмерСтраницы)) || Number(result.Навигация.РазмерСтраницы) < 1 || Number(result.Навигация.РазмерСтраницы) > PAGE_SIZE)) return fail('Saby не подтвердил полный список ЭТрН. Новое создание запрещено.');
    for (const value of result.Документ) {
      if (!sabyObject(value) || !text(value.Идентификатор) || value.Тип !== 'ConsignmentNote' || value.ЧастичныеДанные === 'Да' || seen.has(value.Идентификатор)) return fail('Список ЭТрН изменился или неполон. Новое создание запрещено.');
      seen.add(value.Идентификатор); ids.push(value.Идентификатор);
    }
    if (result.Навигация.ЕстьЕще === 'Нет') { complete = true; break; }
    if (!result.Документ.length) return fail('Saby вернул пустую промежуточную страницу ЭТрН. Создание остановлено.');
  }
  if (!complete) return fail('Список ЭТрН превышает предел безопасной сверки. Новое создание запрещено.');
  const candidates: SabyObject[] = [];
  for (const id of ids) {
    const remote = await client.readConsignmentNote(id);
    if (remote.Идентификатор !== id || remote.Тип !== 'ConsignmentNote' || remote.ЧастичныеДанные === 'Да' || remote.Удален === 'Да' || remote.Направление !== undefined && remote.Направление !== 'Исходящий') return fail('ЭТрН изменилась во время поиска. Новое создание запрещено.');
    const date = remoteDay(remote.Дата);
    if (date < firstDay || date > lastDay || !matches(partyIdentity(remote.НашаОрганизация), snapshot.customerOrganization)) return fail('Saby вернул ЭТрН вне подтверждённой области поиска.');
    const bases = baseDocuments(remote);
    if (remote.Примечание === marker || bases.some(base => base.Идентификатор === order.id)) { candidates.push(remote); continue; }
    // A foreign order link unambiguously excludes this document. Other kinds of
    // bases do not establish that a plausible native note belongs to another trip.
    if (bases.some(base => base.Тип === 'TransportOrder')) continue;
    if (roleMatches(remote, 'sender', snapshot.customerOrganization) && roleMatches(remote, 'carrier', snapshot.carrierOrganization)) return fail('Найдена ЭТрН тех же сторон без подтверждённой связи с заявкой. Требуется сверка; новый документ не создаётся.');
  }
  return candidates;
}

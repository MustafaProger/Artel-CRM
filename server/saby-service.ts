import Decimal from 'decimal.js';
import { createHash, randomUUID } from 'node:crypto';
import type { ShipmentTrip, Snapshot } from '../web/src/model';
import type { SabyDocumentSummary, SabyTripResponse } from '../web/src/saby-model';
import { ApiError } from './api-error';
import type { OperationsData, OperationsStorage } from './operations-store';
import { currentSnapshot } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import { SabyClient, SabyError, sabyConfigFromEnv, sabyConfigurationBlockers, sabyCredentialBlockers, sabyObject, sabyText, type SabyConfig, type SabyObject } from './saby-client';
import { buildSabyTransportDocument, sabyTransportBlockers, type SabyTransportSnapshot } from './saby-transport-order';
import { hasEtrnDocuments } from './etrn-service';

export interface SabyDocumentRecord extends SabyDocumentSummary {
  marker: string;
  payloadHash: string;
  snapshot: SabyTransportSnapshot;
  createdAt: string;
  attemptId: string;
}
export interface SabyTripRecord { documents: SabyDocumentRecord[]; leaseId: string | null; leaseUntil: string | null; updatedAt: string }
export interface SabyData { trips: Record<string, SabyTripRecord> }
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const now = () => new Date().toISOString();
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
const nullableString = (value: unknown) => value === null || typeof value === 'string';
const statusValues = ['pending', 'unknown', 'draft', 'error'];
export function validateSabyData(value: unknown): asserts value is SabyData | undefined {
  if (value === undefined) return;
  if (!sabyObject(value) || !sabyObject(value.trips)) throw new Error('Invalid Saby data');
  for (const [tripId, record] of Object.entries(value.trips)) {
    if (!tripId || !sabyObject(record) || !Array.isArray(record.documents) || !record.documents.length || record.documents.length > 100 || !date(record.updatedAt) || !nullableString(record.leaseId) || !(record.leaseUntil === null || date(record.leaseUntil))) throw new Error('Invalid Saby trip');
    const ids = new Set<string>();
    for (const doc of record.documents) {
      if (!sabyObject(doc) || typeof doc.shipmentId !== 'string' || !doc.shipmentId || ids.has(doc.shipmentId) || !statusValues.includes(String(doc.status)) || !nullableString(doc.id) || !nullableString(doc.revision) || !nullableString(doc.url) || !nullableString(doc.lastError) || !nullableString(doc.remoteStatus) || !date(doc.updatedAt) || !date(doc.createdAt) || typeof doc.attemptId !== 'string' || !doc.attemptId || typeof doc.marker !== 'string' || !doc.marker.startsWith('ARTEL-CRM:') || typeof doc.payloadHash !== 'string' || !/^[a-f0-9]{64}$/.test(doc.payloadHash) || !sabyObject(doc.snapshot) || doc.snapshot.tripId !== tripId || doc.snapshot.shipmentId !== doc.shipmentId || doc.payloadHash !== hash(doc.snapshot)) throw new Error('Invalid Saby document');
      if (doc.status === 'draft' && !doc.id) throw new Error('Missing Saby document ID');
      ids.add(doc.shipmentId);
    }
  }
}
export function hasSabyDocuments(data: OperationsData, tripId: string): boolean { return hasEtrnDocuments(data, tripId) || !!data.saby?.trips[tripId]?.documents.some(doc => doc.status !== 'error' || !!doc.id); }

function snapshots(snapshot: Snapshot, trip: ShipmentTrip, config: SabyConfig): SabyTransportSnapshot[] {
  return trip.customers.map(customer => {
    const company = snapshot.companies.find(company => company.id === customer.fields.customer_id);
    const supplier = snapshot.companies.find(company => company.id === trip.fields.supplier_id);
    const driver = snapshot.directories?.drivers.find(driver => driver.id === trip.fields.driver_id);
    const vehicle = snapshot.directories?.vehicles.find(vehicle => vehicle.id === trip.fields.vehicle_id);
    const row = snapshot.shipments.find(row => row.id === customer.id);
    return {
      tripId: trip.id, shipmentId: customer.id, version: customer.version,
      fields: { ...trip.fields, ...customer.fields, quantity_tonnes: row?.fields.quantity_tonnes ?? null },
      customer: { name: company?.fullName || company?.name || '', inn: company?.inn || '', kpp: company?.kpp || '', address: company?.address || '' },
      supplier: { name: supplier?.fullName || supplier?.name || '', inn: supplier?.inn || '', kpp: supplier?.kpp || '', address: supplier?.address || '' },
      driver: { name: driver?.fullName || driver?.name || '', phone: driver?.phone || '' },
      vehicle: { plate: vehicle?.plate || '', type: vehicle?.vehicleType || '' },
      customerOrganization: { ...config.customer }, carrierOrganization: { ...config.carrier },
      profile: config.transportProfile ?? null,
    };
  });
}
function blockers(snapshot: Snapshot, trip: ShipmentTrip, config: SabyConfig): string[] {
  const errors = [...sabyConfigurationBlockers(config), ...snapshots(snapshot, trip, config).flatMap(sabyTransportBlockers)];
  const vehicle = config.transportProfile?.vehicleById?.[trip.fields.vehicle_id ?? ''];
  if (vehicle && /^\d+(?:\.\d+)?$/.test(vehicle.capacityCubicMetres) && /^\d+(?:\.\d+)?$/.test(vehicle.payloadTonnes)) {
    const litres = trip.customers.reduce((sum, row) => sum.plus(row.fields.quantity_litres || '0'), new Decimal(0));
    if (litres.div(1000).gt(vehicle.capacityCubicMetres)) errors.push('Суммарный объём всех доставок рейса превышает подтверждённую вместимость машины.');
    if (trip.fields.quantity_tonnes && new Decimal(trip.fields.quantity_tonnes).gt(vehicle.payloadTonnes)) errors.push('Суммарная масса рейса превышает подтверждённую грузоподъёмность машины.');
  }
  return [...new Set(errors)];
}
function summary(record: SabyTripRecord | undefined, ready: boolean): SabyTripResponse['saby'] {
  const documents = (record?.documents ?? []).map(({ shipmentId, id, revision, status, url, remoteStatus, lastError, updatedAt }) => ({ shipmentId, id, revision, status: status === 'pending' && (!record?.leaseUntil || Date.parse(record.leaseUntil) <= Date.now()) ? 'unknown' as const : status, url, remoteStatus, lastError, updatedAt }));
  const statuses = new Set(documents.map(doc => doc.status));
  const status = !documents.length ? ready ? 'ready' : 'unconfigured' : statuses.has('pending') ? 'pending' : statuses.has('unknown') ? 'unknown' : statuses.size > 1 ? 'partial' : documents[0].status;
  return { status, updatedAt: record?.updatedAt ?? null, lastError: documents.find(doc => doc.lastError)?.lastError ?? null, documents };
}
export function getSabyTrip(base: Snapshot, data: OperationsData, tripId: string, config = sabyConfigFromEnv()): SabyTripResponse {
  const snapshot = currentSnapshot(base, data);
  const trip = getShipmentTrip(snapshot, tripId);
  const record = data.saby?.trips[tripId];
  const errors = record?.documents.some(doc => doc.status !== 'error' || doc.id) ? sabyCredentialBlockers(config) : blockers(snapshot, trip, config);
  return { saby: summary(data.saby?.trips[tripId], errors.length === 0), readiness: { ready: errors.length === 0, blockers: errors } };
}
function safeLink(value: unknown): string | null {
  const text = sabyText(value); if (!text) return null;
  try { const url = new URL(text); return url.protocol === 'https:' && !url.username && !url.password && /(^|\.)(saby|sbis)\.ru$/.test(url.hostname) ? url.href : null; } catch { return null; }
}
function confirmed(doc: SabyObject, record: SabyDocumentRecord): Partial<SabyDocumentRecord> {
  if (doc.Тип !== 'TransportOrder' || doc.Примечание !== record.marker || !sabyText(doc.Идентификатор) || doc.Удален === 'Да' || doc.ЧастичныеДанные === 'Да') throw new SabyError('unknown', 'Прочитанный документ Saby не подтверждает отправленные данные. Требуется сверка.', true);
  const party = sabyObject(doc.НашаОрганизация) && sabyObject(doc.НашаОрганизация.СвЮЛ) ? doc.НашаОрганизация.СвЮЛ : null;
  const carrier = sabyObject(doc.Контрагент) && sabyObject(doc.Контрагент.СвЮЛ) ? doc.Контрагент.СвЮЛ : null;
  if (!party || party.ИНН !== record.snapshot.customerOrganization.inn || party.КПП !== record.snapshot.customerOrganization.kpp || !carrier || carrier.ИНН !== record.snapshot.carrierOrganization.inn || carrier.КПП !== record.snapshot.carrierOrganization.kpp) throw new SabyError('unknown', 'Saby вернул документ с неподтверждёнными участниками. Требуется сверка.', true);
  const attachments = Array.isArray(doc.Вложение) ? doc.Вложение.filter(sabyObject) : [];
  if (!attachments.some(file => file.Тип === 'ЗаказЗаявка' && file.Подтип === '1110361' && file.ВерсияФормата === '5.01')) throw new SabyError('unknown', 'Saby не подтвердил формализованное вложение заказа 1110361. Проверьте черновик в Saby.', true);
  const state = sabyObject(doc.Состояние) ? doc.Состояние : {};
  if (doc.Ошибка || state.Ошибка || state.Примечание) throw new SabyError('unknown', 'Saby сохранил документ с замечаниями. Проверьте обязательные поля в кабинете.', true);
  const revisions = Array.isArray(doc.Редакция) ? doc.Редакция.filter(sabyObject) : sabyObject(doc.Редакция) ? [doc.Редакция] : [];
  // No signing calls occur here. A remote state is informational, never proof of a carrier signature.
  return { id: sabyText(doc.Идентификатор), revision: sabyText(revisions.at(-1)?.Идентификатор), url: safeLink(doc.СсылкаДляНашаОрганизация), remoteStatus: sabyText(state.Название), status: 'draft', lastError: null, updatedAt: now() };
}
export interface SubmitSabyTripOptions {
  base: Snapshot; store: OperationsStorage; tripId: string;
  authorize: (snapshot: Snapshot, data: OperationsData) => void;
  client?: SabyClient;
}
/** Claims persist before network; the store lock is never held across an external call. */
export async function submitSabyTrip({ base, store, tripId, authorize, client = new SabyClient(sabyConfigFromEnv()) }: SubmitSabyTripOptions): Promise<SabyTripResponse> {
  const source = base.provenance.sourceSha256;
  const leaseId = randomUUID();
  const claimed = await store.mutate(source, data => {
    const snapshot = currentSnapshot(base, data); authorize(snapshot, data);
    const trip = getShipmentTrip(snapshot, tripId);
    const existing = data.saby?.trips[tripId];
    if (existing?.documents.every(doc => doc.status === 'draft')) return { result: null, changed: false };
    if (existing?.leaseId && existing.leaseUntil && Date.parse(existing.leaseUntil) > Date.now()) throw new ApiError(409, 'Передача рейса в Saby уже выполняется. Обновите состояние немного позже.');
    const errors = existing?.documents.some(doc => doc.status !== 'error' || doc.id) ? sabyCredentialBlockers(client.config) : blockers(snapshot, trip, client.config);
    if (errors.length) throw new ApiError(422, errors.join(' '));
    const stamp = now();
    const fresh = snapshots(snapshot, trip, client.config);
    const records = fresh.map(snapshot => {
      const previous = existing?.documents.find(doc => doc.shipmentId === snapshot.shipmentId);
      if (previous && previous.status !== 'error') return { ...previous, status: previous.status === 'pending' ? 'unknown' as const : previous.status };
      if (previous?.id) return previous;
      return { shipmentId: snapshot.shipmentId, id: null, revision: null, status: 'pending' as const, url: null, remoteStatus: null, lastError: null, updatedAt: stamp, createdAt: stamp, snapshot, payloadHash: hash(snapshot), marker: `ARTEL-CRM:${randomUUID()}`, attemptId: randomUUID() };
    });
    const record: SabyTripRecord = { documents: records, leaseId, leaseUntil: new Date(Date.now() + 300_000).toISOString(), updatedAt: stamp };
    data.saby ??= { trips: {} }; data.saby.trips[tripId] = record;
    return { result: structuredClone(records), changed: true };
  });
  if (claimed) {
    const attempted = new Set<string>();
    const update = async (shipmentId: string, patch: Partial<SabyDocumentRecord>) => store.mutate(source, data => {
      const record = data.saby?.trips[tripId];
      if (!record || record.leaseId !== leaseId) throw new ApiError(409, 'Сеанс передачи Saby изменён. Выполните сверку состояния.');
      const document = record.documents.find(doc => doc.shipmentId === shipmentId)!;
      Object.assign(document, patch); record.updatedAt = now(); record.leaseUntil = new Date(Date.now() + 300_000).toISOString();
      return { result: undefined, changed: true };
    });
    try {
      try { await client.verifyOrganizations(claimed[0].snapshot.customerOrganization, claimed[0].snapshot.carrierOrganization); }
      catch (error) {
        const message = error instanceof SabyError ? error.message : 'Не удалось проверить доступ к Saby.';
        for (const record of claimed.filter(doc => doc.status !== 'draft')) await update(record.shipmentId, { status: record.status === 'unknown' || record.id ? 'unknown' : 'error', lastError: message, updatedAt: now() });
        throw error;
      }
      for (const record of claimed) {
        if (record.status === 'draft') continue;
        let beganWrite = false;
        let id = record.id;
        try {
          // Recheck access between customer documents; a revoked employee cannot initiate another one.
          const latest = await store.read(source); authorize(currentSnapshot(base, latest), latest);
          if (record.status === 'unknown' && !id) {
            const rows = await client.findDocuments(record.marker, record.snapshot.fields.date!.split('-').reverse().join('.'), record.snapshot.customerOrganization, `CRM-${record.attemptId}`);
            if (rows.length !== 1) throw new SabyError('unknown', rows.length ? 'В Saby найдено несколько совпадений. Нужна ручная сверка; повторное создание запрещено.' : 'Документ пока не найден в Saby. Результат прежней записи неизвестен; новое создание запрещено. Повторите сверку позже.', true);
            id = sabyText(rows[0].Идентификатор);
            if (!id) throw new SabyError('unknown', 'Найденный документ Saby не содержит идентификатор.', true);
          }
          if (!id) {
            const document = buildSabyTransportDocument(record.snapshot, record.marker, record.attemptId, record.createdAt);
            beganWrite = true; attempted.add(record.shipmentId);
            const written = await client.writeDocument(document); id = sabyText(written.Идентификатор);
            if (!id) throw new SabyError('unknown', 'Saby не подтвердил идентификатор созданного документа.', true);
          }
          // Persist the returned ID even if a crash/revocation/read error occurs next.
          await update(record.shipmentId, { id, status: 'unknown', updatedAt: now() });
          const result = await client.readDocument(id);
          if (result.Идентификатор !== id || result.Номер !== `CRM-${record.attemptId}`) throw new SabyError('unknown', 'Ответ Saby не совпадает с идентификатором и номером созданного заказа.', true);
          await update(record.shipmentId, confirmed(result, record));
        } catch (error) {
          const known = error instanceof SabyError;
          const uncertain = record.status === 'unknown' || !!id || beganWrite && (!known || error.uncertain);
          await update(record.shipmentId, { status: uncertain ? 'unknown' : 'error', lastError: known ? error.message : error instanceof ApiError ? error.message : 'Не удалось выполнить передачу в Saby. Выполните сверку состояния.', updatedAt: now() });
          if (error instanceof ApiError) throw error;
        }
      }
    } catch (error) {
      if (!(error instanceof SabyError)) throw error;
    } finally {
      await store.mutate(source, data => {
        const record = data.saby?.trips[tripId];
        if (!record || record.leaseId !== leaseId) return { result: undefined, changed: false };
        for (const doc of record.documents) if (doc.status === 'pending') { doc.status = attempted.has(doc.shipmentId) ? 'unknown' : 'error'; doc.lastError = attempted.has(doc.shipmentId) ? 'Результат запроса Saby не сохранён. Перед повтором нужна сверка.' : 'Передача остановлена до запроса к Saby. Можно повторить после проверки доступа.'; doc.updatedAt = now(); }
        record.leaseId = null; record.leaseUntil = null; record.updatedAt = now();
        return { result: undefined, changed: true };
      });
    }
  }
  const latest = await store.read(source); authorize(currentSnapshot(base, latest), latest);
  return getSabyTrip(base, latest, tripId, client.config);
}

import { createHash, randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import type { Snapshot } from '../web/src/model';
import type { SabyConsignmentProfile } from '../web/src/etrn-model';
import type { EtrnTripResponse, EtrnDocumentSummary } from '../web/src/etrn-api-model';
import { ApiError } from './api-error';
import type { OperationsData, OperationsStorage } from './operations-store';
import { currentSnapshot } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import { SabyClient, SabyError, sabyConfigFromEnv, sabyConfigurationBlockers, sabyCredentialBlockers, sabyDocumentWorkflow, sabyObject, sabyText, type SabyConfig, type SabyObject } from './saby-client';
import { buildSabyConsignmentSnapshot, readSabyConsignmentProfile, sabyConsignmentBlockers, buildSabyConsignmentDocument, serializeSabyConsignmentNote, type SabyConsignmentSnapshot } from './saby-consignment-note';
import type { CreateTripSabyDelivery } from './trip-saby-workflow';
import { validateEtrnDispatch, type EtrnDispatch } from './etrn-dispatch';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stamp = () => new Date().toISOString();
const isDate = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullable = (v: unknown) => v === null || typeof v === 'string';
const LEASE_MS = 300_000;

interface EtrnArtifact { key: string; attachmentId: string; revision: string | null; name: string; extension: string; sha256?: string; size?: number; content?: string }
export interface EtrnDocument extends Omit<EtrnDocumentSummary, 'files'> {
  dispatch?: EtrnDispatch;
  number?: string; reservationAttempted?: boolean; uploadAttempted?: boolean;
  unexpectedDocumentIds?: string[];
  marker: string; attemptId: string; createdAt: string; payloadHash: string;
  snapshot: SabyConsignmentSnapshot; artifacts: EtrnArtifact[];
  leaseId: string | null; leaseUntil: string | null;
}
interface EtrnDelivery { profile: SabyConsignmentProfile; snapshot: SabyConsignmentSnapshot; preparedHash: string; document: EtrnDocument | null; updatedAt: string; sourceOrderId?: string }
export interface TripLoadingFacts {
  arrivedAt: string; departedAt: string;
  deliveries: Record<string, { grossMassTonnes: string; massMethod: string }>;
  recordedAt: string; actorId: string;
}
export interface EtrnData { trips: Record<string, { deliveries: Record<string, EtrnDelivery>; updatedAt: string; loadingFacts?: TripLoadingFacts }> }
const validLocalEvent = (value: unknown): value is string => {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T(?:[01]\d|2[0-3]):[0-5]\d(?::[0-5]\d)?$/.test(value)) return false;
  const date = new Date(`${value.slice(0, 10)}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value.slice(0, 10);
};
function validateLoadingFacts(value: unknown): asserts value is TripLoadingFacts {
  if (!sabyObject(value) || !validLocalEvent(value.arrivedAt) || !validLocalEvent(value.departedAt) || value.departedAt < value.arrivedAt || !isDate(value.recordedAt) || typeof value.actorId !== 'string' || !value.actorId || !sabyObject(value.deliveries) || !Object.keys(value.deliveries).length) throw new Error('Invalid loading facts');
  for (const row of Object.values(value.deliveries)) if (!sabyObject(row) || Object.keys(row).some(key => !['grossMassTonnes', 'massMethod'].includes(key)) || typeof row.grossMassTonnes !== 'string' || !/^\d{1,11}(?:\.\d{1,6})?$/.test(row.grossMassTonnes) || !new Decimal(row.grossMassTonnes).gt(0) || !['01', '02', '03'].includes(String(row.massMethod))) throw new Error('Invalid loading mass');
}

/** Fail closed on corruption; all optional additions survive legacy store reads. */
export function validateEtrnData(value: unknown): asserts value is EtrnData | undefined {
  if (value === undefined) return;
  if (!sabyObject(value) || !sabyObject(value.trips)) throw new Error('Invalid ETRN data');
  for (const [tripId, trip] of Object.entries(value.trips)) {
    if (!tripId || !sabyObject(trip) || !isDate(trip.updatedAt) || !sabyObject(trip.deliveries)) throw new Error('Invalid ETRN trip');
    if (trip.loadingFacts !== undefined) validateLoadingFacts(trip.loadingFacts);
    for (const [shipmentId, delivery] of Object.entries(trip.deliveries)) {
      if (!shipmentId || !sabyObject(delivery) || !sabyObject(delivery.profile) || !sabyObject(delivery.snapshot) || delivery.snapshot.tripId !== tripId || delivery.snapshot.shipmentId !== shipmentId || delivery.preparedHash !== hash(delivery.snapshot) || !isDate(delivery.updatedAt)) throw new Error('Invalid ETRN preparation');
      const doc = delivery.document;
      if (doc === null) continue;
      if (sabyObject(doc)) validateEtrnDispatch(doc.dispatch, typeof doc.id === 'string' ? doc.id : null);
      if (sabyObject(doc) && doc.unexpectedDocumentIds !== undefined && (!Array.isArray(doc.unexpectedDocumentIds) || doc.unexpectedDocumentIds.length > 10 || !doc.unexpectedDocumentIds.every(id => typeof id === 'string' && id.trim() && id.length <= 256))) throw new Error('Invalid unexpected ETRN identifiers');
      if (sabyObject(doc) && (doc.number !== undefined && (typeof doc.number !== 'string' || !doc.number.trim()) || doc.reservationAttempted !== undefined && typeof doc.reservationAttempted !== 'boolean' || doc.uploadAttempted !== undefined && typeof doc.uploadAttempted !== 'boolean')) throw new Error('Invalid ETRN numbering');
      if (!sabyObject(doc) || !['pending', 'unknown', 'draft', 'error'].includes(String(doc.status)) || !nullable(doc.id) || !nullable(doc.revision) || !nullable(doc.url) || !nullable(doc.remoteStatus) || !nullable(doc.lastError) || !nullable(doc.gisStatus) || !['not_signed','reported_by_saby','unknown'].includes(String(doc.signatureStatus)) || !Array.isArray(doc.availableActions) || !doc.availableActions.every(v => typeof v === 'string') || !isDate(doc.updatedAt) || !isDate(doc.createdAt) || typeof doc.marker !== 'string' || !doc.marker.startsWith('ARTEL-CRM:ETRN:') || typeof doc.attemptId !== 'string' || !doc.attemptId || !sabyObject(doc.snapshot) || doc.snapshot.tripId !== tripId || doc.snapshot.shipmentId !== shipmentId || doc.payloadHash !== hash(doc.snapshot) || !nullable(doc.leaseId) || !(doc.leaseUntil === null || isDate(doc.leaseUntil)) || !Array.isArray(doc.artifacts) || doc.artifacts.length > 500 || doc.status === 'draft' && !doc.id) throw new Error('Invalid ETRN document');
      const keys = new Set<string>();
      for (const file of doc.artifacts) {
        if (!sabyObject(file) || typeof file.key !== 'string' || !/^[a-f0-9]{64}$/.test(file.key) || keys.has(file.key) || typeof file.attachmentId !== 'string' || !file.attachmentId || !nullable(file.revision) || typeof file.name !== 'string' || typeof file.extension !== 'string') throw new Error('Invalid ETRN artifact');
        keys.add(file.key);
        if (file.content !== undefined) {
          if (typeof file.content !== 'string' || file.content.length > 28_000_000) throw new Error('Invalid ETRN file');
          const bytes = Buffer.from(file.content, 'base64');
          if (file.content !== bytes.toString('base64') || file.size !== bytes.length || file.sha256 !== bytesHash(bytes)) throw new Error('Invalid ETRN file checksum');
        }
      }
    }
  }
}

export function hasEtrnDocuments(data: OperationsData, tripId: string): boolean {
  return Object.values(data.etrn?.trips[tripId]?.deliveries ?? {}).some(row => row.document && (row.document.status !== 'error' || !!row.document.id));
}
function makeSnapshot(base: Snapshot, data: OperationsData, tripId: string, shipmentId: string, profile: SabyConsignmentProfile | null, config: SabyConfig) {
  const snapshot = currentSnapshot(base, data);
  const trip = getShipmentTrip(snapshot, tripId);
  if (!trip.customers.some(row => row.id === shipmentId)) throw new ApiError(404, 'Доставка не найдена в этом рейсе.');
  const prepared = buildSabyConsignmentSnapshot(snapshot, trip, shipmentId, config.customer, config.carrier, profile);
  if (!profile && config.consignmentSigner) Object.assign(prepared.profile.signer, config.consignmentSigner);
  return prepared;
}
function documentSummary(doc: EtrnDocument, tripId: string, shipmentId: string): EtrnDocumentSummary {
  return {
    id: doc.id, revision: doc.revision, status: doc.status === 'pending' && (!doc.leaseUntil || Date.parse(doc.leaseUntil) <= Date.now()) ? 'unknown' : doc.status,
    url: doc.url, remoteStatus: doc.remoteStatus, lastError: doc.lastError, updatedAt: doc.updatedAt,
    signatureStatus: doc.signatureStatus, gisStatus: doc.gisStatus, availableActions: doc.availableActions,
    files: doc.artifacts.map(file => ({ id: file.key, name: file.name, extension: file.extension, ...(file.sha256 ? { sha256: file.sha256, size: file.size } : {}), url: `/api/shipment-trips/${encodeURIComponent(tripId)}/etrn/files/${encodeURIComponent(shipmentId)}/${file.key}` })),
  };
}
export function getEtrnTrip(base: Snapshot, data: OperationsData, tripId: string, config = sabyConfigFromEnv()): EtrnTripResponse {
  const trip = getShipmentTrip(currentSnapshot(base, data), tripId);
  const saved = data.etrn?.trips[tripId];
  const configurationBlockers = sabyConfigurationBlockers(config);
  const displayOrganization = (org: SabyConfig['customer']) => ({ name: org.name, inn: org.inn, kpp: org.kpp, address: org.address, phone: org.phone ?? '' });
  return { configured: !configurationBlockers.length, configurationBlockers, updatedAt: saved?.updatedAt ?? null,
    organizations: { consignor: displayOrganization(config.customer), carrier: displayOrganization(config.carrier) },
    deliveries: trip.customers.map(row => {
      const preparation = saved?.deliveries[row.id];
      const doc = preparation?.document;
      const snapshot = doc && doc.status !== 'error' ? doc.snapshot : preparation?.sourceOrderId ? preparation.snapshot : makeSnapshot(base, data, tripId, row.id, preparation?.profile ?? null, config);
      const stale = preparation && !doc && hash(snapshot) !== preparation.preparedHash;
      return { shipmentId: row.id, profile: snapshot.profile, blockers: [...sabyConsignmentBlockers(snapshot), ...(stale ? ['Данные рейса или справочников изменились. Сохраните и проверьте подготовку повторно.'] : [])], document: doc ? documentSummary(doc, tripId, row.id) : null };
    }),
  };
}
type Authorize = (snapshot: Snapshot, data: OperationsData) => void;
export interface EtrnOptions { base: Snapshot; store: OperationsStorage; tripId: string; authorize: Authorize; client?: SabyClient }

export async function saveEtrnProfile(options: EtrnOptions, shipmentId: string, raw: unknown): Promise<EtrnTripResponse> {
  const { base, store, tripId, authorize } = options;
  const config = options.client?.config ?? sabyConfigFromEnv();
  if (!sabyObject(raw) || JSON.stringify(raw).length > 80_000) throw new ApiError(400, 'Некорректные данные подготовки ЭТрН.');
  const profile = readSabyConsignmentProfile(raw);
  await store.mutate(base.provenance.sourceSha256, data => {
    authorize(currentSnapshot(base, data), data);
    if (data.tripSaby?.trips[tripId]) throw new ApiError(409, 'Рейс запущен в Saby. Исправления документов выполняются в Saby; факты погрузки вводятся отдельно.');
    const previous = data.etrn?.trips[tripId]?.deliveries[shipmentId];
    if (previous?.document && (previous.document.status !== 'error' || previous.document.id)) throw new ApiError(409, 'ЭТрН уже передана или результат передачи неизвестен. Сначала выполните сверку.');
    const snapshot = makeSnapshot(base, data, tripId, shipmentId, profile, config);
    data.etrn ??= { trips: {} };
    const trip = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: stamp() };
    trip.deliveries[shipmentId] = { profile: snapshot.profile!, snapshot, preparedHash: hash(snapshot), document: null, updatedAt: stamp() };
    trip.updatedAt = stamp();
    return { result: undefined, changed: true };
  });
  const data = await store.read(base.provenance.sourceSha256); authorize(currentSnapshot(base, data), data);
  return getEtrnTrip(base, data, tripId, config);
}

function partyMatches(raw: unknown, expected: { inn: string; kpp: string }) {
  if (/^\d{12}$/.test(expected.inn)) return sabyObject(raw) && sabyObject(raw.СвФЛ) && raw.СвФЛ.ИНН === expected.inn;
  const party = sabyObject(raw) && sabyObject(raw.СвЮЛ) ? raw.СвЮЛ : null;
  return !!party && party.ИНН === expected.inn && party.КПП === expected.kpp;
}
function confirmed(remote: SabyObject, doc: EtrnDocument): Partial<EtrnDocument> {
  if (remote.Тип !== 'ConsignmentNote' || remote.Идентификатор !== doc.id || remote.Номер !== (doc.number ?? `CRM-${doc.attemptId}`) || remote.Примечание !== doc.marker || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да') throw new SabyError('unknown', 'Прочитанная ЭТрН не совпадает с отправленным документом. Повторное создание запрещено.', true);
  const parties = sabyObject(remote.Стороны) ? remote.Стороны : {};
  const sender = parties.Отправитель ?? remote.Грузоотправитель ?? remote.НашаОрганизация;
  const carrier = parties.Перевозчик ?? remote.Перевозчик ?? remote.ТранспортнаяКомпания;
  const recipient = parties.Получатель ?? remote.Грузополучатель;
  if (!partyMatches(sender, doc.snapshot.customerOrganization) || !partyMatches(carrier, doc.snapshot.carrierOrganization) || !partyMatches(recipient, doc.snapshot.profile!.recipient)) throw new SabyError('unknown', 'Saby не подтвердил всех трёх участников ЭТрН. Требуется сверка документа.', true);
  const attachments = Array.isArray(remote.Вложение) ? remote.Вложение.filter(sabyObject) : [];
  const firstTitles = attachments.filter(file => file.Подтип === '1110339' && file.ВерсияФормата === '5.01' && file.Удален !== 'Да');
  if (firstTitles.length !== 1) throw new SabyError('unknown', 'Saby не подтвердил единственный действующий первый титул ЭТрН 1110339 v5.01.', true);
  const hasErrors = (value: SabyObject) => Number(value.КоличествоОшибок ?? 0) > 0 || !!value.Ошибка || Array.isArray(value.Ошибки) && value.Ошибки.length > 0;
  if (hasErrors(remote) || hasErrors(firstTitles[0])) throw new SabyError('unknown', 'Saby вернул замечания проверки первого титула ЭТрН. Исправьте документ в Saby и обновите состояние.', true);
  const state = sabyObject(remote.Состояние) ? remote.Состояние : {};
  if (hasErrors(state)) throw new SabyError('unknown', 'Saby сохранил ЭТрН с ошибками. Откройте документ и проверьте обязательные сведения.', true);
  const workflow = sabyDocumentWorkflow(remote);
  if (!workflow.revision) throw new SabyError('unknown', 'Saby не подтвердил редакцию ЭТрН. Требуется повторная сверка.', true);
  const artifacts = [...doc.artifacts];
  for (const file of workflow.attachments) {
    const key = hash([workflow.revision, file.id]);
    if (!artifacts.some(saved => saved.key === key)) artifacts.push({ key, attachmentId: file.id, revision: workflow.revision, name: file.name, extension: file.extension });
  }
  return { status: 'draft', revision: workflow.revision, url: workflow.url, remoteStatus: workflow.remoteStatus, signatureStatus: workflow.signatureStatus, gisStatus: workflow.gisStatus, availableActions: workflow.availableActions, artifacts, lastError: null, updatedAt: stamp() };
}

/** Persist the intent before network; reconcile unknown results without any second write. */
export async function exchangeEtrn(options: EtrnOptions, shipmentId: string, refresh = false): Promise<EtrnTripResponse> {
  const { base, store, tripId, authorize } = options;
  const client = options.client ?? new SabyClient(sabyConfigFromEnv());
  const source = base.provenance.sourceSha256;
  const leaseId = randomUUID();
  const claimed = await store.mutate(source, data => {
    authorize(currentSnapshot(base, data), data);
    if (data.tripSaby?.trips[tripId] && !refresh) throw new ApiError(409, 'ЭТрН этого рейса создаются общей цепочкой Saby после подтверждения перевозчика.');
    const preparation = data.etrn?.trips[tripId]?.deliveries[shipmentId];
    if (!preparation) throw new ApiError(422, 'Сначала сохраните и проверьте сведения ЭТрН.');
    // Check membership even for old records, and forbid writes against another organization.
    const fresh = makeSnapshot(base, data, tripId, shipmentId, preparation.profile, client.config);
    const previous = preparation.document;
    if (refresh && preparation.sourceOrderId && !previous?.id) throw new ApiError(409, 'Сверьте результат общей цепочкой Saby: отдельное восстановление ЭТрН без идентификатора недоступно.');
    if (previous?.leaseId && previous.leaseUntil && Date.parse(previous.leaseUntil) > Date.now()) throw new ApiError(409, 'Запрос ЭТрН уже выполняется. Обновите состояние позже.');
    if (previous?.status === 'draft' && !refresh) return { result: null, changed: false };
    if (refresh && !previous) throw new ApiError(422, 'ЭТрН ещё не передавалась в Saby.');
    const recover = !!previous && (previous.status !== 'error' || !!previous.id);
    const errors = recover ? sabyCredentialBlockers(client.config) : [...sabyConfigurationBlockers(client.config), ...sabyConsignmentBlockers(fresh)];
    if (errors.length) throw new ApiError(422, [...new Set(errors)].join(' '));
    if (!recover && hash(fresh) !== preparation.preparedHash) throw new ApiError(409, 'Данные рейса или справочников изменились. Сохраните подготовку ЭТрН повторно.');
    if (refresh && previous?.status === 'error' && !previous.id) throw new ApiError(422, 'Запись не начиналась. Используйте создание после проверки данных.');
    const time = stamp();
    const doc: EtrnDocument = recover ? { ...previous!, status: previous!.status === 'pending' ? 'unknown' : previous!.status } : {
      id: null, revision: null, status: 'pending', url: null, remoteStatus: null, lastError: null,
      updatedAt: time, createdAt: time, attemptId: randomUUID(), marker: `ARTEL-CRM:ETRN:${randomUUID()}`,
      snapshot: fresh, payloadHash: hash(fresh), artifacts: [], signatureStatus: 'unknown', gisStatus: null, availableActions: [], leaseId: null, leaseUntil: null,
    };
    doc.leaseId = leaseId; doc.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    preparation.document = doc; preparation.updatedAt = time; data.etrn!.trips[tripId].updatedAt = time;
    return { result: structuredClone(doc), changed: true };
  });
  if (claimed) {
    let beganWrite = false;
    let id = claimed.id;
    const update = async (patch: Partial<EtrnDocument>) => store.mutate(source, data => {
      const row = data.etrn?.trips[tripId]?.deliveries[shipmentId];
      if (!row?.document || row.document.leaseId !== leaseId) throw new ApiError(409, 'Сеанс обмена ЭТрН изменился. Выполните сверку.');
      Object.assign(row.document, patch); row.updatedAt = stamp(); data.etrn!.trips[tripId].updatedAt = stamp();
      return { result: undefined, changed: true };
    });
    try {
      await client.verifyOrganizations(claimed.snapshot.customerOrganization, claimed.snapshot.carrierOrganization);
      const latest = await store.read(source); authorize(currentSnapshot(base, latest), latest);
      if (!id && claimed.status === 'unknown') {
        const rows = await client.findDocuments(claimed.marker, claimed.snapshot.fields.date!.split('-').reverse().join('.'), claimed.snapshot.customerOrganization, `CRM-${claimed.attemptId}`, 'ConsignmentNote');
        if (rows.length !== 1 || !sabyText(rows[0].Идентификатор)) throw new SabyError('unknown', rows.length ? 'Найдено несколько совпадений ЭТрН. Проверьте Saby; повторная запись запрещена.' : 'Прежняя ЭТрН пока не найдена. Результат неизвестен; повторная запись запрещена.', true);
        id = sabyText(rows[0].Идентификатор);
      }
      if (!id) {
        const request = buildSabyConsignmentDocument(claimed.snapshot, claimed.marker, claimed.attemptId, claimed.createdAt);
        beganWrite = true;
        id = sabyText((await client.writeConsignmentNote(request)).Идентификатор);
        if (!id) throw new SabyError('unknown', 'Saby не вернул идентификатор ЭТрН. Требуется сверка.', true);
      }
      await update({ id, status: 'unknown', updatedAt: stamp() });
      const remote = await client.readConsignmentNote(id!);
      await update(confirmed(remote, { ...claimed, id }));
    } catch (error) {
      const uncertain = !!id || claimed.status === 'unknown' || beganWrite && (!(error instanceof SabyError) || error.uncertain);
      await update({ id, status: uncertain ? 'unknown' : 'error', lastError: error instanceof SabyError || error instanceof ApiError ? error.message : 'Обмен ЭТрН не подтверждён. Выполните сверку состояния.', updatedAt: stamp() });
      if (error instanceof ApiError) throw error;
    } finally {
      await update({ leaseId: null, leaseUntil: null });
    }
  }
  const data = await store.read(source); authorize(currentSnapshot(base, data), data);
  return getEtrnTrip(base, data, tripId, client.config);
}

export async function saveTripLoadingFacts(options: EtrnOptions, raw: unknown, actorId: string): Promise<void> {
  const { base, store, tripId, authorize } = options;
  if (!sabyObject(raw) || Object.keys(raw).some(key => !['arrivedAt', 'departedAt', 'deliveries'].includes(key))) throw new ApiError(400, 'Проверьте сведения о фактической погрузке.');
  const facts = { ...raw, recordedAt: stamp(), actorId };
  try { validateLoadingFacts(facts); } catch { throw new ApiError(400, 'Укажите фактические прибытие и убытие, положительную массу каждой доставки в тоннах и способ определения массы.'); }
  if (Date.parse(`${facts.departedAt}+03:00`) > Date.now()) throw new ApiError(400, 'Фактическое убытие не может быть в будущем.');
  await store.mutate(base.provenance.sourceSha256, data => {
    authorize(currentSnapshot(base, data), data);
    const workflow = data.tripSaby?.trips[tripId];
    if (getShipmentTrip(currentSnapshot(base, data), tripId).fields.trip_flow_version === 'driver-v1') throw new ApiError(409, 'Факты этого рейса фиксирует назначенный водитель действиями «Прибыл» и «Убыл».');
    if (!workflow?.carrierEvidence) throw new ApiError(409, 'Сначала дождитесь подтверждения заявки перевозчиком в Saby.');
    if (workflow.leaseId && workflow.leaseUntil && Date.parse(workflow.leaseUntil) > Date.now()) throw new ApiError(409, 'Обмен выполняется. Дождитесь его завершения.');
    const ids = workflow.deliveries.map(row => row.shipmentId);
    if (Object.keys(facts.deliveries).length !== ids.length || ids.some(id => !facts.deliveries[id])) throw new ApiError(400, 'Подтвердите фактическую массу каждой доставки рейса.');
    const previous = data.etrn?.trips[tripId];
    if (previous?.loadingFacts || Object.values(previous?.deliveries ?? {}).some(row => row.document)) throw new ApiError(409, 'Факты погрузки уже сохранены. Исправления переданных документов выполняются в Saby.');
    const actualTotal = Object.values(facts.deliveries).reduce((sum, row) => sum.plus(row.grossMassTonnes), new Decimal(0));
    if (workflow.deliveries.some(row => actualTotal.gt(row.snapshot.profile.vehicle.payloadTonnes))) throw new ApiError(422, 'Сумма фактических масс доставок превышает подтверждённую грузоподъёмность машины.');
    const order = { id: workflow.order.id!, number: workflow.order.number!, date: workflow.order.date! };
    const errors = workflow.deliveries.flatMap(row => sabyConsignmentBlockers(snapshotWithLoading(row.snapshot, facts, order)));
    if (errors.length) throw new ApiError(422, [...new Set(errors)].join(' '));
    data.etrn ??= { trips: {} };
    const trip = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: stamp() };
    trip.loadingFacts = facts; trip.updatedAt = stamp();
    return { result: undefined, changed: true };
  });
}

function snapshotWithLoading(snapshot: SabyConsignmentSnapshot, facts: TripLoadingFacts, order: CreateTripSabyDelivery['order']): SabyConsignmentSnapshot {
  const result = structuredClone(snapshot);
  result.profile.order = { number: order.number, date: order.date };
  result.profile.loading = { arrivedAt: facts.arrivedAt, departedAt: facts.departedAt, ...facts.deliveries[snapshot.shipmentId] };
  return result;
}

/** Two durable writes target one Saby ID: reserve its registry number, then attach the title. */
export async function exchangePreparedEtrn(options: EtrnOptions, input: CreateTripSabyDelivery): Promise<{ status: 'pending' | 'unknown' | 'draft' | 'error'; id: string | null; lastError: string | null; waitingForLoading?: boolean }> {
  const { base, store, tripId, authorize } = options;
  const client = options.client ?? new SabyClient(sabyConfigFromEnv()), source = base.provenance.sourceSha256, shipmentId = input.shipmentId;
  const leaseId = randomUUID();
  const initial = await store.read(source); authorize(currentSnapshot(base, initial), initial);
  const facts = initial.etrn?.trips[tripId]?.loadingFacts;
  if (!facts) return { status: 'error', id: null, lastError: 'Заявка подтверждена. Заполните фактические сведения погрузки всего рейса.', waitingForLoading: true };
  // Validate ALL deliveries before the first consignment reservation, including saved actual facts.
  const allErrors = (initial.tripSaby?.trips[tripId]?.deliveries ?? []).flatMap(row => sabyConsignmentBlockers(snapshotWithLoading(row.snapshot, facts, input.order)));
  if (allErrors.length) return { status: 'error', id: null, lastError: [...new Set(allErrors)].join(' ') };
  const claimed = await store.mutate(source, data => {
    authorize(currentSnapshot(base, data), data);
    const workflow = data.tripSaby?.trips[tripId];
    if (!workflow?.carrierEvidence || workflow.order.id !== input.order.id || workflow.carrierEvidence.evidenceHash !== input.carrierEvidence.evidenceHash) throw new ApiError(409, 'Подтверждение общей заявки изменилось. Выполните сверку.');
    const existing = data.etrn?.trips[tripId]?.deliveries[shipmentId];
    if (existing?.document?.leaseUntil && Date.parse(existing.document.leaseUntil) > Date.now()) throw new ApiError(409, 'ЭТрН уже обрабатывается.');
    if (existing?.document?.status === 'draft') return { result: structuredClone(existing.document), changed: false };
    const snapshot = existing?.document?.snapshot ?? snapshotWithLoading(input.snapshot, facts, input.order);
    const errors = sabyConsignmentBlockers(snapshot); if (errors.length) throw new ApiError(422, errors.join(' '));
    const time = stamp();
    const doc: EtrnDocument = existing?.document ?? { id: null, revision: null, status: 'pending', url: null, remoteStatus: null, lastError: null, updatedAt: time, createdAt: time, marker: `ARTEL-CRM:ETRN:${randomUUID()}`, attemptId: randomUUID(), payloadHash: hash(snapshot), snapshot, artifacts: [], signatureStatus: 'unknown', gisStatus: null, availableActions: [], leaseId: null, leaseUntil: null, reservationAttempted: false, uploadAttempted: false };
    doc.leaseId = leaseId; doc.leaseUntil = new Date(Date.now() + LEASE_MS).toISOString();
    data.etrn ??= { trips: {} };
    const trip = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: time };
    trip.deliveries[shipmentId] = { profile: snapshot.profile, snapshot, preparedHash: hash(snapshot), document: doc, updatedAt: time, sourceOrderId: input.order.id };
    return { result: structuredClone(doc), changed: true };
  });
  if (claimed.status === 'draft') return { status: claimed.status, id: claimed.id, lastError: claimed.lastError };
  let doc = claimed;
  const update = async (patch: Partial<EtrnDocument>) => {
    doc = await store.mutate(source, data => {
      const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
      if (!current || current.leaseId !== leaseId) throw new ApiError(409, 'Сеанс ЭТрН изменился. Выполните сверку.');
      Object.assign(current, patch, { updatedAt: stamp() });
      return { result: structuredClone(current), changed: true };
    });
  };
  const checkAccess = async () => { const data = await store.read(source); authorize(currentSnapshot(base, data), data); };
  const validateReservation = (remote: SabyObject) => {
    if (remote.Идентификатор !== doc.id || remote.Тип !== 'ConsignmentNote' || remote.Примечание !== doc.marker || remote.Дата !== doc.snapshot.fields.date?.split('-').reverse().join('.') || !sabyText(remote.Номер) || doc.number && remote.Номер !== doc.number || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да' || !partyMatches(remote.НашаОрганизация, doc.snapshot.customerOrganization)) throw new SabyError('unknown', 'Saby не подтвердил зарезервированный номер ЭТрН. Новое создание запрещено.', true);
  };
  let writing: 'reservation' | 'upload' | null = null;
  let armedAction: 'reservation' | 'upload' | null = null;
  try {
    await client.verifyOrganizations(doc.snapshot.customerOrganization, doc.snapshot.carrierOrganization); await checkAccess();
    if (!doc.id && doc.reservationAttempted) {
      const found = await client.findDocuments(doc.marker, doc.snapshot.fields.date!.split('-').reverse().join('.'), doc.snapshot.customerOrganization, doc.number, 'ConsignmentNote');
      if (found.length !== 1 || !sabyText(found[0].Идентификатор)) throw new SabyError('unknown', 'Результат создания ЭТрН пока не установлен. Повторное создание запрещено.', true);
      await update({ id: sabyText(found[0].Идентификатор), status: 'unknown' }); await checkAccess();
    }
    if (!doc.id) {
      const full = buildSabyConsignmentDocument(doc.snapshot, doc.marker, doc.attemptId, doc.createdAt, '1');
      const { Номер: _number, Вложение: _attachments, ...metadata } = full; void _number; void _attachments;
      armedAction = 'reservation';
      await update({ reservationAttempted: true, status: 'pending' }); await checkAccess();
      armedAction = null; writing = 'reservation';
      const reserved = await client.reserveNumberedDocument(metadata);
      const id = sabyText(reserved.Идентификатор);
      if (!id) throw new SabyError('unknown', 'Saby не вернул идентификатор ЭТрН. Требуется сверка.', true);
      await update({ id, status: 'unknown' }); writing = null; await checkAccess();
    }
    let remote = await client.readConsignmentNote(doc.id!); validateReservation(remote);
    await update({ number: String(remote.Номер) }); await checkAccess();
    const hasTitle = Array.isArray(remote.Вложение) && remote.Вложение.some(row => sabyObject(row) && row.Подтип === '1110339' && row.Удален !== 'Да');
    if (!hasTitle) {
      if (doc.uploadAttempted) throw new SabyError('unknown', 'Результат загрузки первого титула ЭТрН неизвестен. Повторная загрузка запрещена.', true);
      const request = { ...buildSabyConsignmentDocument(doc.snapshot, doc.marker, doc.attemptId, doc.createdAt, doc.number), Идентификатор: doc.id };
      armedAction = 'upload';
      await update({ uploadAttempted: true, status: 'pending' }); await checkAccess();
      armedAction = null; writing = 'upload';
      const uploaded = await client.writeConsignmentNote(request);
      if (uploaded.Идентификатор !== doc.id) {
        const unexpectedId = sabyText(uploaded.Идентификатор);
        if (unexpectedId && unexpectedId.length <= 256) await update({ unexpectedDocumentIds: [...new Set([...(doc.unexpectedDocumentIds || []), unexpectedId])].slice(0, 10) });
        throw new SabyError('unknown', 'Saby вернул другой идентификатор ЭТрН при загрузке титула.', true);
      }
      writing = null; await checkAccess(); remote = await client.readConsignmentNote(doc.id!);
    }
    await update(confirmed(remote, doc));
  } catch (error) {
    const localDenied = armedAction && error instanceof ApiError && [401, 403].includes(error.status);
    const denied = localDenied || writing && error instanceof SabyError && !error.uncertain && ['authorization', 'permission'].includes(error.kind);
    const deniedAction = localDenied ? armedAction : writing;
    await update({ ...(denied && deniedAction === 'reservation' ? { reservationAttempted: false } : {}), ...(denied && deniedAction === 'upload' ? { uploadAttempted: false } : {}), status: denied ? 'error' : doc.reservationAttempted || doc.id ? 'unknown' : 'error', lastError: error instanceof SabyError || error instanceof ApiError ? error.message : 'Результат обмена ЭТрН неизвестен. Выполните сверку.' });
    if (error instanceof ApiError && [401, 403].includes(error.status)) throw error;
  } finally { await update({ leaseId: null, leaseUntil: null }); }
  await checkAccess();
  return { status: doc.status, id: doc.id, lastError: doc.lastError };
}

export function preparedEtrnXml(base: Snapshot, data: OperationsData, tripId: string, shipmentId: string, config = sabyConfigFromEnv()) {
  const row = data.etrn?.trips[tripId]?.deliveries[shipmentId];
  if (!row) throw new ApiError(422, 'Сначала сохраните подготовку ЭТрН.');
  const snapshot = row.document?.snapshot ?? makeSnapshot(base, data, tripId, shipmentId, row.profile, config);
  const errors = sabyConsignmentBlockers(snapshot);
  if (errors.length) throw new ApiError(422, errors.join(' '));
  return serializeSabyConsignmentNote(snapshot, row.document?.attemptId ?? '00000000-0000-4000-8000-000000000001', row.document?.createdAt ?? row.updatedAt, row.document?.number);
}

/** Cache immutable bytes privately in the store; never expose session-bearing vendor links. */
export async function downloadEtrnFile(options: EtrnOptions, shipmentId: string, key: string) {
  const { base, store, tripId, authorize } = options;
  const source = base.provenance.sourceSha256;
  const data = await store.read(source); authorize(currentSnapshot(base, data), data);
  const doc = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
  const file = doc?.artifacts.find(file => file.key === key);
  if (!doc?.id || !file) throw new ApiError(404, 'Файл ЭТрН не найден.');
  if (file.content) return { bytes: Buffer.from(file.content, 'base64'), name: file.name, extension: file.extension };
  // A revision can change in Saby; uncached historical bytes must not be replaced by newer ones.
  if (file.revision !== doc.revision) throw new ApiError(409, 'Этот файл относится к предыдущей редакции. Откройте архив редакций в Saby.');
  const client = options.client ?? new SabyClient(sabyConfigFromEnv());
  const read = await client.readConsignmentNote(doc.id);
  const workflow = sabyDocumentWorkflow(read);
  if (workflow.revision !== file.revision || !workflow.attachments.some(item => item.id === file.attachmentId)) throw new ApiError(409, 'Редакция документа в Saby изменилась. Обновите состояние ЭТрН.');
  const downloaded = await client.downloadAttachment(doc.id, file.attachmentId, file.revision);
  if (downloaded.bytes.length > 20_000_000) throw new ApiError(413, 'Файл слишком велик для CRM. Скачайте его в Saby.');
  await store.mutate(source, latest => {
    authorize(currentSnapshot(base, latest), latest);
    const current = latest.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
    const target = current?.artifacts.find(item => item.key === key);
    if (!target || current?.revision !== file.revision) throw new ApiError(409, 'Редакция ЭТрН изменилась. Обновите список файлов.');
    const content = Buffer.from(downloaded.bytes).toString('base64');
    if (target.content && target.content !== content) throw new ApiError(409, 'Saby вернул другие байты сохранённого файла. Требуется сверка.');
    target.content = content; target.size = downloaded.bytes.length; target.sha256 = bytesHash(downloaded.bytes);
    return { result: undefined, changed: true };
  });
  return { bytes: downloaded.bytes, name: file.name, extension: file.extension };
}

import { createHash, randomUUID } from 'node:crypto';
import type { Snapshot } from '../web/src/model';
import type { SabyConsignmentProfile } from '../web/src/etrn-model';
import type { EtrnTripResponse, EtrnDocumentSummary } from '../web/src/etrn-api-model';
import { ApiError } from './api-error';
import type { OperationsData, OperationsStorage } from './operations-store';
import { currentSnapshot } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import { SabyClient, SabyError, sabyConfigFromEnv, sabyConfigurationBlockers, sabyCredentialBlockers, sabyDocumentWorkflow, sabyObject, sabyText, type SabyConfig, type SabyObject } from './saby-client';
import { buildSabyConsignmentSnapshot, readSabyConsignmentProfile, sabyConsignmentBlockers, buildSabyConsignmentDocument, serializeSabyConsignmentNote, type SabyConsignmentSnapshot } from './saby-consignment-note';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stamp = () => new Date().toISOString();
const isDate = (v: unknown) => typeof v === 'string' && Number.isFinite(Date.parse(v));
const nullable = (v: unknown) => v === null || typeof v === 'string';
const LEASE_MS = 300_000;

interface EtrnArtifact { key: string; attachmentId: string; revision: string | null; name: string; extension: string; sha256?: string; size?: number; content?: string }
interface EtrnDocument extends Omit<EtrnDocumentSummary, 'files'> {
  marker: string; attemptId: string; createdAt: string; payloadHash: string;
  snapshot: SabyConsignmentSnapshot; artifacts: EtrnArtifact[];
  leaseId: string | null; leaseUntil: string | null;
}
interface EtrnDelivery { profile: SabyConsignmentProfile; snapshot: SabyConsignmentSnapshot; preparedHash: string; document: EtrnDocument | null; updatedAt: string }
export interface EtrnData { trips: Record<string, { deliveries: Record<string, EtrnDelivery>; updatedAt: string }> }

/** Fail closed on corruption; all optional additions survive legacy store reads. */
export function validateEtrnData(value: unknown): asserts value is EtrnData | undefined {
  if (value === undefined) return;
  if (!sabyObject(value) || !sabyObject(value.trips)) throw new Error('Invalid ETRN data');
  for (const [tripId, trip] of Object.entries(value.trips)) {
    if (!tripId || !sabyObject(trip) || !isDate(trip.updatedAt) || !sabyObject(trip.deliveries)) throw new Error('Invalid ETRN trip');
    for (const [shipmentId, delivery] of Object.entries(trip.deliveries)) {
      if (!shipmentId || !sabyObject(delivery) || !sabyObject(delivery.profile) || !sabyObject(delivery.snapshot) || delivery.snapshot.tripId !== tripId || delivery.snapshot.shipmentId !== shipmentId || delivery.preparedHash !== hash(delivery.snapshot) || !isDate(delivery.updatedAt)) throw new Error('Invalid ETRN preparation');
      const doc = delivery.document;
      if (doc === null) continue;
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
      const snapshot = doc && doc.status !== 'error' ? doc.snapshot : makeSnapshot(base, data, tripId, row.id, preparation?.profile ?? null, config);
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
  const party = sabyObject(raw) && sabyObject(raw.СвЮЛ) ? raw.СвЮЛ : null;
  return !!party && party.ИНН === expected.inn && party.КПП === expected.kpp;
}
function confirmed(remote: SabyObject, doc: EtrnDocument): Partial<EtrnDocument> {
  if (remote.Тип !== 'ConsignmentNote' || remote.Идентификатор !== doc.id || remote.Номер !== `CRM-${doc.attemptId}` || remote.Примечание !== doc.marker || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да') throw new SabyError('unknown', 'Прочитанная ЭТрН не совпадает с отправленным документом. Повторное создание запрещено.', true);
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
    const preparation = data.etrn?.trips[tripId]?.deliveries[shipmentId];
    if (!preparation) throw new ApiError(422, 'Сначала сохраните и проверьте сведения ЭТрН.');
    // Check membership even for old records, and forbid writes against another organization.
    const fresh = makeSnapshot(base, data, tripId, shipmentId, preparation.profile, client.config);
    const previous = preparation.document;
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

export function preparedEtrnXml(base: Snapshot, data: OperationsData, tripId: string, shipmentId: string, config = sabyConfigFromEnv()) {
  const row = data.etrn?.trips[tripId]?.deliveries[shipmentId];
  if (!row) throw new ApiError(422, 'Сначала сохраните подготовку ЭТрН.');
  const snapshot = row.document?.snapshot ?? makeSnapshot(base, data, tripId, shipmentId, row.profile, config);
  const errors = sabyConsignmentBlockers(snapshot);
  if (errors.length) throw new ApiError(422, errors.join(' '));
  return serializeSabyConsignmentNote(snapshot, row.document?.attemptId ?? '00000000-0000-4000-8000-000000000001', row.document?.createdAt ?? row.updatedAt);
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

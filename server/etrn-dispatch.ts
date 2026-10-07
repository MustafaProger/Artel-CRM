import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from './api-error';
import type { EtrnDocument, EtrnOptions } from './etrn-service';
import { currentSnapshot } from './shipment-operations';
import { authorizeAutomaticTripSaby } from './trip-saby-workflow';
import { SabyClient, SabyError, sabyConfigFromEnv, sabyDocumentWorkflow, sabyObject, sabyText, type SabyObject } from './saby-client';
import { assertSigningBinding, assertSigningManifest, createCarrierDraftBinding, createSigningBinding, prepareBoundSigning, prepareCarrierDraft, readSigningEvidence, restorePreparedSigning, signingCertificateForOrganization, type SabySigningBinding, type SabySigningManifest, type SabySigningSide } from './saby-signing';
import { serializeSabyConsignmentNote } from './saby-consignment-note';
import { verifyConsignmentSenderBusiness, verifyConsignmentCarrierBusiness, verifyConsignmentCarrierSourceSignature, fillConsignmentCarrier } from './saby-consignment-evidence';

export interface EtrnDispatchStep {
  state: 'not_started' | 'preparing' | 'waiting' | 'unknown' | 'blocked' | 'confirmed';
  binding?: SabySigningBinding; prepared?: SabySigningManifest;
  verified?: boolean; executeAttempted?: boolean;
  dispatchState?: 'not_sent' | 'attempted' | 'acknowledged';
}
export interface EtrnDispatch {
  version: 1; sender: EtrnDispatchStep; carrier: EtrnDispatchStep;
  carrierDraft?: { binding: SabySigningBinding; state: 'preparing' | 'ready' | 'unknown' };
  carrierFill?: { id: string; revision: string; name: string; beforeHash: string; afterHash: string; attempted: true };
  completedAt?: string; lastError?: string;
}
const rows = (value: unknown): SabyObject[] => Array.isArray(value) ? value.filter(sabyObject) : sabyObject(value) ? [value] : [];
const bytesHash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const stamp = () => new Date().toISOString();
const fail = (message: string): never => { throw new SabyError('validation', message); };
export function validateEtrnDispatch(value: unknown, documentId: string | null): void {
  if (value === undefined) return;
  if (!sabyObject(value) || value.version !== 1 || !documentId || Object.keys(value).some(key => !['version', 'sender', 'carrier', 'carrierDraft', 'carrierFill', 'completedAt', 'lastError'].includes(key))) throw new Error('Invalid ETRN dispatch');
  for (const side of ['sender', 'carrier'] as const) {
    const step = value[side];
    if (!sabyObject(step) || Object.keys(step).some(key => !['state', 'binding', 'prepared', 'verified', 'executeAttempted', 'dispatchState'].includes(key)) || !['not_started', 'preparing', 'waiting', 'unknown', 'blocked', 'confirmed'].includes(String(step.state))) throw new Error('Invalid ETRN dispatch step');
    if (step.verified !== undefined && typeof step.verified !== 'boolean' || step.executeAttempted !== undefined && typeof step.executeAttempted !== 'boolean') throw new Error('Invalid ETRN execution flags');
    if (step.binding !== undefined) {
      assertSigningBinding(step.binding as unknown as SabySigningBinding);
      const binding = step.binding as unknown as SabySigningBinding;
      if (binding.documentType !== 'ConsignmentNote' || binding.documentId !== documentId || binding.side !== side || binding.keyType !== 'Отложенный') throw new Error('Invalid ETRN dispatch binding');
    }
    if (step.prepared !== undefined) {
      assertSigningManifest(step.prepared as unknown as SabySigningManifest);
      if (JSON.stringify((step.prepared as SabySigningManifest).binding) !== JSON.stringify(step.binding)) throw new Error('Invalid ETRN dispatch manifest');
    }
    if (step.executeAttempted && (!step.prepared || step.verified !== true) || step.state === 'confirmed' && (!step.prepared || !step.executeAttempted)) throw new Error('Missing ETRN execution evidence');
    if (step.dispatchState !== undefined && !['not_sent', 'attempted', 'acknowledged'].includes(String(step.dispatchState))) throw new Error('Invalid ETRN dispatch state');
    if (step.verified && !step.prepared || step.dispatchState === 'not_sent' && (step.executeAttempted || step.verified !== true) || ['attempted', 'acknowledged'].includes(String(step.dispatchState)) && step.executeAttempted !== true) throw new Error('Inconsistent ETRN dispatch state');
  }
  if (value.carrierDraft !== undefined) {
    if (!sabyObject(value.carrierDraft) || !['preparing', 'ready', 'unknown'].includes(String(value.carrierDraft.state))) throw new Error('Invalid ETRN carrier preparation');
    const binding = value.carrierDraft.binding as SabySigningBinding;
    assertSigningBinding(binding);
    if (binding.documentType !== 'ConsignmentNote' || binding.documentId !== documentId || binding.side !== 'carrier' || binding.attachmentId !== 'unprepared-carrier-title') throw new Error('Invalid ETRN carrier draft binding');
  }
  if (value.carrierFill !== undefined && (!sabyObject(value.carrierFill) || value.carrierFill.attempted !== true || !['id', 'revision', 'name'].every(key => sabyText((value.carrierFill as SabyObject)[key])) || !['beforeHash', 'afterHash'].every(key => /^[a-f0-9]{64}$/.test(String((value.carrierFill as SabyObject)[key]))))) throw new Error('Invalid ETRN carrier fill');
  if (value.completedAt !== undefined && (typeof value.completedAt !== 'string' || !Number.isFinite(Date.parse(value.completedAt)) || (value.sender as EtrnDispatchStep).state !== 'confirmed' || (value.carrier as EtrnDispatchStep).state !== 'confirmed')) throw new Error('Unconfirmed ETRN completion');
}
function partyMatches(value: unknown, expected: { inn: string; kpp: string }): boolean {
  if (!sabyObject(value)) return false;
  const party = /^\d{10}$/.test(expected.inn) ? value.СвЮЛ : value.СвФЛ;
  return sabyObject(party) && party.ИНН === expected.inn && (/^\d{12}$/.test(expected.inn) || party.КПП === expected.kpp);
}
function verifyIdentity(remote: SabyObject, doc: EtrnDocument, side: SabySigningSide): void {
  const p = sabyObject(remote.Стороны) ? remote.Стороны : {};
  const own = side === 'sender' ? doc.snapshot.customerOrganization : doc.snapshot.carrierOrganization;
  if (remote.Тип !== 'ConsignmentNote' || remote.Идентификатор !== doc.id || remote.Номер !== doc.number || remote.Дата !== doc.snapshot.fields.date?.split('-').reverse().join('.') || !partyMatches(remote.НашаОрганизация, own) || !partyMatches(p.Отправитель ?? remote.Грузоотправитель, doc.snapshot.customerOrganization) || !partyMatches(p.Перевозчик ?? remote.ТранспортнаяКомпания ?? remote.Перевозчик, doc.snapshot.carrierOrganization) || !partyMatches(p.Получатель ?? remote.Грузополучатель, doc.snapshot.profile.recipient) || remote.Удален === 'Да' || remote.ЧастичныеДанные === 'Да') fail('Участники, номер или содержимое ЭТрН изменились. Автоматическая отправка остановлена.');
}
function title(remote: SabyObject, subtype: string) {
  const revision = sabyDocumentWorkflow(remote).revision;
  const titles = rows(remote.Вложение).filter(row => row.Подтип === subtype && row.ВерсияФормата === '5.01' && row.Удален !== 'Да' && row.Актуален !== 'Нет' && (!sabyObject(row.Редакция) || !row.Редакция.Идентификатор || row.Редакция.Идентификатор === revision));
  if (!revision || titles.length !== 1 || !sabyText(titles[0].Идентификатор)) fail('Не подтверждён единственный актуальный титул ЭТрН.');
  return { id: String(titles[0].Идентификатор), revision: revision! };
}
/** Exact recipient assignment at the next stage, not a general state code or accepted Execute. */
export function consignmentClientDispatchConfirmed(remote: SabyObject, recipient: { inn: string; kpp: string }): boolean {
  if (remote.ЧастичныеДанные === 'Да' || remote.Удален === 'Да' || remote.Ошибка || Number(remote.КоличествоОшибок ?? 0) > 0) return false;
  const stages = rows(remote.Этап);
  return rows(remote.ТекущиеЭтапы).some(summary => {
    const found = stages.filter(stage => stage.Идентификатор === summary.Идентификатор);
    if (found.length > 1) return false;
    const stage = found.length === 1 ? found[0] : summary;
    if (stage.Название !== 'Приемка груза' || stage.Служебный === 'Да' || stage.Завершен === 'Да' || stage.Актуален === 'Нет') return false;
    return rows(stage.Исполнитель).some(executor => partyMatches(executor.Контрагент, recipient));
  });
}

/** Automatic stage six exists only for new driver-v1 attempts carrying the saved server policy. */
export async function continueEtrnDispatch(options: EtrnOptions, shipmentId: string): Promise<{ completedAt: string | null; lastError: string | null }> {
  const { base, store, tripId, authorize } = options, source = base.provenance.sourceSha256;
  let client = options.client ?? new SabyClient(sabyConfigFromEnv());
  const leaseId = randomUUID();
  const authority = (data: import('./operations-store').OperationsData) => {
    const snapshot = currentSnapshot(base, data); authorize(snapshot, data);
    const workflow = data.tripSaby?.trips[tripId];
    if (!workflow?.driverFlow || workflow.driverFlow.state !== 'ready' || !workflow.autoAuthorization || !workflow.carrierEvidence || workflow.signing?.sender.state !== 'confirmed' || workflow.signing.carrier.state !== 'confirmed' || !data.driverTripProgress?.[tripId]?.departedAt) throw new ApiError(403, 'Не подтверждено основание автоматической отправки ЭТрН.');
    authorizeAutomaticTripSaby(snapshot, data, tripId, workflow, client.config);
    return workflow;
  };
  let doc = await store.mutate(source, data => {
    authority(data);
    const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
    if (!current?.id || current.status !== 'draft') throw new ApiError(409, 'Сначала подтвердите создание ЭТрН.');
    if (current.leaseId && current.leaseUntil && Date.parse(current.leaseUntil) > Date.now()) throw new ApiError(409, 'ЭТрН уже обрабатывается.');
    current.dispatch ??= { version: 1, sender: { state: 'not_started' }, carrier: { state: 'not_started' } };
    current.leaseId = leaseId; current.leaseUntil = new Date(Date.now() + 300_000).toISOString();
    return { result: structuredClone(current), changed: true };
  });
  const update = async (change: (row: EtrnDocument) => void) => {
    doc = await store.mutate(source, data => {
      authority(data); const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
      if (!current || current.leaseId !== leaseId || Date.parse(current.leaseUntil ?? '') <= Date.now()) throw new ApiError(409, 'Сеанс отправки ЭТрН изменился.');
      change(current); current.updatedAt = stamp(); current.leaseUntil = new Date(Date.now() + 300_000).toISOString();
      return { result: structuredClone(current), changed: true };
    });
  };
  const checkAccess = async () => {
    const data = await store.read(source); authority(data);
    const latest = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
    if (!latest || latest.leaseId !== leaseId || Date.parse(latest.leaseUntil ?? '') <= Date.now()) throw new ApiError(409, 'Сеанс отправки ЭТрН истёк.');
  };
  client = client.withRequestGuard(checkAccess);
  const business = async (remote: SabyObject, side: SabySigningSide) => {
    verifyIdentity(remote, doc, side);
    const sender = title(remote, '1110339');
    const bytes = (await client.downloadSigningAttachment(side, doc.id!, sender.id, sender.revision, 'ConsignmentNote')).bytes;
    const expected = serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, doc.number);
    verifyConsignmentSenderBusiness(bytes, expected.xml);
    if (side === 'carrier') {
      const carrier = title(remote, '1110340');
      const reply = await client.downloadSigningAttachment(side, doc.id!, carrier.id, carrier.revision, 'ConsignmentNote');
      verifyConsignmentCarrierBusiness(reply.bytes, bytes, doc.snapshot);
      const signature = await client.downloadSigningSignature(side, doc.id!, sender.id, sender.revision, doc.dispatch!.sender.prepared!.binding.certificateThumbprint, 'ConsignmentNote');
      verifyConsignmentCarrierSourceSignature(reply.bytes, signature);
    }
  };
  try {
    if (doc.dispatch?.completedAt) return { completedAt: doc.dispatch.completedAt, lastError: null };
    for (const side of ['sender', 'carrier'] as const) {
      let step = doc.dispatch![side];
      if (step.prepared) {
        const evidence = await readSigningEvidence(client, step.prepared);
        if (evidence.state === 'changed') fail(evidence.reason);
        if (evidence.state === 'confirmed') {
          await business(await client.readSigningDocument(side, doc.id!, 'ConsignmentNote'), side);
          await update(row => { row.dispatch![side].state = 'confirmed'; });
          continue;
        }
        if (step.executeAttempted) { await update(row => { row.dispatch![side].state = 'waiting'; row.dispatch!.lastError = evidence.reason; }); break; }
      }
      if (step.state === 'blocked' || step.binding && !step.prepared || step.prepared && (step.verified !== true || step.dispatchState !== 'not_sent')) {
        await update(row => { row.dispatch![side].state = 'unknown'; row.dispatch!.lastError = 'Результат подготовки ЭТрН неизвестен. Повторное действие не выполняется.'; }); break;
      }
      let remote = await client.readSigningDocument(side, doc.id!, 'ConsignmentNote'); verifyIdentity(remote, doc, side);
      const selection = (await store.read(source)).tripSaby!.trips[tripId].autoAuthorization!.selection[side];
      const org = side === 'sender' ? doc.snapshot.customerOrganization : doc.snapshot.carrierOrganization;
      const certificate = signingCertificateForOrganization(await client.readSigningCertificate(side, selection), org);
      if (!certificate || certificate.thumbprint !== selection) fail('Выбранная подпись ЭТрН недоступна для организации.');
      if (side === 'carrier' && !rows(remote.Вложение).some(row => row.Подтип === '1110340' && row.Удален !== 'Да')) {
        if (doc.dispatch!.carrierDraft) { await update(row => { row.dispatch!.lastError = 'Ответ перевозчика ещё не подтверждён; повторная подготовка не выполняется.'; }); break; }
        const binding = createCarrierDraftBinding(remote, certificate!, client.config, 'Отложенный', 'ConsignmentNote');
        await update(row => { row.dispatch!.carrierDraft = { binding, state: 'preparing' }; });
        remote = await prepareCarrierDraft(client, binding);
        await update(row => { row.dispatch!.carrierDraft!.state = 'ready'; });
      }
      if (side === 'carrier' && !step.binding) {
        const sender = title(remote, '1110339'), carrier = title(remote, '1110340');
        const sourceFile = await client.downloadSigningAttachment(side, doc.id!, sender.id, sender.revision, 'ConsignmentNote');
        verifyConsignmentSenderBusiness(sourceFile.bytes, serializeSabyConsignmentNote(doc.snapshot, doc.attemptId, doc.createdAt, doc.number).xml);
        const reply = await client.downloadSigningAttachment(side, doc.id!, carrier.id, carrier.revision, 'ConsignmentNote');
        const sourceSignature = await client.downloadSigningSignature(side, doc.id!, sender.id, sender.revision, doc.dispatch!.sender.prepared!.binding.certificateThumbprint, 'ConsignmentNote');
        verifyConsignmentCarrierSourceSignature(reply.bytes, sourceSignature);
        const previous = doc.dispatch!.carrierFill;
        if (previous) {
          if (previous.id !== carrier.id || previous.revision !== carrier.revision || previous.name !== reply.name || previous.afterHash !== bytesHash(reply.bytes)) fail('Результат заполнения ответа перевозчика ЭТрН неизвестен или изменён. Повторная запись не выполняется.');
        } else {
          const filled = fillConsignmentCarrier(reply.bytes, sourceFile.bytes, doc.snapshot);
          if (filled.changed) {
            const before = bytesHash(reply.bytes), after = bytesHash(filled.bytes);
            const fresh = await client.downloadSigningAttachment(side, doc.id!, carrier.id, carrier.revision, 'ConsignmentNote');
            if (fresh.name !== reply.name || bytesHash(fresh.bytes) !== before) fail('Ответ перевозчика ЭТрН изменился до заполнения.');
            await update(row => { row.dispatch!.carrierFill = { id: carrier.id, revision: carrier.revision, name: reply.name, beforeHash: before, afterHash: after, attempted: true }; });
            await client.writeCarrierAttachment(doc.id!, carrier.revision, carrier.id, reply.name, filled.bytes);
            const saved = await client.downloadSigningAttachment(side, doc.id!, carrier.id, carrier.revision, 'ConsignmentNote');
            if (saved.name !== reply.name || bytesHash(saved.bytes) !== after) fail('Saby не подтвердил сохранённые сведения ответа перевозчика ЭТрН.');
            remote = await client.readSigningDocument(side, doc.id!, 'ConsignmentNote');
          }
        }
      }
      await business(remote, side);
      let prepared;
      if (step.prepared && step.verified && step.dispatchState === 'not_sent') prepared = await restorePreparedSigning(client, step.prepared);
      else {
        const binding = createSigningBinding(remote, side, certificate!, client.config, 'Отложенный', 'ConsignmentNote');
        await update(row => { row.dispatch![side] = { state: 'preparing', binding }; });
        prepared = await prepareBoundSigning(client, binding);
        const manifest: SabySigningManifest = { binding: prepared.binding, attachments: prepared.attachments.map(({ bytes: _bytes, ...file }) => file), preparedHash: prepared.preparedHash };
        await update(row => { row.dispatch![side].prepared = manifest; });
        await business(await client.readSigningDocument(side, doc.id!, 'ConsignmentNote'), side);
        await update(row => { row.dispatch![side].verified = true; row.dispatch![side].dispatchState = 'not_sent'; });
      }
      await client.executeDeferredSigning(prepared, async () => {
        await update(row => { row.dispatch![side].executeAttempted = true; row.dispatch![side].dispatchState = 'attempted'; row.dispatch![side].state = 'waiting'; });
      });
      await update(row => { row.dispatch![side].dispatchState = 'acknowledged'; });
      step = doc.dispatch![side];
      const evidence = await readSigningEvidence(client, step.prepared!);
      if (evidence.state === 'changed') fail(evidence.reason);
      await update(row => { row.dispatch![side].state = evidence.state === 'confirmed' ? 'confirmed' : 'waiting'; row.dispatch!.lastError = evidence.state === 'confirmed' ? undefined : evidence.reason; });
      if (evidence.state !== 'confirmed') break;
    }
    if (doc.dispatch!.sender.state === 'confirmed' && doc.dispatch!.carrier.state === 'confirmed') {
      const remote = await client.readSigningDocument('sender', doc.id!, 'ConsignmentNote');
      await business(remote, 'sender');
      const delivered = consignmentClientDispatchConfirmed(remote, doc.snapshot.profile.recipient);
      await update(row => { if (delivered) { row.dispatch!.completedAt ??= stamp(); row.dispatch!.lastError = undefined; } else { delete row.dispatch!.completedAt; row.dispatch!.lastError = 'Подписи получены. Saby ещё не подтвердил передачу на этап приёмки именно этому клиенту.'; } });
    }
  } catch (error) {
    await update(row => {
      delete row.dispatch!.completedAt;
      const step = row.dispatch!.sender.state !== 'confirmed' ? row.dispatch!.sender : row.dispatch!.carrier;
      step.state = error instanceof SabyError && !error.uncertain && error.kind === 'validation' ? 'blocked' : 'unknown';
      row.dispatch!.lastError = error instanceof SabyError || error instanceof ApiError ? error.message : 'Отправка ЭТрН не подтверждена. Нужна сверка.';
    });
  } finally {
    await store.mutate(source, data => {
      const current = data.etrn?.trips[tripId]?.deliveries[shipmentId]?.document;
      if (!current || current.leaseId !== leaseId) return { result: undefined, changed: false };
      current.leaseId = null; current.leaseUntil = null;
      return { result: undefined, changed: true };
    });
  }
  return { completedAt: doc.dispatch?.completedAt ?? null, lastError: doc.dispatch?.lastError ?? null };
}

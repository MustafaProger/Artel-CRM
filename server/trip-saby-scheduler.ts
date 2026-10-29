import type { ShipmentAccessContext } from './shipment-operations';
import type { Snapshot } from '../web/src/model';
import { ApiError } from './api-error';
import { publicUser } from './auth';
import { requireWholeTrip } from './auth-scope';
import { requireTripSection } from './permissions';
import type { OperationsData, OperationsStorage } from './operations-store';
import { currentShipmentAccess } from './shipment-operations';
import { exchangeEtrn, exchangePreparedEtrn, type EtrnOptions } from './etrn-service';
import { SabyClient, sabyCredentialBlockers, type SabyConfig } from './saby-client';
import { prepareTripSaby } from './trip-saby-preparation';
import { authorizeAutomaticTripSaby, runTripSabyWorkflow, type PrepareTripSaby, type TripSabyRecord } from './trip-saby-workflow';
import { authorizeSigningActor } from './trip-saby-signing';
import { carrierFastPolling } from './trip-saby-carrier';
import { getShipmentTrip } from './shipment-trips';
import { assertTripTransportDocumentsAllowed } from './trip-document-mode';
import { runNkDirectEtrn, type NkDirectEtrnRecord } from './nk-direct-etrn';

export const SABY_WORKFLOW_TICK_MS = 60_000;
export const SABY_CARRIER_WAIT_TICK_MS = 15_000;
// A created ETRN and even one signature do not prove that all participants finished.
export const SABY_COMPLETED_REFRESH_MS = 60_000;
export interface TripSabySchedulerOptions {
  base: Snapshot; store: OperationsStorage; config: SabyConfig; enabled: boolean;
  prepare?: PrepareTripSaby; send?: typeof fetch; now?: number;
  /** Runtime client owns shared, account-isolated sessions across trip jobs. */
  client?: SabyClient;
  carrierWaitingOnly?: boolean;
  /** The post-save dispatch processes only the newly enqueued trip. */
  tripId?: string;
  /** Runtime-wide fair network budget; permission checks run after a slot is granted. */
  runNetwork?: <T>(action: () => Promise<T>) => Promise<T>;
}
export interface TripSabyDispatchResult { continued: number; refreshed: number; denied: number; failed: number }

// These predicates only select work from a fresh scan; they do not authorize it.
// Every launched pass still reads again, claims its lease and guards each request.
function directDue(record: NkDirectEtrnRecord, now: number): boolean {
  return record.phase !== 'completed' || !(now - Date.parse(record.lastCheckedAt ?? record.updatedAt) < SABY_COMPLETED_REFRESH_MS);
}
function workflowContinuing(record: TripSabyRecord, now: number): boolean {
  const expiredSubmission = record.phase === 'submitting' && !!record.leaseId
    && (!record.leaseUntil || Date.parse(record.leaseUntil) <= now);
  const queuedAutomatic = !!record.autoAuthorization && record.phase === 'submitting' && !record.leaseId && !record.reservationAttempted && !record.uploadAttempted && !record.order.id;
  return ['awaiting_driver', 'awaiting_carrier', 'awaiting_loading', 'creating_etrn', 'sending_etrn', 'unknown'].includes(record.phase) || expiredSubmission || queuedAutomatic || !!record.driverFlow && record.phase === 'completed' && !record.stage6CompletedAt;
}
function workflowDue(data: OperationsData, tripId: string, record: TripSabyRecord, now: number, carrierWaitingOnly: boolean): boolean {
  if (carrierWaitingOnly && (!carrierFastPolling(record, now) || now - Date.parse(record.lastCheckAttemptAt ?? record.createdAt) < SABY_CARRIER_WAIT_TICK_MS)) return false;
  if (!(record.signing?.requestedBy ?? record.initiatorId)) return false;
  if (workflowContinuing(record, now)) return true;
  if (record.phase !== 'completed') return false;
  return record.deliveries.some(row => {
    const doc = data.etrn?.trips[tripId]?.deliveries[row.shipmentId]?.document;
    return !!doc?.id && !(now - Date.parse(doc.updatedAt) < SABY_COMPLETED_REFRESH_MS);
  });
}

/** A manual refresh and a scheduled refresh report the same successful observation time. */
export async function refreshTripSabyDelivery(context: EtrnOptions, shipmentId: string): Promise<void> {
  const { base, store, tripId, authorize } = context;
  const source = base.provenance.sourceSha256;
  await store.mutate(source, data => {
    authorize(currentShipmentAccess(base, data), data);
    const record = data.tripSaby?.trips[tripId];
    if (!record) return { result: undefined, changed: false };
    record.lastCheckAttemptAt = new Date().toISOString();
    return { result: undefined, changed: true };
  });
  const refreshed = await exchangeEtrn(context, shipmentId, true);
  const checked = refreshed.deliveries.find(delivery => delivery.shipmentId === shipmentId)?.document;
  if (checked?.status === 'draft' && !checked.lastError) await store.mutate(source, data => {
    authorize(currentShipmentAccess(base, data), data);
    const record = data.tripSaby?.trips[tripId];
    if (!record) return { result: undefined, changed: false };
    record.lastCheckedAt = checked.updatedAt;
    return { result: undefined, changed: true };
  });
}

/** Only explicit saved attempts are eligible; no account/session or browser is impersonated. */
export async function dispatchTripSaby(options: TripSabySchedulerOptions): Promise<TripSabyDispatchResult> {
  const result: TripSabyDispatchResult = { continued: 0, refreshed: 0, denied: 0, failed: 0 };
  if (!options.enabled) return result;
  const { base, store, config } = options;
  const source = base.provenance.sourceSha256;
  const initial = await store.read(source);
  for (const [tripId, saved] of Object.entries(initial.etrn?.trips ?? {})) {
    if (!saved.direct || options.carrierWaitingOnly || options.tripId && options.tripId !== tripId) continue;
    if (!directDue(saved.direct, options.now ?? Date.now())) continue;
    try {
      await runNkDirectEtrn({ base, store, tripId, authorize: () => {}, client: options.client ?? new SabyClient(config, options.send ?? fetch, undefined, options.runNetwork) });
      result.continued++;
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) result.denied++;
      else if (!(error instanceof ApiError && error.status === 409)) result.failed++;
    }
  }
  for (const [tripId, record] of Object.entries(sabyCredentialBlockers(config).length ? {} : initial.tripSaby?.trips ?? {})) {
    if (options.tripId && options.tripId !== tripId) continue;
    const now = options.now ?? Date.now();
    if (!workflowDue(initial, tripId, record, now, !!options.carrierWaitingOnly)) continue;
    const authorityId = record.signing?.requestedBy ?? record.initiatorId;
    const continuing = workflowContinuing(record, now);
    const authorize = (snapshot: ShipmentAccessContext, data: OperationsData) => {
      const current = data.tripSaby?.trips[tripId];
      if (!current || current.attemptId !== record.attemptId || current.initiatorId !== record.initiatorId || (current.signing?.requestId ?? current.autoAuthorization?.requestId) !== (record.signing?.requestId ?? record.autoAuthorization?.requestId) || (current.signing?.requestedBy ?? current.initiatorId) !== authorityId) throw new ApiError(403, 'Основание фонового обмена изменилось.');
      const user = data.accounts?.users.find(row => row.id === authorityId && row.active && !row.deletedAt);
      if (!user) throw new ApiError(403, 'Инициатор обмена больше не имеет доступа.');
      authorizeSigningActor(snapshot, data, tripId, current);
      authorizeAutomaticTripSaby(snapshot, data, tripId, current, config);
      const actor = publicUser(user);
      requireTripSection(actor, true); requireWholeTrip(actor, snapshot, tripId);
      assertTripTransportDocumentsAllowed(getShipmentTrip(snapshot, tripId), data);
    };
    const checkAccess = async () => { const data = await store.read(source); authorize(currentShipmentAccess(base, data), data); };
    // Every fetch, including authentication, organization lookups and attachment GETs,
    // checks current permissions. A revocation stops the next network call immediately.
    const client = (options.client ?? new SabyClient(config, options.send ?? fetch, undefined, options.runNetwork)).withRequestGuard(checkAccess);
    const context = { base, store, tripId, authorize, client };
    try {
      await checkAccess();
      if (continuing) {
        await runTripSabyWorkflow({ ...context, monitoringEnabled: true, prepare: options.prepare ?? prepareTripSaby, createDelivery: (input, guardedClient) => exchangePreparedEtrn({ ...context, client: guardedClient }, input) });
        result.continued++;
      } else {
        for (const row of record.deliveries) {
          const latest = await store.read(source); authorize(currentShipmentAccess(base, latest), latest);
          const doc = latest.etrn?.trips[tripId]?.deliveries[row.shipmentId]?.document;
          if (!doc?.id || (options.now ?? Date.now()) - Date.parse(doc.updatedAt) < SABY_COMPLETED_REFRESH_MS) continue;
          await refreshTripSabyDelivery(context, row.shipmentId);
          result.refreshed++;
        }
      }
    } catch (error) {
      if (error instanceof ApiError && [401, 403, 404].includes(error.status)) result.denied++;
      else if (!(error instanceof ApiError && error.status === 409)) result.failed++;
      // Neither private payloads nor vendor errors enter process logs.
    }
  }
  return result;
}

/**
 * Each trip owns its task. Long provider workflows cannot hold the next scan or
 * another trip; only their individual network calls share the bounded FIFO queue.
 * OperationsStore leases still arbitrate with manual actions and other processes.
 */
export function createTripSabyScheduler(options: Omit<TripSabySchedulerOptions, 'tripId' | 'carrierWaitingOnly' | 'runNetwork'>, networkConcurrency = 4) {
  if (!Number.isSafeInteger(networkConcurrency) || networkConcurrency < 1) throw new Error('Invalid Saby network concurrency');
  const active = new Map<string, { operation: Promise<void>; rerun: boolean }>();
  const scans = new Set<Promise<void>>();
  const waiting: (() => void)[] = [];
  let requests = 0, stopped = false;
  const runNetwork = async <T>(action: () => Promise<T>): Promise<T> => {
    if (requests >= networkConcurrency) await new Promise<void>(done => waiting.push(done));
    else requests++;
    try { return await action(); }
    finally {
      const next = waiting.shift();
      if (next) next(); else requests--;
    }
  };
  const client = (options.client ?? new SabyClient(options.config, options.send ?? fetch)).withRequestBudget(runNetwork);
  const launch = (tripId: string, carrierWaitingOnly = false, immediate = false) => {
    if (stopped || !options.enabled) return;
    const current = active.get(tripId);
    if (current) {
      // Timer ticks do not accumulate work. A newly saved departure needs at most
      // one fresh pass after a task that may already have read the old facts.
      if (immediate) current.rerun = true;
      return;
    }
    const task = { operation: Promise.resolve(), rerun: false };
    task.operation = Promise.resolve().then(async () => {
      do {
        task.rerun = false;
        try { await dispatchTripSaby({ ...options, client, tripId, carrierWaitingOnly }); }
        catch { /* Durable attempts preserve recovery; private provider data never enters logs. */ }
        carrierWaitingOnly = false;
      } while (!stopped && task.rerun);
    }).finally(() => { active.delete(tripId); if (task.rerun) launch(tripId, false, true); });
    active.set(tripId, task);
  };
  return {
    /** Manual runtime reads use the same session pool and network budget. */
    client,
    /** Resolves when the scan has dispatched work, without awaiting provider calls. */
    tick(carrierWaitingOnly = false): Promise<void> {
      if (stopped || !options.enabled) return Promise.resolve();
      const scan = (async () => {
        const data = await options.store.read(options.base.provenance.sourceSha256);
        const now = options.now ?? Date.now();
        if (!carrierWaitingOnly) for (const [tripId, saved] of Object.entries(data.etrn?.trips ?? {})) if (saved.direct && directDue(saved.direct, now)) launch(tripId);
        if (!sabyCredentialBlockers(options.config).length) for (const [tripId, record] of Object.entries(data.tripSaby?.trips ?? {})) {
          if (workflowDue(data, tripId, record, now, carrierWaitingOnly)) launch(tripId, carrierWaitingOnly);
        }
      })().finally(() => { scans.delete(scan); });
      scans.add(scan);
      return scan;
    },
    request(tripId: string) { launch(tripId, false, true); },
    async drain() { while (scans.size || active.size) { await Promise.all([...scans]); await Promise.all([...active.values()].map(task => task.operation)); } },
    async stop() {
      stopped = true;
      // Existing workflows may have persisted a write intent before requesting
      // capacity. Drain them; cancelling queued calls would fabricate unknown writes.
      await Promise.allSettled([...scans]);
      await Promise.all([...active.values()].map(task => task.operation));
    },
  };
}

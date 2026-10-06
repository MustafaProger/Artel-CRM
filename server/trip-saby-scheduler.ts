import type { Snapshot } from '../web/src/model';
import { ApiError } from './api-error';
import { publicUser } from './auth';
import { requireWholeTrip } from './auth-scope';
import { requireTripSection } from './permissions';
import type { OperationsData, OperationsStorage } from './operations-store';
import { currentSnapshot } from './shipment-operations';
import { exchangeEtrn, exchangePreparedEtrn, type EtrnOptions } from './etrn-service';
import { SabyClient, sabyCredentialBlockers, type SabyConfig } from './saby-client';
import { prepareTripSaby } from './trip-saby-preparation';
import { runTripSabyWorkflow, type PrepareTripSaby } from './trip-saby-workflow';
import { authorizeSigningActor } from './trip-saby-signing';
import { carrierFastPolling } from './trip-saby-carrier';

export const SABY_WORKFLOW_TICK_MS = 5 * 60_000;
export const SABY_CARRIER_WAIT_TICK_MS = 15_000;
// A created ETRN and even one signature do not prove that all participants finished.
export const SABY_COMPLETED_REFRESH_MS = 5 * 60_000;
export interface TripSabySchedulerOptions {
  base: Snapshot; store: OperationsStorage; config: SabyConfig; enabled: boolean;
  prepare?: PrepareTripSaby; send?: typeof fetch; now?: number;
  carrierWaitingOnly?: boolean;
}
export interface TripSabyDispatchResult { continued: number; refreshed: number; denied: number; failed: number }

/** A manual refresh and a scheduled refresh report the same successful observation time. */
export async function refreshTripSabyDelivery(context: EtrnOptions, shipmentId: string): Promise<void> {
  const { base, store, tripId, authorize } = context;
  const source = base.provenance.sourceSha256;
  await store.mutate(source, data => {
    authorize(currentSnapshot(base, data), data);
    const record = data.tripSaby?.trips[tripId];
    if (!record) return { result: undefined, changed: false };
    record.lastCheckAttemptAt = new Date().toISOString();
    return { result: undefined, changed: true };
  });
  const refreshed = await exchangeEtrn(context, shipmentId, true);
  const checked = refreshed.deliveries.find(delivery => delivery.shipmentId === shipmentId)?.document;
  if (checked?.status === 'draft' && !checked.lastError) await store.mutate(source, data => {
    authorize(currentSnapshot(base, data), data);
    const record = data.tripSaby?.trips[tripId];
    if (!record) return { result: undefined, changed: false };
    record.lastCheckedAt = checked.updatedAt;
    return { result: undefined, changed: true };
  });
}

/** Only explicit saved attempts are eligible; no account/session or browser is impersonated. */
export async function dispatchTripSaby(options: TripSabySchedulerOptions): Promise<TripSabyDispatchResult> {
  const result: TripSabyDispatchResult = { continued: 0, refreshed: 0, denied: 0, failed: 0 };
  if (!options.enabled || sabyCredentialBlockers(options.config).length) return result;
  const { base, store, config } = options;
  const source = base.provenance.sourceSha256;
  const initial = await store.read(source);
  for (const [tripId, record] of Object.entries(initial.tripSaby?.trips ?? {})) {
    if (options.carrierWaitingOnly && (!carrierFastPolling(record, options.now ?? Date.now()) || (options.now ?? Date.now()) - Date.parse(record.lastCheckAttemptAt ?? record.createdAt) < SABY_CARRIER_WAIT_TICK_MS)) continue;
    const authorityId = record.signing?.requestedBy ?? record.initiatorId;
    if (!authorityId) continue;
    const expiredSubmission = record.phase === 'submitting' && !!record.leaseId
      && (!record.leaseUntil || Date.parse(record.leaseUntil) <= (options.now ?? Date.now()));
    const continuing = ['awaiting_carrier', 'awaiting_loading', 'creating_etrn', 'unknown'].includes(record.phase) || expiredSubmission;
    if (!continuing && record.phase !== 'completed') continue;
    const authorize = (snapshot: Snapshot, data: OperationsData) => {
      const current = data.tripSaby?.trips[tripId];
      if (!current || current.attemptId !== record.attemptId || current.initiatorId !== record.initiatorId || current.signing?.requestId !== record.signing?.requestId || (current.signing?.requestedBy ?? current.initiatorId) !== authorityId) throw new ApiError(403, 'Основание фонового обмена изменилось.');
      const user = data.accounts?.users.find(row => row.id === authorityId && row.active && !row.deletedAt);
      if (!user) throw new ApiError(403, 'Инициатор обмена больше не имеет доступа.');
      authorizeSigningActor(snapshot, data, tripId, current);
      const actor = publicUser(user);
      requireTripSection(actor, true); requireWholeTrip(actor, snapshot, tripId);
    };
    const checkAccess = async () => { const data = await store.read(source); authorize(currentSnapshot(base, data), data); };
    // Every fetch, including authentication, organization lookups and attachment GETs,
    // checks current permissions. A revocation stops the next network call immediately.
    const send: typeof fetch = async (input, init) => { await checkAccess(); return (options.send ?? fetch)(input, init); };
    const client = new SabyClient(config, send);
    const context = { base, store, tripId, authorize, client };
    try {
      await checkAccess();
      if (continuing) {
        await runTripSabyWorkflow({ ...context, monitoringEnabled: true, prepare: options.prepare ?? prepareTripSaby, createDelivery: (input, guardedClient) => exchangePreparedEtrn({ ...context, client: guardedClient }, input) });
        result.continued++;
      } else {
        for (const row of record.deliveries) {
          const latest = await store.read(source); authorize(currentSnapshot(base, latest), latest);
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

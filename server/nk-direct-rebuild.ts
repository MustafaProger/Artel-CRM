import { createHash } from 'node:crypto';
import type { Snapshot } from '../web/src/model';
import type { EtrnExchangeHistoryEntry, EtrnTrip } from './etrn-service';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { directActorAccess } from './nk-direct-etrn';
import { currentSnapshot } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import { isNkDirectEtrn } from './trip-document-mode';
import { requiresEtrn } from './trip-etrn-scope';
import { readTripNumbers } from './trip-numbering';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const sameIds = (left: string[], right: string[]) => JSON.stringify([...left].sort()) === JSON.stringify([...right].sort());

/** Read-only compare-and-swap value. Bank projections are deliberately excluded. */
export function nkDirectRebuildFingerprint(base: Snapshot, data: OperationsData, tripId: string): string {
  const snapshot = currentSnapshot(base, data, false);
  getShipmentTrip(snapshot, tripId);
  const shipments = snapshot.shipments.filter(row => row.fields.trip_id === tripId).sort((a, b) => a.id.localeCompare(b.id));
  return hash({
    tripId, trip: data.etrn?.trips[tripId] ?? null, shipments,
    shipmentOverrides: shipments.map(row => [row.id, data.shipments[row.id] ?? null]),
    driverProgress: data.driverTripProgress?.[tripId] ?? null,
    tripNumber: readTripNumbers(snapshot, data)[tripId] ?? null,
  });
}

interface RebuildOptions {
  base: Snapshot; data: OperationsData; tripId: string; actorId: string;
  requestId: string; expectedFingerprint: string; loadingActorMode: 'sender'; now?: string;
}
export interface NkDirectRebuildResult {
  changed: boolean; replayed: boolean; archiveSha256: string; rebuildId: string;
}

/**
 * Explicit maintenance transaction only. Recreates the exchange draft, not the
 * accounting shipment or a driver's action. No provider, enrollment, or signing
 * grant is created. The loading role is an explicitly reviewed business input;
 * infrastructure ownership and driver facts stay unchanged. The permanent
 * restart hold must be reconciled separately.
 */
export function rebuildNkDirectDraft(options: RebuildOptions): NkDirectRebuildResult {
  const { base, data, tripId, actorId, requestId, expectedFingerprint } = options;
  const now = options.now ?? new Date().toISOString();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(requestId) ||
      !/^[a-f0-9]{64}$/.test(expectedFingerprint) || options.loadingActorMode !== 'sender' || !Number.isFinite(Date.parse(now))) {
    throw new ApiError(400, 'Некорректное подтверждение пересоздания прямой ЭТрН.');
  }
  const snapshot = currentSnapshot(base, data, false), trip = getShipmentTrip(snapshot, tripId);
  directActorAccess(snapshot, data, tripId, actorId);
  const saved = data.etrn?.trips[tripId];
  if (!saved) throw new ApiError(409, 'У рейса нет прямой цепочки ЭТрН для пересоздания.');
  if (saved.rebuild) {
    const prior = saved.rebuild;
    const archived = saved.exchangeHistory?.find(row => row.id === requestId);
    if (prior.id !== requestId || prior.actorId !== actorId || prior.sourceFingerprint !== expectedFingerprint ||
        prior.externalRestartBlocked !== true || !archived || archived.actorId !== actorId ||
        archived.sha256 !== prior.archivedSha256 || hash(archived.exchange) !== archived.sha256 ||
        saved.loadingActorMode !== options.loadingActorMode ||
        saved.direct || saved.directAutostart || Object.keys(saved.deliveries).length) {
      throw new ApiError(409, 'Пересоздание уже выполнено или его состояние изменилось. Требуется сверка.');
    }
    return { changed: false, replayed: true, archiveSha256: prior.archivedSha256, rebuildId: requestId };
  }
  if (nkDirectRebuildFingerprint(base, data, tripId) !== expectedFingerprint) {
    throw new ApiError(409, 'Рейс или состояние обмена изменились после сверки. Пересоздание не выполнено.');
  }
  if (!saved.direct || !isNkDirectEtrn(trip, data) || trip.fields.organization_id !== 'nk-artel' ||
      trip.fields.trip_flow_version !== 'driver-v1' || data.tripSaby?.trips[tripId] || data.saby?.trips[tripId]) {
    throw new ApiError(409, 'Пересоздание доступно только для отдельной прямой ЭТрН НК.');
  }
  const required = trip.customers.filter(requiresEtrn).map(row => row.id);
  if (!required.length || !sameIds(required, saved.direct.deliveries.map(row => row.shipmentId)) ||
      !sameIds(required, Object.keys(saved.deliveries))) {
    throw new ApiError(409, 'Состав доставок прямой ЭТрН не совпадает с рейсом. Требуется сверка.');
  }
  if (saved.direct.completedAt || saved.direct.phase === 'completed' ||
      Object.values(saved.deliveries).some(row => row.document?.dispatch?.completedAt || row.document?.dispatch?.recipientAcceptedAt)) {
    throw new ApiError(409, 'Завершённую доставку нельзя пересоздать как новый черновик.');
  }
  const hasActiveLease = (value: { leaseId: string | null; leaseUntil: string | null }) =>
    !!value.leaseId && (!value.leaseUntil || !Number.isFinite(Date.parse(value.leaseUntil))) ||
    !!value.leaseUntil && Date.parse(value.leaseUntil) > Date.parse(now);
  if (hasActiveLease(saved.direct) || Object.values(saved.deliveries).some(row => row.document && hasActiveLease(row.document))) {
    throw new ApiError(409, 'Обмен ещё выполняется. Дождитесь завершения текущей операции и повторите сверку.');
  }
  if (saved.exchangeHistory?.some(row => row.id === requestId || hash(row.exchange) !== row.sha256)) {
    throw new ApiError(409, 'История обмена не прошла проверку целостности.');
  }
  const exchange: EtrnExchangeHistoryEntry['exchange'] = structuredClone({
    direct: saved.direct, deliveries: saved.deliveries,
    ...(saved.directAutostart ? { directAutostart: saved.directAutostart } : {}),
  });
  const archiveSha256 = hash(exchange);
  const archive: EtrnExchangeHistoryEntry = { id: requestId, archivedAt: now, actorId, sha256: archiveSha256, exchange };
  const replacement: EtrnTrip = { ...saved, deliveries: {}, updatedAt: now, loadingActorMode: options.loadingActorMode,
    exchangeHistory: [...(saved.exchangeHistory ?? []), archive],
    rebuild: { id: requestId, at: now, actorId, archivedSha256: archiveSha256, sourceFingerprint: expectedFingerprint, externalRestartBlocked: true },
  };
  delete replacement.direct;
  delete replacement.directAutostart;
  data.etrn!.trips[tripId] = replacement;
  return { changed: true, replayed: false, archiveSha256, rebuildId: requestId };
}

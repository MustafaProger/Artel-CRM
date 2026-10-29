import { nkDirectAutostartSourceHash, retryNkDirectAfterLoadingDetails } from './nk-direct-autostart';
import { createHash } from 'node:crypto';
import type { Snapshot } from '../web/src/model';
import type { OperationsData } from './operations-store';
import { ApiError } from './api-error';
import { currentSnapshot } from './shipment-operations';
import { getShipmentTrip } from './shipment-trips';
import { hasTripTransportHistory, isNkDirectEtrn } from './trip-document-mode';
import { directActorAccess, directCandidateBlockers, directPolicyHash } from './nk-direct-etrn';
import { departureHash, verifiedDriverDeparture } from './trip-saby-workflow';
import { readEtrnLoadingDetails } from './saby-consignment-note';
import { sabyConfigFromEnv, sabyObject, type SabyConfig } from './saby-client';

const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

/** A worker and their authority describe this loading event, never every future depot visit. */
export function getNkLoadingDetails(base: Snapshot, data: OperationsData, tripId: string, config: SabyConfig = sabyConfigFromEnv()) {
  const snapshot = currentSnapshot(base, data), trip = getShipmentTrip(snapshot, tripId);
  if (!isNkDirectEtrn(trip, data)) throw new ApiError(409, 'Сведения доступны для прямой ЭТрН НК АРТЭЛЬ.');
  const saved = data.etrn?.trips[tripId];
  const depot = snapshot.directories?.oilDepots?.find(row => row.id === trip.fields.oil_depot_id);
  const mode = saved?.loadingActorMode === 'sender' ? 'sender' : 'depot';
  const company = snapshot.companies.find(row => row.id === depot?.loadingActorCompanyId);
  const loadingActor = mode === 'sender' ? { name: config.carrier.name, inn: config.carrier.inn } : company ? { name: company.fullName || company.name, inn: company.inn || '' } : null;
  const owner = snapshot.companies.find(row => row.id === depot?.infrastructureOwnerCompanyId);
  const infrastructureOwner = owner ? { name: owner.fullName || owner.name, inn: owner.inn || '' } : null;
  const frozen = saved?.direct?.deliveries?.[0]?.snapshot;
  const carrierResponsible = saved?.direct ? frozen?.carrierResponsibleVersion === 1 ? frozen.profile.carrierResponsible ?? null : null
    : mode === 'sender' ? config.carrierResponsible ?? null : null;
  const required = mode !== 'sender' && (!company?.inn || company.inn !== config.carrier.inn || (company.kpp || '') !== (config.carrier.kpp || ''));
  const editable = !saved?.direct && !Object.values(saved?.deliveries ?? {}).some(row => !!row.document);
  const details = saved?.loadingDetails ?? null;
  const version = hash([tripId, trip.customers.map(row => [row.id,row.version,row.fields]), trip.fields.oil_depot_id, depot?.loadingActorCompanyId, company?.inn, company?.kpp, details, editable, mode, loadingActor, infrastructureOwner, carrierResponsible]);
  const enrollment = saved?.directAutostart;
  let autoContinuation = !!enrollment && enrollment.state === 'blocked' && enrollment.source === 'trip_save'
    && !!enrollment.event?.sourceHash && !saved?.rebuild && !hasTripTransportHistory(data, tripId)
    && enrollment.event.sourceHash === nkDirectAutostartSourceHash(base, data, tripId)
    && enrollment.event.factsHash === departureHash(data, tripId) && verifiedDriverDeparture(snapshot, data, tripId)
    && !directCandidateBlockers(config).length && enrollment.policyHash === directPolicyHash(config)
    && !!enrollment.certificate && enrollment.certificate === config.automaticSigning?.carrier.thumbprint;
  if (autoContinuation) {
    try { directActorAccess(snapshot, data, tripId, enrollment!.actorId); }
    catch (error) { if (!(error instanceof ApiError)) throw error; autoContinuation = false; }
  }
  return { details, editable, loadingActor, infrastructureOwner, carrierResponsible, mode, required, version, autoContinuation };
}

/** Saves a local draft and may persist the still-authorized departure intent. Never contacts Saby. */
export function saveNkLoadingDetails(base: Snapshot, data: OperationsData, tripId: string, actorId: string, input: unknown, config?: SabyConfig) {
  directActorAccess(currentSnapshot(base, data), data, tripId, actorId);
  if (!sabyObject(input) || Object.keys(input).some(key => !['version', 'details'].includes(key)) || typeof input.version !== 'string' || !sabyObject(input.details)) throw new ApiError(400, 'Передайте сведения о погрузке и версию формы.');
  const current = getNkLoadingDetails(base, data, tripId, config);
  if (!current.editable) throw new ApiError(409, 'Сведения уже включены в начатую ЭТрН. Сначала требуется сверка существующего документа.');
  if (input.version !== current.version) throw new ApiError(409, 'Сведения о погрузке изменились. Обновите форму перед сохранением.');
  const details = readEtrnLoadingDetails(input.details);
  if (hash(details) === hash(current.details)) return { result: current, changed: false };
  const now = new Date().toISOString();
  data.etrn ??= { trips: {} };
  const saved = data.etrn.trips[tripId] ??= { deliveries: {}, updatedAt: now };
  saved.loadingDetails = details;
  saved.updatedAt = now;
  retryNkDirectAfterLoadingDetails({ base, data, tripId, config: config ?? sabyConfigFromEnv() });
  return { result: getNkLoadingDetails(base, data, tripId, config), changed: true };
}

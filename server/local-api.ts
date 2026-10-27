import { readOperator, mutateOperator } from './operator';
import { readTripNumbers } from './trip-numbering';
import { cabinetRoutes } from './cabinet-connections';
import { createHash, randomUUID } from 'node:crypto';
import { BankingService } from './banking/service';
import { bankingRoutes } from './banking/routes';
import { validBankWorkflow } from './banking/cron-auth';
import type { BankRequest } from './banking/transport';
import { sberConnections } from './banking/sber-connections';
import { SberService } from './banking/sber-service';
import { dispatchBanks } from './banking/scheduler';
import { BANK_SYNC_TICK_MS } from './banking/schedule';
import { sberRoutes } from './banking/sber-routes';
import type { SberRequest } from './banking/sber-client';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { dirname, resolve } from 'node:path';
import Decimal from 'decimal.js';
import type { Plugin } from 'vite';
import { hasSection, type AccountUser } from '../web/src/auth-model';
import type { Company, Metric, Payment, QualityIssue, Shipment, Snapshot, Stock } from '../web/src/model';
import { ApiError } from './api-error';
import { decryptAccountPassword } from './account-passwords';
import { activeUsers, authenticate, deleteUser, login, logout, logisticsRequest, publicUser, requireAccounts, requireManage, requireUser, saveUser, sessionCookie } from './auth';
import { mutateDriverAccess, readDriverAccess, requireDriverRoute } from './driver-access';
import { driverTripConfirmation, readDriverTrips, recordDriverTripAction } from './driver-trips';
import { logisticsCompany, logisticsContext, requireLogisticsDirectoryInput, requireLogisticsDirectoryTarget, requireLogisticsRoute } from './logistics-api';
import { scopeSnapshot, checkShipmentWrite, ownShipmentInput, requireOwnedShipment, requireWholeTrip } from './auth-scope';
import { apiSection, requireSection, requireTripSection } from './permissions';
import { planCustomerReconciliation, reconcileCustomers } from './customer-reconciliation';
import { emptyChina } from '../web/src/china-model';
import { mutateChina } from './china-operations';
import { readWork, mutateWork, workFile, workCompanyIds } from './work-operations';
import { prepareCompanyCleanup, prepareDirectoryCleanup } from './directory-cleanup';
import { deleteDirectoryEntry } from './directory-deletion';
import { lookupCheckoCompany, validInn } from './checko';
import { OperationsStore, StoreError, type OperationsStorage } from './operations-store';
import { currentSnapshot, shipmentPage, prepareShipmentFields, inferCalculationRules } from './shipment-operations';
import { buildSettlements } from './settlements';
import { buildOrganizationSettlements, organizationSettlementsForActor } from './organization-settlements';
import { includeIdleCustomers, scopeSettlements } from './settlement-scope';
import { addDirectoryEntry, normalizeName } from './directory-operations';
import { saveCompany, updateDirectoryEntry } from './directory-editing';
import { allocateShipmentNumber } from './shipment-numbering';
import { deleteShipmentTrip, getShipmentTrip, saveShipmentTrip } from './shipment-trips';
import { cancelTripRequest, listTripRequests, requireTripRequest, saveTripRequest, tripRequestCatalog } from './trip-requests';
import { readTripRequestsMapConfig, tripRequestGeocodeTarget } from './trip-request-geocoding';
import { createNominatimGeocoder, readNominatimCachedLocation } from './nominatim-geocoder';
import { createTripRequestLocations } from './trip-request-locations';
import { createYandexTiles, serveYandexTile } from './yandex-tiles';
import { tripRequestExplicitCoordinates, type TripRequestLocationResult } from '../web/src/trip-request-map-coordinates';
import { getSabyTrip, submitSabyTrip } from './saby-service';
import { getEtrnTrip, saveEtrnProfile, exchangeEtrn, preparedEtrnXml, downloadEtrnFile, saveTripLoadingFacts, exchangePreparedEtrn } from './etrn-service';
import { getTripSigningPreview, validateSigningStart } from './trip-saby-signing';
import { enqueueAutomaticTripSaby, startAutomaticTripSaby, getTripSabyWorkflow, runTripSabyWorkflow } from './trip-saby-workflow';
import { automaticSigningCapability } from './saby-auto-policy';
import { prepareTripSaby } from './trip-saby-preparation';
import { SabyClient, sabyConfigFromEnv, sabyCredentialBlockers } from './saby-client';
import { createTripSabyScheduler, refreshTripSabyDelivery, SABY_WORKFLOW_TICK_MS, SABY_CARRIER_WAIT_TICK_MS } from './trip-saby-scheduler';
import { dispatchReminders, dispatchTaskAssignments, dispatchTripAssignments, pushConfig, pushReady, pushSessionHash, sendPush, subscribe, unsubscribe, validCron, type PushConfig, type PushSender } from './push';
import { validPushWorkflow } from './push-cron-auth';
import { acceptPushProbeReceipt, createPushProbe, createPushReceiptLimiter, markPushProbeAccepted, mutatePushProbe, readPushProbe } from './push-probe';

// Sum saved decimal strings exactly, including the source workbook's precision.
const ExactDecimal = Decimal.clone({ precision: 80 });
const defaultDataDirectory = resolve(process.cwd(), 'data/local-xlsx-final');
type SourceFields = Record<string, string | null>;
interface SourceCell { value: string | null; value_type: string; formula?: string | null }
interface SourceRecord {
  id: string;
  source: { sheet: string; row: number };
  fields: SourceFields;
  cells: Record<string, SourceCell>;
  quality_flags?: string[];
  customer_id?: string | null;
  supplier_id?: string | null;
  carrier_id?: string | null;
  counterparty_id?: string | null;
  normalized_amounts?: { incoming_amount: string | null; outgoing_amount: string | null };
}
interface SourceStock extends SourceRecord { label: string; month: string; value_basis: string }
interface SourceCompany {
  id: string;
  display_name: string;
  source_roles: string[];
  manager_labels: string[];
  shipment_ids: string[];
  payment_ids: string[];
  quality_flags: string[];
}
interface SourceManager { id: string; source_label: string; shipment_ids: string[] }
interface SourceIssue {
  code: string;
  severity: string;
  sheet: string;
  cell: string;
  value?: string;
  source_value?: string;
  parsed_decimal?: string;
  target_sheet?: string;
  range_end_rows?: number[];
  last_source_row?: number;
}
interface SourceValidation {
  status: string;
  registry_verified: boolean;
  issue_counts: Record<string, number>;
  cell_issues: SourceIssue[];
  record_flag_counts: Snapshot['quality']['recordFlagCounts'];
  duplicate_record_candidates: { dataset: string; rows: number[] }[];
  legal_form_alias_candidate_groups: { ids: string[] }[];
  multiple_manager_companies: string[];
  limitations: string[];
}
interface SourceMeta {
  source_file: string;
  source_sha256: string;
  created_at_utc: string;
  source_kind: string;
  google_verified: boolean;
  formula_policy: string;
  ownership_policy: string;
}
interface Manifest {
  meta: SourceMeta;
  counts: Record<string, number>;
  files: Record<string, { sha256: string; bytes: number }>;
}

/** Invalid or missing values stay absent; zero remains a numeric value. */
export function decimalValue(value: unknown): string | null {
  if (typeof value !== 'string' || !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value)) return null;
  return new ExactDecimal(value).isFinite() ? value : null;
}

export function exactMetric(values: (string | null)[]): Metric {
  let sum = new ExactDecimal(0);
  let numericCount = 0;
  for (const raw of values) {
    const value = decimalValue(raw);
    if (value === null) continue;
    sum = sum.plus(value);
    numericCount++;
  }
  return { total: numericCount ? sum.toFixed() : null, numericCount, missingCount: values.length - numericCount };
}

export function sourceDate(value: string | null | undefined): string | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}:\d{2}(?:\.\d+)?)?$/.test(value)) return null;
  const day = value.slice(0, 10);
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== day ? null : day;
}

const textValue = (value: unknown): string | null => typeof value === 'string' && value.length > 0 ? value : null;
const rowNumber = (cell: string): number | null => Number(cell.match(/\d+$/)?.[0]) || null;

function sourceIssueDetail(issue: SourceIssue): string | null {
  if (issue.code === 'money_stored_as_text') return `Текст «${issue.source_value}» распознан как ${issue.parsed_decimal}.`;
  if (issue.code === 'summary_range_ends_before_last_source_row') {
    return `Диапазон листа «${issue.target_sheet}» заканчивается строкой ${issue.range_end_rows?.join(', ')}, последняя исходная строка — ${issue.last_source_row}.`;
  }
  if (issue.code === 'broken_formula_reference') return 'Формула содержит повреждённую ссылку #REF!; сохранённое значение не пересчитано.';
  if (issue.code === 'cached_excel_error') return `В Excel сохранена ошибка ${issue.value ?? ''}.`;
  return null;
}

export async function loadSnapshot(dataDirectory = defaultDataDirectory): Promise<Snapshot> {
  const manifest = JSON.parse(await readFile(resolve(dataDirectory, 'manifest.json'), 'utf8')) as Manifest;
  async function readDataset<T>(name: string): Promise<T> {
    const bytes = await readFile(resolve(dataDirectory, `${name}.json`));
    const expected = manifest.files[`${name}.json`];
    if (!expected || createHash('sha256').update(bytes).digest('hex') !== expected.sha256) {
      throw new Error(`Export integrity mismatch: ${name}.json`);
    }
    const document = JSON.parse(bytes.toString('utf8')) as { meta: SourceMeta; data: T };
    if (document.meta.source_sha256 !== manifest.meta.source_sha256) throw new Error('Export source mismatch');
    return document.data;
  }
  const [rawCompanies, rawShipments, rawPayments, rawStocks, rawManagers, validation] = await Promise.all([
    readDataset<SourceCompany[]>('companies'), readDataset<SourceRecord[]>('shipments'),
    readDataset<SourceRecord[]>('payments'), readDataset<SourceStock[]>('stock_summaries'),
    readDataset<SourceManager[]>('manager_labels'), readDataset<SourceValidation>('validation_report'),
  ]);

  const companies: Company[] = rawCompanies.map(row => ({
    id: row.id, name: row.display_name, roles: row.source_roles, managerLabels: row.manager_labels,
    shipmentIds: row.shipment_ids, paymentIds: row.payment_ids, flags: row.quality_flags,
  }));
  const shipments: Shipment[] = rawShipments.map(row => ({
    calculationRules: inferCalculationRules(row.cells, row.source.row),
    id: row.id, date: sourceDate(row.fields.date), customerId: row.customer_id ?? null,
    customer: textValue(row.fields.customer_name), supplierId: row.supplier_id ?? null,
    supplier: textValue(row.fields.supplier_name), carrierId: row.carrier_id ?? null,
    carrier: textValue(row.fields.carrier_name), product: textValue(row.fields.product),
    liters: decimalValue(row.fields.quantity_litres), revenue: decimalValue(row.fields.customer_amount),
    cost: decimalValue(row.fields.purchase_amount), manager: textValue(row.fields.manager_label),
    sourceRow: row.source.row, sourceSheet: row.source.sheet, flags: [...(row.quality_flags ?? [])], fields: row.fields,
  }));
  const payments: Payment[] = rawPayments.map(row => ({
    id: row.id, date: sourceDate(row.fields.date), counterpartyId: row.counterparty_id ?? null,
    counterparty: textValue(row.fields.counterparty_name),
    // Use explicitly normalized values: nine source payment amounts are text.
    incoming: decimalValue(row.normalized_amounts?.incoming_amount),
    outgoing: decimalValue(row.normalized_amounts?.outgoing_amount), purpose: textValue(row.fields.purpose),
    sourceRow: row.source.row, sourceSheet: row.source.sheet, flags: [...(row.quality_flags ?? [])], fields: row.fields,
  }));
  const stocks: Stock[] = rawStocks.map(row => ({
    id: `stock-${row.source.sheet}-${row.source.row}-${row.counterparty_id}`, counterpartyId: row.counterparty_id ?? null,
    label: row.label, month: row.month, incomingLiters: decimalValue(row.fields.incoming_litres),
    incomingAmount: decimalValue(row.fields.incoming_amount), outgoingLiters: decimalValue(row.fields.outgoing_litres),
    outgoingAmount: decimalValue(row.fields.outgoing_amount), balanceLiters: decimalValue(row.fields.balance_litres),
    balanceAmount: decimalValue(row.fields.balance_amount), sourceRow: row.source.row, sourceSheet: row.source.sheet,
    valueBasis: row.value_basis, fields: row.fields,
    flags: [...new Set(validation.cell_issues.filter(issue => issue.sheet === row.source.sheet && issue.cell in row.cells).map(issue => issue.code))],
  }));

  const recordByCell = new Map<string, { id: string; dataset: QualityIssue['dataset'] }>();
  for (const [rows, dataset] of [[rawShipments, 'shipments'], [rawPayments, 'payments'], [rawStocks, 'stocks']] as const) {
    rows.forEach((row, index) => {
      const id = dataset === 'stocks' ? stocks[index].id : row.id;
      Object.keys(row.cells).forEach(cell => recordByCell.set(`${row.source.sheet}!${cell}`, { id, dataset }));
    });
  }
  const issues: QualityIssue[] = validation.cell_issues.map((issue, index) => {
    const record = recordByCell.get(`${issue.sheet}!${issue.cell}`);
    return {
      id: `issue-${index}`, code: issue.code, severity: issue.severity, sheet: issue.sheet, cell: issue.cell,
      sourceRow: rowNumber(issue.cell), recordId: record?.id ?? null, dataset: record?.dataset ?? null,
      value: issue.value ?? issue.source_value ?? null, detail: sourceIssueDetail(issue),
    };
  });
  const shipmentTotals = (rows: Shipment[]) => ({
    liters: exactMetric(rows.map(row => row.liters)), revenue: exactMetric(rows.map(row => row.revenue)),
    cost: exactMetric(rows.map(row => row.cost)),
  });
  const paymentTotals = (rows: Payment[]) => ({
    incoming: exactMetric(rows.map(row => row.incoming)), outgoing: exactMetric(rows.map(row => row.outgoing)),
  });
  const dates = [...shipments, ...payments].flatMap(row => row.date ? [row.date] : []).sort();
  const months = [...new Set(dates.map(date => date.slice(0, 7)))].sort();
  const companyById = new Map(companies.map(company => [company.id, company]));
  return {
    provenance: {
      sourceFile: manifest.meta.source_file, sourceSha256: manifest.meta.source_sha256,
      exportedAt: manifest.meta.created_at_utc, sourceKind: manifest.meta.source_kind,
      googleVerified: manifest.meta.google_verified, registryVerified: validation.registry_verified,
      formulaPolicy: manifest.meta.formula_policy, ownershipPolicy: manifest.meta.ownership_policy,
      valueBasis: 'Сохранённые значения XLSX; формулы не пересчитаны. Платежи включают распознанные текстовые суммы. Суммы отгрузок и выписки не являются подтверждённой задолженностью.',
      sourceFilesVerified: true, counts: manifest.counts,
      dateRange: { from: dates[0] ?? null, to: dates.at(-1) ?? null },
    },
    companies, shipments, payments, stocks,
    managers: rawManagers.map(manager => {
      const ids = new Set(manager.shipment_ids);
      const rows = shipments.filter(row => ids.has(row.id));
      return {
        id: manager.id, label: manager.source_label, shipmentIds: manager.shipment_ids,
        companyIds: companies.filter(company => company.managerLabels.includes(manager.source_label)).map(company => company.id),
        isUserAccount: false, shipmentCount: rows.length,
        liters: exactMetric(rows.map(row => row.liters)), revenue: exactMetric(rows.map(row => row.revenue)),
      };
    }),
    quality: {
      status: validation.status, issueCounts: validation.issue_counts, issues,
      recordFlagCounts: validation.record_flag_counts,
      flaggedShipmentCount: shipments.filter(row => row.flags.length > 0).length,
      flaggedPaymentCount: payments.filter(row => row.flags.length > 0).length,
      duplicateCandidates: validation.duplicate_record_candidates.map(row => ({ dataset: row.dataset, rows: row.rows })),
      aliasCandidates: validation.legal_form_alias_candidate_groups.map(group => ({
        ids: group.ids, names: group.ids.map(id => companyById.get(id)?.name ?? id),
      })),
      multipleManagerCompanyIds: validation.multiple_manager_companies,
      limitations: validation.limitations,
    },
    overview: {
      shipmentCount: shipments.length, paymentCount: payments.length, companyCount: companies.length,
      ...shipmentTotals(shipments), ...paymentTotals(payments),
      missingShipmentDates: shipments.filter(row => row.date === null).length,
      missingPaymentDates: payments.filter(row => row.date === null).length,
    },
    monthly: months.map(month => {
      const shipmentRows = shipments.filter(row => row.date?.startsWith(month));
      const paymentRows = payments.filter(row => row.date?.startsWith(month));
      return { month, shipmentCount: shipmentRows.length, paymentCount: paymentRows.length,
        ...shipmentTotals(shipmentRows), ...paymentTotals(paymentRows) };
    }),
  };
}

function isLocalHost(host: string | undefined): boolean {
  return !!host && /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i.test(host);
}

export function isLocalRequest(request: Pick<IncomingMessage, 'headers' | 'socket'>): boolean {
  const address = request.socket.remoteAddress;
  if (!address || !['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return false;
  if (!isLocalHost(request.headers.host)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  if (request.headers.origin) {
    try {
      const origin = new URL(request.headers.origin);
      if (origin.protocol !== 'http:' || origin.host !== request.headers.host) return false;
    } catch { return false; }
  }
  return true;
}

export interface LocalApiOptions {
  pushConfig?: PushConfig;
  pushSender?: PushSender;
  cronSecret?: string;
  pushIntervalSeconds?: number;
  /** Only isolated domain tests may disable authentication. Runtime always requires it. */
  requireAuthentication?: boolean;
  bankEnvironment?: Record<string, string | undefined>;
  accountPasswordKey?: string;
  cabinetEnvironment?: Record<string, string | undefined>;
  bankRequest?: BankRequest;
  sberRequest?: SberRequest;
  setupToken?: string;
  secureCookies?: boolean;
  operationsStore?: OperationsStorage;
  /** Cloud entry point supplies authentication and same-origin validation. Local default stays closed. */
  authorizeRequest?: (request: IncomingMessage) => boolean;
  operationsDirectory?: string;
  checkoApiKey?: string;
  /** Injectable only on the server, for provider integration tests. */
  fetcher?: typeof fetch;
  /** Isolated tests replace address lookup; browser input cannot select a provider. */
  tripRequestGeocoder?: (address: string, retryUnavailable?: boolean) => Promise<TripRequestLocationResult>;
  geocoderEnvironment?: Record<string, string | undefined>;
  /** Server-only Tiles credential configuration; never included in map-config responses. */
  yandexTilesEnvironment?: Record<string, string | undefined>;
  /** Provider adapter injection for isolated integration tests only. */
  sabyClient?: SabyClient;
  /** True only when this runtime has actually registered the authorized background scheduler. */
  sabyWorkflowMonitoringEnabled?: boolean;
  /** Runtime coordinator resumes an existing saved authority, never the driver's authority. */
  requestSabyWorkflow?: (tripId: string) => void;
}

async function jsonBody(request: IncomingMessage, optional = false, limit = 128 * 1024): Promise<Record<string, unknown>> {
  const type = request.headers['content-type']?.split(';')[0].trim().toLowerCase();
  const length = Number(request.headers['content-length'] ?? 0);
  if (optional && !length && !request.headers['transfer-encoding']) return {};
  if (type !== 'application/json') throw new ApiError(415, 'Передайте данные в формате application/json.');
  if (length > limit) throw new ApiError(413, 'Размер запроса превышает допустимый предел.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += Buffer.byteLength(chunk);
    if (size > limit) throw new ApiError(413, 'Размер запроса превышает допустимый предел.');
    chunks.push(Buffer.from(chunk));
  }
  try {
    const value: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected object');
    return value as Record<string, unknown>;
  } catch { throw new ApiError(400, 'Некорректный JSON запроса.'); }
}

function checkVersion(value: unknown, shipment: Shipment) {
  if (value === undefined) return;
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new ApiError(400, 'Некорректная версия операции.');
  if (value !== (shipment.version ?? 0)) throw new ApiError(409, 'Операция уже изменена в другом окне. Обновите данные и повторите изменение.');
}

export function createSnapshotMiddleware(dataDirectory = defaultDataDirectory, options: LocalApiOptions = {}) {
  const operations = options.operationsStore ?? new OperationsStore(options.operationsDirectory ?? resolve(dataDirectory, '../local-operations'));
  const locationsDirectory = operations instanceof OperationsStore ? dirname(operations.path) : options.operationsDirectory ?? resolve(dataDirectory, '../local-operations');
  const cachePath = resolve(locationsDirectory, 'trip-request-geocoding-cache.json');
  const geocode = options.tripRequestGeocoder ?? createNominatimGeocoder({ cachePath, environment: options.geocoderEnvironment, fetcher: options.fetcher });
  const locations = createTripRequestLocations({
    path: resolve(locationsDirectory, 'trip-request-locations.json'),
    namespace: JSON.stringify(['openstreetmap-nominatim-v1', (options.geocoderEnvironment ?? process.env).ARTEL_GEOCODER_URL || 'https://nominatim.openstreetmap.org/search']),
    successTtlMs: null, // OSM-derived points may be retained; another provider must select its own retention policy.
    geocode,
    peek: options.tripRequestGeocoder ? undefined : address => readNominatimCachedLocation(address, { cachePath, environment: options.geocoderEnvironment }),
  });
  const yandexTiles = createYandexTiles({ environment: options.yandexTilesEnvironment, fetcher: options.fetcher });
  const limitPushReceipt = createPushReceiptLimiter();
  let cache: { signature: string; snapshot: Promise<Snapshot> } | undefined;
  async function baseSnapshot() {
    const names = ['manifest', 'companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report'];
    const stats = await Promise.all(names.map(name => stat(resolve(dataDirectory, `${name}.json`))));
    const signature = stats.map(value => `${value.mtimeMs}:${value.ctimeMs}:${value.size}`).join('|');
    if (!cache || cache.signature !== signature) cache = { signature, snapshot: loadSnapshot(dataDirectory) };
    return cache.snapshot;
  }
  const write = (response: ServerResponse, status: number, body: string) => {
    response.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin',
      ...(status === 405 ? { Allow: 'GET, POST, PATCH, DELETE' } : {}),
    });
    response.end(body);
  };
  return (request: IncomingMessage, response: ServerResponse, next: () => void) => {
    const logistics = logisticsRequest(request);
    const pathname = logistics ? request.url!.split('?')[0].replace('/api/logistics/', '/api/') : request.url?.split('?')[0];
    if (!pathname?.startsWith('/api/')) return next();
    const cronRequest = pathname === '/api/push/dispatch';
    const bankCron = pathname === '/api/banking/dispatch';
    const bankWebhook = pathname === '/api/banking/webhooks/tbank-nk-artel';
    const pushReceipt = pathname === '/api/push/test-receipt';
    // A service worker receipt uses its short-lived token instead of a session cookie.
    // Cloud callers without Origin may use that token; present browser origins still follow the normal check.
    const originAllowed = pushReceipt && !request.headers.origin && options.authorizeRequest
      ? request.headers['sec-fetch-site'] !== 'cross-site'
      : (options.authorizeRequest ?? isLocalRequest)(request);
    if (!cronRequest && !bankCron && !bankWebhook && !originAllowed) return write(response, 403, '{"error":"Доступ к API запрещён."}');
    void (async () => {
      if (logistics) requireLogisticsRoute(pathname, request.method ?? '');
      if (cronRequest && !validCron(request, options.cronSecret ?? process.env.CRON_SECRET) && !await validPushWorkflow(request)) throw new ApiError(403, 'Доступ к планировщику запрещён.');
      const url = new URL(request.url!, 'http://localhost');
      const authEnabled = logistics || options.requireAuthentication !== false;
      const base = await baseSnapshot();
      if (pathname === '/api/maps/yandex/tiles') {
        return serveYandexTile(request, response, url.searchParams, yandexTiles, async () => {
          const user = requireUser(await operations.read(base.provenance.sourceSha256), request);
          requireDriverRoute(user, pathname, request.method ?? '');
          if (!hasSection(user, 'trips') && !hasSection(user, 'directories')) throw new ApiError(403, 'Раздел недоступен. Обратитесь к администратору.');
        });
      }
      // Driver sessions never reach generic routes (including bank/auth subrouters).
      const boundaryUser = authenticate(await operations.read(base.provenance.sourceSha256), request);
      if (boundaryUser) requireDriverRoute(boundaryUser, pathname, request.method ?? '');
      if (pathname === '/api/cabinets' || pathname.startsWith('/api/cabinets/')) return cabinetRoutes(operations, base.provenance.sourceSha256, options.cabinetEnvironment ?? process.env, request, response, () => jsonBody(request, false, 16384));
      const banking = new BankingService(operations, base.provenance.sourceSha256, options.bankEnvironment, options.bankRequest);
      if (bankCron) {
        if (request.method !== 'GET') throw new ApiError(405, 'Метод не поддерживается.');
        if (!validCron(request, options.cronSecret ?? process.env.CRON_SECRET) && !await validBankWorkflow(request)) throw new ApiError(403, 'Доступ к банковскому планировщику запрещён.');
        if (url.searchParams.has('check')) throw new ApiError(404, 'Банковский маршрут не найден.');
        return write(response, 200, JSON.stringify(await dispatchBanks(operations, base.provenance.sourceSha256, options.bankEnvironment, options.bankRequest, options.sberRequest)));
      }
      if (bankWebhook) {
        if (request.method !== 'POST') throw new ApiError(405, 'Метод не поддерживается.');
        await banking.webhook('tbank-nk-artel', request.headers.authorization, await jsonBody(request, false, 65536));
        return write(response, 200, '{"received":true}');
      }
      if (pathname === '/api/banking/sber' || pathname.startsWith('/api/banking/sber/')) return sberRoutes(new SberService(operations, base.provenance.sourceSha256, options.bankEnvironment, options.sberRequest, sberConnections[pathname.startsWith('/api/banking/sber/sber-artel/') ? 'sber-artel' : 'sber-nk-artel']), request, response, url, () => jsonBody(request));
      if (pathname === '/api/banking' || pathname.startsWith('/api/banking/')) return bankingRoutes(banking, request, response, url, () => jsonBody(request));
      const config = options.pushConfig ?? pushConfig();
      if (cronRequest) {
        if (request.method !== 'GET') throw new ApiError(405, 'Метод не поддерживается.');
        const result = await dispatchReminders(operations, base.provenance.sourceSha256, config, options.pushSender ?? sendPush);
        return write(response, 200, JSON.stringify(result));
      }
      if (pushReceipt) {
        if (request.method !== 'POST') throw new ApiError(405, 'Метод не поддерживается.');
        limitPushReceipt(request.socket.remoteAddress ?? 'unknown');
        const body = await jsonBody(request, false, 1024);
        await mutatePushProbe(operations, base.provenance.sourceSha256, data => ({ result: null, changed: acceptPushProbeReceipt(data, body) }));
        return write(response, 200, '{"ok":true}');
      }
      const secure = options.secureCookies ?? !isLocalHost(request.headers.host);
      if (pathname.startsWith('/api/auth/')) {
        const passwordUserId = pathname.match(/^\/api\/auth\/users\/([^/]+)\/password$/)?.[1];
        if (passwordUserId) {
          if (request.method !== 'POST') throw new ApiError(405, 'Метод не поддерживается.');
          requireAccounts(requireUser(await operations.read(base.provenance.sourceSha256), request));
          const body = await jsonBody(request);
          if (Object.keys(body).some(key => key !== 'version') || !Number.isSafeInteger(body.version)) throw new ApiError(400, 'Передайте текущую версию пользователя.');
          const data = await operations.read(base.provenance.sourceSha256);
          requireAccounts(requireUser(data, request));
          const user = data.accounts?.users.find(row => row.id === decodeURIComponent(passwordUserId) && !row.deletedAt);
          if (!user) throw new ApiError(404, 'Пользователь не найден.');
          if (user.version !== body.version) throw new ApiError(409, 'Пользователь уже изменён. Обновите список.');
          return write(response, 200, JSON.stringify({ password: decryptAccountPassword(user, options.accountPasswordKey ?? process.env.ARTEL_ACCOUNT_PASSWORD_KEY) }));
        }
        const userId = pathname.match(/^\/api\/auth\/users\/([^/]+)$/)?.[1];
        if (request.method === 'GET' && pathname === '/api/auth/session') {
          const data = await operations.read(base.provenance.sourceSha256);
          return write(response, 200, JSON.stringify({ user: authenticate(data, request), needsSetup: !logistics && !data.accounts?.users.length, setupTokenRequired: !logistics && secure }));
        }
        if (request.method === 'GET' && pathname === '/api/auth/users') {
          const data = await operations.read(base.provenance.sourceSha256);
          const actor = requireUser(data, request);
          requireAccounts(actor);
          const users = (data.accounts?.users ?? []).filter(user => !user.deletedAt).map(user => ({ ...publicUser(user), passwordAvailable: !!user.passwordCiphertext }));
          const directories = currentSnapshot(base, data, false).directories!;
          const staff = { managers: directories.managers.map(({ id, name }) => ({ id, name })), drivers: directories.drivers.filter(driver => !directories.deletedEntries?.drivers?.includes(driver.id)).map(({ id, name }) => ({ id, name })) };
          return write(response, 200, JSON.stringify({users, currentUserId: actor.id, staff}));
        }
        if (request.method === 'POST' && pathname === '/api/auth/employees') {
          requireAccounts(requireUser(await operations.read(base.provenance.sourceSha256), request));
          const body = await jsonBody(request);
          if (Object.keys(body).some(key => key !== 'name')) throw new ApiError(400, 'Неизвестное поле сотрудника.');
          const result = await operations.mutate(base.provenance.sourceSha256, data => {
            requireAccounts(requireUser(data, request));
            const result = addDirectoryEntry({ kind: 'managers', name: body.name }, currentSnapshot(base, data), data);
            return { result, changed: result.created };
          });
          return write(response, result.created ? 201 : 200, JSON.stringify(result));
        }
        const allowedAuth = request.method === 'POST' && ['/api/auth/setup','/api/auth/login','/api/auth/logout','/api/auth/users'].includes(pathname) || ['PATCH', 'DELETE'].includes(request.method ?? '') && !!userId;
        if (!allowedAuth) throw new ApiError(405,'Метод не поддерживается.');
        const body = await jsonBody(request);
        const result = await operations.mutate<{status:number;token?:string;user?:AccountUser;error?:string}>(base.provenance.sourceSha256, async data => {
          if(pathname === '/api/auth/login')return { result: await login(data,body,logistics ? 'logistics' : undefined), changed:true };
          if(pathname === '/api/auth/setup') {
            if(data.accounts?.users.length)throw new ApiError(409,'Директор уже создан. Выполните вход.');
            const setupToken=options.setupToken ?? process.env.ARTEL_SETUP_TOKEN;
            if(secure && (!setupToken || body.setupToken !== setupToken))throw new ApiError(403,'Для первоначальной настройки нужен серверный ключ настройки.');
            await saveUser(data,currentSnapshot(base,data),body,undefined,true,options.accountPasswordKey);
            return { result:await login(data,body),changed:true };
          }
          const actor=requireUser(data,request);
          if(pathname === '/api/auth/logout'){
            if (!logistics && data.push) data.push.devices = data.push.devices.filter(device => device.sessionHash !== pushSessionHash(request) && !(device.userId === actor.id && device.endpoint === body.pushEndpoint));
            logout(data,request);return {result:{status:200,token:''},changed:true};
          }
          requireAccounts(actor);
          if (request.method === 'DELETE' && userId) {
            const { changed, ...deleted } = deleteUser(data, actor, decodeURIComponent(userId), body);
            return { result: { status: 200, ...deleted }, changed };
          }
          return {result:{status:userId?200:201,user:await saveUser(data,currentSnapshot(base,data),body,userId?decodeURIComponent(userId):undefined,false,options.accountPasswordKey)},changed:true};
        });
        if ('token' in result && typeof result.token === 'string') response.setHeader('Set-Cookie',sessionCookie(result.token,secure,logistics ? 'logistics' : undefined));
        const {token:_token,...safeResult}=result as typeof result & {token?:string};
        return write(response,result.status,JSON.stringify(safeResult));
      }
      const driverAccessMatch = pathname.match(/^\/api\/drivers\/([^/]+)\/access$/);
      if (driverAccessMatch) {
        if (!['GET', 'POST', 'PATCH'].includes(request.method ?? '')) throw new ApiError(405, 'Метод не поддерживается.');
        const driverId = decodeURIComponent(driverAccessMatch[1]);
        if (request.method === 'GET') {
          const data = await operations.read(base.provenance.sourceSha256);
          requireAccounts(requireUser(data, request));
          return write(response, 200, JSON.stringify({ access: readDriverAccess(data, currentSnapshot(base, data, false), driverId) }));
        }
        const body = await jsonBody(request);
        const result = await operations.mutate(base.provenance.sourceSha256, async data => {
          requireAccounts(requireUser(data, request));
          const { changed, ...result } = await mutateDriverAccess(data, currentSnapshot(base, data, false), driverId, request.method!, body, options.accountPasswordKey);
          return { result, changed };
        });
        return write(response, 200, JSON.stringify(result));
      }
      if (pathname.startsWith('/api/driver/')) {
        const match = pathname.match(/^\/api\/driver\/trips(?:\/([^/]+))?(?:\/(arrive|depart))?$/);
        const data = await operations.read(base.provenance.sourceSha256);
        const user = requireUser(data, request);
        requireDriverRoute(user, pathname, request.method ?? '');
        if (!match) throw new ApiError(404, 'Маршрут не найден.');
        if (request.method === 'POST' && match[1] && match[2]) {
          const body = await jsonBody(request);
          const result = await operations.mutate(base.provenance.sourceSha256, fresh => {
            const actor = requireUser(fresh, request);
            requireDriverRoute(actor, pathname, request.method!);
            const action = recordDriverTripAction(base, fresh, actor, decodeURIComponent(match[1]), match[2] as 'arrive' | 'depart', body);
            return { ...action, result: { value: action.result, continueWorkflow: match[2] === 'depart' && action.changed } };
          });
          write(response, 200, JSON.stringify(result.value));
          if (result.continueWorkflow && options.sabyWorkflowMonitoringEnabled) {
            try { options.requestSabyWorkflow?.(decodeURIComponent(match[1])); }
            catch { /* The durable departure will be picked up by the next scheduled scan. */ }
          }
          return;
        }
        if (request.method !== 'GET' || match[2]) throw new ApiError(405, 'Метод не поддерживается.');
        return write(response, 200, JSON.stringify(readDriverTrips(currentSnapshot(base, data, false), user, match[1] ? decodeURIComponent(match[1]) : undefined, url.searchParams.get('q') ?? '', data)));
      }
      const authorized = (data: import('./operations-store').OperationsData) => {
        const user = requireUser(data, request);
        requireDriverRoute(user, pathname, request.method ?? '');
        if (logistics) requireTripSection(user, true);
        if (/^\/api\/shipment-trips(\/|$)/.test(pathname)) requireTripSection(user, /\/(saby|saby-workflow|etrn)(\/|$)/.test(pathname) || pathname === '/api/shipment-trips' && request.method === 'GET');
        const section = apiSection(pathname);
        if (section && !(user.role === 'driver' && pathname.startsWith('/api/push/')) && !(logistics && pathname === '/api/directories' && request.method === 'GET')) requireSection(user, section);
        return user;
      };
      const actor = authEnabled ? authorized(await operations.read(base.provenance.sourceSha256)) : null;
      if (pathname === '/api/operator' || pathname.startsWith('/api/operator/')) {
        // This workspace always requires a real active account, including local mode.
        const match = pathname.match(/^\/api\/operator(?:\/(recipients|refuellings)(?:\/([a-f0-9-]{36})(?:\/(payment|archive))?)?)?$/);
        if (!match) throw new ApiError(404, 'Маршрут не найден.');
        if (request.method === 'GET' && !match[1]) {
          const stored = await operations.read(base.provenance.sourceSha256);
          return write(response, 200, JSON.stringify(readOperator(stored, authorized(stored))));
        }
        if (!match[1] || request.method !== (match[2] ? 'PATCH' : 'POST')) throw new ApiError(405, 'Метод не поддерживается.');
        const body = await jsonBody(request, false, 16384);
        const saved = await operations.mutate(base.provenance.sourceSha256, stored => mutateOperator(stored, authorized(stored), match[1] as 'recipients' | 'refuellings', body, match[2], match[3] as 'payment' | 'archive' | undefined));
        return write(response, match[2] || saved.replayed ? 200 : 201, JSON.stringify(saved));
      }
      const tripRequestMatch = pathname.match(/^\/api\/trip-requests(?:\/([^/]+))?$/);
      if (tripRequestMatch) {
        const id = tripRequestMatch[1] ? decodeURIComponent(tripRequestMatch[1]) : undefined;
        if (id === 'map-config') {
          if (request.method !== 'GET') throw new ApiError(405, 'Метод не поддерживается.');
          return write(response, 200, JSON.stringify(readTripRequestsMapConfig(options.yandexTilesEnvironment)));
        }
        if (id === 'geocode') {
          if (request.method !== 'POST') throw new ApiError(405, 'Метод не поддерживается.');
          const body = await jsonBody(request, false, 2048);
          const { fingerprint, retry, version, ...identity } = body;
          if (version !== undefined && (!Number.isSafeInteger(version) || Number(version) < 0)) throw new ApiError(400, 'Некорректная версия поиска адреса.');
          if (retry !== undefined && retry !== true) throw new ApiError(400, 'Некорректный запрос повтора поиска адреса.');
          if (fingerprint !== undefined && (typeof fingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(fingerprint))) throw new ApiError(400, 'Некорректный идентификатор поиска адреса.');
          const stored = await operations.read(base.provenance.sourceSha256);
          const target = tripRequestGeocodeTarget(stored, currentSnapshot(base, stored, false), actor ? authorized(stored) : null, identity);
          if (version !== undefined && version !== target.version) throw new ApiError(409, 'Заявка или площадка изменена. Обновите данные и повторите поиск.');
          const currentFingerprint = createHash('sha256').update(target.fingerprint).digest('hex');
          if (fingerprint !== undefined && fingerprint !== currentFingerprint) throw new ApiError(409, 'Заявка или площадка изменена. Обновите данные и повторите поиск.');
          // Provider latency must never hold the business-store mutation lock.
          const location = target.location ?? await locations.poll(target.address, 5000, retry === true);
          const fresh = await operations.read(base.provenance.sourceSha256);
          const latest = tripRequestGeocodeTarget(fresh, currentSnapshot(base, fresh, false), actor ? authorized(fresh) : null, identity);
          if (latest.fingerprint !== target.fingerprint) throw new ApiError(409, 'Заявка или площадка изменена. Обновите данные и повторите поиск.');
          return write(response, 200, JSON.stringify(location.status === 'pending' ? { ...location, fingerprint: currentFingerprint } : location));
        }
        if (!id && request.method === 'GET') {
          const stored = await operations.read(base.provenance.sourceSha256);
          const currentActor = actor ? authorized(stored) : null;
          const snapshot = currentSnapshot(base, stored, false);
          const catalog = tripRequestCatalog(snapshot);
          const requests = await Promise.all(listTripRequests(stored, snapshot, currentActor).map(async row => {
            const target = tripRequestGeocodeTarget(stored, snapshot, currentActor, { requestId: row.id });
            return { ...row, location: target.location ?? await locations.read(target.address) };
          }));
          const addresses = await Promise.all(catalog.addresses.map(async row => ({ ...row, location: tripRequestExplicitCoordinates(row) ?? await locations.read(row.address) })));
          // An initial GET reads the local projection only. Legacy active requests backfill once,
          // without holding the response, fetching every directory row, or rewriting their versions.
          for (const row of requests) if (row.location.status === 'pending') void locations.resolve(row.address, 'background').catch(() => undefined);
          return write(response, 200, JSON.stringify({ requests, ...catalog, addresses }));
        }
        if (!(id ? ['PATCH', 'DELETE'] : ['POST']).includes(request.method ?? '')) throw new ApiError(405, 'Метод не поддерживается.');
        const body = await jsonBody(request, request.method === 'DELETE');
        const saved = await operations.mutate<Record<string, unknown>>(base.provenance.sourceSha256, async data => {
          const currentActor = actor ? authorized(data) : null;
          const snapshot = currentSnapshot(base, data, false);
          if (request.method === 'DELETE') return { result: cancelTripRequest(data, snapshot, currentActor, id!, body), changed: true };
          const place = !id && snapshot.directories?.addresses.find(row => row.id === body.addressId && row.companyId === body.companyId && row.kind === 'delivery');
          const known = place ? await locations.read(typeof body.address === 'string' ? body.address : place.address || place.name) : null;
          const result = saveTripRequest(data, snapshot, currentActor, body, id, known?.status === 'found' ? known : undefined);
          const target = result.request.status === 'active' ? tripRequestGeocodeTarget(data, snapshot, currentActor, { requestId: result.request.id }) : { address: result.request.address, location: tripRequestExplicitCoordinates(result.request) };
          return { result: { request: { ...result.request, location: target.location ?? await locations.read(target.address) }, created: result.created }, changed: result.changed };
        });
        const savedRequest = saved.request as import('../web/src/trip-request-model').TripRequest | undefined;
        if (savedRequest?.status === 'active' && savedRequest.location?.status === 'pending') void locations.resolve(savedRequest.address, 'background').catch(() => undefined);
        return write(response, request.method === 'POST' ? 201 : 200, JSON.stringify(saved));
      }
      if (logistics && pathname === '/api/context') {
        const stored = await operations.read(base.provenance.sourceSha256);
        return write(response, 200, JSON.stringify(logisticsContext(currentSnapshot(base, stored), authorized(stored))));
      }
      if (pathname === '/api/settlements') {
        if (request.method !== 'GET') throw new ApiError(405, 'Метод не поддерживается.');
        const stored = await operations.read(base.provenance.sourceSha256);
        const snapshot = currentSnapshot(base, stored, false);
        const report = buildSettlements(snapshot.shipments, snapshot.companies, stored).report;
        const currentActor = actor ? authorized(stored) : null;
        const scoped = currentActor ? scopeSettlements(report, snapshot, currentActor) : { ...includeIdleCustomers(report, snapshot), scope: 'all' };
        const { organizations } = buildOrganizationSettlements(snapshot.shipments, snapshot.companies, stored);
        return write(response, 200, JSON.stringify({ ...scoped, ...organizationSettlementsForActor(organizations, snapshot, currentActor) }));
      }
      if (pathname.startsWith('/api/push/')) {
        if (!actor) throw new ApiError(401, 'Войдите в приложение.');
        if (pathname === '/api/push/config' && request.method === 'GET') {
          const data = await operations.read(base.provenance.sourceSha256);
          return write(response, 200, JSON.stringify({ enabled: pushReady(config), publicKey: config.publicKey, lastRunAt: data.push?.lastRunAt ?? null, intervalSeconds: options.pushIntervalSeconds ?? 300 }));
        }
        if (pathname === '/api/push/test-status') {
          if (request.method !== 'GET') throw new ApiError(405, 'Метод не поддерживается.');
          const data = await operations.read(base.provenance.sourceSha256);
          return write(response, 200, JSON.stringify(readPushProbe(data, url.searchParams.get('probeId'), authorized(data).id)));
        }
        if (pathname !== '/api/push/subscription' && pathname !== '/api/push/test') throw new ApiError(404, 'Маршрут не найден.');
        if (request.method !== 'POST' && !(pathname === '/api/push/subscription' && request.method === 'DELETE')) throw new ApiError(405, 'Метод не поддерживается.');
        if (request.method !== 'DELETE' && !pushReady(config)) throw new ApiError(503, 'Отправка уведомлений ещё не настроена.');
        const body = await jsonBody(request, false, 8192);
        if (pathname === '/api/push/test') {
          const { device, probeId, token } = await mutatePushProbe(operations, base.provenance.sourceSha256, data => {
            const user = authorized(data);
            const device = data.push?.devices.find(device => device.userId === user.id && device.endpoint === body.endpoint);
            if (!device) throw new ApiError(404, 'Сначала включите уведомления на этом устройстве.');
            if (device.testAt && Date.now() - device.testAt < 30000) throw new ApiError(429, 'Повторную проверку можно отправить через 30 секунд.');
            device.testAt = Date.now();
            return { result: { device: { ...device }, ...createPushProbe(data, device) }, changed: true };
          });
          try {
            await (options.pushSender ?? sendPush)(device, JSON.stringify({ title: 'Артэль CRM', body: 'Проверка уведомлений. Устройство создало это уведомление.', tag: `artel-push-test-${probeId}`, url: actor.role === 'driver' ? '/#driver-trips' : '/#work', probe: { id: probeId, token } }), config);
          } catch (error) {
            const received = (await operations.read(base.provenance.sourceSha256)).push?.probes?.[probeId]?.notificationCreatedAt;
            // A browser receipt is stronger evidence than a sender timeout after delivery.
            if (received !== undefined) return write(response, 200, JSON.stringify({ ok: true, probeId }));
            if ([404, 410].includes((error as {statusCode: number}).statusCode)) {
              await operations.mutate(base.provenance.sourceSha256, data => ({ result: null, changed: unsubscribe(data, device.endpoint, device.userId) }));
              throw new ApiError(410, 'Подписка истекла. Выключите и снова включите уведомления.');
            }
            throw new ApiError(502, 'Сервис уведомлений недоступен. Повторите проверку позже.');
          }
          try {
            await mutatePushProbe(operations, base.provenance.sourceSha256, data => ({ result: null, changed: markPushProbeAccepted(data, probeId) }));
          } catch {
            console.error('Проверка уведомления отправлена. Не удалось сохранить результат сервиса; подтверждение устройства доступно по номеру проверки.');
          }
          return write(response, 200, JSON.stringify({ ok: true, probeId }));
        } else {
          await operations.mutate(base.provenance.sourceSha256, data => {
            const user = authorized(data);
            const changed = request.method === 'DELETE' ? unsubscribe(data, body.endpoint, user.id) : subscribe(data, body.subscription, user.id, pushSessionHash(request));
            return { result: null, changed };
          });
        }
        return write(response, 200, '{"ok":true}');
      }
      if (pathname === '/api/directories/reconcile-customers') {
        const data = await operations.read(base.provenance.sourceSha256);
        requireManage(authorized(data));
        if (request.method === 'GET') return write(response, 200, JSON.stringify(planCustomerReconciliation(base, data)));
        if (request.method !== 'POST') throw new ApiError(405, 'Метод не поддерживается.');
        const body = await jsonBody(request);
        if (Object.keys(body).some(key => !['revision', 'fingerprint'].includes(key)) || !Number.isSafeInteger(body.revision) || typeof body.fingerprint !== 'string') throw new ApiError(400, 'Сначала выполните предварительную сверку.');
        const result = await reconcileCustomers(operations, base, { revision: body.revision as number, fingerprint: body.fingerprint }, current => requireManage(authorized(current)));
        return write(response, 200, JSON.stringify(result));
      }
      if (pathname === '/api/directories/cleanup') {
        const stored = await operations.read(base.provenance.sourceSha256);
        requireManage(authorized(stored));
        if (request.method === 'GET') {
          try {
            const preview = url.searchParams.get('scope') === 'companies' ? prepareCompanyCleanup(base, stored) : prepareDirectoryCleanup(base, stored);
            return write(response, 200, JSON.stringify({ counts: preview.counts, revision: stored.revision, available: !!operations.backup }));
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) return write(response, 200, JSON.stringify({ blocked: error.message, revision: stored.revision, available: false }));
            throw error;
          }
        }
        if (request.method !== 'POST') throw new ApiError(405, 'Метод не поддерживается.');
        const body = await jsonBody(request);
        if (body.confirm !== 'clear-directories' || body.scope !== undefined && body.scope !== 'companies' || Object.keys(body).some(key => !['confirm','revision','scope'].includes(key))) throw new ApiError(400, 'Подтвердите очистку справочников.');
        if (!operations.backup) throw new ApiError(503, 'Резервное копирование недоступно. Очистка запрещена.');
        const result = await operations.mutate(base.provenance.sourceSha256, async data => {
          requireManage(authorized(data));
          if (body.revision !== data.revision) throw new ApiError(409, 'Данные изменены. Откройте предварительную проверку заново.');
          const prepared = body.scope === 'companies' ? prepareCompanyCleanup(base, data) : prepareDirectoryCleanup(base, data);
          const backup = await operations.backup!(data);
          data.companies = prepared.data.companies;
          data.directories = prepared.data.directories;
          return { result: { counts: prepared.counts, backup }, changed: true };
        });
        return write(response, 200, JSON.stringify(result));
      }
      const chinaMatch = pathname.match(/^\/api\/china\/(days|payments)(?:\/([^/]+))?$/);
      if (pathname === '/api/china' || chinaMatch) {
        if (!actor) throw new ApiError(401, 'Войдите в приложение.');
        if (pathname === '/api/china' && request.method === 'GET') {
          const data = await operations.read(base.provenance.sourceSha256);
          requireManage(authorized(data));
          return write(response, 200, JSON.stringify({ china: data.china ?? emptyChina(), suppliers: currentSnapshot(base, data).companies.filter(company => company.roles.includes('supplier')) }));
        }
        if (!chinaMatch || (chinaMatch[2] ? request.method !== 'PATCH' : request.method !== 'POST')) throw new ApiError(405, 'Метод не поддерживается.');
        const body = await jsonBody(request);
        const result = await operations.mutate(base.provenance.sourceSha256, data => {
          const result = mutateChina(data, currentSnapshot(base, data), authorized(data), chinaMatch[1], body, chinaMatch[2] ? decodeURIComponent(chinaMatch[2]) : undefined);
          return { result, changed: result.changed };
        });
        return write(response, result.created ? 201 : 200, JSON.stringify(result));
      }
      const fileMatch = pathname.match(/^\/api\/work\/(tasks|companies)\/([^/]+)\/files\/([^/]+)$/);
      if (fileMatch) {
        if (request.method !== 'GET') throw new ApiError(405, 'Метод не поддерживается.');
        const data = await operations.read(base.provenance.sourceSha256);
        const file = workFile(data, fileMatch[1], decodeURIComponent(fileMatch[2]), decodeURIComponent(fileMatch[3]), authorized(data));
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(Buffer.from(file.data!, 'base64')); return;
      }
      const workMatch = pathname.match(/^\/api\/work\/(tasks|companies|notes)(?:\/([^/]+))?$/);
      if(pathname === '/api/work' || workMatch){
        if(!actor)throw new ApiError(401,'Войдите в приложение.');
        if(pathname === '/api/work' && request.method === 'GET'){
          const data=await operations.read(base.provenance.sourceSha256);
          const currentActor = authorized(data);
          return write(response,200,JSON.stringify(readWork(data,scopeSnapshot(currentSnapshot(base,data),currentActor,'work',workCompanyIds(data,currentActor)),url.searchParams,currentActor,activeUsers(data))));
        }
        if(!workMatch)throw new ApiError(405,'Метод не поддерживается.');
        const body=await jsonBody(request, false, 3 * 1024 * 1024);
        const result=await operations.mutate(base.provenance.sourceSha256,data=>{
          const currentActor=authorized(data);
          const result=mutateWork(data,scopeSnapshot(currentSnapshot(base,data),currentActor,'work',workCompanyIds(data,currentActor)),workMatch[1],body,workMatch[2]?decodeURIComponent(workMatch[2]):undefined,request.method??'',currentActor,activeUsers(data));
          return {result,changed:result.changed};
        });
        if (workMatch[1] === 'tasks' && result.entry && pushReady(config)) {
          // Await the attempt within the request so serverless runtimes do not drop it.
          // The saved event remains available to the scheduler if delivery fails.
          try { await dispatchTaskAssignments(operations, base.provenance.sourceSha256, config, options.pushSender ?? sendPush, Date.now(), result.entry.id); }
          catch { console.error('Задача сохранена. Не удалось отправить уведомление о назначении; планировщик повторит попытку.'); }
        }
        return write(response,result.created?201:200,JSON.stringify(result));
      }
      const workflowMatch = pathname.match(/^\/api\/shipment-trips\/([^/]+)\/saby-workflow(?:\/(start|loading-facts|carrier-details|signing|signing\/start))?$/);
      if (workflowMatch) {
        const tripId = decodeURIComponent(workflowMatch[1]);
        const authorize = (snapshot: Snapshot, data: import('./operations-store').OperationsData) => { if (actor) requireWholeTrip(authorized(data), snapshot, tripId); };
        const context = { base, store: operations, tripId, authorize, client: options.sabyClient };
        const data = await operations.read(base.provenance.sourceSha256); authorize(currentSnapshot(base, data), data);
        const read = (latest: import('./operations-store').OperationsData) => ({ ...getTripSabyWorkflow({ base, data: latest, tripId, prepare: prepareTripSaby, config: options.sabyClient?.config, monitoringEnabled: options.sabyWorkflowMonitoringEnabled, actorId: actor?.id }), driverConfirmation: driverTripConfirmation(currentSnapshot(base, latest, false), latest, tripId), loadingFacts: latest.etrn?.trips[tripId]?.loadingFacts ? { arrivedAt: latest.etrn.trips[tripId].loadingFacts!.arrivedAt, departedAt: latest.etrn.trips[tripId].loadingFacts!.departedAt, deliveries: latest.etrn.trips[tripId].loadingFacts!.deliveries } : null });
        if (request.method === 'GET' && workflowMatch[2] === 'signing') return write(response, 200, JSON.stringify(await getTripSigningPreview(context)));
        if (workflowMatch[2] === 'signing') throw new ApiError(405, 'Метод не поддерживается.');
        if (request.method === 'GET' && !workflowMatch[2]) return write(response, 200, JSON.stringify(read(data)));
        if (request.method !== 'POST') throw new ApiError(405, 'Метод не поддерживается.');
        const body = await jsonBody(request);
        if (workflowMatch[2] === 'start') {
          if (!actor) throw new ApiError(403, 'Войдите под своей учётной записью для запуска обмена.');
          if (Object.keys(body).length !== 2 || !['draft', 'sign_and_send'].includes(String(body.mode)) || typeof body.previewToken !== 'string' || !/^[a-f0-9]{64}$/.test(body.previewToken)) throw new ApiError(400, 'Обновите состояние рейса перед запуском обмена.');
          const signingConfig = options.sabyClient?.config ?? sabyConfigFromEnv();
          const queued = await operations.mutate(base.provenance.sourceSha256, latest => {
            const currentActor = authorized(latest);
            startAutomaticTripSaby({ base, data: latest, tripId, actorId: currentActor.id, config: signingConfig, previewToken: body.previewToken as string, mode: body.mode as 'draft' | 'sign_and_send' });
            return { result: read(latest), changed: true };
          });
          // Only a newly committed intent schedules work. Replays fail before this point;
          // an unavailable provider cannot turn the durable enqueue into a failed request.
          write(response, 202, JSON.stringify(queued));
          if (options.requestSabyWorkflow) {
            try { options.requestSabyWorkflow(tripId); }
            catch { /* The scheduler will discover the already committed intent. */ }
          } else {
            void runTripSabyWorkflow({ ...context, monitoringEnabled: options.sabyWorkflowMonitoringEnabled, prepare: prepareTripSaby,
              createDelivery: (input, guardedClient) => exchangePreparedEtrn({ ...context, client: guardedClient }, input) })
              .catch(() => { /* Failure details remain in durable workflow state. */ });
          }
          return;
        }
        let signingStart: import('./trip-saby-workflow').RunTripSabyOptions['signingStart'];
        if (workflowMatch[2] === 'signing/start') {
          if (!actor) throw new ApiError(403, 'Войдите под своей учётной записью для подписания.');
          validateSigningStart(body); signingStart = { request: body, requestedBy: actor.id };
        } else if (workflowMatch[2] === 'loading-facts') await saveTripLoadingFacts(context, body, actor?.id || 'local-operator');
        else if (Object.keys(body).length) throw new ApiError(400, 'Данные отправки берутся из сохранённого рейса.');
        const workflow = await runTripSabyWorkflow({ ...context, signingStart, allowSigningRecovery: !workflowMatch[2] && !!actor, initiatorId: actor?.id, enableCarrierFill: workflowMatch[2] === 'carrier-details', prepare: prepareTripSaby, createDelivery: (input, guardedClient) => exchangePreparedEtrn({ ...context, client: guardedClient }, input) });
        if (workflow.phase === 'completed') for (const delivery of workflow.deliveries) if (delivery.id) await refreshTripSabyDelivery(context, delivery.shipmentId);
        const latest = await operations.read(base.provenance.sourceSha256); authorize(currentSnapshot(base, latest), latest);
        return write(response, 200, JSON.stringify(read(latest)));
      }
      const etrnMatch = pathname.match(/^\/api\/shipment-trips\/([^/]+)\/etrn(?:\/(submit|refresh)|\/xml\/([^/]+)|\/files\/([^/]+)\/([^/]+))?$/);
      if (etrnMatch) {
        const tripId = decodeURIComponent(etrnMatch[1]);
        const authorize = (snapshot: Snapshot, data: import('./operations-store').OperationsData) => {
          if (actor) requireWholeTrip(authorized(data), snapshot, tripId);
        };
        const context = { base, store: operations, tripId, authorize, client: options.sabyClient };
        if (request.method === 'GET' && !etrnMatch[2]) {
          const data = await operations.read(base.provenance.sourceSha256);
          authorize(currentSnapshot(base, data), data);
          if (!etrnMatch[3] && !etrnMatch[4]) return write(response, 200, JSON.stringify(getEtrnTrip(base, data, tripId, options.sabyClient?.config)));
          const file = etrnMatch[3]
            ? (() => { const value = preparedEtrnXml(base, data, tripId, decodeURIComponent(etrnMatch[3]), options.sabyClient?.config); return { bytes: value.xml, name: value.name, extension: 'xml' }; })()
            : await downloadEtrnFile(context, decodeURIComponent(etrnMatch[4]), decodeURIComponent(etrnMatch[5]));
          response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Cross-Origin-Resource-Policy': 'same-origin', 'Content-Disposition': `attachment; filename="etrn.${/^[a-z0-9]{1,8}$/i.test(file.extension) ? file.extension : 'bin'}"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}` });
          return response.end(file.bytes);
        }
        if (request.method === 'PUT' && !etrnMatch[2] && !etrnMatch[3] && !etrnMatch[4]) {
          const body = await jsonBody(request);
          if (Object.keys(body).some(key => !['shipmentId', 'profile'].includes(key)) || typeof body.shipmentId !== 'string') throw new ApiError(400, 'Укажите доставку и сведения ЭТрН.');
          return write(response, 200, JSON.stringify(await saveEtrnProfile(context, body.shipmentId, body.profile)));
        }
        if (request.method === 'POST' && etrnMatch[2]) {
          const body = await jsonBody(request);
          if (Object.keys(body).some(key => key !== 'shipmentId') || typeof body.shipmentId !== 'string') throw new ApiError(400, 'Выберите доставку для ЭТрН.');
          return write(response, 200, JSON.stringify(await exchangeEtrn(context, body.shipmentId, etrnMatch[2] === 'refresh')));
        }
        throw new ApiError(405, 'Метод не поддерживается.');
      }
      const sabyTripMatch = pathname.match(/^\/api\/shipment-trips\/([^/]+)\/saby$/);
      if (sabyTripMatch) {
        if (!['GET', 'POST'].includes(request.method ?? '')) throw new ApiError(405, 'Метод не поддерживается.');
        const tripId = decodeURIComponent(sabyTripMatch[1]);
        const authorize = (snapshot: Snapshot, data: import('./operations-store').OperationsData) => {
          if (actor) requireWholeTrip(authorized(data), snapshot, tripId);
        };
        if (request.method === 'GET') {
          const data = await operations.read(base.provenance.sourceSha256);
          authorize(currentSnapshot(base, data), data);
          return write(response, 200, JSON.stringify(getSabyTrip(base, data, tripId, options.sabyClient?.config)));
        }
        const body = await jsonBody(request);
        if (Object.keys(body).length) throw new ApiError(400, 'Данные передачи берутся из сохранённого рейса.');
        const result = await submitSabyTrip({ base, store: operations, tripId, authorize, client: options.sabyClient });
        return write(response, 200, JSON.stringify(result));
      }
      const shipmentIdMatch = pathname.match(/^\/api\/shipments\/([^/]+)$/);
      const directoryMatch = pathname.match(/^\/api\/directories\/([^/]+)\/([^/]+)$/);
      const tripIdMatch = pathname.match(/^\/api\/shipment-trips\/([^/]+)$/);
      if (!['/api/snapshot', '/api/shipments', '/api/shipment-trips', '/api/directories', '/api/companies/from-inn', '/api/companies/lookup'].includes(pathname) && !shipmentIdMatch && !tripIdMatch && !directoryMatch) throw new ApiError(404, 'Маршрут не найден.');
      const allowed = directoryMatch ? ['PATCH','DELETE'] : pathname === '/api/snapshot' ? ['GET'] : tripIdMatch ? ['GET', 'PATCH', 'DELETE'] : pathname === '/api/shipment-trips' ? ['GET', 'POST'] : ['/api/companies/from-inn', '/api/companies/lookup'].includes(pathname) ? ['POST'] : shipmentIdMatch ? ['GET', 'PATCH', 'DELETE'] : ['GET', 'POST'];
      if (!allowed.includes(request.method ?? '')) throw new ApiError(405, 'Метод не поддерживается для этого маршрута.');
      if (request.method === 'GET') {
        const stored = await operations.read(base.provenance.sourceSha256);
        const fullSnapshot = currentSnapshot(base, stored);
        const snapshot = actor ? scopeSnapshot(fullSnapshot, authorized(stored)) : fullSnapshot;
        if (pathname === '/api/directories') return write(response, 200, JSON.stringify(logistics ? logisticsContext(fullSnapshot, authorized(stored)) : { directories: snapshot.directories, companies: snapshot.companies }));
        if (pathname === '/api/snapshot') {
          if (url.searchParams.get('shipments') === 'omit') snapshot.shipments = [];
          return write(response, 200, JSON.stringify(snapshot));
        }
        if (pathname === '/api/shipment-trips') {
          const numbers = readTripNumbers(fullSnapshot, stored);
          const currentActor = actor ? authorized(stored) : null;
          const trips = [...new Set(snapshot.shipments.map(row => row.fields.trip_id).filter((id): id is string => !!id))].filter(id => {
            try { if (currentActor) requireWholeTrip(currentActor, fullSnapshot, id); return true; } catch { return false; }
          }).map(id => getShipmentTrip(snapshot, id, numbers)).sort((a,b) => (b.fields.date ?? '').localeCompare(a.fields.date ?? '') || a.id.localeCompare(b.id));
          const automation = automaticSigningCapability(options.sabyClient?.config ?? sabyConfigFromEnv());
          return write(response, 200, JSON.stringify({ trips, automation }));
        }
        if (tripIdMatch) {
          const id = decodeURIComponent(tripIdMatch[1]);
          if (actor) requireWholeTrip(authorized(stored), fullSnapshot, id);
          return write(response, 200, JSON.stringify({ trip: getShipmentTrip(snapshot, id, readTripNumbers(fullSnapshot, stored)), shipment: snapshot.shipments.find(row => row.fields.trip_id === id) }));
        }
        if (shipmentIdMatch) {
          const shipment = snapshot.shipments.find(row => row.id === decodeURIComponent(shipmentIdMatch[1]));
          if (!shipment) throw new ApiError(404, 'Операция не найдена.');
          return write(response, 200, JSON.stringify({ shipment }));
        }
        return write(response, 200, JSON.stringify(shipmentPage(snapshot, url.searchParams)));
      }
      const body = await jsonBody(request, request.method === 'DELETE');
      if (logistics) requireLogisticsDirectoryInput(pathname, body);
      if(actor && (pathname.startsWith('/api/directories') || pathname.startsWith('/api/companies') || request.method==='DELETE'))requireManage(actor);
      if (pathname === '/api/directories' || directoryMatch) {
        const savedAddresses: string[] = [];
        const result = await operations.mutate(base.provenance.sourceSha256, data => {
          if(actor)requireManage(authorized(data));
          const snapshot = currentSnapshot(base, data);
          if (logistics) requireLogisticsDirectoryTarget(pathname, body, snapshot, authorized(data));
          const result = directoryMatch && request.method === 'DELETE' ? deleteDirectoryEntry(directoryMatch[1],decodeURIComponent(directoryMatch[2]),body,snapshot,data) : directoryMatch
            ? directoryMatch[1] === 'companies'
              ? saveCompany(body, snapshot, data, decodeURIComponent(directoryMatch[2]))
              : updateDirectoryEntry(directoryMatch[1], decodeURIComponent(directoryMatch[2]), body, snapshot, data)
            : body.kind === 'companies' ? saveCompany(body, snapshot, data) : addDirectoryEntry(body, snapshot, data);
          const updated = currentSnapshot(base, data);
          for (const row of updated.directories?.addresses ?? []) {
            const previous = snapshot.directories?.addresses.find(value => value.id === row.id && value.companyId === row.companyId);
            if (row.kind === 'delivery' && !tripRequestExplicitCoordinates(row) && (!previous || (previous.address || previous.name) !== (row.address || row.name))) savedAddresses.push(row.address || row.name);
          }
          // A successful company POST can restore a historical ID or add a role
          // without creating a new entity. Its changes must still be committed.
          return { result, changed: !!directoryMatch || body.kind === 'companies' || result.created };
        });
        for (const address of new Set(savedAddresses)) void locations.resolve(address, 'background').catch(() => undefined);
        const safeResult = logistics && 'entry' in result && (pathname === '/api/directories' ? body.kind === 'companies' : directoryMatch?.[1] === 'companies') ? { ...result, entry: logisticsCompany(result.entry as Company) } : result;
        return write(response, result.created ? 201 : 200, JSON.stringify(safeResult));
      }
      if (pathname === '/api/companies/lookup') {
        if (Object.keys(body).some(key=>key!=='inn') || typeof body.inn !== 'string' || !validInn(body.inn.trim())) throw new ApiError(400, 'Укажите корректный ИНН.');
        const company = await lookupCheckoCompany(body.inn.trim(), options.checkoApiKey ?? process.env.CHECKO_API_KEY, options.fetcher);
        return write(response, 200, JSON.stringify({ company: logistics ? logisticsCompany(company) : company }));
      }
      if (pathname === '/api/companies/from-inn') {
        if (Object.keys(body).some(key => key !== 'inn') || typeof body.inn !== 'string' || !validInn(body.inn.trim())) throw new ApiError(400, 'Укажите корректный ИНН из 10 или 12 цифр с верными контрольными цифрами.');
        const inn = body.inn.trim();
        const existing = currentSnapshot(base, await operations.read(base.provenance.sourceSha256)).companies.find(company => company.inn === inn);
        if (existing) return write(response, 200, JSON.stringify({ company: existing, created: false }));
        const found = await lookupCheckoCompany(inn, options.checkoApiKey ?? process.env.CHECKO_API_KEY, options.fetcher);
        const result = await operations.mutate(base.provenance.sourceSha256, data => {
          if(actor)requireManage(authorized(data));
          const snapshot = currentSnapshot(base, data);
          const duplicate = snapshot.companies.find(company => company.inn === inn);
          if (duplicate) return { result: { company: duplicate, created: false }, changed: false };
          if (snapshot.companies.some(company => !company.inn && [found.name, found.fullName].filter(Boolean).some(name => normalizeName(company.name) === normalizeName(name!)))) throw new ApiError(409, 'В справочнике уже есть такое название без ИНН. Сначала сверьте существующую фирму; новая запись не создана.');
          // A matching display name does not prove identity. Legacy entries without INN stay separate.
          data.companies.push(found);
          return { result: { company: found, created: true }, changed: true };
        });
        return write(response, result.created ? 201 : 200, JSON.stringify(result));
      }
      if (pathname === '/api/shipment-trips' || tripIdMatch) {
        const id = tripIdMatch ? decodeURIComponent(tripIdMatch[1]) : undefined;
        const signingConfig = options.sabyClient?.config ?? sabyConfigFromEnv();
        const saved = request.method === 'DELETE'
          ? await operations.mutate(base.provenance.sourceSha256, data => {if(actor)requireManage(authorized(data));return { result: { value: deleteShipmentTrip(base, data, body, id!), queued: false }, changed: true };})
          : await operations.mutate(base.provenance.sourceSha256, async data => {
            const currentActor=actor?authorized(data):null;
            const snapshot = currentSnapshot(base, data);
            if (currentActor && id) requireWholeTrip(currentActor, snapshot, id);
            if (currentActor && Array.isArray(body.customers)) body.customers = body.customers.map(customer => {
              if (!customer || typeof customer !== 'object' || Array.isArray(customer)) return customer;
              const previous = id && typeof customer.id === 'string' ? snapshot.shipments.find(row => row.id === customer.id && row.fields.trip_id === id) : undefined;
              const sharedRequest = !previous && typeof customer.sourceRequestId === 'string' ? requireTripRequest(data, snapshot, currentActor, customer.sourceRequestId, false) : undefined;
              return { ...customer, fields: ownShipmentInput(currentActor, customer.fields, snapshot, previous, !!sharedRequest) };
            });
            const replayed = !id && typeof body.idempotencyKey === 'string' && !!data.tripCreateRequests?.[body.idempotencyKey];
            const requestLocations: Record<string, TripRequestLocationResult> = {};
            if (!id && !replayed && Array.isArray(body.customers)) for (const customer of body.customers) {
              if (customer && typeof customer === 'object' && typeof customer.sourceRequestId === 'string') {
                const target = tripRequestGeocodeTarget(data, snapshot, currentActor, { requestId: customer.sourceRequestId });
                requestLocations[customer.sourceRequestId] = target.location ?? await locations.read(target.address);
              }
            }
            const result=saveShipmentTrip(base,data,body,id,currentActor?.id ?? null,{ requireRequests: false, actor: currentActor, requestLocations });
            if (currentActor) requireWholeTrip(currentActor, currentSnapshot(base, data), result.trip.id);
            if(currentActor)for(const row of result.shipments)checkShipmentWrite(currentActor,row.fields,snapshot);
            // Only creation commits a new immutable exchange intent. Editing an existing
            // trip or replaying creation never authorizes exchange under a later policy.
            const automatic = currentActor && !id && !replayed
              ? enqueueAutomaticTripSaby({ base, data, tripId: result.trip.id, actorId: currentActor.id, config: signingConfig })
              : { enqueued: false };
            return { result: { value: result, queued: automatic.enqueued }, changed: !replayed };
          });
        const result = saved.value;
        if ('trip' in result && pushReady(config)) {
          // The assignment is already committed. A provider failure must not turn a saved trip into an error.
          try { await dispatchTripAssignments(operations, base.provenance.sourceSha256, config, options.pushSender ?? sendPush, Date.now(), result.trip.id); }
          catch { console.error('Уведомление водителю ожидает повторной отправки планировщиком.'); }
        }
        write(response, request.method === 'POST' ? 201 : 200, JSON.stringify(result));
        if (saved.queued && 'trip' in result) {
          const tripId = result.trip.id;
          if (options.requestSabyWorkflow) {
            try { options.requestSabyWorkflow(tripId); }
            catch { /* The already committed queue is continued by the next scheduled scan. */ }
            return;
          }
          const authorize = (snapshot: Snapshot, data: import('./operations-store').OperationsData) => {
            const currentActor = authorized(data);
            requireTripSection(currentActor, true); requireWholeTrip(currentActor, snapshot, tripId);
          };
          const context = { base, store: operations, tripId, authorize, client: options.sabyClient };
          // Respond to the successful save first. The durable queue survives a process stop;
          // the authorized scheduler completes it when this immediate attempt cannot finish.
          void runTripSabyWorkflow({ ...context, monitoringEnabled: options.sabyWorkflowMonitoringEnabled, prepare: prepareTripSaby,
            createDelivery: (input, guardedClient) => exchangePreparedEtrn({ ...context, client: guardedClient }, input) })
            .catch(() => { /* Details remain in the workflow; no provider payload enters logs. */ });
        }
        return;
      }
      if (Object.keys(body).some(key => !['fields', 'version'].includes(key))) throw new ApiError(400, 'В запросе есть неизвестные параметры.');
      const result = await operations.mutate<{ shipment: Shipment } | { deleted: boolean; id: string }>(base.provenance.sourceSha256, data => {
        const currentActor=actor?authorized(data):null;
        if(currentActor && request.method==='DELETE')requireManage(currentActor);
        // Persist the original/manual baseline, never the derived bank-paid total.
        const snapshot = currentSnapshot(base, data, false);
        const id = shipmentIdMatch ? decodeURIComponent(shipmentIdMatch[1]) : `shipment-local-${randomUUID()}`;
        const previous = shipmentIdMatch ? snapshot.shipments.find(row => row.id === id) : undefined;
        if (shipmentIdMatch && !previous) throw new ApiError(404, 'Операция не найдена.');
        if (currentActor && previous) requireOwnedShipment(currentActor, previous, snapshot);
        if (previous?.fields.trip_id) throw new ApiError(409, 'Эта строка входит в отгрузку машины. Измените состав клиентов и данные через общую форму отгрузки.');
        if (previous) checkVersion(body.version, previous);
        const now = new Date().toISOString();
        if (request.method === 'DELETE') {
          if (data.paymentAllocations?.some(allocation => allocation.shipmentId === id)) throw new ApiError(409, 'Сначала отмените привязку банковских платежей к этой отгрузке.');
          const fields = { ...previous!.fields };
          for (const key of ['driver_name','vehicle_id','vehicle_plate']) delete fields[key];
          data.shipments[id] = { fields, version: (previous!.version ?? 0) + 1, createdAt: previous!.createdAt ?? now, updatedAt: now, deleted: true };
          return { result: { deleted: true, id }, changed: true };
        }
        const fields = prepareShipmentFields(currentActor ? ownShipmentInput(currentActor, body.fields, snapshot, previous) : body.fields, previous, snapshot);
        if(currentActor)checkShipmentWrite(currentActor,fields,snapshot,previous);
        if (!previous && fields.shipment_type !== 'azs') fields.document_number = allocateShipmentNumber(data, fields.date!);
        data.shipments[id] = { fields, version: (previous?.version ?? 0) + 1, createdAt: previous?.createdAt ?? now, updatedAt: now };
        const shipment = currentSnapshot(base, data).shipments.find(row => row.id === id)!;
        return { result: { shipment }, changed: true };
      });
      write(response, request.method === 'POST' ? 201 : 200, JSON.stringify(result));
    })().catch((error: unknown) => {
      if (error instanceof ApiError) return write(response, error.status, JSON.stringify({ error: error.message }));
      if (error instanceof StoreError) return write(response, 500, '{"error":"Не удалось проверить хранилище операций. Данные не изменены; проверьте data/local-operations/operations.json и файл блокировки."}');
      cache = undefined;
      write(response, 500, '{"error":"Не удалось прочитать или проверить локальные данные. Исходный экспорт и сохранённые операции не изменены."}');
    });
  };
}

/** The source directory remains outside Vite's web root and is never a static asset. */
export default function localApi(options: LocalApiOptions = {}): Plugin {
  const runtimeOptions: LocalApiOptions = { ...options, pushIntervalSeconds: 30, sabyWorkflowMonitoringEnabled: false };
  runtimeOptions.sabyClient ??= new SabyClient(sabyConfigFromEnv(), options.fetcher);
  const middleware = createSnapshotMiddleware(defaultDataDirectory, runtimeOptions);
  const sabyDisposers = new Set<() => Promise<void>>();
  const sabyStops = new Set<Promise<void>>();
  async function startSaby(server: { httpServer: import('node:events').EventEmitter | null }) {
    const enabled = options.sabyWorkflowMonitoringEnabled ?? process.env.SABY_WORKFLOW_ENABLED === 'true';
    const config = runtimeOptions.sabyClient!.config;
    if (!enabled || sabyCredentialBlockers(config).length || !server.httpServer) return;
    const store = options.operationsStore ?? new OperationsStore(options.operationsDirectory ?? resolve(defaultDataDirectory, '../local-operations'));
    const scheduler = createTripSabyScheduler({ base: await loadSnapshot(), store, config, client: runtimeOptions.sabyClient, enabled: true });
    runtimeOptions.sabyClient = scheduler.client;
    let disposed = false;
    const check = async (carrierWaitingOnly = false) => {
      if (disposed) return;
      try { await scheduler.tick(carrierWaitingOnly); }
      catch { /* Provider messages and private document data must never enter process logs. */ }
    };
    const timer = setInterval(() => { void check(); }, SABY_WORKFLOW_TICK_MS);
    const fastTimer = setInterval(() => { void check(true); }, SABY_CARRIER_WAIT_TICK_MS); fastTimer.unref();
    let stopping: Promise<void> | undefined;
    const dispose = () => {
      if (stopping) return stopping;
      disposed = true; clearInterval(timer); clearInterval(fastTimer); sabyDisposers.delete(dispose);
      runtimeOptions.sabyWorkflowMonitoringEnabled = sabyDisposers.size > 0;
      stopping = scheduler.stop().finally(() => { sabyStops.delete(stopping!); });
      sabyStops.add(stopping);
      return stopping;
    };
    timer.unref(); sabyDisposers.add(dispose); runtimeOptions.sabyWorkflowMonitoringEnabled = true;
    runtimeOptions.requestSabyWorkflow = tripId => scheduler.request(tripId);
    server.httpServer.once('close', () => { void dispose(); }); void check();
  }
  function startReminders(server: { httpServer: import('node:events').EventEmitter | null }) {
    const config = options.pushConfig ?? pushConfig();
    if (!pushReady(config)) return;
    const store = options.operationsStore ?? new OperationsStore(options.operationsDirectory ?? resolve(defaultDataDirectory, '../local-operations'));
    let running = false;
    const check = async () => {
      if (running) return;
      running = true;
      try { await dispatchReminders(store, (await loadSnapshot()).provenance.sourceSha256, config, options.pushSender ?? sendPush); }
      catch { console.error('Не удалось проверить push-напоминания. Следующая попытка через 30 секунд.'); }
      finally { running = false; }
    };
    const timer = setInterval(() => { void check(); }, 30000);
    timer.unref();
    server.httpServer?.once('close', () => clearInterval(timer));
  }
  function startBanking(server: { httpServer: import('node:events').EventEmitter | null }) {
    if ((options.bankEnvironment ?? process.env).ARTEL_BANK_SYNC_ENABLED !== 'true') return;
    const store = options.operationsStore ?? new OperationsStore(options.operationsDirectory ?? resolve(defaultDataDirectory, '../local-operations'));
    let running = false;
    const source = loadSnapshot().then(snapshot => snapshot.provenance.sourceSha256);
    const check = async () => {
      if (running) return;
      running = true;
      try { await dispatchBanks(store, await source, options.bankEnvironment, options.bankRequest, options.sberRequest); }
      catch { /* Errors stay in connection state; never log bank responses or credentials. */ }
      finally { running = false; }
    };
    const timer = setInterval(() => { void check(); }, BANK_SYNC_TICK_MS);
    void check();
    timer.unref(); server.httpServer?.once('close', () => clearInterval(timer));
  }
  return {
    name: 'artel-local-operations-api',
    async configureServer(server) { server.middlewares.use(middleware); startReminders(server); startBanking(server); await startSaby(server); },
    async configurePreviewServer(server) { server.middlewares.use(middleware); startReminders(server); startBanking(server); await startSaby(server); },
    async closeBundle() { await Promise.all([...sabyDisposers].map(dispose => dispose())); await Promise.all([...sabyStops]); },
  };
}

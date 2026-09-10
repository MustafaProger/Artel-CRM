import { createHash, randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { resolve } from 'node:path';
import Decimal from 'decimal.js';
import type { Plugin } from 'vite';
import type { AccountUser } from '../web/src/auth-model';
import type { Company, Metric, Payment, QualityIssue, Shipment, Snapshot, Stock } from '../web/src/model';
import { ApiError } from './api-error';
import { activeUsers, authenticate, canManage, login, logout, publicUser, requireManage, requireUser, saveUser, sessionCookie } from './auth';
import { scopeSnapshot, checkShipmentWrite } from './auth-scope';
import { emptyChina } from '../web/src/china-model';
import { mutateChina } from './china-operations';
import { readWork, mutateWork, workFile } from './work-operations';
import { prepareDirectoryCleanup } from './directory-cleanup';
import { deleteDirectoryEntry } from './directory-deletion';
import { lookupCheckoCompany, validInn } from './checko';
import { OperationsStore, StoreError, type OperationsStorage } from './operations-store';
import { currentSnapshot, shipmentPage, prepareShipmentFields, inferCalculationRules } from './shipment-operations';
import { addDirectoryEntry, normalizeName } from './directory-operations';
import { saveCompany, updateDirectoryEntry } from './directory-editing';
import { allocateShipmentNumber } from './shipment-numbering';
import { deleteShipmentTrip, getShipmentTrip, saveShipmentTrip } from './shipment-trips';

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
  /** Only isolated domain tests may disable authentication. Runtime always requires it. */
  requireAuthentication?: boolean;
  setupToken?: string;
  secureCookies?: boolean;
  operationsStore?: OperationsStorage;
  /** Cloud entry point supplies authentication and same-origin validation. Local default stays closed. */
  authorizeRequest?: (request: IncomingMessage) => boolean;
  operationsDirectory?: string;
  checkoApiKey?: string;
  /** Injectable only on the server, for provider integration tests. */
  fetcher?: typeof fetch;
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
    const pathname = request.url?.split('?')[0];
    if (!pathname?.startsWith('/api/')) return next();
    if (!(options.authorizeRequest ?? isLocalRequest)(request)) return write(response, 403, '{"error":"Доступ к API запрещён."}');
    void (async () => {
      const url = new URL(request.url!, 'http://localhost');
      const authEnabled = options.requireAuthentication !== false;
      const base = await baseSnapshot();
      const secure = options.secureCookies ?? !isLocalHost(request.headers.host);
      if (pathname.startsWith('/api/auth/')) {
        const userId = pathname.match(/^\/api\/auth\/users\/([^/]+)$/)?.[1];
        if (request.method === 'GET' && pathname === '/api/auth/session') {
          const data = await operations.read(base.provenance.sourceSha256);
          return write(response, 200, JSON.stringify({ user: authenticate(data, request), needsSetup: !data.accounts?.users.length, setupTokenRequired: secure }));
        }
        if (request.method === 'GET' && pathname === '/api/auth/users') {
          const data = await operations.read(base.provenance.sourceSha256);
          const actor = requireUser(data, request);
          const users = canManage(actor) ? (data.accounts?.users ?? []).map(publicUser) : activeUsers(data).map(u=>({...u,login:''}));
          return write(response, 200, JSON.stringify({users}));
        }
        const allowedAuth = request.method === 'POST' && ['/api/auth/setup','/api/auth/login','/api/auth/logout','/api/auth/users'].includes(pathname) || request.method === 'PATCH' && !!userId;
        if (!allowedAuth) throw new ApiError(405,'Метод не поддерживается.');
        const body = await jsonBody(request);
        const result = await operations.mutate<{status:number;token?:string;user?:AccountUser;error?:string}>(base.provenance.sourceSha256, async data => {
          if(pathname === '/api/auth/login')return { result: await login(data,body), changed:true };
          if(pathname === '/api/auth/setup') {
            if(data.accounts?.users.length)throw new ApiError(409,'Директор уже создан. Выполните вход.');
            const setupToken=options.setupToken ?? process.env.ARTEL_SETUP_TOKEN;
            if(secure && (!setupToken || body.setupToken !== setupToken))throw new ApiError(403,'Для первоначальной настройки нужен серверный ключ настройки.');
            await saveUser(data,currentSnapshot(base,data),body,undefined,true);
            return { result:await login(data,body),changed:true };
          }
          const actor=requireUser(data,request);
          if(pathname === '/api/auth/logout'){logout(data,request);return {result:{status:200,token:''},changed:true};}
          requireManage(actor);
          return {result:{status:userId?200:201,user:await saveUser(data,currentSnapshot(base,data),body,userId?decodeURIComponent(userId):undefined)},changed:true};
        });
        if ('token' in result && typeof result.token === 'string') response.setHeader('Set-Cookie',sessionCookie(result.token,secure));
        const {token:_token,...safeResult}=result as typeof result & {token?:string};
        void _token;
        return write(response,result.status,JSON.stringify(safeResult));
      }
      const actor = authEnabled ? requireUser(await operations.read(base.provenance.sourceSha256),request) : null;
      if (pathname === '/api/directories/cleanup') {
        const stored = await operations.read(base.provenance.sourceSha256);
        requireManage(requireUser(stored, request));
        if (request.method === 'GET') {
          try {
            const preview = prepareDirectoryCleanup(base, stored);
            return write(response, 200, JSON.stringify({ counts: preview.counts, revision: stored.revision, available: !!operations.backup }));
          } catch (error) {
            if (error instanceof ApiError && error.status === 409) return write(response, 200, JSON.stringify({ blocked: error.message, revision: stored.revision, available: false }));
            throw error;
          }
        }
        if (request.method !== 'POST') throw new ApiError(405, 'Метод не поддерживается.');
        const body = await jsonBody(request);
        if (body.confirm !== 'clear-directories' || Object.keys(body).some(key => !['confirm','revision'].includes(key))) throw new ApiError(400, 'Подтвердите очистку справочников.');
        if (!operations.backup) throw new ApiError(503, 'Резервное копирование недоступно. Очистка запрещена.');
        const result = await operations.mutate(base.provenance.sourceSha256, async data => {
          requireManage(requireUser(data, request));
          if (body.revision !== data.revision) throw new ApiError(409, 'Данные изменены. Откройте предварительную проверку заново.');
          const prepared = prepareDirectoryCleanup(base, data);
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
          requireManage(requireUser(data, request));
          return write(response, 200, JSON.stringify({ china: data.china ?? emptyChina(), suppliers: currentSnapshot(base, data).companies.filter(company => company.roles.includes('supplier')) }));
        }
        if (!chinaMatch || (chinaMatch[2] ? request.method !== 'PATCH' : request.method !== 'POST')) throw new ApiError(405, 'Метод не поддерживается.');
        const body = await jsonBody(request);
        const result = await operations.mutate(base.provenance.sourceSha256, data => {
          const result = mutateChina(data, currentSnapshot(base, data), requireUser(data, request), chinaMatch[1], body, chinaMatch[2] ? decodeURIComponent(chinaMatch[2]) : undefined);
          return { result, changed: result.changed };
        });
        return write(response, result.created ? 201 : 200, JSON.stringify(result));
      }
      const fileMatch = pathname.match(/^\/api\/work\/(tasks|companies)\/([^/]+)\/files\/([^/]+)$/);
      if (fileMatch) {
        if (request.method !== 'GET') throw new ApiError(405, 'Метод не поддерживается.');
        const data = await operations.read(base.provenance.sourceSha256);
        const file = workFile(data, fileMatch[1], decodeURIComponent(fileMatch[2]), decodeURIComponent(fileMatch[3]), requireUser(data, request));
        response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="attachment"; filename*=UTF-8''${encodeURIComponent(file.name).replace(/'/g, '%27')}`, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' });
        response.end(Buffer.from(file.data!, 'base64')); return;
      }
      const workMatch = pathname.match(/^\/api\/work\/(tasks|companies|notes)(?:\/([^/]+))?$/);
      if(pathname === '/api/work' || workMatch){
        if(!actor)throw new ApiError(401,'Войдите в приложение.');
        if(pathname === '/api/work' && request.method === 'GET'){
          const data=await operations.read(base.provenance.sourceSha256);
          return write(response,200,JSON.stringify(readWork(data,scopeSnapshot(currentSnapshot(base,data),requireUser(data,request)),url.searchParams,requireUser(data,request),activeUsers(data))));
        }
        if(!workMatch)throw new ApiError(405,'Метод не поддерживается.');
        const body=await jsonBody(request, false, 3 * 1024 * 1024);
        const result=await operations.mutate(base.provenance.sourceSha256,data=>{
          const currentActor=requireUser(data,request);
          const result=mutateWork(data,scopeSnapshot(currentSnapshot(base,data),currentActor),workMatch[1],body,workMatch[2]?decodeURIComponent(workMatch[2]):undefined,request.method??'',currentActor,activeUsers(data));
          return {result,changed:result.changed};
        });
        return write(response,result.created?201:200,JSON.stringify(result));
      }
      const shipmentIdMatch = pathname.match(/^\/api\/shipments\/([^/]+)$/);
      const directoryMatch = pathname.match(/^\/api\/directories\/([^/]+)\/([^/]+)$/);
      const tripIdMatch = pathname.match(/^\/api\/shipment-trips\/([^/]+)$/);
      if (!['/api/snapshot', '/api/shipments', '/api/shipment-trips', '/api/directories', '/api/companies/from-inn', '/api/companies/lookup'].includes(pathname) && !shipmentIdMatch && !tripIdMatch && !directoryMatch) throw new ApiError(404, 'Маршрут не найден.');
      const allowed = directoryMatch ? ['PATCH','DELETE'] : pathname === '/api/snapshot' ? ['GET'] : tripIdMatch ? ['GET', 'PATCH', 'DELETE'] : ['/api/companies/from-inn', '/api/companies/lookup', '/api/shipment-trips'].includes(pathname) ? ['POST'] : shipmentIdMatch ? ['GET', 'PATCH', 'DELETE'] : ['GET', 'POST'];
      if (!allowed.includes(request.method ?? '')) throw new ApiError(405, 'Метод не поддерживается для этого маршрута.');
      if (request.method === 'GET') {
        const stored = await operations.read(base.provenance.sourceSha256);
        const fullSnapshot = currentSnapshot(base, stored);
        const snapshot = actor ? scopeSnapshot(fullSnapshot, requireUser(stored, request)) : fullSnapshot;
        if (pathname === '/api/directories') return write(response, 200, JSON.stringify({ directories: snapshot.directories, companies: snapshot.companies }));
        if (pathname === '/api/snapshot') {
          if (url.searchParams.get('shipments') === 'omit') snapshot.shipments = [];
          return write(response, 200, JSON.stringify(snapshot));
        }
        if (tripIdMatch) return write(response, 200, JSON.stringify({ trip: getShipmentTrip(snapshot, decodeURIComponent(tripIdMatch[1])) }));
        if (shipmentIdMatch) {
          const shipment = snapshot.shipments.find(row => row.id === decodeURIComponent(shipmentIdMatch[1]));
          if (!shipment) throw new ApiError(404, 'Операция не найдена.');
          return write(response, 200, JSON.stringify({ shipment }));
        }
        return write(response, 200, JSON.stringify(shipmentPage(snapshot, url.searchParams)));
      }
      const body = await jsonBody(request, request.method === 'DELETE');
      if(actor && (pathname.startsWith('/api/directories') || pathname.startsWith('/api/companies') || request.method==='DELETE'))requireManage(actor);
      if (pathname === '/api/directories' || directoryMatch) {
        const result = await operations.mutate(base.provenance.sourceSha256, data => {
          if(actor)requireManage(requireUser(data,request));
          const snapshot = currentSnapshot(base, data);
          const result = directoryMatch && request.method === 'DELETE' ? deleteDirectoryEntry(directoryMatch[1],decodeURIComponent(directoryMatch[2]),body,snapshot,data) : directoryMatch
            ? directoryMatch[1] === 'companies'
              ? saveCompany(body, snapshot, data, decodeURIComponent(directoryMatch[2]))
              : updateDirectoryEntry(directoryMatch[1], decodeURIComponent(directoryMatch[2]), body, snapshot, data)
            : body.kind === 'companies' ? saveCompany(body, snapshot, data) : addDirectoryEntry(body, snapshot, data);
          currentSnapshot(base, data);
          return { result, changed: !!directoryMatch || result.created };
        });
        return write(response, result.created ? 201 : 200, JSON.stringify(result));
      }
      if (pathname === '/api/companies/lookup') {
        if (Object.keys(body).some(key=>key!=='inn') || typeof body.inn !== 'string' || !validInn(body.inn.trim())) throw new ApiError(400, 'Укажите корректный ИНН.');
        const company = await lookupCheckoCompany(body.inn.trim(), options.checkoApiKey ?? process.env.CHECKO_API_KEY, options.fetcher);
        return write(response, 200, JSON.stringify({ company }));
      }
      if (pathname === '/api/companies/from-inn') {
        if (Object.keys(body).some(key => key !== 'inn') || typeof body.inn !== 'string' || !validInn(body.inn.trim())) throw new ApiError(400, 'Укажите корректный ИНН из 10 или 12 цифр с верными контрольными цифрами.');
        const inn = body.inn.trim();
        const existing = currentSnapshot(base, await operations.read(base.provenance.sourceSha256)).companies.find(company => company.inn === inn);
        if (existing) return write(response, 200, JSON.stringify({ company: existing, created: false }));
        const found = await lookupCheckoCompany(inn, options.checkoApiKey ?? process.env.CHECKO_API_KEY, options.fetcher);
        const result = await operations.mutate(base.provenance.sourceSha256, data => {
          if(actor)requireManage(requireUser(data,request));
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
        const result = request.method === 'DELETE'
          ? await operations.mutate(base.provenance.sourceSha256, data => {if(actor)requireManage(requireUser(data,request));return { result: deleteShipmentTrip(base, data, body, id!), changed: true };})
          : await operations.mutate(base.provenance.sourceSha256, data => {
            const currentActor=actor?requireUser(data,request):null;
            if(currentActor && id){for(const row of currentSnapshot(base,data).shipments.filter(s=>s.fields.trip_id===id))checkShipmentWrite(currentActor,row.fields,row);}
            const result=saveShipmentTrip(base,data,body,id);
            if(currentActor)for(const row of result.shipments)checkShipmentWrite(currentActor,row.fields);
            return {result,changed:true};
          });
        return write(response, request.method === 'POST' ? 201 : 200, JSON.stringify(result));
      }
      if (Object.keys(body).some(key => !['fields', 'version'].includes(key))) throw new ApiError(400, 'В запросе есть неизвестные параметры.');
      const result = await operations.mutate<{ shipment: Shipment } | { deleted: boolean; id: string }>(base.provenance.sourceSha256, data => {
        const currentActor=actor?requireUser(data,request):null;
        if(currentActor && request.method==='DELETE')requireManage(currentActor);
        const snapshot = currentSnapshot(base, data);
        const id = shipmentIdMatch ? decodeURIComponent(shipmentIdMatch[1]) : `shipment-local-${randomUUID()}`;
        const previous = shipmentIdMatch ? snapshot.shipments.find(row => row.id === id) : undefined;
        if (shipmentIdMatch && !previous) throw new ApiError(404, 'Операция не найдена.');
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
        const fields = prepareShipmentFields(body.fields, previous, snapshot);
        if(currentActor)checkShipmentWrite(currentActor,fields,previous);
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
  const middleware = createSnapshotMiddleware(defaultDataDirectory, options);
  return {
    name: 'artel-local-operations-api',
    configureServer(server) { server.middlewares.use(middleware); },
    configurePreviewServer(server) { server.middlewares.use(middleware); },
  };
}

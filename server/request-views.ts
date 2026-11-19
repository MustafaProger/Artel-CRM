import type { OperationsData, OperationsStorage } from './operations-store';
import { performanceSpan } from './performance-trace';

type CoreFields = readonly (keyof OperationsData)[];
type RequestView = 'auth' | 'boards' | 'workspace' | 'documents' | 'full' | CoreFields;
const shipmentFields = ['shipments', 'companies', 'directories', 'paymentAllocations', 'sourceOperationsCleared'] as const;
const financialFields = [...shipmentFields, 'banking', 'sber', 'sberArtel'] as const;
export const tripFields = [...financialFields, 'tripNumbers', 'tripCreateRequests', 'tripProcessHiddenIds',
  'tripRequests', 'tripRequestCreates', 'tripExchangeControls', 'tripExecutions', 'driverTripProgress', 'saby', 'etrn', 'tripSaby'] as const;
export const tripRequestFields = [...shipmentFields, 'tripRequests'] as const;

export function readAuthority(store: OperationsStorage, source: string) {
  return store.readAuth?.(source) ?? store.read(source);
}
export function readCore(store: OperationsStorage, source: string, fields: CoreFields) {
  return store.readCoreFields?.(source, fields) ?? store.readWorkspace?.(source) ?? store.read(source);
}
export function readWorkspace(store: OperationsStorage, source: string) {
  return store.readWorkspace?.(source) ?? store.read(source);
}

function selectView(path: string, method: string, params: URLSearchParams): RequestView {
  if (/^\/api\/work\/boards(?:\/[^/]+)?$/.test(path) || /^\/api\/work\/(tasks|companies)\/[^/]+\/files\/[^/]+$/.test(path)) return 'boards';
  // The workflow needs current trip state before the first action/response on GET and POST.
  if (/^\/api\/shipment-trips\/[^/]+\/saby-workflow(?:\/|$)/.test(path)) return tripFields;
  if (method !== 'GET') return 'auth'; // Mutations authorize again inside their transaction.
  if (path === '/api/documents' || path.startsWith('/api/documents/')) return 'documents';
  if (path === '/api/auth/users') return params.get('online') === '1' ? 'auth' : shipmentFields;
  if (path.startsWith('/api/auth/') || (path === '/api/invoices' || path.startsWith('/api/invoices/')) || path.startsWith('/api/push/') || path === '/api/trip-requests/map-config' || path === '/api/banking/dispatch') return 'auth';
  if (path === '/api/work' || path === '/api/navigation') return 'workspace';
  if (path === '/api/trip-requests') return tripRequestFields;
  if (path === '/api/trip-requests/context' || path === '/api/context' || path === '/api/directories' ||
      path === '/api/directories/export.xlsx' ||
      (path === '/api/snapshot' && params.get('context') === 'directories' && params.get('shipments') === 'omit')) return shipmentFields;
  if (path === '/api/operator') return [...shipmentFields, 'operator'];
  if (path === '/api/china') return [...financialFields, 'china'];
  if (path === '/api/snapshot' || path === '/api/shipments' || path.startsWith('/api/shipments/') ||
      path === '/api/settlements' || path.startsWith('/api/settlements/')) return financialFields;
  if (path === '/api/shipment-trips' || path.startsWith('/api/shipment-trips/') ||
      path.startsWith('/api/driver/')) return tripFields;
  if (path.startsWith('/api/drivers/')) return shipmentFields;
  // Maintenance checks can fingerprint the entire logical state, including the archive.
  return 'full';
}

export function readRequestView(store: OperationsStorage, source: string, path: string, method: string, params: URLSearchParams) {
  const view = selectView(path, method, params);
  return performanceSpan('request.read-' + (typeof view === 'string' ? view : 'core-fields'), () => {
    switch (view) {
      case 'auth': return readAuthority(store, source);
      case 'boards': return store.readBoards?.(source) ?? store.read(source);
      case 'workspace': return readWorkspace(store, source);
      case 'documents': return store.readDocuments?.(source) ?? store.read(source);
      case 'full': return store.read(source);
      default: return readCore(store, source, view);
    }
  });
}

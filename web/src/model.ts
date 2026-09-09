/** Money and quantities retain the exported decimal precision. Null is never zero. */
export type DecimalValue = string | null;

export interface Metric {
  total: DecimalValue;
  numericCount: number;
  missingCount: number;
}

export interface Company {
  id: string;
  name: string;
  roles: string[];
  managerLabels: string[];
  shipmentIds: string[];
  paymentIds: string[];
  flags: string[];
  inn?: string;
  kpp?: string | null;
  ogrn?: string | null;
  address?: string | null;
  status?: string | null;
  fullName?: string | null;
  registrySource?: 'checko';
  registryCheckedAt?: string;
}

export interface Shipment {
  id: string;
  /** Source records start at zero; each saved edit increments the version. */
  version?: number;
  createdAt?: string;
  updatedAt?: string;
  calculationRules?: CalculationRules;
  calculationWarnings?: string[];
  date: string | null;
  customerId: string | null;
  customer: string | null;
  supplierId: string | null;
  supplier: string | null;
  carrierId: string | null;
  carrier: string | null;
  product: string | null;
  liters: DecimalValue;
  revenue: DecimalValue;
  /** Saved purchase amount only; transport is available in fields. */
  cost: DecimalValue;
  manager: string | null;
  sourceRow: number;
  sourceSheet: string;
  flags: string[];
  /** Original exported values, including nulls and Excel error strings. */
  fields: Record<string, string | null>;
}

export type ShipmentSettlement = 'all' | 'cashless' | 'cash' | 'f2' | 'unspecified';

export interface ShipmentsResponse {
  items: Shipment[];
  total: number;
  hasMore: boolean;
  nextOffset: number;
  summary: { liters: Metric; revenue: Metric; cost: Metric; customerCount: number };
  topCustomers: { id: string; name: string; revenue: DecimalValue }[];
}

export interface Payment {
  id: string;
  date: string | null;
  counterpartyId: string | null;
  counterparty: string | null;
  incoming: DecimalValue;
  outgoing: DecimalValue;
  purpose: string | null;
  sourceRow: number;
  sourceSheet: string;
  flags: string[];
  fields: Record<string, string | null>;
}

export interface Stock {
  id: string;
  counterpartyId: string | null;
  label: string;
  /** Source provides month 1–12, without a year in these summary rows. */
  month: string;
  incomingLiters: DecimalValue;
  incomingAmount: DecimalValue;
  outgoingLiters: DecimalValue;
  outgoingAmount: DecimalValue;
  balanceLiters: DecimalValue;
  balanceAmount: DecimalValue;
  sourceRow: number;
  sourceSheet: string;
  valueBasis: string;
  flags: string[];
  fields: Record<string, string | null>;
}

export interface Manager {
  id: string;
  label: string;
  shipmentIds: string[];
  companyIds: string[];
  isUserAccount: false;
  shipmentCount: number;
  liters: Metric;
  revenue: Metric;
}

export interface QualityIssue {
  id: string;
  code: string;
  severity: string;
  sheet: string;
  cell: string;
  sourceRow: number | null;
  recordId: string | null;
  dataset: 'shipments' | 'payments' | 'stocks' | null;
  value: string | null;
  detail: string | null;
}

export interface MonthlyAggregate {
  /** YYYY-MM, grouped by valid transaction date, not the saved month formula. */
  month: string;
  shipmentCount: number;
  paymentCount: number;
  liters: Metric;
  revenue: Metric;
  cost: Metric;
  incoming: Metric;
  outgoing: Metric;
}

export interface Snapshot {
  directories?: Directories;
  provenance: {
    sourceFile: string;
    sourceSha256: string;
    exportedAt: string;
    sourceKind: string;
    googleVerified: boolean;
    registryVerified: boolean;
    formulaPolicy: string;
    ownershipPolicy: string;
    valueBasis: string;
    sourceFilesVerified: boolean;
    counts: Record<string, number>;
    dateRange: { from: string | null; to: string | null };
  };
  companies: Company[];
  shipments: Shipment[];
  payments: Payment[];
  stocks: Stock[];
  managers: Manager[];
  quality: {
    status: string;
    issueCounts: Record<string, number>;
    issues: QualityIssue[];
    recordFlagCounts: { shipments: Record<string, number>; payments: Record<string, number> };
    flaggedShipmentCount: number;
    flaggedPaymentCount: number;
    duplicateCandidates: { dataset: string; rows: number[] }[];
    aliasCandidates: { names: string[]; ids: string[] }[];
    multipleManagerCompanyIds: string[];
    limitations: string[];
  };
  overview: {
    shipmentCount: number;
    paymentCount: number;
    companyCount: number;
    liters: Metric;
    revenue: Metric;
    cost: Metric;
    incoming: Metric;
    outgoing: Metric;
    missingShipmentDates: number;
    missingPaymentDates: number;
  };
  monthly: MonthlyAggregate[];
}

export interface NamedEntry { id: string; name: string }
export interface Vehicle { id: string; plate: string; brand?: string; model?: string; trailer?: string; name?: string; capacityLitres?: string; compartmentsLitres?: string[] }
export interface Driver extends NamedEntry { vehicleId: string; phone?: string }
export interface ShipmentAddress extends NamedEntry { companyId: string; kind: 'loading' | 'delivery' }
export type ProfitRule = 'simple' | 'excel-rounded' | 'excel-exact' | 'excel-legacy';
export interface CalculationRules {
  sale: 'litres' | 'tonnes' | null;
  purchase: 'litres' | 'tonnes' | null;
  profit: ProfitRule | null;
  debtSign: 'paid-minus-sale';
}
export interface PaymentAllocation {
  id: string; shipmentId: string; paymentId: string; amount: string; date: string;
}
export interface DuplicateCandidate { kind: string; names: string[]; ids: string[]; reason: string }
export interface Directories {
  managers: NamedEntry[]; products: NamedEntry[]; paymentForms: NamedEntry[];
  vehicles: Vehicle[]; drivers: Driver[]; addresses: ShipmentAddress[];
  defaults: { profit: ProfitRule | null };
  duplicates: DuplicateCandidate[];
}

/** A whole truck, represented by one accounting row per customer. */
export interface ShipmentTrip {
  id: string;
  fields: Record<string, string | null>;
  customers: { id: string; version: number; fields: Record<string, string | null> }[];
}
export interface ShipmentTripResponse {
  trip: ShipmentTrip;
  shipments: Shipment[];
  shipment: Shipment;
}

/** Facts confirmed for one selected customer delivery. No historical sample defaults. */
export interface EtrnParty {
  name: string; inn: string; kpp: string; address: string; phone: string; edoId: string;
  /** Legal name of an individual entrepreneur. Never serialize a 12-digit INN as a legal entity. */
  person?: EtrnName;
}
export interface EtrnDocumentBasis { name: string; number: string; date: string; issuerInns: string[] }
/** A loading document is identified either by its electronic ID or all three paper requisites. */
export interface EtrnLoadingDocumentBasis extends EtrnDocumentBasis { documentId?: string; additionalInfo?: string }
export interface EtrnLoadingWorker extends EtrnName {
  position: string;
  /** A choice confirmed by the user; neither a driver's identity nor a signer implies loading authority. */
  authority: '' | 'job_duties' | 'document';
  authorityDocument?: EtrnLoadingDocumentBasis;
  additionalInfo?: string;
}
/** Confirmed for one trip; no automatic reuse for another loading operation. */
export interface EtrnLoadingDetails { basis: EtrnLoadingDocumentBasis; worker: EtrnLoadingWorker }
export interface EtrnName { surname: string; name: string; patronymic: string }
/** Transportation contact; this role grants no signing or loading authority. */
export interface EtrnCarrierResponsible extends EtrnName { phone: string }
export interface EtrnDangerousGoods {
  unNumber: string; shippingName: string; class: string; classificationCode: string;
  packingGroup: string; hazardSign: string; tunnelCode: string;
}
export interface EtrnLoadingParty {
  /** null means unconfirmed. False requires an explicit party, never supplier inference. */
  sameAsConsignor: boolean | null; party: EtrnParty;
  basis?: EtrnLoadingDocumentBasis;
  worker?: EtrnLoadingWorker;
}
export interface SabyConsignmentProfile {
  confirmed: boolean;
  consignorPhone: string;
  carrierPhone: string;
  carrierResponsible?: EtrnCarrierResponsible;
  /** 0 = consignor, 1 = forwarder; forwarder additionally requires transportCustomer. */
  consignorIsForwarder: string;
  transportCustomer?: EtrnParty;
  transportCustomerContract?: EtrnDocumentBasis;
  order: { number: string; date: string };
  signer: EtrnName & { position: string; status: string; powerOfAttorney?: { date: string; number: string; id: string } };
  recipient: EtrnParty;
  cargo: {
    name: string; condition: string; packagingCode: string; packingMethod: string;
    packageCount: string; marking: string; massMethod: string;
    /** undefined means unconfirmed; null explicitly confirms non-dangerous cargo. */
    dangerousGoods?: EtrnDangerousGoods | null;
    dimensions?: { heightMetres: string; lengthMetres: string; widthMetres: string };
  };
  /** Planned delivery mass; legacy profiles without massSource explicitly confirmed it as actual too. */
  deliveryMassTonnes: string;
  /** Calculated allocation is not evidence of an actual weighing or loading event. */
  massSource?: 'calculated' | 'confirmed' | 'driver';
  /** Explicit net mass must never be serialized as the schema's mandatory planned gross. */
  plannedMassKind?: 'net' | 'gross';
  plannedGrossMassTonnes?: string;
  vehicle: {
    type: string; brand: string; payloadTonnes: string; capacityCubicMetres: string;
    ownershipType: string; ownershipDocument?: EtrnDocumentBasis;
  };
  driver: EtrnName;
  loading: {
    /** Moscow civil times; CRM loading_actual_at has insufficient event semantics. */
    arrivedAt: string; departedAt: string;
    /** Separately confirmed loading facts; required for a complete title when massSource is calculated. */
    grossMassTonnes?: string; massMethod?: string;
  };
  loadingActor: EtrnLoadingParty;
  infrastructureOwner: EtrnLoadingParty;
  instructions: {
    regulatory: string; redirectionParty: string; redirectionMethod: string;
    redirectionPhone: string; transshipmentForbidden: string;
  };
}

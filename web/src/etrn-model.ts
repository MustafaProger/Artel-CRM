/** Facts confirmed for one selected customer delivery. No historical sample defaults. */
export interface EtrnParty {
  name: string; inn: string; kpp: string; address: string; phone: string; edoId: string;
}
export interface EtrnDocumentBasis { name: string; number: string; date: string; issuerInns: string[] }
export interface EtrnName { surname: string; name: string; patronymic: string }
export interface EtrnDangerousGoods {
  unNumber: string; shippingName: string; class: string; classificationCode: string;
  packingGroup: string; hazardSign: string; tunnelCode: string;
}
export interface EtrnLoadingParty {
  /** null means unconfirmed. False requires an explicit party, never supplier inference. */
  sameAsConsignor: boolean | null; party: EtrnParty;
}
export interface SabyConsignmentProfile {
  confirmed: boolean;
  consignorPhone: string;
  carrierPhone: string;
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
  /** Actual mass of this delivery, separately confirmed from CRM allocation. */
  deliveryMassTonnes: string;
  vehicle: {
    type: string; brand: string; payloadTonnes: string; capacityCubicMetres: string;
    ownershipType: string; ownershipDocument?: EtrnDocumentBasis;
  };
  driver: EtrnName;
  loading: {
    /** Moscow civil times; CRM loading_actual_at has insufficient event semantics. */
    arrivedAt: string; departedAt: string;
  };
  loadingActor: EtrnLoadingParty;
  infrastructureOwner: EtrnLoadingParty;
  instructions: {
    regulatory: string; redirectionParty: string; redirectionMethod: string;
    redirectionPhone: string; transshipmentForbidden: string;
  };
}

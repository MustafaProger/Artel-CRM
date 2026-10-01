import { isUnpackagedDiesel } from '../web/src/trip-input-rules';
import Decimal from 'decimal.js';
import type { Company, ShipmentTrip, Snapshot } from '../web/src/model';
import type { EtrnLoadingParty, EtrnParty, SabyConsignmentProfile } from '../web/src/etrn-model';
import { allocateTrip } from '../web/src/trip-calculations';
import { readIntermediateStops } from '../web/src/trip-route';
import type { OperationsData } from './operations-store';
import { buildSabyConsignmentSnapshot, readSabyConsignmentProfile, sabyConsignmentBlockers } from './saby-consignment-note';
import { sabyConfigurationBlockers, sabyObject, type SabyConfig } from './saby-client';
import { sabyTransportBlockers, type SabyCargoProfile, type SabyTransportProfile, type SabyTransportSnapshot } from './saby-transport-order';
import type { TripSabyPreparation } from './trip-saby-workflow';

/** Server-only confirmed recurring facts. No credentials or historical document payloads. */
export interface TripSabyAutofillSettings {
  signerStatus?: string;
  contractDateFromTrip?: boolean;
  instructions?: Partial<SabyConsignmentProfile['instructions']>;
  loadingByAddressId?: Record<string, { loadingActorCompanyId?: string; infrastructureOwnerCompanyId?: string }>;
}
export function tripSabyAutofillSettings(env: NodeJS.ProcessEnv = process.env): TripSabyAutofillSettings {
  const text = env.SABY_AUTOFILL_PROFILE_JSON;
  if (!text || text.length > 100_000) return {};
  try {
    const raw: unknown = JSON.parse(text);
    if (!sabyObject(raw)) return {};
    const normalized = readSabyConsignmentProfile({ instructions: raw.instructions });
    const loadingByAddressId = Object.fromEntries(Object.entries(sabyObject(raw.loadingByAddressId) ? raw.loadingByAddressId : {}).flatMap(([id, row]) => !sabyObject(row) ? [] : [[id, {
      ...(typeof row.loadingActorCompanyId === 'string' ? { loadingActorCompanyId: row.loadingActorCompanyId } : {}),
      ...(typeof row.infrastructureOwnerCompanyId === 'string' ? { infrastructureOwnerCompanyId: row.infrastructureOwnerCompanyId } : {}),
    }]]));
    return { signerStatus: typeof raw.signerStatus === 'string' ? raw.signerStatus : '', contractDateFromTrip: raw.contractDateFromTrip === true, instructions: normalized.instructions, loadingByAddressId };
  } catch { return {}; }
}
const party = (company?: Company, phone?: string): EtrnParty => ({ name: company?.fullName || company?.name || '', inn: company?.inn || '', kpp: company?.kpp || '', address: company?.address || '', phone: phone ?? company?.phone ?? '', edoId: '' });
const loadingRole = (source: Snapshot, companyId?: string): EtrnLoadingParty => ({ sameAsConsignor: companyId ? false : null, party: party(source.companies.find(company => company.id === companyId)) });
const profileConfigCargo = (config: SabyConfig, productId: string | null) => config.transportProfile?.cargoByProductId[productId || ''];
const exact = (value: string | undefined, divisor: number) => value && /^\d+(?:\.\d+)?$/.test(value) ? new Decimal(value).div(divisor).toFixed() : '';

/** Pure preflight: never reserves numbers or creates external counterparty cards. */
export function prepareTripSaby(source: Snapshot, _data: OperationsData, trip: ShipmentTrip, config: SabyConfig, settings = tripSabyAutofillSettings()): TripSabyPreparation {
  const blockers = [...sabyConfigurationBlockers(config)];
  const directories = source.directories;
  const product = directories?.products.find(row => row.id === trip.fields.product_id);
  const vehicle = directories?.vehicles.find(row => row.id === trip.fields.vehicle_id);
  const driver = directories?.drivers.find(row => row.id === trip.fields.driver_id);
  if (vehicle?.maxWeight && /^\d+(?:\.\d+)?$/.test(vehicle.maxWeight) && vehicle.payloadTonnes && /^\d+(?:\.\d+)?$/.test(vehicle.payloadTonnes) && new Decimal(vehicle.payloadTonnes).mul(1000).gt(vehicle.maxWeight)) blockers.push('Укажите согласованное максимальное значение для Saby в тоннах. Проверьте единицы: килограммы нужно разделить на 1000.');
  const scenario = trip.fields.organization_id === 'nk-artel' ? 'nk_own_customer' : 'artel_customer';
  if (!['artel', 'nk-artel'].includes(trip.fields.organization_id ?? '')) blockers.push('Выберите нашу организацию рейса.');
  if (product?.transportProductKind !== 'diesel') blockers.push('Для отправки в Saby выберите товар с подтверждённым профилем дизельного топлива.');
  if (!product?.documentName) blockers.push('В справочнике товара заполните полное наименование для документов.');
  if (!product?.dangerousGoodsSource) blockers.push('В справочнике товара укажите источник подтверждения характеристик опасного груза.');
  if (product?.cargoPackaging === 'packaged') blockers.push('Автоматическая подготовка Saby поддерживает дизельное топливо наливом; для груза в упаковке требуется отдельный профиль перевозки.');
  // Both confirmed scenarios ship third-party fuel from Artel with NK as carrier;
  // the CRM accounting organization does not change the document's consignor.
  const sender = config.customer;
  const selectedCarrier = source.companies.find(company => company.id === trip.fields.carrier_id);
  // The ordinary trip selects a driver and vehicle. Its legal Saby carrier comes
  // from the configured organization, never from a driver's name or fleet label.
  // Preserve and reconcile an explicit historical legal link when one exists.
  if (trip.fields.carrier_id && (!selectedCarrier?.inn || selectedCarrier.inn !== config.carrier.inn)) blockers.push('Указанный в истории рейса перевозчик не соответствует настроенной организации-перевозчику Saby. Сверьте юридическое лицо перед отправкой.');
  for (const [label, carrierId] of [['водителя', driver?.carrierId], ['автомобиля', vehicle?.carrierId]] as const) {
    if (!carrierId) continue;
    const linkedCarrier = source.companies.find(company => company.id === carrierId);
    if (!linkedCarrier?.inn || linkedCarrier.inn !== config.carrier.inn) blockers.push(`В карточке ${label} указан перевозчик, не соответствующий настроенному юридическому лицу Saby. Сверьте сохранённую связь перед отправкой.`);
  }
  const transportCarrier = { ...config.carrier, phone: driver?.phone || '' };
  const allocation = allocateTrip(trip.fields.quantity_tonnes || '', trip.customers.map(row => row.fields.quantity_litres || ''));
  const bulkDiesel = isUnpackagedDiesel(product);
  const plannedGross = bulkDiesel ? trip.fields.quantity_tonnes : trip.fields.quantity_gross_tonnes;
  const grossAllocation = plannedGross ? allocateTrip(plannedGross, trip.customers.map(row => row.fields.quantity_litres || '')) : null;
  if (!grossAllocation) blockers.push(bulkDiesel ? 'В рейсе укажите плановую массу груза, т.' : 'В рейсе укажите плановую массу брутто груза.');
  const cargo: SabyCargoProfile = {
    name: product?.documentName || '', condition: 'Жидкий', packagingCode: 'TY', packageCount: '1',
    // The transport-order format describes the planned method, never a performed weighing.
    massMethod: '03', distributable: vehicle?.cargoDistributable ?? profileConfigCargo(config, trip.fields.product_id)?.distributable ?? '' as SabyCargoProfile['distributable'], divisible: '1',
    heightMetres: '1', lengthMetres: '1', widthMetres: '1',
    dangerousGoods: { unNumber: product?.dangerousGoodsUnNumber || '', shippingName: product?.dangerousGoodsShippingName || '', class: product?.dangerousGoodsClass || '', classificationCode: product?.dangerousGoodsClassificationCode || '', packingGroup: product?.dangerousGoodsPackingGroup || '', hazardSign: product?.dangerousGoodsHazardSign || '', tunnelCode: product?.dangerousGoodsTunnelCode || '' },
  };
  const profileConfig = config.transportProfile;
  const contract = profileConfig?.contract ? { ...profileConfig.contract, ...(settings.contractDateFromTrip ? { date: trip.fields.date || '' } : {}) } : undefined;
  const regulatory = settings.instructions?.regulatory || (contract?.name && contract.number && contract.date ? `Согласно ${contract.name} № ${contract.number} от ${contract.date.split('-').reverse().join('.')}` : '');
  const depot = directories?.oilDepots?.find(row => row.id === trip.fields.oil_depot_id);
  const owner = source.companies.find(row => row.id === depot?.ownerCompanyId);
  if (!depot) blockers.push('В рейсе выберите нефтебазу из отдельного справочника.');
  if (depot && !depot.address) blockers.push('В карточке нефтебазы заполните фактический адрес места погрузки.');
  if (depot && !owner) blockers.push('В карточке нефтебазы выберите компанию — владельца нефтебазы.');
  if (owner && !owner.address) blockers.push('В карточке компании — владельца нефтебазы заполните юридический адрес.');
  // Use the selected physical site. A supplier's address and a company's legal
  // address cannot stand in for the loading location, even for the same entity.
  const normalizedTrip = { ...trip, fields: { ...trip.fields,
    ...(depot ? { loading_address: trip.fields.loading_address || depot.address || null, loading_location_name: depot.name,
      loading_map_url: trip.fields.loading_map_url || depot.mapUrl || null, loading_latitude: trip.fields.loading_latitude || depot.latitude || null, loading_longitude: trip.fields.loading_longitude || depot.longitude || null } : {}) } };
  const deliveries = trip.customers.map((delivery, index) => {
    const snapshot = buildSabyConsignmentSnapshot(source, normalizedTrip, delivery.id, sender, transportCarrier, null);
    const p = snapshot.profile;
    const address = directories?.addresses.find(row => row.id === delivery.fields.unloading_address_id);
    p.confirmed = true;
    p.order = { number: '', date: trip.fields.date || '' };
    p.consignorIsForwarder = '0';
    p.recipient.phone = address?.receiverPhone || '';
    if (!address?.receiverName || !address.receiverPhone) blockers.push(`Доставка ${index + 1}: у выбранного адреса заполните имя и телефон приёмщика.`);
    p.carrierPhone = driver?.phone || '';
    p.cargo = { name: cargo.name, condition: cargo.condition, packagingCode: cargo.packagingCode, packingMethod: 'Налив в цистерну', packageCount: '1', marking: 'Без маркировки', massMethod: '', dangerousGoods: cargo.dangerousGoods!, dimensions: { heightMetres: '1', lengthMetres: '1', widthMetres: '1' } };
    p.deliveryMassTonnes = allocation.tonnes[index];
    p.massSource = 'calculated';
    p.plannedMassKind = 'net';
    p.plannedGrossMassTonnes = grossAllocation?.tonnes[index] || '';
    p.vehicle.type = vehicle?.transportVehicleType || vehicle?.vehicleType || '';
    p.vehicle.payloadTonnes = vehicle?.payloadTonnes || '';
    p.vehicle.capacityCubicMetres = exact(vehicle?.capacityLitres, 1000);
    p.vehicle.ownershipType = vehicle?.ownershipType || '';
    if (vehicle?.leaseDocumentName || vehicle?.leaseDocumentNumber || vehicle?.leaseDocumentDate) p.vehicle.ownershipDocument = { name: vehicle.leaseDocumentName || '', number: vehicle.leaseDocumentNumber || '', date: vehicle.leaseDocumentDate || '', issuerInns: (vehicle.leaseDocumentIssuerInn || '').split(',').map(value => value.trim()).filter(Boolean) };
    if (config.consignmentSigner) Object.assign(p.signer, config.consignmentSigner);
    p.signer.status = settings.signerStatus || '';
    p.loadingActor = loadingRole(source, depot?.loadingActorCompanyId);
    p.infrastructureOwner = loadingRole(source, depot?.infrastructureOwnerCompanyId);
    p.instructions = { regulatory, redirectionParty: 'Грузополучатель', redirectionMethod: 'По телефону', redirectionPhone: address?.receiverPhone || '', transshipmentForbidden: '', ...Object.fromEntries(Object.entries(settings.instructions || {}).filter(([, value]) => value)) };
    p.instructions.regulatory = regulatory;
    // Nothing here copies loading_actual_at or a planning time into an event.
    blockers.push(...sabyConsignmentBlockers(snapshot, { stage: 'preparation' }).map(message => `Доставка ${index + 1}: ${message}`));
    return { shipmentId: delivery.id, snapshot };
  });
  const first = deliveries[0].snapshot;
  const productId = trip.fields.product_id || '', vehicleId = trip.fields.vehicle_id || '';
  const profile: SabyTransportProfile = { function: 'Заявка', ...(contract ? { contract } : {}), regulatoryInstructions: regulatory, foodInstructions: 'Отсутствуют', signatory: profileConfig?.signatory || { surname: '', name: '', position: '', authorityMethod: '1' }, cargoByProductId: { [productId]: cargo }, vehicleById: { [vehicleId]: { type: first.profile.vehicle.type, payloadTonnes: first.profile.vehicle.payloadTonnes, capacityCubicMetres: first.profile.vehicle.capacityCubicMetres } } };
  const stops = trip.customers.flatMap(row => readIntermediateStops(row.fields.intermediate_stops_after).map(stop => ({ afterShipmentId: row.id, name: stop.name, address: stop.address })));
  if (stops.length && !['true', 'false'].includes(trip.fields.intermediate_stops_in_order || '')) blockers.push('Укажите в рейсе, включать ли промежуточные остановки в заявку Saby.');
  const infrastructureOwner = first.profile.infrastructureOwner.party;
  const order: SabyTransportSnapshot = {
    tripId: trip.id, shipmentId: trip.id, version: Math.max(...trip.customers.map(row => row.version)),
    fields: { ...first.fields, quantity_litres: allocation.totalLitres, quantity_tonnes: trip.fields.quantity_tonnes, quantity_gross_tonnes: plannedGross ?? null, loading_site_owner_name: owner?.fullName || owner?.name || null, loading_site_owner_address: owner?.address || null, loading_site_owner_inn: owner?.inn || null },
    customer: first.customer, supplier: party(source.companies.find(row => row.id === trip.fields.supplier_id)),
    driver: { name: driver?.fullName || '', phone: driver?.phone || '' }, vehicle: { plate: vehicle?.plate || '', type: first.profile.vehicle.type }, customerOrganization: sender, carrierOrganization: transportCarrier, profile,
    deliveries: deliveries.map(row => ({ shipmentId: row.shipmentId, fields: row.snapshot.fields, customer: row.snapshot.profile.recipient })),
    ...(trip.fields.intermediate_stops_in_order === 'true' ? { intermediateStops: stops } : {}),
    loadingInfrastructureOwner: { name: infrastructureOwner.name, inn: infrastructureOwner.inn }, allowedOperationTime: '19:00:00+03:00',
  };
  blockers.push(...sabyTransportBlockers(order));
  return { scenario, order, deliveries, blockers: [...new Set(blockers)] };
}

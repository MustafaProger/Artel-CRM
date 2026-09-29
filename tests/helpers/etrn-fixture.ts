import type { ShipmentTrip, Snapshot } from '../../web/src/model';
import type { SabyOrganization } from '../../server/saby-client';
import { buildSabyConsignmentSnapshot, readSabyConsignmentProfile } from '../../server/saby-consignment-note';

export const sender: SabyOrganization = { name: 'Синтетический отправитель', inn: '0148372956', kpp: '015927183', address: 'Синтетический юридический адрес отправителя', phone: '+70000000001', edoId: 'SYNTHETICSENDER' };
export const carrier: SabyOrganization = { name: 'Синтетический перевозчик', inn: '0392816475', kpp: '037195284', address: 'Синтетический юридический адрес перевозчика', phone: '+70000000004', edoId: 'SYNTHETICCARRIER' };
export function syntheticEtrnFixture() {
  const trip: ShipmentTrip = { id: 'trip-synthetic', fields: { date: '2025-04-01', organization_id: 'artel', supplier_id: 'supplier-synthetic', driver_id: 'driver-synthetic', vehicle_id: 'vehicle-synthetic', product_id: 'product-synthetic', quantity_tonnes: '11.5', loading_address: 'Синтетическая площадка погрузки', loading_planned_at: '2025-04-01T08:15', loading_actual_at: '2025-04-01T08:45', purchase_price_unspecified_unit: 'private-accounting-only' }, customers: [
    { id: 'shipment-synthetic-one', version: 2, paidAmount: '10000', fields: { customer_id: 'customer-synthetic', quantity_litres: '7125', unloading_address: 'Синтетическая площадка получателя', unloading_planned_at: '2025-04-01T14:00', sale_price_per_litre: 'private-accounting-only' } },
    { id: 'shipment-synthetic-two', version: 3, paidAmount: null, fields: { customer_id: 'customer-other', quantity_litres: '1000' } },
  ] };
  const source = {
    companies: [{ id: 'customer-synthetic', name: 'Синтетический получатель', inn: '0261947385', kpp: '026817294', address: 'Синтетический юридический адрес получателя', phone: '+70000000002' }],
    shipments: [{ id: 'shipment-synthetic-one', fields: { quantity_tonnes: '9.987654321' } }],
    directories: { drivers: [{ id: 'driver-synthetic', name: 'Тест', fullName: 'ВодительТестовый Тест Синтетикович', phone: '+70000000005', inn: '048172639504', licenseSeries: '0009', licenseNumber: '000098', licenseIssuedAt: '2020-02-01', passportNumber: 'NEVER-COPY' }], vehicles: [{ id: 'vehicle-synthetic', plate: 'Т000ТТ00', vin: 'SYNTHETICVIN00001', stsSeries: '00', stsNumber: '000000', vehicleType: 'Синтетический тип', brand: 'Синтетическая марка', capacityLitres: '12340', maxWeight: '27900' }] },
  } as unknown as Snapshot;
  const profile = readSabyConsignmentProfile({
    confirmed: true, consignorIsForwarder: '0', order: { number: 'SYNTHETIC-ORDER', date: '2025-03-31' },
    signer: { surname: 'ПодписантТестовый', name: 'ТестПодписанта', patronymic: 'Синтетикович', position: 'Синтетическая должность', status: '1' },
    recipient: { ...source.companies[0], edoId: '' },
    cargo: { name: 'Синтетический груз', condition: 'Синтетическое состояние', packagingCode: '00', packingMethod: 'Синтетическая упаковка', packageCount: '2', marking: 'Синтетическая маркировка', massMethod: '02', dangerousGoods: null },
    deliveryMassTonnes: '5.123125', vehicle: { type: 'Синтетический тип', brand: 'Синтетическая марка', payloadTonnes: '18.76', capacityCubicMetres: '12.34', ownershipType: '3', ownershipDocument: { name: 'Синтетическое основание владения', number: 'SYNTHETIC-LEASE', date: '2025-03-01', issuerInns: ['059381746205'] } },
    driver: { surname: 'ВодительТестовый', name: 'Тест', patronymic: 'Синтетикович' }, loading: { arrivedAt: '2025-04-01T08:20:30', departedAt: '2025-04-01T09:25:35' },
    loadingActor: { sameAsConsignor: true }, infrastructureOwner: { sameAsConsignor: true },
    instructions: { regulatory: 'Синтетические указания', redirectionParty: 'Грузоотправитель', redirectionMethod: 'Телефон', redirectionPhone: '+70000000001', transshipmentForbidden: '1' },
  });
  return { source, trip, profile, snapshot: buildSabyConsignmentSnapshot(source, trip, trip.customers[0].id, sender, carrier, profile) };
}

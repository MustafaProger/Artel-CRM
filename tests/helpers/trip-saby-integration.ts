import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { emptyDirectories } from '../../server/directory-operations';
import { OperationsStore } from '../../server/operations-store';
import { loadSnapshot } from '../../server/local-api';
import { saveShipmentTrip } from '../../server/shipment-trips';
import { SabyClient, type SabyConfig, type SabyObject } from '../../server/saby-client';
import { prepareTripSaby, type TripSabyAutofillSettings } from '../../server/trip-saby-preparation';
import type { PrepareTripSaby } from '../../server/trip-saby-workflow';
import { sender, carrier } from './etrn-fixture';

export const integrationSettings: TripSabyAutofillSettings = { signerStatus: '1', instructions: { redirectionParty: 'Грузоотправитель', redirectionMethod: 'Телефон', redirectionPhone: '+70000000001' }, loadingByAddressId: { loading: { loadingActorCompanyId: 'supplier', infrastructureOwnerCompanyId: 'supplier' } } };
export const integrationConfig = (): SabyConfig => ({ sessionId: 'private-integration-session', customer: sender, carrier, consignmentSigner: { surname: 'ПодписантТестовый', name: 'Тест', patronymic: '', position: 'Директор' }, transportProfile: { function: 'Заявка', contract: { name: 'Синтетический договор', number: 'SYNTHETIC-CONTRACT', date: '2025-01-01', issuerInns: [sender.inn, carrier.inn] }, regulatoryInstructions: '', foodInstructions: 'Отсутствуют', signatory: { surname: 'ПодписантТестовый', name: 'Тест', position: 'Директор', authorityMethod: '1' }, cargoByProductId: { product: { name: 'Синтетический ДТ', condition: 'Жидкий', packagingCode: 'TY', packageCount: '1', massMethod: '03', distributable: '1', divisible: '1', heightMetres: '1', lengthMetres: '1', widthMetres: '1', dangerousGoods: null } }, vehicleById: {} } });
export const integrationPrepare: PrepareTripSaby = (source, data, trip, config) => prepareTripSaby(source, data, trip, config, integrationSettings);
export async function integrationRuntime() {
  const directory = await mkdtemp(resolve(tmpdir(), 'artel-trip-saby-integration-')); const snapshotDirectory = resolve(directory, 'snapshot'); await mkdir(snapshotDirectory);
  const source = 'b'.repeat(64);
  const meta = { source_file: 'synthetic.xlsx', source_sha256: source, created_at_utc: '2025-01-01T00:00:00Z', source_kind: 'test', google_verified: false, formula_policy: '', ownership_policy: '' };
  const validation = { status: 'ok', registry_verified: false, issue_counts: {}, cell_issues: [], record_flag_counts: {}, duplicate_record_candidates: [], legal_form_alias_candidate_groups: [], multiple_manager_companies: [], limitations: [] };
  const files: Record<string, { sha256: string; bytes: number }> = {};
  for (const name of ['companies', 'shipments', 'payments', 'stock_summaries', 'manager_labels', 'validation_report']) {
    const raw = JSON.stringify({ meta, data: name === 'validation_report' ? validation : [] }); await writeFile(resolve(snapshotDirectory, `${name}.json`), raw); files[`${name}.json`] = { sha256: createHash('sha256').update(raw).digest('hex'), bytes: Buffer.byteLength(raw) };
  }
  await writeFile(resolve(snapshotDirectory, 'manifest.json'), JSON.stringify({ meta, counts: {}, files }));
  const base = await loadSnapshot(snapshotDirectory); const store = new OperationsStore(resolve(directory, 'store'));
  await store.mutate(source, data => {
    data.companies = [
      { ...carrier, id: 'carrier', roles: ['carrier'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] },
      { id: 'supplier', name: 'Синтетический поставщик', inn: '7707083893', kpp: '770701001', address: 'Синтетический юридический адрес', phone: '+70000000007', roles: ['supplier'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] },
      { id: 'customer', name: 'ИП ПолучательТестовый Тест', inn: '010000000102', address: 'Синтетический юридический адрес ИП', phone: '+70000000008', roles: ['customer'], managerLabels: [], shipmentIds: [], paymentIds: [], flags: [] },
    ];
    data.directories = { ...emptyDirectories(), fleetSeedApplied: true, managers: [{ id: 'manager', name: 'Тест' }], products: [{ id: 'product', name: 'ДТ', documentName: 'Синтетическое дизельное топливо', transportProductKind: 'diesel', cargoPackaging: 'bulk', dangerousGoodsSource: 'Синтетический паспорт', dangerousGoodsUnNumber: '1202', dangerousGoodsShippingName: 'ТОПЛИВО ДИЗЕЛЬНОЕ', dangerousGoodsClass: '3', dangerousGoodsClassificationCode: 'F1', dangerousGoodsPackingGroup: 'III', dangerousGoodsHazardSign: '3', dangerousGoodsTunnelCode: 'D/E' }], paymentForms: [{ id: 'payment', name: 'б/нал' }], vehicles: [{ id: 'vehicle', carrierId: 'carrier', plate: 'Т001ЕЕ777', vehicleType: 'Синтетическая цистерна', transportVehicleType: 'Синтетическая цистерна', brand: 'Синтетическая марка', capacityLitres: '25000', payloadTonnes: '20', payloadSource: 'Синтетический ПТС', ownershipType: '1' }], drivers: [{ id: 'driver', carrierId: 'carrier', name: 'Тест', fullName: 'ВодительТестовый Тест', phone: '+70000000003', inn: '048172639504', vehicleId: 'vehicle' }], oilDepots: [{ id: 'depot', name: 'Синтетическая нефтебаза', address: 'Синтетическая погрузка', ownerCompanyId: 'supplier', loadingActorCompanyId: 'supplier', infrastructureOwnerCompanyId: 'supplier' }], addresses: [{ id: 'loading', companyId: 'supplier', kind: 'loading', name: 'Погрузка', address: 'Синтетическая погрузка' }, { id: 'delivery', companyId: 'customer', kind: 'delivery', name: 'Доставка', address: 'Синтетическая доставка', receiverName: 'ПриёмщикТестовый Тест', receiverPhone: '+70000000009' }] };
    return { result: null, changed: true };
  });
  const created = await store.mutate(source, data => ({ result: saveShipmentTrip(base, data, { fields: { organization_id: 'artel', date: '2025-04-01', supplier_id: 'supplier', carrier_id: 'carrier', oil_depot_id: 'depot', product_id: 'product', purchase_price_unspecified_unit: '50000', quantity_tonnes: '12', quantity_gross_tonnes: '12', driver_id: 'driver', vehicle_id: 'vehicle', loading_planned_at: '2025-04-01T09:00', additional_costs: '0', intermediate_stops_in_order: 'true' }, customers: [0, 1].map(index => ({ fields: { customer_id: 'customer', manager_id: 'manager', payment_form_id: 'payment', quantity_litres: index ? '6000' : '8000', sale_price_per_litre: '60', transport_amount: '1000', unloading_address_id: 'delivery', unloading_planned_at: '2025-04-01T09:00', intermediate_stops_after: index ? null : JSON.stringify([{ id: 'synthetic-stop', name: 'Собственная остановка', address: 'Точка только общей заявки' }]) } })) }), changed: true }));
  const facts = () => ({ arrivedAt: '2025-04-01T09:01', departedAt: '2025-04-01T10:03', deliveries: Object.fromEntries(created.trip.customers.map((row, index) => [row.id, { grossMassTonnes: index ? '5.2' : '7', massMethod: '02' }])) });
  return { directory, snapshotDirectory, source, base, store, tripId: created.trip.id, trip: created.trip, prepare: integrationPrepare, authorize: () => undefined, facts, close: () => rm(directory, { recursive: true, force: true }) };
}
export type IntegrationRpc = { method: string; params: Record<string, SabyObject>; id: number };
export function integrationApi() {
  const calls: IntegrationRpc[] = []; const docs = new Map<string, SabyObject>(); let carrierXml = ''; const contents = new Map<string, Buffer>();
  const json = (req: IntegrationRpc, result: unknown) => new Response(JSON.stringify({ jsonrpc: '2.0', id: req.id, result }));
  const send: typeof fetch = async (_url, init) => {
    if (init?.method === 'GET') return new Response(String(_url).includes('carrier.xml') ? Buffer.from(carrierXml, 'utf8') : contents.get(String(_url)));
    const req = JSON.parse(String(init?.body)) as IntegrationRpc; calls.push(req);
    if (req.method === 'СБИС.СписокНашихОрганизаций') return json(req, { НашаОрганизация: [{ СвЮЛ: req.params.Фильтр.НашаОрганизация.СвЮЛ, ДокументооборотПодключен: 'Да' }] });
    if (req.method === 'СБИС.ЗаписатьДокумент') {
      const input = req.params.Документ; const id = String(input.Идентификатор ?? `remote-${docs.size + 1}`); const type = String(input.Тип);
      const doc: SabyObject = { ...docs.get(id), ...input, Идентификатор: id, Номер: input.Номер ?? String(type === 'TransportOrder' ? 41 : 100 + [...docs.values()].filter(row => row.Тип === type).length), Редакция: [{ Идентификатор: `${id}-revision`, Актуален: 'Да' }], Состояние: { Название: 'Черновик' }, Код: { Состояние: '0' }, СсылкаДляНашаОрганизация: `https://online.saby.ru/document/${id}`, Вложение: input.Вложение ? [{ Идентификатор: `${id}-title`, Редакция: { Номер: '1', ДатаВремя: '01.04.2025 10:00:00' }, Тип: type === 'TransportOrder' ? 'ЗаказЗаявка' : 'ЭТрН', Подтип: type === 'TransportOrder' ? '1110361' : '1110339', ВерсияФормата: '5.01', Файл: { Имя: `${id}.xml`, Ссылка: `https://disk.saby.ru/${id}.xml` } }] : [], ...(type === 'ConsignmentNote' ? { Стороны: { Отправитель: input.Грузоотправитель, Перевозчик: input.ТранспортнаяКомпания, Получатель: input.Грузополучатель } } : {}) };
      if (input.Вложение) contents.set(`https://disk.saby.ru/${id}.xml`, Buffer.from(String(((input.Вложение as SabyObject[])[0].Файл as SabyObject).ДвоичныеДанные), 'base64'));
      docs.set(id, doc); return json(req, doc);
    }
    if (req.method === 'СБИС.ПрочитатьДокумент') return json(req, docs.get(String(req.params.Документ.Идентификатор)));
    if (req.method === 'СБИС.СписокДокументов') return json(req, { Документ: [...docs.values()].filter(row => row.Тип === req.params.Фильтр.Тип), Навигация: { ЕстьЕще: 'Нет' } });
    throw new Error('Unexpected synthetic method');
  };
  const accept = () => {
    const doc = [...docs.values()].find(row => row.Тип === 'TransportOrder')!; delete doc.Код; doc.Состояние = { Код: '7', Название: 'Утверждено' };
    const upload = calls.find(row => row.method === 'СБИС.ЗаписатьДокумент' && row.params.Документ.Тип === 'TransportOrder' && row.params.Документ.Вложение)!.params.Документ;
    void upload; const senderBytes = contents.get(`https://disk.saby.ru/${String(doc.Идентификатор)}.xml`)!; const xml = new TextDecoder(senderBytes.subarray(0, 100).toString('ascii').includes('utf-8') ? 'utf-8' : 'windows-1251').decode(senderBytes);
    carrierXml = `<?xml version="1.0" encoding="utf-8"?><Файл><Документ КНД="1110362"><ИдИнфГО ИдФайлИнфГО="${/ИдФайл="([^"]+)"/.exec(xml)![1]}" ДатФайлИнфГО="${/ДатИнфГО="([^"]+)"/.exec(xml)![1]}" ВрФайлИнфГО="${/ВрИнфГО="([^"]+)"/.exec(xml)![1]}" ЭП="synthetic-sender-signature"/><СодИнфПрв СодОпер="1" УИД_Зак="synthetic-uid"/></Документ></Файл>`;
    (doc.Вложение as SabyObject[]).push({ Идентификатор: 'carrier-title', Редакция: { Номер: '1', ДатаВремя: '01.04.2025 11:00:00' }, Подтип: '1110362', ВерсияФормата: '5.01', Файл: { Имя: 'carrier.xml', Ссылка: 'https://disk.saby.ru/carrier.xml' }, Подпись: [{ Сертификат: { Отпечаток: 'synthetic-carrier-certificate' } }] });
  };
  const prepareSender = (changeBusiness = false) => {
    const doc = [...docs.values()].find(row => row.Тип === 'TransportOrder')!; const url = `https://disk.saby.ru/${String(doc.Идентификатор)}.xml`;
    let xml = new TextDecoder('windows-1251').decode(contents.get(url)!).replace(/ИдФайл="[^"]+"/, 'ИдФайл="SABY-PREPARED-SENDER"').replace(/ВерсПрог="[^"]+"/, 'ВерсПрог="Saby"').replace(/ДатИнфГО="[^"]+"/, 'ДатИнфГО="02.04.2025"').replace(/ВрИнфГО="[^"]+"/, 'ВрИнфГО="12:34:56"').replace(/encoding="windows-1251"/, 'encoding="utf-8"');
    if (changeBusiness) xml = xml.replace('МасБрутЗнач="12000"', 'МасБрутЗнач="14200"');
    // Decode by declared UTF-8 while all synthetic headers and business fields remain XML.
    contents.set(url, Buffer.from(xml, 'utf8'));
  };
  return { send, calls, docs, json, accept, prepareSender, client: () => new SabyClient(integrationConfig(), send), writes: (type?: string) => calls.filter(row => row.method === 'СБИС.ЗаписатьДокумент' && (!type || row.params.Документ.Тип === type)), reserves: (type?: string) => calls.filter(row => row.method === 'СБИС.ЗаписатьДокумент' && !row.params.Документ.Идентификатор && (!type || row.params.Документ.Тип === type)) };
}

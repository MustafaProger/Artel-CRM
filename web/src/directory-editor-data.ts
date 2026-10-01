import type { Company, ShipmentAddress, Snapshot, Vehicle } from './model'
import { companyFields, driverFields, allVehicleFields, productTransportFields, vehicleTransportFields } from './directory-fields'
import { customerManagerId } from './customer-manager'

export type EditorTab = 'customers'|'suppliers'|'loadingParty'|'oilDepots'|'managers'|'products'|'paymentForms'|'vehicles'|'drivers'|'addresses'|'customerManagers'
const companyTab = (tab: EditorTab) => ['customers','suppliers','loadingParty'].includes(tab)
export function directoryEntry(data: Snapshot, tab: EditorTab, id?: string) {
  return companyTab(tab) ? data.companies.find(row=>row.id===id) : tab==='customerManagers' ? undefined : (data.directories![tab as Exclude<EditorTab,'customers'|'suppliers'|'loadingParty'|'customerManagers'>]??[]).find(row=>row.id===id)
}
export function directoryDraft(data: Snapshot, tab: EditorTab, id?: string) {
  const entry=directoryEntry(data,tab,id), company=companyTab(tab)?entry as Company|undefined:undefined
  return {
    fields:Object.fromEntries(Object.entries(entry??{}).filter(([,value])=>typeof value==='string')) as Record<string,string>,
    sections:tab==='vehicles'?(entry as Vehicle|undefined)?.compartmentsLitres?.join(' + ')??'':'',
    roles:company?.roles.filter(role=>['customer','supplier','carrier','other'].includes(role))??[tab==='customers'?'customer':tab==='suppliers'?'supplier':'other'],
    companyId:id??'', managerId:customerManagerId(data.directories!,id??''),
    addresses:data.directories!.addresses.filter(address=>address.companyId===id).map(({companyId:_companyId,...address})=>address),
  }
}
type Draft = { fields:Record<string,string>; sections:string; roles:string[]; companyId:string; managerId:string; addresses:Omit<ShipmentAddress,'companyId'>[] }
export function directoryPayload(tab: EditorTab, {fields,sections,roles,companyId,managerId,addresses}: Draft) {
  const payload:Record<string,unknown> = companyTab(tab) ? {...Object.fromEntries(companyFields.map(([key])=>[key,fields[key]??''])),name:fields.name,inn:fields.inn??'',roles,defaultDriverId:fields.defaultDriverId??'',defaultVehicleId:fields.defaultVehicleId??'',managerId:managerId||null,addresses:addresses.map(({id,...address})=>({...(id?{id}:{}),...address}))}
        : tab === 'vehicles' ? Object.fromEntries(['plate','name','brand','model','trailer','capacityLitres','carrierId',...allVehicleFields.map(([key])=>key),...vehicleTransportFields.map(([key])=>key)].map(key=>[key,fields[key]??'']))
        : tab === 'products' ? {name:fields.name,...Object.fromEntries(productTransportFields.map(([key])=>[key,fields[key]??'']))}
        : tab === 'drivers' ? {...Object.fromEntries(driverFields.map(([key])=>[key,fields[key]??''])),name:fields.name,phone:fields.phone??'',vehicleId:fields.vehicleId??'',carrierId:fields.carrierId??''} : tab === 'oilDepots' ? Object.fromEntries(['name','address','mapUrl','latitude','longitude','ownerCompanyId','loadingActorCompanyId','infrastructureOwnerCompanyId'].map(key=>[key,fields[key]??''])) : tab === 'addresses' ? {name:fields.name,companyId:fields.companyId,addressKind:fields.addressKind??fields.kind??'delivery',address:fields.address??'',mapUrl:fields.mapUrl??'',latitude:fields.latitude??'',longitude:fields.longitude??'',receiverName:fields.receiverName??'',receiverPhone:fields.receiverPhone??'',loadingActorCompanyId:fields.loadingActorCompanyId??'',infrastructureOwnerCompanyId:fields.infrastructureOwnerCompanyId??''} : tab === 'customerManagers' ? {companyId,managerId:managerId||null} : {name:fields.name}
  if(tab==='vehicles')payload.compartmentsLitres=sections.trim()?sections.split(/[+;]/).map(value=>value.trim()):undefined
  return payload
}

// Compare editable values; address versions are concurrency tokens, not user edits.
function comparable(value: unknown): unknown {
  if(Array.isArray(value))return value.map(comparable)
  if(value && typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([key,value])=>key!=='version' && value!==undefined && value!==null && value!=='').sort(([a],[b])=>a.localeCompare(b)).map(([key,value])=>[key,comparable(value)]))
  return value??''
}
export const sameDirectoryValue = (a:unknown,b:unknown) => JSON.stringify(comparable(a))===JSON.stringify(comparable(b))
export function mergeDirectoryPayload(base:Record<string,unknown>, local:Record<string,unknown>, latest:Record<string,unknown>) {
  const merged={...latest}, conflicts:string[]=[]
  for(const key of new Set([...Object.keys(base),...Object.keys(local)])) {
    if(sameDirectoryValue(local[key],base[key]))continue
    if(!sameDirectoryValue(latest[key],base[key]) && !sameDirectoryValue(latest[key],local[key]))conflicts.push(key)
    merged[key]=local[key]
  }
  return {merged:withCurrentAddressVersions(merged,latest),conflicts}
}
export const directoryFieldLabel = (key:string) => Object.fromEntries([
  ...companyFields,...driverFields,...allVehicleFields,...productTransportFields,...vehicleTransportFields,
  ['name','Наименование'],['plate','Автомобиль / номер'],['brand','Марка'],['model','Модель'],['trailer','Прицеп'],['capacityLitres','Объём автомобиля, л'],['compartmentsLitres','Секции, л'],['roles','Тип компании'],['addresses','Адреса компании'],['managerId','Менеджер'],['vehicleId','Автомобиль по умолчанию'],['carrierId','Организация транспорта'],['inn','ИНН'],['phone','Телефон'],['addressKind','Тип адреса'],['companyId','Компания адреса'],['ownerCompanyId','Владелец нефтебазы'],['loadingActorCompanyId','Погрузчик'],['infrastructureOwnerCompanyId','Владелец площадки'],['mapUrl','Ссылка на карту'],['latitude','Широта'],['longitude','Долгота'],['receiverName','Приёмщик'],['receiverPhone','Телефон приёмщика'],['defaultDriverId','Водитель по умолчанию'],['defaultVehicleId','Автомобиль по умолчанию'],
])[key]??key

export function withCurrentAddressVersions(payload:Record<string,unknown>,latest:Record<string,unknown>) {
  if(!Array.isArray(payload.addresses)||!Array.isArray(latest.addresses))return payload
  const addresses=latest.addresses as {id?:string;version?:number}[]
  return {...payload,addresses:payload.addresses.map(row=>{
    const current=addresses.find(address=>row.id && address.id===row.id)
    return current?{...row,version:current.version??0}:row
  })}
}

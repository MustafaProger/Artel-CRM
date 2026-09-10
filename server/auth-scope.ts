import Decimal from 'decimal.js';
import type { AccountUser } from '../web/src/auth-model';
import type { Shipment, Snapshot } from '../web/src/model';
import { canManage } from './auth';
import { ApiError } from './api-error';
const Exact=Decimal.clone({precision:80});
export function ownsShipment(actor:AccountUser,row:Shipment){return canManage(actor) || !!actor.managerId && row.fields.manager_id===actor.managerId;}
export function scopeSnapshot(snapshot:Snapshot,actor:AccountUser):Snapshot {
  if(canManage(actor))return snapshot;
  const shipments=snapshot.shipments.filter(row=>ownsShipment(actor,row));
  const ids=new Set(shipments.map(s=>s.id));
  const metric=(values:(string|null)[])=>{const valid=values.filter((v):v is string=>v!==null && /^[+-]?\d+(?:\.\d+)?$/.test(v));return {total:valid.length?valid.reduce((sum,v)=>sum.plus(v),new Exact(0)).toFixed():null,numericCount:valid.length,missingCount:values.length-valid.length};};
  const totals=(rows:Shipment[])=>({shipmentCount:rows.length,paymentCount:0,liters:metric(rows.map(r=>r.liters)),revenue:metric(rows.map(r=>r.revenue)),cost:metric(rows.map(r=>r.cost)),incoming:metric([]),outgoing:metric([])});
  const dates=shipments.flatMap(s=>s.date?[s.date]:[]).sort();
  return {...snapshot,directories:snapshot.directories ? {...snapshot.directories, assignedCustomerIds:(snapshot.directories.customerManagers ?? []).filter(link => link.managerId === actor.managerId).map(link => link.companyId)} : undefined,shipments,payments:[],stocks:[],companies:snapshot.companies.map(c=>({...c,shipmentIds:c.shipmentIds.filter(id=>ids.has(id)),paymentIds:[],managerLabels:[],flags:[]})),managers:[],
    overview:{...totals(shipments),companyCount:snapshot.companies.length,missingShipmentDates:shipments.filter(s=>!s.date).length,missingPaymentDates:0},
    monthly:[...new Set(dates.map(d=>d.slice(0,7)))].map(month=>({month,...totals(shipments.filter(s=>s.date?.startsWith(month)))})),
    provenance:{...snapshot.provenance,counts:{shipment_rows:shipments.length,counterparties:snapshot.companies.length},dateRange:{from:dates[0]??null,to:dates.at(-1)??null}},
    quality:{status:'scoped',issueCounts:{},issues:[],recordFlagCounts:{shipments:{},payments:{}},flaggedShipmentCount:0,flaggedPaymentCount:0,duplicateCandidates:[],aliasCandidates:[],multipleManagerCompanyIds:[],limitations:[]}};
}
export function checkShipmentWrite(actor:AccountUser,fields:Record<string,string|null>,previous?:Shipment){
  if(canManage(actor))return;
  if(previous && !ownsShipment(actor,previous))throw new ApiError(404,'Отгрузка не найдена.');
  if(!actor.managerId || fields.manager_id!==actor.managerId)throw new ApiError(403,'Можно сохранять только свои отгрузки.');
}

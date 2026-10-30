// Local review only: synthetic store, no provider access. Never loaded by the production bundle.
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { integrationRuntime, integrationConfig } from '../tests/helpers/trip-saby-integration.ts';
import { startTripsQaServer } from './qa-trips-runtime.mjs';
import { bootstrapQaAuth } from './qa-auth.mjs';
import { SabyClient } from '../server/saby-client.ts';
const root=resolve(import.meta.dirname,'..'), rt=await integrationRuntime();
const client=new SabyClient(integrationConfig(),async()=>{throw new Error('External provider disabled for local preview');});
const runtime=await startTripsQaServer({root,snapshotDirectory:rt.snapshotDirectory,operationsDirectory:resolve(rt.directory,'store'),sabyClient:client,port:5193});
const {cookie}=await bootstrapQaAuth(runtime.base);
const call=async(path,method='GET',body,cookieValue=cookie)=>{
 const res=await fetch(runtime.base+path,{method,headers:{cookie:cookieValue,'Content-Type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});const value=await res.json();if(!res.ok)throw new Error(`${path}: ${value.error}`);return value;
};
await rt.store.mutate(rt.source,data=>{
 data.shipments={};
 const customer=data.companies.find(c=>c.id==='customer'); customer.name='Стройснаб · демо';
 data.companies.find(c=>c.id==='supplier').name='Комплекс Ойл · демо';
 data.companies.push({...structuredClone(customer),id:'customer-two',name:'Бетонный завод · демо',inn:undefined});
 data.directories.vehicles[0].plate='М442НО797';data.directories.drivers[0].name='Пётр · демо';data.directories.drivers[0].fullName='Пётр · демо';
 data.directories.vehicles.push({...data.directories.vehicles[0],id:'vehicle-two',plate:'А477АА777'});
 data.directories.drivers.push({...data.directories.drivers[0],id:'driver-two',name:'Геннадий · демо',fullName:'Геннадий · демо',vehicleId:'vehicle-two'});
 data.directories.oilDepots[0].address='Московская область, село Константиново, 105Б';
 data.directories.addresses.find(a=>a.id==='delivery').address='Котельники, Промзона Силикат, с9';
 data.directories.addresses.push({...data.directories.addresses.find(a=>a.id==='delivery'),id:'delivery-two',companyId:'customer-two',address:'Москва, район Коммунарка, улица Александры Монаховой, 10'});
 return {changed:true,result:null};
});
const driverCookies={};
for(const id of ['driver','driver-two']){
 const access=await call(`/api/drivers/${id}/access`,'POST',{action:'issue',version:0});
 const response=await fetch(runtime.base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({login:access.access.login,password:access.temporaryPassword})});
 if(!response.ok)throw new Error('Preview driver login failed');driverCookies[id]=response.headers.get('set-cookie').split(';')[0];
}
let previewDriverTrip;
for(let i=0;i<7;i++){
 const driverId=i>=4?'driver-two':'driver';
 const fields=Object.fromEntries(['organization_id','supplier_id','carrier_id','oil_depot_id','product_id','purchase_price_unspecified_unit','additional_costs'].map(k=>[k,rt.trip.fields[k]]));
 Object.assign(fields,{driver_id:driverId,vehicle_id:i>=4?'vehicle-two':'vehicle',trip_flow_version:'driver-v1',purchase_price_unspecified_unit:'77000',loading_at:`2026-10-${27-Math.floor(i/3)}T09:00`,trip_notes:'Локальный демонстрационный рейс. Все события условные, внешние системы отключены.'});
 const customers=rt.trip.customers.map((row,j)=>({fields:{...Object.fromEntries(['manager_id','payment_form_id','sale_price_per_litre','transport_amount'].map(k=>[k,row.fields[k]])),customer_id:j?'customer-two':'customer',unloading_address_id:j?'delivery-two':'delivery',quantity_litres:j?'5500':'4000',sale_price_per_litre:j?'73':'70',transport_amount:j?'7000':'8000',etrn_not_required:'true',invoice_not_required:'true'}}));
 const created=await call('/api/shipment-trips','POST',{fields,customers,idempotencyKey:randomUUID()});
 const path=`/api/driver/trips/${created.trip.id}`, dc=driverCookies[driverId];let trip=(await call(path,'GET',null,dc)).trip;
 const stage=['delivering','enroute','loading','completed','planned','enroute','completed'][i];
 if(stage!=='planned')trip=(await call(path+'/arrive','POST',{versions:trip.versions},dc)).trip;
 if(!['planned','loading'].includes(stage))trip=(await call(path+'/depart','POST',{versions:trip.versions,masses:trip.deliveries.map(d=>({deliveryId:d.id,netTonnes:'4.274'}))},dc)).trip;
 if(['delivering','completed'].includes(stage))trip=(await call(path+'/deliver','POST',{versions:trip.versions,executionVersion:trip.execution.version,deliveryId:trip.deliveries[0].id},dc)).trip;
 if(stage==='completed')trip=(await call(path+'/deliver','POST',{versions:trip.versions,executionVersion:trip.execution.version,deliveryId:trip.deliveries[1].id},dc)).trip;
 if(i===0)previewDriverTrip=trip.id;
}
runtime.server.middlewares.stack.unshift({route:'',handle(req,res,next){
 const path=new URL(req.url,runtime.base).pathname;
 if(path!=='/__preview' && path!=='/__driver')return next();
 const driver=path==='/__driver';res.setHeader('Set-Cookie',`${driver?driverCookies.driver:cookie}; Path=/; HttpOnly; SameSite=Strict`);res.writeHead(302,{Location:driver?`/#driver-trip/${previewDriverTrip}`:'/#trips'});res.end();
}});
console.log(`LOCAL_PREVIEW ${runtime.base}/__preview`);
console.log(`LOCAL_DRIVER ${runtime.base}/__driver`);
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,async()=>{await runtime.server.close();await rt.close();process.exit(0)});

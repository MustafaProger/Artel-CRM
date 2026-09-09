import { useEffect, useMemo, useRef, useState } from 'react'
import { LoaderCircle, Save, X } from 'lucide-react'
import type { Company, Directories, Shipment } from './model'
import DirectorySelect from './DirectorySelect'
import { calculateShipment, today } from './shipment-calculations'
import { number, monthName, formatDate } from './utils'
import ShipmentTripEditor from './ShipmentTripEditor'

export interface ShipmentEditorProps {
  shipment: Shipment | null; companies: Company[]; directories: Directories; defaultPaymentForm?: string; onClose: () => void; onSaved: (shipment: Shipment) => void
}
export default function ShipmentEditor(props: ShipmentEditorProps) {
  return !props.shipment || props.shipment.fields.trip_id ? <ShipmentTripEditor {...props}/> : <LegacyShipmentEditor {...props}/>
}

const manualKeys = ['date','customer_id','supplier_id','manager_id','product_id','payment_form_id','quantity_tonnes','quantity_litres','sale_price_per_litre','purchase_price_unspecified_unit','purchase_unit','loading_address_id','unloading_address_id','driver_id','vehicle_id','transport_amount','additional_costs','payment_due_date']
function LegacyShipmentEditor({ shipment, companies, directories, defaultPaymentForm = 'б/нал', onClose, onSaved }: ShipmentEditorProps) {
  const dialog = useRef<HTMLDialogElement>(null)
  const initial = useMemo(() => {
    const values = Object.fromEntries(manualKeys.map(k => [k,shipment?.fields[k] ?? '']))
    return {...values,date:shipment?.date ?? today(),customer_id:shipment?.customerId ?? '',supplier_id:shipment?.supplierId ?? '',
      manager_id:shipment?.fields.manager_id || directories.managers.find(m => m.name === shipment?.manager)?.id || '',
      product_id:shipment?.fields.product_id || directories.products.find(p => p.name.toLocaleLowerCase('ru') === shipment?.product?.toLocaleLowerCase('ru'))?.id || '',
      payment_form_id:shipment?.fields.payment_form_id || directories.paymentForms.find(p => p.name === (shipment?.fields.payment_form ?? defaultPaymentForm))?.id || '',
      purchase_unit:shipment?.fields.purchase_unit || shipment?.calculationRules?.purchase || '',
      vehicle_id:shipment?.fields.vehicle_id || directories.drivers.find(d=>d.id===shipment?.fields.driver_id)?.vehicleId || '',
      transport_amount:shipment?.fields.transport_amount ?? '0',additional_costs:shipment?.fields.additional_costs ?? '0',
    } as Record<string,string>
  }, [shipment,directories,defaultPaymentForm])
  const [fields,setFields] = useState(initial), [saving,setSaving] = useState(false), [error,setError] = useState(''), [confirmClose,setConfirmClose] = useState(false)
  const dirty = manualKeys.some(k => fields[k] !== initial[k])
  useEffect(() => {
    const element = dialog.current, focused = document.activeElement as HTMLElement | null, old = document.body.style.overflow
    element?.showModal();document.body.style.overflow='hidden'
    return () => {element?.close();document.body.style.overflow=old;focused?.focus()}
  },[])
  const update = (key: string,value: string) => {setFields(previous => ({...previous,[key]:value,...(key==='customer_id'?{unloading_address_id:''}:key==='supplier_id'?{loading_address_id:''}:key==='driver_id'?{vehicle_id:directories.drivers.find(d=>d.id===value)?.vehicleId || ''}:{})}));setConfirmClose(false)}
  const close = () => {if(saving)return;if(dirty)setConfirmClose(true);else onClose()}
  const customer = companies.find(c=>c.id===fields.customer_id), supplier=companies.find(c=>c.id===fields.supplier_id)
  const vehicle=directories.vehicles.find(v=>v.id===fields.vehicle_id)
  const historical = !!shipment && shipment.fields.calculation_mode !== 'automatic'
  const financialChange = ['quantity_litres','quantity_tonnes','sale_price_per_litre','purchase_price_unspecified_unit','purchase_unit','transport_amount','additional_costs'].some(k=>fields[k]!==initial[k])
  const calculation = calculateShipment({...shipment?.fields,...fields},{sale:historical ? shipment.calculationRules?.sale ?? null : 'litres',purchase:fields.purchase_unit as 'litres'|'tonnes'||null,profit:shipment?.calculationRules?.profit ?? directories.defaults.profit,debtSign:'paid-minus-sale'},{historical,recalculate:financialChange,changedFields:manualKeys.filter(k=>fields[k]!==initial[k])})
  const save = async (event: React.FormEvent) => {
    event.preventDefault();if(saving)return;setSaving(true);setError('')
    const changed = Object.fromEntries(manualKeys.filter(key=>shipment ? fields[key]!==initial[key] : fields[key] !== '').map(key=>[key,fields[key].trim() || null]))
    try {
      const response = await fetch(shipment?`/api/shipments/${encodeURIComponent(shipment.id)}`:'/api/shipments',{method:shipment?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:changed,...(shipment?{version:shipment.version??0}:{})})})
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось сохранить отгрузку');onSaved(result.shipment)
    } catch(e) {setError(e instanceof Error?e.message:'Нет связи с сервером')} finally {setSaving(false)}
  }
  const select = (label: string,key: string,entries: {id:string;name:string;detail?:string}[],options: {disabled?:boolean;required?:boolean;legacy?:string|null}={}) => <DirectorySelect key={key} label={label} entries={entries} value={fields[key]} onChange={id=>update(key,id)} disabled={saving||options.disabled} required={!shipment&&options.required} legacy={options.legacy}/>
  const input = (label: string,key: string,type='text',required=false) => <label className="shipment-field" key={key}><span>{label}{!shipment&&required?' *':''}</span><input type={type} inputMode={type==='text'?'decimal':undefined} value={fields[key]} required={!shipment&&required} disabled={saving} onChange={e=>update(key,e.target.value)}/></label>
  const output = (label: string,value?:string|null,money=false) => <div className="shipment-calculated" key={label}><span>{label}</span><output aria-label={label}>{value==null||value===''?'—':money?number(value,2):value}</output></div>
  const companyEntries=companies.map(c=>({id:c.id,name:c.name,detail:c.inn?`ИНН ${c.inn}`:'ИНН не указан в справочнике'}))
  return <dialog ref={dialog} className="shipment-editor" aria-labelledby="shipment-editor-title" onCancel={e=>{e.preventDefault();close()}}><form onSubmit={save} onKeyDown={e=>{
    if(e.key==='Enter' && e.target instanceof HTMLInputElement && e.target.getAttribute('role')!=='combobox') {e.preventDefault();const controls=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('input:not(:disabled),select:not(:disabled),button[type="submit"]'));controls[controls.indexOf(e.target)+1]?.focus()}
  }}>
    <header className="shipment-editor-heading"><div><span>{shipment?'РЕДАКТИРОВАНИЕ':'НОВАЯ ОПЕРАЦИЯ'}</span><h2 id="shipment-editor-title">{shipment?'Изменить отгрузку':'Добавить отгрузку'}</h2></div><button type="button" className="icon-button" aria-label="Закрыть редактор" onClick={close} disabled={saving}><X size={23}/></button></header>
    <div className="shipment-editor-body"><p className="shipment-editor-note">Выбирайте готовые записи из справочников. Tab — следующее поле, стрелки и Enter — выбор из списка.</p>
      <fieldset className="shipment-fieldset group-operation"><legend>Основное</legend><div className="shipment-field-grid">
        {input('Дата операции','date','date',true)}{select('Менеджер','manager_id',directories.managers,{required:true,legacy:shipment?.manager})}{select('Форма оплаты','payment_form_id',directories.paymentForms,{required:true,legacy:shipment?.fields.payment_form})}{select('Товар','product_id',directories.products,{required:true,legacy:shipment?.product})}{input('Количество тонн','quantity_tonnes','text',true)}{input('Количество литров','quantity_litres','text',true)}
      </div><div className="shipment-calculation-strip">{output('Месяц',calculation.fields.month?monthName(calculation.fields.month):null)}</div></fieldset>
      <fieldset className="shipment-fieldset group-sale"><legend>Продажа</legend><div className="shipment-field-grid">
        {select('Контрагент','customer_id',companyEntries,{required:true})}{select('Адрес выгрузки','unloading_address_id',directories.addresses.filter(a=>a.kind==='delivery'&&a.companyId===fields.customer_id),{disabled:!fields.customer_id,legacy:fields.customer_id===initial.customer_id?shipment?.fields.unloading_address:null})}{input(shipment?.calculationRules?.sale==='tonnes'?'Цена продажи за тонну, ₽ (исходник)':'Цена продажи за литр, ₽','sale_price_per_litre','text',true)}{input('Срок оплаты','payment_due_date','date')}
      </div><div className="shipment-calculation-strip">{output('ИНН контрагента',customer?.inn??(fields.customer_id===initial.customer_id?shipment?.fields.customer_inn:null))}{output('Цена продажи за тонну, ₽',calculation.fields.sale_price_per_tonne,true)}{output('Сумма покупателя, ₽',calculation.fields.customer_amount,true)}</div></fieldset>
      <fieldset className="shipment-fieldset group-purchase"><legend>Закупка</legend><div className="shipment-field-grid">
        {select('Поставщик','supplier_id',companyEntries,{required:true})}{select('Адрес загрузки','loading_address_id',directories.addresses.filter(a=>a.kind==='loading'&&a.companyId===fields.supplier_id),{disabled:!fields.supplier_id,legacy:fields.supplier_id===initial.supplier_id?shipment?.fields.loading_address:null})}{input('Цена закупки, ₽','purchase_price_unspecified_unit','text',true)}<label className="shipment-field"><span>Единица цены закупки *</span><select aria-label="Единица цены закупки" value={fields.purchase_unit} required={!shipment} disabled={saving} onChange={e=>update('purchase_unit',e.target.value)}><option value="">Выберите единицу</option><option value="tonnes">₽ за тонну</option><option value="litres">₽ за литр</option></select></label>
      </div><div className="shipment-calculation-strip">{output('ИНН поставщика',supplier?.inn??(fields.supplier_id===initial.supplier_id?shipment?.fields.supplier_inn:null))}{output('Сумма закупки, ₽',calculation.fields.purchase_amount,true)}</div></fieldset>
      <fieldset className="shipment-fieldset group-delivery"><legend>Доставка</legend><div className="shipment-field-grid">
        {select('Водитель','driver_id',directories.drivers.map(d=>({...d,detail:directories.vehicles.find(v=>v.id===d.vehicleId)?.plate})),{legacy:shipment?.carrier?`${shipment.carrier} (из исходника)`:null})}{select('Автомобиль','vehicle_id',directories.vehicles.map(v=>({id:v.id,name:v.name || v.plate,detail:v.name&&v.name!==v.plate?v.plate:undefined})))}{input('Сумма перевозки, ₽','transport_amount')}{input('Дополнительные затраты, ₽','additional_costs')}
      </div><div className="shipment-calculation-strip">{output('Автомобиль / госномер',vehicle?.plate)}</div></fieldset>
      <fieldset className="shipment-fieldset group-settlement"><legend>Расчёты · автоматически</legend><div className="shipment-calculation-strip">
        {output('Прибыль, ₽',calculation.fields.profit_source,true)}{output('Оплачено, ₽',calculation.fields.paid_amount_source,true)}{output('Дата оплаты',calculation.fields.payment_date)}{output('Долг / переплата, ₽',calculation.fields.debt_overpayment_source,true)}{output('Просрочка, дней',calculation.fields.overdue_days)}
      </div><p className="shipment-editor-note">Минус — долг, плюс — переплата. Оплаты появятся после привязки банковских операций. Для просрочки укажите срок оплаты.</p>{calculation.warnings.map(w=><p key={w} className="shipment-calculation-warning">{w}</p>)}</fieldset>
      {!!shipment?.sourceRow&&<fieldset className="shipment-fieldset"><legend>Данные из Excel</legend><div className="shipment-calculation-strip">{output('Перевозчик',shipment.fields.carrier_name)}{output('КВП, ₽',shipment.fields.kvp_source,true)}{output('Срок из Excel, дней',shipment.fields.term_source)}{output('Дата из файла',shipment.fields.unlabelled_note&&/^\d{4}-\d{2}-\d{2}(?:T|$)/.test(shipment.fields.unlabelled_note)?formatDate(shipment.fields.unlabelled_note.slice(0,10)):shipment.fields.unlabelled_note)}</div><p className="shipment-editor-note">Сохранённые значения исходной строки. «Срок из Excel» рассчитан в файле и отличается от текущей просрочки. У столбца с датами в файле нет заголовка.</p></fieldset>}
      {error&&<div className="shipment-error" role="alert">{error}</div>}
    </div>
    <footer className="shipment-editor-footer">{confirmClose?<div className="shipment-discard" role="alert"><span>Есть несохранённые изменения.</span><button type="button" className="button" onClick={()=>setConfirmClose(false)}>Продолжить</button><button type="button" className="button danger" onClick={onClose}>Закрыть без сохранения</button></div>:<><button type="button" className="button" onClick={close} disabled={saving}>Отмена</button><button type="submit" className="button primary" disabled={saving||!!shipment&&!dirty}>{saving?<LoaderCircle className="spin" size={17}/>:<Save size={17}/>}Сохранить отгрузку</button></>}</footer>
  </form></dialog>
}

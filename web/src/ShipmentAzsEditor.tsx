import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react'
import { LoaderCircle, Save, X } from 'lucide-react'
import type { ShipmentEditorProps } from './ShipmentEditor'
import DirectorySelect from './DirectorySelect'
import { customerManagerId, availableShipmentCustomer } from './customer-manager'
import { calculateAzsShipment, today } from './shipment-calculations'
import { settlementKind } from './shipment-settlement'
import { formatDate, monthName, number } from './utils'

const manualKeys = ['document_number','date','customer_id','supplier_id','manager_id','product_id','payment_form_id','quantity_litres','customer_amount','purchase_amount']
export default function ShipmentAzsEditor({shipment,companies,directories,defaultPaymentForm='б/нал',onClose,onSaved}:ShipmentEditorProps) {
  const dialog=useRef<HTMLDialogElement>(null), savingRef=useRef(false)
  const initial=useMemo<Record<string,string>>(()=>({...Object.fromEntries(manualKeys.map(key=>[key,shipment?.fields[key]??''])),date:shipment?.date??today(),payment_form_id:shipment?.fields.payment_form_id??directories.paymentForms.find(entry=>entry.name===defaultPaymentForm&&['cash','cashless'].includes(settlementKind(entry.name)))?.id??''}),[shipment,directories,defaultPaymentForm])
  const [fields,setFields]=useState<Record<string,string>>(initial),[saving,setSaving]=useState(false),[error,setError]=useState(''),[confirmClose,setConfirmClose]=useState(false)
  const dirty=manualKeys.some(key=>fields[key]!==initial[key])
  useEffect(()=>{const element=dialog.current,focused=document.activeElement as HTMLElement|null,overflow=document.body.style.overflow;element?.showModal();document.body.style.overflow='hidden';return()=>{element?.close();document.body.style.overflow=overflow;focused?.focus()}},[])
  const update=(key:string,value:string)=>{setFields(previous=>({...previous,[key]:value,...(key==='customer_id'?{manager_id:customerManagerId(directories,value)}:{})}));setConfirmClose(false)}
  const close=()=>{if(savingRef.current)return;if(dirty)setConfirmClose(true);else onClose()}
  const paymentForm=directories.paymentForms.find(entry=>entry.id===fields.payment_form_id)?.name??null
  // The server owns payment allocations. Preview uses the last returned total as its opening amount.
  const calculated=calculateAzsShipment({...shipment?.fields,...fields,payment_form:paymentForm,opening_paid_amount:shipment?.fields.paid_amount_source??null},{historical:!!shipment})
  const customer=companies.find(entry=>entry.id===fields.customer_id),supplier=companies.find(entry=>entry.id===fields.supplier_id)
  const save=async(event:FormEvent)=>{
    event.preventDefault();if(savingRef.current)return;savingRef.current=true;setSaving(true);setError('')
    const changed=Object.fromEntries(manualKeys.filter(key=>!shipment||fields[key]!==initial[key]).map(key=>[key,fields[key].trim()||null]))
    try {
      const response=await fetch(shipment?`/api/shipments/${encodeURIComponent(shipment.id)}`:'/api/shipments',{method:shipment?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({fields:{...changed,shipment_type:'azs'},...(shipment?{version:shipment.version??0}:{})})})
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось сохранить отгрузку АЗС');onSaved(result.shipment)
    }catch(reason){setError(reason instanceof Error?reason.message:'Нет связи с сервером')}finally{savingRef.current=false;setSaving(false)}
  }
  const select=(label:string,key:string,entries:{id:string;name:string;detail?:string}[])=><DirectorySelect key={key} label={label} value={fields[key]} entries={entries} onChange={id=>update(key,id)} required disabled={saving}/>
  const input=(label:string,key:string,type='text',required=true)=><label className="shipment-field" key={key}><span>{label}{required?' *':''}</span><input aria-label={label} type={type} inputMode={type==='text'&&key!=='document_number'?'decimal':undefined} value={fields[key]} required={required} disabled={saving} onChange={event=>update(key,event.target.value)}/></label>
  const output=(label:string,value?:string|null,money=false)=><div className="shipment-calculated" key={label}><span>{label}</span><output aria-label={label}>{value==null||value===''?'—':money?number(value,2):value}</output></div>
  const companyEntries=(role:string,current:string)=>companies.filter(company=>(company.roles.includes(role)||company.id===current) && (role !== 'customer' || availableShipmentCustomer(directories, company.id, current))).map(company=>({id:company.id,name:company.name,detail:company.inn?`ИНН ${company.inn}`:'ИНН не указан'}))
  return <dialog ref={dialog} className="shipment-editor shipment-azs-editor" aria-labelledby="shipment-azs-title" onCancel={event=>{event.preventDefault();close()}}><form onSubmit={save}>
    <header className="shipment-editor-heading"><div><span>АЗС</span><h2 id="shipment-azs-title">{shipment?'Изменить отгрузку АЗС':'Добавить отгрузку АЗС'}</h2></div><button type="button" className="icon-button" aria-label="Закрыть редактор" disabled={saving} onClick={close}><X size={23}/></button></header>
    <div className="shipment-editor-body">
      <fieldset className="shipment-fieldset group-operation"><legend>Основное</legend><div className="shipment-field-grid">{input('УПД','document_number','text',false)}{input('Дата','date','date')}{select('Менеджер','manager_id',directories.managers)}{select('Форма оплаты','payment_form_id',directories.paymentForms.filter(entry=>['cash','cashless'].includes(settlementKind(entry.name))))}{select('Товар','product_id',directories.products)}</div><div className="shipment-calculation-strip">{output('Месяц',calculated.fields.month?monthName(calculated.fields.month):null)}</div></fieldset>
      <fieldset className="shipment-fieldset group-sale"><legend>Контрагент и количество</legend><div className="shipment-field-grid">{select('Контрагент','customer_id',companyEntries('customer',fields.customer_id))}{input('Количество литров','quantity_litres')}{input('Сумма покупателя, ₽','customer_amount')}</div><div className="shipment-calculation-strip">{output('ИНН контрагента',customer?.inn)}{output('Цена продажи за литр, ₽',calculated.fields.sale_price_per_litre,true)}</div><p className="shipment-calculation-warning">Цена продажи за литр: формула ожидает согласования.</p></fieldset>
      <fieldset className="shipment-fieldset group-purchase"><legend>Поставщик</legend><div className="shipment-field-grid">{select('Поставщик','supplier_id',companyEntries('supplier',fields.supplier_id))}{input('Сумма поставщика, ₽','purchase_amount')}</div><div className="shipment-calculation-strip">{output('ИНН поставщика',supplier?.inn)}</div></fieldset>
      <fieldset className="shipment-fieldset group-settlement"><legend>Расчёты</legend><div className="shipment-calculation-strip">{output('Прибыль, ₽',calculated.fields.profit_source,true)}{output('КВП',calculated.fields.kvp_source,true)}{output('Оплата, ₽',calculated.fields.paid_amount_source,true)}{output('Долг / переплата, ₽',calculated.fields.debt_overpayment_source,true)}{output('Дней с отгрузки',calculated.fields.days_since_shipment)}{output('Дата оплаты',calculated.fields.payment_date?formatDate(calculated.fields.payment_date):null)}</div>
        <p className="shipment-editor-note">Безнал: сумма покупателя − сумма поставщика. Наличные: сумма покупателя − сумма поставщика × 0,83. Оплата учитывается после привязки платежей. Минус — долг, плюс — переплата. Дни считаются до сегодня, пока отгрузка не оплачена полностью.</p>
        <p className="shipment-calculation-warning">Правило КВП ожидает согласования. Дата оплаты сохранена; её отображение в таблице нужно уточнить.</p>
      </fieldset>
      {error&&<div className="shipment-error" role="alert">{error}</div>}
    </div>
    <footer className="shipment-editor-footer">{confirmClose?<div className="shipment-discard" role="alert"><span>Есть несохранённые изменения.</span><button type="button" className="button" onClick={()=>setConfirmClose(false)}>Продолжить</button><button type="button" className="button danger" onClick={onClose}>Закрыть без сохранения</button></div>:<><button type="button" className="button" disabled={saving} onClick={close}>Отмена</button><button type="submit" className="button primary" disabled={saving||!!shipment&&!dirty}>{saving?<LoaderCircle className="spin" size={17}/>:<Save size={17}/>}Сохранить отгрузку</button></>}</footer>
  </form></dialog>
}

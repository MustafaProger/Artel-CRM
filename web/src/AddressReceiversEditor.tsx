import { Plus, Trash2 } from 'lucide-react'
import type { AddressReceiver, ShipmentAddress } from './model'

type Contacts = { receiverName: string; receiverPhone: string; additionalReceivers: AddressReceiver[] }
export default function AddressReceiversEditor({value,label,disabled,onChange}:{value:Pick<ShipmentAddress,'receiverName'|'receiverPhone'|'additionalReceivers'>;label:string;disabled:boolean;onChange:(value:Contacts)=>void}) {
  const rows=[{name:value.receiverName??'',phone:value.receiverPhone??''},...(value.additionalReceivers??[])]
  const change=(next:AddressReceiver[])=>onChange({receiverName:next[0]?.name??'',receiverPhone:next[0]?.phone??'',additionalReceivers:next.slice(1)})
  return <section className="address-receivers form-field-wide" aria-label={`Приёмщики: ${label}`}>
    <div className="address-receivers-heading"><h4>Приёмщики адреса</h4><button type="button" className="button" disabled={disabled||rows.length>=50} onClick={()=>change([...rows,{name:'',phone:''}])}><Plus size={15}/>Добавить приёмщика</button></div>
    {rows.map((row,index)=><div className="address-receiver-row" key={index}>
      <label className="shipment-field"><span>{index===0?'Приёмщик (основной)':`Приёмщик ${index+1}`}</span><input aria-label={`Имя приёмщика ${index+1}: ${label}`} maxLength={500} value={row.name} disabled={disabled} onChange={event=>change(rows.map((item,i)=>i===index?{...item,name:event.target.value}:item))}/></label>
      <label className="shipment-field"><span>Телефон приёмщика</span><input aria-label={`Телефон приёмщика ${index+1}: ${label}`} type="tel" maxLength={500} value={row.phone} disabled={disabled} onChange={event=>change(rows.map((item,i)=>i===index?{...item,phone:event.target.value}:item))}/></label>
      <button type="button" className="icon-button" aria-label={`Удалить приёмщика ${index+1}: ${label}`} disabled={disabled} onClick={()=>change(rows.filter((_,i)=>i!==index))}><Trash2 size={17}/></button>
    </div>)}
    <p className="muted">Первый приёмщик — основной контакт адреса. Контакты не дают права подписывать документы.</p>
  </section>
}

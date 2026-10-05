import ScrollableSegments from './ScrollableSegments'
import { apiFetch as fetch, fetchDirectoryData, isLogisticsWorkspace } from './workspace-api'
import { useEffect, useRef, useState } from 'react'
import { ChevronLeft, ChevronRight, LoaderCircle, Pencil, Plus, Save, Search, Trash2, X } from 'lucide-react'
import type { Company, ShipmentAddress, DirectoryData, Vehicle } from './model'
import DirectorySelect from './DirectorySelect'
import DriverAccess from './DriverAccess'
import { companyFields, driverFields, vehicleFields, stsFields, ptsFields, productTransportFields, vehicleTransportFields } from './directory-fields'
import { directoryDraft, directoryEntry, directoryPayload, mergeDirectoryPayload, directoryFieldLabel, withCurrentAddressVersions, type EditorTab } from './directory-editor-data'
import { customerManagerId } from './customer-manager'
import './directories.css'
import './form-refinements.css'

const tabs = [{id:'customers',name:'Клиенты'}, {id:'suppliers',name:'Поставщики'}, {id:'oilDepots',name:'Нефтебазы'}, {id:'managers',name:'Менеджеры'}, {id:'products',name:'Товары'}, {id:'paymentForms',name:'Формы оплаты'}, {id:'vehicles',name:'Автомобили'}, {id:'drivers',name:'Водители'}, {id:'addresses',name:'Места погрузки и доставки'}, {id:'customerManagers',name:'Клиенты и менеджеры'}] as const
 export type DirectoryTab = (typeof tabs)[number]['id']
 type Tab = DirectoryTab
const titles: Record<EditorTab, string> = { customers: 'клиента', suppliers: 'поставщика', loadingParty: 'участника погрузки', oilDepots: 'нефтебазы', managers: 'менеджера', products: 'товара', paymentForms: 'формы оплаты', vehicles: 'автомобиля', drivers: 'водителя', addresses: 'адреса', customerManagers: 'назначения менеджера' }
const roleLabels = { customer: 'Клиент', supplier: 'Поставщик' }
const companyTab = (tab: EditorTab) => ['customers', 'suppliers', 'loadingParty'].includes(tab)
const tabRole = (tab: EditorTab) => tab === 'customers' ? 'customer' : tab === 'suppliers' ? 'supplier' : 'other'
const bankFields = new Set(['bankName','settlementAccount','correspondentAccount','bik'])
const editablePayload = (payload:Record<string,unknown>) => isLogisticsWorkspace() ? Object.fromEntries(Object.entries(payload).filter(([key])=>!bankFields.has(key))) : payload
const vehicleName = (vehicle: Vehicle) => vehicle.name || vehicle.plate
const vehicleDetail = (vehicle: Vehicle) => [vehicle.name && vehicle.name !== vehicle.plate ? vehicle.plate : '', vehicle.capacityLitres ? `${Number(vehicle.capacityLitres).toLocaleString('ru-RU')} л` : '', vehicle.compartmentsLitres?.length ? `Секции: ${vehicle.compartmentsLitres.join(' + ')} л` : ''].filter(Boolean).join(' · ')
type DirectoryRow = {id:string;name:string;detail:string;version?:number;manager?:string;managerId?:string;addresses?:string;roles?:string[]}

export default function DirectoriesPage({data,onChanged,canManage=true,initialTab='customers',allowedTabs,hideTabs=false}:{data:DirectoryData;onChanged:()=>void;canManage?:boolean;initialTab?:DirectoryTab;allowedTabs?:readonly DirectoryTab[];hideTabs?:boolean}) {
  const [tab,setTab] = useState<Tab>(() => allowedTabs?.includes(initialTab) === false ? allowedTabs[0] ?? initialTab : initialTab), [query,setQuery] = useState(''), [page,setPage] = useState(0)
  const [editor,setEditor] = useState<{id?:string} | null>(null), [notice,setNotice] = useState(''), [deleting,setDeleting] = useState<DirectoryRow|null>(null)
  const catalog = data.directories!
  const rows: DirectoryRow[] = companyTab(tab) ? data.companies.filter(company => !company.directoryArchived && company.roles.includes(tabRole(tab))).map(company => ({
    id: company.id, name: company.name, version: company.version, roles: company.roles,
    detail: [company.inn ? `ИНН ${company.inn}` : 'ИНН не указан', ...company.roles.filter(r => r in roleLabels).map(r => roleLabels[r as keyof typeof roleLabels])].join(' · '),
    manager: catalog.managers.find(manager => manager.id === customerManagerId(catalog, company.id))?.name || 'Не назначен',
    addresses: catalog.addresses.filter(address => address.companyId === company.id).map(address => address.name).join('; '),
  })) : tab === 'vehicles' ? catalog.vehicles.map(vehicle => ({...vehicle,name:vehicleName(vehicle),detail:vehicleDetail(vehicle)}))
    : tab === 'products' ? catalog.products.map(product => ({...product,detail:[product.documentName,product.transportProductKind==='diesel'?'Дизель: транспортные документы':''].filter(Boolean).join(' · ')}))
    : tab === 'drivers' ? catalog.drivers.map(driver => ({ ...driver, detail: [driver.phone, catalog.vehicles.find(vehicle => vehicle.id === driver.vehicleId)].map(value => typeof value === 'object' ? vehicleName(value) : value).filter(Boolean).join(' · ') }))
    : tab === 'oilDepots' ? (catalog.oilDepots ?? []).map(depot => ({...depot,detail:[depot.address,data.companies.find(company=>company.id===depot.ownerCompanyId)?.name].filter(Boolean).join(' · ')}))
    : tab === 'addresses' ? catalog.addresses.map(address => ({...address,detail:[address.kind === 'loading' ? 'Загрузка' : 'Выгрузка',data.companies.find(company=>company.id===address.companyId)?.name,address.address].filter(Boolean).join(' · ')}))
    : tab === 'customerManagers' ? (catalog.customerManagers??[]).map(row=>({id:row.companyId,name:data.companies.find(company=>company.id===row.companyId)?.name??'Компания',detail:catalog.managers.find(manager=>manager.id===row.managerId)?.name??'',managerId:row.managerId}))
    : catalog[tab as 'managers'|'products'|'paymentForms'].map(row => ({...row,detail:''}))
  const visible = rows.filter(row => [row.name, row.detail, row.manager, row.addresses].join(' ').toLocaleLowerCase('ru').includes(query.trim().toLocaleLowerCase('ru')))
  const lastPage = Math.max(0, Math.ceil(visible.length / 30) - 1), currentPage = Math.min(page, lastPage)
  return <div className="directories-page">
    {!hideTabs && <ScrollableSegments className="directory-tabs" label="Справочники" value={tab}>{tabs.filter(item => !['paymentForms','customerManagers'].includes(item.id) && (!allowedTabs || allowedTabs.includes(item.id))).map(item => <button className={`button ${item.id===tab?'primary':''}`} aria-pressed={item.id===tab} key={item.id} onClick={()=>{setTab(item.id);setQuery('');setPage(0);setNotice('')}}>{item.name}</button>)}</ScrollableSegments>}
    {notice && <p className="directory-notice" role="status">{notice}</p>}
    <section className="panel directory-list">
      <div className="directory-toolbar"><label className="shipment-search"><Search size={17}/><input aria-label="Поиск в справочнике" placeholder={companyTab(tab) ? 'Компания, ИНН, менеджер или адрес…' : 'Найти запись…'} value={query} onChange={event=>{setQuery(event.target.value);setPage(0)}}/>{query && <button type="button" className="icon-button" aria-label="Очистить поиск в справочнике" onClick={()=>{setQuery('');setPage(0)}}><X size={16}/></button>}</label>
        {canManage&&<button className="button primary" onClick={()=>setEditor({})}><Plus size={17}/>Добавить</button>}
      </div>
      <div className="directory-record-count">Записей: {visible.length}</div>
      <div className="directory-records">{visible.slice(currentPage*30,(currentPage+1)*30).map(row=><div className="directory-record" key={row.id}>
        <button className="directory-record-open" onClick={()=>setEditor({id:row.id})} disabled={!canManage} aria-label={`Редактировать: ${row.name}`}><span className="directory-record-main"><strong>{row.name}</strong>{row.detail && <small>{row.detail}</small>}{row.addresses && <small>{row.addresses}</small>}</span>
          {row.manager !== undefined && <span className="directory-record-manager"><small>Менеджер</small><span>{row.manager}</span></span>}{canManage&&<Pencil size={17}/>}</button>
        {canManage&&<button className="icon-button directory-delete" aria-label={`Удалить: ${row.name}`} onClick={()=>setDeleting(row)}><Trash2 size={17}/></button>}
      </div>)}</div>
      {!visible.length && <p className="directory-empty">{query ? 'По вашему запросу ничего не найдено.' : canManage ? 'Записей пока нет. Нажмите «Добавить», чтобы создать первую.' : 'Записей пока нет.'}</p>}
      <div className="directory-pagination"><span>{visible.length ? `${currentPage*30+1}–${Math.min((currentPage+1)*30,visible.length)} из ${visible.length}` : '0 записей'}</span><div><button className="icon-button" aria-label="Предыдущая страница справочника" disabled={!currentPage} onClick={()=>setPage(currentPage-1)}><ChevronLeft size={18}/></button><span>{currentPage+1} / {lastPage+1}</span><button className="icon-button" aria-label="Следующая страница справочника" disabled={currentPage===lastPage} onClick={()=>setPage(currentPage+1)}><ChevronRight size={18}/></button></div></div>
    </section>
    {editor && canManage && <DirectoryEditor tab={tab} id={editor.id} data={data} onChanged={onChanged} onClose={()=>setEditor(null)} onSaved={()=>{setEditor(null);setNotice(editor.id ? 'Изменения сохранены' : 'Запись добавлена');onChanged()}}/>}
    {deleting && canManage && <DirectoryDelete tab={tab} row={deleting} onClose={()=>setDeleting(null)} onDeleted={()=>{setDeleting(null);setNotice('Запись удалена из справочника');onChanged()}}/>}
  </div>
}

function DirectoryDelete({tab,row,onClose,onDeleted}:{tab:Tab;row:DirectoryRow;onClose:()=>void;onDeleted:()=>void}) {
  const dialog=useRef<HTMLDialogElement>(null),busy=useRef(false)
  const [saving,setSaving]=useState(false),[error,setError]=useState('')
  useEffect(()=>{const element=dialog.current;element?.showModal();return()=>element?.close()},[])
  const close=()=>{if(!busy.current)onClose()}
  const remove=async()=>{
    if(busy.current)return;busy.current=true;setSaving(true);setError('')
    try{
      const response=await fetch(`/api/directories/${tab}/${encodeURIComponent(row.id)}`,{method:'DELETE',headers:{'Content-Type':'application/json'},body:JSON.stringify(tab==='customerManagers'?{managerId:row.managerId}:{version:row.version??0})})
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось удалить запись')
      onDeleted()
    }catch(reason){setError(reason instanceof Error?reason.message:'Нет связи с сервером')}finally{busy.current=false;setSaving(false)}
  }
  const otherRoles=companyTab(tab)&&row.roles?.some(role=>role!==tabRole(tab))
  return <dialog ref={dialog} className="detail-dialog directory-delete-dialog" aria-labelledby="directory-delete-title" onCancel={event=>{event.preventDefault();close()}}>
    <div className="directory-editor-heading"><h2 id="directory-delete-title">Удаление записи</h2><button className="icon-button" aria-label="Закрыть подтверждение удаления" disabled={saving} onClick={close}><X size={20}/></button></div>
    <div className="directory-editor-body"><p>Удалить «<strong>{row.name}</strong>» из справочника «{tabs.find(item=>item.id===tab)?.name}»?</p>{otherRoles&&<p className="directory-delete-explanation">Компания останется в остальных категориях; её общая карточка и связи сохранятся.</p>}{error&&<p className="shipment-error" role="alert">{error}</p>}</div>
    <div className="directory-editor-footer"><button className="button" disabled={saving} onClick={close}>Отмена</button><button className="button directory-danger" disabled={saving} onClick={()=>void remove()}>{saving?<LoaderCircle size={17} className="spin"/>:<Trash2 size={17}/>}Удалить</button></div>
  </dialog>
}

function formatConflictValue(value:unknown):string {
  if(value===undefined||value===null||value==='')return 'пусто'
  if(Array.isArray(value))return value.map(formatConflictValue).join('; ')||'пусто'
  if(typeof value==='object')return Object.entries(value).filter(([key])=>!['id','version','companyId'].includes(key)).map(([key,value])=>`${directoryFieldLabel(key)}: ${formatConflictValue(value)}`).join(', ')
  return String(value)
}

function DirectoryEditor({tab,id,data,onClose,onSaved,onChanged}:{tab:EditorTab;id?:string;data:DirectoryData;onClose:()=>void;onSaved:(company?:Company)=>void;onChanged:()=>void}) {
  const catalog = data.directories!, dialog = useRef<HTMLDialogElement>(null)
  const [baseline,setBaseline] = useState(data)
  const entry = directoryEntry(baseline,tab,id)
  const busy=useRef(false)
  const conflictPanel=useRef<HTMLDivElement>(null)
  const [conflict,setConflict]=useState<{snapshot:DirectoryData;merged:Record<string,unknown>;latest:Record<string,unknown>;keys:string[];choices:Record<string,'mine'|'saved'>}|null>(null)
  useEffect(()=>{conflictPanel.current?.scrollIntoView({block:'nearest'})},[conflict])
  const company = companyTab(tab) ? entry as Company | undefined : undefined
  const [fields,setFields] = useState<Record<string,string>>(()=>Object.fromEntries(Object.entries(entry ?? {}).filter(([,value])=>typeof value==='string').map(([key,value])=>[key,String(value)])))
  const [sections,setSections] = useState(()=>tab==='vehicles' ? (entry as Vehicle | undefined)?.compartmentsLitres?.join(' + ') ?? '' : '')
  const [roles,setRoles] = useState<string[]>(()=>{
    const existing = company?.roles.filter(role=>['customer','supplier','carrier','other'].includes(role)) ?? []
    return existing.length ? existing : [tabRole(tab)]
  })
  const [participant,setParticipant] = useState<{label:string;value:string;onSelect:(id:string)=>void}|null>(null)
  const [savedCompanies,setSavedCompanies] = useState<Company[]>([])
  const relatedCompanies = [...data.companies.filter(company=>!savedCompanies.some(saved=>saved.id===company.id)),...savedCompanies]
  const [companyId,setCompanyId] = useState(id??'')
  const [managerId,setManagerId] = useState(()=>customerManagerId(catalog,id??''))
  const [addresses,setAddresses] = useState<Omit<ShipmentAddress,'companyId'>[]>(()=>catalog.addresses.filter(address=>address.companyId===id).map(({id,name,kind,version,address,mapUrl,latitude,longitude,receiverName,receiverPhone,loadingActorCompanyId,infrastructureOwnerCompanyId})=>({id,name,kind,version:version??0,address,mapUrl,latitude,longitude,receiverName,receiverPhone,loadingActorCompanyId,infrastructureOwnerCompanyId})))
  const [accessBusy,setAccessBusy] = useState(false)
  const [lookupBusy,setLookupBusy] = useState(false), [lookupNotice,setLookupNotice] = useState('')
  const [saving,setSaving] = useState(false), [error,setError] = useState(''), [dirty,setDirty] = useState(false), [confirmClose,setConfirmClose] = useState(false)
  useEffect(()=>{const element=dialog.current;element?.showModal();return()=>element?.close()},[])
  useEffect(()=>{if(!dirty)return;const handler=(event:BeforeUnloadEvent)=>{event.preventDefault()};window.addEventListener('beforeunload',handler);return()=>window.removeEventListener('beforeunload',handler)},[dirty])
  const close = ()=>{if(saving||lookupBusy||accessBusy)return;if(dirty)setConfirmClose(true);else onClose()}
  const update = (key:string,value:string)=>{setFields(old=>({...old,[key]:value}));setDirty(true)}
  const longFields = new Set(['address','registeredAddress','ownerAddress','fullName','documentName','passportIssuedBy','ptsSpecialMarks','stsSpecialMarks'])
  const input = (label:string,key:string,required=false)=><label className={`shipment-field ${longFields.has(key)?'form-field-wide':''}`}><span>{label}{required?' *':''}</span>{longFields.has(key)?<textarea aria-label={label} value={fields[key]??''} required={required} maxLength={500} rows={2} disabled={saving||lookupBusy} onChange={event=>update(key,event.target.value)}/>:<input aria-label={label} value={fields[key]??''} required={required} maxLength={500} disabled={saving||lookupBusy} onChange={event=>update(key,event.target.value)}/>}</label>
  const loadingRoleSelect = (label:string,value:string,onChange:(id:string)=>void)=><div className="loading-party-field"><DirectorySelect label={label} entries={relatedCompanies.filter(company=>!company.directoryArchived).map(company=>({id:company.id,name:company.name,detail:company.inn?`ИНН ${company.inn}`:undefined}))} value={value} legacy={relatedCompanies.find(company=>company.id===value)?.name} onChange={onChange} disabled={saving||lookupBusy} searchFirst wrapSelection emptyMessage="Введите наименование или ИНН. Новую организацию можно добавить здесь."/><button type="button" className="button" disabled={saving||lookupBusy} aria-label={`${value?'Реквизиты':'Добавить организацию'}: ${label}`} onClick={()=>setParticipant({label,value,onSelect:onChange})}>{value?'Реквизиты':'Добавить организацию'}</button></div>
  const save = async(event:React.FormEvent)=>{
    event.preventDefault();if(busy.current||lookupBusy||accessBusy||conflict)return;busy.current=true;setSaving(true);setError('');setConfirmClose(false)
    try {
      const payload=editablePayload(directoryPayload(tab,{fields,sections,roles,companyId,managerId,addresses}))
      const updating=!!id&&tab!=='customerManagers',kind=companyTab(tab)?'companies':tab
      let result: {entry?:Company;created?:boolean;error?:string} = {}
      for(let attempt=0;attempt<2;attempt++) {
        let outgoing={...payload}
        if(updating) {
          const snapshot=await fetchDirectoryData(), current=directoryEntry(snapshot,tab,id)
          if(!current)throw new Error('Запись удалена из справочника. Ваш ввод сохранён в форме.')
          const base=editablePayload(directoryPayload(tab,directoryDraft(baseline,tab,id))),latest=editablePayload(directoryPayload(tab,directoryDraft(snapshot,tab,id)))
          const {merged,conflicts}=mergeDirectoryPayload(base,payload,latest)
          if(conflicts.length) {setConflict({snapshot,merged,latest,keys:conflicts,choices:{}});return}
          outgoing={...merged,version:current.version??0}
        } else outgoing.kind=kind
        const response=await fetch(updating?`/api/directories/${kind}/${encodeURIComponent(id!)}`:'/api/directories',{method:updating?'PATCH':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(outgoing)})
        result=await response.json()
        if(response.ok)break
        // Re-read once if a writer won the race after our preflight read.
        if(updating && response.status===409 && attempt===0)continue
        throw new Error(response.status===409?'Не удалось сохранить: '+(result.error??'данные изменились')+' Ваш ввод остаётся в форме.':result.error||'Не удалось сохранить запись')
      }
      // Company POST can restore an archived card or add a role to its existing ID.
      // Those committed changes have created:false; actual duplicates return 409.
      if(!id && !companyTab(tab) && tab!=='customerManagers' && !result.created)throw new Error('Такая запись уже есть. Найдите её в списке для редактирования.')
      onSaved(companyTab(tab) ? result.entry as Company : undefined)
    }catch(reason){setError(reason instanceof Error?reason.message:'Нет связи с сервером')}finally{busy.current=false;setSaving(false)}
  }
  const resolveConflict = ()=>{
    if(!conflict)return
    const resolved={...conflict.merged}
    for(const key of conflict.keys)if(conflict.choices[key]==='saved')resolved[key]=conflict.latest[key]
    setFields(Object.fromEntries(Object.entries(resolved).filter(([,value])=>typeof value==='string')) as Record<string,string>)
    setSections((resolved.compartmentsLitres as string[]|undefined)?.join(' + ')??'')
    if(companyTab(tab)){setRoles(resolved.roles as string[]);setAddresses(withCurrentAddressVersions(resolved,conflict.latest).addresses as Omit<ShipmentAddress,'companyId'>[]);setManagerId(resolved.managerId as string||'')}
    setBaseline(conflict.snapshot);setConflict(null);setDirty(true);setError('')
  }
  const lookup = async()=>{
    if(saving||lookupBusy)return;setLookupBusy(true);setError('');setLookupNotice('')
    try{
      const response=await fetch('/api/companies/lookup',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({inn:fields.inn??''})})
      const result=await response.json();if(!response.ok)throw new Error(result.error||'Не удалось получить реквизиты')
      const company=result.company as Company
      setFields(old=>({...old,...Object.fromEntries(['name','inn','fullName','kpp','ogrn','director','address'].map(key=>[key,String(company[key as keyof Company]??'')]))}))
      setDirty(true);setLookupNotice('Реквизиты заполнены из Чекко. Проверьте данные и сохраните карточку.')
    }catch(reason){setError(reason instanceof Error?reason.message:'Нет связи с сервером')}finally{setLookupBusy(false)}
  }
  const extraGroup = (title:string,fields:readonly (readonly [string,string])[],open=false)=><details className="directory-extra-fields" open={open||undefined}><summary>{title}</summary><div className="shipment-field-grid">{fields.map(([key,label])=><div key={key} className={longFields.has(key)?'form-field-wide':undefined}>{input(label,key)}</div>)}</div></details>
  const addressGroup = (kind:'loading'|'delivery',label:string)=><section className="company-address-group">
    <div><h3>{label}</h3><button type="button" className="button" disabled={saving||lookupBusy} onClick={()=>{setAddresses(old=>[...old,{id:'',name:'',kind}]);setDirty(true)}}><Plus size={15}/>Добавить адрес</button></div>
    {addresses.map((address,index)=>{
      if(address.kind!==kind)return null
      const number=addresses.slice(0,index+1).filter(row=>row.kind===kind).length
      const field=(key:'name'|'receiverName'|'receiverPhone',label:string,required=false)=><label className="shipment-field"><span>{label}</span><input aria-label={`${label} ${number}`} value={address[key]??''} required={required} maxLength={500} disabled={saving||lookupBusy} onChange={event=>{setAddresses(old=>old.map((row,i)=>i===index?{...row,[key]:event.target.value}:row));setDirty(true)}}/></label>
      return <div className="company-address-row" key={address.id||`new-${index}`}><div className="shipment-field-grid">
        {field('name',kind==='loading'?'Адрес загрузки':'Адрес отгрузки клиента',true)}
        {kind==='delivery'&&<>{field('receiverName','Приёмщик адреса')}{field('receiverPhone','Телефон приёмщика адреса')}</>}
        {kind==='loading'&&(['loadingActorCompanyId','infrastructureOwnerCompanyId'] as const).map(key=><div key={key}>{loadingRoleSelect(`${key==='loadingActorCompanyId'?'Погрузчик':'Владелец площадки'} ${number}`,address[key]??'',value=>{setAddresses(old=>old.map((row,i)=>i===index?{...row,[key]:value}:row));setDirty(true)})}</div>)}
      </div><button type="button" className="icon-button" aria-label={`Удалить адрес ${address.name||index+1}`} disabled={saving||lookupBusy} onClick={()=>{if(window.confirm(`Удалить адрес «${address.name||'Новый адрес'}»? Изменение сохранится вместе с карточкой компании.`)){setAddresses(old=>old.filter((_,i)=>i!==index));setDirty(true)}}}><Trash2 size={17}/></button></div>
    })}
    {kind==='delivery'&&<p className="muted">У каждого адреса один приёмщик. Этот контакт сам по себе не даёт права подписывать документы.</p>}
    {kind==='loading'&&<p className="muted">Укажите компании, которые выполняют погрузку и владеют площадкой. Эти сведения используются в транспортных документах.</p>}
  </section>
  return <><dialog ref={dialog} className="detail-dialog directory-editor" aria-label={`${id?'Карточка':'Добавление'} ${titles[tab]}`} onCancel={event=>{event.preventDefault();close()}}><form onSubmit={save}>
    <div className="directory-editor-heading"><h2>{id?'Карточка':'Добавление'} {titles[tab]}</h2><button type="button" className="icon-button" aria-label="Закрыть карточку справочника" disabled={saving||lookupBusy||accessBusy} onClick={close}><X size={20}/></button></div>
    <div className="directory-editor-body"><fieldset className="directory-edit-fields" disabled={!!conflict}><div className="shipment-field-grid">
      {companyTab(tab)?<><div className="form-field-wide">{input('Наименование','name',true)}</div>{input('ИНН','inn')}<div className="company-lookup-actions"><button className="button" type="button" disabled={saving||lookupBusy||!fields.inn?.trim()} onClick={()=>void lookup()}>{lookupBusy?<LoaderCircle size={17} className="spin"/>:<Search size={17}/>}Заполнить из Чекко</button></div>{tab!=='loadingParty'&&<><DirectorySelect label="Менеджер компании" entries={catalog.managers} value={managerId} onChange={id=>{setManagerId(id);setDirty(true)}} disabled={saving||lookupBusy}/><fieldset className="company-role-options"><legend>Тип компании</legend>{Object.entries(roleLabels).map(([role,label])=><label key={role}><input type="checkbox" checked={roles.includes(role)} disabled={saving||lookupBusy} onChange={event=>{setRoles(old=>event.target.checked?[...old,role]:old.filter(value=>value!==role));setDirty(true)}}/>{label}</label>)}</fieldset></>}</>
      :tab==='oilDepots'?<>
        <section className="directory-form-section form-field-wide" aria-labelledby="oil-depot-location-title"><div className="directory-form-section-heading"><h3 id="oil-depot-location-title">Место погрузки</h3><p>Название и фактический адрес нефтебазы.</p></div><div className="shipment-field-grid">
          <div className="form-field-wide">{input('Наименование нефтебазы','name',true)}</div>{input('Фактический адрес места погрузки / пункта подачи','address')}
        </div></section>
        <section className="directory-form-section form-field-wide" aria-labelledby="oil-depot-parties-title"><div className="directory-form-section-heading"><h3 id="oil-depot-parties-title">Участники погрузки</h3><p>Выберите организацию для каждой роли. Её данные доступны в реквизитах.</p></div><div className="directory-participants">
          {loadingRoleSelect('Компания — владелец нефтебазы',fields.ownerCompanyId??'',value=>update('ownerCompanyId',value))}
          {fields.ownerCompanyId&&<p className="directory-owner-address"><span>Юридический адрес владельца</span>{relatedCompanies.find(company=>company.id===fields.ownerCompanyId)?.address||'Не указан в реквизитах организации'}</p>}
          {loadingRoleSelect('Лицо, осуществляющее погрузку',fields.loadingActorCompanyId??'',value=>update('loadingActorCompanyId',value))}
          {loadingRoleSelect('Владелец инфраструктуры погрузки',fields.infrastructureOwnerCompanyId??'',value=>update('infrastructureOwnerCompanyId',value))}
        </div></section>
        <details className="directory-extra-fields form-field-wide directory-map-fields"><summary>Карта и координаты</summary><div className="shipment-field-grid"><div className="form-field-wide">{input('Ссылка на Яндекс.Карты','mapUrl')}</div>{input('Широта','latitude')}{input('Долгота','longitude')}</div></details>
      </>
      :tab==='vehicles'?<>{input('Автомобиль / номер','plate',true)}{input('Название для выбора','name')}{input('Марка','brand')}{input('Модель','model')}{input('Прицеп','trailer')}{input('Объём автомобиля, л','capacityLitres')}<label className="shipment-field"><span>Секции, л (через +)</span><input aria-label="Секции, л (через +)" value={sections} disabled={saving||lookupBusy} onChange={event=>{setSections(event.target.value);setDirty(true)}}/></label></>
      :tab==='customerManagers'?<><DirectorySelect label="Клиент" entries={data.companies.filter(company=>company.roles.includes('customer'))} value={companyId} onChange={id=>{setCompanyId(id);setManagerId(customerManagerId(catalog,id));setDirty(true)}} required disabled={saving||!!id}/><DirectorySelect label="Менеджер" entries={catalog.managers} value={managerId} onChange={id=>{setManagerId(id);setDirty(true)}} required disabled={saving}/></>
      :<>{input(tab==='drivers'?'ФИО водителя':tab==='managers'?'Имя менеджера':tab==='paymentForms'?'Название формы оплаты':tab==='addresses'?'Название места':'Название товара','name',true)}{tab==='addresses'&&<><DirectorySelect label="Компания адреса" entries={data.companies.filter(company=>!company.directoryArchived||company.id===fields.companyId).map(company=>({id:company.id,name:company.name,detail:company.inn?`ИНН ${company.inn}`:undefined}))} value={fields.companyId??''} onChange={id=>update('companyId',id)} required disabled={saving} searchFirst/><label className="shipment-field"><span>Тип адреса</span><select aria-label="Тип адреса" value={fields.addressKind??fields.kind??'delivery'} onChange={event=>update('addressKind',event.target.value)} disabled={saving}><option value="delivery">Выгрузка</option><option value="loading">Загрузка</option></select></label>{input('Фактический адрес площадки','address')}{input('Ссылка на Яндекс.Карты','mapUrl')}{input('Широта','latitude')}{input('Долгота','longitude')}{(fields.addressKind??fields.kind??'delivery')==='delivery'&&<>{input('Приёмщик','receiverName')}{input('Телефон приёмщика','receiverPhone')}</>}</>}{tab==='drivers'&&<>{input('Телефон водителя','phone')}<DirectorySelect label="Автомобиль по умолчанию" entries={catalog.vehicles.map(vehicle=>({id:vehicle.id,name:vehicleName(vehicle),detail:vehicleDetail(vehicle)}))} value={fields.vehicleId??''} onChange={id=>update('vehicleId',id)} required disabled={saving||lookupBusy}/></>}</>}
    </div>
    {lookupNotice&&<p className="directory-notice" role="status">{lookupNotice}</p>}
    {companyTab(tab)&&<>{extraGroup('Реквизиты организации',companyFields.slice(0,5),true)}{extraGroup(isLogisticsWorkspace()?'Контакты':'Контакты и банковские реквизиты',isLogisticsWorkspace()?companyFields.slice(5,7):companyFields.slice(5))}{(roles.includes('customer')||addresses.some(address=>address.kind==='delivery'))&&addressGroup('delivery','Фактические адреса отгрузки клиента')}</>}
    {tab==='oilDepots'&&<p className="directory-context-note">Поставщик выбирается отдельно в рейсе.</p>}
    {tab==='drivers'&&<>{id ? <DriverAccess driverId={id} disabled={saving||lookupBusy||!!conflict} onBusyChange={setAccessBusy}/> : <p className="directory-context-note">Сохраните карточку водителя, чтобы выдать ему доступ.</p>}{extraGroup('Водительское удостоверение и ИНН',driverFields.slice(0,4),true)}{extraGroup('Паспортные данные водителя',driverFields.slice(4))}</>}
    {tab==='addresses'&&(fields.addressKind??fields.kind??'delivery')==='loading'&&<div className="shipment-field-grid">{loadingRoleSelect('Погрузчик',fields.loadingActorCompanyId??'',value=>update('loadingActorCompanyId',value))}{loadingRoleSelect('Владелец площадки',fields.infrastructureOwnerCompanyId??'',value=>update('infrastructureOwnerCompanyId',value))}</div>}
    {tab==='products'&&<details className="directory-extra-fields" open><summary>Транспортные документы</summary>
      <div className="shipment-field-grid">{input('Полное наименование для документов','documentName')}<label className="shipment-field"><span>Автоматизация транспортных документов</span><select aria-label="Автоматизация транспортных документов" value={fields.transportProductKind??''} disabled={saving||lookupBusy} onChange={event=>update('transportProductKind',event.target.value)}><option value="">Не настроена</option><option value="diesel">Дизельное топливо</option></select></label><label className="shipment-field"><span>Способ перевозки груза</span><select aria-label="Способ перевозки груза" value={fields.cargoPackaging??''} disabled={saving||lookupBusy} onChange={event=>update('cargoPackaging',event.target.value)}><option value="">Не указан</option><option value="bulk">Без упаковки (наливом)</option><option value="packaged">В упаковке</option></select></label></div>
      <p className="muted">Короткое название остаётся в учёте. Характеристики опасного груза заполните по выбранной позиции справочника Saby или документу на товар; название само по себе не определяет их.</p>
      {extraGroup('Опасный груз: подтверждённые характеристики',productTransportFields.slice(3),fields.transportProductKind==='diesel')}
    </details>}
    {tab==='vehicles'&&<><details className="directory-extra-fields" open><summary>Данные для транспортных документов</summary>
      <div className="shipment-field-grid">{vehicleTransportFields.slice(0,5).map(([key,label])=><div key={key}>{input(label,key)}</div>)}<label className="shipment-field"><span>Основание владения</span><select aria-label="Основание владения" value={fields.ownershipType??''} disabled={saving||lookupBusy} onChange={event=>update('ownershipType',event.target.value)}><option value="">Не указано</option><option value="1">Собственность</option><option value="2">Совместная собственность супругов</option><option value="3">Аренда</option><option value="4">Лизинг</option><option value="5">Безвозмездное пользование</option></select></label></div>
      <p className="muted">Для Saby укажите согласованное максимальное значение в тоннах: 27 900 кг = 27,9 т. Объём цистерны заполняется отдельно.</p>
      <label className="shipment-field"><span>Распределение груза по платформе</span><select aria-label="Распределение груза по платформе" value={fields.cargoDistributable??''} disabled={saving||lookupBusy} onChange={event=>update('cargoDistributable',event.target.value)}><option value="">Не выбрано</option><option value="0">Возможно</option><option value="1">Невозможно</option></select></label>
      {extraGroup('Договор на пользование этой машиной',vehicleTransportFields.slice(6).filter(([key])=>key!=='cargoDistributable'),['3','4','5'].includes(fields.ownershipType??''))}
    </details>{extraGroup('Данные транспортного средства',vehicleFields)}{extraGroup('Свидетельство о регистрации (СТС)',stsFields)}{extraGroup('Паспорт транспортного средства (ПТС / ЭПТС)',ptsFields)}</>}
    </fieldset>
    {conflict&&<div className="directory-conflict" ref={conflictPanel} role="region" aria-label="Сверка изменений"><h3>Эти поля изменились во время редактирования</h3><p>Ваш ввод сохранён. Выберите значения для спорных полей. Остальные изменения будут объединены.</p>{conflict.keys.map(key=><fieldset key={key}><legend>{directoryFieldLabel(key)}</legend>{(['mine','saved'] as const).map(choice=><label key={choice}><input type="radio" name={`conflict-${key}`} checked={conflict.choices[key]===choice} onChange={()=>setConflict({...conflict,choices:{...conflict.choices,[key]:choice}})}/><span>{choice==='mine'?'Моё значение':'Сохранённое значение'}: {formatConflictValue((choice==='mine'?conflict.merged:conflict.latest)[key])}</span></label>)}</fieldset>)}<button type="button" className="button" disabled={conflict.keys.some(key=>!conflict.choices[key])} onClick={resolveConflict}>Применить выбор</button><p className="muted">После сверки нажмите «Сохранить».</p></div>}
    {error&&<p className="shipment-error" role="alert">{error}</p>}
    {confirmClose&&<div className="directory-close-confirm" role="alert"><p>Закрыть карточку без сохранения изменений?</p><button type="button" className="button" onClick={()=>setConfirmClose(false)}>Продолжить редактирование</button><button type="button" className="button" onClick={onClose}>Не сохранять</button></div>}
    </div><div className="directory-editor-footer"><button className="button" type="button" disabled={saving||lookupBusy||accessBusy} onClick={close}>Отмена</button><button className="button primary" type="submit" disabled={saving||lookupBusy||accessBusy||!!conflict}>{saving?<LoaderCircle size={17} className="spin"/>:<Save size={17}/>}Сохранить</button></div>
  </form></dialog>{participant&&<DirectoryEditor tab="loadingParty" id={participant.value||undefined} data={{...data,companies:relatedCompanies}} onChanged={onChanged} onClose={()=>setParticipant(null)} onSaved={company=>{if(!company)return;setSavedCompanies(old=>[...old.filter(row=>row.id!==company.id),company]);participant.onSelect(company.id);setParticipant(null);onChanged()}}/>}</>
}

import { useEffect, useRef, useState } from 'react'
import { Building2, Search, X } from 'lucide-react'
import type { Company } from './model'
import { initial, number, roleName } from './utils'

export default function CompanySearchDialog({companies,initialQuery,onClose,onOpen}: {
  companies: Company[]; initialQuery: string; onClose: () => void; onOpen: (company: Company) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [query,setQuery] = useState(initialQuery)
  const [limit,setLimit] = useState(50)
  useEffect(() => { dialog.current?.showModal(); return () => dialog.current?.close() }, [])
  const normalized = query.trim().toLocaleLowerCase('ru')
  const found = companies.filter(company => [company.name, company.inn].some(value => value?.toLocaleLowerCase('ru').includes(normalized)))
  return <dialog ref={dialog} className="detail-dialog company-search-dialog" onCancel={onClose} aria-labelledby="company-search-title">
    <div className="dialog-inner">
      <div className="dialog-heading"><span className="eyebrow">КОМПАНИИ В ОПЕРАЦИЯХ</span><button className="icon-button" aria-label="Закрыть поиск" onClick={onClose}><X size={20}/></button></div>
      <h2 id="company-search-title">Найти контрагента</h2>
      <label className="table-search company-search-field"><Search size={18}/><input autoFocus aria-label="Название или ИНН контрагента" placeholder="Название или ИНН" value={query} onChange={event => {setQuery(event.target.value);setLimit(50)}}/></label>
      <p className="section-note">Найдено {number(found.length)}. Добавить фирму по ИНН можно при создании или редактировании отгрузки.</p>
      <div className="company-search-results">{found.slice(0,limit).map(company => <button key={company.id} className="company-search-result" onClick={() => onOpen(company)}>
        <span className="company-avatar">{initial(company.name) || <Building2 size={18}/>}</span>
        <span><strong>{company.name}</strong><small>{company.inn ? `ИНН ${company.inn}` : [...new Set(company.roles.map(roleName))].join(' · ')}</small></span>
        <span className="counter">{number(company.shipmentIds.length)}</span>
      </button>)}</div>
      {!found.length && <p className="soft-notice">Контрагент не найден. Попробуйте другое название или ИНН.</p>}
      {limit < found.length && <button className="button company-load-more" onClick={() => setLimit(value => value + 50)}>Показать ещё 50</button>}
    </div>
  </dialog>
}

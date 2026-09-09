import { useId, useMemo, useState } from 'react'
import { Building2, Check, LoaderCircle, Plus, Search, X } from 'lucide-react'
import type { Company } from './model'

type CompanyDetails = Company & { inn?: string | null; fullName?: string | null; address?: string | null }
export default function CompanyPicker({ label, companies, value, selectedId, onChange, onCreated, onLookupStateChange, disabled = false }: {
  label: string; companies: Company[]; value: string; selectedId?: string; onChange: (company: Company | null) => void; onCreated: (company: Company) => void; onLookupStateChange?: (busy: boolean) => void; disabled?: boolean
}) {
  const id = useId()
  const [search, setSearch] = useState(value)
  const [open, setOpen] = useState(false)
  const [inn, setInn] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')
  const [active, setActive] = useState(0)
  const matches = useMemo(() => companies.filter(c => `${c.name} ${(c as CompanyDetails).inn || ''}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))).sort((a,b) => a.name.localeCompare(b.name,'ru')), [companies, search])
  const visible = matches.slice(0, 30)
  const choose = (company: Company) => { onChange(company); setSearch(company.name); setOpen(false); setError('') }
  const add = async () => {
    setError(''); setMessage(''); setAdding(true); onLookupStateChange?.(true)
    try {
      const response = await fetch('/api/companies/from-inn', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({inn:inn.trim()}) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || result.message || 'Не удалось добавить компанию')
      onCreated(result.company); choose(result.company)
      setMessage(result.created ? 'Компания добавлена и выбрана' : 'Компания уже есть в справочнике и выбрана')
      setInn('')
    } catch (e) { setError(e instanceof Error ? e.message : 'Не удалось связаться с сервером') }
    finally { setAdding(false); onLookupStateChange?.(false) }
  }
  return <div className="company-picker">
    <label htmlFor={id}>{label}</label>
    <div className="company-combobox"><Search size={17}/><input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open && visible[active] ? `${id}-option-${active}` : undefined} autoComplete="off" placeholder="Найти в справочнике…" value={open ? search : value} disabled={disabled || adding} onFocus={() => { setSearch(value); setOpen(true); setActive(0) }} onChange={e => { setSearch(e.target.value); setOpen(true); setActive(0) }} onBlur={() => setTimeout(() => setOpen(false), 150)} onKeyDown={e => {
      if (e.key === 'ArrowDown') { e.preventDefault(); setOpen(true); setActive(i => Math.min(i + 1, visible.length - 1)) }
      if (e.key === 'ArrowUp') { e.preventDefault(); setActive(i => Math.max(i - 1, 0)) }
      if (e.key === 'Enter' && open) { e.preventDefault(); if(visible[active]) choose(visible[active]) }
      if (e.key === 'Escape' && open) { e.preventDefault(); e.stopPropagation(); setOpen(false) }
    }}/>{value && <button type="button" className="icon-button" aria-label={`Очистить: ${label}`} disabled={disabled || adding} onClick={() => { onChange(null);setSearch('');setOpen(false) }}><X size={16}/></button>}</div>
    {open && <div id={`${id}-list`} role="listbox" className="company-options" aria-label={label}>
      {visible.map((company, i) => <button type="button" role="option" id={`${id}-option-${i}`} aria-selected={selectedId ? company.id === selectedId : company.name === value} className={active === i ? 'active' : ''} key={company.id} onMouseDown={e => e.preventDefault()} onClick={() => choose(company)}><Building2 size={16}/><span>{company.name}{(company as CompanyDetails).inn && <small>ИНН {(company as CompanyDetails).inn}</small>}</span>{(selectedId ? company.id === selectedId : company.name === value) && <Check size={16}/>}</button>)}
      {!visible.length && <p>Совпадений нет. Добавьте фирму по ИНН ниже.</p>}
      {matches.length > 30 && <p>Уточните название: найдено {matches.length} компаний</p>}
    </div>}
    <div className="company-add"><input aria-label={`ИНН: ${label}`} inputMode="numeric" autoComplete="off" maxLength={12} placeholder="ИНН новой фирмы" value={inn} disabled={disabled || adding} onChange={e => {setInn(e.target.value.replace(/\D/g,''));setError('');setMessage('')}}/><button type="button" className="button" disabled={disabled || adding || ![10,12].includes(inn.length)} onClick={add}>{adding ? <LoaderCircle size={16} className="spin"/> : <Plus size={16}/>} {adding ? 'Ищем в Чекко…' : 'Добавить'}</button></div>
    {error && <p className="shipment-error-text" role="alert">{error}</p>}
    {message && <p className="shipment-success-text" role="status">{message}</p>}
  </div>
}

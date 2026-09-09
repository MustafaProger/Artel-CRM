import { useId, useMemo, useState } from 'react'
import { Check, Search, X } from 'lucide-react'
export interface SelectEntry { id: string; name: string; detail?: string }
export default function DirectorySelect({ label, entries, value, onChange, disabled, required, legacy }: {
  label: string; entries: SelectEntry[]; value: string; onChange: (id: string) => void; disabled?: boolean; required?: boolean; legacy?: string | null
}) {
  const id = useId(), [open,setOpen] = useState(false), [search,setSearch] = useState(''), [active,setActive] = useState(0)
  const selected = entries.find(e => e.id === value)
  const matches = useMemo(() => entries.filter(e => `${e.name} ${e.detail ?? ''}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))),[entries,search])
  const visible = matches.slice(0,50)
  const choose = (id: string) => {onChange(id);setOpen(false);setSearch('')}
  return <div className="company-picker directory-select"><label htmlFor={id}>{label}{required && ' *'}</label><div className="company-combobox"><Search size={16}/><input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open && visible[active] ? `${id}-${active}` : undefined} autoComplete="off" placeholder={disabled ? 'Сначала выберите связанную запись' : 'Выбрать из справочника…'} value={open ? search : selected?.name ?? legacy ?? ''} aria-required={required} required={required && !value && !legacy} disabled={disabled} onFocus={() => {setOpen(true);setSearch('');setActive(0)}} onBlur={() => setOpen(false)} onChange={e => {setSearch(e.target.value);setOpen(true);setActive(0)}} onKeyDown={e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {e.preventDefault();setOpen(true);setActive(i => Math.max(0,Math.min(visible.length-1,i+(e.key === 'ArrowDown' ? 1 : -1))))}
    if (e.key === 'Enter') {e.preventDefault();e.stopPropagation();if(open && visible[active]) choose(visible[active].id)}
    if (e.key === 'Escape' && open) {e.preventDefault();e.stopPropagation();setOpen(false)}
  }}/>{value && !required && <button type="button" className="icon-button" aria-label={`Очистить: ${label}`} onClick={() => choose('')} disabled={disabled}><X size={15}/></button>}</div>
    {open && <div id={`${id}-list`} className="company-options" role="listbox" aria-label={label}>{visible.map((e,i) => <button type="button" tabIndex={-1} role="option" id={`${id}-${i}`} aria-selected={e.id===value} key={e.id} className={i===active?'active':''} onMouseDown={event => event.preventDefault()} onClick={() => choose(e.id)}><span>{e.name}{e.detail && <small>{e.detail}</small>}</span>{e.id===value && <Check size={15}/>}</button>)}{!visible.length && <p>Нет значений. Добавьте запись в разделе «Справочники».</p>}{matches.length>50 && <p>Найдено {matches.length}. Уточните поиск.</p>}</div>}
  </div>
}

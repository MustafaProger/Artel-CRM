import { useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Check, Search, X } from 'lucide-react'
import './form-refinements.css'
export interface SelectEntry { id: string; name: string; detail?: string }
export default function DirectorySelect({ label, entries, value, onChange, disabled, required, legacy, searchFirst=false, emptyMessage, wrapSelection=false, placeholder, portalMenu=false }: {
  label: string; entries: SelectEntry[]; value: string; onChange: (id: string) => void; disabled?: boolean; required?: boolean; legacy?: string | null; searchFirst?: boolean; emptyMessage?: string; wrapSelection?: boolean; placeholder?: string; portalMenu?: boolean
}) {
  const id = useId(), [open,setOpen] = useState(false), [search,setSearch] = useState(''), [active,setActive] = useState(0)
  const root = useRef<HTMLDivElement>(null), combo = useRef<HTMLDivElement>(null)
  const [menuPosition,setMenuPosition] = useState({top:0,left:0,width:0})
  useLayoutEffect(() => {
    if (!open || !portalMenu) return
    const place = () => {
      const host = root.current?.closest('dialog'), anchor = combo.current
      if (!host || !anchor) return
      const dialogRect = host.getBoundingClientRect(), rect = anchor.getBoundingClientRect()
      const width = Math.min(300, Math.max(240, rect.width))
      setMenuPosition({top:rect.top-dialogRect.top-5,left:Math.max(8,Math.min(rect.left-dialogRect.left,dialogRect.width-width-8)),width})
    }
    place()
    window.addEventListener('resize',place)
    window.addEventListener('scroll',place,true)
    return () => {window.removeEventListener('resize',place);window.removeEventListener('scroll',place,true)}
  },[open,portalMenu])
  const selected = entries.find(e => e.id === value)
  const matches = useMemo(() => entries.filter(e => `${e.name} ${e.detail ?? ''}`.toLocaleLowerCase('ru').includes(search.toLocaleLowerCase('ru'))),[entries,search])
  const waitingForSearch = searchFirst && !search.trim()
  const visible = waitingForSearch ? [] : matches.slice(0,50)
  const wrappedSelection = wrapSelection && !open && !!(selected?.name || legacy)
  const choose = (id: string) => {onChange(id);setOpen(false);setSearch('')}
  const menu = <div id={`${id}-list`} className={`company-options${portalMenu ? ' directory-portal' : ''}`} role="listbox" aria-label={label} style={portalMenu ? menuPosition : undefined}>{visible.map((e,i) => <button type="button" tabIndex={-1} role="option" id={`${id}-${i}`} aria-selected={e.id===value} key={e.id} className={i===active?'active':''} onMouseDown={event => event.preventDefault()} onClick={() => choose(e.id)}><span>{e.name}{e.detail && <small>{e.detail}</small>}</span>{e.id===value && <Check size={15}/>}</button>)}{!visible.length && <p>{waitingForSearch?'Введите наименование или ИНН для поиска.':emptyMessage??'Нет значений. Добавьте запись в разделе «Справочники».'}</p>}{!waitingForSearch&&matches.length>50 && <p>Найдено {matches.length}. Уточните поиск.</p>}</div>
  const host = portalMenu ? root.current?.closest('dialog') : null
  return <div ref={root} className="company-picker directory-select"><label htmlFor={id}>{label}{required && ' *'}</label><div ref={combo} className={`company-combobox${wrappedSelection ? ' has-wrapped-selection' : ''}`}><Search size={16}/>{wrappedSelection && <span className="directory-selection-value" aria-hidden="true">{selected?.name ?? legacy}</span>}<input id={id} role="combobox" aria-expanded={open} aria-controls={`${id}-list`} aria-autocomplete="list" aria-activedescendant={open && visible[active] ? `${id}-${active}` : undefined} autoComplete="off" title={!open ? selected?.name ?? legacy ?? undefined : undefined} placeholder={disabled ? 'Сначала выберите связанную запись' : placeholder ?? 'Выбрать из справочника…'} value={open ? search : selected?.name ?? legacy ?? ''} aria-required={required} required={required && !value && !legacy} disabled={disabled} onFocus={() => {setOpen(true);setSearch('');setActive(0)}} onBlur={() => setOpen(false)} onChange={e => {setSearch(e.target.value);setOpen(true);setActive(0)}} onKeyDown={e => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {e.preventDefault();setOpen(true);setActive(i => Math.max(0,Math.min(visible.length-1,i+(e.key === 'ArrowDown' ? 1 : -1))))}
    if (e.key === 'Enter') {e.preventDefault();e.stopPropagation();if(open && visible[active]) choose(visible[active].id)}
    if (e.key === 'Escape' && open) {e.preventDefault();e.stopPropagation();setOpen(false)}
  }}/>{value && !required && <button type="button" className="icon-button" aria-label={`Очистить: ${label}`} onMouseDown={event => event.preventDefault()} onClick={() => choose('')} disabled={disabled}><X size={15}/></button>}</div>
    {open && (host ? createPortal(menu,host) : menu)}
  </div>
}

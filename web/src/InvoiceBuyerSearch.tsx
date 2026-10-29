import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Search, X } from 'lucide-react';

type Buyer = { id: string; name: string; inn?: string; connectionId?: string };
type Props = { buyers: Buyer[]; value: string; onChange: (id: string) => void; disabled: boolean; placeholder: string };
const searchable = (value: string) => value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();

export function InvoiceBuyerSearch({ buyers, value, onChange, disabled, placeholder }: Props) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [query, setQuery] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const selected = buyers.find(buyer => buyer.id === value);
  const words = searchable(query ?? '').split(' ').filter(Boolean);
  const matches = buyers.filter(buyer => words.every(word => searchable(`${buyer.name} ${buyer.inn ?? ''}`).includes(word)));
  // Keep the mobile list short while allowing an exact search across every buyer.
  const visible = matches.slice(0, 50);
  const expanded = open && !disabled;
  const activeId = expanded && active >= 0 && active < visible.length ? `${id}-option-${active}` : undefined;
  useEffect(() => { if (activeId) document.getElementById(activeId)?.scrollIntoView({ block: 'nearest' }); }, [activeId]);
  const choose = (buyer: Buyer) => { input.current?.focus(); setQuery(null); setOpen(false); setActive(-1); onChange(buyer.id); };
  const keyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') { if (expanded) event.preventDefault(); setOpen(false); setActive(-1); return; }
    if (event.key === 'Tab') { setOpen(false); setActive(-1); return; }
    if (event.key === 'Enter' && expanded) {
      event.preventDefault(); if (visible[active]) choose(visible[active]); return;
    }
    let next: number;
    if (event.key === 'ArrowDown') next = expanded ? (active + 1) % Math.max(visible.length, 1) : 0;
    else if (event.key === 'ArrowUp') next = expanded && active > 0 ? active - 1 : visible.length - 1;
    else if (expanded && event.key === 'Home') next = 0;
    else if (expanded && event.key === 'End') next = visible.length - 1;
    else return;
    event.preventDefault(); setOpen(true); setActive(visible.length ? next : -1);
  };
  return <div className="field buyer-field">
    <label htmlFor={id}>Покупатель</label>
    <div className="buyer-search" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) { setOpen(false); setActive(-1); } }}>
      <Search size={18} className="buyer-search-icon" aria-hidden="true" />
      <input ref={input} id={id} type="text" role="combobox" autoComplete="off" autoCapitalize="none" spellCheck={false}
        aria-autocomplete="list" aria-expanded={expanded} aria-controls={`${id}-list`} aria-activedescendant={activeId}
        aria-describedby={expanded ? `${id}-results` : undefined} value={query ?? selected?.name ?? ''}
        placeholder={placeholder} disabled={disabled} required maxLength={240}
        onFocus={() => setOpen(true)} onKeyDown={keyDown}
        onChange={event => { setQuery(event.target.value); setActive(-1); setOpen(true); if (value) onChange(''); }} />
      {!disabled && Boolean(query ?? selected?.name) && <button type="button" className="icon-button buyer-clear" aria-label="Очистить покупателя"
        onMouseDown={event => event.preventDefault()} onClick={() => { setQuery(''); setActive(-1); onChange(''); setOpen(true); input.current?.focus(); }}><X size={17} aria-hidden="true" /></button>}
      {expanded && <div className="buyer-popup">
        <p className="buyer-result-count" id={`${id}-results`} role="status">{matches.length === 0 ? 'Покупатель не найден. Измените поиск.' : matches.length > visible.length ? `Показаны первые ${visible.length} из ${matches.length}. Уточните название или ИНН.` : `Найдено: ${matches.length}`}</p>
        <ul ref={list} id={`${id}-list`} role="listbox" aria-label="Покупатели" className="buyer-options">
          {visible.map((buyer, index) => <li id={`${id}-option-${index}`} key={buyer.id} role="option" tabIndex={-1} aria-selected={buyer.id === value}
            className={index === active ? 'buyer-option active' : 'buyer-option'} onMouseDown={event => event.preventDefault()}
            onPointerMove={() => setActive(index)} onClick={() => choose(buyer)}>
            <span>{buyer.name}</span>{buyer.inn && <small>ИНН {buyer.inn}</small>}
          </li>)}
        </ul>
      </div>}
    </div>
  </div>;
}

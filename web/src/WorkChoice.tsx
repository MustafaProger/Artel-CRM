import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, ChevronRight } from 'lucide-react';

type ChoiceOption = { value: string; name: string; disabled?: boolean; group?: string };

export default function WorkChoice({ label, value, options, onChange, disabled = false, priority = false, placeholder = false, portalMenu = false, selectedValues, projectHeading = false }: {
  label: string;
  value: string;
  options: ChoiceOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  priority?: boolean;
  placeholder?: boolean;
  portalMenu?: boolean;
  selectedValues?: readonly string[];
  projectHeading?: boolean;
}) {
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ top: 0, left: 0, width: 0, maxHeight: 0, above: true });
  const selected = selectedValues
    ? selectedValues.map(id => options.find(option => option.value === id)).filter(option => option !== undefined)
    : options.filter(option => option.value === value);
  useLayoutEffect(() => {
    if (!open || !portalMenu) return;
    const place = () => {
      const host = root.current?.closest('dialog');
      const anchor = trigger.current;
      if (!host || !anchor) return;
      const dialogRect = host.getBoundingClientRect(), rect = anchor.getBoundingClientRect();
      const width = Math.min(priority ? 220 : 190, dialogRect.width - 16);
      const spaceAbove = rect.top - Math.max(dialogRect.top, 0);
      const spaceBelow = Math.min(dialogRect.bottom, window.innerHeight) - rect.bottom;
      const above = spaceAbove >= Math.min(spaceBelow, 220);
      setMenuPosition({
        top: (above ? rect.top - 5 : rect.bottom + 5) - dialogRect.top,
        left: Math.max(8, Math.min(rect.left - dialogRect.left, dialogRect.width - width - 8)),
        width, maxHeight: Math.min(220, Math.max(spaceAbove, spaceBelow) - 10), above,
      });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => { window.removeEventListener('resize', place); window.removeEventListener('scroll', place, true); };
  }, [open, portalMenu, priority]);
  useLayoutEffect(() => {
    const list = menu.current;
    if (!open || !projectHeading || !list) return;
    const active = list.querySelector('[aria-selected="true"]');
    if (!active) return;
    const { left, right } = active.getBoundingClientRect();
    const listLeft = list.getBoundingClientRect().left + list.clientLeft;
    const listRight = listLeft + list.clientWidth;
    if (left < listLeft) list.scrollLeft += left - listLeft - 5;
    if (right > listRight) list.scrollLeft += right - listRight + 5;
  }, [open, projectHeading, value]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node) && !menu.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  const focusOption = (index: number) => {
    const choices = Array.from((menu.current ?? root.current)?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
    choices[(index + choices.length) % choices.length]?.focus();
  };
  const stepForKey = (key: string) => {
    if (key === 'ArrowDown' || (projectHeading && key === 'ArrowRight')) return 1;
    if (key === 'ArrowUp' || (projectHeading && key === 'ArrowLeft')) return -1;
    return 0;
  };
  const renderOption = (option: ChoiceOption) => <button key={option.value} type="button" role="option"
    tabIndex={projectHeading ? -1 : undefined} title={projectHeading ? option.name : undefined} aria-selected={selected.includes(option)} disabled={option.disabled}
    onMouseDown={projectHeading ? event => event.preventDefault() : undefined}
    onClick={() => {
      onChange(option.value);
      if (!selectedValues) {
        setOpen(false);
        trigger.current?.focus({ preventScroll: true });
      }
    }}>
    {priority && <span className={`work-priority-dot work-priority-${option.value}`} aria-hidden="true"/>}
    <span>{option.name}</span>{!projectHeading && selected.includes(option) && <Check size={15} aria-hidden="true"/>}
  </button>;
  const groups = [...new Set(options.map(option => option.group))];
  const choices = <div ref={menu} id={`${id}-options`} className={`work-choice-options${portalMenu ? ` work-choice-portal${menuPosition.above ? '' : ' is-below'}` : ''}`} role="listbox" aria-orientation={projectHeading ? 'horizontal' : undefined} aria-multiselectable={selectedValues ? true : undefined} aria-labelledby={`${id}-label`} style={portalMenu ? { top: menuPosition.top, left: menuPosition.left, width: menuPosition.width, maxHeight: menuPosition.maxHeight } : undefined} onKeyDown={event => {
    event.stopPropagation();
    if (event.key === 'Escape') { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    const step = stepForKey(event.key);
    if (step) {
      event.preventDefault();
      const available = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="option"]:not(:disabled)') ?? []);
      focusOption(available.indexOf(document.activeElement as HTMLButtonElement) + step);
    }
  }}>{groups.some(Boolean) ? groups.map((group, index) => {
    const groupLabel = `${id}-group-${index}`;
    return <div key={group ?? ''} role="group" aria-labelledby={groupLabel}>
      <span id={groupLabel} className="work-choice-group-label">{group || 'Без группы'}</span>
      <div className="work-choice-group-options">{options.filter(option => option.group === group).map(renderOption)}</div>
    </div>;
  }) : options.map(renderOption)}</div>;
  const host = portalMenu ? root.current?.closest('dialog') : null;
  const selectedName = selected.map(option => option.name).join(', ');
  const Chevron = projectHeading ? ChevronRight : ChevronDown;
  const control = <button ref={trigger} type="button" className={`work-choice-trigger${placeholder ? ' is-placeholder' : ''}`} role="combobox" aria-labelledby={`${id}-label`} aria-controls={`${id}-options`} aria-expanded={open} aria-haspopup="listbox" disabled={disabled}
    onMouseDown={projectHeading ? event => event.preventDefault() : undefined}
    onClick={() => {
      if (projectHeading) trigger.current?.focus({ preventScroll: true });
      setOpen(previous => !previous);
    }}>
      {priority && !placeholder && <span className={`work-priority-dot work-priority-${value}`} aria-hidden="true"/>}
      <span className="work-choice-value" title={selectedName}>{placeholder ? label.replace(' *', '') : selectedName || label}</span>
      <Chevron size={15} aria-hidden="true"/>
    </button>;
  return <div ref={root} className={`work-field work-choice${projectHeading ? ' kb-picker' : ''}${priority ? ' work-priority-field' : ''}`} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget) && !menu.current?.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); setOpen(false); trigger.current?.focus(); }
    const step = stepForKey(event.key);
    if (!step) return;
    event.preventDefault();
    if (!open) {
      setOpen(true);
      requestAnimationFrame(() => focusOption(step > 0 ? 0 : -1));
    } else {
      focusOption(step > 0 ? 0 : -1);
    }
  }}>
    <span id={`${id}-label`} className={projectHeading ? 'work-choice-label' : undefined}>{label}</span>
    {projectHeading ? <h2 aria-label={selectedName}>{control}</h2> : control}
    {open && (host ? createPortal(choices, host) : choices)}
  </div>;
}

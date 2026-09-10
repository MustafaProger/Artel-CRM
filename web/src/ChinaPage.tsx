import { useCallback, useEffect, useRef, useState } from 'react';
import { chinaTotals, sumChinaAmounts } from './china-calculations';
import { Plus, Save, X } from 'lucide-react';
import DirectorySelect from './DirectorySelect';
import type { Company } from './model';
import type { ChinaData, ChinaDay, ChinaFuel } from './china-model';
import { formatDate } from './utils';
import { today } from './shipment-calculations';
import './china.css';
const number = (value: string) => { const [whole, fraction] = value.split('.'); return whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0') + (fraction ? `,${fraction}` : ''); };
const sum = sumChinaAmounts;
type Editor = { kind: 'days' | 'payments'; day?: ChinaDay };
type ChinaResponse = { china: ChinaData; suppliers: Company[] };
export default function ChinaPage({ canManage }: { canManage: boolean }) {
  const [data, setData] = useState<ChinaResponse | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(false), [notice, setNotice] = useState('');
  const request = useRef<AbortController | null>(null);
  const [editor, setEditor] = useState<Editor | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController(); request.current = controller; const signal = controller.signal;
    setLoading(true);
    try { const response = await fetch('/api/china', { signal, cache: 'no-store' }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Не удалось загрузить учёт.'); if (!signal?.aborted) { setData(result); setError(''); } }
    catch (reason) { if (!signal?.aborted) setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.'); }
    finally { if (!signal?.aborted) setLoading(false); }
  }, []);
  useEffect(() => { if (!canManage) return; void refresh(); const visible = () => {if (document.visibilityState === 'visible') void refresh()}; const timer = window.setInterval(visible, 30000); window.addEventListener('focus', visible); return () => { request.current?.abort(); clearInterval(timer); window.removeEventListener('focus', visible) }; }, [refresh, canManage]);
  const days = data ? [...new Set([...data.china.days.map(day => day.date), ...data.china.payments.map(payment => payment.date)])].sort().reverse() : [];
  const totals = data ? chinaTotals(data.china) : null;
  return <section className="panel china-page"><header className="china-heading"><h2>Артель Китай</h2><span className="china-period">За всё время</span></header>
    {canManage && <div className="china-totals" aria-label="Итоги Китая" aria-busy={loading}><div className="china-balance"><span>Баланс</span><strong data-testid="china-balance">{totals ? number(totals.balance) : '—'}</strong><small>Поступления минус заправки</small></div><div><span>Поступления</span><strong data-testid="china-total-payments">{totals ? number(totals.payments) : '—'}</strong></div><div><span>Заправки</span><strong data-testid="china-total-fuel">{totals ? number(totals.fuel) : '—'}</strong></div></div>}
    {!canManage ? <p className="china-hint">Учёт доступен директору и администратору в рамках действующих ролей.</p> : <>
      <div className="china-actions"><button className="button primary" disabled={!data || loading} onClick={() => setEditor({ kind: 'days' })}><Plus size={16}/>Добавить день</button><button className="button" disabled={!data || loading} onClick={() => setEditor({ kind: 'payments' })}><Plus size={16}/>Добавить платёж</button><button className="button" disabled={loading} onClick={() => void refresh()}>Обновить</button></div>
      {notice && <p className="work-notice" role="status">{notice}</p>}{error && <p className="shipment-error" role="alert">{error}</p>}
      <div className="china-table-scroll"><table className="china-table"><thead><tr><th>Дата</th><th title="Количество литров">Литры</th><th title="Сумма заправок">Заправки</th><th>Поступления</th></tr></thead><tbody>{days.map(date => { const day = data!.china.days.find(day => day.date === date); const payments = data!.china.payments.filter(payment => payment.date === date); return <tr key={date}><td>{day ? <button className="china-day-link" aria-label={`Открыть день ${date}`} onClick={() => setEditor({ kind: 'days', day })}>{<ChinaDate date={date}/>}</button> : <ChinaDate date={date}/>}</td><td>{day ? number(sum(day.fuels.map(fuel => fuel.litres))) : '—'}</td><td>{day ? <><strong>{number(sum(day.fuels.map(fuel => fuel.amount)))}</strong><details className="china-details"><summary>Заправки · {day.fuels.length}</summary>{day.fuels.map((fuel, index) => <div key={index}>{data!.suppliers.find(supplier => supplier.id === fuel.supplierId)?.name ?? 'Поставщик недоступен'}<small>{number(fuel.litres)} л · {number(fuel.amount)}</small></div>)}</details></> : '—'}</td><td className="china-incoming">{payments.length ? <><strong>+{number(sum(payments.map(payment => payment.amount)))}</strong><details className="china-details"><summary>Платежи · {payments.length}</summary>{payments.map(payment => <div key={payment.id}>+{number(payment.amount)}</div>)}</details></> : '—'}</td></tr>; })}</tbody></table></div>
      {!days.length && <p className="china-hint">{loading ? 'Загрузка…' : 'Заправки и платежи пока не внесены.'}</p>}
      {editor && data && <ChinaEditor editor={editor} suppliers={data.suppliers.filter(supplier => !supplier.directoryArchived || editor.day?.fuels.some(fuel => fuel.supplierId === supplier.id))} onClose={() => setEditor(null)} onSaved={() => { setEditor(null); setNotice('Запись сохранена.'); void refresh(); }}/>}</>}
  </section>;
}
function ChinaDate({ date }: { date: string }) {
  return <time dateTime={date} title={formatDate(date)} aria-label={formatDate(date)}>{date.slice(8,10)}.{date.slice(5,7)}<span className="china-date-year">.{date.slice(0,4)}</span></time>;
}
function ChinaEditor({ editor, suppliers, onClose, onSaved }: { editor: Editor; suppliers: Company[]; onClose: () => void; onSaved: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), busy = useRef(false);
  const [requestId] = useState(() => crypto.randomUUID());
  const [date, setDate] = useState(editor.day?.date ?? today()), [amount, setAmount] = useState('');
  const [fuels, setFuels] = useState<ChinaFuel[]>(editor.day?.fuels ?? [{ supplierId: '', litres: '', amount: '' }]);
  const [saving, setSaving] = useState(false), [error, setError] = useState(''), [dirty, setDirty] = useState(false), [confirmClose, setConfirmClose] = useState(false);
  useEffect(() => { const element = dialog.current; element?.showModal(); return () => element?.close(); }, []);
  useEffect(() => { if (!dirty) return; const prevent = (event: BeforeUnloadEvent) => event.preventDefault(); window.addEventListener('beforeunload', prevent); return () => window.removeEventListener('beforeunload', prevent); }, [dirty]);
  const close = () => { if (busy.current) return; if (dirty) setConfirmClose(true); else onClose(); };
  const update = (index: number, key: keyof ChinaFuel, value: string) => { setFuels(rows => rows.map((row, i) => i === index ? { ...row, [key]: value } : row)); setDirty(true); };
  return <dialog ref={dialog} className="detail-dialog work-editor china-editor" aria-labelledby="china-editor-title" onCancel={event => { event.preventDefault(); close(); }}><form onSubmit={async event => {
    event.preventDefault(); if (busy.current) return; busy.current = true; setSaving(true); setError('');
    try { const response = await fetch(`/api/china/${editor.kind}${editor.day ? `/${encodeURIComponent(editor.day.id)}` : ''}`, { method: editor.day ? 'PATCH' : 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ date, ...(editor.day ? { version: editor.day.version } : { requestId }), ...(editor.kind === 'days' ? { fuels: fuels.map(row => ({ ...row, litres: row.litres.replace(',', '.').trim(), amount: row.amount.replace(',', '.').trim() })) } : { amount: amount.replace(',', '.').trim() }) }) }); const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Не удалось сохранить запись.'); onSaved(); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Нет связи с сервером.'); } finally { busy.current = false; setSaving(false); }
  }}><header className="work-editor-heading"><h2 id="china-editor-title">{editor.kind === 'days' ? editor.day ? 'Заправки за день' : 'Добавить день' : 'Добавить платёж'}</h2><button type="button" className="icon-button" aria-label="Закрыть форму Китая" onClick={close} disabled={saving}><X size={20}/></button></header><div className="work-editor-body"><label className="work-field"><span>Дата</span><input type="date" aria-label="Дата" required disabled={saving} value={date} onChange={event => { setDate(event.target.value); setDirty(true); }}/></label>
    {editor.kind === 'days' ? <><p className="work-hint">Дизельное топливо</p>{fuels.map((fuel, index) => <fieldset className="china-fuel-row" key={index}><legend>Заправка {index + 1}</legend><DirectorySelect label={`Поставщик ${index + 1}`} entries={suppliers.map(supplier => ({ id: supplier.id, name: supplier.name, detail: supplier.inn }))} value={fuel.supplierId} onChange={id => update(index, 'supplierId', id)} required disabled={saving}/><div className="work-field-grid">{([['litres', 'Количество литров'], ['amount', 'Сумма']] as const).map(([key, label]) => <label className="work-field" key={key}><span>{label}</span><input aria-label={`${label} ${index + 1}`} inputMode="decimal" required disabled={saving} value={fuel[key]} onChange={event => update(index, key, event.target.value)}/></label>)}</div>{fuels.length > 1 && <button type="button" className="button" aria-label={`Удалить строку ${index + 1}`} disabled={saving} onClick={() => { setFuels(fuels.filter((_, i) => i !== index)); setDirty(true); }}>Удалить строку</button>}</fieldset>)}<button type="button" className="button" disabled={saving || fuels.length >= 100} onClick={() => { setFuels([...fuels, { supplierId: '', litres: '', amount: '' }]); setDirty(true); }}><Plus size={16}/>Добавить поставщика</button></> : <label className="work-field"><span>Сумма платежа</span><input aria-label="Сумма платежа" inputMode="decimal" required value={amount} disabled={saving} onChange={event => { setAmount(event.target.value); setDirty(true); }}/></label>}
    {error && <p className="shipment-error" role="alert">{error}</p>}{confirmClose && <div className="work-confirm" role="alert"><p>Закрыть без сохранения изменений?</p><button type="button" className="button" onClick={() => setConfirmClose(false)}>Продолжить редактирование</button><button type="button" className="button" onClick={onClose}>Не сохранять</button></div>}</div><footer className="work-editor-footer"><button type="button" className="button" onClick={close} disabled={saving}>Отмена</button><button className="button primary" type="submit" disabled={saving}><Save size={16}/>{saving ? 'Сохранение…' : 'Сохранить'}</button></footer></form></dialog>;
}

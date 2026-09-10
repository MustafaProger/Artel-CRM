import { Fragment, useMemo, useState } from 'react';
import { ArrowDownToLine, ChevronDown, ChevronLeft, ChevronRight, Layers3, Warehouse, X } from 'lucide-react';
import type { Snapshot } from './model';
import './source-pages.css';

const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const fieldLabels: Record<string, string> = {
  incoming_litres: 'Приход, л', incoming_amount: 'Приход, ₽', outgoing_litres: 'Расход, л', outgoing_amount: 'Расход, ₽', balance_litres: 'Остаток, л', balance_amount: 'Остаток, ₽', date: 'Дата', customer_name: 'Покупатель', supplier_name: 'Поставщик', counterparty_name: 'Контрагент', quantity_litres: 'Объём, л', customer_amount: 'Сумма покупателя', payment_purpose: 'Назначение платежа', purpose: 'Назначение платежа',
};

function downloadJson(filename: string, value: unknown) {
  const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json;charset=utf-8' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function numberLabel(value: string | null | undefined) {
  if (value === null || value === undefined || value === '') return 'Нет данных';
  if (!/^[-+]?\d+(\.\d+)?$/.test(value)) return value;
  return new Intl.NumberFormat('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value));
}

function Pager({ page, total, size, onChange }: { page: number; total: number; size: number; onChange: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(total / size));
  return <div className="sp-pagination"><span>{total ? `${page * size + 1}–${Math.min((page + 1) * size, total)} из ${total}` : '0 записей'}</span><div><button type="button" aria-label="Предыдущая страница" disabled={page === 0} onClick={() => onChange(page - 1)}><ChevronLeft size={16} /></button><span>{page + 1} / {pages}</span><button type="button" aria-label="Следующая страница" disabled={page >= pages - 1} onClick={() => onChange(page + 1)}><ChevronRight size={16} /></button></div></div>;
}

function ValueGrid({ fields }: { fields: Record<string, string | null> }) {
  return <dl className="sp-value-grid">{Object.entries(fields).map(([key, value]) => <div key={key}><dt>{fieldLabels[key] || key}</dt><dd className={value === null ? 'sp-unavailable' : undefined}>{value === null ? 'Нет данных в источнике' : value === '' ? 'Пустая строка' : value}</dd></div>)}</dl>;
}

function StockValue({ value, raw }: { value: string | null; raw: string | null | undefined }) {
  if (value === null) return <span className="sp-unavailable" title={raw || 'Значение отсутствует в снимке'}>{raw || 'Нет данных'}</span>;
  return <span className="sp-number">{numberLabel(value)}</span>;
}

export function StockPage({ data }: { data: Snapshot }) {
  const [label, setLabel] = useState('all');
  const [month, setMonth] = useState('all');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const labels = useMemo(() => [...new Set(data.stocks.map(stock => stock.label))], [data.stocks]);
  const filtered = useMemo(() => data.stocks.filter(stock => (label === 'all' || stock.label === label) && (month === 'all' || stock.month === month)), [data.stocks, label, month]);
  const changeFilter = (kind: 'label' | 'month', value: string) => { if (kind === 'label') setLabel(value); else setMonth(value); setPage(0); setExpanded(null); };

  return <div className="sp-page">
    <div className="sp-stats-grid"><div className="panel sp-stat"><div className="sp-stat-icon"><Warehouse size={21} /></div><span>Объектов склада</span><strong>{labels.length}</strong><small>Склад и топливные операторы</small></div><div className="panel sp-stat"><div className="sp-stat-icon"><Layers3 size={21} /></div><span>Месячных сводок</span><strong>{data.stocks.length}</strong><small>Период: январь — декабрь</small></div></div>
    <section className="panel sp-table-panel" aria-labelledby="stock-table-title"><div className="sp-panel-heading"><div><h2 id="stock-table-title">Сводки по объектам</h2><p>Склад · {filtered.length} записей</p></div><div className="sp-heading-controls"><button className="button sp-export" type="button" onClick={() => downloadJson('artel-stock-summaries.json', { provenance: data.provenance, filters: { label, month }, stocks: filtered })}><ArrowDownToLine size={15} /> Экспорт JSON</button></div></div><div className="sp-filter-bar"><label><Warehouse size={16} /><select aria-label="Объект склада" value={label} onChange={event => changeFilter('label', event.target.value)}><option value="all">Все объекты</option>{labels.map(name => <option key={name}>{name}</option>)}</select></label><label><select aria-label="Месяц складской сводки" value={month} onChange={event => changeFilter('month', event.target.value)}><option value="all">Все месяцы</option>{monthNames.map((name, index) => <option key={name} value={String(index + 1)}>{name}</option>)}</select></label>{(label !== 'all' || month !== 'all') && <button type="button" className="sp-clear" onClick={() => { setLabel('all'); setMonth('all'); setPage(0); setExpanded(null); }}><X size={14} /> Сбросить</button>}</div>
      <div className="sp-table-scroll"><table className="sp-table sp-stock-table"><thead><tr><th>Объект / месяц</th><th>Приход, л</th><th data-field="incoming_amount">Приход, ₽</th><th>Расход, л</th><th data-field="outgoing_amount">Расход, ₽</th><th className="align-right">Остаток, л</th><th className="align-right">Остаток, ₽</th><th>Источник</th></tr></thead><tbody>{filtered.slice(page * 12, page * 12 + 12).map(stock => <Fragment key={stock.id}><tr className={expanded === stock.id ? 'sp-selected-row' : undefined}><td><span className="sp-entity-name">{stock.label}</span><span className="sp-cell-subtitle">{monthNames[Number(stock.month) - 1] || stock.month}</span></td><td><StockValue value={stock.incomingLiters} raw={stock.fields.incoming_litres} /></td><td data-field="incoming_amount"><StockValue value={stock.incomingAmount} raw={stock.fields.incoming_amount} /></td><td><StockValue value={stock.outgoingLiters} raw={stock.fields.outgoing_litres} /></td><td data-field="outgoing_amount"><StockValue value={stock.outgoingAmount} raw={stock.fields.outgoing_amount} /></td><td className="sp-balance-cell align-right"><StockValue value={stock.balanceLiters} raw={stock.fields.balance_litres} /></td><td className="align-right"><StockValue value={stock.balanceAmount} raw={stock.fields.balance_amount} /></td><td><button type="button" className="sp-source-link" aria-expanded={expanded === stock.id} onClick={() => setExpanded(expanded === stock.id ? null : stock.id)}>Строка {stock.sourceRow}<ChevronDown size={13} className={expanded === stock.id ? 'sp-rotate' : undefined} /></button></td></tr>{expanded === stock.id && <tr className="sp-detail-row"><td colSpan={8}><div className="sp-detail-content"><strong>{stock.sourceSheet} · строка {stock.sourceRow} · {stock.label}</strong><p>Все шесть значений из выбранной сводки. Полная исходная точность сохранена ниже.</p><ValueGrid fields={stock.fields} /><span className="sp-detail-note">Сохранённый результат формул · без пересчёта</span></div></td></tr>}</Fragment>)}</tbody></table></div>{!filtered.length && <div className="sp-empty"><Warehouse size={28} /><h3>Сводок не найдено</h3><p>Выберите другой объект или месяц.</p></div>}<Pager page={page} total={filtered.length} size={12} onChange={setPage} /></section>
  </div>;
}

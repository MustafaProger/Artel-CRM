import { Fragment, useEffect, useMemo, useState } from 'react';
import { AlertCircle, ArrowDownToLine, Check, ChevronDown, ChevronLeft, ChevronRight, Copy, FileSpreadsheet, Info, Layers3, Search, ShieldCheck, Warehouse, X } from 'lucide-react';
import type { QualityIssue, Shipment, Snapshot } from './model';
import './source-pages.css';

const monthNames = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const issueLabels: Record<string, { title: string; description: string }> = {
  broken_formula_reference: { title: 'Ссылки в формулах', description: 'В формулах исходного файла есть повреждённые ссылки.' },
  cached_excel_error: { title: 'Ошибки Excel', description: 'Сохранённый результат ячейки содержит ошибку Excel.' },
  summary_range_ends_before_last_source_row: { title: 'Неполные диапазоны', description: 'Диапазон сводной формулы заканчивается раньше данных.' },
  money_stored_as_text: { title: 'Суммы в текстовом виде', description: 'Денежное значение записано текстом; исходное значение сохранено.' },
};
const flagLabels: Record<string, string> = {
  manager_formula_broken: 'Повреждена формула менеджера', manager_unresolved: 'Менеджер не определён', missing_customer: 'Не указан покупатель', missing_supplier: 'Не указан поставщик', missing_counterparty: 'Не указан контрагент', no_nonzero_amount: 'Нет ненулевой суммы', missing_or_invalid_date: 'Дата отсутствует или некорректна', both_incoming_and_outgoing: 'Одновременно приход и расход', incoming_amount_stored_as_text: 'Сумма прихода записана текстом',
};
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
  const missing = data.stocks.reduce((sum, stock) => sum + [stock.incomingLiters, stock.incomingAmount, stock.outgoingLiters, stock.outgoingAmount, stock.balanceLiters, stock.balanceAmount].filter(value => value === null).length, 0);
  const allZero = data.stocks.length > 0 && data.stocks.every(stock => Object.values(stock.fields).every(value => value !== null && /^[-+]?0+(\.0+)?$/.test(value)));
  const changeFilter = (kind: 'label' | 'month', value: string) => { if (kind === 'label') setLabel(value); else setMonth(value); setPage(0); setExpanded(null); };

  return <div className="sp-page">
    <div className="sp-stats-grid"><div className="panel sp-stat"><div className="sp-stat-icon"><Warehouse size={21} /></div><span>Объектов в файле</span><strong>{labels.length}</strong><small>Склад и топливные операторы</small></div><div className="panel sp-stat"><div className="sp-stat-icon"><Layers3 size={21} /></div><span>Месячных сводок</span><strong>{data.stocks.length}</strong><small>Период: январь — декабрь</small></div><div className="panel sp-stat"><div className="sp-stat-icon"><FileSpreadsheet size={21} /></div><span>Полнота значений</span><strong>{data.stocks.length * 6 - missing}<span className="sp-stat-unit"> / {data.stocks.length * 6}</span></strong><small>{missing ? `${missing} значений отсутствуют или содержат ошибку` : 'Сохранённые числовые значения'}</small></div></div>
    <div className="sp-notice"><Info size={19} /><div><strong>Это снимок сохранённых формул</strong><p>Значения из XLSX не пересчитывались и не подтверждают текущий остаток. {allZero ? `Все ${data.stocks.length} сводок содержат нули — это результат, сохранённый в файле, а не подтверждение отсутствия топлива.` : 'Отсутствующие значения и ошибки отображаются отдельно от нулей.'} Год в строках этих сводок не указан.</p></div></div>
    <section className="panel sp-table-panel" aria-labelledby="stock-table-title"><div className="sp-panel-heading"><div><h2 id="stock-table-title">Сводки по объектам</h2><p>Исходный лист «Склад» · {filtered.length} записей</p></div><div className="sp-heading-controls"><span className="badge">Кэш XLSX</span><button className="button sp-export" type="button" onClick={() => downloadJson('artel-stock-summaries.json', { provenance: data.provenance, filters: { label, month }, stocks: filtered })}><ArrowDownToLine size={15} /> Экспорт JSON</button></div></div><div className="sp-filter-bar"><label><Warehouse size={16} /><select aria-label="Объект склада" value={label} onChange={event => changeFilter('label', event.target.value)}><option value="all">Все объекты</option>{labels.map(name => <option key={name}>{name}</option>)}</select></label><label><select aria-label="Месяц складской сводки" value={month} onChange={event => changeFilter('month', event.target.value)}><option value="all">Все месяцы</option>{monthNames.map((name, index) => <option key={name} value={String(index + 1)}>{name}</option>)}</select></label>{(label !== 'all' || month !== 'all') && <button type="button" className="sp-clear" onClick={() => { setLabel('all'); setMonth('all'); setPage(0); setExpanded(null); }}><X size={14} /> Сбросить</button>}</div>
      <div className="sp-table-scroll"><table className="sp-table sp-stock-table"><thead><tr><th>Объект / месяц</th><th>Приход, л</th><th data-field="incoming_amount">Приход, ₽</th><th>Расход, л</th><th data-field="outgoing_amount">Расход, ₽</th><th className="align-right">Остаток, л</th><th className="align-right">Остаток, ₽</th><th>Источник</th></tr></thead><tbody>{filtered.slice(page * 12, page * 12 + 12).map(stock => <Fragment key={stock.id}><tr className={expanded === stock.id ? 'sp-selected-row' : undefined}><td><span className="sp-entity-name">{stock.label}</span><span className="sp-cell-subtitle">{monthNames[Number(stock.month) - 1] || stock.month}</span></td><td><StockValue value={stock.incomingLiters} raw={stock.fields.incoming_litres} /></td><td data-field="incoming_amount"><StockValue value={stock.incomingAmount} raw={stock.fields.incoming_amount} /></td><td><StockValue value={stock.outgoingLiters} raw={stock.fields.outgoing_litres} /></td><td data-field="outgoing_amount"><StockValue value={stock.outgoingAmount} raw={stock.fields.outgoing_amount} /></td><td className="sp-balance-cell align-right"><StockValue value={stock.balanceLiters} raw={stock.fields.balance_litres} /></td><td className="align-right"><StockValue value={stock.balanceAmount} raw={stock.fields.balance_amount} /></td><td><button type="button" className="sp-source-link" aria-expanded={expanded === stock.id} onClick={() => setExpanded(expanded === stock.id ? null : stock.id)}>Строка {stock.sourceRow}<ChevronDown size={13} className={expanded === stock.id ? 'sp-rotate' : undefined} /></button></td></tr>{expanded === stock.id && <tr className="sp-detail-row"><td colSpan={8}><div className="sp-detail-content"><strong>{stock.sourceSheet} · строка {stock.sourceRow} · {stock.label}</strong><p>Все шесть значений из выбранной сводки. Полная исходная точность сохранена ниже.</p><ValueGrid fields={stock.fields} /><span className="sp-detail-note">Сохранённый результат формул · без пересчёта</span></div></td></tr>}</Fragment>)}</tbody></table></div>{!filtered.length && <div className="sp-empty"><Warehouse size={28} /><h3>Сводок не найдено</h3><p>Выберите другой объект или месяц.</p></div>}<Pager page={page} total={filtered.length} size={12} onChange={setPage} /></section>
  </div>;
}

function IssueDetails({ issue, data }: { issue: QualityIssue; data: Snapshot }) {
  const remote = useShipmentReference(issue.dataset === 'shipments' ? issue.recordId : null);
  const record = issue.dataset === 'shipments' ? remote.record : issue.dataset === 'payments' ? data.payments.find(item => item.id === issue.recordId) : issue.dataset === 'stocks' ? data.stocks.find(item => item.id === issue.recordId) : undefined;
  return <div className="sp-detail-content"><div className="sp-detail-top"><strong>{issue.sheet} · {issue.cell || `строка ${issue.sourceRow ?? 'не указана'}`}</strong><code>{issue.code}</code></div><p>{issueLabels[issue.code]?.description || 'Сведения из отчёта проверки исходного файла.'}</p>{issue.value !== null && <div className="sp-original-value"><span>Значение в источнике</span><code>{issue.value}</code></div>}{issue.detail && <pre className="sp-issue-extra">{issue.detail}</pre>}{remote.error && <p role="alert">{remote.error}</p>}{record && <details className="sp-record-fields"><summary>Поля связанной строки {record.sourceRow}</summary><ValueGrid fields={record.fields} /></details>}<span className="sp-detail-note">Замечание зафиксировано в снимке. Исходный файл не изменён.</span></div>;
}

function Duplicates({ data }: { data: Snapshot }) {
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<{ dataset: string; row: number } | null>(null);
  const candidates = data.quality.duplicateCandidates;
  const remote = useShipmentReference(null, selected?.dataset === 'shipments' ? selected.row : null);
  const record = selected?.dataset === 'shipments' ? remote.record : data.payments.find(item => item.sourceRow === selected?.row);
  return <section className="panel sp-secondary-panel"><details><summary><span className="sp-summary-copy"><strong>Возможные дубли операций <span className="sp-count">{candidates.length}</span></strong><small>Совпадение полей требует ручной проверки</small></span><ChevronDown size={18} /></summary><div className="sp-candidates"><p className="sp-candidate-note">Строки сохранены по отдельности. Совпадение не доказывает, что это одна операция.</p>{candidates.slice(page * 8, page * 8 + 8).map((candidate, index) => <div className="sp-candidate-row" key={`${candidate.dataset}-${candidate.rows.join('-')}-${index}`}><span>{candidate.dataset === 'shipments' ? 'Бензовозы' : 'Выписка'}</span><div>{candidate.rows.map(row => <button type="button" className="sp-source-link" key={row} onClick={() => setSelected({ dataset: candidate.dataset, row })}>Строка {row}</button>)}</div></div>)}{remote.error && <p className="soft-notice" role="alert">{remote.error}</p>}{record && <div className="sp-candidate-preview"><div className="sp-detail-top"><strong>{record.sourceSheet} · строка {record.sourceRow}</strong><button type="button" className="sp-icon-button" aria-label="Закрыть сведения о строке" onClick={() => setSelected(null)}><X size={16} /></button></div><ValueGrid fields={record.fields} /></div>}<Pager page={page} total={candidates.length} size={8} onChange={setPage} /></div></details></section>;
}

function Aliases({ data }: { data: Snapshot }) {
  const [page, setPage] = useState(0);
  const candidates = data.quality.aliasCandidates;
  return <section className="panel sp-secondary-panel"><details><summary><span className="sp-summary-copy"><strong>Похожие названия компаний <span className="sp-count">{candidates.length}</span></strong><small>Кандидаты на сверку, без автоматического объединения</small></span><ChevronDown size={18} /></summary><div className="sp-candidates"><p className="sp-candidate-note">Названия взяты из файла. Проверка по государственному реестру не проводилась.</p>{candidates.slice(page * 8, page * 8 + 8).map((candidate, index) => <div className="sp-alias-row" key={`${candidate.ids.join('-')}-${index}`}>{candidate.names.map((name, nameIndex) => <span key={`${name}-${nameIndex}`}>{name}</span>)}</div>)}<Pager page={page} total={candidates.length} size={8} onChange={setPage} /></div></details></section>;
}

export function QualityPage({ data }: { data: Snapshot }) {
  const [code, setCode] = useState('all');
  const [sheet, setSheet] = useState('all');
  const [severity, setSeverity] = useState('all');
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const sheets = useMemo(() => [...new Set(data.quality.issues.map(issue => issue.sheet))], [data.quality.issues]);
  const issues = useMemo(() => data.quality.issues.filter(issue => (code === 'all' || issue.code === code) && (sheet === 'all' || issue.sheet === sheet) && (severity === 'all' || issue.severity === severity) && `${issue.sheet} ${issue.cell} ${issue.code} ${issueLabels[issue.code]?.title || ''} ${issue.value || ''}`.toLocaleLowerCase('ru-RU').includes(query.trim().toLocaleLowerCase('ru-RU'))), [data.quality.issues, code, sheet, severity, query]);
  const sourceDate = new Date(data.provenance.exportedAt);
  const formattedDate = Number.isNaN(sourceDate.getTime()) ? data.provenance.exportedAt : sourceDate.toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Moscow' });
  const reset = () => { setCode('all'); setSheet('all'); setSeverity('all'); setQuery(''); setPage(0); setExpanded(null); };
  const filterCode = (value: string) => { setCode(value); setPage(0); setExpanded(null); };
  const copyHash = async () => { try { await navigator.clipboard.writeText(data.provenance.sourceSha256); setCopied(true); setCopyFailed(false); setTimeout(() => setCopied(false), 2200); } catch { setCopyFailed(true); } };

  return <div className="sp-page">
    <section className="panel sp-provenance"><div className="sp-file-icon"><FileSpreadsheet size={25} /></div><div className="sp-file-info"><strong>{data.provenance.sourceFile}</strong><span>Локальный снимок · {formattedDate} МСК</span><div className="sp-file-tags"><span className="sp-tag"><Check size={12} /> {data.provenance.counts.sheets ?? 3} листа</span><span className="sp-tag">XLSX</span><span className="sp-tag sp-tag-neutral">Google не подключён</span></div></div><div className="sp-provenance-status"><ShieldCheck size={18} /><div><strong>{data.provenance.sourceFilesVerified ? 'Целостность снимка проверена' : 'Локальный источник'}</strong><span>Сохранены исходные значения</span></div></div></section>
    <div className="sp-notice sp-notice-warning"><AlertCircle size={19} /><div><strong>В исходном файле есть замечания</strong><p>{data.quality.issues.length} замечаний к ячейкам. Они могут пересекаться с флагами операций ниже. Формулы не пересчитаны, компании не объединены, исходные данные не исправлены.</p></div></div>
    <div className="sp-issue-cards">{Object.entries(data.quality.issueCounts).map(([key, count]) => <button key={key} type="button" className={`panel sp-issue-card ${code === key ? 'sp-issue-card-active' : ''}`} onClick={() => filterCode(code === key ? 'all' : key)} aria-pressed={code === key}><span>{issueLabels[key]?.title || key}<ChevronRight size={15} /></span><strong>{count}</strong><small>{issueLabels[key]?.description || 'Замечания из исходного отчёта'}</small></button>)}</div>
    <section className="panel sp-table-panel" aria-labelledby="quality-table-title"><div className="sp-panel-heading"><div><h2 id="quality-table-title">Замечания к ячейкам</h2><p>Нажмите на строку источника, чтобы увидеть детали</p></div><div className="sp-heading-controls"><span className="sp-count">{issues.length}</span><button className="button sp-export" type="button" onClick={() => downloadJson('artel-quality-report.json', { provenance: data.provenance, quality: data.quality })}><ArrowDownToLine size={15} /> Скачать отчёт</button></div></div><div className="sp-filter-bar"><label className="sp-search"><Search size={16} /><input aria-label="Поиск замечаний" placeholder="Лист, ячейка или замечание" value={query} onChange={event => { setQuery(event.target.value); setPage(0); }} /></label><label><select aria-label="Категория замечания" value={code} onChange={event => filterCode(event.target.value)}><option value="all">Все категории</option>{Object.keys(data.quality.issueCounts).map(key => <option value={key} key={key}>{issueLabels[key]?.title || key}</option>)}</select></label><label><select aria-label="Лист источника" value={sheet} onChange={event => { setSheet(event.target.value); setPage(0); }}><option value="all">Все листы</option>{sheets.map(name => <option key={name}>{name}</option>)}</select></label><label><select aria-label="Уровень замечания" value={severity} onChange={event => { setSeverity(event.target.value); setPage(0); }}><option value="all">Все уровни</option><option value="error">Ошибки</option><option value="warning">Предупреждения</option></select></label>{(code !== 'all' || sheet !== 'all' || severity !== 'all' || query) && <button type="button" className="sp-clear" onClick={reset}><X size={14} /> Сбросить</button>}</div>
      <div className="sp-table-scroll"><table className="sp-table sp-quality-table"><thead><tr><th>Замечание</th><th>Уровень</th><th>Лист</th><th>Источник</th></tr></thead><tbody>{issues.slice(page * 10, page * 10 + 10).map(issue => <Fragment key={issue.id}><tr className={expanded === issue.id ? 'sp-selected-row' : undefined}><td><span className="sp-entity-name">{issueLabels[issue.code]?.title || issue.code}</span>{issue.value && <span className="sp-cell-subtitle">{issue.value}</span>}</td><td><span className={`sp-severity ${issue.severity === 'error' ? 'sp-severity-error' : ''}`}><span />{issue.severity === 'error' ? 'Ошибка' : issue.severity === 'warning' ? 'Предупреждение' : issue.severity}</span></td><td>{issue.sheet}</td><td><button type="button" className="sp-source-link" aria-expanded={expanded === issue.id} onClick={() => setExpanded(expanded === issue.id ? null : issue.id)}>{issue.cell || `Строка ${issue.sourceRow ?? '—'}`}<ChevronDown size={13} className={expanded === issue.id ? 'sp-rotate' : undefined} /></button></td></tr>{expanded === issue.id && <tr className="sp-detail-row"><td colSpan={4}><IssueDetails issue={issue} data={data} /></td></tr>}</Fragment>)}</tbody></table></div>{!issues.length && <div className="sp-empty"><Search size={27} /><h3>Замечаний по этим условиям нет</h3><p>Попробуйте другой запрос или сбросьте фильтры.</p><button className="button" type="button" onClick={reset}>Сбросить фильтры</button></div>}<Pager page={page} total={issues.length} size={10} onChange={setPage} /></section>
    <section className="panel sp-flags-panel"><div className="sp-panel-heading"><div><h2>Полнота операций</h2><p>Одна операция может иметь несколько флагов</p></div></div><div className="sp-flags-grid">{(['shipments', 'payments'] as const).map(dataset => <div key={dataset}><h3>{dataset === 'shipments' ? 'Отгрузки' : 'Платежи'}<span>{dataset === 'shipments' ? data.quality.flaggedShipmentCount : data.quality.flaggedPaymentCount} с замечаниями</span></h3>{Object.entries(data.quality.recordFlagCounts[dataset]).map(([key, count]) => <div className="sp-flag-row" key={key}><span>{flagLabels[key] || key}</span><strong>{count}</strong></div>)}</div>)}</div></section>
    <div className="sp-secondary-grid"><Duplicates data={data} /><Aliases data={data} /></div>
    <section className="panel sp-method-panel"><details><summary><span className="sp-summary-copy"><strong>Происхождение и ограничения снимка</strong><small>Контрольная сумма, правила переноса и доступные данные</small></span><ChevronDown size={18} /></summary><div className="sp-method-content"><div className="sp-hash"><span>SHA-256 исходного XLSX</span><div><code>{data.provenance.sourceSha256}</code><button type="button" className="sp-icon-button" aria-label="Копировать контрольную сумму" onClick={copyHash}>{copied ? <Check size={16} /> : <Copy size={16} />}</button></div>{copied && <small role="status">Контрольная сумма скопирована</small>}{copyFailed && <small role="status">Копирование недоступно. Выделите контрольную сумму вручную.</small>}</div><ul className="sp-limitations"><li>Источник — локальный XLSX. Проверка актуальности по Google Sheets не проводилась.</li><li>Формулы и их сохранённые результаты перенесены без выполнения. Отсутствующее значение не заменяется нулём.</li><li>Наименования компаний сохранены как в источнике. Юридические лица и ИНН не подтверждены по реестру.</li><li>Метки менеджеров из файла не являются учётными записями. Владельцы компаний автоматически не назначаются.</li><li>Идентификаторы операций относятся к этому снимку. Для будущей синхронизации потребуется правило сопоставления.</li></ul>{data.quality.multipleManagerCompanyIds.length > 0 && <div className="sp-manager-note"><strong>Компании с несколькими метками менеджеров</strong><p>{data.quality.multipleManagerCompanyIds.map(id => data.companies.find(company => company.id === id)?.name || id).join(', ')}</p></div>}</div></details></section>
  </div>;
}

function useShipmentReference(id: string | null, row: number | null = null) {
  const [record,setRecord] = useState<Shipment | undefined>()
  const [error,setError] = useState('')
  useEffect(() => {
    setRecord(undefined);setError('')
    if(!id && row === null) return
    const controller = new AbortController()
    const url = id ? `/api/shipments/${encodeURIComponent(id)}` : `/api/shipments?limit=100&query=${row}`
    fetch(url,{signal:controller.signal}).then(async response => {
      if(!response.ok) throw new Error(response.status === 404 ? 'Связанная отгрузка удалена из рабочей базы. Замечание исходного файла сохранено.' : 'Не удалось загрузить связанную строку.')
      return response.json()
    }).then(result => setRecord(id ? result.shipment : result.items.find((item:Shipment) => item.sourceRow === row)))
      .catch(error => {if(error.name !== 'AbortError') setError(error.message)})
    return () => controller.abort()
  },[id,row])
  return {record,error}
}

import { useEffect, useRef, useState, type ReactNode } from 'react'
import { ArrowDownLeft, ArrowDownToLine, ArrowLeft, ArrowUpRight, Building2, Check, ChevronLeft, ChevronRight, Copy, FileText, LoaderCircle, RefreshCw, Search, Unplug, X } from 'lucide-react'
import { bankConnections, type BankCard, type BankListResult, type BankOperation, type BankParty, type BankTotals } from './banking-model'
import './banking.css'

const currentDay = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date())
const date = (value?: string) => value ? new Date(value.length === 10 ? `${value}T12:00:00` : value).toLocaleDateString('ru-RU') : 'Не передана'
const time = (value?: string) => value ? new Date(value).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' }) : 'Ещё не выполнялась'
export function bankMoney(value: string, currency: string) {
  const [whole, fraction = ''] = value.split('.')
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')},${fraction.padEnd(2, '0')} ${currency}`
}
const stateName: Record<BankCard['state'], string> = { not_configured: 'Доступ не настроен', ready: 'Ожидает первой синхронизации', syncing: 'Синхронизация', error: 'Ошибка синхронизации', connected: 'Подключён' }
async function api<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, ...(body !== undefined ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}) })
  const result = await response.json()
  if (!response.ok) throw new Error(result.error ?? 'Не удалось получить банковские данные')
  return result
}
async function download(url: string, filename: string) {
  const response = await fetch(url)
  if (!response.ok) { const result = await response.json(); throw new Error(result.error ?? 'Не удалось скачать файл') }
  const href = URL.createObjectURL(await response.blob()), anchor = document.createElement('a')
  anchor.href = href; anchor.download = filename; anchor.click(); setTimeout(() => URL.revokeObjectURL(href), 1000)
}
function Totals({ values, compact = false }: { values: BankTotals[]; compact?: boolean }) {
  return <div className={compact ? 'bank-card-totals' : 'bank-totals'}>{values.length ? values.map(value => <div className="bank-currency-total" key={value.currency}>
    <div><span><ArrowDownLeft size={15}/>Поступления</span><strong className="bank-incoming">{bankMoney(value.incoming, value.currency)}</strong></div>
    <div><span><ArrowUpRight size={15}/>Списания</span><strong>{bankMoney(value.outgoing, value.currency)}</strong></div>
  </div>) : <p className="bank-muted">Нет подтверждённых операций за выбранный период</p>}</div>
}
export default function BankingPage({ legacy }: { legacy: ReactNode }) {
  const [source, setSource] = useState<'api' | 'legacy'>('api')
  const [connection, setConnection] = useState(''), [account, setAccount] = useState('')
  const [from, setFrom] = useState(() => `${currentDay().slice(0, 7)}-01`), [to, setTo] = useState(currentDay)
  const [query, setQuery] = useState(''), [search, setSearch] = useState(''), [direction, setDirection] = useState(''), [status, setStatus] = useState('')
  const [page, setPage] = useState(1), [pageSize, setPageSize] = useState(25), [revision, setRevision] = useState(0)
  const [data, setData] = useState<BankListResult | null>(null), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [actionError, setActionError] = useState(''), [busy, setBusy] = useState(false), [detail, setDetail] = useState<string | null>(null)
  const [settings, setSettings] = useState(false)
  useEffect(() => { const timer = setTimeout(() => { setSearch(query); setPage(1) }, 250); return () => clearTimeout(timer) }, [query])
  const params = new URLSearchParams({ from, to, q: search, direction, account, status, connection, page: String(page), pageSize: String(pageSize) }).toString()
  useEffect(() => {
    if (source !== 'api') return
    const controller = new AbortController()
    setLoading(true); setError('')
    api<BankListResult>(`/api/banking?${params}`, undefined, controller.signal).then(setData).catch(e => { if (e.name !== 'AbortError') setError(e.message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [params, revision, source])
  const ongoing = data?.connections.filter(card => card.progress && card.progress.attempts < 5 && card.state !== 'not_configured').map(card => card.id).join(',') ?? ''
  useEffect(() => {
    if (!ongoing || busy || source !== 'api') return
    let stopped = false
    const timer = setTimeout(async () => {
      try { for (const id of ongoing.split(',')) { if (stopped) break; await api(`/api/banking/connections/${id}/continue`, {}) } }
      catch (e) { if (!stopped) setActionError((e as Error).message) }
      finally { if (!stopped) setRevision(v => v + 1) }
    }, 1500)
    return () => { stopped = true; clearTimeout(timer) }
  }, [ongoing, busy, revision, source])
  // Poll durable state, including retry backoff, without needing an open page for the scheduler.
  useEffect(() => {
    if (source !== 'api') return
    const timer = setInterval(() => setRevision(v => v + 1), 30000)
    return () => clearInterval(timer)
  }, [source])
  const selectBank = (id: string) => { setConnection(id); setAccount(''); setStatus(''); setPage(1); setSettings(false); setActionError('') }
  const card = data?.connections.find(card => card.id === connection)
  const accounts = [...new Map((card ? card.accounts : data?.connections.flatMap(card => card.accounts) ?? []).map(account => [account.number, account])).values()]
  const synchronize = async () => {
    setBusy(true); setActionError('')
    try {
      const targets = card ? [card] : data?.connections.filter(card => !card.missing.length) ?? []
      for (const item of targets) await api(`/api/banking/connections/${item.id}/sync`, { from: item.progress?.from ?? from, to: item.progress?.to ?? to })
    } catch (e) { setActionError((e as Error).message) }
    finally { setBusy(false); setRevision(v => v + 1) }
  }
  const authorize = async (id: string) => {
    setBusy(true); setActionError('')
    try { const result = await api<{authorizationUrl: string}>(`/api/banking/connections/${id}/authorize`, {}); window.location.assign(result.authorizationUrl) }
    catch (e) { setActionError((e as Error).message); setBusy(false) }
  }
  const reset = () => { setQuery(''); setSearch(''); setDirection(''); setStatus(''); setAccount(''); setPage(1) }
  const filtered = !!(search || direction || status || account)
  return <section className="banking-page">
    <div className="bank-source-tabs" role="tablist" aria-label="Источник платежей"><button role="tab" aria-selected={source === 'api'} onClick={() => setSource('api')}>Банковские подключения</button><button role="tab" aria-selected={source === 'legacy'} onClick={() => setSource('legacy')}>Архив из файла</button></div>
    {source === 'legacy' ? <><p className="bank-notice">Сохранённая XLSX-выписка. Её суммы показаны отдельно: в исходном файле нет достаточных реквизитов для достоверного сопоставления с API. Данные и прежний экспорт сохранены.</p>{legacy}</> : <>
      <div className="bank-section-heading"><div>{connection ? <button className="bank-back" onClick={() => selectBank('')}><ArrowLeft size={16}/>Все подключения</button> : <span className="bank-overline">СЧЕТА КОМПАНИЙ</span>}<h2>{card ? `${card.bankName} · ${card.company}` : 'Банки и операции'}</h2><p>Выписки по счетам · только просмотр</p></div><div className="bank-heading-actions"><button className="button" onClick={() => setSettings(v => !v)}><Unplug size={16}/>Подключение</button><button className="button primary" onClick={() => void synchronize()} disabled={busy || loading || !!error || !(card ? !card.missing.length : data?.connections.some(card => !card.missing.length))}><RefreshCw size={16} className={busy ? 'spin' : ''}/>{busy ? 'Обновляем…' : card?.progress ? 'Продолжить загрузку' : 'Синхронизировать'}</button></div></div>
      <div className="bank-period"><label>Период с<input aria-label="Период с" type="date" value={from} max={to || currentDay()} onChange={e => { setFrom(e.target.value); setPage(1) }}/></label><span>—</span><label>по<input aria-label="Период по" type="date" value={to} min={from} max={currentDay()} onChange={e => { setTo(e.target.value); setPage(1) }}/></label><small>Итоги и экспорт учитывают все фильтры</small></div>
      {settings && <div className="bank-settings panel"><h3>Настройка доступа к выпискам</h3><p>Доступ настраивается на сервере для каждого юридического лица. После настройки выберите период и запустите первую синхронизацию.</p>{(card ? [card] : data?.connections ?? []).map(item => <div key={item.id}><strong>{item.bankName} · {item.company}</strong><p>{item.missing.length ? `Требуются: ${item.missing.join(', ')}.` : 'Настройки доступа сохранены на сервере. Подключение подтверждается успешной загрузкой выписки.'}</p>{item.provider === 'sber' && <button className="button" disabled={busy} onClick={() => void authorize(item.id)}>Разрешить чтение выписок в СберБизнесе</button>}{item.limitations.map(text => <p className="bank-muted" key={text}>{text}</p>)}</div>)}<p>Автоматическая сверка: {data?.scheduleEnabled ? 'включена на сервере' : 'ожидает включения на сервере'}. Для первого получения истории нужен ручной запуск.</p></div>}
      {loading && !data ? <div className="bank-empty" role="status"><LoaderCircle className="spin"/><h3>Загружаем подключения…</h3></div> : <>
        {!connection && <div className="bank-cards">{data?.connections.map(item => <button className={`bank-card bank-${item.provider}`} key={item.id} onClick={() => selectBank(item.id)} aria-label={`Открыть ${item.bankName} — ${item.company}`}><div className="bank-card-top"><span className="bank-emblem"><Building2 size={22}/></span><span className={`bank-state ${item.state}`}>{stateName[item.state]}</span></div><h3>{item.bankName}<ChevronRight size={18}/></h3><p className="bank-company">{item.company}</p><div className="bank-accounts">{item.accounts.length ? item.accounts.map(account => <span key={account.number}>{account.number}<small>{account.currency}</small></span>) : <span>Счета ещё не подключены</span>}</div><Totals values={item.totals} compact/><div className="bank-last-sync">Успешная синхронизация<strong>{time(item.lastSuccessAt)}</strong></div></button>)}</div>}
        {card && <div className="bank-connection-line"><span className={`bank-state ${card.state}`}>{stateName[card.state]}</span><span>Последняя успешная: <strong>{time(card.lastSuccessAt)}</strong></span>{card.lastCompletedPeriod && <span>Загружен период: {date(card.lastCompletedPeriod.from)} — {date(card.lastCompletedPeriod.to)}</span>}</div>}
        {(card ? [card] : data?.connections ?? []).filter(card => card.lastError || card.progress).map(item => <div key={item.id} className={`bank-notice ${item.lastError ? 'bank-error' : ''}`} role={item.lastError ? 'alert' : 'status'}><strong>{item.bankName} · {item.company}</strong>{item.lastError && <p>{item.lastError}</p>}{item.progress && <p>История {date(item.progress.from)} — {date(item.progress.to)} · загружается {date(item.progress.day)} · страниц: {item.progress.pages}{item.progress.nextAttemptAt ? ` · повтор не ранее ${time(item.progress.nextAttemptAt)}` : ''}</p>}</div>)}
        {(error || actionError) && <div className="bank-notice bank-error" role="alert">{error || actionError}{error && <button className="button" onClick={() => setRevision(v => v + 1)}>Повторить загрузку</button>}</div>}
        <div className="panel bank-ledger"><div className="bank-ledger-title"><div><h3>{card ? 'Операции по счетам' : 'Операции всех банков'}</h3><p>{data?.total ?? 0} операций по текущим фильтрам</p></div><button className="button" disabled={loading || !!error || !data?.total} onClick={() => { setActionError(''); void download(`/api/banking/export?${params}`, 'Артель-банковские-операции.csv').catch(e => setActionError(e.message)) }}><ArrowDownToLine size={16}/>Экспорт CSV</button></div>
          <div className="bank-filters"><label className="bank-search"><Search size={17}/><input aria-label="Поиск банковских операций" value={query} onChange={e => setQuery(e.target.value)} placeholder="Контрагент, ИНН, назначение или № документа"/>{query && <button aria-label="Очистить поиск" onClick={() => setQuery('')}><X size={14}/></button>}</label><label><span>Направление</span><select aria-label="Направление операции" value={direction} onChange={e => { setDirection(e.target.value); setPage(1) }}><option value="">Все направления</option><option value="incoming">Поступления</option><option value="outgoing">Списания</option></select></label><label><span>Наш счёт</span><select aria-label="Наш счёт" value={account} onChange={e => { setAccount(e.target.value); setPage(1) }}><option value="">Все счета</option>{accounts.map(item => <option value={item.number} key={item.number}>{item.number} · {item.currency}</option>)}</select></label><label><span>Статус банка</span><select aria-label="Статус банка" value={status} onChange={e => { setStatus(e.target.value); setPage(1) }}><option value="">Все статусы</option>{data?.statuses.map(item => <option key={item} value={item}>{item === '__missing__' ? 'Не передан банком' : item}</option>)}</select></label>{filtered && <button className="button" onClick={reset}>Сбросить</button>}</div>
          <div aria-busy={loading} className={loading ? 'bank-results is-loading' : 'bank-results'}>{loading && data && <div className="bank-loading-line" role="status"><LoaderCircle size={14} className="spin"/>Обновляем список…</div>}<Totals values={data?.totals ?? []}/>
          {data?.items.length ? <div className="bank-table-scroll" tabIndex={0} role="region" aria-label="Таблица банковских операций"><table className="bank-table"><thead><tr><th>Дата / документ</th><th>Контрагент</th><th>Назначение платежа</th><th>Направление</th><th className="align-right">Сумма</th><th>Статус банка</th><th>Наш счёт</th><th/></tr></thead><tbody>{data.items.map(row => { const party = row.direction === 'incoming' ? row.payer : row.payee, bank = data.connections.find(c => c.id === row.connectionId); return <tr key={row.id} onClick={() => setDetail(row.id)}><td><button className="bank-row-link" aria-label={`Открыть платёж ${row.documentNumber ?? row.bankOperationId}`} onClick={() => setDetail(row.id)}>{date(row.statementDate)}<small>№ {row.documentNumber ?? 'не передан'}</small></button></td><td><strong>{party.name ?? 'Не передан банком'}</strong>{party.inn && <small>ИНН {party.inn}</small>}</td><td className="bank-purpose" title={row.purpose}>{row.purpose ?? 'Не передано банком'}</td><td><span className={row.direction === 'incoming' ? 'bank-direction incoming' : 'bank-direction'}>{row.direction === 'incoming' ? <ArrowDownLeft size={14}/> : <ArrowUpRight size={14}/>}{row.direction === 'incoming' ? 'Поступление' : 'Списание'}</span></td><td className={`align-right bank-amount ${row.direction === 'incoming' ? 'bank-incoming' : ''}`}>{bankMoney(row.amount, row.currency)}</td><td>{row.status ?? 'Не передан'}{!row.booked && <small>В оборотах не учтена</small>}</td><td><span className="bank-account-number">{row.account}</span><small>{bank?.bankName} · {bank?.company}</small></td><td><ChevronRight size={16}/></td></tr> })}</tbody></table></div> : !loading && !error && <div className="bank-empty">{(card ? card.missing.length : data?.connections.every(c => c.missing.length)) && !data?.storedCount ? <><Unplug size={30}/><h3>Банковские счета ещё не подключены</h3><p>Настройте доступ к выпискам, затем загрузите историю за выбранный период.</p><button className="button" onClick={() => setSettings(true)}>Что нужно для подключения</button></> : filtered ? <><Search size={30}/><h3>По вашему запросу ничего не найдено</h3><p>Измените запрос или сбросьте фильтры.</p><button className="button" onClick={reset}>Сбросить фильтры</button></> : <><FileText size={30}/><h3>В выбранном периоде нет загруженных операций</h3><p>{card?.lastSuccessAt ? 'Выписка пуста или выбранный период ещё не загружен. Проверьте период последней синхронизации.' : 'Запустите первую синхронизацию для получения истории.'}</p></>}</div>}</div>
          <div className="bank-pagination"><label>На странице<select aria-label="Операций на странице" value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(1) }}>{[10,25,50,100].map(size => <option key={size} value={size}>{size}</option>)}</select></label><span>{data?.total ? `${((data.page - 1) * pageSize) + 1}–${Math.min(data.page * pageSize, data.total)} из ${data.total}` : '0 операций'}</span><div><button className="icon-button" aria-label="Предыдущая страница операций" disabled={loading || !data || data.page <= 1} onClick={() => setPage((data?.page ?? 1) - 1)}><ChevronLeft size={17}/></button><span>{data?.page ?? 1} / {Math.max(1, Math.ceil((data?.total ?? 0) / pageSize))}</span><button className="icon-button" aria-label="Следующая страница операций" disabled={loading || !data || data.page * pageSize >= data.total} onClick={() => setPage((data?.page ?? 1) + 1)}><ChevronRight size={17}/></button></div></div>
        </div><p className="bank-footnote">Итоги отражают подтверждённые движения в валюте счёта, отдельно по каждой валюте. Связь с отгрузками и распределение платежей не выполняются.</p>
      </>}
    </>}
    {detail && <PaymentPanel id={detail} onClose={() => setDetail(null)}/>}
  </section>
}
const partyFields: [keyof BankParty, string][] = [['name','Наименование'],['inn','ИНН'],['kpp','КПП'],['account','Расчётный счёт'],['bankName','Банк'],['bic','БИК / SWIFT'],['correspondentAccount','Корреспондентский счёт']]
function PaymentPanel({ id, onClose }: { id: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null), [row, setRow] = useState<BankOperation | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [copied, setCopied] = useState('')
  useEffect(() => { const element = dialog.current; element?.showModal(); const overflow = document.body.style.overflow; document.body.style.overflow = 'hidden'; return () => { element?.close(); document.body.style.overflow = overflow } }, [])
  useEffect(() => {
    const controller = new AbortController()
    api<{ operation: BankOperation }>(`/api/banking/operations/${id}`, undefined, controller.signal).then(({operation}) => {
      setRow(operation)
      if (operation.provider === 'sber') {
        setBusy(true)
        api<{ operation: BankOperation }>(`/api/banking/operations/${id}/refresh`, {}, controller.signal).then(result => setRow(result.operation)).catch(e => { if (e.name !== 'AbortError') setError(e.message) }).finally(() => { if (!controller.signal.aborted) setBusy(false) })
      }
    }).catch(e => { if (e.name !== 'AbortError') setError(e.message) })
    return () => controller.abort()
  }, [id])
  const copy = async (value: string, label: string) => { try { await navigator.clipboard.writeText(value); setCopied(label) } catch { setError('Не удалось скопировать. Выделите реквизиты и скопируйте вручную.') } }
  const field = (label: string, value?: string) => <div className="bank-detail-field" key={label}><dt>{label}</dt><dd><span>{value || 'Не передано банком'}</span>{value && <button className="icon-button" aria-label={`Копировать ${label}`} onClick={() => void copy(value, label)}>{copied === label ? <Check size={14}/> : <Copy size={14}/>}</button>}</dd></div>
  const bank = bankConnections.find(c => c.id === row?.connectionId)
  const rawFields = (value: unknown, prefix = ''): [string, string][] => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => rawFields(item, prefix ? `${prefix}.${key}` : key)) : [[prefix, value == null ? 'Не передано банком' : String(value)]]
  return <dialog ref={dialog} className="bank-payment-panel" aria-labelledby="bank-payment-title" onCancel={onClose} onClick={e => { if (e.target === dialog.current) { const bounds = dialog.current.getBoundingClientRect(); if (e.clientX < bounds.left || e.clientX > bounds.right || e.clientY < bounds.top || e.clientY > bounds.bottom) onClose() } }}><div className="bank-panel-header"><div><span className="bank-overline">БАНКОВСКАЯ ОПЕРАЦИЯ</span><h2 id="bank-payment-title">Платёж {row?.documentNumber ? `№ ${row.documentNumber}` : ''}</h2><p>{bank?.bankName} · {bank?.company}</p></div><button autoFocus className="icon-button" aria-label="Закрыть карточку платежа" onClick={onClose}><X size={21}/></button></div>
    {error && <p className="bank-notice bank-error" role="alert">{error}</p>}{!row ? <div className="bank-empty" role="status">{error ? 'Реквизиты недоступны' : <><LoaderCircle className="spin"/>Загружаем реквизиты…</>}</div> : <div className="bank-panel-body">
      <div className={`bank-payment-sum ${row.direction === 'incoming' ? 'bank-incoming' : ''}`}><span>{row.direction === 'incoming' ? 'Поступление на наш счёт' : 'Списание с нашего счёта'}</span><strong>{bankMoney(row.amount, row.currency)}</strong></div>
      <dl className="bank-details-grid">{field('Наш счёт', row.account)}{field('Идентификатор операции банка', row.bankOperationId)}{field('Номер документа', row.documentNumber)}{field('Дата документа', row.documentDate ? date(row.documentDate) : undefined)}{field('Дата выписки', date(row.statementDate))}{field('Проведение / исполнение', row.bookedAt)}{field('Статус банка', row.status)}{field('Направление', row.direction === 'incoming' ? 'Поступление' : 'Списание')}</dl>
      <section className="bank-payment-purpose"><h3>Назначение платежа</h3><p>{row.purpose ?? 'Не передано банком'}</p>{row.purpose && <button className="button" onClick={() => void copy(row.purpose!, 'Назначение')}><Copy size={14}/>Копировать назначение</button>}</section>
      <div className="bank-parties">{([['payer','Плательщик'],['payee','Получатель']] as const).map(([key, title]) => <section key={key}><div className="bank-party-title"><h3>{title}</h3><button className="icon-button" aria-label={`Копировать реквизиты: ${title}`} onClick={() => void copy(partyFields.filter(([field]) => row[key][field]).map(([field, label]) => `${label}: ${row[key][field]}`).join('\n'), title)}><Copy size={15}/></button></div><dl>{partyFields.map(([keyName, label]) => field(`${title} · ${label}`, row[key][keyName]))}</dl></section>)}</div>
      {(row.vat || row.commission) && <dl className="bank-details-grid">{row.vat && field('НДС от банка', row.vat)}{row.commission && field('Комиссия от банка', row.commission)}</dl>}
      <details className="bank-raw-details"><summary>Все доступные поля банковского ответа</summary><p>Исходные сведения из API. Данные из назначения не интерпретируются как подтверждённые реквизиты.</p><dl>{rawFields(row.bankData).map(([key, value]) => field(key, value))}</dl></details>
      <div className="bank-panel-actions"><button className="button primary" disabled={busy} onClick={() => { setBusy(true); setError(''); void download(`/api/banking/operations/${id}/print`, `Платёж-${row.documentNumber ?? id.slice(0, 8)}.pdf`).catch(e => setError(e.message)).finally(() => setBusy(false)) }}><FileText size={16}/>{busy ? 'Получаем данные банка…' : 'Печатная форма банка'}</button>{row.provider === 'sber' && <button className="button" disabled={busy} onClick={() => { setBusy(true); setError(''); void api<{operation: BankOperation}>(`/api/banking/operations/${id}/refresh`, {}).then(result => setRow(result.operation)).catch(e => setError(e.message)).finally(() => setBusy(false)) }}><RefreshCw size={15}/>Обновить реквизиты</button>}</div><p className="bank-footnote">Сохранено {time(row.updatedAt)}. Печатная форма предоставляется банком при наличии доступа и поддержке документа.</p>{copied && <p role="status" className="bank-copy-status">Скопировано: {copied}</p>}
    </div>}
  </dialog>
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDownLeft, ArrowUpRight, ChevronRight, FileText, LoaderCircle, RefreshCw, Search, Unplug, X } from 'lucide-react'
import type { BankParty } from './banking-model'
import type { SberOperation, SberStatementsResult } from './sber-model'
import BankConnectionHeader from './BankConnectionHeader'
import './sber-statements.css'

const currentDay = () => new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Moscow' }).format(new Date())
const displayDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) ? value.split('-').reverse().join('.') : value
const displayTimestamp = (value?: string) => {
  if (!value) return 'Ещё не выполнялась'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? value : parsed.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })
}
// Keep bank decimals as text; Number would lose precision for large balances.
export function sberMoney(value: string | null | undefined, currency = 'RUB') {
  if (value == null || value === '') return 'Не передано'
  const [whole, fraction = ''] = value.split('.')
  const unit = currency === 'RUB' || currency === 'RUR' || currency === '643' ? '₽' : currency
  return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')},${fraction.padEnd(2, '0')} ${unit}`
}
const isZero = (value: string | null) => value !== null && /^[+-]?0+(?:\.0+)?$/.test(value)
const counterpart = (row: SberOperation) => row.direction === 'incoming' ? row.payer : row.payee
const operationClock = (row: SberOperation) => {
  if (!row.bookedAt || !/[T ]\d{2}:\d{2}/.test(row.bookedAt)) return undefined
  // Preserve an unzoned bank time; only convert explicitly zoned timestamps.
  if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(row.bookedAt)) return row.bookedAt.match(/[T ](\d{2}:\d{2}(?::\d{2})?)/)?.[1]
  const parsed = new Date(row.bookedAt)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed.toLocaleTimeString('ru-RU', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit' })
}
async function api<T>(url: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) })
  let result: T & { error?: string }
  try { result = await response.json() } catch { throw new Error('Сервер не вернул банковские данные. Повторите загрузку.') }
  if (!response.ok) throw new Error(result.error || 'Не удалось получить банковские данные')
  return result
}

export default function SberStatements({ onBack, connectionId = 'sber-nk-artel' }: { onBack: () => void; connectionId?: string }) {
  const endpoint = `/api/banking/sber/${connectionId}`
  const [period, setPeriod] = useState(() => ({ from: '2026-09-01', to: currentDay() }))
  const [draft, setDraft] = useState(period)
  const [data, setData] = useState<SberStatementsResult | null>(null)
  const [dataPeriod, setDataPeriod] = useState(period)
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false)
  const [error, setError] = useState(''), [actionError, setActionError] = useState('')
  const [hideZero, setHideZero] = useState(false), [selectedDay, setSelectedDay] = useState<string | null>(null)
  const [search, setSearch] = useState(''), [direction, setDirection] = useState('')
  const [detail, setDetail] = useState<SberOperation | null>(null)
  const mounted = useRef(true), working = useRef(false), requestVersion = useRef(0)
  const today = currentDay()
  const invalidPeriod = !draft.from || !draft.to ? 'Выберите начало и конец периода.' : draft.from > draft.to ? 'Начало периода должно быть не позднее его окончания.' : draft.to > today ? 'Выписки доступны по текущую дату. Будущие даты выбрать нельзя.' : Date.parse(draft.to) - Date.parse(draft.from) > 30 * 86400000 ? 'Выберите период не более 31 дня.' : ''
  const draftChanged = draft.from !== period.from || draft.to !== period.to
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; requestVersion.current++ } }, [])

  const load = useCallback(async (signal?: AbortSignal) => {
    const version = ++requestVersion.current
    setLoading(true)
    try {
      const result = await api<SberStatementsResult>(`${endpoint}/statements?${new URLSearchParams(period)}`, undefined, signal)
      if (mounted.current && version === requestVersion.current) {
        setData(result); setDataPeriod(period); setError('')
      }
      return result
    } catch (caught) {
      if (mounted.current && version === requestVersion.current && (caught as Error).name !== 'AbortError') setError((caught as Error).message)
      throw caught
    } finally { if (mounted.current && version === requestVersion.current) setLoading(false) }
  }, [period, endpoint])
  // Opening the screen only reads saved data. A bank request starts with the user's refresh action.
  useEffect(() => {
    const controller = new AbortController()
    void load(controller.signal).catch(() => {})
    return () => controller.abort()
  }, [load])
  // Refresh saved state while the server performs the scheduled bank requests.
  useEffect(() => {
    if (!data?.scheduleEnabled) return
    const timer = setInterval(() => { if (!working.current) void load().catch(() => {}) }, 30000)
    return () => clearInterval(timer)
  }, [load, data?.scheduleEnabled])

  const synchronize = async () => {
    if (working.current || invalidPeriod || draftChanged || data?.missing.length) return
    working.current = true; setBusy(true); setActionError('')
    try {
      // Re-arm a failed durable job as well as starting a new one.
      await api(`${endpoint}/sync`, data?.progress ? { from: data.progress.from, to: data.progress.to } : period)
      let snapshot = await load()
      while (mounted.current && snapshot.progress) {
        const delay = snapshot.progress.nextAttemptAt ? Math.max(0, new Date(snapshot.progress.nextAttemptAt).getTime() - Date.now()) : 0
        if (delay > 0) {
          // Stay responsive during a server retry delay and stop when this screen closes.
          let remaining = delay
          while (mounted.current && remaining > 0) { await new Promise(resolve => setTimeout(resolve, Math.min(remaining, 1000))); remaining -= 1000 }
        }
        if (!mounted.current) break
        await api(`${endpoint}/continue`, {})
        snapshot = await load()
        if (snapshot.lastError) throw new Error(snapshot.lastError)
        if (snapshot.progress) await new Promise(resolve => setTimeout(resolve, 350))
      }
    } catch (caught) {
      if (mounted.current) {
        setActionError((caught as Error).message)
        await load().catch(() => {})
      }
    } finally {
      working.current = false
      if (mounted.current) setBusy(false)
    }
  }

  const days = useMemo(() => (data?.days ?? []).filter(day => !hideZero || !isZero(day.incoming) || !isZero(day.outgoing)).sort((a, b) => b.date.localeCompare(a.date)), [data?.days, hideZero])
  const normalizedSearch = search.trim().toLocaleLowerCase('ru-RU')
  const operations = useMemo(() => (data?.operations ?? []).filter(row => {
    if (selectedDay && row.statementDate !== selectedDay) return false
    if (direction && row.direction !== direction) return false
    if (!normalizedSearch) return true
    const party = counterpart(row)
    return [party.name, party.inn, party.account, row.purpose, row.documentNumber].some(value => value?.toLocaleLowerCase('ru-RU').includes(normalizedSearch))
  }).sort((a, b) => b.statementDate.localeCompare(a.statementDate) || (b.bookedAt ?? '').localeCompare(a.bookedAt ?? '') || a.bankOperationId.localeCompare(b.bankOperationId)), [data?.operations, selectedDay, direction, normalizedSearch])
  const allDayOperations = data?.operations.filter(row => !selectedDay || row.statementDate === selectedDay).length ?? 0
  const syncError = actionError || data?.lastError
  const selectedSummary = data?.days.find(day => day.date === selectedDay)
  const stalePeriod = dataPeriod.from !== period.from || dataPeriod.to !== period.to
  const updateOperation = useCallback((operation: SberOperation) => {
    setData(previous => previous ? { ...previous, operations: previous.operations.map(row => row.id === operation.id ? operation : row) } : previous)
  }, [])
  const chooseDay = (day: string) => {
    setSelectedDay(day)
    document.getElementById('sber-operations-heading')?.focus({ preventScroll: true })
    document.getElementById('sber-operations')?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }

  return <div className="sber-statements">
    <BankConnectionHeader bankName="СберБизнес" company={data?.company ?? (connectionId === 'sber-artel' ? 'ООО «АРТЭЛЬ»' : 'ООО «НК АРТЭЛЬ»')} provider="sber" onBack={onBack}
      actions={<button className="button primary" disabled={busy || loading || !data || !!data.missing.length || !!invalidPeriod || draftChanged} onClick={() => void synchronize()}><RefreshCw size={16} className={busy ? 'spin' : ''}/>{busy ? 'Обновляем выписку…' : data?.progress ? 'Продолжить загрузку' : 'Обновить из банка'}</button>}
      fields={[{ label: 'Расчётный счёт', value: data?.account ?? 'Загружаем…' }, { label: 'ИНН', value: data?.inn ?? 'Загружаем…' }, { label: 'Валюта счёта', value: 'Рубли' }]}>
    <form className="bank-period sber-period" onSubmit={event => { event.preventDefault(); if (!invalidPeriod && !busy) { setSelectedDay(null); setPeriod({ ...draft }) } }}>
      <label>Период с<input aria-label="Начало периода выписки Сбера" type="date" value={draft.from} max={draft.to && draft.to < today ? draft.to : today} disabled={busy} onChange={event => setDraft(previous => ({ ...previous, from: event.target.value }))}/></label>
      <span aria-hidden="true">—</span>
      <label>Период по<input aria-label="Конец периода выписки Сбера" type="date" value={draft.to} min={draft.from} max={today} disabled={busy} onChange={event => setDraft(previous => ({ ...previous, to: event.target.value }))}/></label>
      <button className="button" type="submit" disabled={busy || !!invalidPeriod || loading}>Показать период</button>

      {invalidPeriod && <p className="sber-period-error" role="alert">{invalidPeriod}</p>}
      {draftChanged && !invalidPeriod && <p className="bank-muted">Нажмите «Показать период», чтобы применить выбранные даты.</p>}
    </form>
    <div className="bank-connection-line">{(!data?.lastSuccessAt || busy || syncError || !!data?.missing.length) && <span className={`bank-state ${busy ? 'syncing' : syncError ? 'error' : data?.missing.length ? 'not_configured' : data?.lastSuccessAt ? 'connected' : 'ready'}`}>{busy ? 'Синхронизация' : syncError ? 'Обновление не завершено' : data?.missing.length ? 'Доступ не настроен' : 'Ожидает первой загрузки'}</span>}<span>Обновлено: <strong>{displayTimestamp(data?.lastSuccessAt)}</strong></span>{data?.lastCompletedPeriod && <span>Загружен период: {displayDate(data.lastCompletedPeriod.from)} — {displayDate(data.lastCompletedPeriod.to)}</span>}</div>
    {data?.scheduleEnabled && <p className="bank-auto-sync"><RefreshCw size={14}/>Автообновление каждые 5 минут</p>}
    </BankConnectionHeader>
    {data?.missing.length ? <div className="bank-notice" role="status"><strong>Для подключения не хватает серверных настроек</strong><p>{data.missing.join(', ')}.</p><p>После настройки доступа нажмите «Обновить из банка».</p></div> : null}
    {data?.progress && <div className="bank-notice sber-sync-progress" role="status"><strong>{busy ? 'Получаем банковские данные' : 'Есть незавершённая загрузка'}</strong><p>{displayDate(data.progress.from)} — {displayDate(data.progress.to)} · сохранено дней: {data.progress.completedDays} из {data.progress.totalDays}</p><progress value={data.progress.completedDays} max={Math.max(1, data.progress.totalDays)} aria-label="Дней выписки загружено"/><p>Текущая дата: {displayDate(data.progress.day)}{data.progress.pages !== undefined ? ` · страниц: ${data.progress.pages}` : ''}{data.progress.nextAttemptAt ? ` · повтор не ранее ${displayTimestamp(data.progress.nextAttemptAt)}` : ''}</p>{!busy && <p>Нажмите «Продолжить загрузку», чтобы закончить этот период.</p>}</div>}
    {syncError && <div className="bank-notice bank-error" role="alert"><strong>Не удалось завершить обновление</strong><p>{syncError}</p><p>Ранее загруженные выписки и операции сохранены.</p></div>}
    {error && <div className="bank-notice bank-error" role="alert"><strong>Не удалось загрузить сохранённые данные</strong><p>{error}</p>{data && <p>Показаны ранее загруженные данные за {displayDate(dataPeriod.from)} — {displayDate(dataPeriod.to)}.</p>}<button className="button" disabled={loading || busy} onClick={() => void load().catch(() => {})}>Повторить загрузку</button></div>}
    {loading && !data ? <div className="bank-empty" role="status"><LoaderCircle className="spin"/><h3>Загружаем сохранённую выписку…</h3></div> : data && <>
      <div className="panel bank-ledger sber-summary" aria-busy={loading}>
        <div className="bank-ledger-title"><div><h3>Выписки по дням</h3><p>{displayDate(dataPeriod.from)} — {displayDate(dataPeriod.to)}</p></div><label className="sber-zero-toggle"><input type="checkbox" checked={hideZero} onChange={event => setHideZero(event.target.checked)}/>Скрыть дни без оборотов</label></div>
        {loading && <div className="bank-loading-line" role="status"><LoaderCircle size={14} className="spin"/>Обновляем сохранённые данные…</div>}
        {days.length ? <div className="bank-table-scroll" tabIndex={0} role="region" aria-label="Дневные выписки Сбера"><table className="bank-table sber-days-table"><thead><tr><th scope="col">Дата</th><th scope="col" className="align-right">Остаток на начало дня</th><th scope="col" className="align-right">Поступления</th><th scope="col" className="align-right">Списания</th><th scope="col" className="align-right">Остаток на конец дня</th><th scope="col"><span className="sr-only">Операции</span></th></tr></thead><tbody>{days.map(day => <tr key={day.date} className={selectedDay === day.date ? 'is-selected' : ''} onClick={() => chooseDay(day.date)}><td><button className="bank-row-link" aria-label={`Операции за ${displayDate(day.date)}`} aria-pressed={selectedDay === day.date} onClick={event => { event.stopPropagation(); chooseDay(day.date) }}>{displayDate(day.date)}</button>{day.status === 'partial' && <small>Неполные итоги</small>}{day.error && <small>{day.error}</small>}</td>{([['openingBalance', ''], ['incoming', 'bank-incoming'], ['outgoing', ''], ['closingBalance', '']] as const).map(([key, className]) => <td key={key} className={`align-right bank-amount ${day[key] == null ? 'sber-value-missing' : className}`}>{sberMoney(day[key], day.currency)}</td>)}<td><ChevronRight size={15} aria-hidden="true"/></td></tr>)}</tbody></table></div> : <div className="bank-empty">{data.days.length ? <><FileText size={28}/><h3>Все загруженные дни без оборотов</h3><p>Отключите «Скрыть дни без оборотов», чтобы увидеть остатки.</p></> : <>{data.missing.length ? <Unplug size={28}/> : <FileText size={28}/>}<h3>За выбранный период выписка ещё не загружена</h3><p>{data.missing.length ? 'Ожидаем настройки доступа к Сберу.' : 'Нажмите «Обновить из банка», чтобы получить выписку по дням и операции.'}</p></>}</div>}

      </div>
      <div className="panel bank-ledger" id="sber-operations" aria-busy={loading}>
        <div className="bank-ledger-title"><div className="sber-operations-title"><h3 id="sber-operations-heading" tabIndex={-1}>{selectedDay ? `Операции за ${displayDate(selectedDay)}` : 'Операции за весь период'}</h3><p>{operations.length} из {allDayOperations} операций{stalePeriod ? ' · сохранённые данные предыдущего периода' : ''}</p>{selectedDay && <button className="sber-day-reset" onClick={() => setSelectedDay(null)}>Показать весь период</button>}</div></div>
        <div className="bank-filters"><label className="bank-search"><Search size={17} aria-hidden="true"/><input aria-label="Поиск по контрагенту, ИНН, счёту или назначению" value={search} onChange={event => setSearch(event.target.value)} placeholder="Контрагент, ИНН, счёт или назначение"/>{search && <button aria-label="Очистить поиск операций" onClick={() => setSearch('')}><X size={14}/></button>}</label><label><span>Направление</span><select aria-label="Направление операции Сбера" value={direction} onChange={event => setDirection(event.target.value)}><option value="">Все направления</option><option value="incoming">Поступления</option><option value="outgoing">Списания</option></select></label>{(search || direction) && <button className="button" onClick={() => { setSearch(''); setDirection('') }}>Сбросить фильтры</button>}</div>
        {operations.length ? <div className="bank-table-scroll" tabIndex={0} role="region" aria-label="Операции по счёту Сбера"><table className="bank-table sber-operations-table"><thead><tr><th scope="col">Дата и время</th><th scope="col">Контрагент / счёт</th><th scope="col">Назначение платежа</th><th scope="col" className="align-right">Сумма</th><th scope="col"><span className="sr-only">Подробности</span></th></tr></thead><tbody>{operations.map(row => { const party = counterpart(row), clock = operationClock(row); return <tr key={row.id} onClick={() => setDetail(row)}><td><button className="bank-row-link" aria-label={`Открыть операцию ${row.documentNumber ? `№ ${row.documentNumber}` : row.bankOperationId}`} onClick={() => setDetail(row)}>{displayDate(row.statementDate)}{clock && <small>{clock}</small>}{row.documentNumber && <small>№ {row.documentNumber}</small>}</button></td><td className="sber-counterparty"><strong>{party.name ?? 'Контрагент не передан'}</strong>{party.inn && <small>ИНН {party.inn}</small>}<span className="bank-account-number">{party.account ?? 'Счёт не передан'}</span></td><td className="bank-purpose"><span className="sber-purpose-excerpt">{row.purpose ?? 'Назначение не передано'}</span></td><td className={`align-right bank-amount ${row.direction === 'incoming' ? 'bank-incoming' : ''}`}>{sberMoney(row.amount, row.currency)}<small><span className={`bank-direction ${row.direction === 'incoming' ? 'incoming' : ''}`}>{row.direction === 'incoming' ? <ArrowDownLeft size={14}/> : <ArrowUpRight size={14}/>}{row.direction === 'incoming' ? 'Поступление' : 'Списание'}</span></small></td><td><ChevronRight size={15} aria-hidden="true"/></td></tr>})}</tbody></table></div> : <div className="bank-empty"><Search size={28}/><h3>{normalizedSearch || direction ? 'Операции по этим фильтрам не найдены' : selectedSummary ? 'В этот день нет загруженных операций' : 'Нет загруженных операций'}</h3><p>{normalizedSearch || direction ? 'Измените запрос или сбросьте фильтры. Поиск учитывает выбранный день.' : selectedSummary ? 'Выписка может быть без операций. Проверьте итоги дня и состояние синхронизации выше.' : 'Загрузите выписку за нужный период, чтобы просматривать операции.'}</p></div>}

      </div>
    </>}
    {detail && <OperationDetails endpoint={endpoint} initial={detail} available={!data?.missing.length} onUpdate={updateOperation} onClose={() => setDetail(null)}/>}
  </div>
}

const partyFields: [keyof BankParty, string][] = [['name', 'Наименование'], ['inn', 'ИНН'], ['kpp', 'КПП'], ['account', 'Расчётный счёт'], ['bankName', 'Банк'], ['bic', 'БИК / SWIFT'], ['correspondentAccount', 'Корреспондентский счёт']]
const rawFields = (value: unknown, prefix = ''): [string, string][] => value && typeof value === 'object' ? Object.entries(value).flatMap(([key, item]) => rawFields(item, prefix ? `${prefix}.${key}` : key)) : [[prefix, value == null ? 'Не передано банком' : String(value)]]
function OperationDetails({ endpoint, initial, available, onUpdate, onClose }: { endpoint: string; initial: SberOperation; available: boolean; onUpdate: (operation: SberOperation) => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [row, setRow] = useState(initial), [loading, setLoading] = useState(false), [refreshing, setRefreshing] = useState(false), [error, setError] = useState('')
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    const element = dialog.current, focused = document.activeElement as HTMLElement | null, overflow = document.body.style.overflow
    element?.showModal(); document.body.style.overflow = 'hidden'
    return () => { mounted.current = false; element?.close(); document.body.style.overflow = overflow; focused?.focus() }
  }, [])
  useEffect(() => {
    const controller = new AbortController()
    setLoading(true)
    void api<{ operation: SberOperation }>(`${endpoint}/operations/${encodeURIComponent(initial.id)}`, undefined, controller.signal).then(result => { setRow(result.operation); onUpdate(result.operation) }).catch(caught => { if (!controller.signal.aborted) setError((caught as Error).message) }).finally(() => { if (!controller.signal.aborted) setLoading(false) })
    return () => controller.abort()
  }, [initial.id, onUpdate, endpoint])
  const refresh = async () => {
    if (refreshing) return
    setRefreshing(true); setError('')
    try { const result = await api<{ operation: SberOperation }>(`${endpoint}/operations/${encodeURIComponent(row.id)}/refresh`, {}); if (mounted.current) { setRow(result.operation); onUpdate(result.operation) } }
    catch (caught) { if (mounted.current) setError((caught as Error).message) }
    finally { if (mounted.current) setRefreshing(false) }
  }
  const field = (label: string, value?: string) => <div className="bank-detail-field" key={label}><dt>{label}</dt><dd><span className="sber-raw-value">{value ?? 'Не передано банком'}</span></dd></div>
  return <dialog ref={dialog} className="bank-payment-panel sber-payment-panel" aria-labelledby="sber-payment-title" onCancel={onClose} onClick={event => { if (event.target === dialog.current) { const bounds = dialog.current.getBoundingClientRect(); if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose() } }}>
    <div className="bank-panel-header"><div><h2 id="sber-payment-title">{row.documentNumber ? `Документ № ${row.documentNumber}` : 'Подробности операции'}</h2><p>ООО «НК АРТЭЛЬ» · {displayDate(row.statementDate)}</p></div><button autoFocus className="icon-button" aria-label="Закрыть подробности операции" onClick={onClose}><X size={21}/></button></div>
    <div className="bank-panel-body">
      {error && <div className="bank-notice bank-error" role="alert"><p>{error}</p><p>Показаны ранее сохранённые сведения операции.</p></div>}
      {loading && <div className="bank-loading-line" role="status"><LoaderCircle size={14} className="spin"/>Загружаем сохранённые реквизиты…</div>}
      <div className="sber-detail-refresh"><button className="button" disabled={refreshing || loading || !available} onClick={() => void refresh()}><RefreshCw size={15} className={refreshing ? 'spin' : ''}/>{refreshing ? 'Получаем подробности…' : row.detailsFetchedAt ? 'Обновить подробности из банка' : 'Загрузить подробности из банка'}</button><p>{row.detailsFetchedAt ? `Подробности получены ${displayTimestamp(row.detailsFetchedAt)}` : 'Показаны сведения из выписки. Дополнительные поля доступны при загрузке подробностей из банка.'}</p></div>
      <div className={`bank-payment-sum ${row.direction === 'incoming' ? 'bank-incoming' : ''}`}><span>{row.direction === 'incoming' ? 'Поступление на наш счёт' : 'Списание с нашего счёта'}</span><strong>{sberMoney(row.amount, row.currency)}</strong></div>
      <section className="bank-payment-purpose"><h3>Полное назначение платежа</h3><p>{row.purpose ?? 'Не передано банком'}</p></section>
      <dl className="bank-details-grid">{field('Наш счёт', row.account)}{field('Идентификатор операции банка', row.bankOperationId)}{field('Номер документа', row.documentNumber)}{field('Дата документа', row.documentDate ? displayDate(row.documentDate) : undefined)}{field('Дата выписки', displayDate(row.statementDate))}{field('Дата и время проведения', row.bookedAt)}{field('Статус банка', row.status)}{field('Валюта', row.currency)}</dl>
      <div className="bank-parties">{([['payer', 'Плательщик'], ['payee', 'Получатель']] as const).map(([key, title]) => <section key={key}><h3>{title}</h3><dl>{partyFields.map(([property, label]) => field(label, row[key][property]))}</dl></section>)}</div>
      {(row.vat !== undefined || row.commission !== undefined) && <dl className="bank-details-grid">{row.vat !== undefined && field('НДС от банка', row.vat)}{row.commission !== undefined && field('Комиссия от банка', row.commission)}</dl>}
      <details className="bank-raw-details"><summary>Все поля, полученные от банка</summary><dl>{rawFields(row.bankData).map(([key, value]) => field(key, value))}</dl></details>
      <p className="bank-footnote">Операция сохранена {displayTimestamp(row.updatedAt)}.</p>
    </div>
  </dialog>
}

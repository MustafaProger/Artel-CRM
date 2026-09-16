import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Decimal from 'decimal.js'
import { AlertCircle, ArrowDownLeft, ChevronDown, LoaderCircle, RefreshCw, Search, Wallet, X } from 'lucide-react'
import type { SettlementCompany, SettlementShipment, SettlementSource, SettlementsReport } from './settlements-model'
import './settlements.css'

const Exact = Decimal.clone({ precision: 512 })
const money = (value: string | null | undefined, currency = '₽') => {
  if (value == null) return 'Неизвестно'
  try {
    const parsed = new Exact(value)
    if (!parsed.isFinite()) return 'Неизвестно'
    const [whole, fraction] = parsed.toFixed(2).split('.')
    return `${whole.replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')},${fraction}\u00a0${currency}`
  } catch { return 'Неизвестно' }
}
const positive = (value: string) => { try { return new Exact(value).gt(0) } catch { return false } }
const date = (value: string | null) => {
  if (!value) return 'Дата не указана'
  const parsed = new Date(value.length === 10 ? `${value}T12:00:00Z` : value)
  return Number.isNaN(parsed.getTime()) ? 'Дата не указана' : parsed.toLocaleDateString('ru-RU', { timeZone: 'Europe/Moscow' })
}
const time = (value: string | null) => {
  if (!value) return 'Ещё не загружались'
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? 'Время не указано' : parsed.toLocaleString('ru-RU', { timeZone: 'Europe/Moscow', dateStyle: 'short', timeStyle: 'short' })
}
const shipmentTitle = (row: SettlementShipment) => `${row.number ? `№ ${row.number}` : 'Без номера'} · ${date(row.date)}`
const hasIssues = (company: SettlementCompany) => company.issues.length > 0 || company.shipments.some(row => !!row.issue)
const hasUnknownAmounts = (company: SettlementCompany) => company.shipments.some(row => row.amount === null || row.openingPaid === null || row.paid === null || row.debt === null)
const elementId = (kind: string, key: string) => `settlement-${kind}-${encodeURIComponent(key)}`

export default function SettlementsPage() {
  const [data, setData] = useState<SettlementsReport | null>(null)
  const [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [updatedAt, setUpdatedAt] = useState<string | null>(null)
  const [query, setQuery] = useState(''), [filter, setFilter] = useState<'all' | 'debt' | 'advance' | 'review'>('all')
  const [expanded, setExpanded] = useState<string | null>(null)
  const activeRequest = useRef<AbortController | null>(null), requestNumber = useRef(0)
  const refresh = useCallback(async () => {
    activeRequest.current?.abort()
    const controller = new AbortController(), request = ++requestNumber.current
    activeRequest.current = controller
    setLoading(true)
    try {
      const response = await fetch('/api/settlements', { signal: controller.signal, cache: 'no-store' })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Не удалось обновить взаиморасчёты.')
      if (controller.signal.aborted || request !== requestNumber.current) return
      setData(result); setError(''); setUpdatedAt(new Date().toISOString())
    } catch (cause) {
      if (!controller.signal.aborted && request === requestNumber.current) setError(cause instanceof Error ? cause.message : 'Нет связи с сервером.')
    } finally {
      if (!controller.signal.aborted && request === requestNumber.current) setLoading(false)
    }
  }, [])
  useEffect(() => {
    void refresh()
    const visibleRefresh = () => { if (document.visibilityState === 'visible') void refresh() }
    const interval = window.setInterval(visibleRefresh, 30_000)
    window.addEventListener('focus', visibleRefresh)
    document.addEventListener('visibilitychange', visibleRefresh)
    return () => {
      window.clearInterval(interval)
      window.removeEventListener('focus', visibleRefresh)
      document.removeEventListener('visibilitychange', visibleRefresh)
      activeRequest.current?.abort()
    }
  }, [refresh])

  const term = query.trim().toLocaleLowerCase('ru-RU')
  const companies = useMemo(() => (data?.companies ?? []).filter(company =>
    (!term || `${company.name} ${company.inn ?? ''}`.toLocaleLowerCase('ru-RU').includes(term)) &&
    (filter === 'all' || filter === 'debt' && positive(company.debt) || filter === 'advance' && positive(company.advance) || filter === 'review' && hasIssues(company)),
  ), [data, term, filter])
  const review = (filter === 'all' || filter === 'review') ? (data?.review ?? []).filter(row => !term || `${row.name} ${row.inn ?? ''}`.toLocaleLowerCase('ru-RU').includes(term)) : []
  const reviewCount = (data?.review.length ?? 0) + (data?.companies.filter(hasIssues).length ?? 0)

  return <section className="settlements-page" aria-label="Взаиморасчёты с покупателями">
    <div className="settlements-heading"><div><h2>Расчёты с покупателями</h2><p>Поступления по ИНН закрывают самые ранние отгрузки. Остаток — аванс.</p><p>Общий баланс покупателя по трём банковским подключениям.</p></div><button type="button" className="button" onClick={() => void refresh()} disabled={loading}><RefreshCw size={16} className={loading ? 'spin' : ''}/>{loading && data ? 'Обновляем…' : 'Обновить'}</button></div>
    {error && <div className="settlements-notice settlements-error" role="alert"><AlertCircle size={18}/><div><strong>{error}</strong><p>{data ? `Показаны последние полученные данные от ${time(updatedAt)}. Они могут быть неактуальны.` : 'Повторите загрузку с помощью кнопки «Обновить».'}</p></div></div>}
    {!data ? <div className="settlements-empty" role="status">{loading ? <><LoaderCircle size={26} className="spin"/><p>Загружаем взаиморасчёты…</p></> : <p>Данные пока недоступны.</p>}</div> : <>
      <div className="settlements-totals" aria-label="Итоги по всем покупателям">
        <Total label="Нам должны" value={data.totals.debt} tone="debt"/>
        <Total label="Аванс покупателей" value={data.totals.advance} tone="advance"/>
        <Total label="Поступило из банков" value={data.totals.incoming}/>
        <Total label="Сумма отгрузок" value={data.totals.shipped}/>
      </div>
      <div className="settlements-freshness"><span>{loading && <LoaderCircle size={13} className="spin"/>}Расчёты обновлены: {time(updatedAt)}</span><span>Итоги за всю сохранённую историю · ₽</span></div>
      {data.companies.some(hasUnknownAmounts) && <div className="settlements-notice"><AlertCircle size={18}/><div><strong>В итогах учтены только известные суммы.</strong><p>В некоторых отгрузках сумма или ранее внесённая оплата неизвестны. Нулевой долг у такой фирмы не означает, что она полностью рассчиталась. Откройте записи с отметкой «Требует проверки».</p></div></div>}
      <BankSources sources={data.sources}/>
      <section className="settlements-ledger panel" aria-labelledby="settlements-companies-title">
        <div className="settlements-ledger-heading"><h3 id="settlements-companies-title">Покупатели <span>{companies.length}</span></h3>{reviewCount > 0 && <button className="settlements-review-shortcut" type="button" onClick={() => setFilter('review')}><AlertCircle size={15}/>Требуют проверки: {reviewCount}</button>}</div>
        <div className="settlements-toolbar"><label className="settlements-search"><Search size={18}/><input value={query} onChange={event => setQuery(event.target.value)} placeholder="Название или ИНН" aria-label="Поиск покупателей по названию или ИНН"/>{query && <button type="button" aria-label="Очистить поиск покупателей" onClick={() => setQuery('')}><X size={16}/></button>}</label><label className="settlements-filter"><span>Показать</span><select value={filter} onChange={event => setFilter(event.target.value as typeof filter)}><option value="all">Все покупатели</option><option value="debt">С долгом</option><option value="advance">С авансом</option><option value="review">Требуют проверки</option></select></label></div>
        {companies.length ? <div className="settlements-table-wrap"><table className="settlements-company-table"><caption className="settlements-sr-only">Долги и авансы покупателей. Откройте фирму для просмотра отгрузок и поступлений.</caption><thead><tr><th scope="col">Покупатель / ИНН</th><th scope="col">Отгружено</th><th scope="col">Поступило</th><th scope="col">Долг</th><th scope="col">Аванс</th></tr></thead><tbody>{companies.map(company => <Fragment key={company.key}>
          <tr className={expanded === company.key ? 'settlements-company-row is-expanded' : 'settlements-company-row'}><td data-label="Покупатель"><button type="button" className="settlements-company-button" onClick={() => setExpanded(value => value === company.key ? null : company.key)} aria-expanded={expanded === company.key} aria-controls={expanded === company.key ? elementId('details', company.key) : undefined}><span><strong>{company.name}</strong><small>{company.inn ? `ИНН ${company.inn}` : 'ИНН не указан'}</small>{hasIssues(company) && <span className="settlements-issue-badge">Требует проверки</span>}</span><ChevronDown size={17}/></button></td><td data-label="Отгружено">{money(company.shipped)}</td><td data-label="Поступило">{money(company.incoming)}</td><td data-label="Долг" className={positive(company.debt) ? 'settlements-debt' : ''}>{money(company.debt)}{hasUnknownAmounts(company) && <small className="settlements-unknown">Есть неизвестные суммы</small>}</td><td data-label="Аванс" className={positive(company.advance) ? 'settlements-advance' : ''}>{money(company.advance)}</td></tr>
          {expanded === company.key && <tr className="settlements-details-row"><td colSpan={5}><CompanyDetails company={company}/></td></tr>}
        </Fragment>)}</tbody></table></div> : <div className="settlements-empty"><Wallet size={28}/><h4>{query || filter !== 'all' ? 'Покупателей по этим условиям нет' : 'Взаиморасчётов пока нет'}</h4><p>{query || filter !== 'all' ? 'Измените поиск или фильтр.' : 'Добавьте отгрузку или загрузите поступления в разделе «Платежи».'}</p></div>}
      </section>
      {review.length > 0 && <section className="settlements-review panel" aria-labelledby="settlements-review-title"><div className="settlements-ledger-heading"><div><h3 id="settlements-review-title">Поступления на проверку <span>{review.length}</span></h3><p>Эти операции не уменьшают долг и не попадают в аванс.</p></div><AlertCircle size={20}/></div><div className="settlements-review-list">{review.map(row => <article className="settlements-review-item" key={row.id} data-connection-id={row.connectionId}><div><h4>{row.name}</h4><p>{row.inn ? `ИНН ${row.inn}` : 'ИНН не указан'} · {date(row.date)}</p><p>{row.bank} · {row.company}<br/>Счёт {row.account}</p></div><strong>{money(row.amount, row.currency === 'RUB' || row.currency === '643' ? '₽' : row.currency)}</strong><p className="settlements-review-reason">{row.reason}</p></article>)}</div></section>}
    </>}
  </section>
}

function Total({ label, value, tone }: { label: string; value: string; tone?: 'debt' | 'advance' }) {
  return <div className={`settlements-total${tone ? ` settlements-total-${tone}` : ''}`}><span>{label}</span><strong>{money(value)}</strong></div>
}

const sourceStatus: Record<SettlementSource['status'], string> = {
  not_loaded: 'Выписка ещё не загружена',
  ready: 'Выписка загружена',
  error: 'Ошибка загрузки',
  syncing: 'Загрузка не завершена',
}
function BankSources({ sources }: { sources: SettlementSource[] }) {
  return <details className="settlements-sources" open={sources.some(source => source.status !== 'ready')}>
    <summary>Банковские выписки{sources.length > 0 ? ` · ${sources.length}` : ''}</summary>
    <p>Расчёт использует сохранённые поступления. Выписки обновляются в разделе «Платежи».</p>
    {sources.length ? <ul>{sources.map(source => <li key={source.id} data-connection-id={source.id}>
      <strong>{source.name}</strong>
      <span className={`settlements-source-status settlements-source-${source.status}`}>{source.status === 'syncing' && <LoaderCircle size={12} className="spin"/>}{sourceStatus[source.status]}</span>
      <span>Последняя успешная загрузка: {time(source.lastSuccessAt)}</span>
      <span>{source.from && source.to ? `Последний загруженный период: ${date(source.from)} — ${date(source.to)}` : 'Загруженный период не подтверждён'}</span>
      {source.status === 'syncing' && <p>Полный период ещё не загружен. Расчёт учитывает только уже сохранённые поступления.</p>}
      {source.lastError && <p className="settlements-source-error">{source.lastError}</p>}
    </li>)}</ul> : <p>Сохранённых банковских выписок пока нет.</p>}
  </details>
}

function CompanyDetails({ company }: { company: SettlementCompany }) {
  const focusShipment = (event: React.MouseEvent<HTMLAnchorElement>, shipmentId: string) => {
    event.preventDefault()
    const row = document.getElementById(elementId('shipment', shipmentId))
    row?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); row?.focus({ preventScroll: true })
  }
  return <div className="settlements-company-details" id={elementId('details', company.key)}>
    {company.issues.length > 0 && <div className="settlements-notice"><AlertCircle size={18}/><div><strong>Нужно проверить</strong><ul>{company.issues.map(issue => <li key={issue}>{issue}</li>)}</ul></div></div>}
    <div className="settlements-details-heading"><h4>Отгрузки</h4><span>Ранее учтённая оплата: {money(company.openingPaid)}</span></div>
    {company.shipments.length ? <div className="settlements-detail-scroll" tabIndex={0} role="region" aria-label={`Отгрузки ${company.name}`}><table className="settlements-detail-table"><thead><tr><th scope="col">Отгрузка</th><th scope="col">Сумма</th><th scope="col">Оплачено ранее</th><th scope="col">Из банка</th><th scope="col">Оплачено всего</th><th scope="col">Долг</th></tr></thead><tbody>{company.shipments.map(row => <tr key={row.id} id={elementId('shipment', row.id)} tabIndex={-1}><td><strong>{shipmentTitle(row)}</strong>{row.issue && <small className="settlements-shipment-issue">{row.issue}</small>}</td><td>{money(row.amount)}</td><td>{money(row.openingPaid)}</td><td>{money(row.bankPaid)}</td><td>{money(row.paid)}</td><td className={row.debt && positive(row.debt) ? 'settlements-debt' : ''}>{money(row.debt)}</td></tr>)}</tbody></table></div> : <p className="settlements-details-empty">Отгрузок пока нет. Поступившие деньги сохраняются как аванс.</p>}
    <div className="settlements-details-heading"><h4>Поступления</h4><span>Распределено по отгрузкам: {money(company.allocated)}</span></div>
    {company.receipts.length ? <div className="settlements-receipts">{company.receipts.map(receipt => <article className="settlements-receipt" key={receipt.id} data-connection-id={receipt.connectionId}><div className="settlements-receipt-heading"><div><strong><ArrowDownLeft size={16}/><span>{date(receipt.date)} · {receipt.bank} · {receipt.company}</span></strong><small>Счёт {receipt.account}</small></div><strong>{money(receipt.amount)}</strong></div><p className="settlements-purpose">{receipt.purpose || 'Назначение платежа не передано'}</p><dl className="settlements-receipt-balances"><div><dt>В оплату отгрузок</dt><dd>{money(receipt.allocated)}</dd></div><div><dt>Остаток аванса</dt><dd className={positive(receipt.advance) ? 'settlements-advance' : ''}>{money(receipt.advance)}</dd></div></dl>{receipt.allocations.length > 0 && <ul className="settlements-allocations">{receipt.allocations.map(allocation => { const shipment = company.shipments.find(row => row.id === allocation.shipmentId); return <li key={`${allocation.shipmentId}-${allocation.paymentId}`}><a href={`#${elementId('shipment', allocation.shipmentId)}`} onClick={event => focusShipment(event, allocation.shipmentId)}>{shipment ? `Отгрузка ${shipmentTitle(shipment)}` : 'Отгрузка'}</a><strong>{money(allocation.amount)}</strong></li> })}</ul>}</article>)}</div> : <p className="settlements-details-empty">Подтверждённых поступлений по этому ИНН пока нет.</p>}
  </div>
}
